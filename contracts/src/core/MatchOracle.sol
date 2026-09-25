// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IMatchOracle} from "./interfaces/IMatchOracle.sol";
import {IRoleAuth} from "../interfaces/IRoleAuth.sol";
import {ScoreMath} from "./libraries/ScoreMath.sol";
import {SettlementPot} from "./SettlementPot.sol";

/// @title MatchOracle
/// @notice Match clock, event feed and expected-score engine. Multi-fixture.
///
/// @dev Write access is gated by {IRoleAuth}, which in production reads
///      `ROLE_POST_EVENT` off `oracle.whistle.eth`. The oracle address deliberately
///      holds that role and nothing else, so it cannot pass an agent trade check.
///
///      Because expected score is affine in the clock (see ScoreMath), an event only
///      rewrites the players it actually touched. A HEARTBEAT touches nobody: it
///      advances the clock and every card reprices for free.
contract MatchOracle is IMatchOracle {
    struct Fixture {
        address pot;
        FixtureState state;
        uint16 clock;
        uint16 playerCount;
        uint32 orderDelayL;
        uint32 staleTolerance;
        uint64 lastEventAt;
        bool team0Conceded;
        bool team1Conceded;
        bool finalized;
    }

    address public immutable factory;
    IRoleAuth public roleAuth;

    mapping(uint256 => Fixture) public fixtures;
    mapping(uint256 => mapping(uint16 => ScoreMath.PlayerConfig)) internal _configs;
    mapping(uint256 => mapping(uint16 => ScoreMath.PlayerState)) internal _states;
    mapping(uint256 => mapping(uint16 => address)) public cardOf;

    /// @notice Goalkeepers and defenders per team, so a conceded goal does not have
    ///         to scan the whole squad to zero clean-sheet expectations.
    mapping(uint256 => mapping(uint8 => uint16[])) internal _defensiveIds;

    error OnlyFactory();
    error NotAuthorized();
    error WrongState();
    error NonMonotonicMinute(uint16 given, uint16 clock);
    error StaleEvent(uint64 sourceTimestamp, uint64 nowTs, uint32 maxLag);
    error FutureEvent(uint64 sourceTimestamp, uint64 nowTs);
    error BadPlayerCount();
    error PlayerFrozen(uint16 playerId);
    error PlayerNotOnPitch(uint16 playerId);
    error PlayerAlreadyOnPitch(uint16 playerId);
    error FinalScoreMismatch(uint16 playerId, uint256 computed, uint256 expected);
    error PlayersNotFinalized();

    constructor(address factory_, IRoleAuth roleAuth_) {
        factory = factory_;
        roleAuth = roleAuth_;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert OnlyFactory();
        _;
    }

    modifier onlyPoster() {
        if (!roleAuth.hasPostEventRole(msg.sender)) revert NotAuthorized();
        _;
    }

    // ---------------------------------------------------------------- setup

    function setRoleAuth(IRoleAuth roleAuth_) external onlyFactory {
        roleAuth = roleAuth_;
    }

    function createFixture(uint256 fixtureId, address pot, uint32 orderDelayL, uint32 staleTolerance)
        external
        onlyFactory
    {
        Fixture storage f = fixtures[fixtureId];
        f.pot = pot;
        f.state = FixtureState.PRE_MATCH;
        f.orderDelayL = orderDelayL;
        f.staleTolerance = staleTolerance;
        emit FixtureCreated(fixtureId, pot, orderDelayL);
    }

    function addPlayer(uint256 fixtureId, ScoreMath.PlayerConfig calldata cfg, address card)
        external
        onlyFactory
        returns (uint16 playerId)
    {
        Fixture storage f = fixtures[fixtureId];
        if (f.state != FixtureState.PRE_MATCH || f.finalized) revert WrongState();

        playerId = f.playerCount;
        _configs[fixtureId][playerId] = cfg;
        cardOf[fixtureId][playerId] = card;
        _states[fixtureId][playerId] = ScoreMath.PlayerState({
            banked: 0,
            entryMinute: 0,
            frozenMinutes: 0,
            onPitch: cfg.starter,
            frozen: false
        });

        if (cfg.position == ScoreMath.Position.GK || cfg.position == ScoreMath.Position.DEF) {
            _defensiveIds[fixtureId][cfg.team].push(playerId);
        }

        f.playerCount = playerId + 1;
        emit PlayerAdded(fixtureId, playerId, card);
    }

    function finalizePlayers(uint256 fixtureId) external onlyFactory {
        fixtures[fixtureId].finalized = true;
    }

    /// @notice Explicit PRE_MATCH -> LIVE transition, oracle role only.
    /// @dev Pre-match minting closes HERE, not on the first event. Tying it to the
    ///      first event would leave a window after the whistle in which `P0` is
    ///      still purchasable even though the match is already producing
    ///      information.
    function kickoff(uint256 fixtureId) external onlyPoster {
        Fixture storage f = fixtures[fixtureId];
        if (f.state != FixtureState.PRE_MATCH) revert WrongState();
        if (!f.finalized) revert PlayersNotFinalized();

        f.state = FixtureState.LIVE;
        f.lastEventAt = uint64(block.timestamp);
        SettlementPot(f.pot).setLive();
        emit KickedOff(fixtureId, uint64(block.timestamp));
    }

    // ---------------------------------------------------------------- events

    /// @inheritdoc IMatchOracle
    function postEvent(
        uint256 fixtureId,
        uint16 minute,
        EventType eventType,
        uint16[] calldata playerIds,
        uint64 sourceTimestamp
    ) external onlyPoster {
        Fixture storage f = fixtures[fixtureId];
        _validate(f, minute, sourceTimestamp);

        f.clock = minute;
        // Stoppage time banks events but must not extend minutes played or push the
        // decay term negative, so every linear term uses the clamped clock.
        uint16 t = ScoreMath.clamp(minute);
        SettlementPot(f.pot).advanceClock(t);

        {
            (uint16[] memory touched, uint256 count) = _applyEvent(fixtureId, f, t, eventType, playerIds);
            if (count != 0) _pushAffine(fixtureId, f, touched, count);
        }

        f.lastEventAt = uint64(block.timestamp);
        emit MatchEvent(fixtureId, minute, eventType, playerIds, sourceTimestamp);
    }

    /// @dev Monotonic clock plus the stale-event guard. An event the oracle sat on
    ///      for longer than the order delay would let a queued order fill against a
    ///      price the chain has not been told about yet, which is exactly what the
    ///      delay exists to prevent.
    function _validate(Fixture storage f, uint16 minute, uint64 sourceTimestamp) private view {
        if (f.state != FixtureState.LIVE) revert WrongState();
        if (minute < f.clock) revert NonMonotonicMinute(minute, f.clock);

        uint64 nowTs = uint64(block.timestamp);
        if (sourceTimestamp > nowTs) revert FutureEvent(sourceTimestamp, nowTs);
        uint32 maxLag = f.orderDelayL + f.staleTolerance;
        if (nowTs - sourceTimestamp > maxLag) revert StaleEvent(sourceTimestamp, nowTs, maxLag);
    }

    function _applyEvent(
        uint256 fixtureId,
        Fixture storage f,
        uint16 t,
        EventType eventType,
        uint16[] calldata playerIds
    ) private returns (uint16[] memory touched, uint256 count) {
        if (eventType == EventType.HEARTBEAT) {
            // Nobody's coefficients change; the clock advance already repriced all.
            return (touched, 0);
        }

        if (eventType == EventType.GOAL) {
            return _applyGoal(fixtureId, f, playerIds);
        }

        if (eventType == EventType.YELLOW) {
            if (playerIds.length != 1) revert BadPlayerCount();
            _states[fixtureId][playerIds[0]].banked += ScoreMath.DELTA_YELLOW;
            touched = new uint16[](1);
            touched[0] = playerIds[0];
            return (touched, 1);
        }

        if (eventType == EventType.RED) {
            if (playerIds.length != 1) revert BadPlayerCount();
            ScoreMath.PlayerState storage st = _states[fixtureId][playerIds[0]];
            if (st.frozen) revert PlayerFrozen(playerIds[0]);
            st.banked += ScoreMath.DELTA_RED;
            _freeze(st, t);
            touched = new uint16[](1);
            touched[0] = playerIds[0];
            return (touched, 1);
        }

        return _applySub(fixtureId, t, playerIds);
    }

    function _applySub(uint256 fixtureId, uint16 t, uint16[] calldata playerIds)
        private
        returns (uint16[] memory touched, uint256 count)
    {
        // SUB: [playerOff, playerOn]
        if (playerIds.length != 2) revert BadPlayerCount();

        ScoreMath.PlayerState storage off = _states[fixtureId][playerIds[0]];
        ScoreMath.PlayerState storage on = _states[fixtureId][playerIds[1]];
        if (!off.onPitch) revert PlayerNotOnPitch(playerIds[0]);
        if (on.onPitch) revert PlayerAlreadyOnPitch(playerIds[1]);
        if (on.frozen) revert PlayerFrozen(playerIds[1]);

        _freeze(off, t);
        on.onPitch = true;
        on.entryMinute = t;

        touched = new uint16[](2);
        touched[0] = playerIds[0];
        touched[1] = playerIds[1];
        count = 2;
    }

    /// @dev Freezing banks the minutes accrued so far and collapses the player's
    ///      line to a constant, so no further clock advance can move them.
    function _freeze(ScoreMath.PlayerState storage st, uint16 t) private {
        st.frozenMinutes = ScoreMath.minutesPlayed(st, t);
        st.onPitch = false;
        st.frozen = true;
    }

    function _applyGoal(uint256 fixtureId, Fixture storage f, uint16[] calldata playerIds)
        private
        returns (uint16[] memory touched, uint256 count)
    {
        if (playerIds.length == 0 || playerIds.length > 2) revert BadPlayerCount();

        uint16 scorer = playerIds[0];
        _states[fixtureId][scorer].banked += ScoreMath.DELTA_GOAL;

        uint8 concedingTeam = _configs[fixtureId][scorer].team == 0 ? 1 : 0;
        bool firstConcession = concedingTeam == 0 ? !f.team0Conceded : !f.team1Conceded;
        if (concedingTeam == 0) f.team0Conceded = true;
        else f.team1Conceded = true;

        touched = new uint16[](_defensiveIds[fixtureId][concedingTeam].length + 2);
        touched[count++] = scorer;

        if (playerIds.length == 2) {
            _states[fixtureId][playerIds[1]].banked += ScoreMath.DELTA_ASSIST;
            touched[count++] = playerIds[1];
        }

        count = _applyConcession(fixtureId, concedingTeam, firstConcession, touched, count);
    }

    /// @dev Applies the keeper's goal-conceded penalty and, on the FIRST goal only,
    ///      marks every active defender for recomputation because the whole team
    ///      loses its clean-sheet expectation at once. Later goals move only the
    ///      keeper's line.
    function _applyConcession(
        uint256 fixtureId,
        uint8 concedingTeam,
        bool firstConcession,
        uint16[] memory touched,
        uint256 count
    ) private returns (uint256) {
        uint16[] storage defensive = _defensiveIds[fixtureId][concedingTeam];
        uint16 gk = type(uint16).max;

        for (uint256 i = 0; i < defensive.length; ++i) {
            uint16 id = defensive[i];
            ScoreMath.PlayerState storage st = _states[fixtureId][id];
            if (!st.onPitch || st.frozen) continue;

            if (_configs[fixtureId][id].position == ScoreMath.Position.GK) {
                st.banked += ScoreMath.DELTA_CONCEDED;
                gk = id;
            }
            if (firstConcession) touched[count++] = id;
        }

        if (!firstConcession && gk != type(uint16).max) touched[count++] = gk;
        return count;
    }

    /// @dev Recomputes coefficients for the touched players only and pushes them as
    ///      one batch, so the pot re-bases its aggregates in a single pass.
    function _pushAffine(uint256 fixtureId, Fixture storage f, uint16[] memory touched, uint256 count) private {
        address[] memory cards = new address[](count);
        int256[] memory a90s = new int256[](count);
        int256[] memory b90s = new int256[](count);

        for (uint256 i = 0; i < count; ++i) {
            uint16 id = touched[i];
            ScoreMath.PlayerConfig memory cfg = _configs[fixtureId][id];
            ScoreMath.PlayerState memory st = _states[fixtureId][id];
            (int256 a, int256 b) = ScoreMath.affine(cfg, st, _conceded(f, cfg.team));
            cards[i] = cardOf[fixtureId][id];
            a90s[i] = a;
            b90s[i] = b;
        }

        SettlementPot(f.pot).setAffine(cards, a90s, b90s);
    }

    function _conceded(Fixture storage f, uint8 team) private view returns (bool) {
        return team == 0 ? f.team0Conceded : f.team1Conceded;
    }

    // -------------------------------------------------------------- settle

    /// @inheritdoc IMatchOracle
    function postFinal(uint256 fixtureId, uint256[] calldata expectedS) external onlyPoster {
        Fixture storage f = fixtures[fixtureId];
        if (f.state != FixtureState.LIVE) revert WrongState();

        // Run the clock out so anyone still on the pitch banks their full minutes.
        if (f.clock < ScoreMath.FULL_MATCH) f.clock = ScoreMath.FULL_MATCH;

        SettlementPot pot = SettlementPot(f.pot);
        pot.advanceClock(ScoreMath.FULL_MATCH);
        pot.settle();

        // Optional assert-equal against the pot's own computation. An empty array
        // skips the check; payouts always use the contract's numbers, never the
        // caller's.
        if (expectedS.length != 0) {
            uint16 n = f.playerCount;
            if (expectedS.length != n) revert BadPlayerCount();
            for (uint16 i = 0; i < n; ++i) {
                uint256 computed = pot.finalScoreOf(cardOf[fixtureId][i]);
                if (expectedS[i] != computed) revert FinalScoreMismatch(i, computed, expectedS[i]);
            }
        }

        f.state = FixtureState.SETTLED;
        emit Settled(fixtureId, f.clock);
    }

    // ---------------------------------------------------------------- views

    function _affineOf(uint256 fixtureId, Fixture storage f, uint16 playerId)
        private
        view
        returns (int256 a, int256 b)
    {
        ScoreMath.PlayerConfig memory cfg = _configs[fixtureId][playerId];
        ScoreMath.PlayerState memory st = _states[fixtureId][playerId];
        return ScoreMath.affine(cfg, st, _conceded(f, cfg.team));
    }

    function expectedScore(uint256 fixtureId, uint16 playerId) external view returns (uint256) {
        Fixture storage f = fixtures[fixtureId];
        (int256 a, int256 b) = _affineOf(fixtureId, f, playerId);
        return ScoreMath.score(a, b, f.clock);
    }

    function finalScore(uint256 fixtureId, uint16 playerId) external view returns (uint256) {
        Fixture storage f = fixtures[fixtureId];
        return SettlementPot(f.pot).finalScoreOf(cardOf[fixtureId][playerId]);
    }

    function affineOf(uint256 fixtureId, uint16 playerId) external view returns (int256 a, int256 b) {
        return _affineOf(fixtureId, fixtures[fixtureId], playerId);
    }

    function minutesPlayed(uint256 fixtureId, uint16 playerId) external view returns (uint16) {
        return ScoreMath.minutesPlayed(_states[fixtureId][playerId], fixtures[fixtureId].clock);
    }

    function matchClock(uint256 fixtureId) external view returns (uint16) {
        return fixtures[fixtureId].clock;
    }

    function fixtureState(uint256 fixtureId) external view returns (FixtureState) {
        return fixtures[fixtureId].state;
    }

    function playerState(uint256 fixtureId, uint16 playerId) external view returns (ScoreMath.PlayerState memory) {
        return _states[fixtureId][playerId];
    }

    function playerConfig(uint256 fixtureId, uint16 playerId) external view returns (ScoreMath.PlayerConfig memory) {
        return _configs[fixtureId][playerId];
    }

    function playerCount(uint256 fixtureId) external view returns (uint16) {
        return fixtures[fixtureId].playerCount;
    }
}
