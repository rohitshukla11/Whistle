// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ISettlementPot
/// @notice USDC custody and pricing for one fixture's 36 cards.
interface ISettlementPot {
    event CardRegistered(address indexed card, uint16 indexed playerId);
    event Minted(address indexed card, address indexed to, uint256 units, uint256 costUSDC);
    event Redeemed(address indexed card, address indexed from, uint256 units, uint256 payoutUSDC);
    event SettlementSnapshot(uint256 potSnapshot, uint256 dFinal);

    /// @notice Reference price `R_i = Pot * E_i / D` for one whole card, in USDC 6dp.
    /// @dev Never stored. Computed on demand from `potBalance`, `E_i` and the
    ///      incrementally maintained `D`.
    function referencePrice(address card) external view returns (uint256);

    /// @notice Pre-match price `P0_i = 0.5 USDC * E_i` for one whole card.
    function preMatchPrice(address card) external view returns (uint256);

    /// @notice Settlement payout for one whole card, against the frozen snapshot.
    function payoutPerUnit(address card) external view returns (uint256);

    function quoteMint(address card, uint256 units) external view returns (uint256);

    function quoteAtReference(address card, uint256 units) external view returns (uint256);

    function quoteRedeem(address card, uint256 units) external view returns (uint256);

    function mintPreMatch(address card, uint256 units, address to) external returns (uint256 costUSDC);

    function mintAtReference(address card, uint256 units, address to, uint256 premiumBps)
        external
        returns (uint256 costUSDC);

    function redeem(address card, uint256 units, address to) external returns (uint256 payoutUSDC);

    /// @notice `D90(t) = sum(N_j(t) * supply_j)`, scale 90 * 1e36.
    /// @dev Maintained as `A + B*t` so this is O(1) in the number of cards.
    function d90() external view returns (uint256);

    function potBalance() external view returns (uint256);

    function expectedScoreOf(address card) external view returns (uint256);
}
