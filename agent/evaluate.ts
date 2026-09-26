/**
 * What an agent decides, separated from how it finds out and how it acts.
 *
 * There are now two things driving a match — `agent/runtime.ts` in a terminal
 * and `/api/sim/step` in the browser — and the one thing that must not differ
 * between them is the decision. So the decision lives here, as a function of its
 * inputs and nothing else: no chain reads, no clients, no clock, no logging.
 * Give it the same board and the same agent state and it returns the same
 * orders, on a laptop or on Vercel.
 *
 * The templates themselves are untouched. This is the layer above them: it holds
 * the rules that are true of *every* agent regardless of playbook — a revoked
 * mandate places nothing, an untradable card is not an option, an order for zero
 * units is not an order — so that no template has to remember them and no driver
 * has to re-implement them.
 */

import type { Address } from "viem";

import type { MatchEvent } from "../oracle/types.js";
import type { Intent, MarketView, Template, TemplateContext } from "./templates/types.js";

/**
 * Everything about one agent that bears on what it should do next.
 *
 * Read from the chain by whoever is driving; never read from in here. The
 * separation is the point: this shape is what makes the decision testable
 * without a node.
 */
export interface AgentState {
  address: Address;
  /** Which playbook the mandate says it runs. From ENS, not from config. */
  templateId: number;
  /**
   * `AgentRegistry.isAuthorized` at the moment the board was read.
   *
   * False covers every way a mandate can be dead — revoked, expired, paused to a
   * zero cap, wrong fixture — which is why this is a boolean rather than a
   * reason. The reason belongs in the revert, on chain, where it is provable.
   */
  authorized: boolean;
  /** card -> units held, 18dp. */
  holdings: Map<Address, bigint>;
  /** USDC balance, 6dp. */
  usdc: bigint;
  /** What is left of the ENS spend cap, 6dp. */
  remainingCapUsdc: bigint;
}

/** The market as the agent sees it: one entry per card it could trade. */
export type Board = MarketView[];

/**
 * Decide what this agent does about this event.
 *
 * Returns a list because a driver should not care how many orders a playbook
 * wants — today every template returns at most one, and the day one returns two
 * the callers do not change. An empty list is the common case and is not a
 * failure.
 */
export function evaluate(
  template: Template,
  agent: AgentState,
  latestEvent: MatchEvent,
  board: Board,
): Intent[] {
  // A mandate that is no longer good authorises nothing. Checked here rather
  // than in each template so a playbook cannot forget, and so the two drivers
  // cannot disagree about what "revoked" means.
  if (!agent.authorized) return [];

  /*
   * Only cards with a live pool are options.
   *
   * `queueOrder` reverts `UnknownCard` for anything else, and roughly two thirds
   * of a squad has no market — so without this a momentum template picks the
   * biggest mover in the whole fixture and reverts on it, every single event.
   *
   * Deliberately the ONLY filter applied to the board. A price of zero is left
   * in: it is already harmless (it affords nothing, so the zero-units guard
   * below drops the intent) and excluding it here would quietly change what the
   * terminal runtime has always shown its templates.
   */
  const tradable = board.filter((v) => v.tradable);
  if (tradable.length === 0) return [];

  const ctx: TemplateContext = {
    event: latestEvent,
    clock: latestEvent.minute,
    market: tradable,
    holdings: agent.holdings,
    usdc: agent.usdc,
    remainingCapUsdc: agent.remainingCapUsdc,
  };

  const intent = template.evaluate(ctx);
  if (!intent) return [];

  // An order for nothing still costs a transaction and still reverts. Templates
  // reach zero honestly — an empty holding, a cap with nothing left — so this is
  // a normal outcome, not a bug to report.
  if (intent.units <= 0n) return [];

  // A template must not name a card that was not on the board it was given.
  if (!tradable.some((v) => v.card.toLowerCase() === intent.card.toLowerCase())) return [];

  return [intent];
}

/**
 * The same decision, for every agent at once.
 *
 * Convenience for a driver holding a list; the ordering of the result follows
 * the ordering of `agents`, so a caller can pair them back up by index.
 */
export function evaluateAll(
  templateFor: (templateId: number) => Template,
  agents: AgentState[],
  latestEvent: MatchEvent,
  board: Board,
): { agent: AgentState; intents: Intent[] }[] {
  return agents.map((agent) => ({
    agent,
    intents: evaluate(templateFor(agent.templateId), agent, latestEvent, board),
  }));
}

export type { Intent, MarketView, Template, TemplateContext };
