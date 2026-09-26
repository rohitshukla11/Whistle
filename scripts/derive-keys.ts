/**
 * Derive Whistle's seven service signers from the single owner key.
 *
 *   npx tsx scripts/derive-keys.ts            # prints addresses, writes .secrets/derived.json
 *   npx tsx scripts/derive-keys.ts --check    # prints addresses only, writes nothing
 *
 * Two derivations, both `keccak256(ownerKey ‖ tag)` over the owner key's 32 raw
 * bytes and the tag's UTF-8 bytes:
 *
 *   - service roles:     tag `whistle:<role>`                 (service, A-1..3)
 *   - fixture agents:  tag `whistle:agent:<fixtureId>:<n>`  (demos n = 1..6, A n = 4..6)
 *
 * Agents 1..3 get their mandates from the seed. Agents 4..6 are the managed pool:
 * no mandate, no funds, until the New agent form asks `/api/agents/assign` for
 * one. The route picks the lowest unregistered one, funds it, marks it
 * `assigned` here, and the step runner starts driving it. Pre-derived rather than
 * derived on demand, so the owner key never has to reach the web server.
 *
 * So the whole system is recoverable from one secret, and there are no
 * independent accounts to lose. `.secrets/derived.json` also carries a
 * `fixtures` map — fixture id → its three agent keys — which is how the step
 * route and `replay --single-signer` pick agents by the fixture in the request,
 * without anything in `.env` changing between presentations.
 *
 * That is also the trade to be clear about: anyone holding the owner key holds
 * all seven. This is a demo deployment's key plan, not a production one.
 *
 * Only addresses are ever printed. The keys go to `.secrets/derived.json`
 * (gitignored, mode 0600) and nowhere else.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { concat, keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** secp256k1 group order; a derived scalar must be in [1, n-1]. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The single owner of every admin field. The script refuses any other key. */
export const OWNER = "0x68343Aa0598b7FCAA102769D172e59cdDfae10f2";

/**
 * The seven roles, in a fixed order.
 *
 * `service` is the oracle AND the keeper — one key, so the step route and
 * `replay --single-signer` serialise every write through one nonce sequence.
 * `A-*` are fixture A's three agents (today's rehearsal); `C-*` fixture C's
 * (tomorrow's demo). Agents cannot be shared across fixtures: `createAgent`
 * reverts `AgentAddressInUse` for an address that has ever held a mandate.
 */
export const ROLES = ["service", "A-1", "A-2", "A-3", "C-1", "C-2", "C-3"] as const;
export type Role = (typeof ROLES)[number];

/**
 * `C-1..3` were the first plan's single demo fixture. The plan became seven demo
 * fixtures before any of them was deployed, so these three were funded and never
 * used. They are still derived so `sweep` can return their ETH.
 */
export const LEGACY_ROLES = new Set<Role>(["C-1", "C-2", "C-3"]);

/** Fixture A: today's rehearsal, played to full time, then the settled showcase. */
export const FIXTURE_A = "20260926";

/**
 * The seven demo fixtures, in presentation order. One per presentation, so a
 * used one is never re-used. Ids read as `2026-09-27, demo NN`.
 */
export const DEMO_FIXTURES = [
  "2026092701", "2026092702", "2026092703", "2026092704", "2026092705", "2026092706", "2026092707",
] as const;

/** Agents per fixture: 1..3 pre-created by the seed, 4..6 the managed pool for live creation. */
export const AGENTS_PER_FIXTURE = 6;
export const PREMADE_AGENTS = 3;

/** `keccak256(ownerKey ‖ "whistle:agent:<fixtureId>:<n>")`. */
export function deriveAgentKey(ownerKey: Hex, fixtureId: string, n: number): Hex {
  const key = keccak256(concat([toBytes(ownerKey), toBytes(`whistle:agent:${fixtureId}:${n}`)]));
  const k = BigInt(key);
  if (k === 0n || k >= N) throw new Error(`derived agent key ${fixtureId}:${n} is out of range`);
  return key;
}

export function deriveKey(ownerKey: Hex, role: Role): Hex {
  const key = keccak256(concat([toBytes(ownerKey), toBytes(`whistle:${role}`)]));
  const k = BigInt(key);
  // Astronomically unlikely, but a key outside the curve order is not a key.
  if (k === 0n || k >= N) throw new Error(`derived key for ${role} is out of range`);
  return key;
}

function readOwnerKey(): Hex {
  const envPath = resolve(import.meta.dirname ?? ".", "..", ".env");
  const vars = new Map<string, string>();
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) vars.set(m[1]!, m[2]!.trim().replace(/^["']|["']$/g, ""));
    }
  }
  const raw = process.env.OWNER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? vars.get("DEPLOYER_PRIVATE_KEY");
  if (!raw) throw new Error("No owner key: set DEPLOYER_PRIVATE_KEY (the key for 0x6834…).");
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  const addr = privateKeyToAccount(key).address;
  if (addr.toLowerCase() !== OWNER.toLowerCase()) {
    throw new Error(`The owner key derives to ${addr}, not ${OWNER}. Refusing.`);
  }
  return key;
}

function main(): void {
  const check = process.argv.includes("--check");
  const owner = readOwnerKey();

  const derived = ROLES.map((role) => {
    const key = deriveKey(owner, role);
    return { role, address: privateKeyToAccount(key).address, key };
  });

  console.log(`owner    ${OWNER}`);
  for (const d of derived) {
    console.log(`${d.role.padEnd(8)} ${d.address}${LEGACY_ROLES.has(d.role) ? "   (legacy, unused — sweep it)" : ""}`);
  }

  // fixture id -> its agents. A keeps its A-1..3 roles for 1..3; everything else uses the fixture-scoped tag.
  const fixtures: Record<string, { n: number; address: string; key: Hex }[]> = {
    [FIXTURE_A]: (["A-1", "A-2", "A-3"] as const).map((role, i) => {
      const d = derived.find((x) => x.role === role)!;
      return { n: i + 1, address: d.address, key: d.key };
    }),
  };
  const scoped = (id: string, n: number) => {
    const key = deriveAgentKey(owner, id, n);
    return { n, address: privateKeyToAccount(key).address, key };
  };
  for (let n = PREMADE_AGENTS + 1; n <= AGENTS_PER_FIXTURE; n++) fixtures[FIXTURE_A]!.push(scoped(FIXTURE_A, n));
  for (const id of DEMO_FIXTURES) {
    fixtures[id] = Array.from({ length: AGENTS_PER_FIXTURE }, (_, i) => scoped(id, i + 1));
  }
  // Keep the web server's assignments: regenerating must not hand an agent out twice.
  const outFile = resolve(import.meta.dirname ?? ".", "..", ".secrets", "derived.json");
  if (existsSync(outFile)) {
    const prior = (JSON.parse(readFileSync(outFile, "utf8")) as { fixtures?: typeof fixtures }).fixtures ?? {};
    for (const [id, agents] of Object.entries(fixtures)) {
      for (const a of agents) {
        const was = prior[id]?.find((p) => p.address === a.address) as { assigned?: string } | undefined;
        if (was?.assigned) (a as { assigned?: string }).assigned = was.assigned;
      }
    }
  }
  console.log("");
  for (const [id, agents] of Object.entries(fixtures)) {
    console.log(`fixture ${id.padEnd(10)} ${agents.map((a) => a.address).join("  ")}`);
  }
  const fixtureCount = DEMO_FIXTURES.length + 1;
  console.log(
    `\n${1 + fixtureCount * PREMADE_AGENTS} active derived signers (service + ${fixtureCount} fixtures x ${PREMADE_AGENTS}), ` +
      `${fixtureCount * (AGENTS_PER_FIXTURE - PREMADE_AGENTS)} in the managed pool (unfunded until assigned), ` +
      `plus ${LEGACY_ROLES.size} legacy`,
  );

  if (check) return;

  const dir = resolve(import.meta.dirname ?? ".", "..", ".secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = resolve(dir, "derived.json");
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        owner: OWNER,
        scheme: 'keccak256(ownerKey || "whistle:<role>")',
        signers: Object.fromEntries(derived.map((d) => [d.role, { address: d.address, key: d.key }])),
        agentScheme: 'keccak256(ownerKey || "whistle:agent:<fixtureId>:<n>")',
        fixtures,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(out, 0o600);
  console.log(`\nwrote ${out} (0600, gitignored) — addresses above, keys only in the file`);
}

// Run only when invoked directly. `sweep.ts` and `verify-ownership.ts` import
// the constants above; importing used to run main() and rewrite derived.json.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
