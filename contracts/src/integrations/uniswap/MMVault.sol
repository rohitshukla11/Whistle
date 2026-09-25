// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {CurrencySettler} from "@openzeppelin/uniswap-hooks/src/utils/CurrencySettler.sol";

import {SettlementPot} from "../../core/SettlementPot.sol";

/// @title MMVault
/// @notice The market maker behind every card pool: seeds supply, provides pool
///         liquidity, and is the counterparty of last resort for LIVE fills.
///
/// @dev ## Where inventory actually lives
///
///      Vault inventory is held as **ERC-6909 claims on the PoolManager**, not as
///      ERC-20. `WhistleHook._beforeSwap` has to settle inside an in-flight swap,
///      where paying in ERC-20 would re-`sync` a currency that swap is still
///      accounting for. Claims avoid that entirely.
///
///      The hook is registered as an ERC-6909 **operator** on this vault, so it can
///      `burn` the vault's claims during a fill. `PoolManager.burn` credits the
///      resulting delta to `msg.sender` — the hook — while debiting the claims from
///      `from` — the vault. That split is exactly the accounting this design needs:
///      the vault's books move, the hook's deltas balance.
///
///      `cards[card].inventory` and {usdcReserve} mirror those claim balances in
///      plain storage so the position is readable without an ERC-6909 query, and so
///      a reconciliation test can catch any drift between the two.
///
///      ## What the vault is NOT involved in
///
///      Mint-backed orders (`isMint`) never touch this contract. They are filled by
///      minting new supply at `R * 1.02` straight from the SettlementPot, so they
///      cannot be rationed and cannot exhaust inventory. See
///      `WhistleHook._fillMintOrders`.
contract MMVault is IUnlockCallback {
    using CurrencySettler for Currency;
    using CurrencyLibrary for Currency;
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // ------------------------------------------------------------- constants

    /// @notice Units of every card minted at `P0` when a fixture is seeded.
    uint256 public constant SEED_UNITS = 200e18;

    /// @dev ±10% in price. `ln(1.1) / ln(1.0001) = 953.1` ticks.
    int24 internal constant TICK_BAND = 953;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    // ----------------------------------------------------------------- types

    struct CardState {
        /// @notice Card units held as ERC-6909 claims, available for LIVE fills.
        uint128 inventory;
        /// @notice Units minted at seeding, for the cost basis.
        uint128 seeded;
        /// @notice PositionManager token id of this card's LP position, 0 if none.
        uint256 positionId;
        PoolKey key;
        bool registered;
        bool closed;
    }

    // --------------------------------------------------------------- storage

    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    IAllowanceTransfer public immutable permit2;
    SettlementPot public immutable pot;
    IERC20 public immutable usdc;

    /// @notice The only contract allowed to move inventory. Set once.
    address public immutable hook;

    address public operator;

    address[] public seededCards;
    mapping(address card => CardState) internal _cards;

    /// @notice USDC held as ERC-6909 claims, the working reserve for LIVE fills.
    uint256 public usdcReserve;

    /// @notice How much of the reserve the operator wants kept in claims.
    uint256 public usdcReserveTarget;

    /// @notice Total USDC the operator has put in. The denominator for {vaultPnL}.
    uint256 public capitalIn;

    /// @notice The vault's 90% share of fill fees, received as ERC-20.
    uint256 public feesEarned;

    // ---------------------------------------------------------------- errors

    error OnlyOperator();
    error OnlyHook();
    error OnlyPoolManager();
    error UnknownCard();
    error CardAlreadyRegistered();
    error AlreadySeeded();
    error AlreadyClosed();
    error NotSettled();
    error InsufficientReserve();
    error BadShare();

    event CardRegistered(address indexed card, PoolKey key);
    event CardSeeded(address indexed card, uint256 units, uint256 lpUnits, uint256 positionId, uint256 usdcSpent);
    event ReserveFunded(uint256 amount, uint256 reserve);
    event FillRecorded(address indexed card, int256 cardDelta, int256 usdcDelta, uint256 inventory);
    event FeesReceived(uint256 amount, uint256 total);
    event CapitalContributed(address indexed card, uint256 units, uint256 capitalIn);
    event CardClosed(address indexed card, uint256 cardsRedeemed, uint256 usdcRecovered);

    // ----------------------------------------------------------- constructor

    constructor(
        IPoolManager poolManager_,
        IPositionManager positionManager_,
        IAllowanceTransfer permit2_,
        SettlementPot pot_,
        address hook_
    ) {
        poolManager = poolManager_;
        positionManager = positionManager_;
        permit2 = permit2_;
        pot = pot_;
        usdc = pot_.usdc();
        hook = hook_;
        operator = msg.sender;

        // The hook burns this vault's claims during a fill. `PoolManager.burn`
        // accepts an operator, and credits the delta to the caller rather than to
        // the claim holder — which is what lets the hook balance its own swap while
        // the inventory leaves these books.
        poolManager_.setOperator(hook_, true);

        usdc.forceApprove(address(pot_), type(uint256).max);
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator();
        _;
    }

    modifier onlyHook() {
        if (msg.sender != hook) revert OnlyHook();
        _;
    }

    function setOperator(address operator_) external onlyOperator {
        operator = operator_;
    }

    // ---------------------------------------------------------------- views

    function cardState(address card) external view returns (CardState memory) {
        return _cards[card];
    }

    function cardInventory(address card) external view returns (uint256) {
        return _cards[card].inventory;
    }

    function seededCardCount() external view returns (uint256) {
        return seededCards.length;
    }

    /// @notice Claims balances as the PoolManager sees them, for reconciliation.
    function claimBalances(address card) external view returns (uint256 cardClaims, uint256 usdcClaims) {
        cardClaims = poolManager.balanceOf(address(this), Currency.wrap(card).toId());
        usdcClaims = poolManager.balanceOf(address(this), Currency.wrap(address(usdc)).toId());
    }

    // --------------------------------------------------------------- funding

    /// @notice Put USDC to work. Everything the vault spends comes from here, and
    ///         {vaultPnL} measures against it.
    function fund(uint256 amount) external onlyOperator {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        capitalIn += amount;
    }

    /// @notice Move ERC-20 USDC into the claims reserve that LIVE fills draw on.
    function fundReserve(uint256 amount) external onlyOperator {
        _seedClaims(Currency.wrap(address(usdc)), amount);
        usdcReserve += amount;
        usdcReserveTarget = usdcReserve;
        emit ReserveFunded(amount, usdcReserve);
    }

    function setReserveTarget(uint256 target) external onlyOperator {
        usdcReserveTarget = target;
    }

    // --------------------------------------------------------------- seeding

    function registerCard(address card, PoolKey calldata key) external onlyOperator {
        CardState storage cs = _cards[card];
        if (cs.registered) revert CardAlreadyRegistered();
        if (!pot.isCard(card)) revert UnknownCard();

        cs.key = key;
        cs.registered = true;
        emit CardRegistered(card, key);
    }

    /// @notice Mint {SEED_UNITS} of `card` at `P0` and split them between the pool
    ///         and LIVE-fill inventory.
    ///
    /// @dev The split is the one judgement call in seeding. All 200 units in the LP
    ///      position would leave nothing to fill a net-long book with during LIVE,
    ///      because pool liquidity cannot be withdrawn mid-tick; all 200 in
    ///      inventory would leave the pool untradeable before kickoff. `lpShareBps`
    ///      makes the tradeoff explicit rather than hard-coding it.
    ///
    /// @param lpShareBps Portion of the seeded units committed to the LP position.
    /// @param usdcForLp USDC paired into the position alongside those units.
    function seedCard(address card, uint16 lpShareBps, uint256 usdcForLp)
        external
        onlyOperator
        returns (uint256 positionId, uint256 usdcSpent)
    {
        CardState storage cs = _cards[card];
        if (!cs.registered) revert UnknownCard();
        if (cs.seeded != 0) revert AlreadySeeded();
        if (lpShareBps > BPS) revert BadShare();

        uint256 balanceBefore = usdc.balanceOf(address(this));
        pot.mintPreMatch(card, SEED_UNITS, address(this));
        usdcSpent = balanceBefore - usdc.balanceOf(address(this));

        cs.seeded = SEED_UNITS.toUint128();
        seededCards.push(card);

        uint256 lpUnits = Math.mulDiv(SEED_UNITS, lpShareBps, BPS);
        uint256 inventoryUnits = SEED_UNITS - lpUnits;

        if (lpUnits != 0) {
            positionId = _mintPosition(cs, card, lpUnits, usdcForLp);
            cs.positionId = positionId;
        }

        if (inventoryUnits != 0) {
            _seedClaims(Currency.wrap(card), inventoryUnits);
            cs.inventory = inventoryUnits.toUint128();
        }

        emit CardSeeded(card, SEED_UNITS, lpUnits, positionId, usdcSpent);
    }

    /// @dev Concentrated liquidity, ±10% in price around the pool's current tick.
    function _mintPosition(CardState storage cs, address card, uint256 lpUnits, uint256 usdcForLp)
        private
        returns (uint256 positionId)
    {
        PoolKey memory key = cs.key;
        (uint160 sqrtPriceX96, int24 tick,,) = poolManager.getSlot0(key.toId());

        int24 spacing = key.tickSpacing;
        int24 lower = _align(tick - TICK_BAND, spacing);
        int24 upper = _align(tick + TICK_BAND, spacing);
        if (lower == upper) upper = lower + spacing;

        bool usdcIsCurrency0 = Currency.unwrap(key.currency0) == address(usdc);
        (uint256 amount0, uint256 amount1) =
            usdcIsCurrency0 ? (usdcForLp, lpUnits) : (lpUnits, usdcForLp);

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount0, amount1
        );

        _approveForPosm(Currency.unwrap(key.currency0));
        _approveForPosm(Currency.unwrap(key.currency1));

        positionId = positionManager.nextTokenId();

        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(key, lower, upper, liquidity, amount0, amount1, address(this), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);

        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp + 60);
        card; // silence unused-parameter warnings on some solc builds
    }

    function _approveForPosm(address token) private {
        IERC20(token).forceApprove(address(permit2), type(uint256).max);
        permit2.approve(token, address(positionManager), type(uint160).max, type(uint48).max);
    }

    function _align(int24 tick, int24 spacing) private pure returns (int24) {
        int24 aligned = (tick / spacing) * spacing;
        if (tick < 0 && aligned != tick) aligned -= spacing;
        if (aligned < TickMath.MIN_TICK) aligned = TickMath.MIN_TICK + spacing;
        if (aligned > TickMath.MAX_TICK) aligned = TickMath.MAX_TICK - spacing;
        return aligned;
    }

    // ------------------------------------------------------------ LIVE fills

    /// @notice Book a residual fill the hook has just settled against this vault.
    ///
    /// @dev Called after the swap, not before, so the numbers recorded are the ones
    ///      that actually moved. Deltas are from the vault's point of view: negative
    ///      `cardDelta` means the vault sold cards into a net-long book.
    function recordFill(address card, int256 cardDelta, int256 usdcDelta) external onlyHook {
        CardState storage cs = _cards[card];
        if (!cs.registered) revert UnknownCard();

        if (cardDelta < 0) {
            uint256 out = uint256(-cardDelta);
            if (out > cs.inventory) revert InsufficientReserve();
            cs.inventory = uint128(cs.inventory - out);
        } else if (cardDelta > 0) {
            cs.inventory = uint128(cs.inventory + uint256(cardDelta));
        }

        if (usdcDelta < 0) {
            uint256 out = uint256(-usdcDelta);
            if (out > usdcReserve) revert InsufficientReserve();
            usdcReserve -= out;
        } else if (usdcDelta > 0) {
            usdcReserve += uint256(usdcDelta);
        }

        emit FillRecorded(card, cardDelta, usdcDelta, cs.inventory);
    }

    /// @notice The vault's share of a batch's fill fees, already transferred in.
    function recordFees(uint256 amount) external onlyHook {
        feesEarned += amount;
        emit FeesReceived(amount, feesEarned);
    }

    /// @notice Top up LIVE-fill inventory with cards the operator already holds.
    /// @dev Seeding mints a fixed {SEED_UNITS} per card at `P0`. A vault running a
    ///      real book will want more than that behind a popular card, and a top-up
    ///      is not the same operation as seeding: it buys nothing and mints nothing,
    ///      it only moves existing supply into the claims that fills draw on.
    function depositCards(address card, uint256 units) external onlyOperator {
        CardState storage cs = _cards[card];
        if (!cs.registered) revert UnknownCard();

        IERC20(card).safeTransferFrom(msg.sender, address(this), units);
        _seedClaims(Currency.wrap(card), units);
        cs.inventory = (uint256(cs.inventory) + units).toUint128();

        // Contributed in kind, but still capital. Marking it at the reference price
        // on the way in is what keeps {vaultPnL} honest: without this the cards would
        // arrive free and their whole redemption value would read as profit.
        capitalIn += Math.mulDiv(pot.referencePrice(card), units, WAD);
        emit CapitalContributed(card, units, capitalIn);
    }

    /// @notice What the hook may draw on for a net-long book.
    function availableCardUnits(address card) external view returns (uint256) {
        return _cards[card].inventory;
    }

    /// @notice What the hook may draw on for a net-short book.
    function availableUSDC() external view returns (uint256) {
        return usdcReserve;
    }

    // ------------------------------------------------------------- close out

    /// @notice After settlement: pull the LP position, redeem every card held, and
    ///         come back to pure USDC.
    function closeCard(address card) external onlyOperator returns (uint256 usdcRecovered) {
        if (!pot.settled()) revert NotSettled();

        CardState storage cs = _cards[card];
        if (!cs.registered) revert UnknownCard();
        if (cs.closed) revert AlreadyClosed();
        cs.closed = true;

        uint256 usdcBefore = usdc.balanceOf(address(this));

        if (cs.positionId != 0) _burnPosition(cs);

        // Inventory claims back to ERC-20 so they can be redeemed.
        if (cs.inventory != 0) {
            _redeemClaims(Currency.wrap(card), cs.inventory);
            cs.inventory = 0;
        }

        uint256 held = IERC20(card).balanceOf(address(this));
        if (held != 0) pot.redeem(card, held, address(this));

        usdcRecovered = usdc.balanceOf(address(this)) - usdcBefore;
        emit CardClosed(card, held, usdcRecovered);
    }

    function _burnPosition(CardState storage cs) private {
        PoolKey memory key = cs.key;
        bytes memory actions = abi.encodePacked(uint8(Actions.BURN_POSITION), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(cs.positionId, uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, address(this));

        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp + 60);
        cs.positionId = 0;
    }

    /// @notice Drain the USDC claims reserve back to ERC-20 once fills are over.
    function closeReserve() external onlyOperator {
        uint256 amount = usdcReserve;
        if (amount == 0) return;
        usdcReserve = 0;
        _redeemClaims(Currency.wrap(address(usdc)), amount);
    }

    function withdraw(address to, uint256 amount) external onlyOperator {
        usdc.safeTransfer(to, amount);
    }

    // -------------------------------------------------------------- reporting

    /// @notice Profit and loss for the settlement screen.
    ///
    /// @dev `pnl` is everything the vault holds, marked to the current price, less
    ///      the capital put in. `feesEarned` is tracked directly, so the remainder
    ///      is what market making itself made or lost — inventory carried through
    ///      price moves, plus the spread the vault earns by being the counterparty
    ///      at `R` while collecting a fee on top.
    ///
    ///      Cards are marked at `payoutPerUnit` once the fixture has settled and at
    ///      `referencePrice` before that. Liquidity still sitting in a pool position
    ///      is NOT counted, so call this after {closeCard} for a final number.
    function vaultPnL()
        external
        view
        returns (int256 pnl, uint256 feesEarned_, int256 marketMakingPnL, uint256 inventoryValue)
    {
        bool settled = pot.settled();

        for (uint256 i = 0; i < seededCards.length; ++i) {
            address card = seededCards[i];
            uint256 units = uint256(_cards[card].inventory) + IERC20(card).balanceOf(address(this));
            if (units == 0) continue;
            uint256 price = settled ? pot.payoutPerUnit(card) : pot.referencePrice(card);
            inventoryValue += Math.mulDiv(price, units, WAD);
        }

        uint256 totalUSDC = usdc.balanceOf(address(this)) + usdcReserve;

        pnl = int256(totalUSDC + inventoryValue) - int256(capitalIn);
        feesEarned_ = feesEarned;
        marketMakingPnL = pnl - int256(feesEarned);
    }

    // --------------------------------------------------- ERC-6909 plumbing

    enum Action {
        SEED,
        REDEEM
    }

    /// @dev ERC-20 in, ERC-6909 claims out.
    function _seedClaims(Currency currency, uint256 amount) private {
        poolManager.unlock(abi.encode(Action.SEED, currency, amount));
    }

    /// @dev ERC-6909 claims in, ERC-20 out.
    function _redeemClaims(Currency currency, uint256 amount) private {
        poolManager.unlock(abi.encode(Action.REDEEM, currency, amount));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (Action action, Currency currency, uint256 amount) = abi.decode(data, (Action, Currency, uint256));

        if (action == Action.SEED) {
            currency.settle(poolManager, address(this), amount, false);
            poolManager.mint(address(this), currency.toId(), amount);
        } else {
            poolManager.burn(address(this), currency.toId(), amount);
            currency.take(poolManager, address(this), amount, false);
        }
        return "";
    }
}
