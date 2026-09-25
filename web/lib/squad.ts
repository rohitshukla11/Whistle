"use client";

/**
 * Squad facts the chain does not hold: shirt numbers and the shape a side lined
 * up in.
 *
 * `MatchOracle` stores a player's id, position and points. A shirt number is not
 * on chain, and a formation is not either — it is an observation about which
 * eleven started. Both come from the match file, vendored at build time.
 *
 * Numbers are optional by design. Seven of the thirty-six could not be verified
 * against a team sheet, so they carry none and the UI leaves the slot empty. An
 * empty slot is a small cost; a wrong squad number printed on a real footballer's
 * card is a fabricated fact.
 */

import squad from "../vendor/squad.json";

export interface SquadPlayer {
  id: number;
  name: string;
  team: 0 | 1;
  position: "GK" | "DEF" | "MID" | "FWD";
  starter: boolean;
  number?: number;
}

const PLAYERS = squad.players as SquadPlayer[];
const BY_ID = new Map(PLAYERS.map((p) => [p.id, p]));

export function squadPlayer(id: number): SquadPlayer | undefined {
  return BY_ID.get(id);
}

export function shirtNumber(id: number): number | undefined {
  return BY_ID.get(id)?.number;
}

export const TEAM_NAMES: [string, string] = [
  (squad.metadata as { homeTeam?: string }).homeTeam ?? "Home",
  (squad.metadata as { awayTeam?: string }).awayTeam ?? "Away",
];

/**
 * The shape a side started in, counted from its own starting eleven.
 *
 * Derived rather than declared, so it cannot drift from the lineup it describes.
 * Note this reads Chelsea as 4-5-1 where a match report would say 4-4-2: the
 * file lists Malouda as a midfielder, and the honest thing is to draw the data
 * we have rather than the formation we remember.
 */
export function formation(team: 0 | 1): string {
  const starters = PLAYERS.filter((p) => p.team === team && p.starter);
  const n = (pos: SquadPlayer["position"]) => starters.filter((p) => p.position === pos).length;
  const parts = [n("DEF"), n("MID"), n("FWD")].filter((x) => x > 0);
  return parts.length ? parts.join("-") : "4-4-2";
}

/**
 * Where each starter stands, in normalised pitch coordinates.
 *
 * `x` runs 0..1 across the pitch, `y` 0..1 from that team's own goal line
 * outward, so the same slots serve both halves and the caller mirrors one.
 */
export function slots(team: 0 | 1): { id: number; x: number; y: number }[] {
  const starters = PLAYERS.filter((p) => p.team === team && p.starter);
  const bands: SquadPlayer["position"][] = ["GK", "DEF", "MID", "FWD"];
  const depth: Record<SquadPlayer["position"], number> = { GK: 0.07, DEF: 0.33, MID: 0.60, FWD: 0.85 };

  const out: { id: number; x: number; y: number }[] = [];
  for (const band of bands) {
    const row = starters.filter((p) => p.position === band);
    row.forEach((p, i) => {
      // Spread the row evenly, leaving a margin at each touchline.
      const x = row.length === 1 ? 0.5 : 0.12 + (0.76 * i) / (row.length - 1);
      out.push({ id: p.id, x, y: depth[band] });
    });
  }
  return out;
}
