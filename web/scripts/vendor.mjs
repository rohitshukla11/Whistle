/**
 * Copy the files the app shares with the rest of the repo into `web/vendor/`.
 *
 * The app reads deployment addresses and contract ABIs from the repo root, which
 * is right for local work — one source of truth, edited in one place — but means
 * `web/` on its own is not a complete project. A host that uploads only this
 * directory would fail at `import "../../oracle/abi"` during the build.
 *
 * So the build vendors them first. `vendor/` is generated and gitignored; edit
 * the originals.
 */

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const repo = resolve(web, "..");
const out = join(web, "vendor");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "deployments"), { recursive: true });
mkdirSync(join(out, "oracle"), { recursive: true });

const deployDir = join(repo, "deployments");
for (const f of readdirSync(deployDir).filter((n) => n.endsWith(".json"))) {
  cpSync(join(deployDir, f), join(out, "deployments", f));
}

/**
 * One generated index of every fixture the app can switch between.
 *
 * The list used to be two hard-coded imports in `lib/fixtures.ts`, which meant
 * deploying a new fixture silently left the app pointing at the old one — the
 * screen showed a finished match while the chain had a fresh one at PRE_MATCH.
 * Generating it from what is actually in `deployments/` removes the chance to
 * forget.
 *
 * Newest first, by fixture id; the app defaults to the first unsettled entry.
 */
let fixtures = readdirSync(deployDir)
  .filter((n) => /^fixture-\d+\.json$/.test(n))
  .map((n) => JSON.parse(readFileSync(join(deployDir, n), "utf8")))
  .sort((a, b) => Number(b.fixtureId) - Number(a.fixtureId));

/**
 * Drop fixtures that do not exist on the chain this build targets.
 *
 * `deployments/` is committed, and a rehearsal against an anvil fork writes a
 * fixture file for a venue that exists only on that fork. Left in, it reaches
 * the switcher as a real option and every read against it fails — so the file's
 * presence is not enough, the pot has to have code where the app will look.
 *
 * Skipped silently when there is no RPC to ask: a build offline should produce
 * the same list it always did rather than an empty one.
 */
const verifyRpc =
  process.env.SNAPSHOT_RPC_URL ??
  process.env.NEXT_PUBLIC_LOGS_RPC_URL ??
  process.env.NEXT_PUBLIC_RPC_URL ??
  "";
if (verifyRpc) {
  const live = [];
  for (const f of fixtures) {
    try {
      const res = await fetch(verifyRpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [f.settlementPot, "latest"],
        }),
      }).then((r) => r.json());
      if (typeof res.result === "string" && res.result.length > 2) live.push(f);
      else console.log(`fixture ${f.fixtureId}: no pot code on this chain, skipping (fork-only?)`);
    } catch {
      live.push(f); // Cannot verify: keep it rather than silently losing a real fixture.
    }
  }
  fixtures = live;
}
writeFileSync(join(out, "fixtures.json"), `${JSON.stringify(fixtures, null, 2)}\n`);
console.log(`indexed ${fixtures.length} fixtures: ${fixtures.map((f) => f.fixtureId).join(", ")}`);

/**
 * Squad metadata the chain does not carry.
 *
 * `MatchOracle` stores a player's id, position and expected points — not a shirt
 * number, and not which shape the team lined up in. Both are needed to draw a
 * pitch, and both live in the match file, so a slim projection of it is vendored
 * alongside the deployments. Only what the UI reads is copied.
 */
const match = JSON.parse(readFileSync(join(repo, "fixtures", "che-bar-2009-05-06.json"), "utf8"));
const squad = {
  fixtureId: String(match.fixtureId),
  metadata: match.metadata,
  players: match.players.map((p) => ({
    id: p.id,
    name: p.name,
    team: p.team,
    position: p.position,
    starter: p.starter === true,
    // Absent when it could not be verified — the UI renders nothing, never a guess.
    ...(typeof p.number === "number" ? { number: p.number } : {}),
  })),
};
writeFileSync(join(out, "squad.json"), `${JSON.stringify(squad, null, 2)}\n`);
const numbered = squad.players.filter((p) => p.number !== undefined).length;
console.log(`squad: ${squad.players.length} players, ${numbered} with a shirt number`);
for (const f of ["abi.ts", "tx.ts", "types.ts"]) {
  cpSync(join(repo, "oracle", f), join(out, "oracle", f));
}

console.log("vendored deployments/ and oracle/ into web/vendor");

/**
 * Freeze every SETTLED fixture's history into `public/settled/`.
 *
 * A settled fixture's logs never change, so scanning them from the browser is
 * the same answer computed again at the worst moment — `/settlement` is the last
 * screen of the demo and it measured seventy seconds of "Reading the fixture…".
 *
 * Reads the chain, so it needs an endpoint that serves a wide `eth_getLogs`
 * (Alchemy's free tier answers a ten-block range). If none is configured, or it
 * is unreachable, the build carries on and settled fixtures scan at runtime as
 * before — a snapshot is an optimisation, never a dependency.
 */
const snapshotRpc =
  process.env.SNAPSHOT_RPC_URL ??
  process.env.NEXT_PUBLIC_LOGS_RPC_URL ??
  process.env.SEPOLIA_RPC_URL_INFURA ??
  process.env.SEPOLIA_RPC_URL ??
  "";

const { writeSnapshots } = await import("./snapshot.mjs");
await writeSnapshots(snapshotRpc, fixtures, join(web, "public", "settled"));
