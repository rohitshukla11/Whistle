/**
 * The agent runtime.
 *
 * One process drives one or more agents. Each agent watches the oracle's
 * `MatchEvent` log, evaluates its template, and queues an order from its OWN key
 * with a 10% slippage tolerance. After a fill it writes `last-action` and `status`
 * to its own ENS resolver — from the agent key, exercising exactly the role the
 * user granted it in `createAgent` and nothing more.
 *
 *   pnpm agents -- --fixture fixtures/che-bar-2009-05-06.json
 *
 * Flags:
 *   --fixture <path>   fixture JSON (for names and player metadata)
 *   --slippage <bps>   order slippage tolerance   default 1000 (10%)
 *   --once             handle a single event and exit (for smoke tests)
 *
 * Agent keys come from `AGENT_PRIVATE_KEYS`, a comma-separated list. Each agent's
 * template is read from ENS (`agentInfo().templateId`), not from configuration —
 * the mandate is the source of truth for what the agent is allowed to be.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  type Account,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  agentRegistryAbi,
  matchOracleAbi,
  mockUsdcAbi,
  permissionedResolverAbi,
  playerCardAbi,
  settlementPotAbi,
  whistleHookAbi,
} from "../oracle/abi.js";
import { assertFixtureWritable, bindFixture, connect, dnsEncode, sleep, walletFor } from "../oracle/chain.js";
import { loadFixture } from "../oracle/fixture.js";
import {
  CancelReason,
  EventType,
  Side,
  fromUsdc,
  type Fixture,
  type MatchEvent,
} from "../oracle/types.js";
import { evaluate } from "./evaluate.js";
import { templateById, type Intent, type MarketView } from "./templates/index.js";
import { confirm } from "../oracle/tx.js";
import { derivedAgentKeys } from "../oracle/derived.js";
import { heartbeat, type Heartbeat } from "../oracle/heartbeat.js";

interface Options {
  fixturePath: string;
  slippageBps: number;
  once: boolean;
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    fixturePath: get("--fixture") ?? "fixtures/che-bar-2009-05-06.json",
    slippageBps: Number(get("--slippage") ?? 1000),
    once: argv.includes("--once"),
  };
}

interface AgentHandle {
  account: Account;
  wallet: WalletClient;
  templateId: number;
  resolver: Address;
  fqdn: string;
  dnsName: `0x${string}`;
  /**
   * Last known authorization, so a change is detectable.
   *
   * `undefined` until the first event: the first read establishes a baseline
   * rather than reporting a transition that did not happen.
   */
  authorized?: boolean;
  /** Orders this agent has queued that have not yet resolved. */
  pending: Map<bigint, Intent>;
  /** Order ids already re-queued once after PRICE_MOVED, so we do not loop. */
  requeued: Set<bigint>;
  filled: number;
  cancelled: number;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  // Before connect(): it reads WHISTLE_DEPLOYMENT, so the override must land first.
  const argvAll = process.argv.slice(2);
  const fixtureIdArg = argvAll.includes("--fixture-id") ? argvAll[argvAll.indexOf("--fixture-id") + 1] : undefined;
  if (fixtureIdArg) process.env.WHISTLE_DEPLOYMENT = `deployments/fixture-${fixtureIdArg}.json`;
  const fixture = await loadFixture(opts.fixturePath);
  const { chain, rpcUrl, publicClient, deployment } = connect();
  bindFixture(fixture, deployment);

  // Agents queue orders against this fixture, so they touch it too.
  assertFixtureWritable(fixture.fixtureId, "run agents");

  /*
   * `--fixture-id <id>` takes that fixture's three agents from
   * .secrets/derived.json and ignores AGENT_PRIVATE_KEYS — which still holds the
   * previous deployment's agents and would find no mandate on this one.
   */
  const derivedKeys = fixtureIdArg ? derivedAgentKeys(fixtureIdArg) : [];
  const keys = (derivedKeys.length ? derivedKeys.join(",") : process.env.AGENT_PRIVATE_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (keys.length === 0) throw new Error("AGENT_PRIVATE_KEYS is empty. See .env.example.");

  const agents: AgentHandle[] = [];
  for (const key of keys) {
    const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`);

    const info = await publicClient.readContract({
      address: deployment.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "agentInfo",
      args: [account.address],
    });
    const [, , resolver, , , templateId, , fqdn] = info;

    if (resolver === "0x0000000000000000000000000000000000000000") {
      console.warn(`! ${account.address} is not a registered agent; skipping.`);
      continue;
    }

    agents.push({
      account,
      wallet: walletFor(account, chain, rpcUrl),
      templateId: Number(templateId),
      resolver,
      fqdn,
      dnsName: dnsEncode(fqdn),
      pending: new Map(),
      requeued: new Set(),
      filled: 0,
      cancelled: 0,
    });

    console.log(
      `agent ${account.address}  ${fqdn}  template ${templateById(Number(templateId)).name}`,
    );
  }
  if (agents.length === 0) throw new Error("no registered agents among AGENT_PRIVATE_KEYS");

  // Card addresses and a kickoff price snapshot, so templates can reason about
  // "how far has this moved" rather than only about absolute price.
  const cards: Address[] = [];
  for (const p of fixture.players) {
    cards[p.id] = await publicClient.readContract({
      address: deployment.matchOracle,
      abi: matchOracleAbi,
      functionName: "cardOf",
      args: [fixture.fixtureId, p.id],
    });
  }
  const priceAtKickoff = await readPrices(publicClient, deployment.settlementPot, cards);
  let pricePrevious = priceAtKickoff;

  cachedCtx = { publicClient, deployment, chain, fixture, opts };

  console.log(`watching MatchEvent on ${deployment.matchOracle}`);
  console.log("");

  const unwatch = publicClient.watchContractEvent({
    address: deployment.matchOracle,
    abi: matchOracleAbi,
    eventName: "MatchEvent",
    onLogs: (logs) => {
      agentBeat?.bump("events", logs.length);
      void (async () => {
        for (const log of logs) {
          const args = log.args as {
            fixtureId?: bigint;
            minute?: number;
            eventType?: number;
            playerIds?: readonly number[];
          };
          if (args.fixtureId !== fixture.fixtureId) continue;

          const ev: MatchEvent = {
            minute: Number(args.minute ?? 0),
            type: (args.eventType ?? 0) as EventType,
            players: [...(args.playerIds ?? [])],
          };

          const now = await readPrices(publicClient, deployment.settlementPot, cards);
          await handleEvent(
            { publicClient, deployment, chain, fixture, opts },
            agents,
            cards,
            ev,
            priceAtKickoff,
            pricePrevious,
            now,
          );
          pricePrevious = now;

          if (opts.once) unwatch();
        }
      })();
    },
  });

  // Resolution of queued orders is observed from the hook's own events, so a
  // PRICE_MOVED cancellation is handled by the same loop that placed the order.
  publicClient.watchContractEvent({
    address: deployment.whistleHook,
    abi: whistleHookAbi,
    eventName: "OrderCancelled",
    onLogs: (logs) => {
      void (async () => {
        for (const log of logs) {
          const args = log.args as { orderId?: bigint; reason?: number };
          if (args.orderId === undefined) continue;
          await onCancelled(
            { publicClient, deployment, chain, fixture, opts },
            agents,
            args.orderId,
            (args.reason ?? 0) as CancelReason,
            cards,
          );
        }
      })();
    },
  });

  publicClient.watchContractEvent({
    address: deployment.whistleHook,
    abi: whistleHookAbi,
    eventName: "OrderFilled",
    onLogs: (logs) => {
      void (async () => {
        for (const log of logs) {
          const args = log.args as { orderId?: bigint; units?: bigint; usdc?: bigint };
          if (args.orderId === undefined) continue;
          await onFilled(agents, args.orderId, args.units ?? 0n, args.usdc ?? 0n, chain);
        }
      })();
    },
  });

  /**
   * The presenter's glance-check.
   *
   * Six agents that have decided not to trade look exactly like six agents that
   * have crashed. `events` moving proves the watcher is alive even when nothing
   * is worth acting on.
   */
  const beat = heartbeat(`agents(${agents.length})`, ["events", "queued", "fills", "errors"]);
  agentBeat = beat;

  // Stay alive. Ctrl-C ends the run.
  for (;;) await sleep(60_000);
}

interface Ctx {
  publicClient: PublicClient;
  deployment: ReturnType<typeof connect>["deployment"];
  chain: ReturnType<typeof connect>["chain"];
  fixture: Fixture;
  opts: Options;
}

async function readPrices(
  publicClient: PublicClient,
  pot: Address,
  cards: Address[],
): Promise<Map<Address, bigint>> {
  const prices = new Map<Address, bigint>();
  for (const card of cards) {
    if (!card) continue;
    prices.set(
      card,
      await publicClient.readContract({
        address: pot,
        abi: settlementPotAbi,
        functionName: "referencePrice",
        args: [card],
      }),
    );
  }
  return prices;
}

async function buildMarket(
  ctx: Ctx,
  cards: Address[],
  kickoff: Map<Address, bigint>,
  previous: Map<Address, bigint>,
  now: Map<Address, bigint>,
): Promise<MarketView[]> {
  const views: MarketView[] = [];
  for (const p of ctx.fixture.players) {
    const card = cards[p.id];
    if (!card) continue;

    // Only cards with a pool can be ordered. Without this filter a template picks
    // the biggest mover across the whole squad and `queueOrder` reverts
    // `UnknownCard` on the two thirds of the squad that have no market.
    const info = await ctx.publicClient.readContract({
      address: ctx.deployment.whistleHook,
      abi: whistleHookAbi,
      functionName: "cardInfo",
      args: [card],
    });
    if (!info.registered) continue;

    // `expectedScore` of zero for an on-pitch player means the line has floored;
    // treat a frozen line as "not coming back" for the templates' purposes.
    const e = await ctx.publicClient.readContract({
      address: ctx.deployment.matchOracle,
      abi: matchOracleAbi,
      functionName: "expectedScore",
      args: [ctx.fixture.fixtureId, p.id],
    });
    views.push({
      playerId: p.id,
      name: p.name,
      card,
      team: p.team,
      position: p.position,
      referencePrice: now.get(card) ?? 0n,
      priceAtKickoff: kickoff.get(card) ?? 0n,
      pricePrevious: previous.get(card) ?? 0n,
      onPitch: e > 0n,
      frozen: e === 0n,
      tradable: true,
    });
  }
  return views;
}

async function handleEvent(
  ctx: Ctx,
  agents: AgentHandle[],
  cards: Address[],
  ev: MatchEvent,
  kickoff: Map<Address, bigint>,
  previous: Map<Address, bigint>,
  now: Map<Address, bigint>,
): Promise<void> {
  console.log(`\n${ev.minute}' ${EventType[ev.type]}  [${ev.players.join(", ")}]`);

  const market = await buildMarket(ctx, cards, kickoff, previous, now);

  /**
   * Notice a mandate changing, and act on it on this event rather than the next
   * order the strategy happens to want.
   *
   * Revoke is the beat where the permission system is the point, and waiting for
   * a template to independently decide to trade turns a one-line demo into an
   * open-ended wait. So every event — heartbeats included — re-reads
   * authorization, and an agent that has just lost it attempts one order anyway.
   * The attempt is meant to fail: the revert is the evidence.
   */
  for (const agent of agents) {
    const authorized = await ctx.publicClient.readContract({
      address: ctx.deployment.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "isAuthorized",
      args: [agent.account.address, ctx.fixture.fixtureId, cards[0]!, 1_000_000n],
    });
    if (agent.authorized === undefined) {
      agent.authorized = Boolean(authorized);
      continue;
    }
    if (agent.authorized && !authorized) {
      agent.authorized = false;
      console.log(`  ${agent.fqdn}: authorization withdrawn — probing once`);
      const probe = market.find((v) => (v.referencePrice ?? 0n) > 0n) ?? market[0];
      if (probe) {
        try {
          await ctx.publicClient.simulateContract({
            address: ctx.deployment.whistleHook,
            abi: whistleHookAbi,
            functionName: "queueOrder",
            args: [ctx.fixture.fixtureId, probe.card, Side.BUY, 10n ** 18n, 1000, false],
            account: agent.account,
          });
          console.log(`    unexpected: the order would still be accepted`);
        } catch (err) {
          const why = revertName(err) ?? "reverted";
          console.log(`    queueOrder reverts: ${why}`);

          /*
           * File the refusal under the agent's own name.
           *
           * A reverted `queueOrder` emits nothing, so there is no log row for
           * the UI to index and no way to show "it tried and was stopped" from
           * chain history alone. The agent can still say so itself: `revokeAgent`
           * revokes only ROLE_SET_RESOLVER on the registry, never the per-key
           * `setText` grants on the agent's own resolver, so a cut-off agent
           * keeps exactly enough authority to report that it was cut off.
           * Verified on a fork — `isAuthorized` false, registration status 0,
           * and both writes still land.
           *
           * This is the agent's testimony, not the chain's judgement, and the UI
           * labels it that way.
           */
          await writeEns(ctx, agent, "last-action", `refused: mandate revoked · ${ev.minute}'`);
          await writeEns(ctx, agent, "status", "revoked");
        }
      }
    } else if (!agent.authorized && authorized) {
      agent.authorized = true;
      console.log(`  ${agent.fqdn}: authorization restored`);
    }
  }

  for (const agent of agents) {
    if (agent.authorized === false) continue;
    const template = templateById(agent.templateId);

    const holdings = new Map<Address, bigint>();
    for (const view of market) {
      holdings.set(
        view.card,
        await ctx.publicClient.readContract({
          address: view.card,
          abi: playerCardAbi,
          functionName: "balanceOf",
          args: [agent.account.address],
        }),
      );
    }

    const usdc = await ctx.publicClient.readContract({
      address: ctx.deployment.usdc,
      abi: mockUsdcAbi,
      functionName: "balanceOf",
      args: [agent.account.address],
    });
    const remainingCapUsdc = await ctx.publicClient.readContract({
      address: ctx.deployment.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "remainingCap",
      args: [agent.account.address],
    });

    /*
     * The decision itself lives in `evaluate` so that this process and the
     * browser-driven `/api/sim/step` cannot drift apart on what an agent would
     * do. Everything above this line is chain reading; everything below is
     * sending. Only the middle is the strategy.
     */
    const intents = evaluate(
      template,
      {
        address: agent.account.address,
        templateId: agent.templateId,
        // The loop already skipped every agent whose mandate is known dead, and
        // it does so BEFORE the balance reads — an unauthorised agent should not
        // cost four RPC calls to decide nothing. `undefined` means the baseline
        // has not been taken yet, which has always been allowed through.
        authorized: true,
        holdings,
        usdc,
        remainingCapUsdc,
      },
      ev,
      market,
    );

    for (const intent of intents) await queue(ctx, agent, intent);
  }
}

/**
 * Place an order. The three refusals a live mandate produces are handled here and
 * nowhere else, so the templates never have to know that ENS exists.
 */
async function queue(ctx: Ctx, agent: AgentHandle, intent: Intent): Promise<void> {
  const label = `${agent.fqdn} ${Side[intent.side]} ${intent.units / 10n ** 18n} ${intent.reason}`;

  try {
    const { request, result } = await ctx.publicClient.simulateContract({
      address: ctx.deployment.whistleHook,
      abi: whistleHookAbi,
      functionName: "queueOrder",
      args: [
        ctx.fixture.fixtureId,
        intent.card,
        intent.side,
        intent.units,
        ctx.opts.slippageBps,
        false,
      ],
      account: agent.account,
    });

    const hash = await agent.wallet.writeContract(request);
    await confirm(ctx.publicClient, hash);

    agent.pending.set(result, intent);
    agentBeat?.bump("queued");
    console.log(`  queued #${result}  ${label}`);
    console.log(`    tx ${hash}`);
  } catch (err) {
    const reason = revertName(err);
    if (reason === "Unauthorized") {
      // The mandate is gone or never covered this. Not an error in the runtime —
      // it is the permission system doing its job.
      console.log(`  refused  ${agent.fqdn}: mandate does not cover this order`);
      await writeEns(ctx, agent, "status", "revoked");
      return;
    }
    if (reason === "WouldExceedHolderCap") {
      console.log(`  refused  ${agent.fqdn}: would breach the 5% holder cap`);
      return;
    }
    if (reason === "NotLive") {
      console.log(`  refused  ${agent.fqdn}: fixture is not LIVE`);
      return;
    }
    if (reason === "UnknownCard" || reason === "FixtureMismatch") {
      console.log(`  refused  ${agent.fqdn}: ${intent.card} is not a tradable market`);
      return;
    }
    console.error(`  error    ${agent.fqdn}: ${reason ?? (err as Error).message.split("\n")[0]}`);
  }
}

/** viem wraps reverts; dig out the custom error name if there is one. */
function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError) {
    return revert.data?.errorName ?? revert.reason;
  }
  return undefined;
}

async function onCancelled(
  ctx: Ctx,
  agents: AgentHandle[],
  orderId: bigint,
  reason: CancelReason,
  _cards: Address[],
): Promise<void> {
  for (const agent of agents) {
    const intent = agent.pending.get(orderId);
    if (!intent) continue;
    agent.pending.delete(orderId);
    agent.cancelled += 1;

    console.log(`  cancelled #${orderId}  ${agent.fqdn}  ${CancelReason[reason]}`);

    if (reason === CancelReason.REVOKED || reason === CancelReason.UNAUTHORIZED) {
      await writeEns(ctx, agent, "status", "revoked");
      await writeEns(ctx, agent, "last-action", `order ${orderId} cancelled: ${CancelReason[reason]}`);
      return;
    }

    if (reason === CancelReason.PRICE_MOVED) {
      // Re-queue ONCE, and only if the condition that produced the order still
      // holds. Retrying blindly would turn a moving price into an order storm.
      if (agent.requeued.has(orderId)) {
        console.log(`    already re-queued once; standing down`);
        return;
      }
      agent.requeued.add(orderId);

      const stillAuthorized = await ctx.publicClient.readContract({
        address: ctx.deployment.agentRegistry,
        abi: agentRegistryAbi,
        functionName: "isAuthorized",
        args: [agent.account.address, ctx.fixture.fixtureId, intent.card, 0n],
      });
      if (!stillAuthorized) {
        console.log(`    mandate no longer covers it; standing down`);
        return;
      }

      console.log(`    re-queueing once at the new price`);
      await queue(ctx, agent, intent);
      return;
    }

    // INSUFFICIENT_INVENTORY: the book could not fill it. Nothing to retry.
    await writeEns(ctx, agent, "last-action", `order ${orderId}: ${CancelReason[reason]}`);
  }
}

async function onFilled(
  agents: AgentHandle[],
  orderId: bigint,
  units: bigint,
  usdcAmount: bigint,
  _chain: ReturnType<typeof connect>["chain"],
): Promise<void> {
  for (const agent of agents) {
    const intent = agent.pending.get(orderId);
    if (!intent) continue;
    agent.pending.delete(orderId);
    agent.filled += 1;
    console.log(
      `  filled #${orderId}  ${agent.fqdn}  ${units / 10n ** 18n} units for ${fromUsdc(usdcAmount)} USDC`,
    );
    pendingEnsWrites.push({ agent, intent, units, usdcAmount });
  }
}

/**
 * Fills arrive inside a log callback, where an await on a transaction would stall
 * the watcher. They are drained here instead.
 */
const pendingEnsWrites: {
  agent: AgentHandle;
  intent: Intent;
  units: bigint;
  usdcAmount: bigint;
}[] = [];

/**
 * Write a text record to the agent's OWN resolver, signed by the agent key.
 *
 * This is the role the user granted in `createAgent` being used for real: the
 * agent may write `last-action`, `status` and `pnl-live` on its own resolver and
 * nothing else. A `setText` for `spend-cap` from this key reverts, which is the
 * whole point of the split.
 */
async function writeEns(ctx: Ctx, agent: AgentHandle, key: string, value: string): Promise<void> {
  try {
    const hash: Hash = await agent.wallet.writeContract({
      address: agent.resolver,
      abi: permissionedResolverAbi,
      functionName: "setText",
      args: [agent.dnsName, key, value.slice(0, 200)],
      chain: ctx.chain,
      account: agent.account,
    });
    await confirm(ctx.publicClient, hash);
    console.log(`    ens ${agent.fqdn} ${key} = "${value}"`);
    console.log(`    tx  ${hash}`);
  } catch (err) {
    console.error(`    ens write failed (${key}): ${revertName(err) ?? (err as Error).message.split("\n")[0]}`);
  }
}

/** Drain the fill queue, writing `last-action` and `status` for each. */
async function drainEnsWrites(ctx: Ctx): Promise<void> {
  while (pendingEnsWrites.length > 0) {
    const item = pendingEnsWrites.shift();
    if (!item) return;
    await writeEns(
      ctx,
      item.agent,
      "last-action",
      `${item.intent.reason} (${item.units / 10n ** 18n} units, ${fromUsdc(item.usdcAmount)} USDC)`,
    );
    await writeEns(ctx, item.agent, "status", "active");
  }
}

/**
 * Set once `main` has wired everything up. The drain timer below needs it, and
 * fills arrive from a log callback that must not block on a transaction.
 */
let cachedCtx: Ctx | undefined;

/** Set by `main`; the log callbacks below count against it. */
let agentBeat: Heartbeat | undefined;

// Kept out of the watcher callbacks so a slow ENS write never stalls event handling.
setInterval(() => {
  if (cachedCtx) void drainEnsWrites(cachedCtx);
}, 3_000).unref();

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

export { queue, writeEns };
