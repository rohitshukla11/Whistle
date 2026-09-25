/**
 * The match the simulation replays, as the chain wants it.
 *
 * Read from the same `fixtures/che-bar-2009-05-06.json` the terminal driver
 * reads, vendored at build time. Nothing here is a second source of truth: the
 * file is the match, this only turns its strings into the enum `postEvent`
 * takes.
 */

import raw from "../../vendor/match.json";
import { deriveFinalScores } from "../../vendor/oracle/scoring";
import { EVENT_TYPE_BY_NAME, EventType, POSITION_BY_NAME, toWad } from "../../vendor/oracle/types";

export interface SimEvent {
  minute: number;
  type: EventType;
  typeName: string;
  players: number[];
  note?: string;
}

interface MatchJson {
  fixtureId: number | string;
  metadata: { homeTeam: string; awayTeam: string; finalScore: string };
  players: {
    id: number; name: string; team: 0 | 1; position: string; starter?: boolean;
    expectedEventPoints: string | number; expectedMinutes: number; cleanSheetProb0: string | number;
  }[];
  events: { minute: number; type: string; players: number[]; note?: string }[];
}

const match = raw as unknown as MatchJson;

export const FIXTURE_ID = String(match.fixtureId);
export const METADATA = match.metadata;

export const PLAYER_NAME = new Map<number, string>(match.players.map((p) => [p.id, p.name]));

/**
 * Every event, in minute order.
 *
 * Sorted defensively rather than trusted: `postEvent` enforces monotonic minutes
 * on chain, so a file that is out of order would not produce a wrong match, it
 * would produce a match that stops. Better to be sure here.
 */
export const EVENTS: SimEvent[] = match.events
  .map((e) => {
    const type = EVENT_TYPE_BY_NAME[e.type];
    if (type === undefined) throw new Error(`unknown event type ${e.type} at ${e.minute}'`);
    return { minute: e.minute, type, typeName: e.type, players: e.players, ...(e.note ? { note: e.note } : {}) };
  })
  .sort((a, b) => a.minute - b.minute);

export const LAST_MINUTE = EVENTS[EVENTS.length - 1]?.minute ?? 90;

/** A short phrase for the status line: `9' GOAL Essien`. */
export function describeEvent(e: SimEvent): string {
  const who = e.players.map((id) => PLAYER_NAME.get(id) ?? `#${id}`).join(" → ");
  return `${e.minute}' ${e.typeName}${who ? ` ${who}` : ""}`;
}

/**
 * Every event at the next unplayed minute — as a group, never one at a time.
 *
 * The cursor through the match is the oracle's clock, which is what keeps the
 * server stateless. That only works if "clock = M" means "everything up to M has
 * been applied", and posting events singly breaks exactly that: minute 65 of
 * this fixture holds TWO events, a heartbeat and the substitution that takes
 * Malouda off. Posting the heartbeat set the clock to 65, the next lookup asked
 * for `minute > 65`, and the substitution was skipped for the rest of the match
 * — the chain credited Malouda all 90 minutes and `postFinal` rejected the
 * final scores with `FinalScoreMismatch(9, 10.0, 7.222)`.
 *
 * So a step posts a whole minute. The invariant holds again, and the terminal
 * driver — which walks the event list linearly and never had this problem —
 * still produces the identical sequence.
 */
export function nextEventGroup(chainMinute: number): SimEvent[] {
  const next = EVENTS.find((e) => e.minute > chainMinute);
  if (!next) return [];
  return EVENTS.filter((e) => e.minute === next.minute);
}

/** The first event of the next group, for the status line and the countdown. */
export function nextEventAfter(chainMinute: number): SimEvent | null {
  return EVENTS.find((e) => e.minute > chainMinute) ?? null;
}


/**
 * The final scores `postFinal` asserts against, derived from the event list alone.
 *
 * Computed here rather than read from the chain on purpose: it is the
 * cross-check. The contract accrues points as events land; this replays the same
 * events independently, and `postFinal` reverts if the two disagree. Reading the
 * answer off the chain and handing it back would be asserting that a number
 * equals itself.
 */
export function expectedFinalScores(): bigint[] {
  const players = match.players.map((p) => ({
    id: p.id,
    name: p.name,
    team: p.team,
    position: POSITION_BY_NAME[p.position as keyof typeof POSITION_BY_NAME]!,
    starter: p.starter === true,
    expectedEventPoints: toWad(p.expectedEventPoints as never),
    expectedMinutes: p.expectedMinutes,
    cleanSheetProb0: toWad(p.cleanSheetProb0 as never),
  }));
  const derived = deriveFinalScores(players as never, EVENTS as never);
  return players.map((p) => derived.finalScores[p.id] ?? 0n);
}
