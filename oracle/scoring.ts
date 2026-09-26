/**
 * A faithful TypeScript port of `ScoreMath.sol` plus the event handling in
 * `MatchOracle.sol`.
 *
 * Why this exists: `postFinal(fixtureId, expectedS)` takes an OPTIONAL array of
 * final scores and asserts them elementwise against its own on-chain computation.
 * Passing a non-empty array turns settlement into a cross-check between two
 * independent implementations — this one, derived from the fixture's event list,
 * and the contract's, derived from the state those same events built up on-chain.
 * If they disagree, `postFinal` reverts and the replay stops rather than settling
 * on a number nobody verified.
 *
 * Everything below is integer arithmetic in the same scales the Solidity uses:
 * points and probabilities in WAD, and the 90x-scaled `N` that lets the whole
 * expected-score curve stay affine in the match clock.
 */

import { EventType, Position, WAD, type MatchEvent, type PlayerConfig } from "./types.js";

const FULL_MATCH = 90n;
const FULL_MATCH_N = 90;

const PTS_FULL_MINUTES = 10n * WAD;
const DELTA_GOAL = 12n * WAD;
const DELTA_ASSIST = 6n * WAD;
const DELTA_YELLOW = -2n * WAD;
const DELTA_RED = -5n * WAD;
const DELTA_CONCEDED = -2n * WAD;
const PTS_CLEAN_SHEET = 8n * WAD;

interface PlayerState {
  banked: bigint;
  entryMinute: number;
  frozenMinutes: number;
  onPitch: boolean;
  frozen: boolean;
}

export interface MatchResult {
  /** Final score per player id, WAD, floored at zero. Index is the player id. */
  finalScores: bigint[];
  /** Minutes credited to each player. */
  minutes: number[];
  clock: number;
  teamConceded: [boolean, boolean];
}

const clamp = (t: number): number => (t > FULL_MATCH_N ? FULL_MATCH_N : t);

function baseline(cfg: PlayerConfig): bigint {
  return cfg.expectedEventPoints + (PTS_FULL_MINUTES * BigInt(cfg.expectedMinutes)) / FULL_MATCH;
}

function cleanSheetTerms(cfg: PlayerConfig): [bigint, bigint] {
  if (cfg.position !== Position.GK && cfg.position !== Position.DEF) return [0n, 0n];
  const csA = (PTS_CLEAN_SHEET * cfg.cleanSheetProb0) / WAD;
  const csB = (PTS_CLEAN_SHEET * (WAD - cfg.cleanSheetProb0)) / WAD;
  return [csA, csB];
}

function minutesPlayed(st: PlayerState, clock: number): number {
  if (st.frozen) return st.frozenMinutes;
  if (!st.onPitch) return 0;
  const t = clamp(clock);
  return t > st.entryMinute ? t - st.entryMinute : 0;
}

/** Coefficients of `N(t) = a + b * min(t, 90)`. Mirrors `ScoreMath.affine`. */
function affine(cfg: PlayerConfig, st: PlayerState, teamConceded: boolean): [bigint, bigint] {
  const banked90 = FULL_MATCH * st.banked;

  if (st.frozen) {
    return [banked90 + PTS_FULL_MINUTES * BigInt(st.frozenMinutes), 0n];
  }

  const base = baseline(cfg);

  if (!st.onPitch) {
    // Unused substitute: no minutes, no clean sheet, expectation decaying away.
    return [banked90 + FULL_MATCH * base, -base];
  }

  const [csA, csB] = teamConceded ? [0n, 0n] : cleanSheetTerms(cfg);

  const a = banked90 - PTS_FULL_MINUTES * BigInt(st.entryMinute) + FULL_MATCH * base + FULL_MATCH * csA;
  const b = PTS_FULL_MINUTES - base + csB;
  return [a, b];
}

/** Expected score in WAD, floored at zero. Mirrors `ScoreMath.score`. */
export function scoreAt(a: bigint, b: bigint, clock: number): bigint {
  const n = a + b * BigInt(clamp(clock));
  return n <= 0n ? 0n : n / FULL_MATCH;
}

function freeze(st: PlayerState, t: number): void {
  st.frozenMinutes = minutesPlayed(st, t);
  st.onPitch = false;
  st.frozen = true;
}

/**
 * Replay an event list and return the final scores.
 *
 * Mirrors `MatchOracle.postEvent` / `postFinal`: the clock is monotonic, stoppage
 * time banks events but never extends minutes, and `postFinal` runs the clock out
 * to 90 before computing. Final score is just the expected score evaluated at full
 * time — there is no separate settlement formula, which is why `E(90) == S` holds
 * structurally rather than by coincidence.
 */
export function deriveFinalScores(players: PlayerConfig[], events: MatchEvent[]): MatchResult {
  const { states, teamConceded, clock } = replayStates(players, events);

  // postFinal runs the clock out so anyone still on the pitch banks full minutes.
  return {
    ...evaluate(players, states, teamConceded, FULL_MATCH_N),
    clock: Math.max(clock, FULL_MATCH_N),
    teamConceded,
  };
}

/**
 * Apply an event list to a fresh squad and hand back the resulting state. Split out
 * so the live `R` table can evaluate the same state at the current clock rather
 * than at full time.
 */
function replayStates(
  players: PlayerConfig[],
  events: MatchEvent[],
): { states: Map<number, PlayerState>; teamConceded: [boolean, boolean]; clock: number } {
  const byId = new Map<number, PlayerConfig>(players.map((p) => [p.id, p]));

  const states = new Map<number, PlayerState>(
    players.map((p) => [
      p.id,
      { banked: 0n, entryMinute: 0, frozenMinutes: 0, onPitch: p.starter, frozen: false },
    ]),
  );
  const teamConceded: [boolean, boolean] = [false, false];

  let clock = 0;

  const cfgOf = (id: number): PlayerConfig => {
    const cfg = byId.get(id);
    if (!cfg) throw new Error(`event references unknown player id ${id}`);
    return cfg;
  };
  const stateOf = (id: number): PlayerState => {
    const st = states.get(id);
    if (!st) throw new Error(`no state for player id ${id}`);
    return st;
  };

  for (const ev of events) {
    if (ev.minute < clock) {
      throw new Error(`non-monotonic clock: event at ${ev.minute} after ${clock}`);
    }
    clock = ev.minute;
    const t = clamp(clock);

    switch (ev.type) {
      case EventType.HEARTBEAT:
        break;

      case EventType.GOAL: {
        const [scorer, assist] = ev.players;
        if (scorer === undefined) throw new Error("GOAL with no scorer");
        stateOf(scorer).banked += DELTA_GOAL;
        if (assist !== undefined) stateOf(assist).banked += DELTA_ASSIST;

        // The other team concedes: its keeper is docked, and on the FIRST goal the
        // whole defence loses its clean-sheet expectation at once.
        const conceding = cfgOf(scorer).team === 0 ? 1 : 0;
        teamConceded[conceding] = true;
        for (const p of players) {
          if (p.team !== conceding) continue;
          if (p.position !== Position.GK) continue;
          const st = stateOf(p.id);
          if (!st.onPitch || st.frozen) continue;
          st.banked += DELTA_CONCEDED;
        }
        break;
      }

      case EventType.YELLOW: {
        const [id] = ev.players;
        if (id === undefined) throw new Error("YELLOW with no player");
        stateOf(id).banked += DELTA_YELLOW;
        break;
      }

      case EventType.RED: {
        const [id] = ev.players;
        if (id === undefined) throw new Error("RED with no player");
        const st = stateOf(id);
        if (st.frozen) throw new Error(`RED for already-frozen player ${id}`);
        st.banked += DELTA_RED;
        freeze(st, t);
        break;
      }

      case EventType.SUB: {
        const [off, on] = ev.players;
        if (off === undefined || on === undefined) throw new Error("SUB needs [off, on]");
        const offSt = stateOf(off);
        const onSt = stateOf(on);
        if (!offSt.onPitch) throw new Error(`SUB: player ${off} is not on the pitch`);
        if (onSt.onPitch) throw new Error(`SUB: player ${on} is already on the pitch`);
        if (onSt.frozen) throw new Error(`SUB: player ${on} is frozen`);
        freeze(offSt, t);
        onSt.onPitch = true;
        onSt.entryMinute = t;
        break;
      }
    }
  }

  return { states, teamConceded, clock };
}

/** Score every player at `clock`, given the state the events have built up. */
function evaluate(
  players: PlayerConfig[],
  states: Map<number, PlayerState>,
  teamConceded: [boolean, boolean],
  clock: number,
): { finalScores: bigint[]; minutes: number[] } {
  const maxId = players.reduce((m, p) => (p.id > m ? p.id : m), 0);
  const finalScores = new Array<bigint>(maxId + 1).fill(0n);
  const minutes = new Array<number>(maxId + 1).fill(0);

  for (const p of players) {
    const st = states.get(p.id);
    if (!st) throw new Error(`no state for player id ${p.id}`);
    const [a, b] = affine(p, st, teamConceded[p.team]);
    finalScores[p.id] = scoreAt(a, b, clock);
    minutes[p.id] = minutesPlayed(st, clock);
  }

  return { finalScores, minutes };
}

/**
 * Expected score for every player at an arbitrary clock — the live `R` table's
 * input. Same machinery as {deriveFinalScores}, stopped early and evaluated at the
 * clock rather than at full time.
 */
export function expectedScoresAt(
  players: PlayerConfig[],
  events: MatchEvent[],
  clock: number,
): bigint[] {
  const upTo = events.filter((e) => e.minute <= clock);
  const { states, teamConceded } = replayStates(players, upTo);
  return evaluate(players, states, teamConceded, clock).finalScores;
}
