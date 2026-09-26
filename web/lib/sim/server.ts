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

import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  recoverMessageAddress,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { SIM_AUTH_HEADER, SIM_SESSION_HOURS, simSessionMessage } from "./session-message";

export const RPC_URL =
  process.env.SIM_RPC_URL ??
  process.env.SNAPSHOT_RPC_URL ??
  process.env.NEXT_PUBLIC_RPC_URL ??
  "http://127.0.0.1:8545";

/**
 * Who may drive the simulation: the operator, proven by one signature.
 *
 * No shared secret. The page asks the connected wallet to sign
 * `Whistle sim · <fixtureId> · <unix minute>` once per session and sends it with
 * every call; this recovers the signer and requires it to be
 * `AgentRegistry.operator()` as the chain has it right now. A signature is
 * accepted for {@link SIM_SESSION_HOURS} hours and for the fixture it names.
 *
 * There is no way to configure this open: an unreadable operator is a refusal.
 */
const operatorCache = new Map<string, { at: number; operator: Address }>();

async function operatorOf(pc: PublicClient, registry: Address): Promise<Address> {
  const hit = operatorCache.get(registry);
  if (hit && Date.now() - hit.at < 60_000) return hit.operator;
  const operator = (await pc.readContract({
    address: registry, abi: parseAbi(["function operator() view returns (address)"]), functionName: "operator",
  })) as Address;
  operatorCache.set(registry, { at: Date.now(), operator });
  return operator;
}

export type OperatorCheck = { ok: true; signer: Address } | { ok: false; status: number; error: string };

export async function checkOperator(
  req: Request,
  D: { fixtureId: string; agentRegistry: Address },
  pc: PublicClient = publicClient(),
): Promise<OperatorCheck> {
  const raw = req.headers.get(SIM_AUTH_HEADER) ?? "";
  const [fixtureId, minuteText, signature] = raw.split(":");
  if (!fixtureId || !minuteText || !signature?.startsWith("0x")) {
    return { ok: false, status: 401, error: "Sign in as the operator first — the page asks your wallet for one signature." };
  }
  if (fixtureId !== String(D.fixtureId)) {
    return { ok: false, status: 401, error: "That sign-in was for a different fixture. Sign in again for this one." };
  }
  const minute = Number(minuteText);
  const now = Math.floor(Date.now() / 60_000);
  if (!Number.isInteger(minute) || minute > now + 5) {
    return { ok: false, status: 401, error: "That sign-in is not valid. Sign in again." };
  }
  if (now - minute > SIM_SESSION_HOURS * 60) {
    return { ok: false, status: 401, error: `Your operator sign-in is more than ${SIM_SESSION_HOURS} hours old. Sign in again.` };
  }
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message: simSessionMessage(fixtureId, minute), signature: signature as Hex });
  } catch {
    return { ok: false, status: 401, error: "That signature could not be read. Sign in again." };
  }
  let operator: Address;
  try {
    operator = await operatorOf(pc, D.agentRegistry);
  } catch {
    return { ok: false, status: 503, error: "Could not read the operator from the chain; try again in a moment." };
  }
  if (signer.toLowerCase() !== operator.toLowerCase()) {
    return {
      ok: false, status: 403,
      error: `Only the operator wallet (${operator.slice(0, 6)}…${operator.slice(-4)}) can run the simulation; you signed as ${signer.slice(0, 6)}…${signer.slice(-4)}.`,
    };
  }
  return { ok: true, signer };
}

const key = (name: string): `0x${string}` => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set on the server.`);
  const trimmed = v.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
};

/**
 * One service key, or two role keys.
 *
 * `SIM_SERVICE_KEY` set means single-signer mode: the same account posts events
 * AND runs the keeper. That is the deployment plan — one derived service key —
 * and it is safe here because a step does exactly one unit of work, and
 * {@link signerBusy} refuses to send while that account still has a
 * transaction in flight. The separate `SIM_ORACLE_KEY` / `SIM_KEEPER_KEY` pair
 * still works and is what the fork rehearsals used.
 *
 * The oracle key must be the owner of `oracle.whistle.eth`: `EnsRoleAuth`
 * grants the post-event role to that name's owner and to nobody else.
 */
export function oracleAccount(): Account {
  return privateKeyToAccount(key(process.env.SIM_SERVICE_KEY ? "SIM_SERVICE_KEY" : "SIM_ORACLE_KEY"));
}

export function keeperAccount(): Account {
  if (process.env.SIM_SERVICE_KEY) return privateKeyToAccount(key("SIM_SERVICE_KEY"));
  return privateKeyToAccount(key(process.env.SIM_KEEPER_KEY ? "SIM_KEEPER_KEY" : "SIM_ORACLE_KEY"));
}

/** True when one account signs for both the oracle and the keeper. */
export function singleSigner(): boolean {
  return oracleAccount().address.toLowerCase() === keeperAccount().address.toLowerCase();
}

/**
 * Has this account got a transaction that has not been mined yet?
 *
 * The step route never awaits inclusion, so the next step can arrive while the
 * previous one's transaction is still in the mempool. With one service key both
 * would draw from the same nonce sequence, and a load-balanced RPC whose
 * `pending` count lags by one hands out the same nonce twice — one replaces the
 * other, or both revert. Refusing to send while `pending > latest` makes the
 * single signer strictly sequential without storing anything.
 */
export async function signerBusy(pc: PublicClient, address: Address): Promise<boolean> {
  const [pending, latest] = await Promise.all([
    pc.getTransactionCount({ address, blockTag: "pending" }),
    pc.getTransactionCount({ address, blockTag: "latest" }),
  ]);
  return pending > latest;
}

/** Six, comma-separated. Fewer is allowed; the simulation simply drives fewer. */
/**
 * The fixture's own agents, chosen by the fixture id in the request.
 *
 * Every fixture has three agents of its own — `createAgent` reverts
 * `AgentAddressInUse` for an address that has ever held a mandate, so they can
 * never be shared — and there are eight fixtures. Rather than swap an env var
 * and restart between presentations, the server reads the owner-derived key
 * file (`SIM_DERIVED_FILE`, the `fixtures` map written by
 * `scripts/derive-keys.ts`) and takes the three for whichever fixture the panel
 * is driving. `SIM_AGENT_KEYS` still works, and wins, for a one-fixture setup.
 *
 * Locally the file lives in `.secrets/`. A host with no files (Vercel) takes
 * the same document inline: SIM_DERIVED_JSON, as JSON or base64 of it.
 */
interface DerivedAgent {
  n: number;
  address: string;
  key: string;
  /** Set by {@link markAssigned} when a managed-pool key is handed to the New agent form. */
  assigned?: string;
}

/** The seed pre-creates agents 1..3; 4 and up are the managed pool (see `scripts/derive-keys.ts`). */
const PREMADE_AGENTS = 3;
/**
 * Every key is driven; the chain decides which ones act. The step runner reads
 * each key's mandate first and skips a key with none on this fixture, so an
 * unassigned pool key costs one read and does nothing. This used to rely on an
 * `assigned` mark written back to the key file — which a read-only host
 * cannot write.
 */
const isActive = (_a: DerivedAgent) => true;

let inlineDerived: Record<string, DerivedAgent[]> | null = null;
function inlineFixtures(): Record<string, DerivedAgent[]> | null {
  const raw = process.env.SIM_DERIVED_JSON?.trim();
  if (!raw) return null;
  if (inlineDerived) return inlineDerived;
  const text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  inlineDerived = (JSON.parse(text) as { fixtures?: Record<string, DerivedAgent[]> }).fixtures ?? {};
  return inlineDerived;
}

let derivedCache: { mtimeMs: number; fixtures: Record<string, DerivedAgent[]> } | null = null;

function derivedFixtures(): Record<string, DerivedAgent[]> {
  const inline = inlineFixtures();
  if (inline) return inline;
  const path = process.env.SIM_DERIVED_FILE;
  if (!path) return {};
  try {
    const { mtimeMs } = statSync(path);
    if (!derivedCache || derivedCache.mtimeMs !== mtimeMs) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { fixtures?: Record<string, DerivedAgent[]> };
      derivedCache = { mtimeMs, fixtures: parsed.fixtures ?? {} };
    }
    return derivedCache.fixtures;
  } catch {
    return {};
  }
}

const toAccount = (k: string): Account =>
  privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`);

/** The agents a step drives: the pre-created three, plus managed keys already assigned. */
export function agentAccounts(fixtureId?: string): Account[] {
  const raw = process.env.SIM_AGENT_KEYS;
  if (raw) return raw.split(",").map((k) => k.trim()).filter(Boolean).map(toAccount);
  if (!fixtureId) return [];
  return (derivedFixtures()[String(fixtureId)] ?? []).filter(isActive).map((a) => toAccount(a.key));
}

/** The managed pool for a fixture, lowest n first, as accounts. Keys stay on the server. */
export function managedPool(fixtureId: string): { n: number; account: Account }[] {
  return (derivedFixtures()[String(fixtureId)] ?? [])
    .filter((a) => a.n > PREMADE_AGENTS)
    .sort((a, b) => a.n - b.n)
    .map((a) => ({ n: a.n, account: toAccount(a.key) }));
}

/**
 * Note in the local key file when a pool key was handed out. Bookkeeping only —
 * what the key may do is on chain — so a host without a writable file skips it.
 */
export function markAssigned(fixtureId: string, address: Address): void {
  const path = process.env.SIM_DERIVED_FILE;
  if (!path || process.env.SIM_DERIVED_JSON) return;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { fixtures?: Record<string, DerivedAgent[]> };
    const entry = doc.fixtures?.[String(fixtureId)]?.find((a) => a.address.toLowerCase() === address.toLowerCase());
    if (!entry) return;
    entry.assigned ??= new Date().toISOString();
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    derivedCache = null;
  } catch (err) {
    console.warn(`[sim] could not note the assignment in ${path}: ${String(err).split("\n")[0]}`);
  }
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
