/**
 * Deploy and seed the seven demo fixtures, pipelined, then write the morning table.
 *
 *   npx tsx scripts/deploy-demos.ts                 # Demo 1..7 on the configured RPC
 *   npx tsx scripts/deploy-demos.ts --to 2          # Demo 1..2 (fork rehearsal)
 *   npx tsx scripts/deploy-demos.ts --report-only   # just the table
 *
 * ## Shape
 *
 * 1. **Venues**, one forge run per fixture, back to back and WITHOUT `--slow`:
 *    forge simulates, then sends every write with ordered nonces and waits once.
 *    Venues stay sequential because the router and vault are plain CREATEs from
 *    the owner — their addresses are fixed by the nonce forge simulated, so no
 *    other owner write may land between simulation and broadcast.
 * 2. **Seed, one step at a time across all fixtures.** For each seed step (ens,
 *    vault-funding, pools, wallets, agents) the step's own code runs in plan mode
 *    for every fixture (`PLAN` in oracle/tx.ts): its idempotency reads, and every
 *    write recorded with its sender instead of sent. Then all seven fixtures'
 *    writes for that step go out as ONE stream in owner-nonce order with 8 in
 *    flight — confirm the oldest, top up — so Demo 2's writes are sent while
 *    Demo 1's receipts are pending. The only waits are the true dependencies:
 *    a step's reads need the previous step mined (pools read what vault-funding
 *    minted; the agents step needs the mandates `ens` created). Agents' own
 *    approvals run beside the owner stream, each on its own nonce.
 * 3. **Check** every fixture with the seed's own `--check`, then the table.
 *
 * Gas limits are fixed ceilings, never estimates: a write estimated against
 * state an earlier, still-pending write will change is estimated wrong — that
 * is how the 65' substitution once ran out of gas. Unused gas is not charged.
 *
 * Every receipt must succeed; the first revert stops the run (except a pool
 * `initialize` on a resume, which the seed itself tolerates). A dropped
 * transaction is resent on the SAME nonce. A send the RPC never accepts stops the
 * run rather than leave a nonce gap (that gap stalled seed A for 3 minutes).
 * Rerunning resumes: every step re-plans from the chain.
 *
 * Demo seeding is stage-sized: 500 USDC mandates, and agent holdings small enough
 * to trade inside them (see `SEED_AGENT_CAP_USDC` in deploy-sepolia.ts). Only
 * agents 1..3 are seeded; 4..6 are the managed pool `/api/agents/assign` funds.
 */

import "dotenv/config";

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  fallback,
  formatEther,
  http,
  parseAbi,
  parseAbiItem,
  type Account,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { agentRegistryAbi, matchOracleAbi, whistleHookAbi } from "../oracle/abi.js";
import { DEMO_FIXTURES, FIXTURE_A, OWNER } from "./derive-keys.js";

const REPO = resolve(import.meta.dirname ?? ".", "..");
const argv = process.argv.slice(2);
const flag = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const FROM = Number(flag("--from") ?? 1);
const TO = Number(flag("--to") ?? 7);
const WINDOW = Number(process.env.WHISTLE_STREAM_WINDOW ?? 8);
const RPC = process.env.WHISTLE_RPC_URL ?? process.env.SEPOLIA_RPC_URL;
if (!RPC) throw new Error("set WHISTLE_RPC_URL or SEPOLIA_RPC_URL");
const MAX_RESUMES = 2;

/**
 * Pooled players per demo: fixture A's set — Čech, Terry, Cole, Essien, Malouda,
 * Drogba, Valdés, Puyol, Abidal, Iniesta, Messi. (Demos were first seeded with
 * six; the re-seed adds the other five.)
 */
const DEMO_TRADED = "0,2,4,5,9,10,18,19,21,25,26";
const A_TRADED = [0, 2, 4, 5, 9, 10, 18, 19, 21, 25, 26];

/** Stage-sized mandates. Read by deploy-sepolia.ts at import, so set before it loads. */
const DEMO_SEED_ENV: Record<string, string> = {
  SEED_TRADED: DEMO_TRADED,
  SEED_OWNER_SHARE: "60",
  SEED_AGENT_CAP_USDC: "500",
  SEED_AGENT_CARDS: "100,25,25",
  SEED_AGENT_USDC: "1000",
  SEED_WALLET_CARDS: "all",
  SEED_POOLED_FLOAT: "20000",
  SEED_VAULT_DEPOSIT: "5000",
  SEED_CAP_EXEMPT: "",
  SEED_OWNER_EXEMPT_ALL: "1",
  SEED_AGENT_TOPUP: "",
};

/**
 * Per-fixture departures from the stage seed. Every key of DEMO_SEED_ENV is set
 * for every fixture, so one fixture's override never leaks into the next.
 *
 * Demo 2 is the one paused live for judges, who mint for themselves: six pools
 * and a seeded vault, no owner positions (the whole float goes into the vault and
 * the owner is not a seeded wallet), and three agents at 500 USDC holding USDC
 * only.
 */
const PER_FIXTURE: Record<string, { env?: Record<string, string>; ownerWallet?: boolean }> = {
  /*
   * Demo 1 — the video run and settled showcase: owner 15% / agents 45% / vault
   * 40% of each pooled card, on a small supply so the 500 USDC mandates still bind
   * (largest protect trim ≈ 60 units ≈ 420 USDC). 550 float to the owner, 400 of
   * it deposited, 150 kept; 150 of every pooled card to each agent. The agents and
   * the managed keys 4–6 (the live-created one) are cap-exempt: at ~1,000 units a
   * card, 5% is 50, and a capped fill would revert the whole tick.
   */
  "2026092701": {
    env: {
      SEED_POOLED_FLOAT: "550", SEED_VAULT_DEPOSIT: "400", SEED_AGENT_CARDS: "150,150,150",
      SEED_CAP_EXEMPT: "@fixture-agents", // resolved in seedEnv: agents 1..6 of this fixture
    },
  },
  "2026092702": {
    env: { SEED_WALLET_CARDS: "none", SEED_AGENT_CARDS: "0,0,0", SEED_VAULT_DEPOSIT: "20000" },
    ownerWallet: false,
  },
  /*
   * Demo 3 — spare: A's pool set and vault layout, 500 USDC mandates, and agents
   * brought to ~150 units of every pooled card (the largest protect trim, 60
   * units at ~7.5, still fits the cap). Supply is ~20,000 a card, so 150 is well
   * under the 5% holder cap without exempting the agents.
   */
  "2026092703": {
    env: { SEED_AGENT_CARDS: "150,150,150", SEED_AGENT_TOPUP: "1" },
  },
  /*
   * Demo 4 — a second judges' fixture: Demo 2's layout (A's pool set, the whole
   * 20,000 float in the vault, no owner positions), with Demo 3's agents: ~150
   * of every pooled card each, inside the 500 USDC mandate. Protected.
   */
  "2026092704": {
    env: { SEED_WALLET_CARDS: "none", SEED_VAULT_DEPOSIT: "20000", SEED_AGENT_CARDS: "150,150,150", SEED_AGENT_TOPUP: "1" },
    ownerWallet: false,
  },
};

/** The seed's steps that write through `send`/`sendBatch`, in order. `gas` runs for real. */
const SEED_STEPS = ["ens", "vault-funding", "pools", "owner-exempt", "gas", "wallets", "agents"] as const;

/** Fixed ceilings by function, ~2x the maximum measured on fixture A's seed. */
const GAS: Record<string, bigint> = {
  createAgent: 3_000_000n, registerUser: 1_000_000n, seedCard: 1_500_000n, registerCard: 500_000n,
  depositCards: 300_000n, initialize: 200_000n, approve: 120_000n, setCapExempt: 150_000n,
  mintPreMatch: 600_000n, mint: 150_000n, fund: 500_000n, fundReserve: 500_000n,
};
const DEFAULT_GAS = 800_000n;

const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DerivedAgent { n: number; address: string; key: Hex; assigned?: string }
interface Derived {
  signers: Record<string, { address: string; key: Hex }>;
  fixtures: Record<string, DerivedAgent[]>;
}
const derived = JSON.parse(readFileSync(resolve(REPO, ".secrets/derived.json"), "utf8")) as Derived;
const premade = (id: string) => (derived.fixtures[id] ?? []).filter((a) => a.n <= 3);

const ownerKey = (() => {
  const raw = process.env.DEPLOYER_PRIVATE_KEY;
  if (!raw) throw new Error("DEPLOYER_PRIVATE_KEY is not set");
  const k = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (privateKeyToAccount(k).address.toLowerCase() !== OWNER.toLowerCase()) throw new Error("not the owner key");
  return k;
})();

/**
 * Reads retry harder than viem's default and fall back to a second provider: a
 * 429 on one `eth_getTransactionCount` stopped the first Demo 2–3 seed at the
 * wallets step. Sends still go to RPC only, so every nonce comes from one pool.
 */
const READ_FALLBACK = process.env.SEPOLIA_RPC_URL_INFURA && process.env.SEPOLIA_RPC_URL_INFURA !== RPC ? process.env.SEPOLIA_RPC_URL_INFURA : undefined;
const pc = createPublicClient({
  chain: sepolia,
  transport: READ_FALLBACK
    ? fallback([http(RPC, { timeout: 30_000, retryCount: 6, retryDelay: 1_500 }), http(READ_FALLBACK, { timeout: 30_000, retryCount: 6, retryDelay: 1_500 })])
    : http(RPC, { timeout: 30_000, retryCount: 8, retryDelay: 1_500 }),
}) as PublicClient;
const fixtureFile = (id: string) => resolve(REPO, `deployments/fixture-${id}.json`);
const shared = JSON.parse(readFileSync(resolve(REPO, "deployments/11155111.json"), "utf8")) as Record<string, string>;
const demos = DEMO_FIXTURES.slice(FROM - 1, TO).map((id, i) => ({ id, n: FROM + i }));

/**
 * An EIP-7702 delegated owner may have ONE transaction pending at a time.
 *
 * Geth's pool rejects the second with "in-flight transaction limit reached for
 * delegated accounts". 0x6834 became one when MetaMask upgraded it to a smart
 * account, and the first real run died on it three times in a minute. Then
 * forge runs `--slow` and the owner stream runs one at a time; agents' own
 * streams are unaffected.
 */
const DELEGATED = ((await pc.getCode({ address: OWNER })) ?? "0x").toLowerCase().startsWith("0xef0100");
const OWNER_WINDOW = DELEGATED ? 1 : WINDOW;

const timing = new Map<string, { venueMs: number; seedStart: number; seedEnd: number }>();
/** Wei spent per fixture, from every receipt's gasUsed × effectiveGasPrice (owner and agents). */
const ethUsed = new Map<string, bigint>();
const TIMING_FILE = resolve(REPO, "deployments/.demo-timing.json");

// --------------------------------------------------------------------- venues

async function potHasCode(id: string): Promise<boolean> {
  if (!existsSync(fixtureFile(id))) return false;
  const pot = (JSON.parse(readFileSync(fixtureFile(id), "utf8")) as { settlementPot?: Address }).settlementPot;
  if (!pot) return false;
  return ((await pc.getCode({ address: pot })) ?? "0x").length > 2;
}

const venueAbi = parseAbi([
  "function vault() view returns (address)",
  "function fillRouter() view returns (address)",
  "function fixtures(uint256) view returns (address pot, uint32 orderDelayL, bool finalized)",
]);

/** The venue is whole: fixture finalized on the factory, and the file's hook wired to the file's router and vault. */
async function venueComplete(id: string): Promise<boolean> {
  if (!(await potHasCode(id))) return false;
  const f = JSON.parse(readFileSync(fixtureFile(id), "utf8")) as Record<string, Address>;
  try {
    const [fx, vault, router] = await Promise.all([
      pc.readContract({ address: shared.fixtureFactory as Address, abi: venueAbi, functionName: "fixtures", args: [BigInt(id)] }),
      pc.readContract({ address: f.whistleHook!, abi: venueAbi, functionName: "vault" }),
      pc.readContract({ address: f.whistleHook!, abi: venueAbi, functionName: "fillRouter" }),
    ]);
    return fx[2] && fx[0].toLowerCase() === f.settlementPot!.toLowerCase()
      && vault.toLowerCase() === f.mmVault!.toLowerCase() && router.toLowerCase() === f.fillRouter!.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Take the venue's addresses from what forge BROADCAST, not from the file it wrote.
 *
 * `forge script --resume` re-runs the script's simulation — which rewrites
 * `deployments/fixture-<id>.json` with addresses predicted from the nonce it sees
 * now — and then broadcasts the transactions it saved the first time. After a
 * resume the file named the vault as the router and a vault that was never
 * deployed. The broadcast record is what was actually sent.
 */
function addressesFromBroadcast(id: string): void {
  const b = JSON.parse(readFileSync(resolve(REPO, "contracts/broadcast/DeployFixture.s.sol/11155111/run-latest.json"), "utf8")) as {
    transactions: { transactionType: string; contractName?: string; contractAddress?: string }[];
  };
  const created = (name: string) => b.transactions.find((t) => (t.transactionType === "CREATE" || t.transactionType === "CREATE2") && t.contractName === name)?.contractAddress;
  const f = JSON.parse(readFileSync(fixtureFile(id), "utf8")) as Record<string, unknown>;
  const hook = created("WhistleHook"), router = created("WhistleFillRouter"), vault = created("MMVault");
  if (!hook || !router || !vault) throw new Error(`Demo ${id}: broadcast record has no hook/router/vault`);
  Object.assign(f, { whistleHook: hook, fillRouter: router, mmVault: vault });
  writeFileSync(fixtureFile(id), `${JSON.stringify(f, null, 2)}\n`);
}

/** The block `createFixture` landed in: where this fixture's history begins. */
async function createdBlock(id: string): Promise<number> {
  const event = parseAbiItem("event FixtureCreated(uint256 indexed fixtureId, address pot, uint32 orderDelayL)");
  const head = await pc.getBlockNumber();
  for (let from = BigInt(shared.deployBlock ?? 0); from <= head; from += 5000n) {
    const to = from + 4999n > head ? head : from + 4999n;
    const logs = await pc.getLogs({ address: shared.matchOracle as Address, event, args: { fixtureId: BigInt(id) }, fromBlock: from, toBlock: to });
    if (logs.length) return Number(logs[0]!.blockNumber);
  }
  throw new Error(`no FixtureCreated for ${id}`);
}

async function deployVenue(id: string, n: number): Promise<void> {
  const t0 = Date.now();
  if (await venueComplete(id)) {
    log(`Demo ${n} (${id}) venue: already deployed`);
  } else {
    for (let attempt = 0; ; attempt++) {
      log(`Demo ${n} (${id}) venue: forge${attempt ? " --resume" : ""}${DELEGATED ? " --slow (delegated owner)" : ""}`);
      const r = spawnSync(
        "forge",
        ["script", "script/DeployFixture.s.sol:DeployFixture", "--rpc-url", RPC!, "--broadcast", "--timeout", "300",
          // --resume has no wallet of its own; the script's vm.startBroadcast(pk) only covers a fresh run.
          "--private-key", ownerKey,
          ...(DELEGATED ? ["--slow"] : []),
          ...(attempt ? ["--resume"] : [])],
        {
          cwd: resolve(REPO, "contracts"), encoding: "utf8",
          env: { ...process.env, DEMO_AGENTS: "", NEW_FIXTURE_ID: id, FIXTURE_FILE: "../fixtures/che-bar-A-20260926.deploy.json",
            FIXTURE_FACTORY: shared.fixtureFactory, AGENT_REGISTRY: shared.agentRegistry,
            PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}` },
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      writeFileSync(resolve(REPO, `deployments/.venue-${id}.log`), `${r.stdout}\n${r.stderr}`.replaceAll(ownerKey, "<owner key>"));
      if (r.status === 0 && (await potHasCode(id))) {
        addressesFromBroadcast(id);
        if (await venueComplete(id)) break;
        throw new Error(`STOP: Demo ${n} venue broadcast finished but the hook is not wired to the router/vault it deployed`);
      }
      if (attempt + 1 > MAX_RESUMES) throw new Error(`STOP: Demo ${n} venue needed more than ${MAX_RESUMES} resumes (log: deployments/.venue-${id}.log)`);
      log(`Demo ${n} venue failed (exit ${r.status}); resume ${attempt + 1} of ${MAX_RESUMES}`);
      await sleep(15_000);
    }
  }
  const f = JSON.parse(readFileSync(fixtureFile(id), "utf8")) as Record<string, unknown>;
  for (const k of ["chainId", "agentRegistry", "rootRegistry", "ensRoleAuth", "fixtureFactory", "usdc"]) f[k] ??= shared[k];
  // From the fixture's own FixtureCreated event: forge's run-latest.json belongs to
  // whichever venue ran last, which after a pause is not this one.
  if (!f.deployBlock) f.deployBlock = await createdBlock(id);
  Object.assign(f, { fixtureId: id, label: `Demo ${n}`, settled: false, order: n, agentCapUSDC: DEMO_SEED_ENV.SEED_AGENT_CAP_USDC });
  writeFileSync(fixtureFile(id), `${JSON.stringify(f, null, 2)}\n`);
  timing.set(id, { venueMs: Date.now() - t0, seedStart: 0, seedEnd: 0 });
}

// ----------------------------------------------------------------------- plan

function seedEnv(id: string): Record<string, string> {
  const agents = premade(id).map((a) => a.key);
  const over = PER_FIXTURE[id] ?? {};
  const wallets = over.ownerWallet === false ? agents : [ownerKey, ...agents];
  const env = { ...DEMO_SEED_ENV, ...(over.env ?? {}) };
  if (env.SEED_CAP_EXEMPT === "@fixture-agents") env.SEED_CAP_EXEMPT = (derived.fixtures[id] ?? []).map((a) => a.address).join(",");
  return {
    ...env,
    SEPOLIA_DEPLOYER_KEY: ownerKey, DEMO_USER_ADDRESS: OWNER, WHISTLE_USER_LABEL: "tokyo",
    TOKYO_AGENT_KEYS: agents.join(","), SEPOLIA_WALLET_KEYS: wallets.join(","),
    WHISTLE_DEPLOYMENT: `deployments/fixture-${id}.json`, WHISTLE_CONFIRM_FIXTURE: id, WHISTLE_RPC_URL: RPC!,
  };
}

interface Call { fixture: string; from: Address; label: string; request: Record<string, unknown> }

type SeedModule = typeof import("./deploy-sepolia.js");
type TxModule = typeof import("../oracle/tx.js");

async function planStep(seed: SeedModule, tx: TxModule, step: string, id: string, n: number): Promise<Call[]> {
  Object.assign(process.env, seedEnv(id));
  tx.PLAN.on = true;
  tx.PLAN.calls.length = 0;
  try {
    await seed.main({ argv: ["--only", step], planOnly: true });
  } finally {
    tx.PLAN.on = false;
  }
  return tx.PLAN.calls.map((c) => ({ fixture: id, from: c.from, label: `D${n} ${c.label}`, request: c.request }));
}

// --------------------------------------------------------------------- stream

function keyFor(address: Address): Hex {
  if (address.toLowerCase() === OWNER.toLowerCase()) return ownerKey;
  for (const agents of Object.values(derived.fixtures)) for (const a of agents) if (a.address.toLowerCase() === address.toLowerCase()) return a.key;
  throw new Error(`no derived key for ${address}`);
}

async function sendOne(tx: TxModule, w: WalletClient, account: Account, c: Call, nonce: number): Promise<void> {
  const fn = String(c.request.functionName ?? "");
  const { account: _drop, chain: _chain, ...rest } = c.request;
  const request = { ...rest, account, chain: sepolia, nonce, gas: GAS[fn] ?? DEFAULT_GAS };
  for (let resend = 0; resend < 3; resend++) {
    let hash: Hash | null = null;
    for (let attempt = 1; attempt <= 8 && !hash; attempt++) {
      try {
        hash = await w.writeContract(request as never);
      } catch (err) {
        const msg = String(err);
        if (/429|rate limit|too many requests|timeout|fetch failed|ECONNRESET|RPC Request failed|-32603|internal error|header not found/i.test(msg)) {
          await sleep(Math.min(20_000, 2_000 * attempt));
          continue;
        }
        // An earlier attempt on this nonce was accepted after all: wait for the
        // account's mined count to pass it rather than send anything else on it.
        if (/nonce too low|already known|replacement transaction underpriced/i.test(msg)) {
          for (let i = 0; i < 40; i++) {
            if ((await pc.getTransactionCount({ address: account.address, blockTag: "latest" })) > nonce) return;
            await sleep(3_000);
          }
          throw new Error(`${c.label}: nonce ${nonce} reported as taken but never mined`);
        }
        throw new Error(`${c.label} (nonce ${nonce}): ${msg.split("\n")[0]}`);
      }
    }
    if (!hash) throw new Error(`${c.label}: nonce ${nonce} was never accepted — stopping rather than leave a nonce gap`);
    try {
      const rc = await tx.confirm(pc, hash, c.label, { from: account.address, nonce });
      ethUsed.set(c.fixture, (ethUsed.get(c.fixture) ?? 0n) + rc.gasUsed * rc.effectiveGasPrice);
      if (rc.status !== "success") {
        if (fn === "initialize") { log(`  ${c.label}: pool already initialised (tolerated, as the seed does)`); return; }
        throw new Error(`${c.label} REVERTED on chain (nonce ${nonce}): ${hash}`);
      }
      return;
    } catch (err) {
      if (!(err instanceof tx.TransactionDropped)) throw err;
      log(`  ${c.label}: dropped, resending on nonce ${nonce}`);
    }
  }
  throw new Error(`${c.label}: nonce ${nonce} dropped three times`);
}

/** Strict nonce order, `window` in flight: confirm the oldest, then top up. */
async function stream(tx: TxModule, from: Address, calls: Call[], window: number, onConfirmed?: (c: Call) => void): Promise<void> {
  if (calls.length === 0) return;
  const account = privateKeyToAccount(keyFor(from));
  const w = createWalletClient({ account, chain: sepolia, transport: http(RPC, { timeout: 30_000 }) });
  let nonce = await pc.getTransactionCount({ address: from, blockTag: "pending" });
  const inflight: { c: Call; p: Promise<void> }[] = [];
  let i = 0, done = 0;
  while (i < calls.length || inflight.length) {
    while (i < calls.length && inflight.length < window) {
      const c = calls[i++]!;
      const p = sendOne(tx, w, account, c, nonce++);
      p.catch(() => undefined); // surfaced when it reaches the head
      inflight.push({ c, p });
    }
    const head = inflight.shift()!;
    await head.p;
    onConfirmed?.(head.c);
    if (++done % 25 === 0 || done === calls.length) log(`  ${from.slice(0, 8)}: ${done}/${calls.length} confirmed`);
  }
}

// ---------------------------------------------------------------------- check

function checkFixture(id: string): boolean {
  const r = spawnSync("npx", ["tsx", "scripts/deploy-sepolia.ts", "--check"], {
    cwd: REPO, encoding: "utf8", env: { ...process.env, ...seedEnv(id) },
  });
  return /Everything is done\./.test(r.stdout);
}

// ---------------------------------------------------------------------- table

async function report(): Promise<string> {
  const STATE = ["PRE_MATCH", "LIVE", "SETTLED"];
  const protectedIds = new Set((process.env.PROTECTED_FIXTURES ?? "").split(",").map((s) => s.trim()));
  const market = await pc.readContract({ address: shared.agentRegistry as Address, abi: agentRegistryAbi, functionName: "market" });
  const saved = existsSync(TIMING_FILE) ? (JSON.parse(readFileSync(TIMING_FILE, "utf8")) as Record<string, { venueMs: number; seedStart: number; seedEnd: number }>) : {};
  const lines: string[] = [];
  lines.push(`# Demo fixtures — deployment report`, ``, `Generated ${new Date().toISOString()} from chain state.`, ``);
  lines.push(`| fixture | id | wall time | pools | agents (mandates, cap) | bound now | state | protected |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const [label, id] of [["Settled showcase", FIXTURE_A] as const, ...DEMO_FIXTURES.map((id, i) => [`Demo ${i + 1}`, id] as const)]) {
    if (!existsSync(fixtureFile(id)) || !(await potHasCode(id))) { lines.push(`| ${label} | \`${id}\` | — | not deployed | | | | |`); continue; }
    const F = JSON.parse(readFileSync(fixtureFile(id), "utf8")) as Record<string, string>;
    const FIX = BigInt(id);
    const fx = await pc.readContract({ address: F.matchOracle as Address, abi: matchOracleAbi, functionName: "fixtures", args: [FIX] });
    const players = id === FIXTURE_A ? A_TRADED : DEMO_TRADED.split(",").map(Number);
    let pools = 0;
    for (const p of players) {
      const card = await pc.readContract({ address: F.matchOracle as Address, abi: matchOracleAbi, functionName: "cardOf", args: [FIX, p] });
      const info = await pc.readContract({ address: F.whistleHook as Address, abi: whistleHookAbi, functionName: "cardInfo", args: [card] });
      if ((info as { registered: boolean }).registered) pools++;
    }
    let agents = 0;
    const caps = new Set<string>();
    for (const a of premade(id)) {
      const info = await pc.readContract({ address: shared.agentRegistry as Address, abi: agentRegistryAbi, functionName: "agentInfo", args: [a.address as Address] });
      if (info[4] === FIX) {
        agents++;
        const left = await pc.readContract({ address: shared.agentRegistry as Address, abi: agentRegistryAbi, functionName: "remainingCap", args: [a.address as Address] });
        caps.add(((left as bigint) + (info[6] as bigint)) / 1_000_000n + "");
      }
    }
    const t = timing.get(id) ?? saved[id];
    const wei = ethUsed.get(id) ?? BigInt((t as { ethWei?: string } | undefined)?.ethWei ?? "0");
    const wall = t?.seedEnd ? `${Math.round(t.venueMs / 60000)}m venue · ${Math.round((t.seedEnd - t.seedStart) / 60000)}m seed (pipelined) · ${Number(formatEther(wei)).toFixed(4)} ETH seed` : "—";
    lines.push(
      `| ${label} | \`${id}\` | ${wall} | ${pools}/${players.length} | ${agents}/3 · ${[...caps].map((c) => Number(c).toLocaleString("en-US")).join(", ") || "—"} USDC ` +
        `| ${market.toLowerCase() === F.whistleHook!.toLowerCase() ? "yes" : "no — Activate"} | ${STATE[Number(fx[1])]} | ${protectedIds.has(id) ? "yes" : "no"} |`,
    );
  }
  lines.push(``, `\`AgentRegistry.market()\` = \`${market}\`. One fixture is bound at a time; every presentation starts with Activate.`, ``);
  lines.push(`## ETH on every account`, ``, `| account | address | ETH |`, `|---|---|---|`);
  const accounts: [string, string][] = [["owner 0x6834", OWNER], ["service", derived.signers.service!.address]];
  for (const [id, agents] of Object.entries(derived.fixtures)) {
    for (const a of agents) if (a.n <= 3 || a.assigned) accounts.push([`${id === FIXTURE_A ? "A" : `Demo ${DEMO_FIXTURES.indexOf(id as never) + 1}`} agent ${a.n}${a.n > 3 ? " (managed)" : ""}`, a.address]);
  }
  for (const r of ["C-1", "C-2", "C-3"]) if (derived.signers[r]) accounts.push([`legacy ${r}`, derived.signers[r]!.address]);
  let total = 0n;
  for (const [name, addr] of accounts) {
    const bal = await pc.getBalance({ address: addr as Address });
    total += bal;
    lines.push(`| ${name} | \`${addr}\` | ${Number(formatEther(bal)).toFixed(5)} |`);
  }
  lines.push(`| **total** | | **${Number(formatEther(total)).toFixed(5)}** |`, ``);
  lines.push(`Managed pool keys (agents 4–6 per fixture) hold nothing until \`/api/agents/assign\` funds one; unassigned ones are not listed.`);
  return lines.join("\n") + "\n";
}

// ----------------------------------------------------------------------- main

async function main(): Promise<void> {
  if (!argv.includes("--report-only")) {
    log(`RPC ${new URL(RPC!).host}   demos ${FROM}..${TO}   owner window ${OWNER_WINDOW}${DELEGATED ? " (owner is EIP-7702 delegated: one in flight)" : ""}`);
    for (const { id, n } of demos) await deployVenue(id, n);

    // The seed reads its knobs at import: set them first, then load it once.
    Object.assign(process.env, DEMO_SEED_ENV);
    const tx = await import("../oracle/tx.js");
    const seed = await import("./deploy-sepolia.js");

    const seedStart = Date.now();
    for (const { id } of demos) timing.get(id)!.seedStart = seedStart;

    for (const step of SEED_STEPS) {
      if (step === "gas") {
        // ETH transfers go through sendTransaction, which the plan sink does not
        // see; demo agents are funded up front, so this is normally a no-op.
        for (const { id } of demos) {
          Object.assign(process.env, seedEnv(id));
          await seed.main({ argv: ["--only", "gas"] });
        }
        continue;
      }
      const calls: Call[] = [];
      for (const { id, n } of demos) calls.push(...(await planStep(seed, tx, step, id, n)));
      const owner = calls.filter((c) => c.from.toLowerCase() === OWNER.toLowerCase());
      const others = new Map<string, Call[]>();
      for (const c of calls) if (c.from.toLowerCase() !== OWNER.toLowerCase()) others.set(c.from, [...(others.get(c.from) ?? []), c]);
      log(`${step}: ${owner.length} owner writes across ${demos.length} fixtures, ${calls.length - owner.length} on ${others.size} other accounts`);
      if (calls.length === 0) continue;

      const lastIdx = new Map<string, number>();
      owner.forEach((c, i) => lastIdx.set(c.fixture, i));
      let confirmed = 0;
      const side = Promise.all([...others.entries()].map(([from, cs]) => stream(tx, from as Address, cs, 4)));
      side.catch(() => undefined);
      await stream(tx, OWNER, owner, OWNER_WINDOW, (c) => {
        if (lastIdx.get(c.fixture) === confirmed++) timing.get(c.fixture)!.seedEnd = Date.now();
      });
      await side;
      for (const { id } of demos) timing.get(id)!.seedEnd = Math.max(timing.get(id)!.seedEnd, Date.now());
      writeFileSync(TIMING_FILE, `${JSON.stringify(Object.fromEntries([...timing].map(([k, v]) => [k, { ...v, ethWei: String(ethUsed.get(k) ?? 0n) }])), null, 2)}\n`);
    }

    let allDone = true;
    for (const { id, n } of demos) {
      const ok = checkFixture(id);
      allDone &&= ok;
      log(`Demo ${n} check: ${ok ? "all steps done" : "STILL OWED — rerun to resume"}`);
    }
    if (!allDone) process.exitCode = 2;
  }
  const table = await report();
  const out = resolve(REPO, "docs/demo-fixtures-report.md");
  writeFileSync(out, table);
  console.log(`\n${table}`);
  log(`wrote ${out}`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
