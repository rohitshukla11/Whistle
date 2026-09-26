"use client";

import { createPublicClient, http } from "viem";
import type { Abi, Address, PublicClient } from "viem";
import { sepolia } from "viem/chains";

import { LOGS_RPC_URL } from "./config";

/**
 * Reading a contract's whole history, on an RPC that rations it.
 *
 * Two limits bite. Alchemy's free tier answers `eth_getLogs` over a **ten block**
 * range and returns HTTP 400 for anything wider — not fewer results, an error —
 * so one wide query silently produces an empty feed. And a forked node has no
 * history at all before its fork block.
 *
 * The first version of this scanned a rolling window back from the head, which
 * was wrong in a way that was hard to see. It covered "the last N blocks"
 * whether or not the contract existed then, and it reported an empty result
 * identically whether the range was genuinely empty or every request had failed.
 * So a settlement screen could say "no mint in last 20002 blocks" about a pot
 * that had minted 161 times, and nothing in the output distinguished that from
 * the truth.
 *
 * It now scans from the contract's own deployment block, chunks at a span the
 * endpoint will actually serve, counts failed windows separately from empty
 * ones, and logs the range and count — so a wrong answer looks wrong.
 */

export interface LogScan<T> {
  logs: T[];
  fromBlock: bigint;
  toBlock: bigint;
  /** Windows that errored. Non-zero means incomplete, not empty. */
  failed: number;
  /** The per-request span the endpoint accepted. */
  span: bigint;
  /**
   * This history is finished and will never grow.
   *
   * Set only for a settled fixture's build-time snapshot. A normal cached scan
   * goes stale as the head advances; a settled fixture's cannot, so the staleness
   * check is skipped and the RPC is never asked again.
   */
  final?: boolean;
}

/**
 * Window sizes, widest first.
 *
 * There is deliberately no probe request. Probing asks a synthetic question
 * ("would you serve ten thousand blocks?") whose answer is indistinguishable
 * from "you are sending too many requests right now" — and under the concurrent
 * load of a page that is also polling state, a rate-limited probe made the whole
 * scan fall back to nine-block windows and take a minute to cover two thousand
 * blocks. Instead the scan starts wide and narrows only when a window actually
 * fails, which costs nothing on an endpoint that is fine.
 */
const SPANS = [10_000n, 1_000n, 100n, 9n];

/** A ceiling, so a mistaken `fromBlock` cannot spin forever. */
const MAX_REQUESTS = 400;

/**
 * Being rate limited is not the same as asking for too many blocks.
 *
 * Both arrive as a failed request, and the first version of this treated them
 * alike: narrow the window and try again. That is exactly backwards under rate
 * limiting — a ten-thousand-block scan that was one request becomes a thousand
 * nine-block requests, every one of which is also refused, and the endpoint that
 * was briefly busy is now being hammered by the client that noticed. A screenshot
 * run turned into ninety-eight console 429s this way.
 *
 * So a rate limit waits and retries the SAME window at the SAME span, and only a
 * genuine rejection narrows.
 */
const RATE_LIMITED = /429|rate limit|too many requests|capacity|exceeded/i;
const RATE_LIMIT_RETRIES = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Completed scans, keyed by contract, event and start block.
 *
 * A settled fixture's history never changes, and the settlement screen re-runs
 * its scan whenever the selected fixture changes — including changing back.
 * Caching makes switching between two fixtures cost one scan each rather than
 * one per switch.
 */
const resultCache = new Map<string, LogScan<unknown>>();

/**
 * Completed scans survive a page load.
 *
 * A settled fixture's history is finished, but the in-memory cache dies with the
 * page — so arriving at `/settlement` cost a full rescan every time, and a
 * rehearsal measured seventy seconds of "Reading the fixture…" as the last beat
 * of the demo. The logs cannot change, so re-reading them is pure waste.
 *
 * `sessionStorage` rather than `localStorage`: one browsing session is the right
 * lifetime for a cache nobody will think to clear, and a stale entry survives at
 * most until the tab closes. Bigints do not survive `JSON.stringify`, so the
 * entries are written through a replacer and read back with a reviver.
 */
const STORE_PREFIX = "whistle:logs:";

function storeKey(key: string): string {
  return STORE_PREFIX + key;
}

function loadPersisted<T>(key: string): LogScan<T> | undefined {
  try {
    const raw = sessionStorage.getItem(storeKey(key));
    if (!raw) return undefined;
    return JSON.parse(raw, (_k, v) =>
      typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
    ) as LogScan<T>;
  } catch {
    // Private mode, blocked storage, or a shape we no longer understand. The
    // scan below is the source of truth; this is only ever a shortcut.
    return undefined;
  }
}

function persist(key: string, scan: LogScan<unknown>): void {
  try {
    sessionStorage.setItem(
      storeKey(key),
      JSON.stringify(scan, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)),
    );
  } catch {
    /* over quota, or storage is unavailable */
  }
}

/**
 * Pre-fill the cache from a settled fixture's snapshot.
 *
 * The snapshot's keys are the cache's keys, so this is not a special path the
 * readers have to know about — every existing `scanLogs` call simply finds its
 * answer already there and never reaches the network.
 */
export function primeFromSnapshot(
  entries: Record<string, unknown[]>,
  fromBlock: bigint,
  toBlock: bigint,
): number {
  let primed = 0;
  for (const [key, logs] of Object.entries(entries)) {
    resultCache.set(key, { logs, fromBlock, toBlock, failed: 0, span: 0n, final: true });
    primed += logs.length;
  }
  return primed;
}

/**
 * The cache key, which is also the key a build snapshot fills.
 *
 * `args` is part of it because one contract can serve several fixtures. The
 * MatchOracle is shared across every fixture in a deployment, so `MatchEvent`
 * filtered to fixture A and the same event unfiltered are different questions
 * with different answers — and sharing a key between them handed one fixture
 * another's match events, which read as four goals in a 1-1 game.
 */
export function cacheKeyFor(
  address: Address,
  eventName: string,
  fromBlock: bigint,
  args?: Record<string, unknown>,
): string {
  const suffix = args
    ? `:${Object.entries(args)
        .map(([k, v]) => `${k}=${String(v)}`)
        .sort()
        .join(",")}`
    : "";
  return `${address.toLowerCase()}:${eventName}${suffix}:${fromBlock}`;
}

let logsClient: PublicClient | undefined;

/**
 * The client history is read through. Separate from the app's wagmi client
 * because the two endpoints are chosen for different properties — see
 * {@link LOGS_RPC_URL}.
 */
function historyClient(): PublicClient {
  logsClient ??= createPublicClient({
    chain: sepolia,
    transport: http(LOGS_RPC_URL, { retryCount: 2, retryDelay: 500, timeout: 30_000 }),
  }) as PublicClient;
  return logsClient;
}

/** The history client, for callers outside this module (the fixture list's score and movers). */
export const logsPublicClient = historyClient;

/**
 * Every matching event from `fromBlock` to the head.
 *
 * `fromBlock` should be the contract's deployment block: it is the only value
 * that makes "no results" mean "this never happened" rather than "I did not look
 * far enough back".
 */
/**
 * Every log a contract emitted, without filtering by event.
 *
 * The profile screen needs the resolver's whole history so it can pull each
 * transaction and decode the `setText` inside it — the resolver's events do not
 * carry the key, so there is no event to filter on. Same chunking and the same
 * honesty about failed windows as {@link scanLogs}.
 */
export async function scanAddressLogs(
  fromBlock: bigint,
  address: Address,
): Promise<LogScan<{ transactionHash: `0x${string}` | null; blockNumber: bigint | null }>> {
  const client = historyClient();
  const latest = await client.getBlockNumber();
  const label = `all ${address.slice(0, 10)}`;

  const cacheKey = `${address.toLowerCase()}:*:${fromBlock}`;
  const hit = resultCache.get(cacheKey) ?? loadPersisted<unknown>(cacheKey);
  if (hit && hit.failed === 0 && (hit.final || hit.toBlock >= latest)) {
    resultCache.set(cacheKey, hit);
    return hit as LogScan<{ transactionHash: `0x${string}` | null; blockNumber: bigint | null }>;
  }

  // Extend a clean cached scan rather than reuse it stale — see scanLogs.
  const resumeFrom = hit && hit.failed === 0 && hit.toBlock > fromBlock + 6n ? hit.toBlock - 6n : null;
  const out: { transactionHash: `0x${string}` | null; blockNumber: bigint | null }[] = resumeFrom === null
    ? []
    : (hit!.logs as { transactionHash: `0x${string}` | null; blockNumber: bigint | null }[]).filter((l) => (l.blockNumber ?? 0n) < resumeFrom);
  let failed = 0;
  let spanIndex = 0;
  let from = resumeFrom ?? fromBlock;
  let requests = 0;

  let backoffs = 0;
  while (from <= latest && requests < MAX_REQUESTS) {
    const span = SPANS[spanIndex]!;
    const to = from + span > latest ? latest : from + span;
    try {
      out.push(...(await client.getLogs({ address, fromBlock: from, toBlock: to })));
      requests += 1;
      if (to === latest) break;
      from = to + 1n;
    } catch (err) {
      requests += 1;
      if (RATE_LIMITED.test(String(err)) && backoffs < RATE_LIMIT_RETRIES) {
        backoffs += 1;
        await sleep(400 * 2 ** backoffs);
        continue;
      }
      if (spanIndex < SPANS.length - 1) {
        spanIndex += 1;
        continue;
      }
      failed += 1;
      console.warn(`[logs] ${label} window ${from}-${to} failed: ${String(err).slice(0, 140)}`);
      if (to === latest) break;
      from = to + 1n;
    }
  }

  console.info(`[logs] ${label}: ${out.length} logs, blocks ${fromBlock}-${latest}${failed ? `, ${failed} FAILED` : ""}`);
  const result = { logs: out, fromBlock, toBlock: latest, failed, span: SPANS[spanIndex]! };
  if (failed === 0) {
    resultCache.set(cacheKey, result as LogScan<unknown>);
    persist(cacheKey, result as LogScan<unknown>);
  }
  return result;
}

export async function scanLogs<T>(
  _stateClient: PublicClient,
  fromBlock: bigint,
  query: { address: Address; abi: Abi; eventName: string; args?: Record<string, unknown> },
): Promise<LogScan<T>> {
  const client = historyClient();
  const latest = await client.getBlockNumber();
  const label = `${query.eventName} ${query.address.slice(0, 10)}`;

  const cacheKey = cacheKeyFor(query.address, query.eventName, fromBlock, query.args);
  const hit = resultCache.get(cacheKey) ?? loadPersisted<unknown>(cacheKey);
  if (hit && hit.failed === 0 && (hit.final || hit.toBlock >= latest)) {
    resultCache.set(cacheKey, hit);
    console.info(
      `[logs] ${label} ${hit.final ? "from snapshot" : "cached"}: ${hit.logs.length} logs, ` +
        `blocks ${hit.fromBlock}-${hit.toBlock}`,
    );
    return hit as LogScan<T>;
  }

  /*
   * A cached scan is a prefix, not an answer.
   *
   * The cache used to be reused as-is for fifty blocks, so anything logged after
   * it was taken stayed invisible for up to ten minutes. Demo 1's settlement
   * screen, opened at 85', kept reading 1–0 after the 93' goal and a reload. Now
   * a clean cached scan is extended from where it stopped — re-reading its last
   * few blocks, because an endpoint can serve a block before it has indexed that
   * block's logs — and merged without duplicates.
   */
  const REREAD = 6n;
  const resumeFrom = hit && hit.failed === 0 && hit.toBlock > fromBlock + REREAD ? hit.toBlock - REREAD : null;
  const out: T[] = resumeFrom === null
    ? []
    : (hit!.logs as { blockNumber?: bigint }[]).filter((l) => (l.blockNumber ?? 0n) < resumeFrom) as T[];
  let failed = 0;
  let spanIndex = 0;
  let from = resumeFrom ?? fromBlock;
  let requests = 0;
  let backoffs = 0;

  while (from <= latest && requests < MAX_REQUESTS) {
    const span = SPANS[spanIndex]!;
    const to = from + span > latest ? latest : from + span;
    try {
      out.push(...((await client.getContractEvents({ ...query, fromBlock: from, toBlock: to })) as T[]));
      requests += 1;
      if (to === latest) break;
      from = to + 1n;
    } catch (err) {
      requests += 1;
      if (RATE_LIMITED.test(String(err)) && backoffs < RATE_LIMIT_RETRIES) {
        // Wait, do not narrow. See RATE_LIMITED.
        backoffs += 1;
        console.warn(`[logs] ${label} rate limited, backing off ${400 * 2 ** backoffs}ms`);
        await sleep(400 * 2 ** backoffs);
        continue;
      }
      if (spanIndex < SPANS.length - 1) {
        // Narrow and retry the SAME window: the failure is usually the range,
        // and re-reading it smaller loses nothing.
        spanIndex += 1;
        console.warn(`[logs] ${label} ${from}-${to} failed, narrowing to ${SPANS[spanIndex]}`);
        continue;
      }
      failed += 1;
      console.warn(`[logs] ${label} window ${from}-${to} failed: ${String(err).slice(0, 140)}`);
      if (to === latest) break;
      from = to + 1n;
    }
  }

  const result: LogScan<T> = { logs: out, fromBlock, toBlock: latest, failed, span: SPANS[spanIndex]! };
  console.info(
    `[logs] ${label}: ${out.length} logs, blocks ${fromBlock}-${latest} ` +
      `(${requests} requests, span ${SPANS[spanIndex]}${failed ? `, ${failed} FAILED` : ""})`,
  );
  if (failed === 0) {
    resultCache.set(cacheKey, result as LogScan<unknown>);
    persist(cacheKey, result as LogScan<unknown>);
  }
  return result;
}
