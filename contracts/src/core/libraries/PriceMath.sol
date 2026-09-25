// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title PriceMath
/// @notice Fixed-point conversions between scores, card units and USDC.
/// @dev Scales in play:
///        points / E / S      WAD  (1e18)
///        N = 90 * E          90 * WAD      (see ScoreMath)
///        card units          WAD  (1e18)
///        USDC                1e6
///        D90 = sum(N_j * s_j)  90 * 1e36
///
///      Pricing works in `N` and `D90` rather than `E` and `D`, because the factor
///      of 90 cancels in the ratio:
///          R_i = Pot * E_i / D = Pot * (N_i/90) / (D90/90) = Pot * N_i / D90
///      so the division by 90 never happens on the pricing path at all.
///
///      Every quote is a single `Math.mulDiv`, so there is no intermediate rounding
///      to accumulate. `mulDiv` carries the 512-bit product internally, which
///      matters because `potBalance * N` alone can reach ~1e40 before the divide.
library PriceMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant WAD_SQUARED = 1e36;

    /// @notice Pre-match price constant: 0.5 USDC per expected point, 6dp.
    uint256 internal constant USDC_PER_POINT = 5e5;

    /// @notice Pre-match mint cost: `P0_i = 0.5 USDC * E_i` for `units` card-wei.
    function mintCost(uint256 expectedScoreWad, uint256 units) internal pure returns (uint256) {
        return Math.mulDiv(USDC_PER_POINT * expectedScoreWad, units, WAD_SQUARED);
    }

    /// @notice Cost of `units` at the reference price `R_i = Pot * N_i / D90`.
    function quoteAtReference(uint256 potBalance, uint256 n, uint256 units, uint256 d90)
        internal
        pure
        returns (uint256)
    {
        if (d90 == 0) return 0;
        return Math.mulDiv(potBalance * n, units, d90);
    }

    /// @notice Settlement payout for `units`, against the frozen pot snapshot.
    /// @dev `payout_per_unit_i = Pot * S_i / sum(S_j * supply_j)`.
    function payout(uint256 potSnapshot, uint256 finalScoreWad, uint256 units, uint256 dFinal)
        internal
        pure
        returns (uint256)
    {
        if (dFinal == 0) return 0;
        return Math.mulDiv(potSnapshot * finalScoreWad, units, dFinal);
    }
}
