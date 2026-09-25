"use client";

/**
 * A settled fixture's history, read from disk instead of the chain.
 *
 * The build freezes every SETTLED fixture's logs into `public/settled/<id>.json`
 * (see `scripts/snapshot.mjs`). This loads one, revives its bigints, and pours it
 * into the log cache — after which every `scanLogs` call for that fixture finds
 * its answer locally and the RPC is never asked.
 *
 * Fetched rather than imported, so a few hundred kilobytes of logs stay out of
 * the JavaScript bundle and arrive as one cacheable GET.
 *
 * Failure is never fatal. A missing or malformed snapshot falls through to the
 * ordinary scan, which is slower and correct.
 */

import { primeFromSnapshot } from "./logs";

interface Snapshot {
  fixtureId: string;
  fromBlock: bigint;
  toBlock: bigint;
  generatedAt: string;
  settledTx: `0x${string}` | null;
  entries: Record<string, unknown[]>;
}

/** `"123n"` back into `123n`. Written by the build's JSON replacer. */
function revive(_key: string, value: unknown): unknown {
  return typeof value === "string" && /^-?\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value;
}

/** One in-flight load per fixture, so four readers do not fetch four times. */
const inFlight = new Map<string, Promise<Snapshot | null>>();

/**
 * @param settled  Whether the deployment index thinks this fixture has finished.
 *
 * A live fixture has no snapshot and never will, so asking for one is a
 * guaranteed 404 on every load of the busiest screen in the app — console noise
 * that trains you to ignore console noise. Getting the flag wrong is harmless in
 * both directions: a fixture wrongly marked live simply scans, which is the old
 * behaviour, and one wrongly marked settled 404s once and then scans.
 */
export function loadSnapshot(fixtureId: string, settled: boolean): Promise<Snapshot | null> {
  if (!settled) return Promise.resolve(null);

  const existing = inFlight.get(fixtureId);
  if (existing) return existing;

  const load = (async (): Promise<Snapshot | null> => {
    try {
      const res = await fetch(`/settled/${fixtureId}.json`, { cache: "force-cache" });
      if (!res.ok) return null;
      const snapshot = JSON.parse(await res.text(), revive) as Snapshot;
      const primed = primeFromSnapshot(snapshot.entries, snapshot.fromBlock, snapshot.toBlock);
      console.info(
        `[settled] ${fixtureId}: ${primed} logs from the build snapshot ` +
          `(${snapshot.generatedAt}) — no log scan needed`,
      );
      return snapshot;
    } catch (err) {
      console.warn(`[settled] ${fixtureId}: no usable snapshot, falling back to scanning —`, err);
      return null;
    }
  })();

  inFlight.set(fixtureId, load);
  return load;
}
