// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EnsForkBase} from "./EnsForkBase.sol";
import {AgentRegistry} from "../../../src/integrations/ens/AgentRegistry.sol";
import {EnsSepolia} from "../../../src/integrations/ens/EnsSepolia.sol";
import {WhistleNames} from "../../../src/integrations/ens/WhistleNames.sol";
import {
    IPermissionedRegistry,
    IPermissionedResolver,
    IRegistry,
    IRegistryToken,
    IUniversalResolver
} from "../../../src/integrations/ens/IENSv2.sol";

interface ITextProfile {
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

/// @notice Step 3 acceptance tests, against the LIVE ENSv2 Sepolia beta.
/// @dev No mocks anywhere in the authorization path: every assertion below is
///      answered by the deployed ENS contracts.
contract AgentRegistryTest is EnsForkBase {
    AgentRegistry internal agentRegistry;
    IPermissionedRegistry internal rootRegistry;
    IPermissionedRegistry internal aliceRegistry;

    address internal platform;
    address internal alice;
    address internal agent1;
    address internal agent2;
    address internal oracleSigner;

    uint256 internal constant FIXTURE_ID = 42;
    uint256 internal constant TEMPLATE_ID = 1;
    uint256 internal constant SPEND_CAP = 500_000_000; // 500 USDC, 6dp
    uint64 internal agentExpiry;

    address internal agent1Resolver;
    uint256 internal agent1TokenId;

    function setUp() public {
        if (!_setUpFork()) return;

        // Assigned after the fork exists so code can be cleared; see {_eoa}.
        platform = _eoa("platform");
        alice = _eoa("alice");
        agent1 = _eoa("agent1");
        agent2 = _eoa("agent2");
        oracleSigner = _eoa("oracleSigner");

        _ensureRootName();

        agentRegistry = new AgentRegistry(address(this), platform);

        string[] memory labels = new string[](2);
        labels[0] = ROOT_LABEL;
        labels[1] = "eth";
        rootRegistry = IPermissionedRegistry(agentRegistry.deployRootRegistry(1, labels));

        // Attach our registry beneath whistle.eth. The name's owner holds
        // ROLE_SET_SUBREGISTRY from REGISTRATION_ROLE_BITMAP.
        vm.prank(rootOwner);
        ethRegistry.setSubregistry(rootTokenId, IRegistry(address(rootRegistry)));

        (address aliceReg,) = agentRegistry.registerUser("alice", alice, 2, uint64(block.timestamp + 180 days));
        aliceRegistry = IPermissionedRegistry(aliceReg);

        // Fixture scheduled full time + 5 minutes.
        agentExpiry = uint64(block.timestamp + 2 hours + 5 minutes);

        (agent1Resolver, agent1TokenId) = agentRegistry.createAgent(
            AgentRegistry.CreateAgentParams({
                user: alice,
                agent: agent1,
                fixtureId: FIXTURE_ID,
                templateId: TEMPLATE_ID,
                spendCapUSDC: SPEND_CAP,
                slippageBps: 1000,
                expiry: agentExpiry,
                salt: 3
            })
        );
    }

    // ------------------------------------------------- (a) user subname

    function test_A_UserSubnameRegisteredUnderRoot() public onlyForked {
        uint256 tokenId = rootRegistry.getTokenId(uint256(keccak256(bytes("alice"))));
        assertEq(
            uint256(rootRegistry.getStatus(tokenId)),
            uint256(IPermissionedRegistry.Status.REGISTERED),
            "alice.whistle.eth not registered"
        );
        assertEq(rootRegistry.getOwner(tokenId), alice, "alice does not own her subname");
        assertEq(
            address(rootRegistry.getSubregistry("alice")),
            address(aliceRegistry),
            "user registry not attached"
        );
        // And whistle.eth points at our root registry.
        assertEq(
            address(ethRegistry.getSubregistry(ROOT_LABEL)),
            address(rootRegistry),
            "whistle.eth not repointed"
        );
    }

    // -------------------------------------- (b) agent subname properties

    function test_B_AgentSubnameIsRegisteredAndExpiring() public onlyForked {
        assertEq(
            uint256(aliceRegistry.getStatus(agent1TokenId)),
            uint256(IPermissionedRegistry.Status.REGISTERED),
            "agent-1 not registered"
        );
        assertEq(aliceRegistry.getOwner(agent1TokenId), agent1, "agent does not own its name");
        assertEq(aliceRegistry.getExpiry(agent1TokenId), agentExpiry, "expiry is not FT + 5 min");
    }

    /// @notice Withholding ROLE_CAN_TRANSFER_ADMIN really does block transfers.
    function test_B_AgentSubnameIsNonTransferable() public onlyForked {
        uint256 resource = aliceRegistry.getResource(agent1TokenId);
        assertFalse(
            aliceRegistry.hasRoles(resource, EnsSepolia.ROLE_CAN_TRANSFER_ADMIN, agent1),
            "agent unexpectedly holds ROLE_CAN_TRANSFER_ADMIN"
        );

        IRegistryToken token = IRegistryToken(address(aliceRegistry));
        assertEq(token.balanceOf(agent1, agent1TokenId), 1, "agent should hold its token");

        vm.prank(agent1);
        vm.expectRevert();
        token.safeTransferFrom(agent1, _eoa("buyer"), agent1TokenId, 1, "");

        assertEq(token.balanceOf(agent1, agent1TokenId), 1, "token moved despite withheld role");
    }

    function test_B_ParentCanRevoke() public onlyForked {
        assertTrue(agentRegistry.isAuthorized(agent1, FIXTURE_ID, address(0), 1), "should start authorized");

        vm.prank(alice);
        agentRegistry.revokeAgent(agent1);

        assertEq(
            uint256(aliceRegistry.getStatus(agent1TokenId)),
            uint256(IPermissionedRegistry.Status.AVAILABLE),
            "name not released by revoke"
        );
    }

    // ------------------------------------ (c) per-agent resolver + rights

    function test_C_EachAgentGetsItsOwnResolver() public onlyForked {
        (address r2,) = _createSecondAgent();
        assertTrue(agent1Resolver != r2, "agents share a resolver instance");
        assertEq(aliceRegistry.getResolver("agent-1"), agent1Resolver, "resolver not attached to name");
    }

    function test_C_InitialRecordsAreWritten() public onlyForked {
        assertEq(agentRegistry.readText(agent1, "fixture"), "42", "fixture record wrong");
        assertEq(agentRegistry.readText(agent1, "strategy"), "1", "strategy record wrong");
        assertEq(agentRegistry.readText(agent1, "spend-cap"), "500000000", "spend-cap record wrong");
        assertEq(agentRegistry.readText(agent1, "slippage"), "1000", "slippage record wrong");
        assertEq(agentRegistry.readText(agent1, "status"), "active", "status record wrong");
    }

    function test_C_AgentWritesItsOwnKeys() public onlyForked {
        IPermissionedResolver r = IPermissionedResolver(agent1Resolver);
        bytes memory name = _agent1DnsName();

        vm.startPrank(agent1);
        r.setText(name, "last-action", "bought MID-6 x12");
        r.setText(name, "status", "trading");
        r.setText(name, "pnl-live", "-420");
        vm.stopPrank();

        assertEq(agentRegistry.readText(agent1, "last-action"), "bought MID-6 x12");
        assertEq(agentRegistry.readText(agent1, "pnl-live"), "-420");
    }

    function test_C_AgentCannotWriteSpendCap() public onlyForked {
        IPermissionedResolver r = IPermissionedResolver(agent1Resolver);
        bytes memory name = _agent1DnsName();
        vm.prank(agent1);
        vm.expectRevert();
        r.setText(name, "spend-cap", "999999999999");
    }

    function test_C_UserCannotWritePnlHistory() public onlyForked {
        IPermissionedResolver r = IPermissionedResolver(agent1Resolver);
        bytes memory name = _agent1DnsName();
        vm.prank(alice);
        vm.expectRevert();
        r.setText(name, "pnl-history", "fabricated");
    }

    function test_C_UserWritesMandateKeys() public onlyForked {
        IPermissionedResolver r = IPermissionedResolver(agent1Resolver);
        bytes memory name = _agent1DnsName();
        vm.prank(alice);
        r.setText(name, "spend-cap", "250000000");
        assertEq(agentRegistry.readText(agent1, "spend-cap"), "250000000");
    }

    function test_C_PlatformWritesHistoryKeys() public onlyForked {
        IPermissionedResolver r = IPermissionedResolver(agent1Resolver);
        bytes memory name = _agent1DnsName();
        vm.prank(platform);
        r.setText(name, "matches-played", "7");
        assertEq(agentRegistry.readText(agent1, "matches-played"), "7");
    }

    function test_C_PlatformCannotWriteAgentKeys() public onlyForked {
        IPermissionedResolver r = IPermissionedResolver(agent1Resolver);
        bytes memory name = _agent1DnsName();
        vm.prank(platform);
        vm.expectRevert();
        r.setText(name, "last-action", "spoofed");
    }

    /// @notice THE isolation property that forced one resolver per agent.
    /// @dev Resolver roles are scoped to (instance, key) with NO per-name scoping,
    ///      so if agents shared a resolver, agent-2 could overwrite agent-1's
    ///      `status` and `pnl-live`. Separate instances is what prevents it.
    function test_C_SecondAgentCannotWriteFirstAgentsRecords() public onlyForked {
        _createSecondAgent();

        IPermissionedResolver r1 = IPermissionedResolver(agent1Resolver);
        bytes memory name1 = _agent1DnsName();

        vm.prank(agent2);
        vm.expectRevert();
        r1.setText(name1, "status", "hijacked");

        vm.prank(agent2);
        vm.expectRevert();
        r1.setText(name1, "pnl-live", "999999");

        assertEq(agentRegistry.readText(agent1, "status"), "active", "agent-1 status was overwritten");
    }

    // --------------------------------------------- (d) revoke and expiry

    function test_D_RevokeFlipsIsAuthorized() public onlyForked {
        assertTrue(agentRegistry.isAuthorized(agent1, FIXTURE_ID, address(0), 1_000_000));

        vm.prank(alice);
        agentRegistry.revokeAgent(agent1);

        assertFalse(
            agentRegistry.isAuthorized(agent1, FIXTURE_ID, address(0), 1_000_000),
            "revoked agent still authorized"
        );
    }

    function test_D_ExpiryFlipsIsAuthorized() public onlyForked {
        assertTrue(agentRegistry.isAuthorized(agent1, FIXTURE_ID, address(0), 1_000_000));

        vm.warp(agentExpiry + 1);

        assertFalse(
            agentRegistry.isAuthorized(agent1, FIXTURE_ID, address(0), 1_000_000),
            "expired agent still authorized"
        );
    }

    // ------------------------------------------- (e) wildcard resolution

    function test_E_UserProfileResolvesThroughRegistry() public onlyForked {
        // The user's name carries a resolver and its own nested registry, which is
        // what lets agent-* names be discovered without a per-agent lookup.
        assertEq(
            rootRegistry.getResolver("alice"), EnsSepolia.PUBLIC_RESOLVER_V2, "user resolver not set"
        );
        assertEq(
            address(rootRegistry.getSubregistry("alice")),
            address(aliceRegistry),
            "user subregistry missing"
        );
        // And the agent is discoverable beneath it purely through ENS.
        assertEq(aliceRegistry.getResolver("agent-1"), agent1Resolver, "agent not discoverable");
    }

    /// @notice Resolution walks ETHRegistry -> our root registry -> alice's registry
    ///         through the real UniversalResolverV2, with no Whistle code involved.
    function test_E_UniversalResolverFindsUserResolver() public onlyForked {
        IUniversalResolver ur = IUniversalResolver(EnsSepolia.UNIVERSAL_RESOLVER_V2);

        string[] memory userLabels = new string[](3);
        userLabels[0] = "alice";
        userLabels[1] = ROOT_LABEL;
        userLabels[2] = "eth";

        (address resolver,,) = ur.findResolver(WhistleNames.dnsEncode(userLabels));
        assertEq(resolver, EnsSepolia.PUBLIC_RESOLVER_V2, "UR did not find the user's resolver");
    }

    function test_E_UniversalResolverFindsPerAgentResolver() public onlyForked {
        IUniversalResolver ur = IUniversalResolver(EnsSepolia.UNIVERSAL_RESOLVER_V2);

        (address resolver,,) = ur.findResolver(_agent1DnsName());
        assertEq(resolver, agent1Resolver, "UR did not find the agent's own resolver");
    }

    /// @notice A full profile read of an agent record through UniversalResolverV2 —
    ///         the same path the frontend takes, proving the records are real.
    function test_E_UniversalResolverReadsAgentTextRecord() public onlyForked {
        IUniversalResolver ur = IUniversalResolver(EnsSepolia.UNIVERSAL_RESOLVER_V2);

        bytes memory name = _agent1DnsName();
        string[] memory labels = new string[](4);
        labels[0] = "agent-1";
        labels[1] = "alice";
        labels[2] = ROOT_LABEL;
        labels[3] = "eth";
        bytes32 node = WhistleNames.namehash(labels);

        (bytes memory result, address resolver) =
            ur.resolve(name, abi.encodeWithSelector(ITextProfile.text.selector, node, "spend-cap"));

        assertEq(resolver, agent1Resolver, "resolved via the wrong resolver");
        assertEq(abi.decode(result, (string)), "500000000", "spend-cap did not resolve through UR");
    }

    // ------------------------------------------------ (f) oracle cannot trade

    function test_F_OracleRoleHolderIsNotAnAgent() public onlyForked {
        assertFalse(agentRegistry.isAgent(oracleSigner), "oracle registered as an agent");
        assertFalse(
            agentRegistry.isAuthorized(oracleSigner, FIXTURE_ID, address(0), 1),
            "oracle passed an authorization check"
        );
        // For every fixture, not just this one.
        for (uint256 f = 0; f < 5; ++f) {
            assertFalse(agentRegistry.isAuthorized(oracleSigner, f, address(0), 1), "oracle authorized");
        }
    }

    // ------------------------------------------------------ (g) spend cap

    function test_G_IsAuthorizedRespectsFixtureScope() public onlyForked {
        assertTrue(agentRegistry.isAuthorized(agent1, FIXTURE_ID, address(0), 1));
        assertFalse(
            agentRegistry.isAuthorized(agent1, FIXTURE_ID + 1, address(0), 1),
            "agent authorized outside its fixture"
        );
    }

    function test_G_IsAuthorizedRespectsSpendCap() public onlyForked {
        assertTrue(agentRegistry.isAuthorized(agent1, FIXTURE_ID, address(0), SPEND_CAP));
        assertFalse(
            agentRegistry.isAuthorized(agent1, FIXTURE_ID, address(0), SPEND_CAP + 1),
            "agent authorized beyond cap"
        );
    }

    function test_G_RecordSpendEnforcesCap() public onlyForked {
        agentRegistry.setMarket(address(this));

        agentRegistry.recordSpend(agent1, 400_000_000);
        assertEq(agentRegistry.remainingCap(agent1), 100_000_000, "remaining cap wrong");

        vm.expectRevert();
        agentRegistry.recordSpend(agent1, 200_000_000);

        assertFalse(
            agentRegistry.isAuthorized(agent1, FIXTURE_ID, address(0), 200_000_000),
            "over-cap trade authorized"
        );
        assertTrue(agentRegistry.isAuthorized(agent1, FIXTURE_ID, address(0), 100_000_000));
    }

    /// @notice The cap is authoritative in ENS: changing the record changes the
    ///         answer, with no call into this contract to update a cached copy.
    function test_G_CapIsReadLiveFromEns() public onlyForked {
        agentRegistry.setMarket(address(this));
        agentRegistry.recordSpend(agent1, 400_000_000);
        assertFalse(agentRegistry.isAuthorized(agent1, FIXTURE_ID, address(0), 200_000_000));

        // Alice raises the cap by writing the ENS record directly.
        vm.prank(alice);
        IPermissionedResolver(agent1Resolver).setText(_agent1DnsName(), "spend-cap", "1000000000");

        assertTrue(
            agentRegistry.isAuthorized(agent1, FIXTURE_ID, address(0), 200_000_000),
            "isAuthorized did not follow the ENS record"
        );
    }

    // ----------------------------------------------------------------- gas

    function test_Gas_CreateAgentAndIsAuthorized() public onlyForked {
        uint256 g0 = gasleft();
        agentRegistry.createAgent(
            AgentRegistry.CreateAgentParams({
                user: alice,
                agent: agent2,
                fixtureId: FIXTURE_ID,
                templateId: 2,
                spendCapUSDC: SPEND_CAP,
                slippageBps: 1000,
                expiry: agentExpiry,
                salt: 99
            })
        );
        emit log_named_uint("createAgent end-to-end (subname + resolver clone + grants)", g0 - gasleft());

        agentRegistry.isAuthorized(agent1, FIXTURE_ID, address(0), 1); // warm
        g0 = gasleft();
        agentRegistry.isAuthorized(agent1, FIXTURE_ID, address(0), 1_000_000);
        emit log_named_uint("isAuthorized (warm, full ENS read path)", g0 - gasleft());

        g0 = gasleft();
        agentRegistry.isAuthorized(agent2, FIXTURE_ID, address(0), 1_000_000);
        emit log_named_uint("isAuthorized (cold agent)", g0 - gasleft());
    }

    // ------------------------------------------------------------- helpers

    function _createSecondAgent() internal returns (address resolver, uint256 tokenId) {
        return agentRegistry.createAgent(
            AgentRegistry.CreateAgentParams({
                user: alice,
                agent: agent2,
                fixtureId: FIXTURE_ID,
                templateId: 2,
                spendCapUSDC: SPEND_CAP,
                slippageBps: 1000,
                expiry: agentExpiry,
                salt: 77
            })
        );
    }

    function _agent1DnsName() internal pure returns (bytes memory) {
        string[] memory labels = new string[](4);
        labels[0] = "agent-1";
        labels[1] = "alice";
        labels[2] = ROOT_LABEL;
        labels[3] = "eth";
        return WhistleNames.dnsEncode(labels);
    }
}
