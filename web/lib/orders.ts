"use client";

/**
 * Every order this fixture's hook has seen, as rows rather than events.
 *
 * Three logs describe one order's life — `OrderQueued`, then either `OrderFilled`
 * or `OrderCancelled` — and none of them alone answers "what happened to it".
 * Joining on `orderId` does: the queue log carries who, which card and how much,
 * and the terminal log carries the outcome.
 *
 * Nothing here can show an order that REVERTED. A `queueOrder` that reverts emits
 * no log at all, which is exactly why the revoke proof on the agents screen
 * simulates the call instead of looking for it here.
 */

import type { Abi, Address, PublicClient } from "viem";

import { whistleHookAbi } from "../vendor/oracle/abi";
import { scanLogs } from "./logs";
import { loadSnapshot } from "./settled";
import type { FixtureDeployment } from "./fixtures";
import type { Result } from "../components/agent-ui";

export const CANCEL_REASONS = ["PRICE_MOVED", "UNAUTHORIZED", "INSUFFICIENT_INVENTORY", "REVOKED"] as const;

export interface OrderRow {
  orderId: bigint;
  card: Address;
  owner: Address;
  side: 0 | 1;
  amount: bigint;
  block: bigint;
  tx: `0x${string}`;
  /** `null` while the order is still queued. */
  result: Result | null;
  reason?: (typeof CANCEL_REASONS)[number];
  filledUnits?: bigint;
  filledUSDC?: bigint;
  price?: bigint;
  resultBlock?: bigint;
  resultTx?: `0x${string}`;
}

type L<A> = { args?: A; blockNumber?: bigint | null; transactionHash?: `0x${string}` | null };

export interface OrderScan {
  orders: OrderRow[];
  /** Non-zero means the history is incomplete, not that nothing happened. */
  failed: number;
}

export async function scanOrders(client: PublicClient, D: FixtureDeployment): Promise<OrderScan> {
  // Settled fixtures answer from the build snapshot; see lib/settled.ts.
  await loadSnapshot(D.fixtureId, D.settled);

  const from = BigInt(D.deployBlock);
  const q = (eventName: string) => ({ address: D.whistleHook, abi: whistleHookAbi as Abi, eventName });

  const [queued, filled, cancelled] = await Promise.all([
    scanLogs<L<{ orderId?: bigint; card?: Address; owner?: Address; side?: number; amount?: bigint }>>(
      client, from, q("OrderQueued"),
    ),
    scanLogs<L<{ orderId?: bigint; units?: bigint; usdc?: bigint; referencePrice?: bigint }>>(
      client, from, q("OrderFilled"),
    ),
    scanLogs<L<{ orderId?: bigint; reason?: number }>>(client, from, q("OrderCancelled")),
  ]);

  const byId = new Map<string, OrderRow>();
  for (const log of queued.logs) {
    const a = log.args ?? {};
    if (a.orderId === undefined || !a.card || !a.owner) continue;
    byId.set(a.orderId.toString(), {
      orderId: a.orderId,
      card: a.card,
      owner: a.owner,
      side: (a.side ?? 0) === 1 ? 1 : 0,
      amount: a.amount ?? 0n,
      block: log.blockNumber ?? 0n,
      tx: log.transactionHash ?? "0x",
      result: null,
    });
  }

  for (const log of filled.logs) {
    const a = log.args ?? {};
    const row = a.orderId === undefined ? undefined : byId.get(a.orderId.toString());
    if (!row) continue;
    row.result = "filled";
    row.filledUnits = a.units ?? 0n;
    row.filledUSDC = a.usdc ?? 0n;
    row.price = a.referencePrice ?? 0n;
    row.resultBlock = log.blockNumber ?? 0n;
    row.resultTx = log.transactionHash ?? "0x";
  }

  for (const log of cancelled.logs) {
    const a = log.args ?? {};
    const row = a.orderId === undefined ? undefined : byId.get(a.orderId.toString());
    if (!row) continue;
    row.result = "cancelled";
    row.reason = CANCEL_REASONS[a.reason ?? 0] ?? "PRICE_MOVED";
    row.resultBlock = log.blockNumber ?? 0n;
    row.resultTx = log.transactionHash ?? "0x";
  }

  const orders = [...byId.values()].sort((a, b) => Number(a.orderId - b.orderId));

  /**
   * A cancel the owner came straight back from is a re-queue, not a loss.
   *
   * `PRICE_MOVED` means the batch cleared past the order's slippage bound while
   * it waited, and the runtime places it again. Calling that "cancelled" reads as
   * a failure when it is the price band doing its job — so it is only re-queued
   * if the same owner really did queue the same card again afterwards.
   */
  for (const row of orders) {
    if (row.result !== "cancelled" || row.reason !== "PRICE_MOVED") continue;
    const again = orders.some(
      (o) =>
        o.orderId > row.orderId &&
        o.owner.toLowerCase() === row.owner.toLowerCase() &&
        o.card.toLowerCase() === row.card.toLowerCase(),
    );
    if (again) row.result = "re-queued";
  }

  return { orders, failed: queued.failed + filled.failed + cancelled.failed };
}
