/**
 * "Is this exact event already on chain?"
 *
 * The one question that makes resending a `postEvent` safe. It is asked by
 * identity — fixture, minute, type and the exact player list — not by minute
 * alone, because a minute is not unique: the 65th of Chelsea–Barcelona carries
 * both a heartbeat and Malouda's substitution, and `MatchOracle._validate`
 * permits equal minutes precisely so that both can be posted. A resend matched
 * on minute would refuse to resend a heartbeat that never landed just because
 * the substitution did.
 */

import type { Address, PublicClient } from "viem";
import { parseAbiItem } from "viem";

const MATCH_EVENT = parseAbiItem(
  "event MatchEvent(uint256 indexed fixtureId, uint16 minute, uint8 eventType, uint16[] playerIds, uint64 sourceTimestamp)",
);

/**
 * How far back to look.
 *
 * A dropped transaction is seconds old, not hours, so a short window is both
 * sufficient and cheap — and it stays inside the ten-block `eth_getLogs` range
 * that free provider tiers allow, which a wider scan would not.
 */
export const LOOKBACK_BLOCKS = 9n;

export interface PostedQuery {
  oracle: Address;
  fixtureId: bigint;
  minute: number;
  eventType: number;
  playerIds: readonly number[];
}

const samePlayers = (a: readonly (number | bigint)[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => Number(v) === b[i]);

/**
 * True when the chain already holds this exact event.
 *
 * A read failure answers **false** on purpose: "I could not tell" must not be
 * reported as "already done", because that would silently drop an event the
 * match needs. The cost of being wrong the other way is one duplicate that the
 * caller's own nonce reasoning still guards.
 */
export async function eventAlreadyPosted(client: PublicClient, q: PostedQuery): Promise<boolean> {
  try {
    const head = await client.getBlockNumber();
    const fromBlock = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
    const logs = await client.getLogs({
      address: q.oracle,
      event: MATCH_EVENT,
      args: { fixtureId: q.fixtureId },
      fromBlock,
      toBlock: head,
    });
    return logs.some(
      (l) =>
        Number(l.args.minute) === q.minute &&
        Number(l.args.eventType) === q.eventType &&
        samePlayers(l.args.playerIds ?? [], q.playerIds),
    );
  } catch {
    return false;
  }
}

/**
 * The same question over the fixture's whole history, for resuming a match.
 *
 * {@link eventAlreadyPosted} looks back nine blocks, which is right for a
 * dropped resend and wrong for a resume: resuming fixture A at 93' asked it
 * about a goal posted eighteen blocks earlier, it said no, and the goal was
 * applied twice. This scans from the fixture's deploy block in windows that
 * shrink to ten blocks if the provider refuses a wider range, and it THROWS if
 * it cannot read — for a resume, "could not tell" must stop the replay rather
 * than risk a duplicate.
 */
export async function eventPostedSince(client: PublicClient, q: PostedQuery, fromBlock: bigint): Promise<boolean> {
  const head = await client.getBlockNumber();
  let span = 2_000n;
  for (let from = fromBlock; from <= head; ) {
    const to = from + span - 1n > head ? head : from + span - 1n;
    let logs;
    try {
      logs = await client.getLogs({ address: q.oracle, event: MATCH_EVENT, args: { fixtureId: q.fixtureId }, fromBlock: from, toBlock: to });
    } catch (err) {
      if (span > 10n) {
        span = 10n;
        continue;
      }
      throw new Error(`could not read MatchEvent logs ${from}-${to}: ${String(err).split("\n")[0]}`);
    }
    if (logs.some((l) => Number(l.args.minute) === q.minute && Number(l.args.eventType) === q.eventType && samePlayers(l.args.playerIds ?? [], q.playerIds))) {
      return true;
    }
    from = to + 1n;
  }
  return false;
}
