/**
 * A live football feed behind the same {EventSource} interface `replay.ts` uses.
 *
 * Swapping `loadFixture` for this is the only change needed to drive a real match:
 * the driver, the keeper loop and the agent runtime all work against the interface
 * rather than against the JSON file.
 *
 * Built against api-football (`v3.football.api-sports.io`), whose free tier covers
 * fixtures, line-ups and live events. Configure with:
 *
 *   FOOTBALL_API_KEY=...            required
 *   FOOTBALL_API_HOST=v3.football.api-sports.io
 *   FOOTBALL_FIXTURE_ID=1234567     the provider's fixture id
 *   FOOTBALL_POLL_SECONDS=15
 *
 * STATUS: compiles and is wired, but is NOT exercised by the test suite — no free
 * API key is committed and a live match cannot be replayed deterministically.
 * Treat the field mappings below as the thing to check first if it misbehaves.
 */

import {
  EVENT_TYPE_BY_NAME,
  EventType,
  POSITION_BY_NAME,
  Position,
  toWad,
  type EventSource,
  type Fixture,
  type MatchEvent,
  type PlayerConfig,
} from "./types.js";
import { sleep } from "./chain.js";

interface ApiPlayer {
  player: { id: number; name: string; pos?: string | null };
}

interface ApiLineup {
  team: { id: number; name: string };
  startXI: ApiPlayer[];
  substitutes: ApiPlayer[];
}

interface ApiEvent {
  time: { elapsed: number; extra?: number | null };
  team: { id: number };
  player: { id: number | null; name: string | null };
  assist: { id: number | null; name: string | null };
  type: string; // "Goal" | "Card" | "subst"
  detail: string; // "Normal Goal" | "Yellow Card" | "Red Card" | "Substitution 1"
}

export interface LiveAdapterConfig {
  apiKey: string;
  apiHost: string;
  providerFixtureId: number;
  /** Whistle's own fixture id, which does not have to match the provider's. */
  fixtureId: bigint;
  pollSeconds: number;
  /** Emit a HEARTBEAT if this many match minutes pass with no real event. */
  heartbeatEveryMinutes: number;
}

export function configFromEnv(): LiveAdapterConfig {
  const apiKey = process.env.FOOTBALL_API_KEY;
  if (!apiKey) throw new Error("FOOTBALL_API_KEY is not set");

  const providerFixtureId = Number(process.env.FOOTBALL_FIXTURE_ID ?? 0);
  if (!providerFixtureId) throw new Error("FOOTBALL_FIXTURE_ID is not set");

  return {
    apiKey,
    apiHost: process.env.FOOTBALL_API_HOST ?? "v3.football.api-sports.io",
    providerFixtureId,
    fixtureId: BigInt(process.env.WHISTLE_FIXTURE_ID ?? providerFixtureId),
    pollSeconds: Number(process.env.FOOTBALL_POLL_SECONDS ?? 15),
    heartbeatEveryMinutes: Number(process.env.FOOTBALL_HEARTBEAT_MINUTES ?? 5),
  };
}

export class LiveAdapter implements EventSource {
  private readonly cfg: LiveAdapterConfig;
  /** Provider player id -> Whistle player id. Built when the line-ups load. */
  private readonly idMap = new Map<number, number>();
  /** Provider team id -> 0 (home) or 1 (away). */
  private readonly teamMap = new Map<number, 0 | 1>();

  constructor(cfg: LiveAdapterConfig = configFromEnv()) {
    this.cfg = cfg;
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`https://${this.cfg.apiHost}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url, {
      headers: { "x-apisports-key": this.cfg.apiKey, "x-apisports-host": this.cfg.apiHost },
    });
    if (!res.ok) throw new Error(`${path} failed: ${res.status} ${res.statusText}`);

    const body = (await res.json()) as { response: T; errors?: unknown };
    if (body.errors && Object.keys(body.errors).length > 0) {
      throw new Error(`${path} returned errors: ${JSON.stringify(body.errors)}`);
    }
    return body.response;
  }

  /**
   * Line-ups become the squad. Expected-points priors are NOT available from the
   * feed — position is the only signal here, so these are the same crude priors the
   * fixture files use, and a production build would want a real model.
   */
  async loadFixture(): Promise<Fixture> {
    const lineups = await this.get<ApiLineup[]>("fixtures/lineups", {
      fixture: String(this.cfg.providerFixtureId),
    });
    if (lineups.length < 2) throw new Error("line-ups are not published yet");

    const players: PlayerConfig[] = [];
    let nextId = 0;

    lineups.slice(0, 2).forEach((lineup, index) => {
      const team = (index === 0 ? 0 : 1) as 0 | 1;
      this.teamMap.set(lineup.team.id, team);

      const add = (entry: ApiPlayer, starter: boolean): void => {
        const position = mapPosition(entry.player.pos);
        const id = nextId++;
        this.idMap.set(entry.player.id, id);
        players.push({
          id,
          name: entry.player.name,
          team,
          position,
          starter,
          expectedEventPoints: priorFor(position, starter),
          expectedMinutes: starter ? 90 : 25,
          cleanSheetProb0:
            position === Position.GK || position === Position.DEF ? toWad("0.30") : 0n,
        });
      };

      for (const p of lineup.startXI) add(p, true);
      for (const p of lineup.substitutes) add(p, false);
    });

    return {
      fixtureId: this.cfg.fixtureId,
      metadata: {
        homeTeam: lineups[0]?.team.name ?? "home",
        awayTeam: lineups[1]?.team.name ?? "away",
        source: `api-football fixture ${this.cfg.providerFixtureId}`,
      },
      players,
      events: [],
    };
  }

  /**
   * Poll the provider and yield anything new, in clock order. Heartbeats are
   * synthesised so the match clock keeps advancing through quiet spells — the pot
   * needs a clock advance to reprice, and a real feed does not send one.
   */
  async *stream(): AsyncIterable<MatchEvent> {
    const seen = new Set<string>();
    let lastEmittedMinute = 0;

    for (;;) {
      const events = await this.get<ApiEvent[]>("fixtures/events", {
        fixture: String(this.cfg.providerFixtureId),
      });

      const mapped = events
        .map((e) => this.mapEvent(e))
        .filter((e): e is { key: string; event: MatchEvent } => e !== null)
        .filter((e) => !seen.has(e.key))
        .sort((a, b) => a.event.minute - b.event.minute);

      for (const { key, event } of mapped) {
        // Fill the gap with heartbeats so no more than N minutes pass unmarked.
        while (event.minute - lastEmittedMinute > this.cfg.heartbeatEveryMinutes) {
          lastEmittedMinute += this.cfg.heartbeatEveryMinutes;
          yield { minute: lastEmittedMinute, type: EventType.HEARTBEAT, players: [] };
        }

        seen.add(key);
        lastEmittedMinute = Math.max(lastEmittedMinute, event.minute);
        yield event;
      }

      await sleep(this.cfg.pollSeconds * 1000);
    }
  }

  private mapEvent(e: ApiEvent): { key: string; event: MatchEvent } | null {
    const minute = e.time.elapsed + (e.time.extra ?? 0);
    const key = `${minute}:${e.type}:${e.detail}:${e.player.id ?? "?"}`;

    const whistleId = (providerId: number | null): number | undefined =>
      providerId === null ? undefined : this.idMap.get(providerId);

    const primary = whistleId(e.player.id);

    if (e.type === "Goal") {
      if (primary === undefined) return null;
      const assist = whistleId(e.assist.id);
      const players = assist === undefined ? [primary] : [primary, assist];
      return { key, event: { minute, type: EventType.GOAL, players, note: e.detail } };
    }

    if (e.type === "Card") {
      if (primary === undefined) return null;
      const type = e.detail === "Red Card" ? EventType.RED : EventType.YELLOW;
      return { key, event: { minute, type, players: [primary], note: e.detail } };
    }

    if (e.type === "subst") {
      // api-football puts the player coming OFF in `player` and the one coming ON
      // in `assist`. Whistle's SUB takes [off, on], so the order is preserved.
      const on = whistleId(e.assist.id);
      if (primary === undefined || on === undefined) return null;
      return { key, event: { minute, type: EventType.SUB, players: [primary, on], note: e.detail } };
    }

    return null;
  }
}

function mapPosition(pos: string | null | undefined): Position {
  switch ((pos ?? "M").toUpperCase()) {
    case "G":
      return Position.GK;
    case "D":
      return Position.DEF;
    case "F":
      return Position.FWD;
    default:
      return Position.MID;
  }
}

function priorFor(position: Position, starter: boolean): bigint {
  const base =
    position === Position.FWD
      ? "3.0"
      : position === Position.MID
        ? "2.0"
        : position === Position.DEF
          ? "1.0"
          : "0.5";
  const wad = toWad(base);
  return starter ? wad : wad / 2n;
}

export { EVENT_TYPE_BY_NAME, POSITION_BY_NAME };
