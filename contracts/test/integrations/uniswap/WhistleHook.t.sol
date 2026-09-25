// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {CurrencySettler} from "@openzeppelin/uniswap-hooks/src/utils/CurrencySettler.sol";

import {WhistleHookForkBase} from "./WhistleHookForkBase.sol";
import {WhistleHook} from "../../../src/integrations/uniswap/WhistleHook.sol";
import {IMarketVenue} from "../../../src/interfaces/IMarketVenue.sol";
import {IMatchOracle} from "../../../src/core/interfaces/IMatchOracle.sol";
import {WhistleFillRouter} from "../../../src/integrations/uniswap/WhistleFillRouter.sol";
import {WhistleHookHarness} from "./WhistleHookForkBase.sol";
import {IAgentAuth} from "../../../src/interfaces/IAgentAuth.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";

/// @notice An ordinary swapper, used only to prove that direct swaps are refused.
contract DirectSwapper is IUnlockCallback {
    using CurrencySettler for Currency;

    IPoolManager public immutable poolManager;

    constructor(IPoolManager pm) {
        poolManager = pm;
    }

    function swap(PoolKey calldata key, uint256 amountIn, bool zeroForOne) external returns (BalanceDelta delta) {
        delta = abi.decode(poolManager.unlock(abi.encode(msg.sender, key, amountIn, zeroForOne)), (BalanceDelta));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        (address payer, PoolKey memory key, uint256 amountIn, bool zeroForOne) =
            abi.decode(data, (address, PoolKey, uint256, bool));

        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        _one(key.currency0, delta.amount0(), payer);
        _one(key.currency1, delta.amount1(), payer);
        return abi.encode(delta);
    }

    function _one(Currency c, int128 amount, address payer) private {
        if (amount < 0) {
            c.settle(poolManager, payer, uint256(uint128(-amount)), false);
        } else if (amount > 0) {
            c.take(poolManager, payer, uint256(uint128(amount)), false);
        }
    }
}

/// @notice Step 4 acceptance tests. One Sepolia fork, both live systems: ENSv2
///         answers every authorization question and the real v4 PoolManager
///         executes every fill.
contract WhistleHookTest is WhistleHookForkBase {
    using StateLibrary for IPoolManager;

    /// @dev Mirrors {WhistleHookHarness.AuthChecked}, for log decoding.
    event AuthChecked(address indexed agent, bool allowed, uint256 gasUsed);

    uint256 internal r;

    function setUp() public {
        if (!_setUpFork()) return;
        _setUpRig();
        r = pot.referencePrice(card);
    }

    // ------------------------------------------------------------ sanity

    function test_RigIsLiveAndAnchored() public onlyForked {
        assertEq(uint256(oracle.fixtureState(FIXTURE_ID)), 1, "fixture is not LIVE");
        assertGt(r, 0, "reference price is zero");

        // The pool was initialized at R, so the dynamic fee starts at base + the
        // post-kickoff event surcharge and nothing else.
        vm.warp(block.timestamp + 61);
        // Anchored at R means the divergence term contributes nothing but rounding.
        assertLe(hook.currentFeeBps(FIXTURE_ID, card), hook.BASE_FEE_BPS() + 2, "pool is not anchored at R");
        assertGe(hook.currentFeeBps(FIXTURE_ID, card), hook.BASE_FEE_BPS(), "fee below base");
    }

    // --------------------------------------- netting, pro-rata, one price

    /// @notice Four orders, two of them from one agent. Buys cross against the sell
    ///         first; only the imbalance touches vault inventory, and because that
    ///         inventory is short, every buyer takes the identical haircut and fills
    ///         at the identical price.
    function test_NettingProRataUniformPriceAndFees() public onlyForked {
        uint256 vaultUnits = hook.vaultCardUnits(card);

        uint256 a1 = _queue(agentA, IMarketVenue.Side.BUY, 20_000e18, 0);
        uint256 a2 = _queue(agentA, IMarketVenue.Side.BUY, 10_000e18, 0);
        uint256 h1 = _queue(human, IMarketVenue.Side.BUY, 10_000e18, 0);
        uint256 b1 = _queue(agentB, IMarketVenue.Side.SELL, 5_000e18, 0);

        uint256 buys = 40_000e18;
        uint256 sells = 5_000e18;

        // Past both the order delay and the post-kickoff surcharge window.
        vm.warp(block.timestamp + 61);
        uint256 feeBps = hook.currentFeeBps(FIXTURE_ID, card);
        assertLe(feeBps, hook.BASE_FEE_BPS() + 2, "unexpected fee regime - surcharge or divergence leaked in");

        uint256 sellerUsdcBefore = usdc.balanceOf(agentB);
        uint256 vaultUsdcBefore = usdc.balanceOf(address(vault));

        vm.recordLogs();
        vm.prank(keeper);
        (, uint256 processed) = hook.tick(FIXTURE_ID, TICK_CARDS, 10);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(processed, 4, "not every order resolved");

        // --- netting: only the imbalance drew on the vault
        int256 residual = _batchResidual(logs);
        assertEq(residual, int256(vaultUnits), "vault supplied more or less than its whole inventory");
        assertLt(uint256(residual), buys - sells, "residual was not netted down by the crossing sell");

        // --- pro-rata: one ratio, applied to every buyer
        uint256 expectedRatio = Math.mulDiv(sells + vaultUnits, WAD, buys);
        assertEq(hook.getOrder(a1).filled, Math.mulDiv(20_000e18, expectedRatio, WAD), "a1 haircut");
        assertEq(hook.getOrder(a2).filled, Math.mulDiv(10_000e18, expectedRatio, WAD), "a2 haircut");
        assertEq(hook.getOrder(h1).filled, Math.mulDiv(10_000e18, expectedRatio, WAD), "h1 haircut");
        // The short side fills whole.
        assertEq(hook.getOrder(b1).filled, 5_000e18, "seller should not be rationed");

        // --- uniform price: identical per-unit price on every fill, both sides
        _assertUniformPrice(logs, r);

        // --- fee accounting, and the vault really was drained through the pool
        _assertFeeAccounting([a1, a2, h1, b1], feeBps, sellerUsdcBefore, vaultUsdcBefore);
        assertEq(hook.vaultCardUnits(card), 0, "vault card claims did not move");
    }

    struct ExpectedFees {
        uint256 total;
        uint256 vaultCut;
        uint256 protocolCut;
    }

    /// @dev Recomputes the whole fee schedule order by order, independently of the
    ///      hook, so the assertions below check arithmetic rather than echo it.
    function _expectedFees(uint256[4] memory ids, uint256 feeBps) private view returns (ExpectedFees memory e) {
        for (uint256 i = 0; i < ids.length; ++i) {
            WhistleHook.Order memory o = hook.getOrder(ids[i]);
            uint256 notional = _notional(o.filled, r);

            uint256 base = Math.mulDiv(notional, feeBps, BPS);
            uint256 surcharge = o.isAgent ? Math.mulDiv(notional, hook.AGENT_SURCHARGE_BPS(), BPS) : 0;
            uint256 vaultCut = Math.mulDiv(base, hook.VAULT_FEE_SHARE_BPS(), BPS);

            e.vaultCut += vaultCut;
            e.protocolCut += base - vaultCut + surcharge;
            e.total += base + surcharge;
        }
    }

    /// @dev Split out of the test above purely to stay inside the stack limit.
    function _assertFeeAccounting(
        uint256[4] memory ids,
        uint256 feeBps,
        uint256 sellerUsdcBefore,
        uint256 vaultUsdcBefore
    ) private view {
        ExpectedFees memory e = _expectedFees(ids, feeBps);

        // 90/10 on the base fee, with the agent surcharge going wholly to protocol.
        assertEq(hook.accruedFeesUSDC(), e.protocolCut, "protocol share is wrong");
        assertEq(hook.vaultFeesPaidUSDC(), e.vaultCut, "vault share is wrong");
        assertEq(vault.feesEarned(), e.vaultCut, "vault did not book its share");
        assertEq(usdc.balanceOf(address(vault)) - vaultUsdcBefore, e.vaultCut, "vault was not actually paid");

        // Nothing is lost between the two buckets.
        assertEq(e.vaultCut + e.protocolCut, e.total, "the split does not re-add to the fee");

        // The seller received notional less the FULL fee, not just one share of it.
        WhistleHook.Order memory seller = hook.getOrder(ids[3]);
        uint256 sellNotional = _notional(seller.filled, r);
        uint256 sellFee = Math.mulDiv(sellNotional, feeBps + hook.AGENT_SURCHARGE_BPS(), BPS);
        assertEq(
            usdc.balanceOf(agentB) - sellerUsdcBefore,
            sellNotional - sellFee,
            "seller proceeds are not notional minus fee"
        );
    }

    /// @notice The queue is not a price-improvement venue: the pool price is
    ///         untouched by a batch, because the curve is bypassed entirely.
    function test_TickLeavesPoolPriceUntouched() public onlyForked {
        (uint160 before,,,) = POOL_MANAGER.getSlot0(key.toId());

        _queue(agentA, IMarketVenue.Side.BUY, 1_000e18, 0);
        vm.warp(block.timestamp + 61);
        vm.prank(keeper);
        hook.tick(FIXTURE_ID, TICK_CARDS, 10);

        (uint160 afterSqrt,,,) = POOL_MANAGER.getSlot0(key.toId());
        assertEq(afterSqrt, before, "pool price moved - the AMM curve was not bypassed");
    }

    // ----------------------------------------------------- memoised auth

    /// @notice One live ENS read per agent per tick, however many orders that agent
    ///         has in the batch. Humans are not read at all.
    function test_OneEnsReadPerAgentPerTick() public onlyForked {
        _queue(agentA, IMarketVenue.Side.BUY, 100e18, 0);
        _queue(agentA, IMarketVenue.Side.BUY, 100e18, 0);
        _queue(agentA, IMarketVenue.Side.BUY, 100e18, 0);
        _queue(agentB, IMarketVenue.Side.SELL, 100e18, 0);
        _queue(human, IMarketVenue.Side.BUY, 100e18, 0);

        vm.warp(block.timestamp + 61);

        vm.recordLogs();
        vm.prank(keeper);
        hook.tick(FIXTURE_ID, TICK_CARDS, 10);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        (uint256 readsA, uint256 gasA) = _authReads(logs, agentA);
        (uint256 readsB,) = _authReads(logs, agentB);
        (uint256 readsHuman,) = _authReads(logs, human);

        assertEq(readsA, 1, "agentA read more than once despite three orders");
        assertEq(readsB, 1, "agentB read more than once");
        assertEq(readsHuman, 0, "a human should never hit the ENS path");

        console.log("isAuthorized gas, measured live:", gasA);
        assertGt(gasA, 0, "instrumentation did not measure anything");
    }

    // ------------------------------------------------------ revocation

    /// @notice An agent revoked after queueing has its pending order cancelled on the
    ///         next tick, with REVOKED. Nothing is cached that could keep it alive.
    function test_RevokeMidQueueCancelsWithRevoked() public onlyForked {
        uint256 orderId = _queue(agentA, IMarketVenue.Side.BUY, 1_000e18, 0);
        uint256 survivor = _queue(agentB, IMarketVenue.Side.BUY, 1_000e18, 0);

        // The user pulls the mandate while the order is still waiting out its delay.
        vm.prank(user);
        agentRegistry.revokeAgent(agentA);

        vm.warp(block.timestamp + 61);

        vm.recordLogs();
        vm.prank(keeper);
        hook.tick(FIXTURE_ID, TICK_CARDS, 10);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(uint256(hook.getOrder(orderId).status), uint256(WhistleHook.Status.CANCELLED), "order not cancelled");
        assertEq(hook.getOrder(orderId).filled, 0, "revoked order filled anyway");
        assertEq(
            uint256(_cancelReason(logs, orderId)),
            uint256(IMarketVenue.CancelReason.REVOKED),
            "wrong cancellation reason"
        );

        // The other agent is untouched.
        assertEq(uint256(hook.getOrder(survivor).status), uint256(WhistleHook.Status.FILLED), "survivor did not fill");
    }

    /// @notice And its next queueOrder is refused outright.
    function test_RevokedAgentCannotQueueAgain() public onlyForked {
        vm.prank(user);
        agentRegistry.revokeAgent(agentA);

        vm.prank(agentA);
        vm.expectRevert(WhistleHook.Unauthorized.selector);
        hook.queueOrder(FIXTURE_ID, card, IMarketVenue.Side.BUY, 1_000e18, 0, false);
    }

    // ------------------------------------------------- price protection

    /// @notice Protection is symmetric: a move in the trader's favour cancels too.
    function test_PriceMoveCancelsSymmetrically() public onlyForked {
        uint256 tight = _queue(human, IMarketVenue.Side.BUY, 1_000e18, 1); // 0.01%
        uint256 loose = _queue(agentA, IMarketVenue.Side.BUY, 1_000e18, 9_000); // 90%

        // A goal moves R upward - in a buyer's favour - and the tight order still
        // cancels, because it is a price the trader did not agree to.
        _postGoal();
        vm.warp(block.timestamp + 61);

        uint256 rNow = pot.referencePrice(card);
        assertTrue(rNow != r, "R did not move");

        vm.recordLogs();
        vm.prank(keeper);
        hook.tick(FIXTURE_ID, TICK_CARDS, 10);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(uint256(hook.getOrder(tight).status), uint256(WhistleHook.Status.CANCELLED), "tight order survived");
        assertEq(
            uint256(_cancelReason(logs, tight)),
            uint256(IMarketVenue.CancelReason.PRICE_MOVED),
            "wrong reason for the tight order"
        );
        assertEq(uint256(hook.getOrder(loose).status), uint256(WhistleHook.Status.FILLED), "loose order should fill");
    }

    // --------------------------------------------------- direct swaps

    /// @notice While the match is LIVE the pool is closed to everyone but the fill
    ///         router. The revert is asserted in full, wrapper and all, so a future
    ///         change that reverts for some *other* reason cannot pass this test.
    function test_DirectSwapDuringLiveReverts() public onlyForked {
        DirectSwapper swapper = new DirectSwapper(POOL_MANAGER);

        vm.startPrank(human);
        usdc.approve(address(swapper), type(uint256).max);
        IERC20(card).approve(address(swapper), type(uint256).max);

        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeSwap.selector,
                abi.encodeWithSelector(WhistleHook.DirectSwapDuringLive.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        swapper.swap(key, 100e6, address(usdc) < card);
        vm.stopPrank();
    }

    /// @notice Settlement closes the venue: no new orders, no more ticks.
    function test_SettledClosesTheQueue() public onlyForked {
        uint256[] memory noExpected = new uint256[](0);
        vm.prank(oracleSigner);
        oracle.postFinal(FIXTURE_ID, noExpected);

        assertEq(uint256(oracle.fixtureState(FIXTURE_ID)), 2, "fixture is not SETTLED");

        vm.prank(human);
        vm.expectRevert(WhistleHook.NotLive.selector);
        hook.queueOrder(FIXTURE_ID, card, IMarketVenue.Side.BUY, 100e18, 0, false);

        vm.expectRevert(WhistleHook.NotLive.selector);
        hook.tick(FIXTURE_ID, TICK_CARDS, 10);
    }

    // ----------------------------------------------- dynamic fee schedule

    /// @notice 50 bps on top for 60 seconds after an event, then back to base.
    ///
    /// @dev Measured off the kickoff, which stamps `lastEventAt` like any other
    ///      event. Any `postEvent` re-arms the window the same way — but a goal also
    ///      dislocates `R` far enough from the pool anchor to saturate the 200 bps
    ///      cap, which would hide the surcharge instead of demonstrating it. Here
    ///      nothing has moved `R`, so the 50 bps stands alone.
    function test_EventSurchargeAppliesThenExpires() public onlyForked {
        uint24 inWindow = hook.currentFeeBps(FIXTURE_ID, card);
        assertLt(inWindow, hook.MAX_FEE_BPS(), "fee is capped - the surcharge would be invisible");

        vm.warp(block.timestamp + 61);
        uint24 afterWindow = hook.currentFeeBps(FIXTURE_ID, card);

        assertEq(inWindow - afterWindow, hook.EVENT_SURCHARGE_BPS(), "surcharge is not exactly 50 bps");
        assertGe(afterWindow, hook.BASE_FEE_BPS(), "fee fell below base");
    }

    /// @notice And an event during the match re-arms it.
    function test_EventSurchargeReArms() public onlyForked {
        vm.warp(block.timestamp + 61);
        uint24 quiet = hook.currentFeeBps(FIXTURE_ID, card);

        _postHeartbeat();
        assertEq(
            hook.currentFeeBps(FIXTURE_ID, card) - _divergenceDelta(quiet),
            quiet + hook.EVENT_SURCHARGE_BPS(),
            "surcharge did not re-arm on a heartbeat"
        );
    }

    /// @dev A heartbeat advances the clock, which moves `R` a little and so moves the
    ///      divergence term with it. This isolates the surcharge from that drift.
    function _divergenceDelta(uint24 quiet) private returns (uint24) {
        uint256 snapshot = vm.snapshotState();
        vm.warp(block.timestamp + 61);
        uint24 driftOnly = hook.currentFeeBps(FIXTURE_ID, card);
        vm.revertToState(snapshot);
        return driftOnly - quiet;
    }

    /// @notice A single conceded goal reprices the keeper hard enough that the pool
    ///         anchor is stale by hundreds of bps, and the fee saturates.
    function test_FeeIsCappedAt200Bps() public onlyForked {
        _postGoal();
        vm.warp(block.timestamp + 61); // past the event surcharge, so only divergence is left
        assertEq(hook.currentFeeBps(FIXTURE_ID, card), hook.MAX_FEE_BPS(), "fee is not capped");
    }

    // ------------------------------------------------------- pagination

    /// @notice A 40-order queue clears across several bounded calls, and every one of
    ///         them clears at the same price, because nothing moved R in between.
    function test_FortyOrderQueueClearsAcrossCalls() public onlyForked {
        address[4] memory traders =
            [_eoa("bulk0"), _eoa("bulk1"), _eoa("bulk2"), _eoa("bulk3")];
        for (uint256 i = 0; i < traders.length; ++i) {
            _fundExtra(traders[i], 5_000e18);
        }

        // Interleaved, so each page of ten is a balanced book and the vault is never
        // the binding constraint.
        for (uint256 i = 0; i < 40; ++i) {
            address who = traders[i % traders.length];
            _queue(who, i % 2 == 0 ? IMarketVenue.Side.BUY : IMarketVenue.Side.SELL, 100e18, 0);
        }
        assertEq(hook.queueLength(FIXTURE_ID), 40, "queue length");

        vm.warp(block.timestamp + 61);

        uint256 totalProcessed;
        uint256 calls;
        vm.recordLogs();
        while (hook.queueHead(FIXTURE_ID) < 40) {
            vm.prank(keeper);
            (, uint256 processed) = hook.tick(FIXTURE_ID, TICK_CARDS, 10);
            if (processed == 0) break;
            totalProcessed += processed;
            ++calls;
            assertLt(calls, 20, "tick made no progress");
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(totalProcessed, 40, "not every order cleared");
        assertGt(calls, 1, "the whole queue cleared in one call - pagination untested");
        assertEq(hook.queueHead(FIXTURE_ID), 40, "queue head did not reach the end");

        // Identical price on all 40 fills, across every call.
        _assertUniformPrice(logs, r);
        console.log("40-order queue cleared in calls:", calls);
    }

    /// @notice The page bound is a real ceiling: `maxCards * maxOrdersPerCard`
    ///         sizes the tick's memory arrays, so an unbounded page would blow the
    ///         block on allocation before it cleared anything.
    function test_TickRejectsAnOversizedPage() public onlyForked {
        vm.expectRevert(WhistleHook.PageTooLarge.selector);
        hook.tick(FIXTURE_ID, 32, 32); // 1024 > MAX_TICK_ORDERS

        // The boundary itself is fine.
        vm.prank(keeper);
        hook.tick(FIXTURE_ID, 4, 64); // exactly 256
    }

    /// @notice Paging by card: a page of one card clears only that card's orders and
    ///         leaves the rest of the book for the next call, however many other
    ///         cards are waiting.
    function test_TickPagesByCard() public onlyForked {
        _queue(agentA, IMarketVenue.Side.BUY, 100e18, 0);
        _queue(human, IMarketVenue.Side.BUY, 100e18, 0);
        vm.warp(block.timestamp + 61);

        vm.prank(keeper);
        (, uint256 processed) = hook.tick(FIXTURE_ID, 1, 1);
        assertEq(processed, 1, "a one-card, one-order page cleared more than one order");

        vm.prank(keeper);
        (, uint256 second) = hook.tick(FIXTURE_ID, 1, 8);
        assertEq(second, 1, "the second call did not pick up the remainder");

        vm.prank(keeper);
        (, uint256 third) = hook.tick(FIXTURE_ID, TICK_CARDS, 8);
        assertEq(third, 0, "the book should be empty");
    }

    function test_TickRejectsZeroMaxOrders() public onlyForked {
        vm.expectRevert(WhistleHook.ZeroAmount.selector);
        hook.tick(FIXTURE_ID, TICK_CARDS, 0);

        vm.expectRevert(WhistleHook.ZeroAmount.selector);
        hook.tick(FIXTURE_ID, 0, 8);
    }

    /// @notice A tick is bounded by gas as well as by count.
    function test_GasBudgetStopsTheScan() public onlyForked {
        for (uint256 i = 0; i < 12; ++i) {
            _queue(human, IMarketVenue.Side.BUY, 10e18, 0);
        }
        vm.warp(block.timestamp + 61);

        hook.setTickGasBudget(450_000); // barely above GAS_RESERVE

        // One card, a page big enough to take all twelve: only the gas budget can
        // be what stops this short.
        vm.prank(keeper);
        (, uint256 processed) = hook.tick(FIXTURE_ID, 1, 64);
        assertLt(processed, 12, "gas budget did not bound the scan");
    }

    // ----------------------------------------------------- router setter

    /// @notice The fill router is the one address allowed to trigger a custom-curve
    ///         fill, so the setter has to be both one-shot and owner-only. A second
    ///         call reverts even for the operator.
    function test_FillRouterSetterIsOneShot() public onlyForked {
        assertEq(address(hook.fillRouter()), address(router), "router not set by the rig");

        WhistleFillRouter usurper = new WhistleFillRouter(POOL_MANAGER, address(hook));

        vm.expectRevert(WhistleHook.RouterAlreadySet.selector);
        hook.setFillRouter(usurper);

        assertEq(address(hook.fillRouter()), address(router), "router was replaced");
    }

    /// @notice And a non-operator cannot set it, even before it is set.
    function test_FillRouterSetterIsOperatorOnly() public onlyForked {
        WhistleFillRouter usurper = new WhistleFillRouter(POOL_MANAGER, address(hook));

        vm.prank(human);
        vm.expectRevert(WhistleHook.OnlyOperator.selector);
        hook.setFillRouter(usurper);

        assertEq(address(hook.fillRouter()), address(router), "router was replaced by a stranger");
    }

    /// @notice The operator-only check is what a fresh hook relies on before its
    ///         router exists, so prove it there too rather than only on a set hook.
    function test_UnsetFillRouterIsStillOperatorOnly() public onlyForked {
        WhistleHookHarness fresh = _deployBareHook();
        assertEq(address(fresh.fillRouter()), address(0), "fresh hook already has a router");

        WhistleFillRouter theirs = new WhistleFillRouter(POOL_MANAGER, address(fresh));

        vm.prank(human);
        vm.expectRevert(WhistleHook.OnlyOperator.selector);
        fresh.setFillRouter(theirs);

        // The operator can, exactly once.
        fresh.setFillRouter(theirs);
        assertEq(address(fresh.fillRouter()), address(theirs), "operator could not set it");

        vm.expectRevert(WhistleHook.RouterAlreadySet.selector);
        fresh.setFillRouter(theirs);
    }

    /// @notice Cards cannot be registered before the router exists, because
    ///         registration grants it the ERC-20 approvals it settles with.
    function test_RegisterCardNeedsTheRouterFirst() public onlyForked {
        WhistleHookHarness fresh = _deployBareHook();

        vm.expectRevert(WhistleHook.RouterNotSet.selector);
        fresh.registerCard(FIXTURE_ID, card, key);
    }

    /// @dev A second hook at a different mined address, with no router set.
    function _deployBareHook() private returns (WhistleHookHarness fresh) {
        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
        bytes memory args =
            abi.encode(POOL_MANAGER, oracle, IAgentAuth(address(agentRegistry)), feeRecipient, address(this));
        (, bytes32 salt) = HookMiner.find(address(this), flags, type(WhistleHookHarness).creationCode, args);
        fresh = new WhistleHookHarness{salt: salt}(
            POOL_MANAGER, oracle, IAgentAuth(address(agentRegistry)), feeRecipient, address(this)
        );
    }

    // -------------------------------------------------------------- gas

    /// @notice Where the money goes on the queue path: an agent order carries a full
    ///         live ENS read, a human order carries none.
    function test_Gas_QueueOrderAgentVsHuman() public onlyForked {
        vm.prank(human);
        uint256 g = gasleft();
        hook.queueOrder(FIXTURE_ID, card, IMarketVenue.Side.BUY, 100e18, 0, false);
        uint256 humanGas = g - gasleft();

        vm.prank(agentA);
        g = gasleft();
        hook.queueOrder(FIXTURE_ID, card, IMarketVenue.Side.BUY, 100e18, 0, false);
        uint256 agentGas = g - gasleft();

        // Warm-path delta: the human call above already warmed the pot, the oracle
        // and the registry accounts. The cold cost of the ENS read on its own is what
        // AuthChecked reports during a tick, and it is materially higher.
        console.log("queueOrder human (warm)", humanGas);
        console.log("queueOrder agent (warm)", agentGas);
        console.log("  warm-path ENS delta  ", agentGas - humanGas);
        assertGt(agentGas, humanGas, "an agent order should cost strictly more");
    }

    function test_Gas_QueueAndTick() public onlyForked {
        _gasFor(1);
        _gasFor(3);
        _gasFor(20);
    }

    function _gasFor(uint256 n) private {
        address[4] memory traders =
            [_eoa(string.concat("g", vm.toString(n), "a")), _eoa(string.concat("g", vm.toString(n), "b")),
             _eoa(string.concat("g", vm.toString(n), "c")), _eoa(string.concat("g", vm.toString(n), "d"))];
        for (uint256 i = 0; i < traders.length; ++i) {
            _fundExtra(traders[i], 5_000e18);
        }

        uint256 queueGas;
        for (uint256 i = 0; i < n; ++i) {
            address who = traders[i % traders.length];
            vm.prank(who);
            uint256 before = gasleft();
            hook.queueOrder(
                FIXTURE_ID, card, i % 2 == 0 ? IMarketVenue.Side.BUY : IMarketVenue.Side.SELL, 100e18, 0, false
            );
            queueGas += before - gasleft();
        }

        vm.warp(block.timestamp + 61);

        vm.prank(keeper);
        uint256 g = gasleft();
        hook.tick(FIXTURE_ID, TICK_CARDS, n);
        uint256 tickGas = g - gasleft();

        console.log("orders", n);
        console.log("  queueOrder avg gas", queueGas / n);
        console.log("  tick total gas    ", tickGas);
        console.log("  tick per order    ", tickGas / n);
    }

    // --------------------------------------------------------- helpers

    function _postGoal() private {
        uint16[] memory ids = new uint16[](1);
        ids[0] = 3; // a forward on the other side, so the GK card's clean sheet dies
        // Read the clock BEFORE the prank: an argument that is itself an external
        // call would otherwise consume it, and postEvent would arrive unpranked.
        uint16 minute = oracle.matchClock(FIXTURE_ID) + 5;
        vm.prank(oracleSigner);
        oracle.postEvent(FIXTURE_ID, minute, IMatchOracle.EventType.GOAL, ids, uint64(block.timestamp));
    }

    function _postHeartbeat() private {
        uint16[] memory none = new uint16[](0);
        uint16 minute = oracle.matchClock(FIXTURE_ID) + 5;
        vm.prank(oracleSigner);
        oracle.postEvent(FIXTURE_ID, minute, IMatchOracle.EventType.HEARTBEAT, none, uint64(block.timestamp));
    }

    function _fee(uint256 notional, uint256 bps) private pure returns (uint256) {
        return Math.mulDiv(notional, bps, BPS);
    }

    /// @dev Every `OrderFilled` in `logs` priced the fill at exactly `expectedR`.
    function _assertUniformPrice(Vm.Log[] memory logs, uint256 expectedR) private pure {
        bytes32 sig = keccak256("OrderFilled(uint256,address,uint256,uint256,uint256)");
        uint256 seen;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != sig) continue;
            (uint256 units, uint256 usdcAmount, uint256 priceUsed) =
                abi.decode(logs[i].data, (uint256, uint256, uint256));
            require(priceUsed == expectedR, "fill priced away from R");
            require(usdcAmount == Math.mulDiv(expectedR, units, WAD), "notional is not units * R");
            ++seen;
        }
        require(seen > 0, "no fills to check");
    }

    function _batchResidual(Vm.Log[] memory logs) private pure returns (int256) {
        bytes32 sig = keccak256("BatchCleared(address,uint256,uint256,uint256,int256)");
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != sig) continue;
            (,,, int256 residual) = abi.decode(logs[i].data, (uint256, uint256, uint256, int256));
            return residual;
        }
        revert("no BatchCleared");
    }

    function _cancelReason(Vm.Log[] memory logs, uint256 orderId)
        private
        pure
        returns (IMarketVenue.CancelReason)
    {
        bytes32 sig = keccak256("OrderCancelled(uint256,uint8)");
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length < 2 || logs[i].topics[0] != sig) continue;
            if (uint256(logs[i].topics[1]) != orderId) continue;
            return IMarketVenue.CancelReason(abi.decode(logs[i].data, (uint8)));
        }
        revert("no OrderCancelled for that order");
    }

    function _authReads(Vm.Log[] memory logs, address agent) private pure returns (uint256 count, uint256 gasUsed) {
        bytes32 sig = keccak256("AuthChecked(address,bool,uint256)");
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length < 2 || logs[i].topics[0] != sig) continue;
            if (address(uint160(uint256(logs[i].topics[1]))) != agent) continue;
            (, uint256 g) = abi.decode(logs[i].data, (bool, uint256));
            gasUsed = g;
            ++count;
        }
    }
}
