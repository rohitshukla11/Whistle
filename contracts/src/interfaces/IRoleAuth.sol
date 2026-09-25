// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IRoleAuth
/// @notice Seam for "who may post match events".
/// @dev Step 2 uses {SimpleRoleAuth}. Step 3 replaces it with an ENSv2-backed
///      implementation that reads `ROLE_POST_EVENT` off `oracle.whistle.eth`.
///      Keeping this behind an interface means MatchOracle never changes when the
///      permission source moves from a mapping to ENS.
interface IRoleAuth {
    /// @notice True if `account` holds the post-event role.
    function hasPostEventRole(address account) external view returns (bool);
}
