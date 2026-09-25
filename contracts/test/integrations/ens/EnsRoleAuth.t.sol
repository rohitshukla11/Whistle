// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EnsForkBase} from "./EnsForkBase.sol";
import {AgentRegistry} from "../../../src/integrations/ens/AgentRegistry.sol";
import {EnsRoleAuth} from "../../../src/integrations/ens/EnsRoleAuth.sol";
import {IPermissionedRegistry, IRegistry} from "../../../src/integrations/ens/IENSv2.sol";

/// @notice `ROLE_POST_EVENT` really does live on `oracle.whistle.eth`.
///
/// @dev Against the live ENSv2 Sepolia beta. The point of every test here is that
///      the answer changes when ENS changes and at no other time — no function on
///      Whistle grants or revokes this role.
contract EnsRoleAuthTest is EnsForkBase {
    AgentRegistry internal agentRegistry;
    IPermissionedRegistry internal rootRegistry;
    EnsRoleAuth internal roleAuth;

    address internal oracleSigner;
    address internal stranger;
    address internal platform;

    function setUp() public {
        if (!_setUpFork()) return;

        oracleSigner = _eoa("oracleSigner");
        stranger = _eoa("stranger");
        platform = _eoa("platform");

        _ensureRootName();

        agentRegistry = new AgentRegistry(address(this), platform);

        string[] memory labels = new string[](2);
        labels[0] = ROOT_LABEL;
        labels[1] = "eth";
        rootRegistry = IPermissionedRegistry(agentRegistry.deployRootRegistry(31, labels));

        vm.prank(rootOwner);
        ethRegistry.setSubregistry(rootTokenId, IRegistry(address(rootRegistry)));

        roleAuth = new EnsRoleAuth(rootRegistry, "oracle");
    }

    function test_NobodyHoldsTheRoleBeforeTheNameExists() public onlyForked {
        assertEq(roleAuth.roleHolder(), address(0), "somebody holds an unregistered name");
        assertFalse(roleAuth.hasPostEventRole(oracleSigner), "role granted with no name");
        assertFalse(roleAuth.hasPostEventRole(address(0)), "the zero address holds the role");
    }

    function test_TheNameOwnerHoldsTheRole() public onlyForked {
        _registerOracle(oracleSigner);

        assertEq(roleAuth.roleHolder(), oracleSigner, "wrong role holder");
        assertTrue(roleAuth.hasPostEventRole(oracleSigner), "name owner does not hold the role");
        assertFalse(roleAuth.hasPostEventRole(stranger), "a stranger holds the role");
    }

    /// @notice The address that moves prices cannot trade them.
    ///
    /// @dev PLAN.md §10's separation, checked rather than asserted: `oracle` is a
    ///      plain subname under the root, never an agent, so `AgentRegistry` has no
    ///      record of it and `isAuthorized` is false on every fixture.
    function test_TheOracleIsNotAnAgent() public onlyForked {
        _registerOracle(oracleSigner);

        assertTrue(roleAuth.hasPostEventRole(oracleSigner), "oracle does not hold its own role");
        assertFalse(agentRegistry.isAgent(oracleSigner), "the oracle is registered as an agent");
        assertFalse(
            agentRegistry.isAuthorized(oracleSigner, 1, address(this), 1),
            "the oracle can trade"
        );
    }

    /// @notice And taking it away is an ENS revocation. No Whistle function is
    ///         involved in either direction.
    function test_UnregisteringTheNameRemovesTheRole() public onlyForked {
        uint256 tokenId = _registerOracle(oracleSigner);
        assertTrue(roleAuth.hasPostEventRole(oracleSigner), "precondition");

        vm.prank(address(agentRegistry));
        rootRegistry.unregister(tokenId);

        assertEq(roleAuth.roleHolder(), address(0), "role survived unregistration");
        assertFalse(roleAuth.hasPostEventRole(oracleSigner), "role survived unregistration");
    }

    function test_ExpiryRemovesTheRole() public onlyForked {
        _registerOracle(oracleSigner);
        assertTrue(roleAuth.hasPostEventRole(oracleSigner), "precondition");

        vm.warp(block.timestamp + 3 hours + 1);

        assertFalse(roleAuth.hasPostEventRole(oracleSigner), "an expired name still holds the role");
    }

    /// @dev Registers `oracle.whistle.eth` to `owner` through the same path the
    ///      deploy script uses, so this test exercises the real thing. Only
    ///      AgentRegistry holds ROLE_REGISTRAR on the root registry.
    function _registerOracle(address owner) private returns (uint256 tokenId) {
        (, tokenId) = agentRegistry.registerUser("oracle", owner, 32, uint64(block.timestamp + 3 hours));
    }
}
