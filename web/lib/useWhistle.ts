"use client";

/**
 * One hook for every contract read the app makes.
 *
 * Everything on the screens comes from here, so there is exactly one place that
 * knows how to ask the chain a question and one cache to invalidate. The pattern
 * is deliberately plain: a multicall for the per-player table, a small multicall
 * for the fixture header, and viem log watchers that push rather than poll.
 *
 * Nothing polls faster than {POLL_MS}. Match events arrive every few seconds at
 * most, and the expensive read here is a 28-row price table — hammering it buys
 * nothing and makes the fork crawl.
 */

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { usePublicClient } from "wagmi";
import type {Abi, Address, Log } from "viem";

import {
  agentRegistryAbi,
  matchOracleAbi,
  mmVaultAbi,
  playerCardAbi,
  settlementPotAbi,
  whistleHookAbi,
} from "../vendor/oracle/abi";
import { POLL_MS, RPC_IS_DEFAULT, RPC_URL, redactRpc } from "./config";
import { useFixture } from "./fixtures";
import { scanLogs } from "./logs";
import { loadSnapshot } from "./settled";

/** A decoded log as the feed consumes it: a viem log that also carries `args`. */
type FeedLog = Log & { args?: Record<string, unknown> };

export interface PlayerRow {
  id: number;
  card: Address;
  name: string;
  symbol: string;
  team: 0 | 1;
  position: number;
  starter: boolean;
  /** USDC 6dp per whole card. */
  referencePrice: bigint;
  /** WAD. */
  expectedScore: bigint;
  finalScore: bigint;
  minutes: number;
  /** WAD, signed. */
  banked: bigint;
  onPitch: boolean;
  frozen: boolean;
  supply: bigint;
  /**
   * Whether this card has a Uniswap pool and can therefore be traded.
   *
   * Read from the hook rather than inferred from supply: every card in the
   * fixture has supply, but only the ones a beat of the demo touches were given
   * a pool. Without a pool `queueOrder` reverts `UnknownCard`, so the UI has to
   * say "mint only" rather than offer a form that cannot work.
   */
  pooled: boolean;
  /** Set once the fixture settles. */
  payoutPerUnit: bigint;
  preMatchPrice: bigint;
}

/**
 * The price to show, whatever state the fixture is in.
 *
 * `referencePrice` is `Pot * E_i / D`, and once a settled pot has been redeemed
 * both the numerator and the denominator go to dust — the ratio is then numerical
 * noise, not a price. After settlement the meaningful number is the payout the
 * snapshot fixed, so that is what the UI shows.
 */
export function displayPrice(p: PlayerRow, settled: boolean): bigint | undefined {
  if (!settled) return p.referencePrice;
  if (p.payoutPerUnit > 0n) return p.payoutPerUnit;
  return p.finalScore === 0n ? 0n : undefined;
}

/**
 * The score to show beside a price.
 *
 * Not `banked`. Banked points are goals and cards only, so a defender who has
 * played the whole match banks nothing and the board read "0.0 points" next to a
 * 9.01 USDC card. The price is `Pot x E / sum(E)`, so `E` — the expected final
 * score — is the number that explains it, and after full time `E` is final.
 *
 * The UI labels this EXP while the match runs and PTS once it is over.
 */
export function displayScore(p: PlayerRow): bigint {
  return p.finalScore > 0n ? p.finalScore : p.expectedScore;
}

export type PlayerStatus = "on-pitch" | "bench" | "subbed" | "sent-off";

export function statusOf(p: PlayerRow): PlayerStatus {
  if (p.onPitch) return "on-pitch";
  if (!p.frozen) return "bench";
  // A frozen player either walked or was replaced. A red card is the only thing
  // that makes `banked` go negative by exactly the red penalty on its own, so the
  // minutes tell the story better: somebody subbed off keeps their minutes.
  return p.banked < 0n ? "sent-off" : "subbed";
}

export interface FixtureHeader {
  state: number;
  clock: number;
  playerCount: number;
  potBalance: bigint;
  potSnapshot: bigint;
  settled: boolean;
  orderDelayL: number;
  lastEventAt: number;
}

export interface FeedEntry {
  key: string;
  blockNumber: bigint;
  kind: "event" | "batch" | "fill" | "cancel" | "queued";
  label: string;
  detail: string;
}

export interface VaultSummary {
  pnl: bigint;
  feesEarned: bigint;
  marketMakingPnL: bigint;
  inventoryValue: bigint;
  capitalIn: bigint;
}

const ZERO = "0x0000000000000000000000000000000000000000" as const;

export function useWhistle() {
  const { deployment: D, fixtureId } = useFixture();
  /** Pool membership, read once per fixture rather than on every poll. */
  const pooledRef = useRef<Map<Address, boolean>>(new Map());
  const publicClient = usePublicClient();

  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [header, setHeader] = useState<FixtureHeader | null>(null);
  const [vault, setVault] = useState<VaultSummary | null>(null);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  /**
   * Whether the event history was actually read.
   *
   * The goal count comes from `MatchEvent` logs, so "no goals found" and "no
   * logs readable" produce the same empty list. Callers need to tell them apart
   * before printing a score.
   */
  const [feedComplete, setFeedComplete] = useState(false);
  /** Reference prices at the kickoff block: the honest MOVE baseline. */
  const [kickoffPrices, setKickoffPrices] = useState<Map<number, bigint>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /** Static per-player metadata. Read once; it cannot change after finalize. */
  const [meta, setMeta] = useState<
    { id: number; card: Address; name: string; symbol: string; team: 0 | 1; position: number; starter: boolean }[]
  >([]);

  const pushFeed = useCallback((entry: FeedEntry) => {
    setFeed((prev) => (prev.some((e) => e.key === entry.key) ? prev : [entry, ...prev].slice(0, 60)));
  }, []);

  // ---------------------------------------------------------------- metadata

  /**
   * The player table is read once per fixture — so a failure here is permanent.
   *
   * Everything else on every screen hangs off `meta`: `refresh` returns early
   * without it, so one rate-limited multicall at mount used to leave the page
   * reading "Reading the fixture…" for as long as it was open, with a banner no
   * amount of polling would clear. A one-shot read of something this load-bearing
   * has to retry.
   */
  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;

    (async () => {
      for (let attempt = 0; attempt < 5 && !cancelled; attempt += 1) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 1_200 * 2 ** (attempt - 1)));
          if (cancelled) return;
        }
        try {
          const count = await publicClient.readContract({
            address: D.matchOracle,
            abi: matchOracleAbi,
            functionName: "playerCount",
            args: [fixtureId],
          });

          const ids = Array.from({ length: Number(count) }, (_, i) => i);

          const cards = (await publicClient.multicall({
            contracts: ids.map((id) => ({
              address: D.matchOracle,
              abi: matchOracleAbi,
              functionName: "cardOf" as const,
              args: [fixtureId, id] as const,
            })),
            allowFailure: false,
          })) as Address[];

          const configs = (await publicClient.multicall({
            contracts: ids.map((id) => ({
              address: D.matchOracle,
              abi: matchOracleAbi,
              functionName: "playerConfig" as const,
              args: [fixtureId, id] as const,
            })),
            allowFailure: false,
          })) as {
            expectedEventPoints: bigint;
            cleanSheetProb0: bigint;
            expectedMinutes: number;
            team: number;
            position: number;
            starter: boolean;
          }[];

          const names = (await publicClient.multicall({
            contracts: cards.map((card) => ({
              address: card,
              abi: playerCardAbi,
              functionName: "name" as const,
            })),
            allowFailure: false,
          })) as string[];

          const symbols = (await publicClient.multicall({
            contracts: cards.map((card) => ({
              address: card,
              abi: playerCardAbi,
              functionName: "symbol" as const,
            })),
            allowFailure: false,
          })) as string[];

          // Which cards have a pool is fixed for the fixture's life — registering a
          // card is a one-off operator call — so it is read with the rest of the
          // static metadata rather than on every four-second poll.
          const pooled = (await publicClient.multicall({
            contracts: ids.map((id) => ({
              address: D.whistleHook,
              abi: whistleHookAbi,
              functionName: "cardInfo" as const,
              args: [cards[id]!] as const,
            })),
            allowFailure: true,
          })) as { status: string; result?: { registered: boolean } }[];
          pooledRef.current = new Map(
            ids.map((id, i) => [cards[id]!, pooled[i]?.status === "success" && Boolean(pooled[i]?.result?.registered)]),
          );

          if (cancelled) return;
          setMeta(
            ids.map((id) => ({
              id,
              card: cards[id]!,
              name: names[id] ?? `Player ${id}`,
              symbol: symbols[id] ?? `WP${id}`,
              team: (configs[id]?.team ?? 0) as 0 | 1,
              position: configs[id]?.position ?? 2,
              starter: configs[id]?.starter ?? false,
            })),
          );
          if (!cancelled) setError(null);
          return;
        } catch (err) {
          console.warn(`[whistle] player table read failed (attempt ${attempt + 1}/5):`, err);
          if (!cancelled) setError(describe(err));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicClient, D, fixtureId]);

  const clock = header?.clock;

  /**
   * Reference prices as they stood in the block the match kicked off in.
   *
   * This is the only defensible baseline for a "since kick-off" move.
   * `preMatchPrice` looks like one and is not — it is a live view, half the
   * player's *current* expected score, so it drifts with the match and makes
   * every card report the same percentage. The honest number needs a historical
   * read, which is one `KickedOff` log plus one multicall pinned to its block.
   */
  useEffect(() => {
    if (!publicClient || meta.length === 0) return;
    // Nothing to read before kick-off, and scanning for an event that cannot
    // exist yet is a whole log scan per fixture load.
    if ((clock ?? 0) === 0) return;
    let cancelled = false;

    (async () => {
      try {
        // Filtered by fixture: one MatchOracle serves every fixture in the
        // deployment, so an unfiltered scan finds whichever kicked off first.
        const kicks = await scanLogs<FeedLog>(publicClient, BigInt(D.deployBlock), {
          address: D.matchOracle, abi: matchOracleAbi as Abi, eventName: "KickedOff",
          args: { fixtureId },
        });
        const at = kicks.logs[0]?.blockNumber;
        if (!at || cancelled) return;

        const prices = (await publicClient.multicall({
          contracts: meta.map((m) => ({
            address: D.settlementPot,
            abi: settlementPotAbi,
            functionName: "referencePrice" as const,
            args: [m.card] as const,
          })),
          allowFailure: true,
          blockNumber: at,
        })) as { status: string; result?: bigint }[];

        if (cancelled) return;
        const out = new Map<number, bigint>();
        meta.forEach((m, i) => {
          const r = prices[i];
          if (r?.status === "success" && typeof r.result === "bigint") out.set(m.id, r.result);
        });
        if (out.size > 0) setKickoffPrices(out);
        console.info(`[baseline] kickoff block ${at}: ${out.size} prices`);
      } catch (err) {
        // A node without archive state cannot answer this; the caller falls back
        // to the first price it sees and relabels the column.
        console.warn("[baseline] kickoff prices unavailable:", String(err).slice(0, 140));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicClient, meta, D, clock]);

  // ------------------------------------------------------------------ reads

  const refresh = useCallback(async () => {
    if (!publicClient || meta.length === 0) return;
    try {
      const [fixture, potBalance, potSnapshot, settled] = await Promise.all([
        publicClient.readContract({
          address: D.matchOracle,
          abi: matchOracleAbi,
          functionName: "fixtures",
          args: [fixtureId],
        }),
        publicClient.readContract({
          address: D.settlementPot,
          abi: settlementPotAbi,
          functionName: "potBalance",
        }),
        publicClient.readContract({
          address: D.settlementPot,
          abi: settlementPotAbi,
          functionName: "potSnapshot",
        }),
        publicClient.readContract({
          address: D.settlementPot,
          abi: settlementPotAbi,
          functionName: "settled",
        }),
      ]);

      const [, state, clock, playerCount, orderDelayL, , lastEventAt] = fixture as unknown as [
        Address,
        number,
        number,
        number,
        number,
        number,
        bigint,
      ];

      setHeader({
        state: Number(state),
        clock: Number(clock),
        playerCount: Number(playerCount),
        potBalance,
        potSnapshot,
        settled,
        orderDelayL: Number(orderDelayL),
        lastEventAt: Number(lastEventAt),
      });

      // One multicall per quantity keeps each request small; a single 150-call
      // batch stalls a cold fork while it backfills storage.
      const prices = (await publicClient.multicall({
        contracts: meta.map((m) => ({
          address: D.settlementPot,
          abi: settlementPotAbi,
          functionName: "referencePrice" as const,
          args: [m.card] as const,
        })),
        allowFailure: false,
      })) as bigint[];

      const expected = (await publicClient.multicall({
        contracts: meta.map((m) => ({
          address: D.matchOracle,
          abi: matchOracleAbi,
          functionName: "expectedScore" as const,
          args: [fixtureId, m.id] as const,
        })),
        allowFailure: false,
      })) as bigint[];

      const states = (await publicClient.multicall({
        contracts: meta.map((m) => ({
          address: D.matchOracle,
          abi: matchOracleAbi,
          functionName: "playerState" as const,
          args: [fixtureId, m.id] as const,
        })),
        allowFailure: false,
      })) as { banked: bigint; entryMinute: number; frozenMinutes: number; onPitch: boolean; frozen: boolean }[];

      const mins = (await publicClient.multicall({
        contracts: meta.map((m) => ({
          address: D.matchOracle,
          abi: matchOracleAbi,
          functionName: "minutesPlayed" as const,
          args: [fixtureId, m.id] as const,
        })),
        allowFailure: false,
      })) as number[];

      const supplies = (await publicClient.multicall({
        contracts: meta.map((m) => ({
          address: D.settlementPot,
          abi: settlementPotAbi,
          functionName: "supplyOf" as const,
          args: [m.card] as const,
        })),
        allowFailure: false,
      })) as bigint[];

      const preMatch = (await publicClient.multicall({
        contracts: meta.map((m) => ({
          address: D.settlementPot,
          abi: settlementPotAbi,
          functionName: "preMatchPrice" as const,
          args: [m.card] as const,
        })),
        allowFailure: false,
      })) as bigint[];

      const finals = settled
        ? ((await publicClient.multicall({
            contracts: meta.map((m) => ({
              address: D.matchOracle,
              abi: matchOracleAbi,
              functionName: "finalScore" as const,
              args: [fixtureId, m.id] as const,
            })),
            allowFailure: false,
          })) as bigint[])
        : meta.map(() => 0n);

      const payouts = settled
        ? ((await publicClient.multicall({
            contracts: meta.map((m) => ({
              address: D.settlementPot,
              abi: settlementPotAbi,
              functionName: "payoutPerUnit" as const,
              args: [m.card] as const,
            })),
            allowFailure: false,
          })) as bigint[])
        : meta.map(() => 0n);

      setPlayers(
        meta.map((m, i) => ({
          ...m,
          referencePrice: prices[i] ?? 0n,
          expectedScore: expected[i] ?? 0n,
          finalScore: finals[i] ?? 0n,
          minutes: Number(mins[i] ?? 0),
          banked: states[i]?.banked ?? 0n,
          onPitch: states[i]?.onPitch ?? false,
          frozen: states[i]?.frozen ?? false,
          supply: supplies[i] ?? 0n,
          pooled: pooledRef.current.get(m.card) ?? false,
          payoutPerUnit: payouts[i] ?? 0n,
          preMatchPrice: preMatch[i] ?? 0n,
        })),
      );

      const [pnl, feesEarned, marketMakingPnL, inventoryValue] = (await publicClient.readContract({
        address: D.mmVault,
        abi: mmVaultAbi,
        functionName: "vaultPnL",
      })) as [bigint, bigint, bigint, bigint];
      const capitalIn = await publicClient.readContract({
        address: D.mmVault,
        abi: mmVaultAbi,
        functionName: "capitalIn",
      });
      setVault({ pnl, feesEarned, marketMakingPnL, inventoryValue, capitalIn });

      setError(null);
    } catch (err) {
      setError(describe(err));
    } finally {
      setLoading(false);
    }
  }, [publicClient, meta, D, fixtureId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // ------------------------------------------------------------- backfill

  /**
   * Seed the feed from recent history.
   *
   * Watchers only ever see logs that arrive after the page loads, so an event feed
   * built purely from them is empty exactly when somebody opens the app mid-match —
   * which is the only time they would want it.
   */
  useEffect(() => {
    if (!publicClient || meta.length === 0) return;
    let cancelled = false;

    (async () => {
      try {
        const latest = await publicClient.getBlockNumber();

        /**
         * History, chunked to whatever `eth_getLogs` span the endpoint serves.
         *
         * Two separate limits bite here: a forked node has no history before its
         * fork block, and Alchemy's free tier answers only a ten-block range. Both
         * surface as an error rather than an empty result, so a single wide query
         * silently produces an empty feed. {@link scanLogs} probes the real span
         * and pages backwards within it.
         */
        /**
         * A settled fixture answers from the build snapshot, not the chain.
         *
         * This is attempted for every fixture rather than gated on the
         * deployment file's `settled` flag: the build only writes a snapshot for
         * a fixture the chain says is SETTLED, so its mere existence is the
         * authority. A live fixture gets one cached 404 and scans as before.
         */
        await loadSnapshot(D.fixtureId, D.settled);

        const FEED_FROM = BigInt(D.deployBlock);
        const [events, fills, batches] = await Promise.all([
          /**
           * Filtered by fixture id, which is not optional here.
           *
           * The MatchOracle is shared across every fixture in a deployment, and
           * the scan runs from this fixture's deploy block to the head — so a
           * settled fixture picked up every later fixture's events as well. The
           * 1-1 game read as 2-2 on the payout screen, because it was counting
           * two matches' goals.
           */
          scanLogs<FeedLog>(publicClient, FEED_FROM, {
            address: D.matchOracle, abi: matchOracleAbi as Abi, eventName: "MatchEvent",
            args: { fixtureId },
          }).then((r) => {
            /**
             * An empty scan is only believable before kick-off.
             *
             * A live match posts a heartbeat every five minutes, so zero
             * `MatchEvent` logs during one means the read failed — a node that
             * cannot serve history returns nothing rather than erroring. Trusting
             * it would print "0–0" over a match that has already been scored in.
             */
            const believable = r.failed === 0 && (r.logs.length > 0 || (clock ?? 0) === 0);
            setFeedComplete(believable);
            return r.logs;
          }),
          scanLogs<FeedLog>(publicClient, FEED_FROM, {
            address: D.whistleHook, abi: whistleHookAbi as Abi, eventName: "OrderFilled",
          }).then((r) => r.logs),
          scanLogs<FeedLog>(publicClient, FEED_FROM, {
            address: D.whistleHook, abi: whistleHookAbi as Abi, eventName: "BatchCleared",
          }).then((r) => r.logs),
        ]);

        if (cancelled) return;

        const nameOf = (id: number): string => meta.find((m) => m.id === id)?.name ?? `#${id}`;
        const cardName = (addr: string): string =>
          meta.find((m) => m.card.toLowerCase() === addr.toLowerCase())?.name ?? addr.slice(0, 10);

        for (const log of events) {
          const a = log.args as { minute?: number; eventType?: number; playerIds?: readonly number[] };
          pushFeed({
            key: keyOf(log),
            blockNumber: log.blockNumber ?? 0n,
            kind: "event",
            label: `${a.minute}' ${["HEARTBEAT", "GOAL", "YELLOW", "RED", "SUB"][a.eventType ?? 0]}`,
            detail: (a.playerIds ?? []).map((id) => nameOf(Number(id))).join(" → "),
          });
        }
        for (const log of fills) {
          const a = log.args as { orderId?: bigint; card?: Address; units?: bigint };
          pushFeed({
            key: keyOf(log),
            blockNumber: log.blockNumber ?? 0n,
            kind: "fill",
            label: `fill #${a.orderId} · ${cardName(a.card ?? ZERO)}`,
            detail: `${fmtUnits(a.units)} units`,
          });
        }
        for (const log of batches) {
          const a = log.args as {
            card?: Address;
            buyVolume?: bigint;
            sellVolume?: bigint;
            vaultResidual?: bigint;
          };
          pushFeed({
            key: keyOf(log),
            blockNumber: log.blockNumber ?? 0n,
            kind: "batch",
            label: `batch cleared · ${cardName(a.card ?? ZERO)}`,
            detail: `buys ${fmtUnits(a.buyVolume)} · sells ${fmtUnits(a.sellVolume)} · vault ${fmtUnits(a.vaultResidual)}`,
          });
        }
      } catch {
        /* best effort: the live watchers below are the primary path */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicClient, meta, pushFeed, D, fixtureId]);

  // --------------------------------------------------------------- watchers

  useEffect(() => {
    if (!publicClient || meta.length === 0) return;
    const nameOf = (id: number): string => meta.find((m) => m.id === id)?.name ?? `#${id}`;
    const cardName = (addr: string): string =>
      meta.find((m) => m.card.toLowerCase() === addr.toLowerCase())?.name ?? addr.slice(0, 10);

    const unwatchers = [
      publicClient.watchContractEvent({
        address: D.matchOracle,
        abi: matchOracleAbi,
        eventName: "MatchEvent",
        // Shared oracle: without this the feed shows other fixtures' events live.
        args: { fixtureId },
        pollingInterval: POLL_MS,
        onLogs: (logs) => {
          for (const log of logs) {
            const a = log.args as { minute?: number; eventType?: number; playerIds?: readonly number[] };
            const names = (a.playerIds ?? []).map((id) => nameOf(Number(id))).join(" → ");
            pushFeed({
              key: keyOf(log),
              blockNumber: log.blockNumber ?? 0n,
              kind: "event",
              label: `${a.minute}' ${["HEARTBEAT", "GOAL", "YELLOW", "RED", "SUB"][a.eventType ?? 0]}`,
              detail: names,
            });
          }
          void refresh();
        },
      }),
      publicClient.watchContractEvent({
        address: D.whistleHook,
        abi: whistleHookAbi,
        eventName: "BatchCleared",
        pollingInterval: POLL_MS,
        onLogs: (logs) => {
          for (const log of logs) {
            const a = log.args as {
              card?: Address;
              referencePrice?: bigint;
              buyVolume?: bigint;
              sellVolume?: bigint;
              vaultResidual?: bigint;
            };
            pushFeed({
              key: keyOf(log),
              blockNumber: log.blockNumber ?? 0n,
              kind: "batch",
              label: `batch cleared · ${cardName(a.card ?? ZERO)}`,
              detail: `buys ${fmtUnits(a.buyVolume)} · sells ${fmtUnits(a.sellVolume)} · vault ${fmtUnits(a.vaultResidual)}`,
            });
          }
        },
      }),
      publicClient.watchContractEvent({
        address: D.whistleHook,
        abi: whistleHookAbi,
        eventName: "OrderFilled",
        pollingInterval: POLL_MS,
        onLogs: (logs) => {
          for (const log of logs) {
            const a = log.args as { orderId?: bigint; card?: Address; units?: bigint; usdc?: bigint };
            pushFeed({
              key: keyOf(log),
              blockNumber: log.blockNumber ?? 0n,
              kind: "fill",
              label: `fill #${a.orderId} · ${cardName(a.card ?? ZERO)}`,
              detail: `${fmtUnits(a.units)} units`,
            });
          }
        },
      }),
      publicClient.watchContractEvent({
        address: D.whistleHook,
        abi: whistleHookAbi,
        eventName: "OrderCancelled",
        pollingInterval: POLL_MS,
        onLogs: (logs) => {
          for (const log of logs) {
            const a = log.args as { orderId?: bigint; reason?: number };
            pushFeed({
              key: keyOf(log),
              blockNumber: log.blockNumber ?? 0n,
              kind: "cancel",
              label: `cancelled #${a.orderId}`,
              detail:
                ["PRICE_MOVED", "UNAUTHORIZED", "INSUFFICIENT_INVENTORY", "REVOKED"][a.reason ?? 0] ?? "",
            });
          }
        },
      }),
      publicClient.watchContractEvent({
        address: D.whistleHook,
        abi: whistleHookAbi,
        eventName: "OrderQueued",
        pollingInterval: POLL_MS,
        onLogs: (logs) => {
          for (const log of logs) {
            const a = log.args as { orderId?: bigint; card?: Address; owner?: Address; side?: number; amount?: bigint };
            pushFeed({
              key: keyOf(log),
              blockNumber: log.blockNumber ?? 0n,
              kind: "queued",
              label: `queued #${a.orderId} · ${["BUY", "SELL"][a.side ?? 0]}`,
              detail: `${fmtUnits(a.amount)} ${cardName(a.card ?? ZERO)}`,
            });
          }
        },
      }),
    ];

    return () => unwatchers.forEach((u) => u());
  }, [publicClient, meta, pushFeed, refresh, D, fixtureId]);

  const byTeam = useMemo(
    () => ({ home: players.filter((p) => p.team === 0), away: players.filter((p) => p.team === 1) }),
    [players],
  );

  return { players, byTeam, header, vault, feed, feedComplete, kickoffPrices, error, loading, refresh };
}

function keyOf(log: Log): string {
  return `${log.transactionHash}-${log.logIndex}`;
}

function fmtUnits(v: bigint | undefined): string {
  if (v === undefined) return "0";
  const negative = v < 0n;
  const abs = negative ? -v : v;
  return `${negative ? "-" : ""}${abs / 10n ** 18n}`;
}

/**
 * An error a reader can act on.
 *
 * viem reports an unreachable endpoint as "HTTP request failed." — true, and
 * useless: it names neither the endpoint nor the fix. The commonest cause by far
 * is that nobody set `NEXT_PUBLIC_RPC_URL`, so the app quietly tried a local node
 * that is not running, and the screen sits on "Reading the fixture…" with a red
 * banner that explains nothing.
 */
export function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // The 5% holder cap, in words: a card nobody holds yet cannot be minted by a
  // wallet that is not cap-exempt, because the first mint would be 100% of it.
  if (/HolderCapExceeded/.test(message)) {
    return "Refused by the 5% holder cap: no wallet may hold more than 5% of a card's supply, and this card has too little supply yet. Mint a pooled card, or a smaller amount.";
  }
  const first = message.split("\n")[0] ?? message;

  const unreachable =
    /HTTP request failed|fetch failed|Failed to fetch|ECONNREFUSED|NetworkError|timed out/i.test(message);
  if (!unreachable) return first;

  const where = `Cannot reach the RPC at ${redactRpc(RPC_URL)}.`;
  return RPC_IS_DEFAULT
    ? `${where} NEXT_PUBLIC_RPC_URL is not set, so the app fell back to a local node — ` +
        `create web/.env.local with a Sepolia endpoint (see docs/run-local.md), or start anvil.`
    : `${where} Check the endpoint is up and the key is not rate limited or origin restricted.`;
}

export { agentRegistryAbi, matchOracleAbi, mmVaultAbi, playerCardAbi, settlementPotAbi, whistleHookAbi };
