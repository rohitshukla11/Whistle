// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IRoleAuth} from "../../interfaces/IRoleAuth.sol";
import {IPermissionedRegistry} from "./IENSv2.sol";

/// @title EnsRoleAuth
/// @notice `ROLE_POST_EVENT`, read live off `oracle.whistle.eth`.
///
/// @dev This is what PLAN.md §10 describes and what {SimpleRoleAuth} stands in for
///      during local work: the right to move the match clock belongs to whoever
///      holds one ENS name, and it is checked on every call rather than cached in a
///      mapping somebody has to remember to update.
///
///      Three things have to hold, and all three are read from the registry at call
///      time:
///        - the name is REGISTERED (revoking unregisters it),
///        - it has not expired,
///        - `account` owns it.
///
///      So handing the oracle role to a different key is an ENS transfer, and taking
///      it away is an ENS revocation — neither needs a transaction against Whistle.
///
///      Deliberately NOT an agent: `AgentRegistry.isAuthorized` returns false for
///      this name on every fixture, so the address that moves prices can never trade
///      them.
contract EnsRoleAuth is IRoleAuth {
    /// @notice Whistle's own root Permissioned Registry, sitting under `whistle.eth`.
    IPermissionedRegistry public immutable rootRegistry;

    /// @notice The label whose owner holds the role. `"oracle"` in production.
    string public label;

    /// @dev Cached because the label never changes and `keccak256` of a storage
    ///      string on every event post is pure waste.
    uint256 private immutable _labelHash;

    constructor(IPermissionedRegistry rootRegistry_, string memory label_) {
        rootRegistry = rootRegistry_;
        label = label_;
        _labelHash = uint256(keccak256(bytes(label_)));
    }

    /// @notice The address that currently owns `<label>.whistle.eth`, or zero.
    function roleHolder() public view returns (address) {
        uint256 tokenId = rootRegistry.getTokenId(_labelHash);
        if (rootRegistry.getStatus(tokenId) != IPermissionedRegistry.Status.REGISTERED) return address(0);
        if (rootRegistry.getExpiry(tokenId) <= block.timestamp) return address(0);
        return rootRegistry.getOwner(tokenId);
    }

    /// @inheritdoc IRoleAuth
    function hasPostEventRole(address account) external view returns (bool) {
        if (account == address(0)) return false;
        return roleHolder() == account;
    }
}
