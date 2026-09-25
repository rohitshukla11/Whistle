/**
 * One unit of work, then return. The server remembers nothing.
 *
 * The first version kept the operator's intent in Vercel KV or a file in the OS
 * temp directory. On Vercel that is wrong: each invocation can land on a
 * different instance and the file is not shared, so a match would silently
 * forget it was running. The KV path fixed that and was never exercised.
 *
 * So there is no server state at all now. The browser is already the clock — it
 * is the thing that knows whether Pause has been pressed — so it sends the clock
 * with every call, and everything else is read from the chain:
 *
 *   - the cursor through the match is the oracle's own minute, so the next event
 *     is simply the first one in the fixture file after it;
 *   - an event is confirmed when the chain's minute reaches it, which needs no
 *     receipt and no bookkeeping;
 *   - the queue is the queue.
 *
 * That makes two steps racing, a double-click, a retried request, a reload and
 * a cold instance all the same case. It also makes local and Vercel identical,
 * which was the point.
 */

import { NextResponse } from "next/server";
import type { Address, Hash } from "viem";

import { evaluate } from "../../../../vendor/agent/evaluate";
import { templateById } from "../../../../vendor/agent/templates/index";
import {
  agentRegistryAbi,
  matchOracleAbi,
  mockUsdcAbi,
  playerCardAbi,
  settlementPotAbi,
  whistleHookAbi,
} from "../../../../vendor/oracle/abi";
import { Side } from "../../../../vendor/oracle/types";
import { minuteOf, etaSeconds, type Clock, type Speed } from "../../../../lib/sim/clock";
import { resolveFixture, type SimDeployment } from "../../../../lib/sim/deployment";
import { EVENTS, LAST_MINUTE, describeEvent, expectedFinalScores, nextEventAfter, nextEventGroup } from "../../../../lib/sim/match";
import { agentAccounts, checkToken, keeperAccount, oracleAccount, publicClient, walletFor } from "../../../../lib/sim/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/** Enough orders per tick to clear a busy minute, small enough to stay in budget. */
const TICK_CARDS = 4n;
const TICK_PAGE = 8n;

export async function POST(req: Request) {
  try {
    return await step(req);
  } catch (err) {
    // The panel's status line is the only thing the operator can see. An HTML
    // error page would blank it mid-demo; a sentence keeps them informed.
    const message = (err as Error).message?.split("\n")[0] ?? String(err);
    console.error("[sim] step failed:", err);
    return NextResponse.json({ error: `Step failed: ${message}` }, { status: 500 });
  }
}

async function step(req: Request) {
  const auth = checkToken(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* optional */
  }

  const D = resolveFixture(body.fixtureId);
  if (!D) return NextResponse.json({ error: `Unknown fixture ${String(body.fixtureId)}.` }, { status: 404 });
  const FIXTURE = BigInt(D.fixtureId);

  // The clock arrives with the request. Nothing about it is remembered.
  const clock: Clock = {
    running: body.running === true,
    speed: (Number(body.speed) === 6 ? 6 : 3) as Speed,
    originMs: Number(body.originMs) || Date.now(),
    originMinute: Number(body.originMinute) || 0,
    ...(Number.isFinite(Number(body.skipTo)) && Number(body.skipTo) > 0 ? { skipTo: Number(body.skipTo) } : {}),
  };

  const pc = publicClient();
  const fixture = (await pc.readContract({
    address: D.matchOracle, abi: matchOracleAbi, functionName: "fixtures", args: [FIXTURE],
  })) as readonly unknown[];
  const chainState = Number(fixture[1]);
  const chainMinute = Number(fixture[2]);
  const playerCount = Number(fixture[3]);

  const next = nextEventAfter(chainMinute);
  const base = {
    fixtureId: D.fixtureId,
    chainState,
    chainMinute,
    simMinute: Math.floor(minuteOf(clock) * 10) / 10,
    nextEvent: next ? { minute: next.minute, label: describeEvent(next) } : null,
    eventsPosted: EVENTS.filter((e) => e.minute <= chainMinute).length,
    eventsTotal: EVENTS.length,
    lastMinute: LAST_MINUTE,
    lastTx: null as { hash: Hash; what: string } | null,
    tickInfo: null as { head: string; queued: string } | null,
    agentOrders: [] as { hash: Hash; what: string }[],
  };

  if (chainState === 2) return NextResponse.json({ ...base, note: "full time — the fixture is settled" });
  if (chainState === 0) return NextResponse.json({ ...base, note: "not kicked off" });
  if (!clock.running) return NextResponse.json({ ...base, note: `paused at ${Math.floor(minuteOf(clock))}'` });

  // ------------------------------------------------ post the next due event
  if (next) {
    if (next.minute <= minuteOf(clock)) {
      const oracle = oracleAccount();
      const wallet = walletFor(oracle);
      const stamp = (await pc.getBlock({ blockTag: "latest" })).timestamp;

      /*
       * The whole minute, in one step, with explicit nonces.
       *
       * `postEvent` permits `minute == clock` — it has to, or two events in the
       * same minute could not both be posted — which means a duplicate at the
       * CURRENT minute is applied twice rather than rejected. So this must not
       * be split across steps: a second step that re-read the same clock would
       * re-apply the group. One tab drives one match; that is the assumption,
       * and the client serialises its own calls to hold it.
       */
      const group = nextEventGroup(chainMinute);
      let nonce = await pc.getTransactionCount({ address: oracle.address, blockTag: "pending" });
      let hash: Hash = "0x" as Hash;
      for (const ev of group) {
        hash = await wallet.writeContract({
          address: D.matchOracle, abi: matchOracleAbi, functionName: "postEvent",
          args: [FIXTURE, ev.minute, ev.type, ev.players, stamp], chain: null, account: oracle,
          nonce: nonce++,
        });
      }
      /*
       * `posted` tells the browser to re-anchor its clock to this minute.
       *
       * The compressed clock runs in real time; the chain advances one event per
       * call. A 90-minute match at 3x has events due faster than three seconds
       * apart, so without this the clock pulls ahead and never comes back — it
       * read 55' while the oracle was at 40', and every remaining event became
       * "due" at once, which turns pacing into a queue flush.
       */
      return NextResponse.json({
        ...base,
        lastTx: { hash, what: group.map(describeEvent).join(" + ") },
        posted: { minute: next.minute },
        note: `posting ${group.map(describeEvent).join(" + ")}…`,
      });
    }
    // ----------------------------------------------------------- one tick
    const [queued, head] = (await Promise.all([
      pc.readContract({ address: D.whistleHook, abi: whistleHookAbi, functionName: "queueLength", args: [FIXTURE] }),
      pc.readContract({ address: D.whistleHook, abi: whistleHookAbi, functionName: "queueHead", args: [FIXTURE] }),
    ])) as [bigint, bigint];
    base.tickInfo = { head: head.toString(), queued: queued.toString() };

    if (head < queued) {
      const keeper = keeperAccount();
      const hash = await walletFor(keeper).writeContract({
        address: D.whistleHook, abi: whistleHookAbi, functionName: "tick",
        args: [FIXTURE, TICK_CARDS, TICK_PAGE], chain: null, account: keeper,
      });
      return NextResponse.json({
        ...base, lastTx: { hash, what: `tick ${head}/${queued}` }, note: `filling orders — tick ${head}/${queued}`,
      });
    }

    // ------------------------------------------------------- the agents act
    const latest = [...EVENTS].reverse().find((e) => e.minute <= chainMinute);
    if (latest && agentAccounts().length > 0) {
      const placed = await runAgents(pc, D, latest, playerCount).catch((err: unknown) => {
        // Thirty-six cards times four multicalls is the heaviest thing a step
        // does. A slow read must cost this round of decisions, not the match.
        console.warn(`[sim] agent pass skipped: ${(err as Error).message.split("\n")[0]}`);
        return [];
      });
      if (placed.length > 0) {
        return NextResponse.json({
          ...base, agentOrders: placed,
          note: `${placed.length} agent order${placed.length === 1 ? "" : "s"} queued`,
        });
      }
    }

    return NextResponse.json({ ...base, note: `${describeEvent(next)} in ${etaSeconds(clock, next.minute)}s` });
  }

  // ------------------------------------------------------------- full time
  //
  // Every event is on chain. `postFinal` carries the scores derived from the
  // event list alone, so settlement cross-checks this implementation against the
  // contract's own accrual rather than trusting either one.
  const oracle = oracleAccount();
  const hash = await walletFor(oracle).writeContract({
    address: D.matchOracle, abi: matchOracleAbi, functionName: "postFinal",
    args: [FIXTURE, expectedFinalScores()], chain: null, account: oracle,
  });
  return NextResponse.json({
    ...base, lastTx: { hash, what: "postFinal" }, note: "full time — posting final scores",
  });
}

async function runAgents(
  pc: ReturnType<typeof publicClient>,
  D: SimDeployment,
  latest: (typeof EVENTS)[number],
  playerCount: number,
): Promise<{ hash: Hash; what: string }[]> {
  if (playerCount === 0) return [];
  const FIXTURE = BigInt(D.fixtureId);
  const ids = Array.from({ length: playerCount }, (_, i) => i);

  const cards = (await pc.multicall({
    contracts: ids.map((id) => ({
      address: D.matchOracle, abi: matchOracleAbi, functionName: "cardOf" as const, args: [FIXTURE, id] as const,
    })),
    allowFailure: false,
  })) as Address[];

  const [prices, infos, scores] = await Promise.all([
    pc.multicall({
      contracts: cards.map((c) => ({
        address: D.settlementPot, abi: settlementPotAbi, functionName: "referencePrice" as const, args: [c] as const,
      })), allowFailure: false,
    }) as Promise<bigint[]>,
    pc.multicall({
      contracts: cards.map((c) => ({
        address: D.whistleHook, abi: whistleHookAbi, functionName: "cardInfo" as const, args: [c] as const,
      })), allowFailure: true,
    }) as Promise<{ status: string; result?: { registered: boolean } }[]>,
    pc.multicall({
      contracts: ids.map((id) => ({
        address: D.matchOracle, abi: matchOracleAbi, functionName: "expectedScore" as const, args: [FIXTURE, id] as const,
      })), allowFailure: false,
    }) as Promise<bigint[]>,
  ]);

  /*
   * `pricePrevious` is the price now, not the price before the event.
   *
   * The terminal driver posts the event itself and can read either side of it. A
   * step function arrives after the fact, so the honest value is the current
   * one: a template's "how far did this move" reads zero on the event it already
   * missed, and non-zero only on a move it can actually see. Templates are
   * unchanged; they act a step later than the terminal's do.
   */
  const board = ids
    .map((id, i) => ({
      playerId: id, name: `#${id}`, card: cards[i]!, team: 0 as 0 | 1, position: 0,
      referencePrice: prices[i] ?? 0n, priceAtKickoff: prices[i] ?? 0n, pricePrevious: prices[i] ?? 0n,
      onPitch: (scores[i] ?? 0n) > 0n, frozen: (scores[i] ?? 0n) === 0n,
      tradable: infos[i]?.status === "success" && Boolean(infos[i]?.result?.registered),
    }))
    .filter((v) => v.tradable);
  if (board.length === 0) return [];

  const out: { hash: Hash; what: string }[] = [];
  for (const account of agentAccounts()) {
    const [info, authorized, usdc, cap] = await Promise.all([
      pc.readContract({ address: D.agentRegistry, abi: agentRegistryAbi, functionName: "agentInfo", args: [account.address] }).catch(() => null),
      pc.readContract({
        address: D.agentRegistry, abi: agentRegistryAbi, functionName: "isAuthorized",
        args: [account.address, FIXTURE, board[0]!.card, 1_000_000n],
      }).catch(() => false),
      pc.readContract({ address: D.usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [account.address] }).catch(() => 0n),
      pc.readContract({ address: D.agentRegistry, abi: agentRegistryAbi, functionName: "remainingCap", args: [account.address] }).catch(() => 0n),
    ]);
    if (!info) continue;
    const tuple = info as readonly unknown[];
    // [user, registry, resolver, tokenId, fixtureId, templateId, spent, fqdn]
    if ((tuple[4] as bigint) !== FIXTURE) continue;
    const templateId = Number(tuple[5] as bigint);
    if (templateId === 0) continue;

    const balances = (await pc.multicall({
      contracts: board.map((v) => ({
        address: v.card, abi: playerCardAbi, functionName: "balanceOf" as const, args: [account.address] as const,
      })), allowFailure: false,
    })) as bigint[];
    const holdings = new Map<Address, bigint>();
    board.forEach((v, i) => holdings.set(v.card, balances[i] ?? 0n));

    const intents = evaluate(
      templateById(templateId),
      { address: account.address, templateId, authorized: Boolean(authorized), holdings, usdc: usdc as bigint, remainingCapUsdc: cap as bigint },
      { minute: latest.minute, type: latest.type, players: latest.players } as never,
      board as never,
    );

    for (const intent of intents) {
      try {
        // Simulated first: a revoked mandate must revert here, cheaply, rather
        // than burn a transaction to prove the same point.
        const { request } = await pc.simulateContract({
          address: D.whistleHook, abi: whistleHookAbi, functionName: "queueOrder",
          args: [FIXTURE, intent.card, intent.side, intent.units, 1000, false], account,
        });
        const hash = await walletFor(account).writeContract({ ...request, chain: null });
        out.push({ hash, what: `${account.address.slice(0, 8)} ${intent.side === Side.BUY ? "buy" : "sell"} ${intent.reason}` });
      } catch {
        // Refused by the mandate. That is the system working.
      }
    }
  }
  return out;
}
