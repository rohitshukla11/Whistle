// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {FixtureFactory} from "../../src/core/FixtureFactory.sol";
import {MatchOracle} from "../../src/core/MatchOracle.sol";
import {PlayerCard} from "../../src/core/PlayerCard.sol";
import {SettlementPot} from "../../src/core/SettlementPot.sol";
import {IMatchOracle} from "../../src/core/interfaces/IMatchOracle.sol";
import {ScoreMath} from "../../src/core/libraries/ScoreMath.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {SimpleRoleAuth} from "../../src/mocks/SimpleRoleAuth.sol";

/// @notice Shared rig: a full 36-card fixture (11 starters + 7 bench per side).
abstract contract WhistleTestBase is Test {
    uint256 internal constant FIXTURE_ID = 1;
    uint16 internal constant PLAYERS = 36;
    uint16 internal constant PER_SIDE = 18;
    uint32 internal constant ORDER_DELAY_L = 30;
    uint32 internal constant STALE_TOLERANCE = 60;

    MockUSDC internal usdc;
    SimpleRoleAuth internal roleAuth;
    FixtureFactory internal factory;
    MatchOracle internal oracle;
    SettlementPot internal pot;

    address internal oracleSigner = makeAddr("oracleSigner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public virtual {
        usdc = new MockUSDC();
        roleAuth = new SimpleRoleAuth(address(this));
        roleAuth.setPoster(oracleSigner, true);

        factory = new FixtureFactory(address(usdc), roleAuth);
        oracle = factory.oracle();

        pot = SettlementPot(factory.createFixture(FIXTURE_ID, ORDER_DELAY_L, STALE_TOLERANCE));

        _addSide(0);
        _addSide(1);
        factory.finalizeFixture(FIXTURE_ID);
        factory.setMinter(FIXTURE_ID, address(this));

        // The holder cap is orthogonal to the price math, so the rig exempts its
        // actors. Cap behaviour has its own dedicated tests.
        for (uint16 i = 0; i < PLAYERS; ++i) {
            address card = pot.cards(i);
            factory.setCapExempt(card, address(this), true);
            factory.setCapExempt(card, alice, true);
            factory.setCapExempt(card, bob, true);
        }

        usdc.mint(address(this), 100_000_000e6);
        usdc.approve(address(pot), type(uint256).max);
    }

    // --------------------------------------------------------------- fixture

    function _addSide(uint8 team) internal {
        (
            ScoreMath.PlayerConfig[] memory cfgs,
            string[] memory names,
            string[] memory symbols
        ) = _buildSide(team);
        factory.addPlayers(FIXTURE_ID, cfgs, names, symbols);
    }

    /// @dev Per side: 1 GK + 4 DEF + 4 MID + 2 FWD starting, then 7 bench.
    function _buildSide(uint8 team)
        internal
        view
        returns (ScoreMath.PlayerConfig[] memory cfgs, string[] memory names, string[] memory symbols)
    {
        cfgs = new ScoreMath.PlayerConfig[](PER_SIDE);
        names = new string[](PER_SIDE);
        symbols = new string[](PER_SIDE);

        for (uint16 i = 0; i < PER_SIDE; ++i) {
            bool starter = i < 11;
            ScoreMath.Position pos = _positionFor(i);
            bool defensive = pos == ScoreMath.Position.GK || pos == ScoreMath.Position.DEF;

            uint256 eventPts = _eventPointsFor(pos);
            if (!starter) eventPts /= 2;

            cfgs[i] = ScoreMath.PlayerConfig({
                expectedEventPoints: uint128(eventPts),
                cleanSheetProb0: defensive ? uint64(0.3e18) : uint64(0),
                expectedMinutes: starter ? 90 : 20,
                team: team,
                position: pos,
                starter: starter
            });

            uint16 globalId = team * PER_SIDE + i;
            names[i] = string.concat("Whistle Player ", vm.toString(globalId));
            symbols[i] = string.concat("WP", vm.toString(globalId));
        }
    }

    function _positionFor(uint16 i) internal pure returns (ScoreMath.Position) {
        if (i == 0) return ScoreMath.Position.GK;
        if (i <= 4) return ScoreMath.Position.DEF;
        if (i <= 8) return ScoreMath.Position.MID;
        if (i <= 10) return ScoreMath.Position.FWD;
        if (i == 11) return ScoreMath.Position.GK;
        if (i <= 13) return ScoreMath.Position.DEF;
        if (i <= 15) return ScoreMath.Position.MID;
        return ScoreMath.Position.FWD;
    }

    function _eventPointsFor(ScoreMath.Position pos) internal pure returns (uint256) {
        if (pos == ScoreMath.Position.GK) return 0.5e18;
        if (pos == ScoreMath.Position.DEF) return 1e18;
        if (pos == ScoreMath.Position.MID) return 2e18;
        return 3e18;
    }

    // ----------------------------------------------------------------- utils

    function _card(uint16 playerId) internal view returns (PlayerCard) {
        return PlayerCard(pot.cards(playerId));
    }

    function _kickoff() internal {
        vm.prank(oracleSigner);
        oracle.kickoff(FIXTURE_ID);
    }

    function _post(uint16 minute, IMatchOracle.EventType t, uint16[] memory ids) internal {
        vm.prank(oracleSigner);
        oracle.postEvent(FIXTURE_ID, minute, t, ids, uint64(block.timestamp));
    }

    function _heartbeat(uint16 minute) internal {
        _post(minute, IMatchOracle.EventType.HEARTBEAT, new uint16[](0));
    }

    function _ids(uint16 a) internal pure returns (uint16[] memory out) {
        out = new uint16[](1);
        out[0] = a;
    }

    function _ids(uint16 a, uint16 b) internal pure returns (uint16[] memory out) {
        out = new uint16[](2);
        out[0] = a;
        out[1] = b;
    }

    /// @notice Mint `units` of every card at the pre-match price.
    function _mintAllAtP0(uint256 units) internal {
        for (uint16 i = 0; i < PLAYERS; ++i) {
            pot.mintPreMatch(pot.cards(i), units, address(this));
        }
    }

    /// @notice Sum of every card's current reference price.
    function _referencePrices() internal view returns (uint256[] memory out) {
        out = new uint256[](PLAYERS);
        for (uint16 i = 0; i < PLAYERS; ++i) {
            out[i] = pot.referencePrice(pot.cards(i));
        }
    }
}
