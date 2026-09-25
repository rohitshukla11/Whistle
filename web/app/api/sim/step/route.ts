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
import { BaseError, ContractFunctionRevertedError, formatUnits, type Address, type Hash } from "viem";

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
import { EventType, Side } from "../../../../vendor/oracle/types";
import { minuteOf, etaSeconds, type Clock, type Speed } from "../../../../lib/sim/clock";
import { resolveFixture, type SimDeployment } from "../../../../lib/sim/deployment";
import { EVENTS, LAST_MINUTE, describeEvent, expectedFinalScores, nextEventAfter, nextEventGroup } from "../../../../lib/sim/match";
import { agentAccounts, checkOperator, keeperAccount, oracleAccount, publicClient, signerBusy, walletFor } from "../../../../lib/sim/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Gas ceilings for the oracle's writes.
 *
 * Every event in a minute-group is sent in one step with explicit nonces, so
 * each one's estimate is taken BEFORE the earlier events in its group apply —
 * against the wrong state. A substitution estimated 2,800 gas short ran out of
 * gas on a fork, and because the next lookup asks for the first minute after
 * the chain's clock, the reverted substitution was skipped for good. A fixed
 * ceiling is free (unused gas is not charged) and removes that failure.
 */
const POST_EVENT_GAS = 1_000_000n;
const POST_FINAL_GAS = 3_000_000n;

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

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* optional */
  }

  const D = resolveFixture(body.fixtureId);
  if (!D) return NextResponse.json({ error: `Unknown fixture ${String(body.fixtureId)}.` }, { status: 404 });
  const auth = await checkOperator(req, D);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
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

  /*
   * Read the clock at a block that has seen our last write.
   *
   * The cursor through the match is the oracle's own minute, so a read served
   * by an RPC node that is a block behind sees the minute before the event we
   * just posted — and posts that group AGAIN. `postEvent` accepts
   * `minute == clock`, so the duplicate applies: fixture A's 9' goal was
   * credited twice (Essien 34 on chain against 22 derived) and `postFinal`
   * reverted `FinalScoreMismatch` at 93'. So every state read in a step is pinned
   * to one block number at or after the newest receipt this match has seen —
   * the ones being checked now, and `minBlock`, which the browser carries.
   */
  const checkTxs = Array.isArray(body.checkTxs)
    ? (body.checkTxs as unknown[]).filter((h): h is Hash => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h))
    : [];
  const receipts = await Promise.all(checkTxs.map((h) => pc.getTransactionReceipt({ hash: h }).catch(() => null)));
  let floor = /^\d+$/.test(String(body.minBlock ?? "")) ? BigInt(String(body.minBlock)) : 0n;
  for (const rc of receipts) if (rc && rc.blockNumber > floor) floor = rc.blockNumber;
  const head = await pc.getBlockNumber({ cacheTime: 0 });
  const readAt = head > floor ? head : floor;
  let fixture: readonly unknown[];
  try {
    fixture = (await pc.readContract({
      address: D.matchOracle, abi: matchOracleAbi, functionName: "fixtures", args: [FIXTURE], blockNumber: readAt,
    })) as readonly unknown[];
  } catch {
    return NextResponse.json(
      { error: `the RPC has not caught up with block ${readAt} yet — retrying`, minBlock: floor.toString(), pendingTxs: checkTxs },
      { status: 503 },
    );
  }
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
    /** The newest block this match is known to have written in; the browser sends it back. */
    minBlock: floor.toString(),
  };

  /*
   * Never move past a transaction nobody has checked.
   *
   * The browser hands back the hashes the previous step sent. Until each has a
   * receipt the match waits; if any reverted, the match STOPS with the reason
   * on screen. The cursor is the chain's clock, so a silently reverted event
   * is not retried — it is skipped, and the damage only shows at `postFinal`.
   * Stateless, like everything else here: the client carries the hashes.
   */
  for (const [i, h] of checkTxs.entries()) {
    const rc = receipts[i];
    if (!rc) {
      return NextResponse.json({ ...base, pendingTxs: checkTxs, note: "waiting for inclusion — confirming the last step" });
    }
    if (rc.status !== "success") {
      // A reverted postFinal is not a reason to stop: the FINAL branch below
      // re-simulates and falls back to the chain's own scores.
      if (!next && chainState === 1) {
        console.error(`[sim] postFinal ${h} reverted on chain; retrying through the FINAL fallback`);
        continue;
      }
      return NextResponse.json(
        {
          ...base,
          reverted: h,
          error:
            `A transaction from the last step REVERTED on chain (${h.slice(0, 10)}…, gas ${rc.gasUsed}). ` +
            `The match is stopped so that nothing is skipped — check it on the explorer before resuming.`,
        },
        { status: 409 },
      );
    }
  }

  if (chainState === 2) return NextResponse.json({ ...base, note: "full time — the fixture is settled" });
  if (chainState === 0) return NextResponse.json({ ...base, note: "not kicked off" });
  if (!clock.running) return NextResponse.json({ ...base, note: `paused at ${Math.floor(minuteOf(clock))}'` });

  // ---------------------------------- the agents react to what just happened
  /*
   * After a real event lands, the agents move before anything else is posted.
   *
   * They used to act only when a step had nothing else to do, and in a
   * compressed match that moment never follows a goal: by then the next
   * heartbeat is due, it gets posted first, and the templates — which sit
   * heartbeats out — never see the goal. A whole fixture ran on a fork with no
   * agent trading at all. So the latest non-heartbeat event gets exactly one
   * agent pass, ahead of the next post. Stateless like the rest: the browser
   * carries the minute the agents last acted on (`agentsActedAt`, part of the
   * clock) and this returns the new one.
   */
  const actedAt = Number.isFinite(Number(body.agentsActedAt)) ? Number(body.agentsActedAt) : -1;
  const lastReal = [...EVENTS].reverse().find((e) => e.minute <= chainMinute && e.type !== EventType.HEARTBEAT);
  if (lastReal && lastReal.minute > actedAt && agentAccounts(D.fixtureId).length > 0) {
    const placed = await runAgents(pc, D, lastReal, playerCount).catch((err: unknown) => {
      console.warn(`[sim] agent pass skipped: ${(err as Error).message.split("\n")[0]}`);
      return [];
    });
    return NextResponse.json({
      ...base,
      agentsActed: lastReal.minute,
      agentOrders: placed,
      note: placed.length
        ? `${placed.length} agent order${placed.length === 1 ? "" : "s"} queued after ${describeEvent(lastReal)}`
        : `agents weighed ${describeEvent(lastReal)} — no orders`,
    });
  }

  // ------------------------------------------------ post the next due event
  if (next) {
    if (next.minute <= minuteOf(clock)) {
      const oracle = oracleAccount();
      if (await signerBusy(pc, oracle.address)) {
        return NextResponse.json({ ...base, note: `waiting for inclusion — the oracle has a transaction in flight` });
      }
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
      const sent: Hash[] = [];
      for (const ev of group) {
        hash = await wallet.writeContract({
          address: D.matchOracle, abi: matchOracleAbi, functionName: "postEvent",
          args: [FIXTURE, ev.minute, ev.type, ev.players, stamp], chain: null, account: oracle,
          nonce: nonce++,
          gas: POST_EVENT_GAS,
        });
        sent.push(hash);
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
        sent,
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
      if (await signerBusy(pc, keeper.address)) {
        return NextResponse.json({
          ...base, note: `waiting for inclusion — the keeper has a transaction in flight · tick ${head}/${queued} next`,
        });
      }
      const hash = await walletFor(keeper).writeContract({
        address: D.whistleHook, abi: whistleHookAbi, functionName: "tick",
        args: [FIXTURE, TICK_CARDS, TICK_PAGE], chain: null, account: keeper,
      });
      return NextResponse.json({
        ...base, lastTx: { hash, what: `tick ${head}/${queued}` }, sent: [hash],
        note: `filling orders — tick ${head}/${queued}`,
      });
    }

    // ------------------------------------------------------- the agents act
    const latest = [...EVENTS].reverse().find((e) => e.minute <= chainMinute);
    if (latest && agentAccounts(D.fixtureId).length > 0) {
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
  if (await signerBusy(pc, oracle.address)) {
    return NextResponse.json({ ...base, note: "waiting for the last event to land before posting final scores" });
  }

  /*
   * Never strand at 93'.
   *
   * The derived scores are a cross-check, not the payout: the pot settles on its
   * own numbers either way. So the derived array is simulated first, and on
   * `FinalScoreMismatch` the mismatch is logged loudly — it means the chain saw
   * a different match from the fixture file, which is a sim bug to chase — and
   * the fixture settles with an empty array, the contract's "skip the check".
   * Any other revert is reported and nothing is sent.
   */
  let expected: readonly bigint[] = expectedFinalScores();
  let mismatch: { playerId: number; computed: string; derived: string } | null = null;
  try {
    await pc.simulateContract({
      address: D.matchOracle, abi: matchOracleAbi, functionName: "postFinal", args: [FIXTURE, expected], account: oracle,
    });
  } catch (err) {
    const reverted = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === "FinalScoreMismatch") {
      const [playerId, computed, derived] = reverted.data.args as [number, bigint, bigint];
      mismatch = { playerId: Number(playerId), computed: formatUnits(computed, 18), derived: formatUnits(derived, 18) };
      console.error(
        `[sim] !!! FINAL SCORE MISMATCH on fixture ${D.fixtureId}: player #${mismatch.playerId} chain ${mismatch.computed}, ` +
          `derived ${mismatch.derived}. The chain applied a different event list from the fixture file. ` +
          `Settling with an empty expectedS[] so the pot's own scores stand.`,
      );
      expected = [];
    } else {
      const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
      return NextResponse.json({ ...base, error: `postFinal would revert: ${reason}` }, { status: 409 });
    }
  }
  const hash = await walletFor(oracle).writeContract({
    address: D.matchOracle, abi: matchOracleAbi, functionName: "postFinal",
    args: [FIXTURE, expected], chain: null, account: oracle, gas: POST_FINAL_GAS,
  });
  return NextResponse.json({
    ...base,
    lastTx: { hash, what: mismatch ? "postFinal (chain scores)" : "postFinal" },
    sent: [hash],
    ...(mismatch ? { finalMismatch: mismatch } : {}),
    note: mismatch
      ? `FINAL SCORE MISMATCH — player #${mismatch.playerId}: chain ${mismatch.computed}, sim ${mismatch.derived}. Settling on the chain's own scores.`
      : "full time — posting final scores",
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
  for (const account of agentAccounts(D.fixtureId)) {
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
      } catch (err) {
        // Refused — usually by the mandate, which is the system working. Logged,
        // because a refusal for any other reason looks identical from the panel.
        console.warn(`[sim] ${account.address.slice(0, 8)} ${intent.reason}: refused — ${String(err).split("\n")[0].slice(0, 200)}`);
      }
    }
  }
  return out;
}
