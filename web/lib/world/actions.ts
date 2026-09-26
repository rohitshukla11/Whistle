/**
 * The protected actions, run server-side after a verified World ID callback —
 * server only. With NEXT_PUBLIC_WORLD_IDP=on the browser never performs these.
 *
 * The rule: increasing an agent's authority needs a fresh World ID proof;
 * decreasing it never does. So exactly two things come through here:
 *
 *   create-agent  assign a managed key, createAgent with the operator key, then
 *                 bind the human: `human.agent-N` = keccak256(iss ‖ sub) on
 *                 tokyo.whistle.eth (see scripts/setup-human-resolver.ts for why
 *                 it is not on the agent's own resolver).
 *   raise-cap     write a higher spend-cap — including from 0, which is Resume.
 *                 The new cap is in the pending action; with none given, Resume
 *                 restores the cap the pause zeroed.
 *
 * Pause, lowering the cap and revoke are plain wallet transactions, never here.
 * A raise requires the verified human to match the agent's bound human when it
 * has one; an agent created before World ID is bound on its first raise.
 */

import {
  concat,
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  toBytes,
  zeroAddress,
  type Account,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { namehash } from "viem/ens";
import { sepolia } from "viem/chains";

import { agentRegistryAbi } from "../../vendor/oracle/abi";
import { assignManagedKey } from "../sim/assign";
import { resolveFixture, type SimDeployment } from "../sim/deployment";
import { publicClient, walletFor } from "../sim/server";
import type { Human } from "./flow";
import type { Pending } from "./store";

/** The most any single raise may set: a typo guard, not a policy. */
const MAX_CAP_USDC = 1_000_000n;

const resolverAbi = parseAbi([
  "function setText(bytes name, string key, string value)",
  "function text(bytes32 node, string key) view returns (string)",
  "function resolve(bytes name, bytes data) view returns (bytes)",
]);
const rootRegistryAbi = parseAbi(["function getResolver(string label) view returns (address)"]);
const TEXT_UPDATED = parseAbiItem("event TextUpdated(uint256 indexed recordId, string indexed keyHash, string key, string value)");

export const dnsEncode = (name: string): Hex =>
  `0x${name.split(".").map((l) => Buffer.from([l.length]).toString("hex") + Buffer.from(l).toString("hex")).join("")}00` as Hex;

export const humanValue = (h: Pick<Human, "iss" | "sub">): Hex => keccak256(concat([toBytes(h.iss), toBytes(h.sub)]));

function operator(): Account {
  const k = process.env.SIM_OPERATOR_KEY;
  if (!k) throw new Error("SIM_OPERATOR_KEY is not set on the server.");
  return privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as Hex);
}

function logsClient(): PublicClient {
  const url = process.env.NEXT_PUBLIC_LOGS_RPC_URL ?? process.env.SIM_RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL;
  return createPublicClient({ chain: sepolia, transport: http(url, { timeout: 20_000, retryCount: 3 }) }) as PublicClient;
}

async function send(pc: PublicClient, account: Account, req: Record<string, unknown>): Promise<Hash> {
  const sim = (await pc.simulateContract({ ...req, account } as never)) as { request: Record<string, unknown> };
  const hash = await walletFor(account).writeContract({ ...sim.request, chain: null } as never);
  const rc = await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (rc.status !== "success") throw new Error(`transaction reverted: ${hash}`);
  return hash;
}

// ------------------------------------------------------------ human record

interface AgentRow {
  user: Address;
  registry: Address;
  resolver: Address;
  fixtureId: bigint;
  spent: bigint;
  fqdn: string;
}

async function agentRow(pc: PublicClient, D: SimDeployment, agent: Address): Promise<AgentRow> {
  const info = (await pc.readContract({ address: D.agentRegistry, abi: agentRegistryAbi, functionName: "agentInfo", args: [agent] })) as readonly unknown[];
  if (info[1] === zeroAddress) throw new Error("unknown agent");
  return { user: info[0] as Address, registry: info[1] as Address, resolver: info[2] as Address, fixtureId: info[4] as bigint, spent: info[6] as bigint, fqdn: info[7] as string };
}

/** The user's name (e.g. tokyo.whistle.eth) and its resolver, from the agent's fqdn. */
async function userName(pc: PublicClient, D: SimDeployment, fqdn: string): Promise<{ name: string; label: string; resolver: Address; key: string }> {
  const [agentLabel, userLabel] = fqdn.split(".") as [string, string];
  const root = (D as unknown as { rootRegistry?: Address }).rootRegistry;
  if (!root) throw new Error("deployment has no rootRegistry");
  const resolver = await pc.readContract({ address: root, abi: rootRegistryAbi, functionName: "getResolver", args: [userLabel] });
  return { name: fqdn.split(".").slice(1).join("."), label: userLabel, resolver, key: `human.${agentLabel}` };
}

export async function readHuman(pc: PublicClient, D: SimDeployment, fqdn: string): Promise<string> {
  const u = await userName(pc, D, fqdn);
  try {
    const data = encodeFunctionData({ abi: resolverAbi, functionName: "text", args: [namehash(u.name), u.key] });
    const out = await pc.readContract({ address: u.resolver, abi: resolverAbi, functionName: "resolve", args: [dnsEncode(u.name), data] });
    return decodeFunctionResult({ abi: resolverAbi, functionName: "text", data: out as Hex }) as string;
  } catch {
    return "";
  }
}

async function writeHuman(pc: PublicClient, D: SimDeployment, fqdn: string, value: Hex): Promise<Hash> {
  const u = await userName(pc, D, fqdn);
  return send(pc, operator(), { address: u.resolver, abi: resolverAbi, functionName: "setText", args: [dnsEncode(u.name), u.key, value] });
}

/** The verified human must be this agent's human; an unbound agent is bound now. */
async function requireSameHuman(pc: PublicClient, D: SimDeployment, fqdn: string, human: Human): Promise<{ bound: boolean }> {
  const want = humanValue(human);
  const have = await readHuman(pc, D, fqdn);
  if (have && have.toLowerCase() !== want.toLowerCase()) throw new Error("this agent is bound to a different World ID");
  if (!have) {
    await writeHuman(pc, D, fqdn, want);
    return { bound: true };
  }
  return { bound: false };
}

export async function readAgentText(pc: PublicClient, fqdn: string, resolver: Address, key: string): Promise<string> {
  const data = encodeFunctionData({ abi: resolverAbi, functionName: "text", args: [namehash(fqdn), key] });
  const out = await pc.readContract({ address: resolver, abi: resolverAbi, functionName: "resolve", args: [dnsEncode(fqdn), data] });
  return decodeFunctionResult({ abi: resolverAbi, functionName: "text", data: out as Hex }) as string;
}

// ---------------------------------------------------------------- actions

function fixtureOf(payload: Record<string, unknown>): SimDeployment {
  const D = resolveFixture(payload.fixtureId);
  if (!D) throw new Error(`unknown fixture ${String(payload.fixtureId)}`);
  return D;
}

async function createAgentAction(p: Pending, human: Human): Promise<Record<string, unknown>> {
  const D = fixtureOf(p.payload);
  const pc = publicClient();
  const op = operator();
  const templateId = BigInt(Number(p.payload.templateId));
  const capUSDC = BigInt(Math.floor(Number(p.payload.capUSDC)));
  const slippageBps = BigInt(Math.round(Number(p.payload.slippageBps)));
  const hours = Number(p.payload.hours ?? 6);
  if (![1n, 2n, 3n].includes(templateId)) throw new Error("bad template");
  if (capUSDC <= 0n || capUSDC > 1_000_000n) throw new Error("cap out of range");
  if (slippageBps < 0n || slippageBps > 5_000n) throw new Error("max move out of range");
  if (!(hours > 0 && hours <= 24)) throw new Error("duration out of range");

  const assigned = await assignManagedKey(D, pc);
  const hash = await send(pc, op, {
    address: D.agentRegistry, abi: agentRegistryAbi, functionName: "createAgent",
    args: [{
      user: op.address, agent: assigned.address, fixtureId: BigInt(D.fixtureId), templateId,
      spendCapUSDC: capUSDC * 1_000_000n, slippageBps,
      expiry: BigInt(Math.floor(Date.now() / 1000 + hours * 3600)),
      salt: BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`),
    }],
  });
  const row = await agentRow(pc, D, assigned.address as Address);
  const humanHash = await writeHuman(pc, D, row.fqdn, humanValue(human));
  return { agent: assigned.address, fqdn: row.fqdn, createHash: hash, humanHash, human: "human-backed · World ID" };
}

/** The last non-zero spend-cap this agent's resolver ever held, from its own events. */
async function capBeforePause(D: SimDeployment, resolver: Address): Promise<bigint | null> {
  const lc = logsClient();
  const head = await lc.getBlockNumber();
  const from = BigInt((D as unknown as { deployBlock?: number }).deployBlock ?? 0);
  let last: bigint | null = null;
  for (let a = from; a <= head; a += 5_000n) {
    const b = a + 4_999n > head ? head : a + 4_999n;
    const logs = await lc.getLogs({ address: resolver, event: TEXT_UPDATED, fromBlock: a, toBlock: b });
    for (const l of logs) {
      if (l.args.key === "spend-cap" && /^\d+$/.test(l.args.value ?? "") && BigInt(l.args.value!) > 0n) last = BigInt(l.args.value!);
    }
  }
  return last;
}

/**
 * What a raise would set, checked before the human is asked and again after:
 * it must be an increase, on an agent Whistle holds the user role for.
 */
export async function planRaise(
  payload: Record<string, unknown>,
  { resolveResume = true } = {},
): Promise<{ D: SimDeployment; row: AgentRow; current: bigint; next: bigint }> {
  const D = fixtureOf(payload);
  const pc = publicClient();
  const agent = payload.agent as Address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(agent))) throw new Error("bad agent address");
  const row = await agentRow(pc, D, agent);
  if (row.user.toLowerCase() !== operator().address.toLowerCase()) throw new Error("Whistle holds the user role only for its own agents");
  const text = await readAgentText(pc, row.fqdn, row.resolver, "spend-cap");
  const current = /^\d+$/.test(text) ? BigInt(text) : 0n;
  let next: bigint;
  if (payload.capUSDC === undefined || payload.capUSDC === null || payload.capUSDC === "") {
    if (current !== 0n) throw new Error("give the new cap");
    // Before the human is asked it is enough to know this is a resume; which cap
    // comes back is worked out when it happens.
    if (!resolveResume) return { D, row, current, next: 1n };
    // Resume: the cap the pause zeroed. A log scan the endpoint refuses (a fork
    // forwarding old ranges upstream) falls back to the seeded cap.
    const scanned = await capBeforePause(D, row.resolver).catch((err: unknown) => {
      console.warn(`[world] could not scan ${row.fqdn}'s cap history, using the seeded cap: ${String(err).split("\n")[0]!.slice(0, 120)}`);
      return null;
    });
    const seeded = (D as unknown as { agentCapUSDC?: string }).agentCapUSDC;
    next = scanned ?? (seeded ? BigInt(seeded) * 1_000_000n : 2_000n * 1_000_000n);
  } else {
    const usdc = Number(payload.capUSDC);
    if (!Number.isFinite(usdc) || usdc <= 0) throw new Error("the new cap must be a positive number of USDC");
    next = BigInt(Math.round(usdc * 1e6));
  }
  if (next > MAX_CAP_USDC * 1_000_000n) throw new Error("cap out of range");
  if (next <= current) throw new Error("that is not an increase — lowering a cap needs no verification, do it directly");
  return { D, row, current, next };
}

async function raiseCapAction(p: Pending, human: Human): Promise<Record<string, unknown>> {
  // Re-read now: the chain may have moved while the human was verifying.
  const { D, row, current, next } = await planRaise(p.payload);
  const pc = publicClient();
  const bind = await requireSameHuman(pc, D, row.fqdn, human);
  const hash = await send(pc, operator(), {
    address: row.resolver, abi: resolverAbi, functionName: "setText", args: [dnsEncode(row.fqdn), "spend-cap", next.toString()],
  });
  return { agent: p.payload.agent, fqdn: row.fqdn, capFrom: current.toString(), capTo: next.toString(), resumed: current === 0n, hash, boundNow: bind.bound };
}

/**
 * One protected action at a time. They all sign with the operator key, and two
 * approvals landing together (a create and a raise, say) would otherwise race
 * for the same nonce and one would fail after its human had already approved it.
 */
const queue = globalThis as unknown as { __whistleWorldQueue?: Promise<unknown> };
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = (queue.__whistleWorldQueue ?? Promise.resolve()).catch(() => undefined).then(fn);
  queue.__whistleWorldQueue = next.catch(() => undefined);
  return next;
}

export async function runAction(p: Pending, human: Human): Promise<Record<string, unknown>> {
  return serial(() => {
    if (p.action === "create-agent") return createAgentAction(p, human);
    if (p.action === "raise-cap") return raiseCapAction(p, human);
    throw new Error(`unknown action ${String(p.action)}`);
  });
}
