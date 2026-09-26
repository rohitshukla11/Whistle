/**
 * Sending a transaction and actually finding out what happened to it.
 *
 * Every stall in the step-8 Sepolia deploy had one cause: viem's receipt watcher
 * gave up while the transaction was mining, the caller treated that as a failure,
 * and a rerun paid for the same work twice. The transaction had landed every
 * single time.
 *
 * So the rule here is: **a timeout is never evidence of failure.** Before giving
 * up on a hash, ask the chain directly. `getTransactionReceipt` on a mined hash
 * answers even when the watcher has stopped listening, and if the transaction is
 * merely still pending, waiting longer is correct.
 */

import type { Address, Hash, PublicClient, TransactionReceipt, WalletClient } from "viem";

/**
 * The outer bound on waiting for one transaction.
 *
 * Was ten minutes per round, three rounds — half an hour of silence for a hash
 * that had been dropped in the first second. The guard below usually decides in
 * one block; this is only the backstop for a transaction genuinely sitting in a
 * congested mempool.
 */
export const RECEIPT_TIMEOUT_MS = Number(process.env.WHISTLE_RECEIPT_TIMEOUT_MS ?? 180_000);

/**
 * One block on the target chain, which is how often it is worth looking again.
 *
 * Sepolia is ~12s. A local node mines on demand, so the override exists to keep
 * fork runs from sleeping through work that has already happened.
 */
export const BLOCK_MS = Number(process.env.WHISTLE_BLOCK_MS ?? 12_000);

/** Slower than viem's default. There is no prize for polling a 12s chain every second. */
export const POLL_INTERVAL_MS = 4_000;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The transaction is not coming. It was never mined and is no longer in flight.
 *
 * Distinct from "still waiting" because the two need opposite responses: one is
 * patience, the other is re-reading the chain and sending again.
 */
export class TransactionDropped extends Error {
  constructor(
    readonly hash: Hash,
    readonly label: string,
  ) {
    super(`${label}: ${hash} was neither mined nor pending — dropped`);
    this.name = "TransactionDropped";
  }
}

/**
 * Has this sender got anything in flight at all?
 *
 * `pending` counts what the mempool has accepted, `latest` what has been mined.
 * Equal means nothing of theirs is waiting — so a hash with no receipt is gone,
 * not slow. This is the whole guard: it turns an unbounded wait into a decision.
 */
async function nothingInFlight(client: PublicClient, from: Address): Promise<boolean> {
  const [pending, latest] = await Promise.all([
    client.getTransactionCount({ address: from, blockTag: "pending" }),
    client.getTransactionCount({ address: from, blockTag: "latest" }),
  ]);
  return pending === latest;
}

/**
 * "Has this work already been done?" — asked before any resend.
 *
 * A resend is only safe if the original is provably absent. For most calls the
 * nonce settles that: same nonce, so a resend can only ever replace. But a
 * transaction can also be *missed* rather than dropped — the receipt watcher
 * gives up while it mines — and for a call the chain accepts twice, replacing a
 * transaction that already landed applies it again.
 *
 * `postEvent` is exactly that call. `MatchOracle._validate` reverts only on
 * `minute < clock`, so equal minutes are permitted — they have to be, because
 * the 65th minute of Chelsea–Barcelona holds two events — which means a
 * re-posted substitution is APPLIED A SECOND TIME rather than rejected. The
 * player is subbed off twice and the final scores stop matching.
 *
 * So callers that send such a transaction pass a check that asks the chain
 * whether the work is already there. Returning true means "landed, do not
 * resend"; the default, when no check is given, is the old nonce-only reasoning.
 */
export type AlreadyLanded = () => Promise<boolean>;

export interface ConfirmOptions {
  /** The sender, so a dropped transaction can be told from a slow one. */
  from?: Address;
  /**
   * The nonce this transaction was sent with.
   *
   * Stronger evidence than {@link nothingInFlight} where it is known: once the
   * sender's mined count is past this nonce and the hash still has no receipt,
   * some OTHER transaction took the slot and this one can never land.
   */
  nonce?: number;
}

/**
 * Wait for `hash`, and never wait forever.
 *
 * Three outcomes, and the point is to reach one of them quickly:
 *
 *   - a receipt, which is the answer;
 *   - {@link TransactionDropped}, when the chain can prove the transaction is
 *     not coming — its nonce was used by something else, or the sender has
 *     nothing in flight at all;
 *   - a timeout, only after {@link RECEIPT_TIMEOUT_MS} of a genuinely pending
 *     transaction.
 *
 * A watcher giving up is still never treated as failure: every round asks the
 * chain directly by hash, which answers for any mined transaction.
 */
export async function confirm(
  publicClient: PublicClient,
  hash: Hash,
  label = "transaction",
  options: ConfirmOptions = {},
): Promise<TransactionReceipt> {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  let warned = false;

  for (;;) {
    const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
    if (receipt) {
      if (warned) console.warn(`  (${label} had landed after all: ${hash})`);
      return receipt;
    }

    // Still in the mempool? Then waiting is the correct thing to do.
    const pending = await publicClient.getTransaction({ hash }).catch(() => null);
    if (!pending) {
      if (options.nonce !== undefined && options.from) {
        const mined = await publicClient.getTransactionCount({
          address: options.from, blockTag: "latest",
        });
        // The slot is spent and this hash is not what filled it.
        if (mined > options.nonce) throw new TransactionDropped(hash, label);
      }
      if (options.from && (await nothingInFlight(publicClient, options.from))) {
        throw new TransactionDropped(hash, label);
      }
    }

    if (Date.now() > deadline) {
      throw new Error(
        `${label}: no receipt for ${hash} after ${RECEIPT_TIMEOUT_MS / 1000}s and it is still ` +
          `pending. Check the hash before rerunning — every step resumes from chain state, ` +
          `so nothing is paid for twice.`,
      );
    }

    if (!warned) {
      warned = true;
      console.warn(`  (waiting on ${label}: ${hash})`);
    }
    await sleep(BLOCK_MS);
  }
}

/**
 * Plan mode: record writes instead of sending them.
 *
 * The demo orchestrator runs the seed's own steps — the same idempotency reads,
 * the same argument building — with this switched on, so every write the seed
 * WOULD send is captured in order, tagged with its sender. It then sends all of
 * them itself: the owner's as one nonce-ordered stream across every fixture,
 * everyone else's on their own nonces. Reusing the steps is the point; a second
 * copy of the seeding logic would be a second thing to get wrong unattended.
 *
 * Off unless something turns it on. `send` returns a stub receipt in plan mode;
 * no step reads receipt fields, which is what makes that safe.
 */
export const PLAN: {
  on: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  calls: { from: Address; label: string; request: any }[];
} = { on: false, calls: [] };

/**
 * Write a contract call and confirm it, reverting loudly if it failed on-chain.
 *
 * `request` is whatever `simulateContract` produced, or a plain write request.
 */
export async function send(
  publicClient: PublicClient,
  wallet: WalletClient,
  label: string,
  // viem's write request type is deeply generic; the orchestrator passes it through untouched.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: any,
  alreadyLanded?: AlreadyLanded,
): Promise<TransactionReceipt> {
  if (PLAN.on) {
    PLAN.calls.push({ from: wallet.account!.address, label, request });
    return { status: "success", gasUsed: 0n, blockNumber: 0n, logs: [] } as unknown as TransactionReceipt;
  }
  const hash: Hash = await wallet.writeContract(request);
  // Pass the sender: without it `confirm` cannot tell a dropped transaction from
  // a slow one and has no choice but to wait out the timeout.
  const from = wallet.account?.address;
  const receipt = await confirm(publicClient, hash, label, from ? { from } : {}).catch(async (err) => {
    if (err instanceof TransactionDropped && alreadyLanded && (await alreadyLanded())) {
      console.warn(`  (${label} was reported dropped but is already on chain)`);
      return null;
    }
    throw err;
  });
  if (receipt === null) return { status: "success" } as TransactionReceipt;
  if (receipt.status !== "success") {
    throw new Error(`${label} reverted on-chain: ${hash}`);
  }
  console.log(`  ${label.padEnd(46)} ${hash}  gas ${receipt.gasUsed}`);
  return receipt;
}

/**
 * How many transactions from one key to keep in flight at once.
 *
 * Overridable because the right number depends on the endpoint, not the code:
 * a provider that rate-limits will reject the tail of a wide batch, and the
 * nonce gap then stalls everything behind it.
 */
const BATCH_CONCURRENCY = Number(process.env.WHISTLE_BATCH_CONCURRENCY ?? 8);

/**
 * Send many transactions from a single key at once, by assigning nonces yourself.
 *
 * One key means one nonce sequence, which is usually taken to mean "send them one
 * at a time and wait for each receipt". That costs a block per transaction: the
 * Sepolia seed is ~225 operator calls, or forty-five minutes of waiting for work
 * the chain would happily do in a handful of blocks.
 *
 * Nothing actually requires waiting — only that each transaction carries the next
 * nonce. So this reads the nonce once, hands out the sequence, and lets the
 * mempool order them. A gap would stall the rest, which is why every send is
 * retried in place rather than abandoned.
 *
 * `calls` are viem write requests without a nonce. Returns in the same order.
 */
export async function sendBatch(
  publicClient: PublicClient,
  wallet: WalletClient,
  label: string,
  // viem's write request type is deeply generic; callers pass theirs through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  calls: { label: string; request: any; alreadyLanded?: AlreadyLanded }[],
): Promise<void> {
  if (calls.length === 0) return;
  const account = wallet.account;
  if (!account) throw new Error("sendBatch needs a wallet with an account");
  if (PLAN.on) {
    for (const c of calls) PLAN.calls.push({ from: account.address, label: c.label, request: c.request });
    return;
  }

  let nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
  const jobs = calls.map((c, i) => ({ ...c, nonce: nonce + i }));

  for (let start = 0; start < jobs.length; start += BATCH_CONCURRENCY) {
    const slice = jobs.slice(start, start + BATCH_CONCURRENCY);
    const hashes = await Promise.all(
      slice.map(async (job) => {
        /*
         * A send that did not happen must never be reported as one that did.
         *
         * This used to fall out of the loop and `return null` after three
         * throttled attempts — and null means "already landed" to the confirm
         * step below. On a real Sepolia seed that silently skipped nonce 329,
         * and every later transaction in the batch sat behind the gap until the
         * receipt wait gave up. Throttling now gets a longer back-off, and if the
         * send still has not been accepted the batch fails loudly: a rerun then
         * resumes from chain state and hands out fresh nonces, gap and all.
         */
        const MAX_THROTTLED = 8;
        for (let attempt = 1; attempt <= MAX_THROTTLED; attempt++) {
          try {
            return await wallet.writeContract({ ...job.request, nonce: job.nonce });
          } catch (err) {
            const msg = String(err);
            // Already mined by an earlier run: the nonce is spent, which is the
            // answer we wanted.
            if (/nonce too low|already known|replacement/i.test(msg)) return null;
            // Provider throttling. The batch is wide on purpose, so back off
            // rather than give up — the nonce is already committed to this call.
            if (/Transaction creation failed|429|rate limit|too many requests/i.test(msg)) {
              await sleep(Math.min(20_000, 2_000 * attempt));
              continue;
            }
            if (attempt >= 3) throw new Error(`${job.label}: ${String(err).slice(0, 160)}`);
            await sleep(1_000 * attempt);
          }
        }
        throw new Error(
          `${job.label}: nonce ${job.nonce} was never accepted after ${MAX_THROTTLED} throttled attempts — ` +
            `stopping rather than leave a nonce gap. Rerun; it resumes from chain state.`,
        );
      }),
    );

    /**
     * Confirm each, and resend the ones the chain dropped.
     *
     * A wide batch is exactly where transactions go missing: the provider
     * accepts eight, drops the tail under load, and the nonces behind the gap
     * can never land. Waiting was the old behaviour and it cost half an hour of
     * silence per gap. Now a dropped hash is detected in about a block and the
     * same nonce is sent again — same nonce, so a resend can only ever replace
     * the missing transaction, never duplicate a landed one.
     */
    await Promise.all(
      hashes.map(async (hash, i) => {
        const job = slice[i]!;
        let current = hash;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          if (!current) return;
          try {
            const receipt = await confirm(publicClient, current, job.label, {
              from: account.address,
              nonce: job.nonce,
            });
            if (receipt.status !== "success") throw new Error(`${job.label} reverted: ${current}`);
            return;
          } catch (err) {
            if (!(err instanceof TransactionDropped) || attempt === 3) throw err;
            // Never resend work the chain already has. See {@link AlreadyLanded}.
            if (job.alreadyLanded && (await job.alreadyLanded())) {
              console.warn(`  (${job.label} was reported dropped but is already on chain — not resending)`);
              return;
            }
            console.warn(`  (${job.label} was dropped, resending nonce ${job.nonce})`);
            current = await wallet
              .writeContract({ ...job.request, nonce: job.nonce })
              .catch((e: unknown) => {
                // The nonce landed after all, between the check and the resend.
                if (/nonce too low|already known/i.test(String(e))) return null;
                throw e;
              });
          }
        }
      }),
    );
    console.log(`  ${label}: ${Math.min(start + slice.length, jobs.length)}/${jobs.length}`);
  }
}
