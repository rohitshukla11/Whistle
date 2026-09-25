// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ScoreMath} from "../libraries/ScoreMath.sol";

/// @title IMatchOracle
/// @notice Match clock, event feed and expected-score source for a fixture.
interface IMatchOracle {
    enum FixtureState {
        PRE_MATCH,
        LIVE,
        SETTLED
    }

    /// @dev HEARTBEAT carries no players and exists purely to advance the clock,
    ///      so minutes-based accrual keeps moving between real events.
    enum EventType {
        HEARTBEAT,
        GOAL,
        YELLOW,
        RED,
        SUB
    }

    event FixtureCreated(uint256 indexed fixtureId, address pot, uint32 orderDelayL);
    event PlayerAdded(uint256 indexed fixtureId, uint16 indexed playerId, address card);
    event KickedOff(uint256 indexed fixtureId, uint64 at);
    event MatchEvent(uint256 indexed fixtureId, uint16 minute, EventType eventType, uint16[] playerIds, uint64 sourceTimestamp);
    event Settled(uint256 indexed fixtureId, uint16 clock);

    function postEvent(
        uint256 fixtureId,
        uint16 minute,
        EventType eventType,
        uint16[] calldata playerIds,
        uint64 sourceTimestamp
    ) external;

    /// @notice Close the fixture. Final scores are computed on-chain from accrued
    ///         state; `expectedS` is an optional assert-equal check.
    /// @param expectedS Empty array skips the check. Non-empty must match the
    ///        contract's own computation elementwise, or the call reverts.
    function postFinal(uint256 fixtureId, uint256[] calldata expectedS) external;

    function expectedScore(uint256 fixtureId, uint16 playerId) external view returns (uint256);

    function finalScore(uint256 fixtureId, uint16 playerId) external view returns (uint256);

    function matchClock(uint256 fixtureId) external view returns (uint16);

    function fixtureState(uint256 fixtureId) external view returns (FixtureState);

    function playerState(uint256 fixtureId, uint16 playerId) external view returns (ScoreMath.PlayerState memory);

    function playerConfig(uint256 fixtureId, uint16 playerId) external view returns (ScoreMath.PlayerConfig memory);
}
