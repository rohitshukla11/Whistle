/** Loading and validating a fixture file. */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  EVENT_TYPE_BY_NAME,
  EventType,
  POSITION_BY_NAME,
  toWad,
  type Fixture,
  type FixtureJson,
  type MatchEvent,
  type PlayerConfig,
} from "./types.js";

export async function loadFixture(path: string): Promise<Fixture> {
  const raw = await readFile(resolve(path), "utf8");
  const json = JSON.parse(raw) as FixtureJson;

  if (json.schema !== "whistle.fixture/1") {
    throw new Error(`unsupported fixture schema: ${json.schema}`);
  }

  const players: PlayerConfig[] = json.players.map((p) => {
    const position = POSITION_BY_NAME[p.position];
    if (position === undefined) throw new Error(`unknown position ${p.position} for ${p.name}`);
    return {
      id: p.id,
      name: p.name,
      team: p.team,
      position,
      starter: p.starter,
      expectedEventPoints: toWad(p.expectedEventPoints),
      expectedMinutes: p.expectedMinutes,
      cleanSheetProb0: toWad(p.cleanSheetProb0),
    };
  });

  const events: MatchEvent[] = json.events.map((e) => {
    const type = EVENT_TYPE_BY_NAME[e.type];
    if (type === undefined) throw new Error(`unknown event type ${e.type} at minute ${e.minute}`);
    return { minute: e.minute, type, players: e.players, ...(e.note ? { note: e.note } : {}) };
  });

  validate(players, events);

  return {
    fixtureId: BigInt(json.fixtureId),
    metadata: json.metadata,
    players,
    events,
  };
}

/**
 * Catch in the loader what would otherwise be a revert three transactions into a
 * live replay. Everything here mirrors a guard in `MatchOracle`.
 */
function validate(players: PlayerConfig[], events: MatchEvent[]): void {
  const ids = new Set<number>();
  for (const p of players) {
    if (ids.has(p.id)) throw new Error(`duplicate player id ${p.id}`);
    ids.add(p.id);
  }
  for (let i = 0; i < players.length; i++) {
    if (!ids.has(i)) throw new Error(`player ids must be contiguous from 0; ${i} is missing`);
  }

  let clock = 0;
  for (const e of events) {
    if (e.minute < clock) {
      throw new Error(`events must be in clock order: ${e.minute} follows ${clock}`);
    }
    clock = e.minute;

    for (const id of e.players) {
      if (!ids.has(id)) throw new Error(`event at ${e.minute} references unknown player ${id}`);
    }

    const expected =
      e.type === EventType.HEARTBEAT ? 0 : e.type === EventType.SUB ? 2 : e.type === EventType.GOAL ? -1 : 1;
    if (expected >= 0 && e.players.length !== expected) {
      throw new Error(`event ${EventType[e.type]} at ${e.minute} needs ${expected} players`);
    }
    if (e.type === EventType.GOAL && (e.players.length < 1 || e.players.length > 2)) {
      throw new Error(`GOAL at ${e.minute} needs a scorer and an optional assist`);
    }
  }
}
