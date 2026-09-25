// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";

import {FixtureFactory} from "../src/core/FixtureFactory.sol";
import {MatchOracle} from "../src/core/MatchOracle.sol";
import {SettlementPot} from "../src/core/SettlementPot.sol";
import {ScoreMath} from "../src/core/libraries/ScoreMath.sol";
import {AgentRegistry} from "../src/integrations/ens/AgentRegistry.sol";
import {WhistleHook} from "../src/integrations/uniswap/WhistleHook.sol";
import {WhistleFillRouter} from "../src/integrations/uniswap/WhistleFillRouter.sol";
import {MMVault} from "../src/integrations/uniswap/MMVault.sol";
import {IAgentAuth} from "../src/interfaces/IAgentAuth.sol";

/// @notice A second fixture on an existing deployment.
///
/// @dev Most of Whistle is reusable across matches and is NOT redeployed here:
///      `AgentRegistry`, the root Permissioned Registry, `EnsRoleAuth`, `MockUSDC`,
///      `FixtureFactory` and `MatchOracle` all stay exactly where they are, so
///      `whistle.eth` keeps pointing at the same registry and `oracle.whistle.eth`
///      keeps holding `ROLE_POST_EVENT`.
///
///      What has to be new is everything bound to one pot:
///
///        - `SettlementPot` — `FixtureFactory.createFixture` deploys one per fixture;
///        - the 36 `PlayerCard` clones;
///        - `MMVault`, because `MMVault.pot` is immutable;
///        - `WhistleHook`, because `setVault` is one-shot, so an existing hook can
///          never be pointed at the new vault;
///        - `WhistleFillRouter`, because it is bound to one hook.
///
///      That chain of one-way doors is deliberate — each is a trust edge the README
///      argues for — but it does mean a new fixture costs a new venue. The roadmap
///      entry for making the vault per-fixture behind a hook mapping (the way
///      `potOf` already works) is the fix.
///
///      Run with:
///        forge script script/DeployFixture.s.sol:DeployFixture \
///          --rpc-url $SEPOLIA_RPC_URL --broadcast --slow --no-storage-caching
contract DeployFixture is Script {
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0xE03A1074c86CFeDd5C142C4F04F1a1536e203543);
    IPositionManager internal constant POSITION_MANAGER =
        IPositionManager(0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4);
    IAllowanceTransfer internal constant PERMIT2 =
        IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    /// @dev Production value. A demo on a compressed clock wants it shorter —
    ///      at a 3-minute clock 30s is 15 match minutes — so it is an env
    ///      override rather than a constant. It cannot be changed after
    ///      `createFixture`, which is why it has to be decided here.
    uint32 internal constant DEFAULT_ORDER_DELAY_L = 30;
    uint32 internal constant STALE_TOLERANCE = 600;

    /// @dev Twelve at a time keeps each `addPlayers` inside a comfortable block.
    uint256 internal constant PLAYER_BATCH = 12;

    /// @dev A struct rather than locals: `run()` overflows the stack otherwise.
    struct Ctx {
        address deployer;
        uint256 fixtureId;
        FixtureFactory factory;
        AgentRegistry agentRegistry;
        MatchOracle oracle;
        SettlementPot pot;
    }

    function run() external {
        string memory json = vm.readFile(
            vm.envOr("FIXTURE_FILE", string("../fixtures/che-bar-2009-05-06.deploy.json"))
        );

        uint256 pk = _key("DEPLOYER_PRIVATE_KEY");
        Ctx memory c;
        c.deployer = vm.addr(pk);
        c.fixtureId = vm.envUint("NEW_FIXTURE_ID");
        c.factory = FixtureFactory(vm.envAddress("FIXTURE_FACTORY"));
        c.agentRegistry = AgentRegistry(vm.envAddress("AGENT_REGISTRY"));
        c.oracle = c.factory.oracle();

        console.log("deployer     ", c.deployer);
        console.log("new fixtureId", c.fixtureId);
        console.log("reusing factory", address(c.factory));
        console.log("reusing oracle ", address(c.oracle));

        vm.startBroadcast(pk);

        // Resume-friendly: a half-finished run leaves the fixture created but
        // empty, and `createFixture` reverts `FixtureExists` on the second attempt.
        (address existing,, bool finalized) = c.factory.fixtures(c.fixtureId);
        c.pot = SettlementPot(
            existing != address(0)
                ? existing
                : c.factory.createFixture(c.fixtureId, uint32(vm.envOr("ORDER_DELAY_L", uint256(DEFAULT_ORDER_DELAY_L))), STALE_TOLERANCE)
        );
        console.log("SettlementPot", address(c.pot));

        if (!finalized) {
            _addPlayers(c.factory, c.fixtureId, json, uint16(vm.parseJsonUint(json, ".playerCount")));
        }

        (address hook, address router, address vault) = _deployVenue(c);

        vm.stopBroadcast();

        console.log("WhistleHook  ", hook);
        console.log("FillRouter   ", router);
        console.log("MMVault      ", vault);

        _write(c.fixtureId, address(c.pot), hook, router, vault, address(c.oracle));
    }

    /// @dev Its own frame purely to keep the stack shallow enough for the legacy
    ///      codegen pipeline; `run()` overflows otherwise.
    function _deployVenue(Ctx memory c) private returns (address, address, address) {
        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
        // The operator is passed explicitly: `forge script` routes `new{salt:}`
        // through the deterministic CREATE2 factory, so `msg.sender` inside the
        // constructor is that factory rather than the deployer.
        bytes memory args =
            abi.encode(POOL_MANAGER, c.oracle, IAgentAuth(address(c.agentRegistry)), c.deployer, c.deployer);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_FACTORY, flags, type(WhistleHook).creationCode, args);

        WhistleHook hook = new WhistleHook{salt: salt}(
            POOL_MANAGER, c.oracle, IAgentAuth(address(c.agentRegistry)), c.deployer, c.deployer
        );
        require(address(hook) == hookAddr, "hook address mismatch");

        WhistleFillRouter router = new WhistleFillRouter(POOL_MANAGER, address(hook));
        hook.setFillRouter(router);

        MMVault vault = new MMVault(POOL_MANAGER, POSITION_MANAGER, PERMIT2, c.pot, address(hook));
        hook.setVault(vault);

        // The registry points at the newest venue; the old fixture is settled and
        // no longer needs a market.
        c.agentRegistry.setMarket(address(hook));
        c.factory.setMinter(c.fixtureId, address(hook));

        return (address(hook), address(router), address(vault));
    }

    /// @dev The compiled fixture is column-oriented — one array per field — because
    ///      `vm.parseJson*Array` reads those in a single cheatcode call, where a
    ///      list of per-player objects needs one call per field per player.
    struct Squad {
        uint256[] points;
        uint256[] minutesPlayed;
        uint256[] cleanSheet;
        uint256[] teams;
        uint256[] positions;
        bool[] starters;
        string[] names;
        string[] symbols;
    }

    function _addPlayers(FixtureFactory factory, uint256 fixtureId, string memory json, uint16 playerCount)
        private
    {
        Squad memory squad = Squad({
            points: vm.parseJsonUintArray(json, ".expectedEventPoints"),
            minutesPlayed: vm.parseJsonUintArray(json, ".expectedMinutes"),
            cleanSheet: vm.parseJsonUintArray(json, ".cleanSheetProb0"),
            teams: vm.parseJsonUintArray(json, ".teams"),
            positions: vm.parseJsonUintArray(json, ".positions"),
            starters: vm.parseJsonBoolArray(json, ".starters"),
            names: vm.parseJsonStringArray(json, ".names"),
            symbols: vm.parseJsonStringArray(json, ".symbols")
        });

        for (uint256 start = 0; start < playerCount; start += PLAYER_BATCH) {
            uint256 size = start + PLAYER_BATCH > playerCount ? playerCount - start : PLAYER_BATCH;
            _addBatch(factory, fixtureId, squad, start, size);
            console.log("  addPlayers batch from", start, "size", size);
        }
        factory.finalizeFixture(fixtureId);
    }

    function _addBatch(
        FixtureFactory factory,
        uint256 fixtureId,
        Squad memory squad,
        uint256 start,
        uint256 size
    ) private {
        ScoreMath.PlayerConfig[] memory cfgs = new ScoreMath.PlayerConfig[](size);
        string[] memory batchNames = new string[](size);
        string[] memory batchSymbols = new string[](size);

        for (uint256 i = 0; i < size; ++i) {
            uint256 k = start + i;
            cfgs[i] = ScoreMath.PlayerConfig({
                expectedEventPoints: uint128(squad.points[k]),
                cleanSheetProb0: uint64(squad.cleanSheet[k]),
                expectedMinutes: uint16(squad.minutesPlayed[k]),
                team: uint8(squad.teams[k]),
                position: ScoreMath.Position(squad.positions[k]),
                starter: squad.starters[k]
            });
            batchNames[i] = squad.names[k];
            batchSymbols[i] = squad.symbols[k];
        }
        factory.addPlayers(fixtureId, cfgs, batchNames, batchSymbols);
    }

    function _write(
        uint256 fixtureId,
        address pot,
        address hook,
        address router,
        address vault,
        address oracle
    ) private {
        string memory o = "fixture";
        vm.serializeUint(o, "fixtureId", fixtureId);
        vm.serializeAddress(o, "settlementPot", pot);
        vm.serializeAddress(o, "whistleHook", hook);
        vm.serializeAddress(o, "fillRouter", router);
        vm.serializeAddress(o, "matchOracle", oracle);
        string memory out = vm.serializeAddress(o, "mmVault", vault);
        vm.writeJson(out, string.concat("../deployments/fixture-", vm.toString(fixtureId), ".json"));
    }

    /// @dev `vm.envUint` rejects a key without the `0x` prefix.
    function _key(string memory name) private view returns (uint256) {
        string memory raw = vm.envString(name);
        bytes memory b = bytes(raw);
        if (b.length > 1 && b[0] == "0" && (b[1] == "x" || b[1] == "X")) return vm.parseUint(raw);
        return vm.parseUint(string.concat("0x", raw));
    }
}
