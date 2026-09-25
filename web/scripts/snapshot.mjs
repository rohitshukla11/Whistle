/**
 * Freeze a settled fixture's history at build time.
 *
 * A settled fixture's logs can never change, so scanning them from the browser
 * is work that produces the same answer every time. It is also the slowest thing
 * the app does: a rehearsal measured seventy seconds of "Reading the fixture…"
 * on `/settlement`, which is the last screen of the demo and the worst possible
 * place to spend a minute.
 *
 * So the build reads them once and writes them next to the app. The browser
 * fetches one JSON file instead of paging `eth_getLogs` across ten thousand
 * blocks, and the RPC is not involved at all.
 *
 * Only SETTLED fixtures are frozen, and settled is read from the chain rather
 * than taken from the deployment file — a file can be wrong about that, and a
 * frozen snapshot of a live fixture would be a screen that stops updating.
 *
 * Written to `public/settled/` rather than `vendor/`: these are fetched at
 * runtime, not imported, which keeps a few hundred kilobytes of logs out of the
 * JavaScript bundle.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createPublicClient, http, parseAbi } from "viem";
import { sepolia } from "viem/chains";

/** The events the screens actually read back. */
const EVENTS = {
  matchOracle: parseAbi([
    "event MatchEvent(uint256 indexed fixtureId, uint16 minute, uint8 eventType, uint16[] playerIds, uint64 at)",
    "event Settled(uint256 indexed fixtureId, uint16 clock)",
  ]),
  settlementPot: parseAbi([
    "event Minted(address indexed card, address indexed to, uint256 units, uint256 costUSDC)",
    "event Redeemed(address indexed card, address indexed from, uint256 units, uint256 payoutUSDC)",
  ]),
  whistleHook: parseAbi([
    "event BatchCleared(uint256 indexed fixtureId, address indexed card, uint256 referencePrice, uint256 buyVolume, uint256 sellVolume, uint256 vaultResidual)",
    "event OrderQueued(uint256 indexed orderId, uint256 indexed fixtureId, address indexed card, address owner, uint8 side, uint256 amount)",
    "event OrderFilled(uint256 indexed orderId, address indexed card, uint256 units, uint256 usdc, uint256 referencePrice)",
    "event OrderCancelled(uint256 indexed orderId, uint8 reason)",
  ]),
};

/**
 * Which contract each event lives on, and therefore which cache key it fills.
 *
 * The keys mirror `lib/logs.ts` exactly — `address:eventName:fromBlock` — so a
 * snapshot is simply a pre-filled scan result and every existing caller picks it
 * up without knowing snapshots exist.
 */
/**
 * `byFixture` marks the events that need filtering.
 *
 * The MatchOracle is shared by every fixture in a deployment, and each scan runs
 * from its own fixture's deploy block to the head — so an unfiltered scan of a
 * SETTLED fixture swept up every later fixture's events too. `20090506` came back
 * with 46 `MatchEvent` logs where it has 23, and four goals in a 1-1 match.
 *
 * The pot and the hook are deployed per fixture, so their events need no filter.
 */
const PLAN = [
  ["matchOracle", "MatchEvent", true],
  ["settlementPot", "Minted", false],
  ["settlementPot", "Redeemed", false],
  ["whistleHook", "BatchCleared", false],
  ["whistleHook", "OrderQueued", false],
  ["whistleHook", "OrderFilled", false],
  ["whistleHook", "OrderCancelled", false],
];

/** Mirrors `cacheKeyFor` in lib/logs.ts. The two must not drift. */
function cacheKey(address, eventName, fromBlock, args) {
  const suffix = args
    ? `:${Object.entries(args)
        .map(([k, v]) => `${k}=${String(v)}`)
        .sort()
        .join(",")}`
    : "";
  return `${address.toLowerCase()}:${eventName}${suffix}:${fromBlock}`;
}

const SPANS = [10_000n, 1_000n, 100n, 9n];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Page `eth_getLogs` at whatever span the endpoint will serve. */
async function scan(client, address, abi, eventName, fromBlock, toBlock, args) {
  const out = [];
  let spanIndex = 0;
  let from = fromBlock;
  let backoffs = 0;

  while (from <= toBlock) {
    const span = SPANS[spanIndex];
    const to = from + span > toBlock ? toBlock : from + span;
    try {
      out.push(
        ...(await client.getContractEvents({
          address, abi, eventName, fromBlock: from, toBlock: to,
          ...(args ? { args } : {}),
        })),
      );
      if (to === toBlock) break;
      from = to + 1n;
    } catch (err) {
      const text = String(err);
      // A rate limit is not a range problem; narrowing would only send more.
      if (/429|rate limit|too many requests/i.test(text) && backoffs < 5) {
        backoffs += 1;
        await sleep(500 * 2 ** backoffs);
        continue;
      }
      if (spanIndex < SPANS.length - 1) {
        spanIndex += 1;
        continue;
      }
      throw new Error(`${eventName} ${from}-${to}: ${text.slice(0, 160)}`);
    }
  }
  return out;
}

const bigints = (_k, v) => (typeof v === "bigint" ? `${v}n` : v);

/**
 * @param {string} rpcUrl
 * @param {object[]} fixtures  the generated fixture index
 * @param {string} outDir      `public/settled`
 */
export async function writeSnapshots(rpcUrl, fixtures, outDir) {
  if (!rpcUrl) {
    console.log("snapshot: no RPC URL, skipping (settled fixtures will scan at runtime)");
    return;
  }

  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl, { timeout: 60_000 }) });

  let head;
  try {
    head = await client.getBlockNumber();
  } catch (err) {
    console.warn(`snapshot: cannot reach the RPC, skipping — ${String(err).slice(0, 120)}`);
    return;
  }

  mkdirSync(outDir, { recursive: true });
  const stateAbi = parseAbi(["function fixtureState(uint256 fixtureId) view returns (uint8)"]);

  for (const f of fixtures) {
    // Ask the chain, not the file. A deployment file that says "settled" about a
    // fixture that is still running would freeze a screen mid-match.
    let state;
    try {
      state = await client.readContract({
        address: f.matchOracle, abi: stateAbi, functionName: "fixtureState", args: [BigInt(f.fixtureId)],
      });
    } catch (err) {
      console.warn(`snapshot: ${f.fixtureId} state unreadable, skipping — ${String(err).slice(0, 100)}`);
      continue;
    }
    if (Number(state) !== 2) {
      console.log(`snapshot: ${f.fixtureId} is not SETTLED (state ${state}), skipping`);
      continue;
    }

    const fromBlock = BigInt(f.deployBlock);
    const entries = {};
    let total = 0;
    try {
      for (const [contract, eventName, byFixture] of PLAN) {
        const address = f[contract];
        const args = byFixture ? { fixtureId: BigInt(f.fixtureId) } : undefined;
        const logs = await scan(client, address, EVENTS[contract], eventName, fromBlock, head, args);
        entries[cacheKey(address, eventName, fromBlock, args)] = logs.map((l) => ({
          address: l.address,
          blockNumber: l.blockNumber,
          transactionHash: l.transactionHash,
          logIndex: l.logIndex,
          args: l.args,
        }));
        total += logs.length;
      }
    } catch (err) {
      // A partial snapshot is worse than none: it would look complete and be
      // missing events, with nothing on screen to say so.
      console.warn(`snapshot: ${f.fixtureId} incomplete, not writing — ${String(err).slice(0, 160)}`);
      continue;
    }

    // The transaction that settled THIS fixture. Filtered for the same reason as
    // MatchEvent: unfiltered, every fixture reported whichever settled last.
    let settledTx = null;
    try {
      const settled = await scan(
        client, f.matchOracle, EVENTS.matchOracle, "Settled", fromBlock, head,
        { fixtureId: BigInt(f.fixtureId) },
      );
      settledTx = settled.at(-1)?.transactionHash ?? null;
    } catch {
      /* the link is a nicety */
    }
    const snapshot = {
      fixtureId: String(f.fixtureId),
      chainId: f.chainId,
      fromBlock,
      toBlock: head,
      generatedAt: new Date().toISOString(),
      settledTx,
      entries,
    };
    writeFileSync(join(outDir, `${f.fixtureId}.json`), JSON.stringify(snapshot, bigints));
    console.log(
      `snapshot: ${f.fixtureId} frozen — ${total} logs, blocks ${fromBlock}-${head}` +
        `${settledTx ? `, settled in ${settledTx.slice(0, 12)}…` : ""}`,
    );
  }
}
