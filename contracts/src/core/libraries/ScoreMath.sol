// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ScoreMath
/// @notice Fantasy scoring table expressed in CLOSED FORM, so that expected score
///         and the pricing denominator are both O(1) in the match clock.
///
/// @dev ## Why closed form
///
/// The naive implementation recomputes every player's `E` on every clock tick and
/// pushes 36 writes into the pot. That makes a HEARTBEAT — an event that carries no
/// information at all — one of the most expensive calls in the system.
///
/// Every term of `E` is affine in the match clock, so the whole thing collapses to
///
///     E_i(t) = (a_i + b_i * min(t, 90)) / 90
///
/// with `a_i`, `b_i` constant between events. A clock advance then costs one storage
/// write, and the aggregate denominator `D` follows the same shape (see
/// SettlementPot).
///
/// ## The scaling trick
///
/// Every component of `E` carries a division by 90. Rather than divide three times
/// and accumulate three rounding errors, the library works with
///
///     N_i(t) = 90 * E_i(t)
///
/// which is an exact integer. `N` is what the pot aggregates and prices against; the
/// 90s cancel in `R_i = Pot * E_i / D = Pot * N_i / D90`, so pricing never divides by
/// 90 at all. Only the human-facing `score()` view performs the final division.
///
/// ## Term by term (for a player on the pitch since minute `e`)
///
///     90 * banked                                      -> a += 90 * banked
///     90 * minutes    = 10e18 * (t - e)                -> a -= 10e18 * e,  b += 10e18
///     90 * decay      = baseline * (90 - t)            -> a += 90 * baseline, b -= baseline
///     90 * cleanSheet = 90 * csA + csB * t             -> a += 90 * csA,   b += csB
///
/// Sanity check, a starter with no events at t = 90 and no clean sheet:
///     N(90) = 90*baseline + (10e18 - baseline)*90 = 900e18  ->  E = 10e18.
/// Exactly the full-minutes award, as the table requires.
library ScoreMath {
    uint256 internal constant WAD = 1e18;
    uint16 internal constant FULL_MATCH = 90;

    uint256 internal constant PTS_FULL_MINUTES = 10e18;
    uint256 internal constant PTS_GOAL = 12e18;
    uint256 internal constant PTS_ASSIST = 6e18;
    uint256 internal constant PTS_CLEAN_SHEET = 8e18;
    uint256 internal constant PTS_CONCEDED = 2e18;
    uint256 internal constant PTS_YELLOW = 2e18;
    uint256 internal constant PTS_RED = 5e18;

    /// @dev Signed deltas applied to `PlayerState.banked`, which is int128 so that a
    ///      player's whole mutable state fits in ONE storage slot. Event handling
    ///      touches several players at once, so slot count there is the dominant
    ///      cost of a goal.
    int128 internal constant DELTA_GOAL = 12e18;
    int128 internal constant DELTA_ASSIST = 6e18;
    int128 internal constant DELTA_YELLOW = -2e18;
    int128 internal constant DELTA_RED = -5e18;
    int128 internal constant DELTA_CONCEDED = -2e18;

    enum Position {
        GK,
        DEF,
        MID,
        FWD
    }

    /// @param expectedEventPoints WAD. Goals/assists/cards only — EXCLUDES clean
    ///        sheet, which is its own component so that conceding zeroes an
    ///        expectation rather than applying a negative event delta.
    /// @param cleanSheetProb0 WAD in [0, 1e18]. Must be 0 for MID/FWD.
    /// @dev Field order is chosen so the whole struct packs into a single slot
    ///      (16 + 8 + 2 + 1 + 1 + 1 = 29 bytes).
    struct PlayerConfig {
        uint128 expectedEventPoints;
        uint64 cleanSheetProb0;
        uint16 expectedMinutes;
        uint8 team;
        Position position;
        bool starter;
    }

    /// @param entryMinute Minute the player came on, clamped to 90. Minutes played
    ///        are derived as `t - entryMinute`, so no per-tick accrual loop exists.
    /// @param frozenMinutes Minutes banked at the moment of freezing.
    /// @dev Also packs into a single slot (16 + 2 + 2 + 1 + 1 = 22 bytes).
    struct PlayerState {
        int128 banked;
        uint16 entryMinute;
        uint16 frozenMinutes;
        bool onPitch;
        bool frozen;
    }

    /// @notice Clamp the raw clock for every linear term.
    /// @dev Stoppage time still banks events (a 94th-minute goal counts) but must
    ///      not extend minutes played or push decay negative.
    function clamp(uint16 clock) internal pure returns (uint16) {
        return clock > FULL_MATCH ? FULL_MATCH : clock;
    }

    function baseline(PlayerConfig memory cfg) internal pure returns (uint256) {
        return uint256(cfg.expectedEventPoints) + (PTS_FULL_MINUTES * cfg.expectedMinutes) / FULL_MATCH;
    }

    /// @notice Clean-sheet intercept and ramp, both WAD.
    /// @dev `csA` is the bonus already expected at kickoff; `csB` is the remainder
    ///      that accrues linearly across the 90 minutes. At t = 90 the pair sums to
    ///      the full 8 points, which is what makes `E(90)` meet `S` exactly.
    function cleanSheetTerms(PlayerConfig memory cfg) internal pure returns (uint256 csA, uint256 csB) {
        if (cfg.position != Position.GK && cfg.position != Position.DEF) return (0, 0);
        csA = (PTS_CLEAN_SHEET * cfg.cleanSheetProb0) / WAD;
        csB = (PTS_CLEAN_SHEET * (WAD - uint256(cfg.cleanSheetProb0))) / WAD;
    }

    /// @notice Coefficients of `N_i(t) = a + b * min(t, 90)`.
    /// @dev Three regimes:
    ///      - frozen: constant. `b = 0`, so a clock advance cannot move them.
    ///      - on the pitch: full affine form.
    ///      - on the bench, never used: only the decaying expectation that they
    ///        might yet come on.
    function affine(PlayerConfig memory cfg, PlayerState memory st, bool teamConceded)
        internal
        pure
        returns (int256 a, int256 b)
    {
        int256 banked90 = int256(uint256(FULL_MATCH)) * int256(st.banked);

        if (st.frozen) {
            return (banked90 + int256(PTS_FULL_MINUTES * st.frozenMinutes), int256(0));
        }

        int256 base = int256(baseline(cfg));

        if (!st.onPitch) {
            // Unused substitute: no minutes, no clean sheet, expectation decaying.
            return (banked90 + int256(uint256(FULL_MATCH)) * base, -base);
        }

        (uint256 csA, uint256 csB) = teamConceded ? (uint256(0), uint256(0)) : cleanSheetTerms(cfg);

        a = banked90 - int256(PTS_FULL_MINUTES * st.entryMinute) + int256(uint256(FULL_MATCH)) * base
            + int256(uint256(FULL_MATCH) * csA);
        b = int256(PTS_FULL_MINUTES) - base + int256(csB);
    }

    /// @notice `N_i(t)`, the 90x-scaled expected score. May be negative before flooring.
    function nAt(int256 a, int256 b, uint16 clock) internal pure returns (int256) {
        return a + b * int256(uint256(clamp(clock)));
    }

    /// @notice Expected score in WAD, floored at zero.
    function score(int256 a, int256 b, uint16 clock) internal pure returns (uint256) {
        int256 n = nAt(a, b, clock);
        return n <= 0 ? 0 : uint256(n) / FULL_MATCH;
    }

    /// @notice Final score is simply the expected score evaluated at full time.
    /// @dev Because decay reaches zero and the clean-sheet ramp reaches the full
    ///      bonus at the same instant, `E(90) == S` holds STRUCTURALLY here rather
    ///      than by numerical coincidence. There is no separate settlement formula
    ///      that could drift from the live one.
    function finalScore(int256 a, int256 b) internal pure returns (uint256) {
        return score(a, b, FULL_MATCH);
    }

    /// @notice Minutes played at clock `clock`.
    function minutesPlayed(PlayerState memory st, uint16 clock) internal pure returns (uint16) {
        if (st.frozen) return st.frozenMinutes;
        if (!st.onPitch) return 0;
        uint16 t = clamp(clock);
        return t > st.entryMinute ? t - st.entryMinute : 0;
    }
}
