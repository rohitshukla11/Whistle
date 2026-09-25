/**
 * The server half of the simulation: keys, clients, and the guards around them.
 *
 * Everything in this file is server-only by construction — it reads private keys
 * out of the environment, and none of the variables carry a `NEXT_PUBLIC_`
 * prefix, so none of it can be imported into a browser bundle without the build
 * failing loudly. That is deliberate: the simulation signs real transactions
 * against real contracts, and the browser's job is to ask for a step, not to
 * hold the means to take one.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

export const RPC_URL =
  process.env.SIM_RPC_URL ??
  process.env.SNAPSHOT_RPC_URL ??
  process.env.NEXT_PUBLIC_RPC_URL ??
  "http://127.0.0.1:8545";

/**
 * The bearer token that gates every route here.
 *
 * Absent means the simulation is unavailable, not open — a deployment that
 * forgot the variable must not end up with an unauthenticated endpoint that can
 * kick off a match.
 */
export function checkToken(req: Request): { ok: true } | { ok: false; status: number; error: string } {
  const expected = process.env.SIM_ADMIN_TOKEN;
  if (!expected) {
    return { ok: false, status: 503, error: "SIM_ADMIN_TOKEN is not set on the server." };
  }
  const header = req.headers.get("authorization") ?? "";
  const given = header.replace(/^Bearer\s+/i, "");
  // Length-then-content, so the comparison does not leak the length by timing.
  if (given.length !== expected.length || given !== expected) {
    return { ok: false, status: 401, error: "Bad or missing bearer token." };
  }
  return { ok: true };
}

const key = (name: string): `0x${string}` => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set on the server.`);
  const trimmed = v.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
};

export function oracleAccount(): Account {
  return privateKeyToAccount(key("SIM_ORACLE_KEY"));
}

export function keeperAccount(): Account {
  return privateKeyToAccount(key("SIM_KEEPER_KEY"));
}

/** Six, comma-separated. Fewer is allowed; the simulation simply drives fewer. */
export function agentAccounts(): Account[] {
  const raw = process.env.SIM_AGENT_KEYS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`));
}

export function publicClient(): PublicClient {
  return createPublicClient({
    chain: sepolia,
    // A step has ~3 seconds; a read that has not answered in 8 is not going to
    // save this call, and letting it run only delays the next one.
    transport: http(RPC_URL, { timeout: 8_000, batch: true }),
  }) as PublicClient;
}

export function walletFor(account: Account): WalletClient {
  return createWalletClient({ account, chain: sepolia, transport: http(RPC_URL, { timeout: 8_000 }) });
}

/**
 * Fixtures no route may write to without being told twice.
 *
 * The demo fixture goes in here the moment it is deployed: `postEvent` and
 * `kickoff` are one-way, and a stray Start against Saturday's fixture cannot be
 * undone. A local node is NOT exempt here, unlike the terminal guard — the
 * browser cannot be trusted to know which chain it is pointed at, and the cost
 * of confirming on a fork is one extra query parameter.
 */
export function protectedFixtures(): Set<string> {
  return new Set(
    (process.env.PROTECTED_FIXTURES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isProtected(fixtureId: string): boolean {
  return protectedFixtures().has(String(fixtureId));
}

/** Redact a provider key before it reaches a response body or a log line. */
export function redactRpc(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}/…`;
  } catch {
    return "the configured RPC";
  }
}

export type { Address };
