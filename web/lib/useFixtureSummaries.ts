"use client";

/**
 * One row of numbers per fixture, for the fixture list.
 *
 * All from the chain: state, clock and order delay from `MatchOracle.fixtures`,
 * the pot, the connected wallet's holdings (at the reference price, or at the
 * payout once settled), the score and the latest notable event from
 * `MatchEvent` logs, and — for a settled fixture — the best and worst card
 * against its pre-match price.
 *
 * "Pre-match price" is `referencePrice` read at the block before `kickoff`,
 * which is exactly what a pre-match mint paid. The settlement screen's MOVE
 * uses a volume-weighted cost basis from every mint instead; that is a full log
 * scan per card, fine for one fixture and too heavy for a list, so the list
 * says "against the pre-match price". The payout is the realised rate from
 * `Redeemed` where anyone has redeemed, because `payoutPerUnit` drifts once
 * the pot starts paying out.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, PublicClient } from "viem";
import { useAccount, usePublicClient } from "wagmi";

import { FIXTURES, type FixtureDeployment } from "./fixtures";
import { scanLogs } from "./logs";
import { squadPlayer } from "./squad";
import { matchOracleAbi, playerCardAbi, settlementPotAbi, whistleHookAbi } from "../vendor/oracle/abi";

const WAD = 10n ** 18n;
const TYPES = ["HEARTBEAT", "GOAL", "YELLOW", "RED", "SUB"] as const;

export interface Mover {
  name: string;
  pct: number;
}

export interface FixtureSummary {
  D: FixtureDeployment;
  state: number;
  clock: number;
  orderDelayL: number;
  pot: bigint;
  /** This wallet's cards, valued at the reference price (or the payout once settled). 6dp. */
  youHold: bigint;
  /** Settled only: what this wallet can still redeem. 6dp. */
  toRedeem: bigint;
  pooled: number;
  score: { home: number; away: number } | null;
  /** Latest non-heartbeat event, e.g. "66' RED Abidal". */
  latest: string | null;
  winner: Mover | null;
  loser: Mover | null;
}

type EventLog = { blockNumber: bigint; args: Record<string, unknown> };

async function summarise(pc: PublicClient, D: FixtureDeployment, holder: Address | undefined): Promise<FixtureSummary> {
  const FIX = BigInt(D.fixtureId);
  const fx = (await pc.readContract({ address: D.matchOracle, abi: matchOracleAbi, functionName: "fixtures", args: [FIX] })) as readonly unknown[];
  const state = Number(fx[1]);
  const count = Number(fx[3]);
  const ids = Array.from({ length: count }, (_, i) => i);
  const cards = (await pc.multicall({
    contracts: ids.map((i) => ({ address: D.matchOracle, abi: matchOracleAbi, functionName: "cardOf" as const, args: [FIX, i] as const })),
    allowFailure: false,
  })) as Address[];

  const [pot, prices, balances, registered] = await Promise.all([
    pc.readContract({ address: D.settlementPot, abi: settlementPotAbi, functionName: "potBalance" }) as Promise<bigint>,
    pc.multicall({
      contracts: cards.map((c) => ({
        address: D.settlementPot, abi: settlementPotAbi,
        functionName: (state === 2 ? "payoutPerUnit" : "referencePrice") as "referencePrice", args: [c] as const,
      })),
      allowFailure: true,
    }),
    holder
      ? pc.multicall({
          contracts: cards.map((c) => ({ address: c, abi: playerCardAbi, functionName: "balanceOf" as const, args: [holder] as const })),
          allowFailure: true,
        })
      : Promise.resolve([] as { status: string; result?: unknown }[]),
    state === 0
      ? pc.multicall({
          contracts: cards.map((c) => ({ address: D.whistleHook, abi: whistleHookAbi, functionName: "cardInfo" as const, args: [c] as const })),
          allowFailure: true,
        })
      : Promise.resolve([] as { status: string; result?: unknown }[]),
  ]);
  const price = (i: number) => (prices[i]?.status === "success" ? (prices[i]!.result as bigint) : 0n);
  const bal = (i: number) => (balances[i]?.status === "success" ? (balances[i]!.result as bigint) : 0n);

  // History: score, latest notable event, and (settled) kickoff block + realised payouts.
  let score: FixtureSummary["score"] = null;
  let latest: string | null = null;
  let winner: Mover | null = null;
  let loser: Mover | null = null;
  const realised = new Map<string, bigint>();
  if (state !== 0) {
    try {
      // The app's own scanner: backs off on 429s, narrows on range errors, caches.
      const from = BigInt(D.deployBlock ?? 0);
      const scanned = await scanLogs<EventLog>(pc, from, { address: D.matchOracle, abi: matchOracleAbi as never, eventName: "MatchEvent", args: { fixtureId: FIX } });
      if (scanned.failed > 0) throw new Error("match history incomplete");
      const events = scanned.logs as unknown as { args: { minute?: number; eventType?: number; playerIds?: readonly number[] } }[];
      score = { home: 0, away: 0 };
      for (const e of events) {
        const t = Number(e.args.eventType);
        const players = (e.args.playerIds ?? []).map(Number);
        if (t === 1 && players[0] !== undefined) {
          const team = squadPlayer(players[0])?.team;
          if (team === 0) score.home++;
          else if (team === 1) score.away++;
        }
        if (t !== 0) {
          const who = players[0] !== undefined ? squadPlayer(players[0])?.name.split(" ").slice(-1)[0] : undefined;
          latest = `${e.args.minute}' ${TYPES[t]}${who ? ` ${who}` : ""}`;
        }
      }
      if (state === 2) {
        const [kickedScan, redeemedScan] = await Promise.all([
          scanLogs<EventLog>(pc, from, { address: D.matchOracle, abi: matchOracleAbi as never, eventName: "KickedOff", args: { fixtureId: FIX } }),
          scanLogs<EventLog>(pc, from, { address: D.settlementPot, abi: settlementPotAbi as never, eventName: "Redeemed" }),
        ]);
        const kicked = kickedScan.logs;
        const redeemed = redeemedScan.logs as unknown as { args: { card?: Address; units?: bigint; payoutUSDC?: bigint } }[];
        for (const r of redeemed) {
          if (r.args.units && r.args.units > 0n && r.args.card) realised.set(r.args.card.toLowerCase(), (r.args.payoutUSDC! * WAD) / r.args.units);
        }
        const kick = kicked[0]?.blockNumber;
        if (kick) {
          const pre = await pc.multicall({
            contracts: cards.map((c) => ({ address: D.settlementPot, abi: settlementPotAbi, functionName: "referencePrice" as const, args: [c] as const })),
            allowFailure: true,
            blockNumber: kick - 1n,
          });
          const moves: Mover[] = [];
          cards.forEach((c, i) => {
            const p0 = pre[i]?.status === "success" ? (pre[i]!.result as bigint) : 0n;
            const paid = realised.get(c.toLowerCase()) ?? price(i);
            const sp = squadPlayer(i);
            if (p0 > 0n && sp && (sp.starter || paid > 0n)) {
              moves.push({ name: sp.name.split(" ").slice(-1)[0] ?? sp.name, pct: (Number(paid) / Number(p0) - 1) * 100 });
            }
          });
          moves.sort((a, b) => b.pct - a.pct);
          winner = moves[0] ?? null;
          loser = moves[moves.length - 1] ?? null;
        }
      }
    } catch {
      /* history is decoration here; the row still reads without it */
    }
  }

  let youHold = 0n;
  let toRedeem = 0n;
  cards.forEach((c, i) => {
    const b = bal(i);
    if (b === 0n) return;
    const rate = state === 2 ? (realised.get(c.toLowerCase()) ?? price(i)) : price(i);
    const v = (rate * b) / WAD;
    if (state === 2) toRedeem += v;
    else youHold += v;
  });

  const pooledFromFile = (D as { tradedPlayerIds?: number[] }).tradedPlayerIds?.length;
  const pooled = state === 0
    ? registered.filter((r) => r.status === "success" && (r.result as { registered: boolean }).registered).length
    : (pooledFromFile ?? 0);

  return {
    D, state, clock: Number(fx[2]), orderDelayL: Number(fx[4]), pot,
    youHold, toRedeem, pooled, score, latest, winner, loser,
  };
}

/** Every listed fixture's row, refreshed every 10 s (the list is an overview, not a clock). */
export function useFixtureSummaries(refreshMs = 10_000) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [rows, setRows] = useState<Map<string, FixtureSummary>>(new Map());
  const [loaded, setLoaded] = useState(false);

  // Only the newest load may write: a load started before the wallet connected
  // can finish after the one that knows the address, and would zero YOU HOLD.
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!publicClient) return;
    const mine = ++seq.current;
    const results = await Promise.allSettled(FIXTURES.map((D) => summarise(publicClient as PublicClient, D, address)));
    if (mine !== seq.current) return;
    setRows((prev) => {
      const next = new Map(prev);
      results.forEach((r, i) => {
        if (r.status === "fulfilled") next.set(FIXTURES[i]!.fixtureId, r.value);
        else console.warn(`[fixtures] ${FIXTURES[i]!.fixtureId}: ${String(r.reason).split("\n")[0]}`);
      });
      return next;
    });
    setLoaded(true);
  }, [publicClient, address]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);

  return { rows, loaded };
}
