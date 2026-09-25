// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

import {CurrencySettler} from "@openzeppelin/uniswap-hooks/src/utils/CurrencySettler.sol";

/// @title WhistleFillRouter
/// @notice Holds the `PoolManager` unlock and issues the swap that fills a tick's
///         residual against vault inventory.
///
/// @dev ## Why this contract exists at all
///
///      `WhistleHook` cannot call `PoolManager.swap` itself. `Hooks.beforeSwap`
///      opens with
///
///      ```solidity
///      if (msg.sender == address(self)) return (amountToSwap, ZERO_DELTA, lpFeeOverride);
///      ```
///
///      so a hook that swaps on its own pool never receives its own `beforeSwap`
///      callback. The swap then executes against the AMM curve at the AMM price,
///      **silently** — no revert, no event, just a fill at the wrong price.
///      `Hooks.afterSwap` carries the identical guard.
///
///      Routing the swap through a second contract restores the callback, because
///      `msg.sender` is then this router rather than the hook. The hook checks
///      `sender == fillRouter` before honouring a `BeforeSwapDelta`, so the
///      custom-curve path stays closed to everyone else.
///
///      Measured against the live Sepolia PoolManager in
///      `test/integrations/uniswap/proto/FillPathProbe.t.sol`.
///
///      This contract is deliberately tiny and holds no inventory between calls:
///      it pulls what it owes from the hook and pushes everything it receives
///      straight back.
contract WhistleFillRouter is IUnlockCallback {
    using CurrencySettler for Currency;

    IPoolManager public immutable poolManager;

    /// @notice The only caller. Set at construction, never changed.
    /// @dev The hook's address is CREATE2-mined before deployment (its low bits
    ///      encode its permission flags), so it is known in advance and this
    ///      router can be deployed first.
    address public immutable hook;

    error OnlyHook();
    error OnlyPoolManager();

    enum Action {
        FILL,
        SEED
    }

    constructor(IPoolManager poolManager_, address hook_) {
        poolManager = poolManager_;
        hook = hook_;
    }

    modifier onlyHook() {
        if (msg.sender != hook) revert OnlyHook();
        _;
    }

    /// @notice Swap on `key` so the hook's `_beforeSwap` fills it at `R`.
    /// @param amountSpecified Negative for exact input, positive for exact output.
    ///        Residual buys use exact output and residual sells exact input, so the
    ///        unit count is exact on whichever side the batch was computed from.
    function fill(PoolKey calldata key, bool zeroForOne, int256 amountSpecified)
        external
        onlyHook
        returns (BalanceDelta delta)
    {
        bytes memory result = poolManager.unlock(abi.encode(Action.FILL, key, abi.encode(zeroForOne, amountSpecified)));
        delta = abi.decode(result, (BalanceDelta));
    }

    /// @notice Convert the hook's ERC-20 holdings into ERC-6909 claims on the
    ///         `PoolManager`, which is what `_beforeSwap` pays fills out of.
    /// @dev Stands in for MMVault (step 5). Claims rather than ERC-20 because
    ///      settling ERC-20 inside an in-flight swap would re-`sync` a currency the
    ///      enclosing swap is still accounting for.
    function seedClaims(PoolKey calldata key, Currency currency, uint256 amount) external onlyHook {
        poolManager.unlock(abi.encode(Action.SEED, key, abi.encode(currency, amount)));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();

        (Action action, PoolKey memory key, bytes memory inner) = abi.decode(data, (Action, PoolKey, bytes));

        if (action == Action.SEED) {
            (Currency currency, uint256 amount) = abi.decode(inner, (Currency, uint256));
            // Pull ERC-20 from the hook, hand back an equal ERC-6909 balance.
            currency.settle(poolManager, hook, amount, false);
            poolManager.mint(hook, currency.toId(), amount);
            return "";
        }

        (bool zeroForOne, int256 amountSpecified) = abi.decode(inner, (bool, int256));

        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        // The hook is both counterparty and payer: it owes the input and receives
        // the output. Nothing settles to this router.
        _settle(key.currency0, delta.amount0());
        _settle(key.currency1, delta.amount1());

        return abi.encode(delta);
    }

    function _settle(Currency currency, int128 amount) private {
        if (amount < 0) {
            currency.settle(poolManager, hook, uint256(uint128(-amount)), false);
        } else if (amount > 0) {
            currency.take(poolManager, hook, uint256(uint128(amount)), false);
        }
    }
}
