// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, toBeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";

import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {CurrencySettler} from "@openzeppelin/uniswap-hooks/src/utils/CurrencySettler.sol";

import {IAgentAuth} from "../../interfaces/IAgentAuth.sol";
import {IMarketVenue} from "../../interfaces/IMarketVenue.sol";
import {IMatchOracle} from "../../core/interfaces/IMatchOracle.sol";
import {MatchOracle} from "../../core/MatchOracle.sol";
import {SettlementPot} from "../../core/SettlementPot.sol";
import {WhistleFillRouter} from "./WhistleFillRouter.sol";
import {MMVault} from "./MMVault.sol";
import {PlayerCard} from "../../core/PlayerCard.sol";

/// @title WhistleHook
/// @notice The market venue: a delayed, batch-cleared order queue that fills at the
///         oracle reference price `R` instead of along an AMM curve.
///
/// @dev ## Why orders are queued rather than swapped
///
///      The oracle moves `R` on every match event. A swap that executes the instant
///      it arrives is a race between the trader and the oracle, and whoever has the
///      faster feed wins it every time. So orders sit for `L` seconds and then clear
///      **as a batch at a single price** — the `R` in force when the batch clears.
///      Nobody inside a batch is ahead of anybody else.
///
///      ## How a batch clears
///
///      Buys and sells for the same card cross against each other first, at `R`.
///      Only the residual imbalance draws on vault inventory, and the pro-rata
///      haircut applies to that residual alone, so a balanced book never touches
///      the vault and never gets rationed.
///
///      ## Why the fill goes through a router
///
///      `Hooks.beforeSwap` short-circuits when the hook is the caller of
///      `PoolManager.swap`, so a hook cannot fill against its own custom curve
///      directly — the swap runs on the AMM curve instead, silently, at the wrong
///      price. {WhistleFillRouter} exists solely to be a different `msg.sender`.
///      See that contract's docs and `test/integrations/uniswap/proto/`.
///
///      ## Authorization cost
///
///      `AgentRegistry.isAuthorized` is a live ENS read and costs ~88k gas. It is
///      charged once per order at queue time, and **once per agent per `tick()`
///      call** at fill time — memoized in memory for the duration of the call and
///      never across calls, so a revocation between two ticks is always seen.
contract WhistleHook is BaseHook, IMarketVenue {
    using CurrencySettler for Currency;
    using CurrencyLibrary for Currency;
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // ------------------------------------------------------------- constants

    uint24 public constant BASE_FEE_BPS = 30;
    uint24 public constant MAX_FEE_BPS = 200;
    uint24 public constant EVENT_SURCHARGE_BPS = 50;
    uint32 public constant EVENT_SURCHARGE_WINDOW = 60 seconds;

    /// @dev PLAN.md §2.7. Agents pay this on top, and all of it goes to the
    ///      protocol recipient rather than being shared with the vault.
    uint24 public constant AGENT_SURCHARGE_BPS = 10;

    /// @notice The vault's share of the base fill fee. The rest goes to protocol.
    /// @dev The vault is the counterparty that carries inventory risk through a
    ///      match, so it takes the bulk of what the spread earns.
    uint24 public constant VAULT_FEE_SHARE_BPS = 9000;

    /// @notice Premium over `R` charged on mint-backed fills, paid to the pot.
    /// @dev Minting at exactly `R` is neutral for every other card. This 2% is
    ///      deliberately above that, so a late minter pays existing holders for the
    ///      information advantage of arriving with the match already in progress.
    uint24 public constant MINT_PREMIUM_BPS = 200;

    uint16 public constant DEFAULT_AGENT_SLIPPAGE_BPS = 1000; // 10%
    uint16 public constant DEFAULT_HUMAN_SLIPPAGE_BPS = 500; // 5%

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    /// @dev Headroom the scan loop leaves for the clearing that follows it.
    uint256 internal constant GAS_RESERVE = 400_000;

    /// @notice Hard ceiling on `maxCards * maxOrdersPerCard`, so a page cannot ask
    ///         for memory arrays large enough to blow the block on allocation alone.
    uint256 public constant MAX_TICK_ORDERS = 256;

    // ----------------------------------------------------------------- types

    enum Status {
        PENDING,
        FILLED,
        CANCELLED
    }

    struct Order {
        address owner;
        uint96 rAtSubmit;
        address card;
        uint64 submittedAt;
        uint16 maxSlippageBps;
        Side side;
        bool isMint;
        uint120 amount;
        uint120 filled;
        Status status;
        bool isAgent;
    }

    struct CardInfo {
        uint256 fixtureId;
        PoolKey key;
        bool registered;
        bool usdcIsCurrency0;
    }

    // --------------------------------------------------------------- storage

    MatchOracle public immutable oracle;
    IAgentAuth public auth;
    WhistleFillRouter public fillRouter;
    MMVault public vault;

    address public operator;
    address public feeRecipient;

    /// @notice The quote asset. Shared by every fixture this hook serves.
    address public feeToken;

    /// @notice Upper bound on the gas one `tick()` call may burn scanning the queue.
    uint256 public tickGasBudget = 8_000_000;

    mapping(uint256 fixtureId => address pot) public potOf;
    mapping(address card => CardInfo) internal _cards;
    mapping(PoolId => address card) public cardOfPool;

    mapping(uint256 orderId => Order) internal _orders;
    mapping(uint256 fixtureId => uint256[]) internal _queue;

    /// @notice First queue index still unresolved. Advances lazily after each tick.
    mapping(uint256 fixtureId => uint256) public queueHead;

    uint256 public nextOrderId = 1;

    /// @notice Protocol's share of fees, withdrawable by the operator.
    uint256 public accruedFeesUSDC;

    /// @notice Everything ever routed to the vault, for reconciliation.
    uint256 public vaultFeesPaidUSDC;

    /// @dev Live only for the duration of one router fill, so `_beforeSwap` prices at
    ///      the batch's `R` rather than re-reading it mid-swap. Transient: it must
    ///      not survive the transaction under any control flow.
    address private transient _activeFillCard;
    uint256 private transient _activeFillR;

    // ---------------------------------------------------------------- errors

    error OnlyOperator();
    error UnknownCard();
    error CardAlreadyRegistered();
    error FixtureMismatch();
    error NotLive();
    error DirectSwapDuringLive();
    error Unauthorized();
    error ZeroAmount();
    error AmountTooLarge();
    error NotOrderOwner();
    error OrderNotPending();
    error RouterAlreadySet();
    error RouterNotSet();
    error VaultAlreadySet();
    error VaultNotSet();
    error MintOrdersMustBeBuys();
    error WouldExceedHolderCap();
    error NoActiveFill();
    error SlippageTooHigh();
    error PageTooLarge();

    event CardRegistered(uint256 indexed fixtureId, address indexed card, PoolId poolId);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event TickGasBudgetSet(uint256 budget);
    event VaultSet(address vault);

    // ----------------------------------------------------------- constructor

    /// @param operator_ The admin. Passed in rather than taken from `msg.sender`
    ///        because this hook is deployed with CREATE2 — its low bits have to
    ///        encode its permission flags — and under `forge script` that goes
    ///        through the deterministic CREATE2 factory. `msg.sender` in this
    ///        constructor is therefore the factory, not the deployer, and an
    ///        operator set from it would belong to nobody.
    constructor(
        IPoolManager poolManager_,
        MatchOracle oracle_,
        IAgentAuth auth_,
        address feeRecipient_,
        address operator_
    ) BaseHook(poolManager_) {
        oracle = oracle_;
        auth = auth_;
        operator = operator_;
        feeRecipient = feeRecipient_;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator();
        _;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ------------------------------------------------------------------ admin

    function setOperator(address operator_) external onlyOperator {
        operator = operator_;
    }

    function setAuth(IAgentAuth auth_) external onlyOperator {
        auth = auth_;
    }

    function setFeeRecipient(address feeRecipient_) external onlyOperator {
        feeRecipient = feeRecipient_;
    }

    function setTickGasBudget(uint256 budget) external onlyOperator {
        tickGasBudget = budget;
        emit TickGasBudgetSet(budget);
    }

    /// @dev One-shot. The router's only authorised caller is this hook, and swapping
    ///      it out mid-flight would strand the ERC-20 approvals granted below.
    function setFillRouter(WhistleFillRouter router) external onlyOperator {
        if (address(fillRouter) != address(0)) revert RouterAlreadySet();
        fillRouter = router;
    }

    /// @dev One-shot for the same reason as {setFillRouter}: the vault grants this
    ///      hook ERC-6909 operator rights over its inventory in its constructor, so
    ///      the pairing is fixed the moment the vault exists.
    function setVault(MMVault vault_) external onlyOperator {
        if (address(vault) != address(0)) revert VaultAlreadySet();
        vault = vault_;
        emit VaultSet(address(vault_));
    }

    function registerCard(uint256 fixtureId, address card, PoolKey calldata key) external onlyOperator {
        if (address(fillRouter) == address(0)) revert RouterNotSet();
        if (address(vault) == address(0)) revert VaultNotSet();

        CardInfo storage ci = _cards[card];
        if (ci.registered) revert CardAlreadyRegistered();

        address pot = potOf[fixtureId];
        if (pot == address(0)) {
            (address p,,,,,,,,,) = oracle.fixtures(fixtureId);
            pot = p;
            potOf[fixtureId] = p;
        }
        if (!SettlementPot(pot).isCard(card)) revert UnknownCard();

        address usdc = address(SettlementPot(pot).usdc());
        if (feeToken == address(0)) feeToken = usdc;

        bool usdcIsCurrency0 = Currency.unwrap(key.currency0) == usdc;
        if (!usdcIsCurrency0 && Currency.unwrap(key.currency1) != usdc) revert UnknownCard();
        if (Currency.unwrap(usdcIsCurrency0 ? key.currency1 : key.currency0) != card) revert UnknownCard();

        ci.fixtureId = fixtureId;
        ci.key = key;
        ci.registered = true;
        ci.usdcIsCurrency0 = usdcIsCurrency0;
        cardOfPool[key.toId()] = card;

        // The router settles on this hook's behalf, so it moves the hook's ERC-20.
        IERC20(usdc).forceApprove(address(fillRouter), type(uint256).max);
        IERC20(card).forceApprove(address(fillRouter), type(uint256).max);
        // Mint-backed fills pay the pot directly out of this hook's balance.
        IERC20(usdc).forceApprove(pot, type(uint256).max);

        emit CardRegistered(fixtureId, card, key.toId());
    }

    function withdrawFees(address to) external onlyOperator {
        uint256 amount = accruedFeesUSDC;
        accruedFeesUSDC = 0;
        if (amount != 0) IERC20(feeToken).safeTransfer(to, amount);
        emit FeesWithdrawn(to, amount);
    }

    // ------------------------------------------------------------- fee policy

    /// @notice Dynamic fee in basis points, applied to queued fills and to direct
    ///         pool swaps alike.
    /// @dev Base 30 bps, plus 50 bps for 60 seconds after any match event, plus the
    ///      pool's divergence from `R`, capped at 200 bps. The event surcharge is
    ///      what makes trading on a freshly posted event expensive. The divergence
    ///      term only bites in PRE_MATCH, because LIVE admits no direct swaps that
    ///      could move the pool away from `R`.
    function currentFeeBps(uint256 fixtureId, address card) public view returns (uint24 feeBps) {
        feeBps = BASE_FEE_BPS;

        (,,,,,, uint64 lastEventAt,,,) = oracle.fixtures(fixtureId);
        if (lastEventAt != 0 && block.timestamp - lastEventAt <= EVENT_SURCHARGE_WINDOW) {
            feeBps += EVENT_SURCHARGE_BPS;
        }

        feeBps += _divergenceBps(card);
        if (feeBps > MAX_FEE_BPS) feeBps = MAX_FEE_BPS;
    }

    /// @dev `|poolPrice - R| / R` in bps. Zero when either price is unavailable.
    function _divergenceBps(address card) internal view returns (uint24) {
        CardInfo storage ci = _cards[card];
        if (!ci.registered) return 0;

        uint256 r = SettlementPot(potOf[ci.fixtureId]).referencePrice(card);
        if (r == 0) return 0;

        uint256 poolPrice = _poolPrice(ci);
        if (poolPrice == 0) return 0;

        uint256 diff = poolPrice > r ? poolPrice - r : r - poolPrice;
        uint256 bps = Math.mulDiv(diff, BPS, r);
        return bps >= MAX_FEE_BPS ? uint24(MAX_FEE_BPS) : uint24(bps);
    }

    /// @dev USDC (6dp) per whole card (1e18 units), read off the pool's sqrt price.
    function _poolPrice(CardInfo storage ci) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(ci.key.toId());
        if (sqrtPriceX96 == 0) return 0;

        // pX96 = (amount1 / amount0) * 2^96, in raw token units.
        uint256 pX96 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 96);
        if (pX96 == 0) return 0;

        return ci.usdcIsCurrency0
            ? Math.mulDiv(WAD, 1 << 96, pX96) // usdc is token0: usdc per card = 1/p
            : Math.mulDiv(pX96, WAD, 1 << 96); // card is token0: usdc per card = p
    }

    // ------------------------------------------------------------ queueOrder

    /// @inheritdoc IMarketVenue
    function queueOrder(
        uint256 fixtureId,
        address card,
        Side side,
        uint256 amount,
        uint16 maxSlippageBps,
        bool isMint
    ) external returns (uint256 orderId) {
        CardInfo storage ci = _cards[card];
        if (!ci.registered) revert UnknownCard();
        if (ci.fixtureId != fixtureId) revert FixtureMismatch();
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint120).max) revert AmountTooLarge();
        if (maxSlippageBps > BPS) revert SlippageTooHigh();

        (, IMatchOracle.FixtureState state,,,,,,,,) = oracle.fixtures(fixtureId);
        if (state != IMatchOracle.FixtureState.LIVE) revert NotLive();

        bool senderIsAgent = auth.isAgent(msg.sender);
        uint256 r = SettlementPot(potOf[fixtureId]).referencePrice(card);

        // Queue-time authorization is per order, by design. An agent must not be
        // able to park an order it has no mandate for and have it sit in the book.
        if (senderIsAgent && !auth.isAuthorized(msg.sender, fixtureId, card, Math.mulDiv(r, amount, WAD))) {
            revert Unauthorized();
        }

        if (isMint && side != Side.BUY) revert MintOrdersMustBeBuys();
        if (side == Side.BUY && _wouldExceedHolderCap(card, msg.sender, amount, isMint)) {
            revert WouldExceedHolderCap();
        }

        if (maxSlippageBps == 0) {
            maxSlippageBps = senderIsAgent ? DEFAULT_AGENT_SLIPPAGE_BPS : DEFAULT_HUMAN_SLIPPAGE_BPS;
        }

        orderId = nextOrderId++;
        _orders[orderId] = Order({
            owner: msg.sender,
            rAtSubmit: uint96(r),
            card: card,
            submittedAt: uint64(block.timestamp),
            maxSlippageBps: maxSlippageBps,
            side: side,
            isMint: isMint,
            amount: uint120(amount),
            filled: 0,
            status: Status.PENDING,
            isAgent: senderIsAgent
        });
        _queue[fixtureId].push(orderId);

        emit OrderQueued(orderId, fixtureId, card, msg.sender, side, amount);
    }

    /// @inheritdoc IMarketVenue
    function cancelOrder(uint256 orderId) external {
        Order storage o = _orders[orderId];
        if (o.owner != msg.sender) revert NotOrderOwner();
        if (o.status != Status.PENDING) revert OrderNotPending();
        o.status = Status.CANCELLED;
        emit OrderCancelled(orderId, CancelReason.PRICE_MOVED);
    }

    // ------------------------------------------------------------------ views

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function cardInfo(address card) external view returns (CardInfo memory) {
        return _cards[card];
    }

    /// @inheritdoc IMarketVenue
    function queueLength(uint256 fixtureId) external view returns (uint256) {
        return _queue[fixtureId].length;
    }

    function vaultCardUnits(address card) external view returns (uint256) {
        return vault.availableCardUnits(card);
    }

    function vaultUSDC() external view returns (uint256) {
        return vault.availableUSDC();
    }

    // ------------------------------------------------------------------ tick

    /// @dev Everything one `tick()` call needs, in memory. Kept in a single struct so
    ///      the helpers stay inside the stack limit without `via_ir`.
    struct TickState {
        uint256 fixtureId;
        uint256 feeBps;
        uint256 resolved;
        // memoised authorization, one entry per distinct agent seen this call
        address[] memoAgent;
        bool[] memoAllowed;
        uint256 memoCount;
        // orders admitted to this batch
        uint256[] ids;
        uint256 n;
        // distinct cards in this batch, and their aggregates
        address[] cards;
        uint256[] cardR;
        uint256[] buyUnits;
        uint256[] sellUnits;
        uint256[] mintUnits;
        uint256[] cardOrders;
        uint256 cardCount;
    }

    /// @inheritdoc IMarketVenue
    function tick(uint256 fixtureId, uint256 maxCards, uint256 maxOrdersPerCard)
        external
        returns (uint256 nextCursor, uint256 processed)
    {
        (, IMatchOracle.FixtureState state,,, uint32 orderDelayL,,,,,) = oracle.fixtures(fixtureId);
        if (state != IMatchOracle.FixtureState.LIVE) revert NotLive();
        if (maxCards == 0 || maxOrdersPerCard == 0) revert ZeroAmount();
        if (maxCards * maxOrdersPerCard > MAX_TICK_ORDERS) revert PageTooLarge();

        TickState memory ts = _newTickState(fixtureId, maxCards, maxOrdersPerCard);

        nextCursor = _scan(ts, maxCards, maxOrdersPerCard, orderDelayL);
        _clear(ts);
        processed = ts.resolved;

        _advanceHead(fixtureId);
    }

    function _newTickState(uint256 fixtureId, uint256 maxCards, uint256 maxOrdersPerCard)
        private
        pure
        returns (TickState memory ts)
    {
        uint256 capacity = maxCards * maxOrdersPerCard;
        ts.fixtureId = fixtureId;
        ts.memoAgent = new address[](capacity);
        ts.memoAllowed = new bool[](capacity);
        ts.ids = new uint256[](capacity);
        ts.cards = new address[](maxCards);
        ts.cardR = new uint256[](maxCards);
        ts.buyUnits = new uint256[](maxCards);
        ts.sellUnits = new uint256[](maxCards);
        ts.mintUnits = new uint256[](maxCards);
        ts.cardOrders = new uint256[](maxCards);
    }

    /// @dev Pass one: walk the queue, resolve everything that fails a check, and
    ///      admit the survivors to the batch — **card by card**.
    ///
    ///      An order is skipped, and left pending for a later tick, when its card is
    ///      not in this batch and the card budget is already full, or when its card
    ///      is in the batch but has taken its share of orders. That is what keeps a
    ///      page from spreading thinly across many cards: the expensive part of a
    ///      tick is per card, not per order.
    function _scan(TickState memory ts, uint256 maxCards, uint256 maxOrdersPerCard, uint32 orderDelayL)
        private
        returns (uint256 cursor)
    {
        uint256[] storage q = _queue[ts.fixtureId];
        uint256 len = q.length;
        uint256 startGas = gasleft();
        uint256 budget = tickGasBudget;

        cursor = queueHead[ts.fixtureId];

        while (cursor < len) {
            if (startGas - gasleft() + GAS_RESERVE >= budget) break;

            uint256 orderId = q[cursor];
            ++cursor;

            Order storage o = _orders[orderId];
            if (o.status != Status.PENDING) continue;
            // Not yet through its delay. Left in place; a later tick will see it.
            if (block.timestamp < uint256(o.submittedAt) + orderDelayL) continue;

            if (!_admits(ts, o.card, maxCards, maxOrdersPerCard)) continue;
            uint256 ci = _cardIndex(ts, o.card);
            ++ts.cardOrders[ci];

            _admit(ts, orderId, o, ci);
        }
    }

    /// @dev Is there room in this page for one more order on `card`?
    function _admits(TickState memory ts, address card, uint256 maxCards, uint256 maxOrdersPerCard)
        private
        pure
        returns (bool)
    {
        for (uint256 i = 0; i < ts.cardCount; ++i) {
            if (ts.cards[i] == card) return ts.cardOrders[i] < maxOrdersPerCard;
        }
        return ts.cardCount < maxCards;
    }

    function _admit(TickState memory ts, uint256 orderId, Order storage o, uint256 ci) private {
        uint256 r = ts.cardR[ci];

        // Symmetric price-move protection. A move in the trader's favour is still a
        // move they did not consent to, and filling it would hand them a windfall
        // out of vault inventory.
        uint256 rSub = o.rAtSubmit;
        uint256 diff = r > rSub ? r - rSub : rSub - r;
        if (rSub != 0 && Math.mulDiv(diff, BPS, rSub) > o.maxSlippageBps) {
            _resolve(ts, orderId, o, CancelReason.PRICE_MOVED);
            return;
        }

        uint256 notional = Math.mulDiv(r, o.amount, WAD);

        if (o.isAgent) {
            if (!_authorized(ts, o.owner, o.card, notional)) {
                _resolve(ts, orderId, o, CancelReason.REVOKED);
                return;
            }
        } else if (auth.isAgent(o.owner)) {
            // Queued as a human, an agent by the time it clears: no mandate covers it.
            _resolve(ts, orderId, o, CancelReason.UNAUTHORIZED);
            return;
        }

        // Can the trader actually pay? Settled here so the clearing pass cannot
        // revert an entire tick over one broke account.
        if (!_canPay(o, notional, o.isMint)) {
            _resolve(ts, orderId, o, CancelReason.INSUFFICIENT_INVENTORY);
            return;
        }

        // The 5% holder cap is checked at queue time too. This is the safety net for
        // a position that grew in between: PlayerCard would revert on delivery, and
        // one over-full holder must not take a whole tick down with it.
        if (o.side == Side.BUY && _wouldExceedHolderCap(o.card, o.owner, o.amount, o.isMint)) {
            _resolve(ts, orderId, o, CancelReason.INSUFFICIENT_INVENTORY);
            return;
        }

        ts.ids[ts.n++] = orderId;
        if (o.isMint) {
            // Mint-backed buys are their own lane: served by new supply from the pot,
            // so they never enter the netting and can never be rationed.
            ts.mintUnits[ci] += o.amount;
        } else if (o.side == Side.BUY) {
            ts.buyUnits[ci] += o.amount;
        } else {
            ts.sellUnits[ci] += o.amount;
        }
    }

    /// @dev Mirrors `PlayerCard._update`, including its exemption list, so the check
    ///      here and the revert there cannot disagree.
    function _wouldExceedHolderCap(address card, address holder, uint256 units, bool minting)
        internal
        view
        returns (bool)
    {
        PlayerCard pc = PlayerCard(card);
        if (pc.capExempt(holder)) return false;

        uint256 supply = pc.totalSupply() + (minting ? units : 0);
        if (supply == 0) return false;

        uint256 balance = pc.balanceOf(holder) + units;
        return balance > Math.mulDiv(supply, pc.MAX_HOLDER_BPS(), BPS);
    }

    function _canPay(Order storage o, uint256 notional, bool isMint) private view returns (bool) {
        if (o.side == Side.BUY) {
            // Worst case: the largest fee this batch could possibly charge. A mint
            // order pays the 2% premium instead of a fill fee, but budgeting for the
            // larger of the two keeps one branch here.
            uint256 needed = notional + Math.mulDiv(notional, MAX_FEE_BPS + AGENT_SURCHARGE_BPS, BPS);
            if (isMint) needed = notional + Math.mulDiv(notional, MINT_PREMIUM_BPS + AGENT_SURCHARGE_BPS, BPS);
            IERC20 usdc = IERC20(feeToken);
            return usdc.balanceOf(o.owner) >= needed && usdc.allowance(o.owner, address(this)) >= needed;
        }
        IERC20 card = IERC20(o.card);
        return card.balanceOf(o.owner) >= o.amount && card.allowance(o.owner, address(this)) >= o.amount;
    }

    /// @dev One live ENS read per agent per `tick()` call. The memo lives in memory
    ///      and dies with the call, so a revocation between two ticks is always seen
    ///      — which is the whole reason it is not a storage cache.
    function _authorized(TickState memory ts, address agent, address card, uint256 notional)
        private
        returns (bool allowed)
    {
        for (uint256 i = 0; i < ts.memoCount; ++i) {
            if (ts.memoAgent[i] == agent) return ts.memoAllowed[i];
        }

        allowed = _liveAuthCheck(agent, ts.fixtureId, card, notional);

        ts.memoAgent[ts.memoCount] = agent;
        ts.memoAllowed[ts.memoCount] = allowed;
        ++ts.memoCount;
    }

    /// @dev The uncached read, isolated so test builds can instrument it without
    ///      leaving a `gasleft()` pair in the production path.
    function _liveAuthCheck(address agent, uint256 fixtureId, address card, uint256 notional)
        internal
        virtual
        returns (bool)
    {
        return auth.isAuthorized(agent, fixtureId, card, notional);
    }

    function _cardIndex(TickState memory ts, address card) private view returns (uint256) {
        for (uint256 i = 0; i < ts.cardCount; ++i) {
            if (ts.cards[i] == card) return i;
        }
        uint256 idx = ts.cardCount++;
        ts.cards[idx] = card;
        ts.cardR[idx] = SettlementPot(potOf[ts.fixtureId]).referencePrice(card);
        return idx;
    }

    // ---------------------------------------------------------------- clearing

    function _clear(TickState memory ts) private {
        for (uint256 c = 0; c < ts.cardCount; ++c) {
            _clearCard(ts, c);
        }
    }

    /// @dev Net, ration, then move tokens in three ordered phases. Collection has to
    ///      precede the residual swap, because the hook pays the vault leg out of
    ///      what this same batch's buyers just handed it.
    function _clearCard(TickState memory ts, uint256 c) private {
        address card = ts.cards[c];
        uint256 r = ts.cardR[c];

        ts.feeBps = currentFeeBps(ts.fixtureId, card);

        // Lane one: mint-backed buys, served by new supply at `R * 1.02`.
        if (ts.mintUnits[c] != 0) _fillMintOrders(ts, c, card);

        // Lane two: the crossing book, served by itself and then by the vault.
        uint256 buys = ts.buyUnits[c];
        uint256 sells = ts.sellUnits[c];
        if (buys == 0 && sells == 0) return;

        (uint256 buyRatio, uint256 sellRatio, int256 residual) = _ration(card, r, buys, sells);

        _collect(ts, c, r, buyRatio, sellRatio);
        if (residual != 0) _fillResidual(card, r, residual);
        _payOut(ts, c, r, buyRatio, sellRatio);

        emit BatchCleared(card, r, buys, sells, residual);
    }

    /// @notice Fill every mint-backed buy for one card, in one mint, at one price.
    ///
    /// @dev Aggregated deliberately. `quoteAtReference` moves as soon as the pot's
    ///      balance and `D` change, so minting order-by-order would give the first
    ///      buyer in a batch a better price than the last. One mint for the batch's
    ///      whole size keeps the lane at a single price, which is the same guarantee
    ///      the crossing lane gives.
    ///
    ///      Nothing here touches vault inventory, so a mint order cannot be rationed
    ///      and cannot fail for want of inventory.
    function _fillMintOrders(TickState memory ts, uint256 c, address card) private {
        SettlementPot p = SettlementPot(potOf[ts.fixtureId]);

        // Price per whole card, premium included, fixed for the whole lane.
        uint256 unitPrice = Math.mulDiv(p.quoteAtReference(card, WAD), BPS + MINT_PREMIUM_BPS, BPS);

        (uint256 collected, uint256 surcharges) = _collectMint(ts, card, unitPrice);

        // One mint for the lane. The pot recomputes the price itself; any difference
        // against what was collected is dust, and it goes to the protocol.
        uint256 charged = p.mintAtReference(card, ts.mintUnits[c], address(this), MINT_PREMIUM_BPS);

        _deliverMint(ts, c, card, unitPrice);

        accruedFeesUSDC += surcharges + (collected > charged ? collected - charged : 0);
    }

    function _collectMint(TickState memory ts, address card, uint256 unitPrice)
        private
        returns (uint256 collected, uint256 surcharges)
    {
        IERC20 usdc = IERC20(feeToken);

        for (uint256 i = 0; i < ts.n; ++i) {
            Order storage o = _orders[ts.ids[i]];
            if (o.card != card || !o.isMint || o.status != Status.PENDING) continue;

            // Round the buyer's side up, so the batch can never collect less than the
            // pot is about to charge it.
            uint256 cost = Math.mulDiv(unitPrice, o.amount, WAD, Math.Rounding.Ceil);
            uint256 surcharge = o.isAgent ? Math.mulDiv(cost, AGENT_SURCHARGE_BPS, BPS) : 0;

            usdc.safeTransferFrom(o.owner, address(this), cost + surcharge);
            collected += cost;
            surcharges += surcharge;
        }
    }

    function _deliverMint(TickState memory ts, uint256 c, address card, uint256 unitPrice) private {
        uint256 r = ts.cardR[c];

        for (uint256 i = 0; i < ts.n; ++i) {
            uint256 orderId = ts.ids[i];
            Order storage o = _orders[orderId];
            if (o.card != card || !o.isMint || o.status != Status.PENDING) continue;

            uint256 units = o.amount;
            uint256 cost = Math.mulDiv(unitPrice, units, WAD, Math.Rounding.Ceil);

            IERC20(card).safeTransfer(o.owner, units);
            if (o.isAgent) auth.recordSpend(o.owner, cost);

            o.filled = uint120(units);
            o.status = Status.FILLED;
            ++ts.resolved;

            emit OrderFilled(orderId, card, units, cost, r);
        }
    }

    /// @dev Pro-rata applies to the residual side only: whichever side is longer
    ///      shares the vault's capacity in proportion to order size, so every order
    ///      on that side takes an identical haircut and all of them still fill at `R`.
    function _ration(address card, uint256 r, uint256 buys, uint256 sells)
        private
        view
        returns (uint256 buyRatio, uint256 sellRatio, int256 residual)
    {
        buyRatio = WAD;
        sellRatio = WAD;

        if (buys > sells) {
            uint256 want = buys - sells;
            uint256 available = vault.availableCardUnits(card);
            uint256 supplied = want < available ? want : available;
            buyRatio = Math.mulDiv(sells + supplied, WAD, buys);
            residual = int256(supplied);
        } else if (sells > buys) {
            uint256 want = sells - buys;
            uint256 capacityUnits = r == 0 ? 0 : Math.mulDiv(vault.availableUSDC(), WAD, r);
            uint256 supplied = want < capacityUnits ? want : capacityUnits;
            sellRatio = Math.mulDiv(buys + supplied, WAD, sells);
            residual = -int256(supplied);
        }
    }

    function _fillUnits(Order storage o, uint256 buyRatio, uint256 sellRatio) private view returns (uint256) {
        uint256 ratio = o.side == Side.BUY ? buyRatio : sellRatio;
        return ratio == WAD ? o.amount : Math.mulDiv(o.amount, ratio, WAD);
    }

    /// @dev Phase one: take what every filling order owes into the hook.
    function _collect(TickState memory ts, uint256 c, uint256 r, uint256 buyRatio, uint256 sellRatio) private {
        address card = ts.cards[c];
        IERC20 usdc = IERC20(feeToken);

        for (uint256 i = 0; i < ts.n; ++i) {
            Order storage o = _orders[ts.ids[i]];
            if (o.card != card || o.isMint || o.status != Status.PENDING) continue;

            uint256 units = _fillUnits(o, buyRatio, sellRatio);
            if (units == 0) continue;

            if (o.side == Side.BUY) {
                uint256 notional = Math.mulDiv(r, units, WAD);
                usdc.safeTransferFrom(o.owner, address(this), notional + _feeOn(ts, notional, o.isAgent));
            } else {
                IERC20(card).safeTransferFrom(o.owner, address(this), units);
            }
        }
    }

    /// @dev Phase two: the one swap per card per tick. Exact output when the vault
    ///      sells into the book, exact input when it buys from it, so the unit count
    ///      the batch was rationed against is exactly the unit count that moves.
    function _fillResidual(address card, uint256 r, int256 residual) private {
        CardInfo storage ci = _cards[card];

        _activeFillCard = card;
        _activeFillR = r;

        // `usdcIsCurrency0` means the card is currency1.
        bool zeroForOne = residual > 0 ? ci.usdcIsCurrency0 : !ci.usdcIsCurrency0;

        fillRouter.fill(ci.key, zeroForOne, residual);

        _activeFillCard = address(0);
        _activeFillR = 0;

        // Book it on the vault's side. Signs are from the vault's point of view: a
        // positive residual means the vault sold cards into a net-long book.
        uint256 units = residual > 0 ? uint256(residual) : uint256(-residual);
        int256 usdcDelta = int256(Math.mulDiv(r, units, WAD));
        if (residual > 0) {
            vault.recordFill(card, -int256(units), usdcDelta);
        } else {
            vault.recordFill(card, int256(units), -usdcDelta);
        }
    }

    /// @dev Running fee totals for one card's batch, in memory so the payout loop
    ///      stays inside the stack limit without `via_ir`.
    struct FeeTotals {
        uint256 vaultCut;
        uint256 protocolCut;
    }

    /// @dev Phase three: hand out what every filling order is owed, and book it.
    function _payOut(TickState memory ts, uint256 c, uint256 r, uint256 buyRatio, uint256 sellRatio) private {
        address card = ts.cards[c];
        FeeTotals memory ft;

        for (uint256 i = 0; i < ts.n; ++i) {
            uint256 orderId = ts.ids[i];
            Order storage o = _orders[orderId];
            if (o.card != card || o.isMint || o.status != Status.PENDING) continue;

            uint256 units = _fillUnits(o, buyRatio, sellRatio);
            if (units == 0) {
                _resolve(ts, orderId, o, CancelReason.INSUFFICIENT_INVENTORY);
                continue;
            }

            _payOne(ts, orderId, o, card, units, r, ft);
        }

        accruedFeesUSDC += ft.protocolCut;
        if (ft.vaultCut != 0) {
            vaultFeesPaidUSDC += ft.vaultCut;
            IERC20(feeToken).safeTransfer(address(vault), ft.vaultCut);
            vault.recordFees(ft.vaultCut);
        }
    }

    function _payOne(
        TickState memory ts,
        uint256 orderId,
        Order storage o,
        address card,
        uint256 units,
        uint256 r,
        FeeTotals memory ft
    ) private {
        uint256 notional = Math.mulDiv(r, units, WAD);
        (uint256 fee, uint256 vaultCut, uint256 protocolCut) = _splitFee(ts, notional, o.isAgent);
        ft.vaultCut += vaultCut;
        ft.protocolCut += protocolCut;

        if (o.side == Side.BUY) {
            IERC20(card).safeTransfer(o.owner, units);
        } else {
            IERC20(feeToken).safeTransfer(o.owner, notional - fee);
        }

        if (o.isAgent) auth.recordSpend(o.owner, notional);

        o.filled = uint120(units);
        o.status = Status.FILLED;
        ++ts.resolved;

        emit OrderFilled(orderId, card, units, notional, r);

        // A rationed order fills what it can. The remainder does not stay queued
        // against a price that is already stale.
        if (units < o.amount) emit OrderCancelled(orderId, CancelReason.INSUFFICIENT_INVENTORY);
    }

    /// @dev The base fee splits 90/10 between the vault and the protocol; the agent
    ///      surcharge is not shared at all. `protocolCut` takes the subtraction
    ///      rather than a second `mulDiv`, so the two halves always re-add to `fee`
    ///      exactly and rounding cannot leak a wei.
    function _splitFee(TickState memory ts, uint256 notional, bool isAgent)
        private
        pure
        returns (uint256 fee, uint256 vaultCut, uint256 protocolCut)
    {
        uint256 base = Math.mulDiv(notional, ts.feeBps, BPS);
        uint256 surcharge = isAgent ? Math.mulDiv(notional, AGENT_SURCHARGE_BPS, BPS) : 0;

        vaultCut = Math.mulDiv(base, VAULT_FEE_SHARE_BPS, BPS);
        protocolCut = base - vaultCut + surcharge;
        fee = base + surcharge;
    }

    function _feeOn(TickState memory ts, uint256 notional, bool isAgent) private pure returns (uint256) {
        (uint256 fee,,) = _splitFee(ts, notional, isAgent);
        return fee;
    }

    function _resolve(TickState memory ts, uint256 orderId, Order storage o, CancelReason reason) private {
        o.status = Status.CANCELLED;
        ++ts.resolved;
        emit OrderCancelled(orderId, reason);
    }

    function _advanceHead(uint256 fixtureId) private {
        uint256[] storage q = _queue[fixtureId];
        uint256 len = q.length;
        uint256 h = queueHead[fixtureId];
        while (h < len && _orders[q[h]].status != Status.PENDING) {
            ++h;
        }
        queueHead[fixtureId] = h;
    }

    // ------------------------------------------------------------- hook entry

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        address card = cardOfPool[key.toId()];
        if (card == address(0)) revert UnknownCard();

        uint256 fixtureId = _cards[card].fixtureId;
        uint24 feeOverride = currentFeeBps(fixtureId, card) * 100 | LPFeeLibrary.OVERRIDE_FEE_FLAG;

        if (sender == address(fillRouter)) {
            return (BaseHook.beforeSwap.selector, _fillAtReference(key, params, card), feeOverride);
        }

        // During LIVE, price discovery belongs to the oracle. A direct swap would be
        // a trade at the AMM price against a book that is deliberately waiting `L`
        // seconds — precisely the race the queue exists to prevent.
        (, IMatchOracle.FixtureState state,,,,,,,,) = oracle.fixtures(fixtureId);
        if (state == IMatchOracle.FixtureState.LIVE) revert DirectSwapDuringLive();

        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, feeOverride);
    }

    /// @dev Consumes the whole swap and settles it against vault inventory at `R`, so
    ///      the AMM curve is bypassed and the pool price does not move.
    function _fillAtReference(PoolKey calldata key, SwapParams calldata params, address card)
        private
        returns (BeforeSwapDelta)
    {
        uint256 r = _activeFillR;
        if (r == 0 || _activeFillCard != card) revert NoActiveFill();

        bool exactInput = params.amountSpecified < 0;
        (Currency specified, Currency unspecified) =
            (params.zeroForOne == exactInput) ? (key.currency0, key.currency1) : (key.currency1, key.currency0);

        uint256 specifiedAmount = exactInput ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        uint256 unspecifiedAmount = Currency.unwrap(specified) == card
            ? Math.mulDiv(r, specifiedAmount, WAD) // cards specified -> usdc on the other side
            : Math.mulDiv(specifiedAmount, WAD, r); // usdc specified -> cards on the other side

        // Claims move on the VAULT's books, not this hook's: the vault is the
        // counterparty. `PoolManager.burn`/`mint` credit the resulting delta to
        // `msg.sender` — this hook — which is what balances the swap, while the
        // inventory itself leaves or joins the vault. The hook is an ERC-6909
        // operator on the vault, granted in the vault's constructor.
        address counterparty = address(vault);

        if (exactInput) {
            specified.take(poolManager, counterparty, specifiedAmount, true);
            unspecified.settle(poolManager, counterparty, unspecifiedAmount, true);
            return toBeforeSwapDelta(int128(int256(specifiedAmount)), -int128(int256(unspecifiedAmount)));
        }

        specified.settle(poolManager, counterparty, specifiedAmount, true);
        unspecified.take(poolManager, counterparty, unspecifiedAmount, true);
        return toBeforeSwapDelta(-int128(int256(specifiedAmount)), int128(int256(unspecifiedAmount)));
    }
}
