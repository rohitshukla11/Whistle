// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {WhistleTestBase} from "./WhistleTestBase.sol";
import {PlayerCard} from "../../src/core/PlayerCard.sol";
import {SettlementPot} from "../../src/core/SettlementPot.sol";
import {IMatchOracle} from "../../src/core/interfaces/IMatchOracle.sol";

/// @notice The settlement invariant: payouts exhaust the pot, to within dust.
contract SettlementFuzzTest is WhistleTestBase {
    /// @dev One wei of USDC (1e-6) of slack per card is the most rounding can cost,
    ///      since each payout is a single floor division.
    function _dustAllowance() internal pure returns (uint256) {
        return PLAYERS;
    }

    function _playMatch() internal {
        _kickoff();
        _heartbeat(5);
        _post(12, IMatchOracle.EventType.GOAL, _ids(10, 6));
        _heartbeat(25);
        _post(31, IMatchOracle.EventType.RED, _ids(22));
        _post(46, IMatchOracle.EventType.SUB, _ids(9, 16));
        _heartbeat(60);
        _post(71, IMatchOracle.EventType.GOAL, _ids(28));
        _heartbeat(85);
        vm.prank(oracleSigner);
        oracle.postFinal(FIXTURE_ID, new uint256[](0));
    }

    /// @notice Sum of every holder's payout equals the snapshot, minus dust.
    function testFuzz_PayoutsSumToPot(uint16 seed) public {
        for (uint16 i = 0; i < PLAYERS; ++i) {
            uint256 units = (uint256(keccak256(abi.encode(seed, i))) % 900 + 1) * 1e18;
            pot.mintPreMatch(pot.cards(i), units, address(this));
        }

        _playMatch();

        uint256 snapshot = pot.potSnapshot();
        assertGt(snapshot, 0, "pot snapshot empty");

        uint256 totalPayout;
        for (uint16 i = 0; i < PLAYERS; ++i) {
            address card = pot.cards(i);
            totalPayout += pot.quoteRedeem(card, PlayerCard(card).totalSupply());
        }

        assertLe(totalPayout, snapshot, "payouts exceed the pot");
        assertApproxEqAbs(totalPayout, snapshot, _dustAllowance(), "payouts did not exhaust the pot");
    }

    /// @notice The same invariant through the real redemption path.
    function testFuzz_RedeemingEverythingDrainsThePotToDust(uint16 seed) public {
        for (uint16 i = 0; i < PLAYERS; ++i) {
            uint256 units = (uint256(keccak256(abi.encode(seed, i))) % 900 + 1) * 1e18;
            pot.mintPreMatch(pot.cards(i), units, address(this));
        }

        _playMatch();
        uint256 snapshot = pot.potSnapshot();

        uint256 received;
        for (uint16 i = 0; i < PLAYERS; ++i) {
            address card = pot.cards(i);
            uint256 supply = PlayerCard(card).totalSupply();
            if (supply == 0) continue;
            received += pot.redeem(card, supply, address(this));
        }

        assertApproxEqAbs(received, snapshot, _dustAllowance(), "redemptions did not drain the pot");
        // Dust stays behind, and it is genuinely small.
        assertLe(usdc.balanceOf(address(pot)), _dustAllowance(), "too much USDC left stranded");
    }

    /// @notice Payout per unit must not depend on redemption order.
    /// @dev This is why the pot is snapshotted at settlement: against a live
    ///      balance, each redemption would shrink the pot and inflate the next
    ///      redeemer's share.
    function test_PayoutIsIndependentOfRedemptionOrder() public {
        _mintAllAtP0(200e18);
        _playMatch();

        address first = pot.cards(10);
        address last = pot.cards(28);

        uint256 quotedLastBefore = pot.quoteRedeem(last, 100e18);
        pot.redeem(first, 200e18, address(this));
        uint256 quotedLastAfter = pot.quoteRedeem(last, 100e18);

        assertEq(quotedLastAfter, quotedLastBefore, "an earlier redemption moved a later payout");
    }

    function test_RedeemRevertsBeforeSettlement() public {
        _mintAllAtP0(100e18);
        address card = pot.cards(0);
        vm.expectRevert(SettlementPot.NotSettled.selector);
        pot.redeem(card, 1e18, address(this));
    }

    /// @notice A zero-score card pays nothing but does not break the invariant.
    function test_ZeroScoreCardsPayNothing() public {
        _mintAllAtP0(200e18);
        _playMatch();

        // Player 22 was sent off on 31 minutes; the penalty floors the score at 0.
        assertEq(oracle.finalScore(FIXTURE_ID, 22), 0, "expected a floored score");
        assertEq(pot.quoteRedeem(pot.cards(22), 200e18), 0, "zero-score card paid out");

        // Unused substitutes likewise.
        assertEq(oracle.finalScore(FIXTURE_ID, 30), 0, "unused sub scored");
        assertEq(pot.quoteRedeem(pot.cards(30), 200e18), 0, "unused sub card paid out");
    }
}
