/**
 * A missed receipt on the 65' substitution must not post it twice.
 *
 * This is the failure the chain cannot catch for us. `MatchOracle._validate`
 * rejects only `minute < clock`, so a re-posted event at the CURRENT minute is
 * applied a second time — Malouda is subbed off twice and the final scores stop
 * matching. The only defence is to ask the chain, by event identity, before
 * resending.
 *
 *   npx tsx test/resend.test.ts
 */

import assert from "node:assert/strict";

import { eventAlreadyPosted } from "../oracle/posted.js";
import { TransactionDropped } from "../oracle/tx.js";

const ORACLE = "0x0333f424E73b9aeD547B115919Ea4a4fB472C5D6" as const;
const FIXTURE = 20260923n;
/** 65' SUB [9, 12] — Malouda off, Kalou on. The event that exposed this. */
const SUB = { minute: 65, eventType: 4, playerIds: [9, 12] as const };
const HEARTBEAT = { minute: 65, eventType: 0, playerIds: [] as const };

const makeClient = (logs: unknown[]) =>
  ({
    getBlockNumber: async () => 100n,
    getLogs: async () => logs,
  }) as never;

const logFor = (e: { minute: number; eventType: number; playerIds: readonly number[] }) => ({
  args: { fixtureId: FIXTURE, minute: e.minute, eventType: e.eventType, playerIds: [...e.playerIds] },
});

let passed = 0;
const check = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve(fn()).then(
    () => { passed += 1; console.log(`  ok   ${name}`); },
    (err) => { console.error(`  FAIL ${name}\n       ${(err as Error).message}`); process.exitCode = 1; },
  );

await check("the SUB is recognised once it is on chain", async () => {
  const landed = await eventAlreadyPosted(makeClient([logFor(SUB)]), { oracle: ORACLE, fixtureId: FIXTURE, ...SUB });
  assert.equal(landed, true);
});

await check("an empty log window is NOT reported as landed", async () => {
  const landed = await eventAlreadyPosted(makeClient([]), { oracle: ORACLE, fixtureId: FIXTURE, ...SUB });
  assert.equal(landed, false);
});

await check("the 65' HEARTBEAT does not stand in for the 65' SUB", async () => {
  // Both sit at minute 65. Matching on minute alone would refuse to resend a
  // substitution that never landed, because a heartbeat did.
  const landed = await eventAlreadyPosted(makeClient([logFor(HEARTBEAT)]), { oracle: ORACLE, fixtureId: FIXTURE, ...SUB });
  assert.equal(landed, false);
});

await check("a different player list at the same minute does not match", async () => {
  const other = { minute: 65, eventType: 4, playerIds: [28, 29] as const };
  const landed = await eventAlreadyPosted(makeClient([logFor(other)]), { oracle: ORACLE, fixtureId: FIXTURE, ...SUB });
  assert.equal(landed, false);
});

await check("a read failure answers false, never 'already done'", async () => {
  const broken = { getBlockNumber: async () => 100n, getLogs: async () => { throw new Error("429"); } } as never;
  assert.equal(await eventAlreadyPosted(broken, { oracle: ORACLE, fixtureId: FIXTURE, ...SUB }), false);
});

await check("a timed-out SUB that DID land is not resent", async () => {
  // The whole scenario: confirm() gives up, the guard asks the chain, the chain
  // has it, so no second transaction is sent.
  let sends = 0;
  const resendIfNeeded = async () => {
    try {
      throw new TransactionDropped("0xdead" as `0x${string}`, "postEvent 65' SUB");
    } catch (err) {
      if (!(err instanceof TransactionDropped)) throw err;
      const landed = await eventAlreadyPosted(makeClient([logFor(SUB)]), { oracle: ORACLE, fixtureId: FIXTURE, ...SUB });
      if (!landed) sends += 1;
    }
  };
  await resendIfNeeded();
  assert.equal(sends, 0, "a landed event was resent");
});

await check("a timed-out SUB that did NOT land is resent exactly once", async () => {
  let sends = 0;
  const landed = await eventAlreadyPosted(makeClient([logFor(HEARTBEAT)]), { oracle: ORACLE, fixtureId: FIXTURE, ...SUB });
  if (!landed) sends += 1;
  assert.equal(sends, 1);
});

console.log(`\n${passed}/7 passed`);
