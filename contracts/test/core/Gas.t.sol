// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {WhistleTestBase} from "./WhistleTestBase.sol";
import {FixtureFactory} from "../../src/core/FixtureFactory.sol";
import {SettlementPot} from "../../src/core/SettlementPot.sol";
import {IMatchOracle} from "../../src/core/interfaces/IMatchOracle.sol";
import {ScoreMath} from "../../src/core/libraries/ScoreMath.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {SimpleRoleAuth} from "../../src/mocks/SimpleRoleAuth.sol";

/// @notice Gas budgets for the hot paths.
/// @dev These are assertions, not just measurements: the closed-form score exists
///      precisely so a HEARTBEAT stays cheap, and a regression that reintroduces a
///      per-player loop should break the build rather than quietly cost 36 writes
///      per tick.
contract GasTest is WhistleTestBase {
    uint256 internal constant HEARTBEAT_BUDGET = 100_000;
    uint256 internal constant GOAL_BUDGET = 300_000;

    function setUp() public override {
        super.setUp();
        _mintAllAtP0(200e18);
    }

    function test_Gas_Heartbeat() public {
        _kickoff();

        vm.prank(oracleSigner);
        uint256 g0 = gasleft();
        oracle.postEvent(FIXTURE_ID, 5, IMatchOracle.EventType.HEARTBEAT, new uint16[](0), uint64(block.timestamp));
        uint256 used = g0 - gasleft();

        emit log_named_uint("postEvent HEARTBEAT (first, cold)", used);
        assertLt(used, HEARTBEAT_BUDGET, "heartbeat over budget");
    }

    function test_Gas_HeartbeatWarm() public {
        _kickoff();
        _heartbeat(5);

        vm.prank(oracleSigner);
        uint256 g0 = gasleft();
        oracle.postEvent(FIXTURE_ID, 10, IMatchOracle.EventType.HEARTBEAT, new uint16[](0), uint64(block.timestamp));
        uint256 used = g0 - gasleft();

        emit log_named_uint("postEvent HEARTBEAT (warm)", used);
        assertLt(used, HEARTBEAT_BUDGET, "warm heartbeat over budget");
    }

    /// @dev Worst case: the first goal against a side zeroes the clean-sheet
    ///      expectation for every active defender, so it touches the most players
    ///      of any event in the match.
    function test_Gas_GoalFirstConcession() public {
        _kickoff();

        uint16[] memory ids = _ids(10, 6);
        vm.prank(oracleSigner);
        uint256 g0 = gasleft();
        oracle.postEvent(FIXTURE_ID, 12, IMatchOracle.EventType.GOAL, ids, uint64(block.timestamp));
        uint256 used = g0 - gasleft();

        emit log_named_uint("postEvent GOAL (first concession, worst case)", used);
        assertLt(used, GOAL_BUDGET, "goal over budget");
    }

    /// @dev Later goals move only the keeper's line.
    function test_Gas_GoalSubsequent() public {
        _kickoff();
        _post(12, IMatchOracle.EventType.GOAL, _ids(10, 6));

        uint16[] memory ids = _ids(9, 7);
        vm.prank(oracleSigner);
        uint256 g0 = gasleft();
        oracle.postEvent(FIXTURE_ID, 40, IMatchOracle.EventType.GOAL, ids, uint64(block.timestamp));
        uint256 used = g0 - gasleft();

        emit log_named_uint("postEvent GOAL (subsequent)", used);
        assertLt(used, GOAL_BUDGET, "subsequent goal over budget");
    }

    function test_Gas_RedCardAndSub() public {
        _kickoff();

        uint16[] memory red = _ids(22);
        vm.prank(oracleSigner);
        uint256 g0 = gasleft();
        oracle.postEvent(FIXTURE_ID, 31, IMatchOracle.EventType.RED, red, uint64(block.timestamp));
        emit log_named_uint("postEvent RED", g0 - gasleft());

        uint16[] memory sub = _ids(9, 16);
        vm.prank(oracleSigner);
        g0 = gasleft();
        oracle.postEvent(FIXTURE_ID, 46, IMatchOracle.EventType.SUB, sub, uint64(block.timestamp));
        emit log_named_uint("postEvent SUB", g0 - gasleft());
    }

    /// @notice `referencePrice` must not scale with the card count.
    function test_Gas_ReferencePrice() public {
        _kickoff();
        _post(12, IMatchOracle.EventType.GOAL, _ids(10, 6));

        address card = pot.cards(10);
        pot.referencePrice(card); // warm

        uint256 g0 = gasleft();
        pot.referencePrice(card);
        uint256 used = g0 - gasleft();

        emit log_named_uint("referencePrice (warm)", used);
        emit log_named_uint("riskyCards length", pot.riskyCardCount());

        address cold = pot.cards(29);
        g0 = gasleft();
        pot.referencePrice(cold);
        emit log_named_uint("referencePrice (cold card)", g0 - gasleft());

        assertLt(used, 20_000, "referencePrice is not O(1)");
    }

    function test_Gas_QuoteAndMint() public {
        address card = pot.cards(5);

        uint256 g0 = gasleft();
        pot.quoteMint(card, 1e18);
        emit log_named_uint("quoteMint (warm-ish)", g0 - gasleft());

        g0 = gasleft();
        pot.mintPreMatch(card, 10e18, address(this));
        emit log_named_uint("mintPreMatch", g0 - gasleft());
    }

    /// @notice Whole-fixture deployment cost, batched as it would be on Sepolia.
    function test_Gas_FixtureDeployment() public {
        MockUSDC usdc2 = new MockUSDC();
        SimpleRoleAuth auth2 = new SimpleRoleAuth(address(this));

        uint256 g0 = gasleft();
        FixtureFactory f2 = new FixtureFactory(address(usdc2), auth2);
        uint256 factoryGas = g0 - gasleft();
        emit log_named_uint("FixtureFactory deploy (incl. card impl + oracle)", factoryGas);

        g0 = gasleft();
        f2.createFixture(7, ORDER_DELAY_L, STALE_TOLERANCE);
        uint256 createGas = g0 - gasleft();
        emit log_named_uint("createFixture (SettlementPot deploy)", createGas);

        uint256 batchTotal;
        for (uint8 team = 0; team < 2; ++team) {
            (
                ScoreMath.PlayerConfig[] memory cfgs,
                string[] memory names,
                string[] memory symbols
            ) = _buildSide(team);

            g0 = gasleft();
            f2.addPlayers(7, cfgs, names, symbols);
            uint256 batchGas = g0 - gasleft();
            batchTotal += batchGas;
            emit log_named_uint("addPlayers batch of 18 (EIP-1167 clones)", batchGas);
        }

        g0 = gasleft();
        f2.finalizeFixture(7);
        uint256 finalizeGas = g0 - gasleft();

        emit log_named_uint("per-card clone+register (avg)", batchTotal / PLAYERS);
        emit log_named_uint("TOTAL per-fixture deploy gas", factoryGas + createGas + batchTotal + finalizeGas);

        // A single 18-card batch must comfortably fit a Sepolia block.
        assertLt(batchTotal / 2, 25_000_000, "an 18-card batch will not fit a block");
    }
}
