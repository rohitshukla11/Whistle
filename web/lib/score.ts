"use client";

/**
 * The scoreline, counted from match events.
 *
 * `MatchOracle` stores points, not goals — a 1–0 win and a 0–0 draw with the same
 * expected scores are indistinguishable from its state. So the score is counted
 * from `MatchEvent` logs, which means it is only as complete as the log scan was.
 *
 * `known` carries that honestly. An RPC that cannot serve history returns an
 * empty result rather than an error, and printing "0–0" over a match that has
 * been scored in is worse than printing nothing.
 */

import type { FeedEntry, PlayerRow } from "./useWhistle";

export interface Score {
  home: number;
  away: number;
  /** False when the feed is incomplete; render "–" rather than a number. */
  known: boolean;
}

export function scoreFrom(
  feed: FeedEntry[],
  players: PlayerRow[],
  feedComplete: boolean,
  /** `undefined` while the fixture header has not loaded. */
  clock: number | undefined,
): Score {
  const byName = new Map(players.map((p) => [p.name, p.team]));
  const out: [number, number] = [0, 0];
  let events = 0;

  for (const f of feed) {
    if (f.kind !== "event") continue;
    events += 1;
    if (!/GOAL/.test(f.label)) continue;
    const team = byName.get(f.detail.split(" → ")[0]?.trim() ?? "");
    if (team === 0 || team === 1) out[team] += 1;
  }

  // No header means no clock, and no clock means there is nothing to judge an
  // empty feed against. A pre-match fixture and a fixture we have not read yet
  // both have zero goals so far; only one of them is a fact.
  const known = clock === undefined ? false : feedComplete || events > 0 || clock === 0;
  return { home: out[0], away: out[1], known };
}
