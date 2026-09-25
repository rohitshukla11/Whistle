// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {WhistleTestBase} from "./WhistleTestBase.sol";
import {MatchOracle} from "../../src/core/MatchOracle.sol";
import {SettlementPot} from "../../src/core/SettlementPot.sol";
import {IMatchOracle} from "../../src/core/interfaces/IMatchOracle.sol";
import {ScoreMath} from "../../src/core/libraries/ScoreMath.sol";

/// @notice Scoring table transitions and the oracle's replay consistency.
contract ScoringTest is WhistleTestBase {
    /// @dev Minutes points for `m` minutes played, matching the scoring table.
    function _min(uint16 m) internal pure returns (uint256) {
        return (10e18 * uint256(m)) / 90;
    }

    function _state(uint16 id) internal view returns (ScoreMath.PlayerState memory) {
        return oracle.playerState(FIXTURE_ID, id);
    }

    /// @dev Minutes are derived from the clock and entry minute rather than stored,
    ///      so they come from the oracle view rather than the state struct.
    function _mins(uint16 id) internal view returns (uint16) {
        return oracle.minutesPlayed(FIXTURE_ID, id);
    }

    function _postAt(uint16 minute, IMatchOracle.EventType t, uint16[] memory ids, uint64 src) internal {
        vm.prank(oracleSigner);
        oracle.postEvent(FIXTURE_ID, minute, t, ids, src);
    }

    function setUp() public override {
        super.setUp();
        _mintAllAtP0(100e18);
    }

    // ------------------------------------------------ individual transitions

    function test_GoalAndAssistBankPoints() public {
        _kickoff();
        _post(12, IMatchOracle.EventType.GOAL, _ids(10, 6));

        assertEq(_state(10).banked, int256(ScoreMath.PTS_GOAL), "scorer did not bank 12");
        assertEq(_state(6).banked, int256(ScoreMath.PTS_ASSIST), "assister did not bank 6");
    }

    function test_GoalPenalisesOnlyTheConcedingGoalkeeper() public {
        _kickoff();
        _post(12, IMatchOracle.EventType.GOAL, _ids(10));

        // Player 18 is team 1's keeper; team 0 scored.
        assertEq(_state(18).banked, -int256(ScoreMath.PTS_CONCEDED), "conceding GK not penalised");
        // Team 0's keeper is untouched, and so are outfield defenders.
        assertEq(_state(0).banked, int256(0), "wrong keeper penalised");
        assertEq(_state(19).banked, int256(0), "defender wrongly penalised for a goal conceded");
    }

    function test_YellowCardDeductsTwo() public {
        _kickoff();
        _post(23, IMatchOracle.EventType.YELLOW, _ids(3));
        assertEq(_state(3).banked, -int256(ScoreMath.PTS_YELLOW));
    }

    function test_RedCardFreezesPlayerAndStopsMinutes() public {
        _kickoff();
        _post(31, IMatchOracle.EventType.RED, _ids(22));

        ScoreMath.PlayerState memory st = _state(22);
        assertEq(st.banked, -int256(ScoreMath.PTS_RED), "red card deduction wrong");
        assertTrue(st.frozen, "red card did not freeze");
        assertFalse(st.onPitch, "sent-off player still on pitch");
        assertEq(_mins(22), 31, "minutes at dismissal wrong");

        // Clock runs on; the frozen player banks nothing further.
        _heartbeat(60);
        assertEq(_mins(22), 31, "frozen player kept accruing minutes");
    }

    /// @dev A red card collapses the decay term, so expectation drops to realised
    ///      value immediately rather than continuing to price in a rest-of-match.
    function test_RedCardCollapsesExpectedScore() public {
        _kickoff();
        _heartbeat(30);
        uint256 before = oracle.expectedScore(FIXTURE_ID, 22);

        _post(31, IMatchOracle.EventType.RED, _ids(22));
        uint256 afterRed = oracle.expectedScore(FIXTURE_ID, 22);

        assertLt(afterRed, before, "red card did not reduce E");

        ScoreMath.PlayerState memory st = _state(22);
        // Frozen: E is exactly banked + minutes, with no decay and no clean sheet.
        int256 expected = st.banked + int256(_min(_mins(22)));
        assertEq(afterRed, expected <= 0 ? 0 : uint256(expected), "frozen E is not banked + minutes");
    }

    function test_SubstitutionFreezesOneAndStartsTheOther() public {
        _kickoff();
        _post(46, IMatchOracle.EventType.SUB, _ids(9, 16));

        assertTrue(_state(9).frozen, "player off not frozen");
        assertFalse(_state(9).onPitch, "player off still on pitch");
        assertEq(_mins(9), 46, "player off minutes wrong");

        assertTrue(_state(16).onPitch, "player on not on pitch");
        assertEq(_mins(16), 0, "substitute accrued minutes before entering");

        _heartbeat(60);
        assertEq(_mins(16), 14, "substitute accrual wrong");
        assertEq(_mins(9), 46, "subbed-off player kept accruing");
    }

    function test_BenchPlayerAccruesNothingUntilBroughtOn() public {
        _kickoff();
        _heartbeat(60);
        assertEq(_mins(16), 0, "unused substitute accrued minutes");
    }

    /// @dev Clean-sheet expectation is a separate component zeroed for the whole
    ///      conceding team, not a negative delta applied to one player.
    function test_FirstGoalZeroesCleanSheetExpectationForWholeConcedingTeam() public {
        _kickoff();
        _heartbeat(30);

        uint256 gkBefore = oracle.expectedScore(FIXTURE_ID, 18);
        uint256 defBefore = oracle.expectedScore(FIXTURE_ID, 19);

        _post(31, IMatchOracle.EventType.GOAL, _ids(10));

        assertLt(oracle.expectedScore(FIXTURE_ID, 18), gkBefore, "conceding GK expectation unchanged");
        assertLt(oracle.expectedScore(FIXTURE_ID, 19), defBefore, "conceding DEF expectation unchanged");

        // Defender banked nothing: the drop is expectation, not a point deduction.
        assertEq(_state(19).banked, int256(0), "defender was wrongly deducted points");
    }

    function test_CleanSheetExpectationRampsWithAGoallessClock() public {
        _kickoff();
        _heartbeat(10);
        uint256 early = oracle.expectedScore(FIXTURE_ID, 19);
        _heartbeat(80);
        uint256 late = oracle.expectedScore(FIXTURE_ID, 19);

        // Decay shrinks and the clean-sheet ramp grows; for a defender still on the
        // pitch in a goalless match the net effect must be upward.
        assertGt(late, early, "clean sheet expectation did not ramp");
    }

    // ------------------------------------------------------- guard rails

    function test_RejectsNonMonotonicMinutes() public {
        _kickoff();
        _heartbeat(40);
        vm.prank(oracleSigner);
        vm.expectRevert(abi.encodeWithSelector(MatchOracle.NonMonotonicMinute.selector, uint16(30), uint16(40)));
        oracle.postEvent(FIXTURE_ID, 30, IMatchOracle.EventType.HEARTBEAT, new uint16[](0), uint64(block.timestamp));
    }

    function test_RejectsStaleEvents() public {
        _kickoff();
        vm.warp(block.timestamp + 10_000);
        uint64 stale = uint64(block.timestamp - (ORDER_DELAY_L + STALE_TOLERANCE + 1));

        vm.prank(oracleSigner);
        vm.expectRevert();
        oracle.postEvent(FIXTURE_ID, 10, IMatchOracle.EventType.HEARTBEAT, new uint16[](0), stale);

        // Just inside the window is accepted.
        _postAt(10, IMatchOracle.EventType.HEARTBEAT, new uint16[](0), uint64(block.timestamp - ORDER_DELAY_L));
        assertEq(oracle.matchClock(FIXTURE_ID), 10);
    }

    function test_RejectsFutureDatedEvents() public {
        _kickoff();
        vm.prank(oracleSigner);
        vm.expectRevert();
        oracle.postEvent(FIXTURE_ID, 10, IMatchOracle.EventType.HEARTBEAT, new uint16[](0), uint64(block.timestamp + 1));
    }

    function test_RejectsUnauthorisedPoster() public {
        _kickoff();
        vm.prank(alice);
        vm.expectRevert(MatchOracle.NotAuthorized.selector);
        oracle.postEvent(FIXTURE_ID, 10, IMatchOracle.EventType.HEARTBEAT, new uint16[](0), uint64(block.timestamp));
    }

    // -------------------------------------------------- replay consistency

    /// @notice Plays a scripted fixture and checks `postFinal` against totals
    ///         derived by hand from the same event list.
    function test_ReplayConsistency_ScriptedMatch() public {
        _playScriptedMatch();

        uint256[] memory expected = _scriptedFinalScores();

        // Non-empty array: postFinal asserts its own computation matches elementwise.
        vm.prank(oracleSigner);
        oracle.postFinal(FIXTURE_ID, expected);

        for (uint16 i = 0; i < PLAYERS; ++i) {
            assertEq(oracle.finalScore(FIXTURE_ID, i), expected[i], "final score mismatch");
        }
    }

    function test_PostFinalRevertsOnInconsistentScores() public {
        _playScriptedMatch();

        uint256[] memory wrong = _scriptedFinalScores();
        wrong[10] += 1e18;

        vm.prank(oracleSigner);
        vm.expectRevert();
        oracle.postFinal(FIXTURE_ID, wrong);
    }

    function test_PostFinalAcceptsEmptyArrayAndStillComputesScores() public {
        _playScriptedMatch();
        uint256[] memory expected = _scriptedFinalScores();

        vm.prank(oracleSigner);
        oracle.postFinal(FIXTURE_ID, new uint256[](0));

        for (uint16 i = 0; i < PLAYERS; ++i) {
            assertEq(oracle.finalScore(FIXTURE_ID, i), expected[i], "computed score diverged");
        }
    }

    /// @notice At minute 90, expectation has converged exactly onto realised score.
    /// @dev This is what makes `E` an honest price signal rather than a drifting
    ///      estimate: decay reaches zero and the clean-sheet ramp reaches the full
    ///      bonus at the same instant.
    function test_ExpectedScoreConvergesToActualAtFullTime() public {
        _playScriptedMatch();
        _heartbeat(90);

        uint256[] memory eAt90 = new uint256[](PLAYERS);
        for (uint16 i = 0; i < PLAYERS; ++i) {
            eAt90[i] = oracle.expectedScore(FIXTURE_ID, i);
        }

        vm.prank(oracleSigner);
        oracle.postFinal(FIXTURE_ID, new uint256[](0));

        for (uint16 i = 0; i < PLAYERS; ++i) {
            assertEq(oracle.finalScore(FIXTURE_ID, i), eAt90[i], "E(90) did not equal S");
        }
    }

    function test_CleanSheetAwardedToTeamThatDidNotConcede() public {
        _kickoff();
        _heartbeat(5);
        _post(12, IMatchOracle.EventType.GOAL, _ids(10, 6)); // team 0 scores
        _heartbeat(60);

        vm.prank(oracleSigner);
        oracle.postFinal(FIXTURE_ID, new uint256[](0));

        // Team 0 kept a clean sheet: keeper and defenders get the full bonus.
        assertEq(oracle.finalScore(FIXTURE_ID, 0), _min(90) + ScoreMath.PTS_CLEAN_SHEET, "GK clean sheet missing");
        assertEq(oracle.finalScore(FIXTURE_ID, 1), _min(90) + ScoreMath.PTS_CLEAN_SHEET, "DEF clean sheet missing");

        // Team 1 conceded: keeper takes the goal-conceded penalty, no bonus.
        assertEq(oracle.finalScore(FIXTURE_ID, 18), _min(90) - ScoreMath.PTS_CONCEDED, "conceding GK score wrong");
        assertEq(oracle.finalScore(FIXTURE_ID, 19), _min(90), "conceding DEF wrongly got a bonus");

        // Unused substitutes were never on the pitch, so no clean sheet for them.
        assertEq(oracle.finalScore(FIXTURE_ID, 12), 0, "unused sub defender got a clean sheet");
    }

    // ----------------------------------------------------- explicit kickoff

    function test_PostEventBeforeKickoffReverts() public {
        vm.prank(oracleSigner);
        vm.expectRevert(MatchOracle.WrongState.selector);
        oracle.postEvent(FIXTURE_ID, 5, IMatchOracle.EventType.HEARTBEAT, new uint16[](0), uint64(block.timestamp));
    }

    function test_KickoffRequiresOracleRole() public {
        vm.prank(alice);
        vm.expectRevert(MatchOracle.NotAuthorized.selector);
        oracle.kickoff(FIXTURE_ID);
    }

    function test_KickoffIsNotRepeatable() public {
        _kickoff();
        vm.prank(oracleSigner);
        vm.expectRevert(MatchOracle.WrongState.selector);
        oracle.kickoff(FIXTURE_ID);
    }

    /// @notice Pre-match minting closes at the explicit kickoff, not at first event.
    function test_KickoffAloneClosesPreMatchMinting() public {
        address card = pot.cards(0);
        pot.mintPreMatch(card, 1e18, address(this)); // fine before kickoff

        _kickoff(); // no event posted yet

        vm.expectRevert(SettlementPot.NotPreMatch.selector);
        pot.mintPreMatch(card, 1e18, address(this));
    }

    // -------------------------------------------------------- stoppage time

    /// @notice A 94th-minute goal banks its points, but every linear term clamps at 90.
    function test_StoppageTimeGoalBanksWhileClockClamps() public {
        _kickoff();
        _heartbeat(90);
        _post(94, IMatchOracle.EventType.GOAL, _ids(10, 6));

        assertEq(_state(10).banked, int256(ScoreMath.PTS_GOAL), "stoppage goal not banked");
        assertEq(_state(6).banked, int256(ScoreMath.PTS_ASSIST), "stoppage assist not banked");
        assertEq(_mins(10), 90, "minutes ran past 90");
        assertEq(oracle.matchClock(FIXTURE_ID), 94, "raw clock should keep the real minute");
    }

    /// @notice E(FT) still collapses onto S when the match ran into stoppage time.
    function test_StoppageTime_ExpectedScoreStillConvergesToActual() public {
        _kickoff();
        _heartbeat(90);
        _post(93, IMatchOracle.EventType.YELLOW, _ids(3));
        _post(94, IMatchOracle.EventType.GOAL, _ids(10, 6));
        _post(96, IMatchOracle.EventType.RED, _ids(22));

        uint256[] memory eAtEnd = new uint256[](PLAYERS);
        for (uint16 i = 0; i < PLAYERS; ++i) {
            eAtEnd[i] = oracle.expectedScore(FIXTURE_ID, i);
        }

        vm.prank(oracleSigner);
        oracle.postFinal(FIXTURE_ID, new uint256[](0));

        for (uint16 i = 0; i < PLAYERS; ++i) {
            assertEq(oracle.finalScore(FIXTURE_ID, i), eAtEnd[i], "E(FT) != S after stoppage time");
        }

        // And the scoring table still reads correctly through the clamp.
        assertEq(oracle.finalScore(FIXTURE_ID, 10), _min(90) + ScoreMath.PTS_GOAL, "scorer total wrong");
        // Team 0 scored and never conceded, so its defenders keep the clean sheet
        // even through stoppage time.
        assertEq(
            oracle.finalScore(FIXTURE_ID, 3),
            _min(90) - ScoreMath.PTS_YELLOW + ScoreMath.PTS_CLEAN_SHEET,
            "booked defender total wrong"
        );
        assertEq(oracle.finalScore(FIXTURE_ID, 18), _min(90) - ScoreMath.PTS_CONCEDED, "conceding GK total wrong");
    }

    /// @notice A substitute brought on in stoppage time accrues no minutes.
    function test_StoppageTimeSubstituteAccruesNoMinutes() public {
        _kickoff();
        _heartbeat(90);
        _post(92, IMatchOracle.EventType.SUB, _ids(9, 16));

        assertEq(_mins(16), 0, "stoppage substitute accrued minutes");
        assertEq(_mins(9), 90, "player off should be credited a full match");
    }

    // ------------------------------------------------------ scripted match

    /// @dev 25-ish events including a red card, a substitution with the incoming
    ///      player named, and a late goal.
    function _playScriptedMatch() internal {
        _kickoff();
        _heartbeat(5);
        _post(12, IMatchOracle.EventType.GOAL, _ids(10, 6)); // team 0 scores, assist
        _heartbeat(20);
        _post(23, IMatchOracle.EventType.YELLOW, _ids(3));
        _post(31, IMatchOracle.EventType.RED, _ids(22)); // team 1 defender sent off
        _heartbeat(40);
        _post(46, IMatchOracle.EventType.SUB, _ids(9, 16)); // team 0 swaps a forward
        _heartbeat(60);
        _post(71, IMatchOracle.EventType.GOAL, _ids(28)); // team 1 equalises late
        _heartbeat(85);
    }

    /// @dev Totals derived from the event list above, independently of contract
    ///      state. Both teams conceded, so nobody earns a clean sheet.
    function _scriptedFinalScores() internal pure returns (uint256[] memory s) {
        s = new uint256[](PLAYERS);

        // --- team 0: conceded on 71, so no clean sheet anywhere ---
        s[0] = _min(90) - ScoreMath.PTS_CONCEDED; // GK, one conceded
        s[1] = _min(90);
        s[2] = _min(90);
        s[3] = _min(90) - ScoreMath.PTS_YELLOW; // booked on 23
        s[4] = _min(90);
        s[5] = _min(90);
        s[6] = _min(90) + ScoreMath.PTS_ASSIST; // assist on 12
        s[7] = _min(90);
        s[8] = _min(90);
        s[9] = _min(46); // substituted off on 46
        s[10] = _min(90) + ScoreMath.PTS_GOAL; // scored on 12
        // 11..15, 17 never left the bench
        s[16] = _min(44); // came on at 46

        // --- team 1: conceded on 12 ---
        s[18] = _min(90) - ScoreMath.PTS_CONCEDED; // GK
        s[19] = _min(90);
        s[20] = _min(90);
        s[21] = _min(90);
        // s[22]: sent off on 31 -> 31 minutes is worth less than the 5 point
        //        penalty, so the score floors at zero.
        s[22] = 0;
        s[23] = _min(90);
        s[24] = _min(90);
        s[25] = _min(90);
        s[26] = _min(90);
        s[27] = _min(90);
        s[28] = _min(90) + ScoreMath.PTS_GOAL; // scored on 71
        // 29..35 never left the bench
    }
}
