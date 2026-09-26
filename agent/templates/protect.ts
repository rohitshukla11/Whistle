/**
 * Protect: cut exposure when the news is bad.
 *
 * The mandate a nervous holder gives an agent — do not try to win, just do not be
 * caught holding a card whose expected score has just collapsed. It only acts on
 * real events, never on heartbeats, and it only ever sells what is already held.
 */

import { EventType, Side } from "../../oracle/types.js";
import { moveBps, type Intent, type Template, type TemplateContext } from "./types.js";

/** Sell this share of the holding when a position is hit. */
const TRIM_NUMERATOR = 40n;
const TRIM_DENOMINATOR = 100n;

/** Ignore moves smaller than this; a 20 bps drift is not news. */
const MATERIAL_DROP_BPS = -150;

export const protect: Template = {
  id: 1,
  name: "protect",
  description: "Sells a slice of any held card whose reference price just dropped materially.",

  evaluate(ctx: TemplateContext): Intent | null {
    if (ctx.event.type === EventType.HEARTBEAT) return null;

    const hit = new Set(ctx.event.players);

    let worst: { view: (typeof ctx.market)[number]; drop: number } | null = null;

    for (const view of ctx.market) {
      const held = ctx.holdings.get(view.card) ?? 0n;
      if (held === 0n) continue;

      const drop = moveBps(view.referencePrice, view.pricePrevious);

      // A red card for a player we hold is the clearest possible sell signal, even
      // before the price has finished moving.
      const directlyHit = hit.has(view.playerId) && ctx.event.type === EventType.RED;

      if (!directlyHit && drop > MATERIAL_DROP_BPS) continue;
      if (worst === null || drop < worst.drop) worst = { view, drop };
    }

    if (worst === null) return null;

    const held = ctx.holdings.get(worst.view.card) ?? 0n;
    const units = (held * TRIM_NUMERATOR) / TRIM_DENOMINATOR;
    if (units === 0n) return null;

    return {
      card: worst.view.card,
      playerId: worst.view.playerId,
      side: Side.SELL,
      units,
      reason: `protect: trimmed ${worst.view.name} after ${worst.drop} bps`,
    };
  },
};
