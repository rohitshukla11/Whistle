/** The seam every agent template implements. */

import type { Address } from "viem";

import { Position, Side, type MatchEvent } from "../../oracle/types.js";

export interface MarketView {
  playerId: number;
  name: string;
  card: Address;
  team: 0 | 1;
  position: Position;
  /** USDC 6dp for one whole card. */
  referencePrice: bigint;
  /** `R` as it stood at kickoff, the reference for "how far has this moved". */
  priceAtKickoff: bigint;
  /** `R` before the event currently being handled. */
  pricePrevious: bigint;
  onPitch: boolean;
  frozen: boolean;
  /** Has a pool and is registered with the hook. Only these can be ordered. */
  tradable: boolean;
}

export interface TemplateContext {
  /** The event that woke the agent up. */
  event: MatchEvent;
  clock: number;
  market: MarketView[];
  /** card -> units held, 18dp. */
  holdings: Map<Address, bigint>;
  /** The agent's USDC balance, 6dp. */
  usdc: bigint;
  /** What is left of the ENS spend cap, 6dp. */
  remainingCapUsdc: bigint;
}

export interface Intent {
  card: Address;
  playerId: number;
  side: Side;
  /** Card units, 18dp. */
  units: bigint;
  /** Written to the agent's `last-action` ENS record, so keep it short. */
  reason: string;
}

export interface Template {
  id: number;
  name: string;
  description: string;
  /** Return at most one intent per event. Null means "sit this one out". */
  evaluate(ctx: TemplateContext): Intent | null;
}

/** Basis-point move of `a` against `b`, signed. */
export function moveBps(now: bigint, before: bigint): number {
  if (before === 0n) return 0;
  return Number(((now - before) * 10_000n) / before);
}

/** How many whole units of `card` the agent can afford at `R`, capped by the mandate. */
export function affordableUnits(ctx: TemplateContext, price: bigint, budgetUsdc: bigint): bigint {
  if (price === 0n) return 0n;
  const spendable = [budgetUsdc, ctx.usdc, ctx.remainingCapUsdc].reduce((m, v) => (v < m ? v : m));
  return (spendable * 10n ** 18n) / price;
}

export { Side };
