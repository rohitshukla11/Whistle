// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {ScoreMath} from "./libraries/ScoreMath.sol";
import {IRoleAuth} from "../interfaces/IRoleAuth.sol";
import {MatchOracle} from "./MatchOracle.sol";
import {PlayerCard} from "./PlayerCard.sol";
import {SettlementPot} from "./SettlementPot.sol";

/// @title FixtureFactory
/// @notice Deploys and wires one fixture: a SettlementPot plus one PlayerCard per
///         player, registered with the shared MatchOracle.
/// @dev Cards are EIP-1167 clones of a single implementation deployed once in the
///      constructor, which is what makes a 36-card fixture affordable. Registration
///      is still batched so the caller can pick a chunk size that fits a block.
///
///      Pools and the hook attach in step 4; this contract deliberately knows
///      nothing about Uniswap.
contract FixtureFactory {
    address public immutable usdc;
    address public immutable cardImplementation;
    MatchOracle public immutable oracle;
    address public operator;

    struct FixtureRef {
        address pot;
        bool exists;
        bool finalized;
    }

    mapping(uint256 => FixtureRef) public fixtures;

    error OnlyOperator();
    error FixtureExists();
    error UnknownFixture();
    error AlreadyFinalized();
    error LengthMismatch();

    event FixtureDeployed(uint256 indexed fixtureId, address pot);
    event PlayerCardDeployed(uint256 indexed fixtureId, uint16 indexed playerId, address card, string symbol);
    event FixtureFinalized(uint256 indexed fixtureId, uint16 playerCount);

    constructor(address usdc_, IRoleAuth roleAuth_) {
        usdc = usdc_;
        operator = msg.sender;
        cardImplementation = address(new PlayerCard());
        oracle = new MatchOracle(address(this), roleAuth_);
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator();
        _;
    }

    function setOperator(address operator_) external onlyOperator {
        operator = operator_;
    }

    function createFixture(uint256 fixtureId, uint32 orderDelayL, uint32 staleTolerance)
        external
        onlyOperator
        returns (address pot)
    {
        if (fixtures[fixtureId].exists) revert FixtureExists();

        SettlementPot p = new SettlementPot(usdc, address(this), fixtureId);
        p.setOracle(address(oracle));
        pot = address(p);

        fixtures[fixtureId] = FixtureRef({pot: pot, exists: true, finalized: false});
        oracle.createFixture(fixtureId, pot, orderDelayL, staleTolerance);

        emit FixtureDeployed(fixtureId, pot);
    }

    /// @notice Clone and register a batch of player cards.
    function addPlayers(
        uint256 fixtureId,
        ScoreMath.PlayerConfig[] calldata configs,
        string[] calldata names,
        string[] calldata symbols
    ) external onlyOperator {
        FixtureRef storage ref = fixtures[fixtureId];
        if (!ref.exists) revert UnknownFixture();
        if (ref.finalized) revert AlreadyFinalized();
        if (configs.length != names.length || configs.length != symbols.length) revert LengthMismatch();

        for (uint256 i = 0; i < configs.length; ++i) {
            _deployCard(fixtureId, ref.pot, configs[i], names[i], symbols[i]);
        }
    }

    /// @dev Split out of {addPlayers} purely to keep the stack shallow enough for
    ///      the legacy codegen pipeline.
    function _deployCard(
        uint256 fixtureId,
        address pot,
        ScoreMath.PlayerConfig calldata cfg,
        string calldata name,
        string calldata symbol
    ) private {
        uint16 playerId = oracle.playerCount(fixtureId);

        address card = Clones.clone(cardImplementation);
        PlayerCard(card).initialize(name, symbol, pot, address(this), playerId);

        // Kickoff coefficients, before any event has moved the clock.
        (int256 a90, int256 b90) = ScoreMath.affine(
            cfg,
            ScoreMath.PlayerState({
                banked: 0,
                entryMinute: 0,
                frozenMinutes: 0,
                onPitch: cfg.starter,
                frozen: false
            }),
            false
        );

        SettlementPot(pot).registerCard(card, playerId, a90, b90);
        oracle.addPlayer(fixtureId, cfg, card);

        emit PlayerCardDeployed(fixtureId, playerId, card, symbol);
    }

    function finalizeFixture(uint256 fixtureId) external onlyOperator {
        FixtureRef storage ref = fixtures[fixtureId];
        if (!ref.exists) revert UnknownFixture();
        if (ref.finalized) revert AlreadyFinalized();
        ref.finalized = true;
        oracle.finalizePlayers(fixtureId);
        emit FixtureFinalized(fixtureId, oracle.playerCount(fixtureId));
    }

    /// @notice Exempt an address from a card's 5% holder cap.
    /// @dev Used for MMVault, PoolManager and the hook. See PlayerCard.capExempt.
    function setCapExempt(address card, address account, bool exempt) external onlyOperator {
        PlayerCard(card).setCapExempt(account, exempt);
    }

    /// @notice Set the market venue allowed to mint at the reference price.
    function setMinter(uint256 fixtureId, address minter) external onlyOperator {
        FixtureRef storage ref = fixtures[fixtureId];
        if (!ref.exists) revert UnknownFixture();
        SettlementPot(ref.pot).setMinter(minter);
    }
}
