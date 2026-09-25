// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console} from "forge-std/Test.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";

import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {CurrencySettler} from "@openzeppelin/uniswap-hooks/src/utils/CurrencySettler.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";

import {MockUSDC} from "../../../../src/mocks/MockUSDC.sol";

/// @notice Probe hook. Fills at a fixed ratio instead of the AMM curve, but only
///         for one designated `filler` address, and counts every `beforeSwap` it
///         actually receives.
/// @dev The counter is the whole point: it distinguishes "the hook declined to
///      override" from "the hook was never asked".
contract ProbeHook is BaseHook, IUnlockCallback {
    using CurrencySettler for Currency;

    uint256 public beforeSwapCalls;
    address public lastSender;

    address public filler;
    uint256 public priceNum;
    uint256 public priceDen;

    event ProbeFill(address sender, uint256 amountIn, uint256 amountOut);

    constructor(IPoolManager pm) BaseHook(pm) {}

    function configure(address filler_, uint256 num, uint256 den) external {
        filler = filler_;
        priceNum = num;
        priceDen = den;
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

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        beforeSwapCalls++;
        lastSender = sender;

        // Anyone other than the designated filler falls through to the AMM curve.
        if (sender != filler) {
            return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        require(params.amountSpecified < 0, "probe: exact-input only");
        uint256 amountIn = uint256(-params.amountSpecified);
        uint256 amountOut = (amountIn * priceNum) / priceDen;

        (Currency specified, Currency unspecified) =
            params.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);

        // Take the input into hook inventory, pay the output out of it. Both as
        // ERC-6909 claims, so no ERC-20 transfer happens inside the swap.
        specified.take(poolManager, address(this), amountIn, true);
        unspecified.settle(poolManager, address(this), amountOut, true);

        emit ProbeFill(sender, amountIn, amountOut);

        return (
            BaseHook.beforeSwap.selector,
            toBeforeSwapDelta(int128(int256(amountIn)), -int128(int256(amountOut))),
            0
        );
    }

    // ---------------------------------------------------------------- route A

    /// @notice Route A: the hook itself is the caller of `poolManager.swap`.
    function fillViaSelfCall(PoolKey calldata key, uint256 amountIn, bool zeroForOne)
        external
        returns (BalanceDelta delta)
    {
        bytes memory out = poolManager.unlock(abi.encode(key, amountIn, zeroForOne));
        delta = abi.decode(out, (BalanceDelta));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "probe: not manager");
        (PoolKey memory key, uint256 amountIn, bool zeroForOne) = abi.decode(data, (PoolKey, uint256, bool));

        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        // Settle whatever the swap left owing, paying from hook inventory.
        _settle(key.currency0, delta.amount0());
        _settle(key.currency1, delta.amount1());

        return abi.encode(delta);
    }

    function _settle(Currency c, int128 amount) private {
        if (amount < 0) {
            c.settle(poolManager, address(this), uint256(uint128(-amount)), false);
        } else if (amount > 0) {
            c.take(poolManager, address(this), uint256(uint128(amount)), false);
        }
    }
}

/// @notice A minimal external caller: unlocks, acts, settles. Deliberately NOT the
///         hook, so `Hooks.beforeSwap`'s self-call short circuit does not apply.
contract ProbeRouter is IUnlockCallback {
    using CurrencySettler for Currency;

    IPoolManager public immutable poolManager;

    enum Action {
        SWAP,
        ADD_LIQUIDITY,
        SEED_CLAIMS
    }

    constructor(IPoolManager pm) {
        poolManager = pm;
    }

    function swap(PoolKey calldata key, uint256 amountIn, bool zeroForOne) external returns (BalanceDelta delta) {
        bytes memory out =
            poolManager.unlock(abi.encode(Action.SWAP, msg.sender, key, abi.encode(amountIn, zeroForOne)));
        delta = abi.decode(out, (BalanceDelta));
    }

    function addLiquidity(PoolKey calldata key, ModifyLiquidityParams calldata params) external {
        poolManager.unlock(abi.encode(Action.ADD_LIQUIDITY, msg.sender, key, abi.encode(params)));
    }

    /// @notice Give `to` ERC-6909 claims on `currency`, paid for in real ERC-20.
    /// @dev This is the stand-in for MMVault inventory: the hook needs claim
    ///      balances before it can pay out of them inside `beforeSwap`.
    function seedClaims(PoolKey calldata key, Currency currency, uint256 amount, address to) external {
        poolManager.unlock(abi.encode(Action.SEED_CLAIMS, msg.sender, key, abi.encode(currency, amount, to)));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "router: not manager");
        (Action action, address payer, PoolKey memory key, bytes memory inner) =
            abi.decode(data, (Action, address, PoolKey, bytes));

        if (action == Action.SEED_CLAIMS) {
            (Currency currency, uint256 amount, address to) = abi.decode(inner, (Currency, uint256, address));
            currency.settle(poolManager, payer, amount, false);
            poolManager.mint(to, currency.toId(), amount);
            return "";
        }

        if (action == Action.ADD_LIQUIDITY) {
            ModifyLiquidityParams memory params = abi.decode(inner, (ModifyLiquidityParams));
            (BalanceDelta delta,) = poolManager.modifyLiquidity(key, params, "");
            _settlePair(key, delta, payer);
            return "";
        }

        (uint256 amountIn, bool zeroForOne) = abi.decode(inner, (uint256, bool));
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        _settlePair(key, delta, payer);
        return abi.encode(delta);
    }

    function _settlePair(PoolKey memory key, BalanceDelta delta, address payer) private {
        _one(key.currency0, delta.amount0(), payer);
        _one(key.currency1, delta.amount1(), payer);
    }

    function _one(Currency c, int128 amount, address payer) private {
        if (amount < 0) {
            c.settle(poolManager, payer, uint256(uint128(-amount)), false);
        } else if (amount > 0) {
            c.take(poolManager, payer, uint256(uint128(amount)), false);
        }
    }
}

/// @notice Does `beforeSwapReturnDelta` actually carry the LIVE fill path?
///
/// @dev Step 4's design has `tick()` fill queued orders at the oracle reference
///      price `R` by calling `poolManager.swap` and having the hook's own
///      `_beforeSwap` return a `BeforeSwapDelta` that consumes the whole swap.
///      This file establishes, against the real Sepolia PoolManager, which caller
///      that works for.
contract FillPathProbeTest is Test {
    using CurrencySettler for Currency;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// @dev Sepolia v4 PoolManager. Same address PLAN.md §0 pins.
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0xE03A1074c86CFeDd5C142C4F04F1a1536e203543);

    /// @dev Any recent block; nothing here depends on chain history beyond the
    ///      PoolManager's deployed bytecode.
    uint256 internal constant FORK_BLOCK = 11_753_325;

    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    uint160 internal constant SQRT_PRICE_1_1 = 79_228_162_514_264_337_593_543_950_336;

    /// @dev Fill ratio the probe hook uses: 0.75 out per 1 in. Deliberately far from
    ///      the 1:1 pool price, so an AMM fill and a hook fill cannot be confused.
    uint256 internal constant PRICE_NUM = 3;
    uint256 internal constant PRICE_DEN = 4;

    ProbeHook internal hook;
    ProbeRouter internal router;
    PoolKey internal key;
    MockUSDC internal token0;
    MockUSDC internal token1;

    bool internal forked;

    function setUp() public {
        string memory url = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url, FORK_BLOCK);
        forked = true;

        MockUSDC a = new MockUSDC();
        MockUSDC b = new MockUSDC();
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), flags, type(ProbeHook).creationCode, abi.encode(POOL_MANAGER));
        hook = new ProbeHook{salt: salt}(POOL_MANAGER);
        require(address(hook) == hookAddr, "hook address mismatch");

        router = new ProbeRouter(POOL_MANAGER);
        hook.configure(address(router), PRICE_NUM, PRICE_DEN);

        key = PoolKey({
            currency0: Currency.wrap(address(token0)),
            currency1: Currency.wrap(address(token1)),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: hook
        });
        POOL_MANAGER.initialize(key, SQRT_PRICE_1_1);

        token0.mint(address(this), 1_000_000e6);
        token1.mint(address(this), 1_000_000e6);
        token0.approve(address(router), type(uint256).max);
        token1.approve(address(router), type(uint256).max);

        // Real AMM liquidity, so a curve fill is distinguishable from a hook fill.
        router.addLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: -60 * 100,
                tickUpper: 60 * 100,
                liquidityDelta: 100_000e6,
                salt: bytes32(0)
            })
        );

        // Hook inventory, as ERC-6909 claims. Stands in for MMVault.
        router.seedClaims(key, key.currency1, 100_000e6, address(hook));
        router.seedClaims(key, key.currency0, 100_000e6, address(hook));

        // The hook also needs plain ERC-20 for route A, where it settles directly.
        token0.mint(address(hook), 100_000e6);
        token1.mint(address(hook), 100_000e6);
    }

    modifier onlyForked() {
        if (!forked) {
            emit log("SEPOLIA_RPC_URL unset - skipping v4 fork test");
            return;
        }
        _;
    }

    // ------------------------------------------------------------------------
    // Route A: the hook calls poolManager.swap itself. THIS IS THE BLOCKER.
    // ------------------------------------------------------------------------

    /// @notice The hook's own `beforeSwap` is never invoked when the hook is the
    ///         caller, so the swap runs on the AMM curve at the AMM price.
    function test_A_SelfCallSkipsBeforeSwapEntirely() public onlyForked {
        uint256 amountIn = 1_000e6;

        assertEq(hook.beforeSwapCalls(), 0, "precondition");

        BalanceDelta delta = hook.fillViaSelfCall(key, amountIn, true);

        assertEq(hook.beforeSwapCalls(), 0, "beforeSwap ran - self-call short circuit is gone");
        assertEq(hook.lastSender(), address(0), "sender recorded - hook was called after all");

        // The swap still happened, against the curve.
        assertEq(uint256(uint128(-delta.amount0())), amountIn, "input not consumed");
        uint256 out = uint256(uint128(delta.amount1()));
        assertGt(out, 0, "no output - swap did not execute");

        uint256 hookPriceOut = (amountIn * PRICE_NUM) / PRICE_DEN;
        assertTrue(out != hookPriceOut, "output matched the hook price by coincidence");

        console.log("route A  amountIn      ", amountIn);
        console.log("route A  AMM output    ", out);
        console.log("route A  hook-price out", hookPriceOut);
        console.log("route A  beforeSwapCalls", hook.beforeSwapCalls());
    }

    // ------------------------------------------------------------------------
    // Route B: an external filler calls poolManager.swap. This works.
    // ------------------------------------------------------------------------

    /// @notice With a separate caller, `beforeSwap` runs, the returned
    ///         `BeforeSwapDelta` is honoured, and the fill lands exactly on the
    ///         hook's price with the AMM curve untouched.
    function test_B_ExternalFillerGetsCustomCurveFill() public onlyForked {
        uint256 amountIn = 1_000e6;
        uint256 expectedOut = (amountIn * PRICE_NUM) / PRICE_DEN;

        uint256 before0 = token0.balanceOf(address(this));
        uint256 before1 = token1.balanceOf(address(this));

        BalanceDelta delta = router.swap(key, amountIn, true);

        assertEq(hook.beforeSwapCalls(), 1, "beforeSwap did not run exactly once");
        assertEq(hook.lastSender(), address(router), "sender is not the router");

        assertEq(uint256(uint128(-delta.amount0())), amountIn, "input not exactly consumed");
        assertEq(uint256(uint128(delta.amount1())), expectedOut, "output is not the hook price");

        assertEq(before0 - token0.balanceOf(address(this)), amountIn, "payer input mismatch");
        assertEq(token1.balanceOf(address(this)) - before1, expectedOut, "payer output mismatch");

        console.log("route B  amountIn      ", amountIn);
        console.log("route B  hook fill out ", uint256(uint128(delta.amount1())));
        console.log("route B  beforeSwapCalls", hook.beforeSwapCalls());
    }

    /// @notice The AMM curve really is bypassed on route B: the pool price does not
    ///         move, because `amountToSwap` reached `Pool.swap` as zero.
    function test_B_CustomCurveFillLeavesPoolPriceUntouched() public onlyForked {
        (uint160 sqrtBefore,,,) = _slot0();
        router.swap(key, 1_000e6, true);
        (uint160 sqrtAfter,,,) = _slot0();
        assertEq(sqrtAfter, sqrtBefore, "pool price moved - the curve was not bypassed");
    }

    /// @notice A third party still trades the ordinary curve, so the override is
    ///         scoped to the filler rather than global.
    function test_B_NonFillerStillHitsTheCurve() public onlyForked {
        address human = address(0xBEEF);
        token0.mint(human, 10_000e6);

        vm.startPrank(human);
        token0.approve(address(router), type(uint256).max);
        // The router is the filler, so route the human through a second router.
        ProbeRouter humanRouter = new ProbeRouter(POOL_MANAGER);
        token0.approve(address(humanRouter), type(uint256).max);
        BalanceDelta delta = humanRouter.swap(key, 1_000e6, true);
        vm.stopPrank();

        assertEq(hook.lastSender(), address(humanRouter), "sender not recorded");
        uint256 out = uint256(uint128(delta.amount1()));
        assertTrue(out != (1_000e6 * PRICE_NUM) / PRICE_DEN, "non-filler got the hook price");
        assertGt(out, 0, "non-filler got nothing");
    }

    function _slot0() private view returns (uint160, int24, uint24, uint24) {
        return POOL_MANAGER.getSlot0(key.toId());
    }
}
