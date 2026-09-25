// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IRoleAuth} from "../interfaces/IRoleAuth.sol";

/// @notice Mapping-backed {IRoleAuth} for local tests and pre-ENS deploys.
/// @dev Step 3 replaces this with an ENSv2-backed implementation reading
///      `ROLE_POST_EVENT` off `oracle.whistle.eth`. It is NOT part of the demo path.
contract SimpleRoleAuth is IRoleAuth {
    address public admin;
    mapping(address => bool) public posters;

    error OnlyAdmin();

    event PosterSet(address indexed account, bool allowed);

    constructor(address admin_) {
        admin = admin_;
    }

    function setPoster(address account, bool allowed) external {
        if (msg.sender != admin) revert OnlyAdmin();
        posters[account] = allowed;
        emit PosterSet(account, allowed);
    }

    function hasPostEventRole(address account) external view returns (bool) {
        return posters[account];
    }
}
