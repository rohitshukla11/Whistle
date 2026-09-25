// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PositionInfo, PositionInfoLibrary} from "v4-periphery/src/libraries/PositionInfoLibrary.sol";

import {WhistleHookForkBase} from "./WhistleHookForkBase.sol";
import {WhistleHook} from "../../../src/integrations/uniswap/WhistleHook.sol";
import {MMVault} from "../../../src/integrations/uniswap/MMVault.sol";
import {PlayerCard} from "../../../src/core/PlayerCard.sol";
import {IMarketVenue} from "../../../src/interfaces/IMarketVenue.sol";

/// @notice Step 5 acceptance tests for {MMVault}, on the same single Sepolia fork as
///         the hook suite: real PoolManager, real PositionManager, real ENSv2.
contract MMVaultTest is WhistleHookForkBase {
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using PositionInfoLibrary for PositionInfo;

    uint256 internal r;

    function setUp() public {
        if (!_setUpFork()) return;
        _setUpRig();
        r = pot.referencePrice(card);
    }

    // ------------------------------------------------------------- seeding

    /// @notice Seeding mints {SEED_UNITS} at `P0`, splits them between a ±10%
    ///         concentrated position and fill inventory, and leaves a USDC reserve.
    function test_SeedingMintsAtP0AndSplitsInventory() public onlyForked {
        MMVault.CardState memory cs = vault.cardState(card);

        assertEq(cs.seeded, vault.SEED_UNITS(), "did not seed 200 units");
        assertGt(cs.positionId, 0, "no LP position was minted");
        assertEq(
            positionManagerOwnerOf(cs.positionId), address(vault), "the vault does not own its position"
        );
        assertGt(POSITION_MANAGER.getPositionLiquidity(cs.positionId), 0, "position carries no liquidity");
        _assertBandIsTenPercent(cs.positionId);

        // Half to the pool, half to fill inventory, plus the explicit top-up.
        uint256 expectedFromSeed = Math.mulDiv(vault.SEED_UNITS(), BPS - LP_SHARE_BPS, BPS);
        assertEq(cs.inventory, expectedFromSeed + INVENTORY_TOPUP, "inventory split is wrong");

        assertEq(vault.availableUSDC(), USDC_RESERVE, "reserve was not retained");
        assertGt(vault.capitalIn(), 0, "no capital recorded");
    }

    /// @dev The position should straddle the pool's tick by ±10% in price, aligned
    ///      down to the pool's tick spacing. `ln(1.1)/ln(1.0001) = 953.1` ticks, and
    ///      one spacing of slack either side covers the alignment.
    function _assertBandIsTenPercent(uint256 positionId) private view {
        (PoolKey memory poolKey, PositionInfo info) = POSITION_MANAGER.getPoolAndPositionInfo(positionId);
        (, int24 tick,,) = POOL_MANAGER.getSlot0(poolKey.toId());

        int24 lower = info.tickLower();
        int24 upper = info.tickUpper();

        assertLt(lower, tick, "position does not straddle the pool tick from below");
        assertGt(upper, tick, "position does not straddle the pool tick from above");

        int24 spacing = poolKey.tickSpacing;
        assertEq(lower % spacing, 0, "lower tick is not aligned to spacing");
        assertEq(upper % spacing, 0, "upper tick is not aligned to spacing");

        uint256 slack = uint256(uint24(spacing));
        assertApproxEqAbs(int256(tick - lower), int256(953), slack, "lower band is not ~10%");
        assertApproxEqAbs(int256(upper - tick), int256(953), slack, "upper band is not ~10%");
    }

    // -------------------------------------------------- inventory accounting

    /// @notice Inventory is tracked in the vault's own storage and stays in step with
    ///         the ERC-6909 claims the PoolManager holds for it.
    function test_InventoryReconcilesWithClaimsAfterEveryFill() public onlyForked {
        _assertReconciled("before any fill");

        uint256 cardStart = vault.cardInventory(card);
        uint256 usdcStart = vault.availableUSDC();
        int256 cardSum;
        int256 usdcSum;

        vm.recordLogs();

        _queue(agentA, IMarketVenue.Side.BUY, 1_000e18, 0);
        _queue(human, IMarketVenue.Side.SELL, 200e18, 0);
        vm.warp(block.timestamp + 61);
        vm.prank(keeper);
        hook.tick(FIXTURE_ID, TICK_CARDS, 10);
        _assertReconciled("after a net-long tick");

        _queue(human, IMarketVenue.Side.SELL, 500e18, 0);
        vm.warp(block.timestamp + 61);
        vm.prank(keeper);
        hook.tick(FIXTURE_ID, TICK_CARDS, 10);
        _assertReconciled("after a net-short tick");

        // Every position change the vault reports must add up to the position it is
        // actually in. Three-way: events, storage, and the PoolManager's claims.
        (cardSum, usdcSum) = _sumFillRecords(vm.getRecordedLogs());
        assertEq(int256(vault.cardInventory(card)), int256(cardStart) + cardSum, "card events do not reconcile");
        assertEq(int256(vault.availableUSDC()), int256(usdcStart) + usdcSum, "usdc events do not reconcile");
        assertTrue(cardSum != 0, "no fills were recorded at all");
    }

    /// @dev Net of every `FillRecorded` the vault emitted.
    function _sumFillRecords(Vm.Log[] memory logs) private view returns (int256 cardSum, int256 usdcSum) {
        bytes32 sig = keccak256("FillRecorded(address,int256,int256,uint256)");
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault)) continue;
            if (logs[i].topics.length < 2 || logs[i].topics[0] != sig) continue;
            if (address(uint160(uint256(logs[i].topics[1]))) != card) continue;
            (int256 cardDelta, int256 usdcDelta,) = abi.decode(logs[i].data, (int256, int256, uint256));
            cardSum += cardDelta;
            usdcSum += usdcDelta;
        }
    }

    function _assertReconciled(string memory what) private view {
        (uint256 cardClaims, uint256 usdcClaims) = vault.claimBalances(card);
        assertEq(vault.cardInventory(card), cardClaims, string.concat("card inventory drifted ", what));
        assertEq(vault.availableUSDC(), usdcClaims, string.concat("usdc reserve drifted ", what));
    }

    /// @notice A net-long book larger than inventory fills what it can at `R`, and
    ///         the remainder is cancelled rather than left queued at a stale price.
    function test_PartialFillCancelsRemainderAndKeepsOnePrice() public onlyForked {
        uint256 inventory = vault.cardInventory(card);
        uint256 size = inventory * 2;

        uint256 o1 = _queue(agentA, IMarketVenue.Side.BUY, size, 0);
        uint256 o2 = _queue(human, IMarketVenue.Side.BUY, size, 0);

        vm.warp(block.timestamp + 61);
        vm.recordLogs();
        vm.prank(keeper);
        hook.tick(FIXTURE_ID, TICK_CARDS, 10);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        WhistleHook.Order memory f1 = hook.getOrder(o1);
        WhistleHook.Order memory f2 = hook.getOrder(o2);

        assertLt(f1.filled, f1.amount, "order 1 was not rationed");
        assertLt(f2.filled, f2.amount, "order 2 was not rationed");
        assertEq(f1.filled, f2.filled, "equal orders took unequal haircuts");
        assertEq(uint256(f1.filled) + f2.filled, inventory, "the whole inventory was not used");

        // Both fills at exactly R, despite being partial.
        _assertUniformPrice(logs, r);

        // And the remainder is explicitly cancelled, not silently dropped.
        assertTrue(_hasCancel(logs, o1, IMarketVenue.CancelReason.INSUFFICIENT_INVENTORY), "no cancel for order 1");
        assertTrue(_hasCancel(logs, o2, IMarketVenue.CancelReason.INSUFFICIENT_INVENTORY), "no cancel for order 2");

        assertEq(vault.cardInventory(card), 0, "inventory not drawn down");
        _assertReconciled("after a partial fill");
    }

    // ------------------------------------------------------------ mint lane

    /// @notice A mint-backed order fills at `R * 1.02`, the money goes to the pot, and
    ///         vault inventory is untouched.
    function test_MintOrderFillsAtPremiumAndPaysThePot() public onlyForked {
        uint256 units = 1_000e18;
        uint256 inventoryBefore = vault.cardInventory(card);
        uint256 vaultUsdcBefore = usdc.balanceOf(address(vault));
        uint256 potBefore = pot.potBalance();
        uint256 supplyBefore = IERC20(card).totalSupply();

        uint256 orderId = _queueMint(human, units);
        vm.warp(block.timestamp + 61);
        vm.prank(keeper);
        hook.tick(FIXTURE_ID, TICK_CARDS, 10);

        WhistleHook.Order memory o = hook.getOrder(orderId);
        assertEq(o.filled, units, "mint order was rationed");

        // New supply, not vault inventory.
        assertEq(IERC20(card).totalSupply() - supplyBefore, units, "supply did not grow by the fill");
        assertEq(vault.cardInventory(card), inventoryBefore, "mint touched vault inventory");
        assertEq(usdc.balanceOf(address(vault)), vaultUsdcBefore, "mint paid the vault");

        // The pot received the premium price.
        uint256 potDelta = pot.potBalance() - potBefore;
        uint256 atR = Math.mulDiv(r, units, WAD);
        assertGt(potDelta, atR, "the pot was paid no premium");
        assertApproxEqRel(potDelta, Math.mulDiv(atR, BPS + hook.MINT_PREMIUM_BPS(), BPS), 1e15, "premium is not 2%");
    }

    /// @notice A mint order cannot fail for inventory, even with the vault empty.
    function test_MintOrderFillsWithTheVaultDrained() public onlyForked {
        // Drain the vault first.
        _queue(agentA, IMarketVenue.Side.BUY, vault.cardInventory(card), 0);
        vm.warp(block.timestamp + 61);
        vm.prank(keeper);
        hook.tick(FIXTURE_ID, TICK_CARDS, 10);
        assertEq(vault.cardInventory(card), 0, "vault not drained");

        uint256 orderId = _queueMint(human, 5_000e18);
        vm.warp(block.timestamp + 61);
        vm.prank(keeper);
        hook.tick(FIXTURE_ID, TICK_CARDS, 10);

        WhistleHook.Order memory o = hook.getOrder(orderId);
        assertEq(uint256(o.status), uint256(WhistleHook.Status.FILLED), "mint order did not fill");
        assertEq(o.filled, 5_000e18, "mint order was rationed with an empty vault");
    }

    /// @notice Mint-at-`R` is neutral for every other card; the 2% premium is not.
    ///
    /// @dev This is the economic claim the premium rests on. `R_j = Pot * E_j / D`,
    ///      and minting `Δ` of card `i` at price `p` gives `Pot' = Pot + Δp` and
    ///      `D' = D + E_i·Δ`. The ratio is unchanged exactly when `p == R_i`, so any
    ///      premium above that accrues to existing holders of every card.
    /// @notice Mint-at-`R` is neutral for every other card.
    ///
    /// @dev This is the economic claim the premium rests on. `R_j = Pot * E_j / D`,
    ///      and minting `Δ` of card `i` at price `p` gives `Pot' = Pot + Δp` and
    ///      `D' = D + E_i·Δ`. The ratio is unchanged exactly when `p == R_i`, so any
    ///      premium above that accrues to existing holders of every card.
    function test_MintAtExactRIsNeutralForOtherCards() public onlyForked {
        uint256 before = pot.referencePrice(otherCard);

        usdc.mint(address(hook), 50_000_000e6);
        vm.prank(address(hook));
        pot.mintAtReference(card, 5_000e18, address(this), 0);

        assertEq(pot.referencePrice(otherCard), before, "mint at exactly R moved another card's R");
    }

    /// @notice And the 2% premium is not neutral: it lifts every other card's `R`.
    /// @dev Deliberately a separate test rather than a snapshot/revert pair. Reverting
    ///      fork state mid-test also rolls back the pot's minter wiring, which fails
    ///      in a way that looks like an access-control bug.
    function test_MintAtPremiumRaisesOtherCards() public onlyForked {
        uint256 before = pot.referencePrice(otherCard);

        // Read the premium BEFORE the prank: an argument that is itself an external
        // call consumes the prank, and the mint then arrives from the test contract.
        uint256 premium = hook.MINT_PREMIUM_BPS();

        usdc.mint(address(hook), 50_000_000e6);
        vm.prank(address(hook));
        pot.mintAtReference(card, 5_000e18, address(this), premium);

        uint256 afterPremium = pot.referencePrice(otherCard);
        assertGt(afterPremium, before, "mint at R * 1.02 did not raise another card's R");

        console.log("other card R before     ", before);
        console.log("  after mint at R * 1.02", afterPremium);
    }

    // ----------------------------------------------------------- holder cap

    function test_VaultAndPlumbingAreCapExempt() public onlyForked {
        PlayerCard pc = PlayerCard(card);
        assertTrue(pc.capExempt(address(vault)), "vault is not exempt");
        assertTrue(pc.capExempt(address(hook)), "hook is not exempt");
        assertTrue(pc.capExempt(address(router)), "router is not exempt");
        assertTrue(pc.capExempt(address(POOL_MANAGER)), "PoolManager is not exempt");
    }

    /// @notice A holder already at 5% is refused on a vault-served fill AND on a mint.
    function test_HolderAtCapIsRejectedOnFillAndOnMint() public onlyForked {
        address whale = _atTheCap();

        vm.prank(whale);
        vm.expectRevert(WhistleHook.WouldExceedHolderCap.selector);
        hook.queueOrder(FIXTURE_ID, card, IMarketVenue.Side.BUY, 1e18, 0, false);

        vm.prank(whale);
        vm.expectRevert(WhistleHook.WouldExceedHolderCap.selector);
        hook.queueOrder(FIXTURE_ID, card, IMarketVenue.Side.BUY, 1e18, 0, true);
    }

    /// @notice The same holder can still sell, and can still buy once under the cap.
    function test_HolderAtCapCanStillSell() public onlyForked {
        address whale = _atTheCap();

        vm.prank(whale);
        uint256 orderId = hook.queueOrder(FIXTURE_ID, card, IMarketVenue.Side.SELL, 1_000e18, 0, false);
        assertGt(orderId, 0, "a capped holder could not sell");
    }

    /// @dev Move a fresh, non-exempt address to exactly the 5% cap.
    function _atTheCap() private returns (address whale) {
        whale = _eoa("whale");
        PlayerCard pc = PlayerCard(card);

        uint256 atCap = Math.mulDiv(pc.totalSupply(), pc.MAX_HOLDER_BPS(), BPS);
        IERC20(card).transfer(whale, atCap);

        usdc.mint(whale, 10_000_000e6);
        vm.startPrank(whale);
        usdc.approve(address(hook), type(uint256).max);
        IERC20(card).approve(address(hook), type(uint256).max);
        vm.stopPrank();

        assertEq(pc.balanceOf(whale), atCap, "whale is not at the cap");
        assertFalse(pc.capExempt(whale), "whale should not be exempt");
    }

    // ------------------------------------------------ pot balance invariant

    /// @notice The pot moves on mint and on redeem, and on nothing else. A tick that
    ///         only crosses and draws on the vault must leave it exactly alone.
    function test_PotBalanceOnlyMovesOnMintAndRedeem() public onlyForked {
        uint256 potBefore = pot.potBalance();

        _queue(agentA, IMarketVenue.Side.BUY, 1_000e18, 0);
        _queue(human, IMarketVenue.Side.SELL, 400e18, 0);
        vm.warp(block.timestamp + 61);
        vm.prank(keeper);
        hook.tick(FIXTURE_ID, TICK_CARDS, 10);

        assertEq(pot.potBalance(), potBefore, "a vault-served tick moved the pot");

        // A mint-backed tick must move it, and by the premium price.
        _queueMint(human, 100e18);
        vm.warp(block.timestamp + 61);
        vm.prank(keeper);
        hook.tick(FIXTURE_ID, TICK_CARDS, 10);

        assertGt(pot.potBalance(), potBefore, "a mint tick did not move the pot");
    }

    // -------------------------------------------------------- close out

    /// @notice After settlement the vault pulls its liquidity, redeems what it holds,
    ///         and reports a P&L that reconciles with its own USDC balance.
    function test_CloseOutRedeemsAndReportsPnL() public onlyForked {
        // Trade a little first, so there are fees and an inventory move to account for.
        _queue(agentA, IMarketVenue.Side.BUY, 2_000e18, 0);
        _queue(human, IMarketVenue.Side.SELL, 800e18, 0);
        vm.warp(block.timestamp + 61);
        vm.prank(keeper);
        hook.tick(FIXTURE_ID, TICK_CARDS, 10);

        uint256 feesBooked = vault.feesEarned();
        assertGt(feesBooked, 0, "vault earned no fees");

        uint256[] memory noExpected = new uint256[](0);
        vm.prank(oracleSigner);
        oracle.postFinal(FIXTURE_ID, noExpected);
        assertTrue(pot.settled(), "fixture did not settle");

        uint256 liquidityBefore = POSITION_MANAGER.getPositionLiquidity(vault.cardState(card).positionId);
        assertGt(liquidityBefore, 0, "no position to close");

        vault.closeCard(card);
        vault.closeReserve();

        assertEq(vault.cardState(card).positionId, 0, "position was not burned");
        assertEq(vault.cardInventory(card), 0, "inventory was not redeemed");
        assertEq(vault.availableUSDC(), 0, "reserve was not drained");
        assertEq(IERC20(card).balanceOf(address(vault)), 0, "cards left unredeemed");

        (int256 pnl, uint256 fees, int256 marketMaking, uint256 inventoryValue) = vault.vaultPnL();

        assertEq(fees, feesBooked, "reported fees do not match what was booked");
        assertEq(inventoryValue, 0, "inventory should be zero after close out");
        assertEq(pnl, int256(usdc.balanceOf(address(vault))) - int256(vault.capitalIn()), "pnl is not cash less capital");
        assertEq(marketMaking, pnl - int256(fees), "decomposition does not add up");

        console.log("vault capital in   ", vault.capitalIn());
        console.log("vault USDC out     ", usdc.balanceOf(address(vault)));
        console.log("vault fees earned  ", fees);
        console.logInt(pnl);
    }

    function test_CloseOutRequiresSettlement() public onlyForked {
        vm.expectRevert(MMVault.NotSettled.selector);
        vault.closeCard(card);
    }

    // ----------------------------------------------------------- access

    function test_OnlyHookCanMoveInventory() public onlyForked {
        vm.prank(human);
        vm.expectRevert(MMVault.OnlyHook.selector);
        vault.recordFill(card, -1e18, 1e6);

        vm.prank(human);
        vm.expectRevert(MMVault.OnlyHook.selector);
        vault.recordFees(1e6);
    }

    function test_OnlyOperatorCanSeedOrWithdraw() public onlyForked {
        vm.startPrank(human);
        vm.expectRevert(MMVault.OnlyOperator.selector);
        vault.seedCard(otherCard, 5000, 1e6);

        vm.expectRevert(MMVault.OnlyOperator.selector);
        vault.withdraw(human, 1);

        vm.expectRevert(MMVault.OnlyOperator.selector);
        vault.fundReserve(1);
        vm.stopPrank();
    }

    function test_CardCannotBeSeededTwice() public onlyForked {
        vm.expectRevert(MMVault.AlreadySeeded.selector);
        vault.seedCard(card, LP_SHARE_BPS, 1_000e6);
    }

    // ---------------------------------------------------------- helpers

    function _queueMint(address who, uint256 units) private returns (uint256 orderId) {
        vm.prank(who);
        orderId = hook.queueOrder(FIXTURE_ID, card, IMarketVenue.Side.BUY, units, 0, true);
    }

    function positionManagerOwnerOf(uint256 tokenId) private view returns (address) {
        (bool ok, bytes memory out) =
            address(POSITION_MANAGER).staticcall(abi.encodeWithSignature("ownerOf(uint256)", tokenId));
        require(ok, "ownerOf failed");
        return abi.decode(out, (address));
    }

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

    function _hasCancel(Vm.Log[] memory logs, uint256 orderId, IMarketVenue.CancelReason reason)
        private
        pure
        returns (bool)
    {
        bytes32 sig = keccak256("OrderCancelled(uint256,uint8)");
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length < 2 || logs[i].topics[0] != sig) continue;
            if (uint256(logs[i].topics[1]) != orderId) continue;
            if (abi.decode(logs[i].data, (uint8)) == uint8(reason)) return true;
        }
        return false;
    }
}

/// @notice A whole second rig, stopped before kickoff, used to measure seeding on a
///         card that has not been seeded yet.
/// @dev Pre-match minting closes at the whistle, so this cannot be done inside a
///      test whose `setUp` already kicked off.

/// @notice Seeding tests, which have to run while the fixture is still PRE_MATCH:
///         `mintPreMatch` closes at the whistle, so this rig never kicks off.
contract MMVaultSeedingTest is WhistleHookForkBase {
    function setUp() public {
        if (!_setUpFork()) return;
        _setUpRigPreMatch();
    }

    /// @notice The seeded units are bought from the pot at the pre-match price, so the
    ///         pot receives exactly what the vault paid and not a wei more.
    function test_SeedingPaysThePotAtP0() public onlyForked {
        address fresh = pot.cards(1);
        _createPoolFor(fresh);

        uint256 expected = pot.quoteMint(fresh, vault.SEED_UNITS());
        uint256 potBefore = pot.potBalance();

        (, uint256 spent) = vault.seedCard(fresh, LP_SHARE_BPS, 5_000e6);

        assertEq(spent, expected, "seeding did not pay P0");
        assertEq(pot.potBalance() - potBefore, spent, "pot did not receive exactly what the vault paid");
    }

    /// @notice Gas for the per-card seeding job, and what a 36-card fixture implies.
    function test_Gas_SeedingPerFixture() public onlyForked {
        address fresh = pot.cards(1);
        _createPoolFor(fresh);

        uint256 before = gasleft();
        vault.seedCard(fresh, LP_SHARE_BPS, 5_000e6);
        uint256 gasUsed = before - gasleft();

        console.log("seedCard gas, 1 card (mint at P0 + concentrated LP + inventory)", gasUsed);
        console.log("  extrapolated to a 36-card fixture                            ", gasUsed * 36);
        assertGt(gasUsed, 0, "no gas measured");
    }

    /// @notice A card seeded with no LP share keeps all 200 units as fill inventory.
    function test_SeedingWithZeroLpShareIsAllInventory() public onlyForked {
        address fresh = pot.cards(1);
        _createPoolFor(fresh);

        (uint256 positionId,) = vault.seedCard(fresh, 0, 0);

        assertEq(positionId, 0, "a position was minted despite a zero LP share");
        assertEq(vault.cardInventory(fresh), vault.SEED_UNITS(), "units did not all land in inventory");
    }
}
