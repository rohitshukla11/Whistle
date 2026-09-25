// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {WhistleTestBase} from "./WhistleTestBase.sol";
import {PlayerCard} from "../../src/core/PlayerCard.sol";
import {SettlementPot} from "../../src/core/SettlementPot.sol";
import {IMatchOracle} from "../../src/core/interfaces/IMatchOracle.sol";

/// @notice The pricing invariants the whole design rests on.
contract EconomicsTest is WhistleTestBase {
    /// @dev Uneven supplies across cards, so a bug that only cancels under uniform
    ///      supply cannot hide.
    function _mintVaried() internal {
        for (uint16 i = 0; i < PLAYERS; ++i) {
            pot.mintPreMatch(pot.cards(i), (100 + uint256(i) * 7) * 1e18, address(this));
        }
    }

    // ------------------------------------------------- R == P0 at kickoff

    /// @notice If every card is minted at `P0_i = k * E_i`, then `R_i == P0_i`.
    /// @dev `Pot = sum(k*E_j*supply_j) = k*D`, so `R_i = Pot*E_i/D = k*E_i`.
    function test_ReferencePriceEqualsPreMatchPriceAtKickoff() public {
        _mintVaried();

        for (uint16 i = 0; i < PLAYERS; ++i) {
            address card = pot.cards(i);
            assertApproxEqAbs(
                pot.referencePrice(card), pot.preMatchPrice(card), 2, "R diverged from P0 at kickoff"
            );
        }
    }

    function test_ReferencePriceEqualsP0_UniformSupply() public {
        _mintAllAtP0(200e18);
        for (uint16 i = 0; i < PLAYERS; ++i) {
            address card = pot.cards(i);
            assertApproxEqAbs(pot.referencePrice(card), pot.preMatchPrice(card), 2, "R != P0");
        }
    }

    function testFuzz_ReferencePriceEqualsP0(uint16 supplySeed) public {
        for (uint16 i = 0; i < PLAYERS; ++i) {
            uint256 units = (uint256(supplySeed % 500) + 1 + uint256(i)) * 1e18;
            pot.mintPreMatch(pot.cards(i), units, address(this));
        }
        for (uint16 i = 0; i < PLAYERS; ++i) {
            address card = pot.cards(i);
            assertApproxEqAbs(pot.referencePrice(card), pot.preMatchPrice(card), 2, "R != P0");
        }
    }

    // ------------------------------------------------ mint-at-R neutrality

    /// @notice Minting at exactly `R_i` leaves every card's price untouched.
    function test_MintAtReferenceIsPriceNeutral() public {
        _mintVaried();
        uint256[] memory before = _referencePrices();

        pot.mintAtReference(pot.cards(7), 50e18, address(this), 0);

        uint256[] memory afterPrices = _referencePrices();
        for (uint16 i = 0; i < PLAYERS; ++i) {
            assertApproxEqAbs(afterPrices[i], before[i], 2, "mint at R moved a price");
        }
    }

    function testFuzz_MintAtReferenceIsPriceNeutral(uint8 cardIdx, uint96 units) public {
        uint16 idx = uint16(cardIdx) % PLAYERS;
        uint256 amount = uint256(units % 1000e18) + 1e18;

        _mintVaried();
        uint256[] memory before = _referencePrices();

        pot.mintAtReference(pot.cards(idx), amount, address(this), 0);

        uint256[] memory afterPrices = _referencePrices();
        for (uint16 i = 0; i < PLAYERS; ++i) {
            assertApproxEqAbs(afterPrices[i], before[i], 2, "mint at R moved a price");
        }
    }

    /// @notice The 2% LIVE premium accrues to existing holders across every card.
    function test_LivePremiumRaisesAllReferencePrices() public {
        _mintVaried();
        uint256[] memory before = _referencePrices();

        pot.mintAtReference(pot.cards(7), 500e18, address(this), 200);

        uint256[] memory afterPrices = _referencePrices();
        uint256 sumBefore;
        uint256 sumAfter;
        for (uint16 i = 0; i < PLAYERS; ++i) {
            assertGe(afterPrices[i], before[i], "premium lowered a price");
            sumBefore += before[i];
            sumAfter += afterPrices[i];
        }
        assertGt(sumAfter, sumBefore, "premium did not raise prices");
    }

    // ------------------------------------------------------ incremental D

    /// @notice Incremental `D` must equal a from-scratch recomputation exactly.
    /// @dev Every mutation is an exact integer add/sub with no division, so this is
    ///      an equality assertion, not an approximation.
    function test_IncrementalD_MatchesRecomputation_AfterMints() public {
        _mintVaried();
        assertEq(pot.d90(), pot.recomputeD90(), "D90 drifted after mints");
    }

    function test_IncrementalD_MatchesRecomputation_AfterEvents() public {
        _mintVaried();
        _kickoff();

        _heartbeat(5);
        _post(12, IMatchOracle.EventType.GOAL, _ids(10, 6));
        assertEq(pot.d90(), pot.recomputeD90(), "D90 drifted after goal");

        _heartbeat(20);
        _post(23, IMatchOracle.EventType.YELLOW, _ids(3));
        _post(31, IMatchOracle.EventType.RED, _ids(22));
        assertEq(pot.d90(), pot.recomputeD90(), "D90 drifted after red card");

        _post(46, IMatchOracle.EventType.SUB, _ids(9, 16));
        _heartbeat(60);
        _post(71, IMatchOracle.EventType.GOAL, _ids(28));
        _heartbeat(85);

        assertEq(pot.d90(), pot.recomputeD90(), "D90 drifted after full sequence");
    }

    /// @dev Interleaves LIVE mints with events, since a mint and an `E` update touch
    ///      `D` through different code paths.
    function testFuzz_IncrementalD_MatchesRecomputation(uint256 seed) public {
        _mintVaried();
        _kickoff();

        uint16 minute = 0;
        for (uint256 step = 0; step < 12; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));

            minute += uint16(1 + (seed % 6));
            if (minute > 88) break;

            uint16 player = uint16(seed >> 16) % PLAYERS;
            uint256 kind = (seed >> 32) % 3;

            if (kind == 0) {
                _heartbeat(minute);
            } else if (kind == 1) {
                _post(minute, IMatchOracle.EventType.GOAL, _ids(player));
            } else {
                _post(minute, IMatchOracle.EventType.YELLOW, _ids(player));
            }

            if ((seed >> 48) % 2 == 0) {
                uint16 target = uint16(seed >> 64) % PLAYERS;
                pot.mintAtReference(pot.cards(target), 1e18 + (seed % 100) * 1e18, address(this), 200);
            }

            assertEq(pot.d90(), pot.recomputeD90(), "D90 drifted mid-sequence");
        }

        assertEq(pot.d90(), pot.recomputeD90(), "D90 drifted at end of sequence");
    }

    // ------------------------------------------------------- holder cap

    function test_HolderCapBlocksOversizedMint() public {
        address card = pot.cards(0);
        factory.setCapExempt(card, address(this), false);

        // Seed supply through an exempt holder so a cap can exist at all.
        factory.setCapExempt(card, alice, true);
        pot.mintPreMatch(card, 1000e18, alice);

        // 5% of the post-mint supply is the ceiling; 60 units of ~1060 is 5.7%.
        vm.expectRevert();
        pot.mintPreMatch(card, 60e18, address(this));

        // 50 of 1050 is 4.76%, which fits.
        pot.mintPreMatch(card, 50e18, address(this));
        assertEq(PlayerCard(card).balanceOf(address(this)), 50e18);
    }

    function test_PreMatchMintClosesAtKickoff() public {
        _mintVaried();
        _kickoff();
        // Resolve the card first: vm.expectRevert binds to the very next call, and
        // `pot.cards(0)` would otherwise consume it.
        address card = pot.cards(0);
        vm.expectRevert(SettlementPot.NotPreMatch.selector);
        pot.mintPreMatch(card, 1e18, address(this));
    }
}
