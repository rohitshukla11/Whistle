/**
 * Contrarian: buy what just fell, if the player is still on the pitch.
 *
 * The bet is that the market overreacts to a single event while minutes keep
 * accruing. The "still on the pitch" guard is what separates this from catching a
 * falling knife: a player who has been sent off or substituted has a frozen line
 * and will never recover, so their price drop is information, not an overreaction.
 */

import { EventType, Side, USDC } from "../../oracle/types.js";
import { affordableUnits, moveBps, type Intent, type Template, type TemplateContext } from "./types.js";

const MATERIAL_DROP_BPS = -100;
const BUDGET_USDC = 200n * USDC;

export const contrarian: Template = {
  id: 3,
  name: "contrarian",
  description: "Buys the card that fell hardest, provided the player is still playing.",

  evaluate(ctx: TemplateContext): Intent | null {
    if (ctx.event.type === EventType.HEARTBEAT) return null;

    let best: { view: (typeof ctx.market)[number]; drop: number } | null = null;

    for (const view of ctx.market) {
      // A frozen line cannot rebound. This is the whole discipline of the template.
      if (view.frozen || !view.onPitch) continue;

      const drop = moveBps(view.referencePrice, view.pricePrevious);
      if (drop > MATERIAL_DROP_BPS) continue;
      if (best === null || drop < best.drop) best = { view, drop };
    }

    if (best === null) return null;

    const units = affordableUnits(ctx, best.view.referencePrice, BUDGET_USDC);
    if (units === 0n) return null;

    return {
      card: best.view.card,
      playerId: best.view.playerId,
      side: Side.BUY,
      units,
      reason: `contrarian: faded ${best.view.name} at ${best.drop} bps`,
    };
  },
};
