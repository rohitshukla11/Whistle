/**
 * The Saturday plan: two fixtures, one already played, one waiting to be.
 *
 * `deploy:sepolia` builds one fixture. The demo needs two, because the payout
 * beat and the live beat cannot be the same match: a replay settles what it runs
 * on, and a settled fixture cannot be reopened. So:
 *
 *   A — deployed, seeded, replayed to `postFinal`, redeemed. The payouts screen.
 *   B — deployed, seeded, left at PRE_MATCH and added to PROTECTED_FIXTURES so
 *       nothing can touch it before the demo.
 *
 * Every phase asks the chain whether it is already done, so a crash costs the
 * phase it crashed in and nothing before it. Rerun as often as you like.
 *
 *   pnpm deploy:sepolia -- --plan saturday [--dry-run] [--force]
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createPublicClient, formatEther, http, parseAbi, type Address, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { isLocalRpc, redactRpc, rpcUrlFor } from "../oracle/chain.js";

const repo = resolve(new URL("..", import.meta.url).pathname);

const oracleAbi = parseAbi([
  "function fixtureState(uint256 fixtureId) view returns (uint8)",
  "function fixtures(uint256 fixtureId) view returns (address pot, uint8 state, uint16 clock, uint16 playerCount, uint32 orderDelayL, uint32 staleTolerance, uint64 lastEventAt, bool a, bool b, bool finalized)",
]);
const potAbi = parseAbi(["function potBalance() view returns (uint256)"]);

/**
 * What each phase costs, in gas, per role.
 *
 * Measured, with the provenance of each number recorded — a budget built from
 * guesses is a budget that lets you start a job you cannot finish.
 *
 *   venue   forge's own "Estimated total gas used for script" for
 *           DeployFixture, 13,531,507, observed on a fork of Sepolia.
 *   seed    the deployer's own transactions on that same fork: 79 txs and
 *           36,562,045 gas total, of which the venue deploy is the above, so
 *           seeding is ~23,000,000 and rising — pools were still running when
 *           this was taken, so it is rounded UP to 26,000,000 rather than
 *           treated as final.
 *   replay  10,570,490 gas for the whole Sepolia run of fixture 20090506 —
 *           23 events, 16 paginated ticks and postFinal — split here between
 *           the oracle and the keeper in proportion to their transaction
 *           counts.
 *   redeem  126 redemptions on that same run; ~21,000 gas each plus the
 *           approvals, rounded up.
 *
 * Re-measure after Saturday's real run and replace these.
 */
const GAS = {
  /** Per fixture, all on the deployer. */
  venue: 13_531_507,
  seed: 26_000_000,
  redeem: 2_800_000,
  /** The replay, once, across its two signing roles. */
  oracle: 4_100_000,
  keeper: 6_500_000,
  /** Per agent, for a whole match of queueing and ENS writes. */
  agent: 900_000,
} as const;

/**
 * The phases a budget line has to cover, in the order they run.
 *
 * Named separately from {@link GAS} so the pre-flight can show WHERE the money
 * goes rather than one number per key — "the deployer needs 0.19 ETH" is not
 * actionable, "0.07 of that is fixture B's seed" is.
 */
const PHASE_COST: { phase: string; role: string; gas: number }[] = [
  { phase: "fixture A venue", role: "deployer", gas: GAS.venue },
  { phase: "fixture A seed", role: "deployer", gas: GAS.seed },
  { phase: "replay (events)", role: "oracle", gas: GAS.oracle },
  { phase: "replay (ticks)", role: "keeper", gas: GAS.keeper },
  { phase: "settle + redeem", role: "deployer", gas: GAS.redeem },
  { phase: "fixture B venue", role: "deployer", gas: GAS.venue },
  { phase: "fixture B seed", role: "deployer", gas: GAS.seed },
];

const BUDGET_MARGIN = 13n; // /10 == 1.3x

interface Role {
  name: string;
  address: Address;
  /** Gas this role spends across the whole plan, in gas units. */
  gas: number;
  /** Flat ETH this role must hold on top of its gas — the float it pays out. */
  floatWei?: bigint;
  /**
   * Funded by the plan itself rather than beforehand.
   *
   * The agents' ETH comes from the deployer during the `seed` phase, so an empty
   * agent balance is the expected state at the start, not a reason to refuse.
   * Their cost is charged to the deployer instead.
   */
  fundedByPlan?: boolean;
}

export interface PlanOptions {
  dryRun: boolean;
  force: boolean;
  /** Skip phases already satisfied, rather than re-running them. */
  fixtureIdA: string;
  fixtureIdB: string;
}

interface Ctx extends PlanOptions {
  rpcUrl: string;
  client: PublicClient;
  oracle: Address;
  factory: Address;
  agentRegistry: Address;
  roles: Role[];
  timings: { phase: string; seconds: number }[];
  before: Map<string, bigint>;
}

// ------------------------------------------------------------------ helpers

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`${name} is not set. See .env.example.`);
  return v;
}

/** Run a command, streaming its output, and resolve only if it exits zero. */
function run(cmd: string, args: string[], extraEnv: Record<string, string> = {}, cwd = repo): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: "inherit" });
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0 ? ok() : fail(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
  });
}

/** Start a long-running child and return a stop function. */
function start(cmd: string, args: string[], extraEnv: Record<string, string> = {}) {
  const child = spawn(cmd, args, { cwd: repo, env: { ...process.env, ...extraEnv }, stdio: "inherit" });
  return () => {
    if (!child.killed) child.kill("SIGTERM");
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fixtureFile(id: string): string {
  return resolve(repo, "deployments", `fixture-${id}.json`);
}

function readFixture(id: string): Record<string, string> | null {
  const p = fixtureFile(id);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, string>) : null;
}

async function stateOf(ctx: Ctx, id: string): Promise<number | null> {
  try {
    const s = await ctx.client.readContract({
      address: ctx.oracle, abi: oracleAbi, functionName: "fixtureState", args: [BigInt(id)],
    });
    return Number(s);
  } catch {
    return null;
  }
}

/**
 * Six fresh agent keys for a fixture.
 *
 * `createAgent` reverts `AgentAddressInUse` rather than re-mandate an address —
 * deliberately, so a revoked mandate cannot be resurrected by reusing the key —
 * which means every new fixture needs six keys that have never been an agent.
 * Generated here and appended to `.env` (gitignored) so a rerun finds the same
 * ones rather than minting a second set the deployer would also have to fund.
 */
function agentKeysFor(slot: "A" | "B", persist = true): { keys: string; addresses: Address[] } {
  const name = `SATURDAY_AGENT_KEYS_${slot}`;
  const existing = env(name);
  if (existing) {
    const addresses = existing.split(",").map((k) => privateKeyToAccount(k.trim() as `0x${string}`).address);
    return { keys: existing, addresses };
  }
  // A dry run must not leave anything behind, least of all keys. Without them
  // the budget cannot name the agent addresses, so it says so instead.
  if (!persist) return { keys: "", addresses: [] };

  const fresh = Array.from({ length: 6 }, () => generatePrivateKey());
  const keys = fresh.join(",");
  appendFileSync(
    resolve(repo, ".env"),
    `\n# Generated by the Saturday plan for fixture ${slot}. Six keys, never used as an agent before.\n${name}=${keys}\n`,
  );
  process.env[name] = keys;
  const addresses = fresh.map((k) => privateKeyToAccount(k).address);
  console.log(`  generated six agent keys for fixture ${slot} and wrote ${name} to .env`);
  return { keys, addresses };
}

// ------------------------------------------------------------------- phases

interface Phase {
  name: string;
  done(ctx: Ctx): Promise<boolean>;
  run(ctx: Ctx): Promise<void>;
}

function deployPhase(slot: "A" | "B", idOf: (c: Ctx) => string): Phase {
  return {
    name: `fixture-${slot}:deploy`,
    async done(ctx) {
      const id = idOf(ctx);
      const f = readFixture(id);
      // A file alone is not enough: the forge script writes only the six
      // per-fixture addresses, and everything downstream needs the shared ones
      // merged in. Both must be true, and the chain has to know the fixture.
      if (!f?.settlementPot || !f.agentRegistry || !f.usdc) return false;
      return (await stateOf(ctx, id)) !== null;
    },
    async run(ctx) {
      const id = idOf(ctx);

      // Captured before deploying: log scans start here, and a block that
      // predates the pot is safe where one that postdates it silently loses
      // history.
      const deployBlock = Number(await ctx.client.getBlockNumber());

      await run(
        `${process.env.HOME}/.foundry/bin/forge`,
        [
          "script", "script/DeployFixture.s.sol:DeployFixture",
          "--rpc-url", ctx.rpcUrl, "--broadcast", "--slow", "--no-storage-caching",
        ],
        {
          NEW_FIXTURE_ID: id,
          FIXTURE_FACTORY: ctx.factory,
          AGENT_REGISTRY: ctx.agentRegistry,
          DEPLOYER_PRIVATE_KEY: requireEnv("SEPOLIA_DEPLOYER_KEY"),
        },
        resolve(repo, "contracts"),
      );

      /**
       * Make the fixture file a complete deployment.
       *
       * `DeployFixture` writes the six addresses it created. Everything that
       * reads the file afterwards — the seeder, the agents, the web app — also
       * needs the contracts shared across fixtures, and without them the seeder
       * dies on `eth_getCode(null)` with nothing to say about which address was
       * missing.
       */
      const base = JSON.parse(
        readFileSync(resolve(repo, `deployments/${sepolia.id}.json`), "utf8"),
      ) as Record<string, unknown>;
      const own = readFixture(id) ?? {};
      const merged = {
        chainId: sepolia.id,
        agentRegistry: base.agentRegistry,
        fixtureFactory: base.fixtureFactory,
        usdc: base.usdc,
        rootRegistry: base.rootRegistry,
        ensRoleAuth: base.ensRoleAuth,
        ...own,
        fixtureId: id,
        deployBlock,
        label: `Chelsea v Barcelona (Saturday ${slot})`,
        settled: false,
      };
      const { writeFileSync } = await import("node:fs");
      writeFileSync(fixtureFile(id), `${JSON.stringify(merged, null, 2)}\n`);
      console.log(`  merged shared addresses into ${fixtureFile(id)} (deployBlock ${deployBlock})`);
    },
  };
}

function seedPhase(slot: "A" | "B", idOf: (c: Ctx) => string): Phase {
  return {
    name: `fixture-${slot}:seed`,
    async done(ctx) {
      const id = idOf(ctx);
      // `deploy:sepolia --check` is the authority on "is this seeded": it asks
      // the chain for every step. Exit zero and no outstanding steps means done.
      return await checkSeeded(ctx, id);
    },
    async run(ctx) {
      const id = idOf(ctx);
      const { keys } = agentKeysFor(slot);
      await run("npx", ["tsx", "scripts/deploy-sepolia.ts", "--user", `sat${slot.toLowerCase()}`], {
        WHISTLE_DEPLOYMENT: fixtureFile(id),
        WHISTLE_RPC_URL: ctx.rpcUrl,
        AGENT_PRIVATE_KEYS: keys,
      });
    },
  };
}

/** True when `deploy:sepolia --check` reports nothing outstanding. */
async function checkSeeded(ctx: Ctx, id: string): Promise<boolean> {
  return new Promise((ok) => {
    const child = spawn("npx", ["tsx", "scripts/deploy-sepolia.ts", "--check"], {
      cwd: repo,
      env: { ...process.env, WHISTLE_DEPLOYMENT: fixtureFile(id), WHISTLE_RPC_URL: ctx.rpcUrl },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.on("exit", () => ok(/Everything is done\./.test(out)));
    child.on("error", () => ok(false));
  });
}

const replayPhase: Phase = {
  name: "fixture-A:replay",
  async done(ctx) {
    return (await stateOf(ctx, ctx.fixtureIdA)) === 2;
  },
  async run(ctx) {
    const { keys } = agentKeysFor("A");
    const common = {
      WHISTLE_DEPLOYMENT: fixtureFile(ctx.fixtureIdA),
      WHISTLE_RPC_URL: ctx.rpcUrl,
      WHISTLE_CHAIN: "sepolia",
    };
    // Agents first, so they are watching when kickoff lands.
    const stopAgents = start("npx", ["tsx", "agent/runtime.ts", "--fixture", "fixtures/che-bar-2009-05-06.json"], {
      ...common,
      AGENT_PRIVATE_KEYS: keys,
    });
    try {
      await sleep(20_000);
      await run(
        "npx",
        ["tsx", "oracle/replay.ts", "--fixture", "fixtures/che-bar-2009-05-06.json",
         "--clock", "3m", "--cards", "4", "--page", "8"],
        {
          ...common,
          ORACLE_PRIVATE_KEY: requireEnv("SEPOLIA_ORACLE_KEY"),
          KEEPER_PRIVATE_KEY: requireEnv("SEPOLIA_KEEPER_KEY"),
        },
      );
      // `postFinal` is the last thing the replay sends; confirm the chain agrees
      // rather than trusting the exit code.
      for (let i = 0; i < 30; i += 1) {
        if ((await stateOf(ctx, ctx.fixtureIdA)) === 2) {
          // The web app picks its default fixture from this flag, so a settled
          // fixture still marked live would open the demo on the wrong match.
          const f = readFixture(ctx.fixtureIdA) ?? {};
          const { writeFileSync } = await import("node:fs");
          writeFileSync(
            fixtureFile(ctx.fixtureIdA),
            `${JSON.stringify({ ...f, settled: true, label: "Chelsea 1-1 Barcelona (settled)" }, null, 2)}\n`,
          );
          return;
        }
        await sleep(2_000);
      }
      throw new Error("replay exited but the fixture is not SETTLED");
    } finally {
      stopAgents();
      await sleep(1_000);
    }
  },
};

const redeemPhase: Phase = {
  name: "fixture-A:redeem",
  async done(ctx) {
    const f = readFixture(ctx.fixtureIdA);
    if (!f?.settlementPot) return false;
    try {
      const left = await ctx.client.readContract({
        address: f.settlementPot as Address, abi: potAbi, functionName: "potBalance",
      });
      // Dust, not zero: every redemption rounds its payout down by up to one
      // unit of USDC, and a few wei of card units stay stranded as liquidity
      // rounding inside the PoolManager, which cannot call `redeem`.
      return left < 1_000_000n;
    } catch {
      return false;
    }
  },
  async run(ctx) {
    const { keys } = agentKeysFor("A");
    await run("npx", ["tsx", "scripts/redeem-all.ts"], {
      WHISTLE_DEPLOYMENT: fixtureFile(ctx.fixtureIdA),
      WHISTLE_RPC_URL: ctx.rpcUrl,
      WHISTLE_CHAIN: "sepolia",
      AGENT_PRIVATE_KEYS: keys,
    });
  },
};

const protectPhase: Phase = {
  name: "fixture-B:protect",
  async done(ctx) {
    const raw = readFileSync(resolve(repo, ".env"), "utf8");
    const line = /^PROTECTED_FIXTURES=(.*)$/m.exec(raw)?.[1] ?? "";
    return line.split(",").map((s) => s.trim()).includes(ctx.fixtureIdB);
  },
  async run(ctx) {
    const path = resolve(repo, ".env");
    const raw = readFileSync(path, "utf8");
    const current = /^PROTECTED_FIXTURES=(.*)$/m.exec(raw)?.[1] ?? "";
    const ids = [...current.split(",").map((s) => s.trim()).filter(Boolean), ctx.fixtureIdB];
    const next = /^PROTECTED_FIXTURES=/m.test(raw)
      ? raw.replace(/^PROTECTED_FIXTURES=.*$/m, `PROTECTED_FIXTURES=${ids.join(",")}`)
      : `${raw}\nPROTECTED_FIXTURES=${ids.join(",")}\n`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, next);
    console.log(`  PROTECTED_FIXTURES=${ids.join(",")}`);
  },
};

const buildPhase: Phase = {
  name: "web:build",
  async done(ctx) {
    // The snapshot for A is the thing the payouts beat depends on.
    return existsSync(resolve(repo, "web", "public", "settled", `${ctx.fixtureIdA}.json`));
  },
  async run() {
    await run("pnpm", ["build"], {}, resolve(repo, "web"));
  },
};

// -------------------------------------------------------------------- budget

async function budget(ctx: Ctx): Promise<{ ok: boolean; rows: string[] }> {
  const price = await ctx.client.getGasPrice();
  const rows: string[] = [];
  let ok = true;

  const eth = (gas: number) => formatEther((BigInt(gas) * price * BUDGET_MARGIN) / 10n).slice(0, 8);

  rows.push(`gas price ${(Number(price) / 1e9).toFixed(3)} gwei x 1.3 margin\n`);
  rows.push("  phase                 role        gas          ETH");
  rows.push("  " + "-".repeat(52));
  for (const c of PHASE_COST) {
    rows.push(
      `  ${c.phase.padEnd(20)} ${c.role.padEnd(10)} ${String(c.gas).padStart(10)}  ${eth(c.gas).padStart(9)}`,
    );
  }
  const totalGas = PHASE_COST.reduce((n, c) => n + c.gas, 0);
  rows.push("  " + "-".repeat(52));
  rows.push(`  ${"total".padEnd(31)} ${String(totalGas).padStart(10)}  ${eth(totalGas).padStart(9)}`);
  rows.push(
    `  ${"+ float to 12 agents and 8 shared wallets".padEnd(42)} ` +
      `${formatEther(6_000_000_000_000_000n * 20n).slice(0, 8).padStart(9)}\n`,
  );
  rows.push("  per key");
  for (const role of ctx.roles) {
    const need = (BigInt(role.gas) * price * BUDGET_MARGIN) / 10n + (role.floatWei ?? 0n);
    const have = await ctx.client.getBalance({ address: role.address });
    ctx.before.set(role.name, have);

    // A role the plan funds cannot be short before the plan runs.
    const short = !role.fundedByPlan && have < need;
    if (short) ok = false;
    rows.push(
      `  ${short ? "!" : " "} ${role.name.padEnd(12)} ${role.address}  ` +
        `need ${formatEther(need).slice(0, 8).padStart(8)}  have ${formatEther(have).slice(0, 8).padStart(8)} ETH` +
        `${short ? "  SHORT" : role.fundedByPlan ? "  funded by the plan" : ""}`,
    );
  }
  return { ok, rows };
}

// ---------------------------------------------------------------------- run

export async function runSaturdayPlan(opts: PlanOptions): Promise<void> {
  const rpcUrl = rpcUrlFor(sepolia);
  const client = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl, { retryCount: 3, retryDelay: 1_000, timeout: 120_000 }),
  }) as PublicClient;

  const base = JSON.parse(readFileSync(resolve(repo, `deployments/${sepolia.id}.json`), "utf8"));

  const agentsA = agentKeysFor("A", !opts.dryRun).addresses;
  const agentsB = agentKeysFor("B", !opts.dryRun).addresses;
  const roleAddr = (k: string) => privateKeyToAccount(requireEnv(k) as `0x${string}`).address;

  const gasFor = (role: string) =>
    PHASE_COST.filter((c) => c.role === role).reduce((n, c) => n + c.gas, 0);
  /**
   * The deployer also pays everyone else's float.
   *
   * `deploy:sepolia` tops up the agents and the demo wallets to 0.006 ETH each
   * during `seed`. That is real ETH leaving the deployer, and leaving it out of
   * the budget is how you discover it halfway through the second fixture.
   *
   * Twelve agents, because `createAgent` reverts `AgentAddressInUse` and each
   * fixture needs six keys that have never been an agent. Only eight wallets,
   * because a demo wallet is just an address holding cards — nothing stops the
   * same eight holding positions in both fixtures, and funding a second set
   * would be 0.048 ETH for nothing.
   */
  const FLOAT_EACH = 6_000_000_000_000_000n;
  const floatRecipients = 12 + 8;
  const roles: Role[] = [
    {
      name: "deployer",
      address: roleAddr("SEPOLIA_DEPLOYER_KEY"),
      gas: gasFor("deployer"),
      floatWei: FLOAT_EACH * BigInt(floatRecipients),
    },
    { name: "oracle", address: roleAddr("SEPOLIA_ORACLE_KEY"), gas: gasFor("oracle") },
    { name: "keeper", address: roleAddr("SEPOLIA_KEEPER_KEY"), gas: gasFor("keeper") },
    ...[...agentsA, ...agentsB].map((a, i) => ({
      name: `agent-${i + 1}`,
      address: a,
      // Only fixture A's agents trade; B's are minted and left idle until the demo.
      gas: i < 6 ? GAS.agent : 0,
      fundedByPlan: true,
    })),
  ];

  const ctx: Ctx = {
    ...opts, rpcUrl, client,
    oracle: base.matchOracle, factory: base.fixtureFactory, agentRegistry: base.agentRegistry,
    roles, timings: [], before: new Map(),
  };

  console.log(`\nSaturday plan`);
  console.log(`  RPC        ${redactRpc(rpcUrl)}${isLocalRpc(rpcUrl) ? "  (local — a fork)" : ""}`);
  console.log(`  fixture A  ${ctx.fixtureIdA}   settled showcase`);
  console.log(`  fixture B  ${ctx.fixtureIdB}   live demo, will be protected\n`);

  const { ok, rows } = await budget(ctx);
  console.log("ETH budget (measured gas x current price x 1.3)");
  for (const r of rows) console.log(r);
  if (agentsA.length === 0) {
    console.log("  (agent keys are generated on the first real run; their budget is 0.0025 ETH each)");
  }

  // A dry run sends nothing, so a short key is information rather than a reason
  // to stop — the phase table below is the point of the run.
  if (!ok && !opts.dryRun && !opts.force) {
    throw new Error("\nAt least one key is short. Top it up, or rerun with --force to start anyway.");
  }
  if (!ok && !opts.dryRun) console.log("\n  --force: starting with at least one key short.\n");

  const phases: Phase[] = [
    deployPhase("A", (c) => c.fixtureIdA),
    seedPhase("A", (c) => c.fixtureIdA),
    replayPhase,
    redeemPhase,
    deployPhase("B", (c) => c.fixtureIdB),
    seedPhase("B", (c) => c.fixtureIdB),
    protectPhase,
    buildPhase,
  ];

  if (opts.dryRun) {
    console.log("\n--dry-run: phase status only, nothing sent.\n");
    for (const p of phases) {
      const d = await p.done(ctx);
      console.log(`  [${d ? "x" : " "}] ${p.name}`);
    }
    return;
  }

  for (const phase of phases) {
    const started = Date.now();
    if (await phase.done(ctx)) {
      console.log(`\n== ${phase.name}: already done`);
      continue;
    }
    console.log(`\n== ${phase.name}`);
    await phase.run(ctx);
    if (!(await phase.done(ctx))) throw new Error(`${phase.name} ran but still reports not done`);
    const seconds = (Date.now() - started) / 1000;
    ctx.timings.push({ phase: phase.name, seconds });
    console.log(`== ${phase.name}: done in ${seconds.toFixed(1)}s`);
  }

  await report(ctx);
}

async function report(ctx: Ctx): Promise<void> {
  console.log(`\n${"=".repeat(72)}\nSaturday plan complete\n`);

  const a = readFixture(ctx.fixtureIdA);
  const b = readFixture(ctx.fixtureIdB);
  console.log("addresses");
  for (const [slot, f] of [["A", a], ["B", b]] as const) {
    if (!f) continue;
    console.log(`  fixture ${slot} ${f.fixtureId}`);
    for (const k of ["settlementPot", "whistleHook", "fillRouter", "mmVault", "matchOracle"]) {
      if (f[k]) console.log(`    ${k.padEnd(14)} ${f[k]}`);
    }
  }

  console.log("\nETH per key");
  for (const role of ctx.roles) {
    const before = ctx.before.get(role.name) ?? 0n;
    const after = await ctx.client.getBalance({ address: role.address });
    const spent = before > after ? before - after : 0n;
    console.log(
      `  ${role.name.padEnd(12)} ${formatEther(before).slice(0, 8).padStart(8)} -> ` +
        `${formatEther(after).slice(0, 8).padStart(8)}   spent ${formatEther(spent).slice(0, 8)}`,
    );
  }

  console.log("\nwall time");
  let total = 0;
  for (const t of ctx.timings) {
    total += t.seconds;
    console.log(`  ${t.phase.padEnd(22)} ${t.seconds.toFixed(1)}s`);
  }
  console.log(`  ${"total".padEnd(22)} ${total.toFixed(1)}s (${(total / 60).toFixed(1)} min)`);
  console.log(`\nfixture ${ctx.fixtureIdB} is PROTECTED. Remove it from .env when you mean to run for real.`);
}
