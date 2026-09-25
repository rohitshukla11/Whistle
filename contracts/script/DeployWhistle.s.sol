// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";

import {FixtureFactory} from "../src/core/FixtureFactory.sol";
import {MatchOracle} from "../src/core/MatchOracle.sol";
import {SettlementPot} from "../src/core/SettlementPot.sol";
import {ScoreMath} from "../src/core/libraries/ScoreMath.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {EnsRoleAuth} from "../src/integrations/ens/EnsRoleAuth.sol";

import {AgentRegistry} from "../src/integrations/ens/AgentRegistry.sol";
import {EnsSepolia} from "../src/integrations/ens/EnsSepolia.sol";
import {IPermissionedRegistry, IRegistry} from "../src/integrations/ens/IENSv2.sol";

import {WhistleHook} from "../src/integrations/uniswap/WhistleHook.sol";
import {WhistleFillRouter} from "../src/integrations/uniswap/WhistleFillRouter.sol";
import {MMVault} from "../src/integrations/uniswap/MMVault.sol";
import {IAgentAuth} from "../src/interfaces/IAgentAuth.sol";

/// @notice Stand the whole stack up from a compiled fixture file.
///
/// @dev Intended for a local anvil fork of Sepolia, which is where `replay.ts` is
///      dry-run. It is also the skeleton of the step-8 Sepolia deploy — the only
///      differences there are batching (a 36-card fixture does not fit one block)
///      and not re-registering `whistle.eth`, which already exists.
///
///      Run against a fork with:
///        anvil --fork-url $SEPOLIA_RPC_URL --fork-block-number 11753325
///        forge script script/DeployWhistle.s.sol:DeployWhistle \
///          --rpc-url http://127.0.0.1:8545 --broadcast --skip-simulation
///
///      Writes `deployments/anvil.json`, which the TypeScript reads.
contract DeployWhistle is Script {
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0xE03A1074c86CFeDd5C142C4F04F1a1536e203543);
    IPositionManager internal constant POSITION_MANAGER =
        IPositionManager(0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4);
    IAllowanceTransfer internal constant PERMIT2 =
        IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    uint32 internal constant ORDER_DELAY_L = 30;
    uint32 internal constant STALE_TOLERANCE = 600;
    int24 internal constant TICK_SPACING = 60;
    uint16 internal constant LP_SHARE_BPS = 5000;
    uint256 internal constant WAD = 1e18;

    /// @dev Player ids that get a pool. Keeper, scorer, scorer.
    /// @dev Player ids that get a pool: the keeper, and the two goalscorers.
    uint16[3] internal TRADED = [uint16(0), 5, 25];

    /// @notice Vault units minted per card at `P0`.
    ///
    /// @dev 200, not 100. Half goes into the concentrated position and half stays
    ///      as LIVE fill inventory, so 100 units back the vault side of the book per
    ///      card. At 100 seeded that would be 50, and a demo order of any realistic
    ///      size would exhaust it — every batch would ration, which makes the
    ///      pro-rata path look like the normal case rather than the exception it is.
    ///      200 leaves enough depth that netting is what you see and rationing is
    ///      what you have to reach for. The cost is the same either way: one
    ///      `mintPreMatch` call, paid in a mock quote asset.
    uint256 internal constant VAULT_UNITS_PER_CARD = 200e18;

    struct Ctx {
        address deployer;
        MockUSDC usdc;
        EnsRoleAuth roleAuth;
        FixtureFactory factory;
        MatchOracle oracle;
        SettlementPot pot;
        WhistleHook hook;
        WhistleFillRouter router;
        MMVault vault;
        AgentRegistry agentRegistry;
        address rootRegistry;
        uint256 fixtureId;
        uint16 playerCount;
    }

    function run() external {
        string memory fixturePath =
            vm.envOr("FIXTURE_FILE", string("../fixtures/che-bar-2009-05-06.deploy.json"));
        string memory json = vm.readFile(fixturePath);

        uint256 pk = _key("DEPLOYER_PRIVATE_KEY");
        Ctx memory c;
        c.deployer = vm.addr(pk);
        c.fixtureId = vm.parseJsonUint(json, ".fixtureId");
        c.playerCount = uint16(vm.parseJsonUint(json, ".playerCount"));

        console.log("deployer  ", c.deployer);
        console.log("fixtureId ", c.fixtureId);
        console.log("players   ", c.playerCount);

        vm.startBroadcast(pk);

        // Order matters: the ENS root registry has to exist before EnsRoleAuth,
        // which has to exist before the factory, because the factory hands it to
        // MatchOracle in its constructor.
        _deployEns(c);
        _deployCore(c);
        _addPlayers(c, json);
        _deployVenue(c);
        _createPoolsAndSeed(c);
        _createAgents(c);

        vm.stopBroadcast();

        _writeDeployment(c);
    }

    function _key(string memory name) private view returns (uint256) {
        string memory raw = vm.envString(name);
        if (bytes(raw).length > 2 && bytes(raw)[0] == "0" && bytes(raw)[1] == "x") {
            return vm.parseUint(raw);
        }
        return vm.parseUint(string.concat("0x", raw));
    }

    // ------------------------------------------------------------------ core

    function _deployCore(Ctx memory c) private {
        c.usdc = new MockUSDC();

        // ROLE_POST_EVENT is read live off `oracle.whistle.eth`. Handing the oracle
        // role to another key is an ENS transfer; taking it away is an ENS
        // revocation. Neither needs a transaction against Whistle.
        c.roleAuth = new EnsRoleAuth(IPermissionedRegistry(c.rootRegistry), "oracle");
        console.log("EnsRoleAuth ", address(c.roleAuth));
        console.log("  role holder", c.roleAuth.roleHolder());

        c.factory = new FixtureFactory(address(c.usdc), c.roleAuth);
        c.oracle = c.factory.oracle();
        c.pot = SettlementPot(c.factory.createFixture(c.fixtureId, ORDER_DELAY_L, STALE_TOLERANCE));

        console.log("MockUSDC     ", address(c.usdc));
        console.log("FixtureFactory", address(c.factory));
        console.log("MatchOracle  ", address(c.oracle));
        console.log("SettlementPot", address(c.pot));
    }

    /// @dev Parsed fixture arrays, held in one struct so the batching loop below
    ///      stays inside the stack limit without `via_ir`.
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

    /// @dev In batches, because a 36-card fixture does not fit one block on Sepolia.
    function _addPlayers(Ctx memory c, string memory json) private {
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

        uint256 batch = 12;
        for (uint256 start = 0; start < c.playerCount; start += batch) {
            uint256 size = start + batch > c.playerCount ? c.playerCount - start : batch;
            _addBatch(c, squad, start, size);
            console.log("  addPlayers batch from", start, "size", size);
        }

        c.factory.finalizeFixture(c.fixtureId);
    }

    function _addBatch(Ctx memory c, Squad memory squad, uint256 start, uint256 size) private {
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

        c.factory.addPlayers(c.fixtureId, cfgs, batchNames, batchSymbols);
    }

    // ----------------------------------------------------------------- venue

    function _deployVenue(Ctx memory c) private {
        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
        // The operator is passed explicitly: `forge script` routes `new{salt:}`
        // through the deterministic CREATE2 factory, so `msg.sender` inside the
        // constructor is that factory rather than the deployer.
        bytes memory args = abi.encode(
            POOL_MANAGER, c.oracle, IAgentAuth(address(c.agentRegistry)), c.deployer, c.deployer
        );

        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_FACTORY, flags, type(WhistleHook).creationCode, args);

        c.hook = new WhistleHook{salt: salt}(
            POOL_MANAGER, c.oracle, IAgentAuth(address(c.agentRegistry)), c.deployer, c.deployer
        );
        require(address(c.hook) == hookAddr, "hook address mismatch");

        c.router = new WhistleFillRouter(POOL_MANAGER, address(c.hook));
        c.hook.setFillRouter(c.router);

        c.vault = new MMVault(POOL_MANAGER, POSITION_MANAGER, PERMIT2, c.pot, address(c.hook));
        c.hook.setVault(c.vault);

        c.agentRegistry.setMarket(address(c.hook));
        c.factory.setMinter(c.fixtureId, address(c.hook));

        console.log("WhistleHook  ", address(c.hook));
        console.log("FillRouter   ", address(c.router));
        console.log("MMVault      ", address(c.vault));
    }

    // ------------------------------------------------------------------- ENS

    /// @dev Deploys Whistle's own root registry, registers the two service names
    ///      beneath it, and repoints `whistle.eth` at it — but only if this deployer
    ///      owns the name. On Sepolia the registrant is a separate key, so the
    ///      repoint is a second transaction from that key; the script prints what to
    ///      run rather than reverting.
    function _deployEns(Ctx memory c) private {
        c.agentRegistry = new AgentRegistry(c.deployer, c.deployer);
        console.log("AgentRegistry", address(c.agentRegistry));

        string[] memory labels = new string[](2);
        labels[0] = "whistle";
        labels[1] = "eth";
        c.rootRegistry = c.agentRegistry.deployRootRegistry(uint256(keccak256(abi.encode(block.timestamp))), labels);
        console.log("root registry", c.rootRegistry);

        uint64 serviceExpiry = uint64(block.timestamp + 365 days);

        // oracle.whistle.eth — this name IS the ROLE_POST_EVENT grant.
        address oracleSigner = vm.envOr("ORACLE_ADDRESS", c.deployer);
        c.agentRegistry.registerUser("oracle", oracleSigner, 9_001, serviceExpiry);
        console.log("oracle.whistle.eth ->", oracleSigner);

        // vault.whistle.eth — identity only. No on-chain role hangs off it; it
        // exists so the vault is nameable, and it is held by the deployer because
        // MMVault cannot receive an ERC-1155.
        c.agentRegistry.registerUser("vault", c.deployer, 9_002, serviceExpiry);
        console.log("vault.whistle.eth  ->", c.deployer, "(identity only)");

        IPermissionedRegistry ethRegistry = IPermissionedRegistry(EnsSepolia.ETH_REGISTRY);
        uint256 tokenId = ethRegistry.getTokenId(uint256(keccak256(bytes("whistle"))));
        if (ethRegistry.getOwner(tokenId) == c.deployer) {
            ethRegistry.setSubregistry(tokenId, IRegistry(c.rootRegistry));
            console.log("whistle.eth repointed");
        } else {
            console.log("whistle.eth is owned by", ethRegistry.getOwner(tokenId));
            console.log("  repoint separately with RegisterWhistleRoot --sig repointStep(address)");
        }
    }

    /// @notice Register the demo user and mint six agent mandates beneath it.
    ///
    /// @dev Two of each template — 1 protect, 2 momentum, 3 contrarian — matching
    ///      `FullMatchReplay.t.sol`, so the on-chain demo is the scenario the
    ///      integration test already passes. Skipped entirely when `DEMO_AGENTS` is
    ///      unset, because granting a mandate is the user's act, not the deploy
    ///      script's, and a real deployment does it from the app.
    function _createAgents(Ctx memory c) private {
        address[] memory agents = vm.envOr("DEMO_AGENTS", ",", new address[](0));
        if (agents.length == 0) {
            console.log("DEMO_AGENTS unset - no agents created");
            return;
        }

        // The user who grants mandates is a person, not the deployer. `registerUser`
        // keys accounts by address and the deployer already holds `vault`, so this
        // needs its own key — which is also how it would work in production.
        address demoUser = vm.envOr("DEMO_USER_ADDRESS", c.deployer);
        c.agentRegistry.registerUser("demo", demoUser, 7_001, uint64(block.timestamp + 180 days));
        console.log("demo.whistle.eth ->", demoUser);

        uint64 expiry = uint64(block.timestamp + 6 hours);
        for (uint256 i = 0; i < agents.length; ++i) {
            c.agentRegistry.createAgent(
                AgentRegistry.CreateAgentParams({
                    user: demoUser,
                    agent: agents[i],
                    fixtureId: c.fixtureId,
                    templateId: (i / 2) + 1,
                    spendCapUSDC: 2_000_000e6,
                    slippageBps: 1000,
                    expiry: expiry,
                    salt: 7_100 + i
                })
            );
            console.log("  agent", agents[i], "template", (i / 2) + 1);
        }
    }

    // -------------------------------------------------------- pools and seed

    function _createPoolsAndSeed(Ctx memory c) private {
        c.usdc.mint(c.deployer, 500_000_000e6);
        c.usdc.approve(address(c.pot), type(uint256).max);
        c.usdc.approve(address(c.vault), type(uint256).max);
        c.vault.fund(50_000_000e6);

        for (uint256 i = 0; i < TRADED.length; ++i) {
            address cardAddr = c.pot.cards(TRADED[i]);
            PoolKey memory key = _initPool(c, cardAddr);

            c.hook.registerCard(c.fixtureId, cardAddr, key);
            c.vault.registerCard(cardAddr, key);

            c.factory.setCapExempt(cardAddr, address(c.vault), true);
            c.factory.setCapExempt(cardAddr, address(c.hook), true);
            c.factory.setCapExempt(cardAddr, address(c.router), true);
            c.factory.setCapExempt(cardAddr, address(POOL_MANAGER), true);
            c.factory.setCapExempt(cardAddr, address(POSITION_MANAGER), true);
            c.factory.setCapExempt(cardAddr, c.deployer, true);

            // Float, so the 5% cap is never the binding constraint for a demo wallet.
            c.pot.mintPreMatch(cardAddr, 20_000e18, c.deployer);

            // MMVault.SEED_UNITS is the 200 this comment argues for; the constant
            // lives there because seeding is the vault's job.
            require(c.vault.SEED_UNITS() == VAULT_UNITS_PER_CARD, "seed units changed");
            c.vault.seedCard(cardAddr, LP_SHARE_BPS, 20_000e6);

            IERC20(cardAddr).approve(address(c.vault), type(uint256).max);
            c.vault.depositCards(cardAddr, 5_000e18);

            console.log("  pooled + seeded card", TRADED[i], cardAddr);
        }

        // Supply on the rest of the squad, so D reflects a whole team rather than
        // three players.
        for (uint16 p = 0; p < c.playerCount; ++p) {
            if (_isTraded(p)) continue;
            address cardAddr = c.pot.cards(p);
            c.factory.setCapExempt(cardAddr, c.deployer, true);
            c.pot.mintPreMatch(cardAddr, 2_000e18, c.deployer);
        }

        c.vault.fundReserve(5_000_000e6);
    }

    function _initPool(Ctx memory c, address cardAddr) private returns (PoolKey memory key) {
        bool usdcIsCurrency0 = address(c.usdc) < cardAddr;
        key = PoolKey({
            currency0: Currency.wrap(usdcIsCurrency0 ? address(c.usdc) : cardAddr),
            currency1: Currency.wrap(usdcIsCurrency0 ? cardAddr : address(c.usdc)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: c.hook
        });

        uint256 r = c.pot.referencePrice(cardAddr);
        uint160 sqrtPriceX96 = usdcIsCurrency0
            ? uint160(Math.sqrt(Math.mulDiv(WAD, 1 << 96, r)) << 48)
            : uint160(Math.sqrt(Math.mulDiv(r, 1 << 96, WAD)) << 48);

        POOL_MANAGER.initialize(key, sqrtPriceX96);
    }

    function _isTraded(uint16 playerId) private view returns (bool) {
        for (uint256 i = 0; i < TRADED.length; ++i) {
            if (TRADED[i] == playerId) return true;
        }
        return false;
    }

    // ------------------------------------------------------------ deployment

    function _writeDeployment(Ctx memory c) private {
        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "ensRoleAuth", address(c.roleAuth));
        vm.serializeAddress(obj, "rootRegistry", c.rootRegistry);
        vm.serializeAddress(obj, "matchOracle", address(c.oracle));
        vm.serializeAddress(obj, "settlementPot", address(c.pot));
        vm.serializeAddress(obj, "whistleHook", address(c.hook));
        vm.serializeAddress(obj, "fillRouter", address(c.router));
        vm.serializeAddress(obj, "mmVault", address(c.vault));
        vm.serializeAddress(obj, "agentRegistry", address(c.agentRegistry));
        vm.serializeAddress(obj, "fixtureFactory", address(c.factory));
        vm.serializeAddress(obj, "usdc", address(c.usdc));
        string memory out = vm.serializeString(obj, "fixtureId", vm.toString(c.fixtureId));

        string memory path = string.concat("../deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console.log("wrote", path);
    }
}
