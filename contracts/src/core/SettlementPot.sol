// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ISettlementPot} from "./interfaces/ISettlementPot.sol";
import {PlayerCard} from "./PlayerCard.sol";
import {PriceMath} from "./libraries/PriceMath.sol";
import {ScoreMath} from "./libraries/ScoreMath.sol";

/// @title SettlementPot
/// @notice USDC custody and pricing for one fixture. One pot per fixture.
///
/// @dev ## O(1) pricing
///
/// Each card's scaled expected score is affine in the clock: `N_i(t) = a_i + b_i*t`.
/// The pricing denominator is therefore affine too:
///
///     D90(t) = sum(N_i(t) * s_i) = A + B*t,   A = sum(a_i*s_i),  B = sum(b_i*s_i)
///
/// so the pot keeps just `A` and `B`. A clock advance is ONE storage write and
/// reprices all 36 cards; `referencePrice()` is a couple of SLOADs and a `mulDiv`.
/// Nothing iterates the card set on the hot path.
///
/// ## The floor, and why some cards sit outside the aggregate
///
/// Scores floor at zero, and `max(0, a + b*t)` is not affine — a card whose line
/// dips below zero would otherwise drag `D90` down by a negative amount and
/// overprice every other card. A card is folded into `A`/`B` only if its line is
/// non-negative across the whole remaining match, checked at both endpoints since
/// the line is monotonic. The rest go in `riskyCards` and are corrected
/// individually at query time. In practice that set is empty: it takes something
/// like a keeper conceding six to push a line negative. Because the clock only
/// advances, the interval `[t, 90]` only shrinks, so a safe card can never become
/// risky and the classification never needs revisiting.
contract SettlementPot is ISettlementPot, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for int256;
    using SafeCast for uint256;

    IERC20 public immutable usdc;
    address public immutable factory;
    uint256 public immutable fixtureId;

    address public oracle;
    address public minter;

    address[] public cards;

    /// @notice Per-card state, packed into exactly two slots.
    /// @dev Slot 0 holds the affine coefficients, slot 1 the supply and flags. An
    ///      event touches several cards at once, so slot count here is the dominant
    ///      cost of posting a goal. Supply is mirrored locally so the hot path never
    ///      makes an external call to the token.
    struct CardData {
        int128 a90; //  slot 0
        int128 b90;
        uint128 supply; // slot 1
        uint16 playerId;
        bool registered;
        bool risky;
    }

    mapping(address => CardData) public cardData;
    mapping(address => uint256) public finalScoreOf;

    /// @notice Aggregates over cards whose score line cannot go negative.
    int256 public aggA;
    int256 public aggB;

    /// @dev `risky` on CardData is the hot-path flag (already loaded with supply);
    ///      this index only moves when a card actually changes bucket, which is rare.
    address[] public riskyCards;
    mapping(address => uint256) internal riskyIndexPlus1;

    /// @notice Match clock, already clamped to 90 by the oracle.
    uint16 public clockT;

    /// @notice USDC held, tracked explicitly rather than read from `balanceOf`.
    /// @dev A donated transfer must not move every card's price, so the pot only
    ///      counts USDC that arrived through a mint.
    uint256 public potBalance;

    bool public settled;

    /// @notice True once the fixture kicks off.
    /// @dev Pre-match minting closes at an explicit kickoff, not on the first event.
    ///      Leaving it open would let anyone buy at the stale `P0` while the queue is
    ///      already the only legitimate way in.
    bool public live;

    /// @notice Pot size frozen at settlement, and the settlement denominator.
    /// @dev Payouts MUST use a snapshot. Against a live balance each redemption
    ///      would shrink the pot and inflate every later redeemer's share.
    uint256 public potSnapshot;
    uint256 public dFinal;

    error OnlyOracle();
    error OnlyFactory();
    error OnlyMinter();
    error UnknownCard();
    error AlreadySettled();
    error NotSettled();
    error CardAlreadyRegistered();
    error LengthMismatch();
    error ZeroUnits();
    error NotPreMatch();

    constructor(address usdc_, address factory_, uint256 fixtureId_) {
        usdc = IERC20(usdc_);
        factory = factory_;
        fixtureId = fixtureId_;
    }

    modifier onlyOracle() {
        if (msg.sender != oracle) revert OnlyOracle();
        _;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert OnlyFactory();
        _;
    }

    // ---------------------------------------------------------------- wiring

    function setOracle(address oracle_) external onlyFactory {
        oracle = oracle_;
    }

    function setMinter(address minter_) external onlyFactory {
        minter = minter_;
    }

    /// @notice Close pre-match minting. Called by the oracle at explicit kickoff.
    function setLive() external onlyOracle {
        live = true;
    }

    function registerCard(address card, uint16 playerId, int256 a90, int256 b90) external onlyFactory {
        CardData storage cd = cardData[card];
        if (cd.registered) revert CardAlreadyRegistered();

        cd.registered = true;
        cd.playerId = playerId;
        cd.a90 = a90.toInt128();
        cd.b90 = b90.toInt128();
        cards.push(card);

        // Supply is zero, so the aggregates are unchanged either way; classify now
        // so the first mint knows which bucket the card belongs to.
        if (!_lineIsNonNegative(a90, b90)) {
            cd.risky = true;
            _addRisky(card);
        }
        emit CardRegistered(card, playerId);
    }

    function cardCount() external view returns (uint256) {
        return cards.length;
    }

    function riskyCardCount() external view returns (uint256) {
        return riskyCards.length;
    }

    // ------------------------------------------------------------- oracle in

    /// @notice Advance the match clock. Reprices every card in one write.
    /// @dev This is the whole point of the closed form: a HEARTBEAT carries no
    ///      information about any individual player, so it should not cost 36
    ///      writes. It costs one.
    function advanceClock(uint16 t) external onlyOracle {
        clockT = t;
    }

    /// @notice Update the affine coefficients of the cards an event actually touched.
    function setAffine(address[] calldata cards_, int256[] calldata a90s, int256[] calldata b90s)
        external
        onlyOracle
    {
        if (cards_.length != a90s.length || cards_.length != b90s.length) revert LengthMismatch();

        int256 newA = aggA;
        int256 newB = aggB;

        for (uint256 i = 0; i < cards_.length; ++i) {
            address card = cards_[i];
            CardData storage cd = cardData[card];
            if (!cd.registered) revert UnknownCard();

            int256 supply = int256(uint256(cd.supply));
            bool wasSafe = !cd.risky;

            if (wasSafe) {
                newA -= int256(cd.a90) * supply;
                newB -= int256(cd.b90) * supply;
            }

            cd.a90 = a90s[i].toInt128();
            cd.b90 = b90s[i].toInt128();

            if (_lineIsNonNegative(a90s[i], b90s[i])) {
                if (!wasSafe) {
                    cd.risky = false;
                    _removeRisky(card);
                }
                newA += a90s[i] * supply;
                newB += b90s[i] * supply;
            } else if (wasSafe) {
                cd.risky = true;
                _addRisky(card);
            }
        }

        aggA = newA;
        aggB = newB;
    }

    /// @notice Freeze final scores and snapshot the pot.
    /// @dev Scores are evaluated from the pot's own affine state at minute 90, so
    ///      the settlement number is the live expected score at full time — one
    ///      formula, not two that could drift apart.
    function settle() external onlyOracle {
        if (settled) revert AlreadySettled();

        uint256 dFinal_;
        for (uint256 i = 0; i < cards.length; ++i) {
            address card = cards[i];
            CardData storage cd = cardData[card];
            uint256 s = ScoreMath.finalScore(cd.a90, cd.b90);
            finalScoreOf[card] = s;
            dFinal_ += s * cd.supply;
        }

        dFinal = dFinal_;
        potSnapshot = potBalance;
        settled = true;
        emit SettlementSnapshot(potSnapshot, dFinal_);
    }

    // ----------------------------------------------------------------- mint

    /// @notice Mint at the pre-match price `P0_i = 0.5 USDC * E_i`. Uncapped.
    function mintPreMatch(address card, uint256 units, address to)
        external
        nonReentrant
        returns (uint256 costUSDC)
    {
        if (live) revert NotPreMatch();
        costUSDC = _mint(card, units, to, quoteMint(card, units));
    }

    /// @notice Mint at the live reference price plus a premium, via the hook.
    /// @dev Minting at exactly `R_i` (premium 0) leaves every other card's `R_j`
    ///      untouched, because `Pot'/D90' = Pot/D90` holds precisely when the mint
    ///      price is `R_i`. Any premium above that raises every `R_j` slightly,
    ///      which is the point: the LIVE premium pays existing holders for the
    ///      information advantage a late minter has.
    function mintAtReference(address card, uint256 units, address to, uint256 premiumBps)
        external
        nonReentrant
        returns (uint256 costUSDC)
    {
        if (msg.sender != minter) revert OnlyMinter();
        uint256 base = quoteAtReference(card, units);
        costUSDC = _mint(card, units, to, (base * (10_000 + premiumBps)) / 10_000);
    }

    function _mint(address card, uint256 units, address to, uint256 costUSDC) private returns (uint256) {
        CardData storage cd = cardData[card];
        if (!cd.registered) revert UnknownCard();
        if (settled) revert AlreadySettled();
        if (units == 0) revert ZeroUnits();

        // Effects before interactions: aggregates, supply and balance move together.
        cd.supply = (uint256(cd.supply) + units).toUint128();
        if (!cd.risky) {
            aggA += int256(cd.a90) * int256(units);
            aggB += int256(cd.b90) * int256(units);
        }
        potBalance += costUSDC;

        usdc.safeTransferFrom(msg.sender, address(this), costUSDC);
        PlayerCard(card).mint(to, units);

        emit Minted(card, to, units, costUSDC);
        return costUSDC;
    }

    // --------------------------------------------------------------- redeem

    function redeem(address card, uint256 units, address to) external nonReentrant returns (uint256 payoutUSDC) {
        CardData storage cd = cardData[card];
        if (!settled) revert NotSettled();
        if (!cd.registered) revert UnknownCard();
        if (units == 0) revert ZeroUnits();

        payoutUSDC = _payoutFor(card, units);

        cd.supply = (uint256(cd.supply) - units).toUint128();
        if (!cd.risky) {
            aggA -= int256(cd.a90) * int256(units);
            aggB -= int256(cd.b90) * int256(units);
        }
        potBalance -= payoutUSDC;

        PlayerCard(card).burn(msg.sender, units);
        usdc.safeTransfer(to, payoutUSDC);

        emit Redeemed(card, msg.sender, units, payoutUSDC);
    }

    function _payoutFor(address card, uint256 units) private view returns (uint256) {
        if (dFinal != 0) {
            return PriceMath.payout(potSnapshot, finalScoreOf[card], units, dFinal);
        }
        // Degenerate fixture: every final score is zero, or nothing with a score was
        // ever minted. Fall back to pro-rata by supply so the pot still clears.
        uint256 totalUnits;
        for (uint256 i = 0; i < cards.length; ++i) {
            totalUnits += cardData[cards[i]].supply;
        }
        if (totalUnits == 0) return 0;
        return (potSnapshot * units) / totalUnits;
    }

    // ------------------------------------------------------- internal math

    /// @dev The line is monotonic in `t`, so non-negativity across `[clockT, 90]`
    ///      is settled by its two endpoints.
    function _lineIsNonNegative(int256 a, int256 b) private view returns (bool) {
        return ScoreMath.nAt(a, b, clockT) >= 0 && ScoreMath.nAt(a, b, ScoreMath.FULL_MATCH) >= 0;
    }

    function _addRisky(address card) private {
        if (riskyIndexPlus1[card] != 0) return;
        riskyCards.push(card);
        riskyIndexPlus1[card] = riskyCards.length;
    }

    function _removeRisky(address card) private {
        uint256 idx = riskyIndexPlus1[card];
        if (idx == 0) return;
        uint256 len = riskyCards.length;
        if (idx != len) {
            address moved = riskyCards[len - 1];
            riskyCards[idx - 1] = moved;
            riskyIndexPlus1[moved] = idx;
        }
        riskyCards.pop();
        riskyIndexPlus1[card] = 0;
    }

    function _n(address card) private view returns (uint256) {
        CardData storage cd = cardData[card];
        int256 n = ScoreMath.nAt(cd.a90, cd.b90, clockT);
        return n <= 0 ? 0 : uint256(n);
    }

    /// @notice `D90(t) = A + B*t`, plus a correction for any floored cards.
    function d90() public view returns (uint256) {
        int256 base = aggA + aggB * int256(uint256(clockT));
        uint256 total = base <= 0 ? 0 : uint256(base);

        uint256 len = riskyCards.length;
        for (uint256 i = 0; i < len; ++i) {
            CardData storage cd = cardData[riskyCards[i]];
            int256 n = ScoreMath.nAt(cd.a90, cd.b90, clockT);
            if (n > 0) total += uint256(n) * cd.supply;
        }
        return total;
    }

    // ---------------------------------------------------------------- views

    function expectedScoreOf(address card) public view returns (uint256) {
        CardData storage cd = cardData[card];
        return ScoreMath.score(cd.a90, cd.b90, clockT);
    }

    function supplyOf(address card) external view returns (uint256) {
        return cardData[card].supply;
    }

    function isCard(address card) external view returns (bool) {
        return cardData[card].registered;
    }

    function quoteMint(address card, uint256 units) public view returns (uint256) {
        return PriceMath.mintCost(expectedScoreOf(card), units);
    }

    function quoteAtReference(address card, uint256 units) public view returns (uint256) {
        uint256 denom = d90();
        if (denom == 0) return PriceMath.mintCost(expectedScoreOf(card), units);
        return PriceMath.quoteAtReference(potBalance, _n(card), units, denom);
    }

    function referencePrice(address card) external view returns (uint256) {
        return quoteAtReference(card, PriceMath.WAD);
    }

    function preMatchPrice(address card) external view returns (uint256) {
        return PriceMath.mintCost(expectedScoreOf(card), PriceMath.WAD);
    }

    function payoutPerUnit(address card) external view returns (uint256) {
        if (!settled) return 0;
        return _payoutFor(card, PriceMath.WAD);
    }

    function quoteRedeem(address card, uint256 units) external view returns (uint256) {
        if (!settled) return 0;
        return _payoutFor(card, units);
    }

    /// @notice Recompute `D90` card by card. Test/diagnostic mirror of the O(1) path.
    function recomputeD90() external view returns (uint256 total) {
        for (uint256 i = 0; i < cards.length; ++i) {
            total += _n(cards[i]) * cardData[cards[i]].supply;
        }
    }
}
