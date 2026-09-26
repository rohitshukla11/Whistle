/**
 * Momentum: buy what just went up.
 *
 * Buys the card whose reference price moved up hardest on the event being handled,
 * on the theory that a player who has just scored is more likely to score again.
 * It sizes off the remaining ENS spend cap, so the mandate itself is the risk
 * limit rather than anything in this file.
 */

import { EventType, Side, USDC } from "../../oracle/types.js";
import { affordableUnits, moveBps, type Intent, type Template, type TemplateContext } from "./types.js";

/** Only chase a move of at least this size. */
const MATERIAL_RISE_BPS = 100;

/** Per-order budget. Small enough that one event cannot spend a whole mandate. */
const BUDGET_USDC = 250n * USDC;

export const momentum: Template = {
  id: 2,
  name: "momentum",
  description: "Buys the card that rose hardest on the last event.",

  evaluate(ctx: TemplateContext): Intent | null {
    if (ctx.event.type === EventType.HEARTBEAT) return null;

    const scorers = new Set(ctx.event.players);
    let best: { view: (typeof ctx.market)[number]; rise: number } | null = null;

    for (const view of ctx.market) {
      if (view.frozen || !view.onPitch) continue; // no point chasing somebody who is off

      const rise = moveBps(view.referencePrice, view.pricePrevious);
      const scoredThisEvent = ctx.event.type === EventType.GOAL && scorers.has(view.playerId);

      if (!scoredThisEvent && rise < MATERIAL_RISE_BPS) continue;
      if (best === null || rise > best.rise) best = { view, rise };
    }

    if (best === null) return null;

    const units = affordableUnits(ctx, best.view.referencePrice, BUDGET_USDC);
    if (units === 0n) return null;

    return {
      card: best.view.card,
      playerId: best.view.playerId,
      side: Side.BUY,
      units,
      reason: `momentum: bought ${best.view.name} on +${best.rise} bps`,
    };
  },
};
