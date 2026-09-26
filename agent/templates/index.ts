import { contrarian } from "./contrarian.js";
import { momentum } from "./momentum.js";
import { protect } from "./protect.js";
import type { Template } from "./types.js";

export const TEMPLATES: Template[] = [protect, momentum, contrarian];

export function templateById(id: number): Template {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`unknown template id ${id}; known: ${TEMPLATES.map((x) => x.id).join(", ")}`);
  return t;
}

export { contrarian, momentum, protect };
export type { Intent, MarketView, Template, TemplateContext } from "./types.js";
