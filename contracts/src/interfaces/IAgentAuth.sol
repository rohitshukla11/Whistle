// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IAgentAuth
/// @notice Authorization seam for agent-originated orders.
/// @dev ENSv2 lives behind this interface (see AgentRegistry, step 3). A Monad /
///      ERC-8004 adapter can be dropped in without touching hook or market logic.
interface IAgentAuth {
    /// @notice True if `agent` may trade `card` in `fixtureId` for `amountUSDC`.
    /// @dev Implementations must resolve the agent's ENS name and check roles,
    ///      expiry and remaining spend cap on-chain. No caching, no hard-coding.
    function isAuthorized(address agent, uint256 fixtureId, address card, uint256 amountUSDC)
        external
        view
        returns (bool);

    /// @notice Debit `amountUSDC` from the agent's remaining spend cap.
    function recordSpend(address agent, uint256 amountUSDC) external;

    /// @notice True if `account` is a registered agent (humans skip auth checks).
    function isAgent(address account) external view returns (bool);
}
