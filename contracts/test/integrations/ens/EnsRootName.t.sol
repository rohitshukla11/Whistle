// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EnsForkBase} from "./EnsForkBase.sol";
import {EnsSepolia} from "../../../src/integrations/ens/EnsSepolia.sol";
import {IPermissionedRegistry, IRegistry} from "../../../src/integrations/ens/IENSv2.sol";

/// @notice Proves the registration path chosen for `whistle.eth`.
/// @dev The open question was whether the subregistry can be repointed AFTER
///      registration. If it can, we register immediately with a placeholder and
///      attach Whistle's own root registry later; if not, the root registry has to
///      be deployed first. Reading `REGISTRATION_ROLE_BITMAP` says it can — these
///      tests confirm it against deployed bytecode rather than trusting the read.
contract EnsRootNameTest is EnsForkBase {
    function setUp() public {
        if (!_setUpFork()) return;
        _ensureRootName();
    }

    function test_RootNameIsRegisteredToOwner() public onlyForked {
        assertEq(
            uint256(ethRegistry.getStatus(rootTokenId)),
            uint256(IPermissionedRegistry.Status.REGISTERED),
            "whistle.eth not registered"
        );
        assertEq(ethRegistry.getOwner(rootTokenId), rootOwner, "unexpected owner");
        assertGt(ethRegistry.getExpiry(rootTokenId), block.timestamp, "already expired");
    }

    /// @notice The owner holds the roles needed to repoint subregistry and resolver.
    function test_OwnerHoldsSubregistryAndResolverRoles() public onlyForked {
        uint256 resource = ethRegistry.getResource(rootTokenId);

        assertTrue(
            ethRegistry.hasRoles(resource, EnsSepolia.ROLE_SET_SUBREGISTRY, rootOwner),
            "owner lacks ROLE_SET_SUBREGISTRY"
        );
        assertTrue(
            ethRegistry.hasRoles(resource, EnsSepolia.ROLE_SET_RESOLVER, rootOwner),
            "owner lacks ROLE_SET_RESOLVER"
        );
    }

    /// @notice THE decision test: a placeholder registration can be repointed later.
    function test_SubregistryCanBeRepointedAfterRegistration() public onlyForked {
        // Registered with address(0) as a placeholder.
        assertEq(address(ethRegistry.getSubregistry(ROOT_LABEL)), address(0), "expected placeholder");

        address newRegistry = makeAddr("whistleRootRegistry");
        vm.prank(rootOwner);
        ethRegistry.setSubregistry(rootTokenId, IRegistry(newRegistry));

        assertEq(
            address(ethRegistry.getSubregistry(ROOT_LABEL)), newRegistry, "subregistry did not repoint"
        );
    }

    function test_ResolverCanBeRepointedAfterRegistration() public onlyForked {
        address newResolver = makeAddr("whistleResolver");
        vm.prank(rootOwner);
        ethRegistry.setResolver(rootTokenId, newResolver);
        assertEq(ethRegistry.getResolver(ROOT_LABEL), newResolver, "resolver did not repoint");
    }

    function test_NonOwnerCannotRepointSubregistry() public onlyForked {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert();
        ethRegistry.setSubregistry(rootTokenId, IRegistry(makeAddr("hostile")));
    }
}
