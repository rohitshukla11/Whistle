// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IMarketVenue
/// @notice Execution seam. Uniswap v4 lives behind this interface (WhistleHook,
///         step 4); a Kuru adapter could replace it without changing economics.
interface IMarketVenue {
    enum Side {
        BUY,
        SELL
    }

    enum CancelReason {
        /// @notice `R` moved further than the order's slippage tolerance, in either
        ///         direction, between submission and the clearing tick.
        PRICE_MOVED,
        /// @notice The order carries no mandate that covers it — a human order whose
        ///         owner has since become an agent.
        UNAUTHORIZED,
        /// @notice Neither the crossing book nor vault inventory could fill it, or
        ///         the trader could not pay for it.
        INSUFFICIENT_INVENTORY,
        /// @notice The agent's ENS mandate stopped authorizing the order after it was
        ///         queued: role revoked, name unregistered, expired, re-scoped, or the
        ///         spend cap exhausted.
        REVOKED
    }

    event OrderQueued(
        uint256 indexed orderId, uint256 indexed fixtureId, address indexed card, address owner, Side side, uint256 amount
    );
    event OrderFilled(uint256 indexed orderId, address indexed card, uint256 units, uint256 usdc, uint256 referencePrice);
    event OrderCancelled(uint256 indexed orderId, CancelReason reason);

    /// @notice Per-tick clearing summary. `vaultResidual` is what the netted book
    ///         could not cross internally and had to draw from vault inventory:
    ///         positive when the book was net long and the vault sold into it.
    event BatchCleared(address indexed card, uint256 referencePrice, uint256 buyVolume, uint256 sellVolume, int256 vaultResidual);

    function queueOrder(
        uint256 fixtureId,
        address card,
        Side side,
        uint256 amount,
        uint16 maxSlippageBps,
        bool isMint
    ) external returns (uint256 orderId);

    /// @notice Clear a bounded slice of the book for `fixtureId`, **paged by card**.
    ///
    /// @dev Pagination is two-dimensional on purpose. A tick's cost is dominated by
    ///      per-card work — the reference-price read, the fee computation and, when
    ///      the book does not net, a whole `PoolManager` unlock and swap — so a page
    ///      that spreads a handful of orders across many cards pays that block many
    ///      times over for very little clearing. Bounding cards first and orders
    ///      per card second keeps each card's orders together, which is where the
    ///      netting and the amortisation both come from.
    ///
    ///      The call also stops early if it would exceed the configured gas budget,
    ///      so both bounds are upper bounds rather than promises.
    ///
    /// @param maxCards Maximum number of distinct cards to clear in this call.
    /// @param maxOrdersPerCard Maximum orders admitted for each of those cards.
    /// @return nextCursor Queue index reached. The keeper loops while `processed` is
    ///         non-zero.
    /// @return processed How many orders this call resolved — filled or cancelled.
    ///         Zero means everything still queued is waiting out its delay, and the
    ///         keeper should stop rather than spin.
    function tick(uint256 fixtureId, uint256 maxCards, uint256 maxOrdersPerCard)
        external
        returns (uint256 nextCursor, uint256 processed);

    function cancelOrder(uint256 orderId) external;

    /// @notice Total orders ever queued for `fixtureId`, resolved or not.
    function queueLength(uint256 fixtureId) external view returns (uint256);
}
