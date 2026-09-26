/**
 * Chain wiring: clients, keys and deployed addresses.
 *
 * Addresses come from `deployments/<chain>.json` when it exists — which is what
 * step 8's deploy script writes — and otherwise from the environment, so the
 * replay can be pointed at a local anvil fork long before anything is deployed to
 * a public network.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Account,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil, sepolia } from "viem/chains";

export interface Deployment {
  chainId: number;
  matchOracle: Address;
  settlementPot: Address;
  whistleHook: Address;
  fillRouter: Address;
  mmVault: Address;
  agentRegistry: Address;
  fixtureFactory: Address;
  usdc: Address;
  /** Optional: the fixture the demo is wired for. */
  fixtureId?: string;
}

const REQUIRED: (keyof Deployment)[] = [
  "matchOracle",
  "settlementPot",
  "whistleHook",
  "fillRouter",
  "mmVault",
  "agentRegistry",
  "fixtureFactory",
  "usdc",
];

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`${name} is not set. See .env.example.`);
  return v;
}

/** Private keys are accepted with or without `0x`; viem needs the prefix. */
export function accountFromEnv(name: string): Account {
  const raw = requireEnv(name);
  const hex = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  return privateKeyToAccount(hex);
}

export function optionalAccount(name: string): Account | undefined {
  return env(name) ? accountFromEnv(name) : undefined;
}

/**
 * Which chain the addresses belong to.
 *
 * Note that a local anvil FORK of Sepolia reports chain id 11155111, not 31337 —
 * so a fork run wants `WHISTLE_CHAIN=sepolia` with `WHISTLE_RPC_URL` pointed at
 * localhost. `anvil` here means a bare, non-forked node.
 */
export function chainFromEnv(): Chain {
  const target = (env("WHISTLE_CHAIN") ?? env("WHISTLE_NETWORK") ?? "sepolia").toLowerCase();
  if (target === "anvil" || target === "local" || target === "localhost") return anvil;
  if (target === "sepolia") return sepolia;
  throw new Error(`unknown WHISTLE_CHAIN: ${target}`);
}

export function rpcUrlFor(chain: Chain): string {
  const override = env("WHISTLE_RPC_URL");
  if (override) return override;
  if (chain.id === anvil.id) return "http://127.0.0.1:8545";
  return requireEnv("SEPOLIA_RPC_URL");
}

/**
 * Every endpoint this run may use, best first.
 *
 * A demo is three minutes long and a rate-limited provider does not recover
 * inside it. `WHISTLE_RPC_URL_FALLBACK` (comma-separated) is the second and
 * third choice; `SEPOLIA_RPC_URL_INFURA` is picked up automatically because it
 * is already in every .env here and is a different provider to the primary.
 *
 * Duplicates are dropped: failing over to the endpoint that just rate-limited
 * you is not failing over.
 */
export function rpcUrlsFor(chain: Chain): string[] {
  const extra = (env("WHISTLE_RPC_URL_FALLBACK") ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const auto = chain.id === anvil.id ? [] : [env("SEPOLIA_RPC_URL_INFURA")].filter(Boolean);
  return [...new Set([rpcUrlFor(chain), ...extra, ...(auto as string[])])];
}

/**
 * How many rate-limit answers inside a minute count as "this endpoint is gone".
 *
 * Three, because one is noise and two is bad luck. The window matters as much as
 * the count: a provider that 429s twice an hour is fine, and failing away from
 * it would cost more than it saved.
 */
const RATE_LIMIT_TRIPS = Number(env("WHISTLE_RPC_TRIP_COUNT") ?? 3);
const RATE_LIMIT_WINDOW_MS = 60_000;

const RATE_LIMITED = /429|rate limit|too many requests|capacity|exceeded|Transaction creation failed/i;

/**
 * A transport that stops using an endpoint once it starts refusing.
 *
 * viem's `fallback()` retries the next endpoint on a failed request, which is
 * resilient but keeps paying the dead one first on every single call. What a
 * three-minute demo wants is for the *preferred* endpoint to move and stay
 * moved.
 *
 * So the routing is explicit: requests go to `urls[index]`, and `index` advances
 * when that endpoint has refused {@link RATE_LIMIT_TRIPS} times inside a minute.
 * A single failed request still falls through to the next endpoint immediately —
 * resilience is not deferred while the counter fills — but the threshold is what
 * decides to stop going back.
 *
 * An earlier version counted trips but left the routing to `fallback()`, so the
 * "switching to" line named an endpoint the transport was not actually
 * preferring. A log that describes something the code is not doing is worse than
 * no log.
 */
export function failoverTransport(urls: string[], timeout: number) {
  const inner = urls.map((url) => http(url, { timeout, retryCount: 1, retryDelay: 500 }));
  let index = 0;
  const trips: number[] = [];

  const refused = (from: number) => {
    const now = Date.now();
    trips.push(now);
    while (trips.length > 0 && now - trips[0]! > RATE_LIMIT_WINDOW_MS) trips.shift();
    // Only the endpoint currently in use can demote itself; a failure recorded
    // while probing a later one must not advance the pointer past a healthy
    // endpoint that has done nothing wrong.
    if (from === index && trips.length >= RATE_LIMIT_TRIPS && index < urls.length - 1) {
      index += 1;
      trips.length = 0;
      console.warn(
        `  ! ${RATE_LIMIT_TRIPS} failures in a minute from ${redactRpc(urls[from]!)}; ` +
          `switching to ${redactRpc(urls[index]!)}`,
      );
    }
  };

  return custom({
    async request(args: { method: string; params?: unknown }) {
      let lastError: unknown;
      // Start at the preferred endpoint, then walk forward. One pass: a request
      // that every endpoint refuses is a real failure, not something to loop on.
      for (let hop = 0; hop < urls.length; hop += 1) {
        const at = (index + hop) % urls.length;
        try {
          return await inner[at]!({ timeout }).request(args as never);
        } catch (err) {
          lastError = err;
          if (RATE_LIMITED.test(String(err)) || /fetch failed|ECONNREFUSED|socket/i.test(String(err))) {
            refused(at);
            continue;
          }
          // A revert or a bad parameter is the chain's answer, not the
          // endpoint's fault. Trying another endpoint would get the same answer
          // more slowly.
          throw err;
        }
      }
      throw lastError;
    },
  });
}

/**
 * Load the deployment. A file under `deployments/` wins; otherwise every address
 * has to be in the environment. Failing loudly here beats a `0x0` call that
 * returns empty data three steps later.
 */
export function loadDeployment(chain: Chain): Deployment {
  // The deploy script writes `deployments/<chainId>.json`. `WHISTLE_DEPLOYMENT`
  // overrides, which is what a second fork on the same chain id needs.
  const path = resolve(env("WHISTLE_DEPLOYMENT") ?? `deployments/${chain.id}.json`);

  let candidate: Partial<Deployment> = {};
  if (existsSync(path)) {
    candidate = JSON.parse(readFileSync(path, "utf8")) as Partial<Deployment>;
  } else {
    candidate = {
      chainId: chain.id,
      matchOracle: env("MATCH_ORACLE") as Address,
      settlementPot: env("SETTLEMENT_POT") as Address,
      whistleHook: env("WHISTLE_HOOK") as Address,
      fillRouter: env("FILL_ROUTER") as Address,
      mmVault: env("MM_VAULT") as Address,
      agentRegistry: env("AGENT_REGISTRY") as Address,
      fixtureFactory: env("FIXTURE_FACTORY") as Address,
      usdc: env("WHISTLE_USDC") as Address,
    };
  }

  const missing = REQUIRED.filter((k) => !candidate[k]);
  if (missing.length > 0) {
    throw new Error(
      `deployment is incomplete: missing ${missing.join(", ")} (looked in ${path}).\n` +
        `Either write deployments/${chain.id}.json or set the matching env vars ` +
        `(MATCH_ORACLE, SETTLEMENT_POT, WHISTLE_HOOK, FILL_ROUTER, MM_VAULT, AGENT_REGISTRY, ` +
        `FIXTURE_FACTORY, WHISTLE_USDC).`,
    );
  }

  return { ...(candidate as Deployment), chainId: chain.id };
}

/**
 * How long to let a single RPC call take.
 *
 * viem's ten-second default is generous against a hosted endpoint and far too
 * tight against a fork: anvil executes a transaction by fetching every storage
 * slot it touches from upstream, so the first write to a cold contract can sit
 * there for half a minute through no fault of its own. A rehearsal died mid
 * warm-up on `postEvent` with "The request took too long to respond", which reads
 * like a broken contract and is really just a cold cache.
 */
function rpcTimeout(rpcUrl: string): number {
  const override = env("WHISTLE_RPC_TIMEOUT_MS");
  if (override) return Number(override);
  return isLocalRpc(rpcUrl) ? 120_000 : 30_000;
}

export interface Wiring {
  chain: Chain;
  rpcUrl: string;
  publicClient: PublicClient;
  deployment: Deployment;
}

export function connect(): Wiring {
  const chain = chainFromEnv();
  const rpcUrl = rpcUrlFor(chain);
  const urls = rpcUrlsFor(chain);
  if (urls.length > 1) {
    console.log(`rpc        ${urls.map(redactRpc).join("  ->  ")}`);
  }
  const publicClient = createPublicClient({
    chain,
    transport: failoverTransport(urls, rpcTimeout(rpcUrl)),
  });
  return { chain, rpcUrl, publicClient, deployment: loadDeployment(chain) };
}

/**
 * Fixtures that must not be written to on a real network.
 *
 * `PROTECTED_FIXTURES` in `.env` is a comma-separated list of fixture ids that
 * are spoken for — the one the demo runs on, above all. A replay settles the
 * fixture it runs on and `MMVault.pot` is immutable, so a stray `pnpm replay`
 * against Saturday's fixture does not cost a rerun: it costs a new venue, six
 * fresh agent keys and about fifteen minutes of deploying, and there is no undo.
 *
 * A local node is exempt. That is the point of forking — the rehearsal has to
 * run the real commands against the real state, and a guard that blocked it
 * would only teach everyone to turn the guard off.
 */
export function protectedFixtures(): Set<string> {
  return new Set(
    (env("PROTECTED_FIXTURES") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * An RPC URL with the key taken out.
 *
 * Provider URLs carry the API key in the path, so printing one into an error puts
 * a credential into every terminal, log and pasted traceback that error reaches.
 * The host is the part that answers "which endpoint was this".
 */
export function redactRpc(rpcUrl: string): string {
  try {
    const u = new URL(rpcUrl);
    return u.pathname === "/" || u.pathname === "" ? u.host : `${u.host}/…`;
  } catch {
    return "(unparseable RPC URL)";
  }
}

export function isLocalRpc(rpcUrl: string): boolean {
  return /(^|\/\/)(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/.test(rpcUrl);
}

export function assertFixtureWritable(fixtureId: bigint | string, what: string): void {
  const id = fixtureId.toString();
  if (!protectedFixtures().has(id)) return;

  const rpcUrl = rpcUrlFor(chainFromEnv());
  if (isLocalRpc(rpcUrl)) {
    console.warn(
      `\n  ! fixture ${id} is PROTECTED, and this is a local node (${redactRpc(rpcUrl)}).\n` +
        `    Allowing ${what} against the fork. Nothing here reaches Sepolia.\n`,
    );
    return;
  }

  /*
   * The deliberate way through, for the presentation itself.
   *
   * Every demo fixture is protected, and the fallback has to be able to run one
   * on stage without anyone editing `.env`. `--confirm <id>` sets this, and it
   * only opens the one fixture whose id it names — the same bargain as the
   * browser's confirm dialog, which also has to be asked for per fixture.
   */
  if (process.env.WHISTLE_CONFIRM_FIXTURE === id) {
    console.warn(`\n  ! fixture ${id} is PROTECTED — running ${what} because --confirm ${id} was given.\n`);
    return;
  }

  throw new Error(
    `refusing to ${what} against fixture ${id}: it is listed in PROTECTED_FIXTURES.\n` +
      `  RPC: ${redactRpc(rpcUrl)}\n` +
      `  This fixture is reserved. Replaying it settles it, and a settled fixture cannot be\n` +
      `  reopened — it needs a new pot, 36 new cards, a newly mined hook and six fresh agent\n` +
      `  keys.\n` +
      `  To rehearse, fork Sepolia and point WHISTLE_RPC_URL at the fork.\n` +
      `  To release the fixture, remove ${id} from PROTECTED_FIXTURES in .env.`,
  );
}

export function walletFor(account: Account, chain: Chain, rpcUrl: string): WalletClient {
  // Same failover as the reader: a keeper that can read but not send is no more
  // use during a demo than one that cannot do either.
  const urls = [...new Set([rpcUrl, ...rpcUrlsFor(chain).slice(1)])];
  return createWalletClient({
    account,
    chain,
    transport: failoverTransport(urls, rpcTimeout(rpcUrl)),
  });
}

// ------------------------------------------------------------------ ENS names

/**
 * DNS wire format, the encoding ENSv2 setters and `resolve()` take. Mirrors
 * `WhistleNames.dnsEncode`: each label length-prefixed, terminated by a zero byte.
 *
 * `agent-1.alice.whistle.eth`
 *   -> 0x07"agent-1"0x05"alice"0x07"whistle"0x03"eth"0x00
 */
export function dnsEncode(name: string): `0x${string}` {
  const bytes: number[] = [];
  for (const label of name.split(".")) {
    if (label.length === 0) throw new Error(`empty label in "${name}"`);
    const encoded = new TextEncoder().encode(label);
    if (encoded.length > 255) throw new Error(`label too long in "${name}"`);
    bytes.push(encoded.length, ...encoded);
  }
  bytes.push(0);
  return `0x${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Point a loaded fixture at the on-chain fixture it was deployed as.
 *
 * The fixture FILE is the match: `che-bar-2009-05-06.json` carries `20090506`,
 * the date it was played. The DEPLOYMENT says which id that match was deployed
 * under, and re-deploying the same match for a second demo gives it a new one.
 *
 * Conflating the two is quiet and costly: the replay read `20090506` from the
 * file, found that fixture already settled, and refused to start — while the
 * fixture it was meant to drive sat at PRE_MATCH under a different id.
 */
export function bindFixture<T extends { fixtureId: bigint }>(fixture: T, deployment: Deployment): T {
  if (deployment.fixtureId) fixture.fixtureId = BigInt(deployment.fixtureId);
  return fixture;
}
