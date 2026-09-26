/**
 * Flatten a fixture file into the shape a Foundry script can read.
 *
 * `vm.parseJson` handles arrays of primitives cleanly and structs-of-strings
 * badly, and Solidity cannot parse a decimal like "3.0" at all. So the deploy
 * script reads flat, integer-only arrays emitted here rather than the human file
 * directly — the human file stays the single source of truth, and this is only a
 * projection of it.
 *
 *   pnpm tsx scripts/compile-fixture.ts fixtures/che-bar-2009-05-06.json
 *
 * Writes `<input>.deploy.json` next to the input.
 */

import { writeFile } from "node:fs/promises";

import { loadFixture } from "../oracle/fixture.js";
import { deriveFinalScores } from "../oracle/scoring.js";

async function main(): Promise<void> {
  const input = process.argv[2] ?? "fixtures/che-bar-2009-05-06.json";
  const fixture = await loadFixture(input);
  const derived = deriveFinalScores(fixture.players, fixture.events);

  const out = {
    fixtureId: fixture.fixtureId.toString(),
    playerCount: fixture.players.length,

    names: fixture.players.map((p) => p.name),
    // Short, unique, and legible in a wallet: WP<id> plus the surname's initials.
    symbols: fixture.players.map((p) => `W${p.id}${initials(p.name)}`),
    teams: fixture.players.map((p) => p.team),
    positions: fixture.players.map((p) => p.position),
    starters: fixture.players.map((p) => p.starter),
    expectedEventPoints: fixture.players.map((p) => p.expectedEventPoints.toString()),
    expectedMinutes: fixture.players.map((p) => p.expectedMinutes),
    cleanSheetProb0: fixture.players.map((p) => p.cleanSheetProb0.toString()),

    eventCount: fixture.events.length,
    eventMinutes: fixture.events.map((e) => e.minute),
    eventTypes: fixture.events.map((e) => e.type),

    finalScores: fixture.players.map((p) => (derived.finalScores[p.id] ?? 0n).toString()),
  };

  const path = input.replace(/\.json$/, ".deploy.json");
  await writeFile(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${path}  (${out.playerCount} players, ${out.eventCount} events)`);
}

function initials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 3);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
