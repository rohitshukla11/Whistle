// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";

import {EnsForkBase} from "../ens/EnsForkBase.sol";
import {AgentRegistry} from "../../../src/integrations/ens/AgentRegistry.sol";
import {IPermissionedRegistry, IRegistry} from "../../../src/integrations/ens/IENSv2.sol";

import {FixtureFactory} from "../../../src/core/FixtureFactory.sol";
import {MatchOracle} from "../../../src/core/MatchOracle.sol";
import {SettlementPot} from "../../../src/core/SettlementPot.sol";
import {ScoreMath} from "../../../src/core/libraries/ScoreMath.sol";
import {MockUSDC} from "../../../src/mocks/MockUSDC.sol";
import {SimpleRoleAuth} from "../../../src/mocks/SimpleRoleAuth.sol";

import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {WhistleHook} from "../../../src/integrations/uniswap/WhistleHook.sol";
import {WhistleFillRouter} from "../../../src/integrations/uniswap/WhistleFillRouter.sol";
import {MMVault} from "../../../src/integrations/uniswap/MMVault.sol";
import {IAgentAuth} from "../../../src/interfaces/IAgentAuth.sol";

/// @notice Test-build hook. Identical to {WhistleHook} except that it measures and
///         reports the live ENS authorization read.
/// @dev The instrumentation lives in an override rather than behind a flag, so the
///      production contract carries no `gasleft()` pair and no event in the hot path.
///      `AuthChecked` is what FEEDBACK.md's numbers are measured from, and what the
///      "one ENS read per agent per tick" test counts.
contract WhistleHookHarness is WhistleHook {
    event AuthChecked(address indexed agent, bool allowed, uint256 gasUsed);

    constructor(IPoolManager pm, MatchOracle oracle_, IAgentAuth auth_, address feeRecipient_, address operator_)
        WhistleHook(pm, oracle_, auth_, feeRecipient_, operator_)
    {}

    function _liveAuthCheck(address agent, uint256 fixtureId, address card, uint256 notional)
        internal
        override
        returns (bool allowed)
    {
        uint256 startGas = gasleft();
        allowed = super._liveAuthCheck(agent, fixtureId, card, notional);
        emit AuthChecked(agent, allowed, startGas - gasleft());
    }
}

/// @notice Shared rig for the step-4 hook tests.
///
/// @dev Everything below runs on ONE Sepolia fork, against BOTH live systems at
///      once: the real ENSv2 beta answers every authorization question and the real
///      v4 PoolManager executes every fill. There is no mock anywhere in either
///      path. The fork block comes from {EnsForkBase}, which picks it based on
///      whether `WHISTLE_ROOT_OWNER` is set.
abstract contract WhistleHookForkBase is EnsForkBase {
    /// @dev Sepolia v4 addresses, as pinned in PLAN.md §0.
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0xE03A1074c86CFeDd5C142C4F04F1a1536e203543);
    IPositionManager internal constant POSITION_MANAGER =
        IPositionManager(0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4);
    IAllowanceTransfer internal constant PERMIT2 =
        IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    /// @dev Cards a single `tick` may clear. Four covers every rig in this suite.
    uint256 internal constant TICK_CARDS = 4;

    /// @dev Half the seeded units go to the pool, half stay as fill inventory.
    uint16 internal constant LP_SHARE_BPS = 5000;

    /// @dev Extra inventory on top of the 200 seeded units, so the clearing tests
    ///      work at a scale where rationing is visible.
    uint256 internal constant INVENTORY_TOPUP = 10_000e18;
    uint256 internal constant USDC_RESERVE = 2_000_000e6;

    uint256 internal constant FIXTURE_ID = 7;
    uint32 internal constant ORDER_DELAY_L = 30;
    uint32 internal constant STALE_TOLERANCE = 60;
    /// @dev Squad size per side. Virtual so a test that needs a bench — a SUB has to
    ///      bring somebody on who is not already on the pitch — can ask for one.
    function _perSide() internal view virtual returns (uint16) {
        return 2;
    }


    uint256 internal constant SPEND_CAP = 10_000_000_000_000; // 10m USDC, 6dp
    int24 internal constant TICK_SPACING = 60;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    MockUSDC internal usdc;
    SimpleRoleAuth internal roleAuth;
    FixtureFactory internal factory;
    MatchOracle internal oracle;
    SettlementPot internal pot;

    /// @notice The card with a pool. Player 0: team 0's goalkeeper.
    address internal card;

    /// @dev A second card carrying supply but no pool. Without it `D` reduces to
    ///      `E_0 * supply_0` and `R_0 = Pot / supply_0` becomes constant — no match
    ///      event could move the price, and half these tests would be vacuous.
    address internal otherCard;

    AgentRegistry internal agentRegistry;
    IPermissionedRegistry internal rootRegistry;

    WhistleHookHarness internal hook;
    WhistleFillRouter internal router;
    MMVault internal vault;
    PoolKey internal key;

    address internal platform;
    address internal user;
    address internal agentA;
    address internal agentB;
    address internal human;
    address internal keeper;
    address internal oracleSigner;
    address internal feeRecipient;

    function _setUpRig() internal {
        _setUpRigPreMatch();
        _kickoff();
    }

    /// @dev Everything except the whistle. Seeding mints at `P0`, which is only legal
    ///      while the fixture is PRE_MATCH, so a test that measures seeding has to be
    ///      able to stop here.
    function _setUpRigPreMatch() internal {
        platform = _eoa("platform");
        user = _eoa("user");
        agentA = _eoa("agentA");
        agentB = _eoa("agentB");
        human = _eoa("human");
        keeper = _eoa("keeper");
        oracleSigner = _eoa("oracleSigner");
        feeRecipient = _eoa("feeRecipient");

        _deployCore();
        _deployEns();
        _deployHook();
        _initPool();
        _seed();
    }

    function _kickoff() internal {
        vm.prank(oracleSigner);
        oracle.kickoff(FIXTURE_ID);
    }

    // ------------------------------------------------------------------ core

    function _deployCore() private {
        usdc = new MockUSDC();
        roleAuth = new SimpleRoleAuth(address(this));
        roleAuth.setPoster(oracleSigner, true);

        factory = new FixtureFactory(address(usdc), roleAuth);
        oracle = factory.oracle();
        pot = SettlementPot(factory.createFixture(FIXTURE_ID, ORDER_DELAY_L, STALE_TOLERANCE));

        _addSide(0);
        _addSide(1);
        factory.finalizeFixture(FIXTURE_ID);

        card = pot.cards(0);
        otherCard = pot.cards(_perSide()); // the first player on the other side
    }

    /// @dev A deliberately small squad by default. The scoring maths has its own
    ///      36-card suite; what matters here is one card with one pool.
    function _addSide(uint8 team) private {
        uint16 n = _perSide();
        ScoreMath.PlayerConfig[] memory cfgs = new ScoreMath.PlayerConfig[](n);
        string[] memory names = new string[](n);
        string[] memory symbols = new string[](n);

        for (uint16 i = 0; i < n; ++i) {
            cfgs[i] = _configFor(team, i);
            uint16 globalId = uint16(team) * n + i;
            names[i] = string.concat("Whistle Player ", vm.toString(globalId));
            symbols[i] = string.concat("WP", vm.toString(globalId));
        }

        factory.addPlayers(FIXTURE_ID, cfgs, names, symbols);
    }

    /// @dev Default shape: a keeper and forwards, everybody starting.
    function _configFor(uint8 team, uint16 i) internal view virtual returns (ScoreMath.PlayerConfig memory) {
        return ScoreMath.PlayerConfig({
            expectedEventPoints: i == 0 ? uint128(0.5e18) : uint128(3e18),
            cleanSheetProb0: i == 0 ? uint64(0.3e18) : uint64(0),
            expectedMinutes: 90,
            team: team,
            position: i == 0 ? ScoreMath.Position.GK : ScoreMath.Position.FWD,
            starter: true
        });
    }

    // ------------------------------------------------------------------- ENS

    function _deployEns() private {
        _ensureRootName();

        agentRegistry = new AgentRegistry(address(this), platform);

        string[] memory labels = new string[](2);
        labels[0] = ROOT_LABEL;
        labels[1] = "eth";
        rootRegistry = IPermissionedRegistry(agentRegistry.deployRootRegistry(11, labels));

        vm.prank(rootOwner);
        ethRegistry.setSubregistry(rootTokenId, IRegistry(address(rootRegistry)));

        agentRegistry.registerUser("trader", user, 12, uint64(block.timestamp + 180 days));

        uint64 expiry = uint64(block.timestamp + 3 hours);
        agentRegistry.createAgent(
            AgentRegistry.CreateAgentParams({
                user: user,
                agent: agentA,
                fixtureId: FIXTURE_ID,
                templateId: 1,
                spendCapUSDC: SPEND_CAP,
                slippageBps: 1000,
                expiry: expiry,
                salt: 13
            })
        );
        agentRegistry.createAgent(
            AgentRegistry.CreateAgentParams({
                user: user,
                agent: agentB,
                fixtureId: FIXTURE_ID,
                templateId: 2,
                spendCapUSDC: SPEND_CAP,
                slippageBps: 1000,
                expiry: expiry,
                salt: 14
            })
        );
    }

    // ------------------------------------------------------------------ hook

    function _deployHook() private {
        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
        bytes memory args =
            abi.encode(POOL_MANAGER, oracle, IAgentAuth(address(agentRegistry)), feeRecipient, address(this));
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), flags, type(WhistleHookHarness).creationCode, args);

        hook = new WhistleHookHarness{salt: salt}(
            POOL_MANAGER, oracle, IAgentAuth(address(agentRegistry)), feeRecipient, address(this)
        );
        require(address(hook) == hookAddr, "hook address mismatch");

        router = new WhistleFillRouter(POOL_MANAGER, address(hook));
        hook.setFillRouter(router);

        // The vault takes the hook's address in its constructor and immediately
        // grants it ERC-6909 operator rights, so it has to be deployed after the
        // hook's address is known.
        vault = new MMVault(POOL_MANAGER, POSITION_MANAGER, PERMIT2, pot, address(hook));
        hook.setVault(vault);

        agentRegistry.setMarket(address(hook));
    }

    function _initPool() private {
        key = _createPoolFor(card);
    }

    /// @notice Initialize `target`'s pool at its own `R` and register it everywhere.
    /// @dev Anchoring at `R` rather than 1:1 keeps the dynamic fee's divergence term
    ///      at zero, so a fresh pool does not read as a 200 bps dislocation.
    function _createPoolFor(address target) internal returns (PoolKey memory poolKey) {
        bool usdcIsCurrency0 = address(usdc) < target;
        poolKey = PoolKey({
            currency0: Currency.wrap(usdcIsCurrency0 ? address(usdc) : target),
            currency1: Currency.wrap(usdcIsCurrency0 ? target : address(usdc)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: hook
        });

        uint256 r = pot.referencePrice(target);
        uint160 sqrtPriceX96 = usdcIsCurrency0 ? _sqrtPriceX96(WAD, r) : _sqrtPriceX96(r, WAD);
        POOL_MANAGER.initialize(poolKey, sqrtPriceX96);

        hook.registerCard(FIXTURE_ID, target, poolKey);
        vault.registerCard(target, poolKey);

        // The vault holds 100% of a freshly seeded card's supply for a moment, and
        // the hook and router carry fill inventory in transit. All four are exempt
        // from the 5% holder cap, exactly as a real deployment would set them.
        factory.setCapExempt(target, address(vault), true);
        factory.setCapExempt(target, address(hook), true);
        factory.setCapExempt(target, address(router), true);
        factory.setCapExempt(target, address(POOL_MANAGER), true);
        factory.setCapExempt(target, address(POSITION_MANAGER), true);
    }

    /// @dev `sqrt(num/den) * 2^96`, staged so neither half overflows.
    function _sqrtPriceX96(uint256 num, uint256 den) internal pure returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(num, 1 << 96, den)) << 48);
    }

    // ------------------------------------------------------------------ seed

    function _seed() private {
        usdc.mint(address(this), 100_000_000e6);
        usdc.approve(address(pot), type(uint256).max);
        usdc.approve(address(vault), type(uint256).max);

        address[10] memory exempt = [
            address(hook),
            address(router),
            address(vault),
            address(POOL_MANAGER),
            address(POSITION_MANAGER),
            agentA,
            agentB,
            human,
            keeper,
            address(this)
        ];
        for (uint256 i = 0; i < exempt.length; ++i) {
            factory.setCapExempt(card, exempt[i], true);
        }
        // The second card exists only to give `D` a second term; this rig holds all
        // of its supply, which is 100% of it.
        factory.setCapExempt(otherCard, address(this), true);
        factory.setCapExempt(otherCard, address(vault), true);

        // The mint lane fills out of the pot, so the hook has to be its minter.
        factory.setMinter(FIXTURE_ID, address(hook));

        // Pre-match inventory. Minting closes at kickoff, so everything any test
        // will ever need has to exist by now; later top-ups are transfers.
        // Traders hold enough to be genuine sellers. A seller short of cards fails
        // the pay check and drops out of the book, which silently turns a netting
        // test into a vault-only test.
        pot.mintPreMatch(card, 50_000e18, agentA);
        pot.mintPreMatch(card, 50_000e18, agentB);
        pot.mintPreMatch(card, 50_000e18, human);
        pot.mintPreMatch(card, 200_000e18, address(this)); // reserve for {_fundExtra}
        pot.mintPreMatch(card, INVENTORY_TOPUP, address(this)); // vault top-up

        // Supply on a second card, so `D` has more than one term and match events can
        // actually move `R` on the card under test. The weight has to be comparable:
        // `R_0 = Pot * E_0 / D`, so if card 0 dominates `D` then `R_0` collapses to
        // `Pot / supply_0` and no event can move it at all.
        pot.mintPreMatch(otherCard, 300_000e18, address(this));

        _fund(agentA);
        _fund(agentB);
        _fund(human);

        // The real seeding path: 200 units minted at P0, split between a ±10%
        // concentrated position and LIVE-fill inventory.
        vault.fund(20_000_000e6);
        vault.seedCard(card, LP_SHARE_BPS, 5_000e6);

        // Top up so the clearing tests exercise rationing rather than a dust vault.
        IERC20(card).approve(address(vault), type(uint256).max);
        vault.depositCards(card, INVENTORY_TOPUP);
        vault.fundReserve(USDC_RESERVE);
    }

    function _fund(address who) internal {
        usdc.mint(who, 1_000_000e6);
        vm.startPrank(who);
        usdc.approve(address(hook), type(uint256).max);
        IERC20(card).approve(address(hook), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev Top up a trader after kickoff. Pre-match minting is closed by then, so
    ///      cards come out of the reserve minted in {_seed} rather than from new
    ///      supply — which also keeps `R` still.
    function _fundExtra(address who, uint256 cardUnits) internal {
        factory.setCapExempt(card, who, true);
        usdc.mint(who, 1_000_000e6);
        if (cardUnits != 0) IERC20(card).transfer(who, cardUnits);
        vm.startPrank(who);
        usdc.approve(address(hook), type(uint256).max);
        IERC20(card).approve(address(hook), type(uint256).max);
        vm.stopPrank();
    }

    // --------------------------------------------------------------- helpers

    function _queue(address who, WhistleHook.Side side, uint256 units, uint16 slippageBps)
        internal
        returns (uint256 orderId)
    {
        vm.prank(who);
        orderId = hook.queueOrder(FIXTURE_ID, card, side, units, slippageBps, false);
    }

    function _notional(uint256 units, uint256 r) internal pure returns (uint256) {
        return Math.mulDiv(r, units, WAD);
    }
}
