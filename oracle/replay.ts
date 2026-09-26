/**
 * Replay a historical match on-chain against a compressed clock.
 *
 * Posts `kickoff`, every event in the fixture file, and `postFinal` from the oracle
 * key, while a keeper loop clears the order book on its own cadence. Every
 * transaction hash is logged, and the reference-price table is printed after each
 * event so the price movement is visible as the match runs.
 *
 *   pnpm replay -- --fixture fixtures/che-bar-2009-05-06.json --minutes 6
 *
 * Flags (all optional):
 *   --fixture <path>   fixture JSON                     default fixtures/che-bar-2009-05-06.json
 *   --minutes <n>      wall-clock minutes for 90'       default 6
 *   --clock <preset>   2m | 3m | 6m | 90m, overrides --minutes
 *   --fast-until <m>   post everything up to match minute m back-to-back, then
 *                      pace the rest on the compressed clock. For judging: start
 *                      with --fast-until 60 a couple of minutes before they
 *                      arrive, and the 66' red card lands live in front of them.
 *   --delay <seconds>  narration only; L is fixed on chain per fixture
 *   --tick <seconds>   keeper cadence                   default 5
 *   --cards <n>        distinct cards per tick() call   default 4
 *   --page <n>         orders per card per tick() call  default 16
 *   --dry-run          derive and print, send nothing
 *   --no-keeper        do not run the keeper loop
 *   --single-signer    one service key signs events AND ticks; every write is
 *                      queued behind the previous one's inclusion. The key is
 *                      SERVICE_PRIVATE_KEY, else the `service` key in
 *                      .secrets/derived.json, else ORACLE_PRIVATE_KEY.
 *   --fixture-id <id>  use deployments/fixture-<id>.json (no .env edit)
 *   --confirm <id>     allow this ONE protected fixture; must match the id
 *
 * NOTE ON THE COMPRESSED CLOCK. With the default 6-minute run, one wall-clock
 * second is 15 match seconds, so the 30-second order delay `L` is worth about 7.5
 * match minutes. That is deliberate for a demo — it makes the delay visible — but
 * it is much longer in match terms than a production `L` would be. Set `--minutes
 * 90` for a real-time run, where 30s is 30 match seconds.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  formatEther,
  formatUnits,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";

import { agentRegistryAbi, matchOracleAbi, settlementPotAbi, whistleHookAbi } from "./abi.js";
import { assertFixtureWritable, bindFixture, accountFromEnv, connect, sleep, walletFor } from "./chain.js";
import { loadFixture } from "./fixture.js";
import { deriveFinalScores } from "./scoring.js";
import { EventType, FixtureState, fromUsdc, type Fixture, type MatchEvent } from "./types.js";
import { TransactionDropped, confirm } from "./tx.js";
import { eventAlreadyPosted, eventPostedSince } from "./posted.js";
import { derivedServiceKey } from "./derived.js";
import { privateKeyToAccount } from "viem/accounts";
import { heartbeat } from "./heartbeat.js";

interface Options {
  fixturePath: string;
  compressedMinutes: number;
  /** Post everything up to this match minute back-to-back, then pace normally. */
  fastUntil: number;
  /** Opt-in only. The chain's `L` is authoritative; see the note by the presets. */
  orderDelayOverride?: number;
  keeperIntervalSeconds: number;
  keeperCards: bigint;
  keeperPage: bigint;
  dryRun: boolean;
  runKeeper: boolean;
  /** One service key for oracle and keeper, with every send serialised. */
  singleSigner: boolean;
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const delay = get("--delay");
  return {
    fixturePath: get("--fixture") ?? "fixtures/che-bar-2009-05-06.json",
    compressedMinutes: clockMinutes(get("--clock"), get("--minutes")),
    ...(delay === undefined ? {} : { orderDelayOverride: Number(delay) }),
    keeperIntervalSeconds: Number(get("--tick") ?? 5),
    keeperCards: BigInt(get("--cards") ?? 4),
    keeperPage: BigInt(get("--page") ?? 16),
    fastUntil: Number(get("--fast-until") ?? 0),
    dryRun: argv.includes("--dry-run"),
    runKeeper: !argv.includes("--no-keeper"),
    singleSigner: argv.includes("--single-signer"),
  };
}

const FULL_MATCH = 90;

/**
 * Gas ceilings for the oracle's writes, instead of trusting the estimate.
 *
 * `postEvent` costs more or less depending on state the estimate may not see:
 * a substitution measured 152,950 gas on one run and was estimated at 150,150
 * on the next, so it ran out of gas and the player was never taken off. The
 * limit is only a ceiling — unused gas is not charged — so a generous fixed
 * one costs nothing and removes the failure. Measured maxima: a goal ~248k,
 * `postFinal` ~1.08M.
 */
const POST_EVENT_GAS = 1_000_000n;
const POST_FINAL_GAS = 3_000_000n;

/**
 * `--clock 2m` and friends, falling back to `--minutes`.
 *
 * A preset exists because the number that matters on the day is "how long until
 * this is over", and converting that to a compression ratio in your head while
 * judges are sitting down is exactly the kind of arithmetic to get wrong.
 */
const CLOCK_PRESETS: Record<string, number> = { "2m": 2, "3m": 3, "6m": 6, "90m": 90 };

/** What production uses. Every shorter value here is a demo concession. */
const PRODUCTION_DELAY_SECONDS = 30;

/**
 * `L` is not a preset and not a flag's business.
 *
 * It is fixed on chain when the fixture is created and cannot be changed, so the
 * only honest value to print is the one the contract holds. An earlier version
 * had `--clock 3m` quietly default the *reported* L to 15s while fills still
 * happened at the chain's 30s — printed and effective disagreeing, which is the
 * one thing a number on a demo screen must never do.
 *
 * `--delay` survives as an explicit opt-in for the countdown the driver narrates
 * when running against a fixture deployed with a shorter L. It never changes
 * when a fill happens, and the banner says so whenever it differs.
 */

function clockMinutes(clock: string | undefined, minutes: string | undefined): number {
  if (clock) {
    const preset = CLOCK_PRESETS[clock.toLowerCase()];
    if (preset) return preset;
    const parsed = Number(clock.replace(/m$/i, ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    throw new Error(`unknown --clock "${clock}". Try one of: ${Object.keys(CLOCK_PRESETS).join(", ")}`);
  }
  return Number(minutes ?? 6);
}

/** Wall-clock milliseconds per match minute, from the compression ratio. */
function msPerMatchMinute(opts: Options): number {
  return (opts.compressedMinutes * 60_000) / FULL_MATCH;
}

function banner(fixture: Fixture, opts: Options, onChainL?: number): void {
  const m = fixture.metadata;
  console.log("=".repeat(72));
  console.log(`  ${m.homeTeam} v ${m.awayTeam} — ${m.competition}, ${m.round}`);
  console.log(`  ${m.date}, ${m.venue}. Final score ${m.finalScore}.`);
  console.log("=".repeat(72));
  console.log(`fixtureId        ${fixture.fixtureId}`);
  console.log(`players          ${fixture.players.length}`);
  console.log(`events           ${fixture.events.length}`);
  console.log(`compressed clock 90' -> ${opts.compressedMinutes} min`);
  if (opts.fastUntil > 0) console.log(`fast-forward     to ${opts.fastUntil}' then pace`);

  // The chain's own L, so the printed value is always the one that decides fills.
  const effectiveL = onChainL ?? PRODUCTION_DELAY_SECONDS;
  const delayInMatchMinutes = (effectiveL * FULL_MATCH) / (opts.compressedMinutes * 60);
  console.log(
    `order delay L    ${effectiveL}s on chain  ≈ ${delayInMatchMinutes.toFixed(1)} match minutes` +
      (effectiveL === PRODUCTION_DELAY_SECONDS ? "  (the production value)" : ""),
  );
  if (opts.orderDelayOverride !== undefined && opts.orderDelayOverride !== effectiveL) {
    console.log(
      `                 --delay ${opts.orderDelayOverride}s is narration only; this fixture ` +
        `fills ${effectiveL}s after queueing and that cannot be changed.`,
    );
  }
  console.log(
    `keeper           tick(cards=${opts.keeperCards}, orders/card=${opts.keeperPage})` +
      ` every ${opts.keeperIntervalSeconds}s`,
  );
  console.log("");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  // Chosen on the command line, before anything reads the environment.
  const fixtureId = argv.includes("--fixture-id") ? argv[argv.indexOf("--fixture-id") + 1] : undefined;
  if (fixtureId) process.env.WHISTLE_DEPLOYMENT = `deployments/fixture-${fixtureId}.json`;
  if (argv.includes("--confirm")) process.env.WHISTLE_CONFIRM_FIXTURE = argv[argv.indexOf("--confirm") + 1];
  const fixture = await loadFixture(opts.fixturePath);

  // Resolve which on-chain fixture this match file refers to BEFORE the banner,
  // so the id printed at the top is the one the run will actually drive.
  const { chain, rpcUrl, publicClient, deployment } = connect();
  bindFixture(fixture, deployment);

  // Read L before printing anything: the banner reports the chain's value, not
  // a flag's, so the two can never disagree.
  let onChainL: number | undefined;
  try {
    const f = (await publicClient.readContract({
      address: deployment.matchOracle,
      abi: matchOracleAbi,
      functionName: "fixtures",
      args: [fixture.fixtureId],
    })) as readonly unknown[];
    onChainL = Number(f[4]);
  } catch {
    /* dry runs and un-deployed fixtures have no L to read */
  }

  banner(fixture, opts, onChainL);

  // Derive the final scores from the event list before touching the chain. These go
  // into postFinal as the assert-equal array, so settlement cross-checks this
  // implementation against the contract's own accrual.
  const derived = deriveFinalScores(fixture.players, fixture.events);
  console.log("derived final scores (S), from the event list alone:");
  for (const p of fixture.players) {
    const s = derived.finalScores[p.id] ?? 0n;
    if (s === 0n) continue;
    console.log(
      `  ${String(p.id).padStart(2)} ${p.name.padEnd(20)} ${formatEther(s).padStart(10)} pts` +
        `  (${derived.minutes[p.id] ?? 0}')`,
    );
  }
  console.log("");

  if (opts.dryRun) {
    console.log("--dry-run: nothing was sent. Derivation above is the whole output.");
    return;
  }

  // Last stop before the first write. A replay settles the fixture it runs on,
  // and a settled fixture cannot be reopened.
  assertFixtureWritable(fixture.fixtureId, "replay");

  /*
   * Single-signer mode: one service key is the oracle AND the keeper.
   *
   * The keeper loop runs concurrently with event posting, so two writes from
   * one key can be in flight at once — and they draw from the same nonce
   * sequence. That is the collision the warning below has always described.
   * `--single-signer` makes it safe instead of warned about: both roles share
   * one wallet whose `writeContract` is queued, and each send waits for the
   * previous one's inclusion (bounded, best effort) before it goes. Nothing at
   * the call sites changes; `confirm` still decides what happened.
   */
  const derivedService = opts.singleSigner && !process.env.SERVICE_PRIVATE_KEY ? derivedServiceKey() : null;
  const oracleAccount = opts.singleSigner
    ? derivedService
      ? privateKeyToAccount(derivedService)
      : accountFromEnv(process.env.SERVICE_PRIVATE_KEY ? "SERVICE_PRIVATE_KEY" : "ORACLE_PRIVATE_KEY")
    : accountFromEnv("ORACLE_PRIVATE_KEY");
  const oracleWallet = opts.singleSigner
    ? serialised(walletFor(oracleAccount, chain, rpcUrl), publicClient)
    : walletFor(oracleAccount, chain, rpcUrl);

  const keeperAccount = opts.singleSigner
    ? oracleAccount
    : process.env.KEEPER_PRIVATE_KEY
      ? accountFromEnv("KEEPER_PRIVATE_KEY")
      : oracleAccount;
  const keeperWallet = opts.singleSigner ? oracleWallet : walletFor(keeperAccount, chain, rpcUrl);

  /**
   * The presenter's glance-check.
   *
   * A keeper with an empty queue and a keeper that has died print the same
   * nothing. This prints a line every ten seconds either way, with counters that
   * have to move.
   */
  const beat = heartbeat("keeper", ["ticks", "fills", "errors"]);

  if (opts.singleSigner) {
    console.log("single-signer    oracle and keeper share one key; every write is queued");
  } else if (keeperAccount.address === oracleAccount.address) {
    console.warn(
      "! KEEPER_PRIVATE_KEY is unset, so the keeper is signing as the oracle.\n" +
        "  The two send concurrently, so they will collide on nonce and this run will\n" +
        "  stall on a receipt that never arrives. Give the keeper its own key.",
    );
  }

  console.log(`network          ${chain.name} (${chain.id})`);
  console.log(`oracle           ${oracleAccount.address}`);
  console.log(`keeper           ${keeperAccount.address}`);
  console.log(`MatchOracle      ${deployment.matchOracle}`);
  console.log(`SettlementPot    ${deployment.settlementPot}`);
  console.log(`WhistleHook      ${deployment.whistleHook}`);
  console.log("");

  /**
   * `sourceTimestamp` is checked against the CHAIN's clock, not ours:
   * `MatchOracle` rejects anything ahead of `block.timestamp` as a FutureEvent and
   * anything more than `L + staleTolerance` behind it as stale. On a local fork
   * `block.timestamp` sits at the fork block while the wall clock runs on, so a
   * `Date.now()` stamp is minutes in the future and every event is rejected.
   * Reading the chain is correct on a live network too, where the latest block is
   * within a few seconds of now.
   */
  const chainNow = async (): Promise<bigint> => {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    return block.timestamp;
  };

  /**
   * Confirm one transaction, and never resend work the chain already has.
   *
   * `landed` is supplied for `postEvent` only. That call is the one the oracle
   * accepts twice — equal minutes are legal, so a re-post is applied again
   * rather than rejected — and a watcher that gives up while the transaction is
   * mining looks exactly like a drop. Asking the chain by event identity is the
   * difference between a missed receipt and a double substitution.
   */
  const send = async (label: string, hash: Hash, landed?: () => Promise<boolean>): Promise<void> => {
    try {
      const receipt = await confirm(publicClient, hash, label, { from: oracleAccount.address });
      /*
       * A mined transaction is not a successful one.
       *
       * This used to print a reverted `postEvent` exactly like a good one and
       * carry on. On a fork the 65' substitution ran out of gas, the replay
       * logged it as a normal line, and ninety minutes later `postFinal`
       * rejected the match with `FinalScoreMismatch` for a player the chain
       * never took off. An event the chain refused must stop the match here,
       * where the cause is, not at full time.
       */
      if (receipt.status !== "success") {
        throw new Error(`${label} REVERTED on chain (gas used ${receipt.gasUsed}): ${hash}`);
      }
      console.log(
        `  tx ${label.padEnd(26)} ${hash}  block ${receipt.blockNumber}  gas ${receipt.gasUsed}`,
      );
    } catch (err) {
      if (err instanceof TransactionDropped && landed && (await landed())) {
        console.log(`  tx ${label.padEnd(26)} ${hash}  (no receipt, but the event is on chain)`);
        return;
      }
      throw err;
    }
  };

  // Cards, in player-id order, for the R table. One multicall rather than one
  // round trip per player: against a forked node every miss is a remote fetch, and
  // 28 sequential reads per event is the difference between a demo that keeps up
  // with the compressed clock and one that falls behind it.
  const cards: Address[] = (await chunkedMulticall(
    publicClient,
    fixture.players.map((p) => ({
      address: deployment.matchOracle,
      abi: matchOracleAbi,
      functionName: "cardOf" as const,
      args: [fixture.fixtureId, p.id] as const,
    })),
  )) as Address[];

  const state = await publicClient.readContract({
    address: deployment.matchOracle,
    abi: matchOracleAbi,
    functionName: "fixtureState",
    args: [fixture.fixtureId],
  });

  if (state === FixtureState.PRE_MATCH) {
    /*
     * Refuse to kick off while the agents are bound to another fixture.
     *
     * AgentRegistry has one market and every fixture's deploy repoints it; on a
     * fixture that is not the market, the first agent fill reverts `OnlyMarket`
     * and the tick reverts with it. This driver holds only the service key, which
     * cannot call `setMarket`, so it says what to run instead.
     */
    const market = await publicClient.readContract({
      address: deployment.agentRegistry, abi: agentRegistryAbi, functionName: "market",
    });
    if (market.toLowerCase() !== deployment.whistleHook.toLowerCase()) {
      throw new Error(
        `agents are bound to another fixture (market ${market}, this hook ${deployment.whistleHook}).\n` +
          `  Activate first:  npx tsx scripts/activate-fixture.ts ${fixture.fixtureId}`,
      );
    }
    console.log("KICKOFF");
    await send(
      "kickoff",
      await oracleWallet.writeContract({
        address: deployment.matchOracle,
        abi: matchOracleAbi,
        functionName: "kickoff",
        args: [fixture.fixtureId],
        chain,
        account: oracleAccount,
      }),
    );
  } else if (state === FixtureState.LIVE) {
    console.log("fixture is already LIVE; resuming.");
  } else {
    throw new Error("fixture is already SETTLED");
  }
  console.log("");

  // The keeper runs on its own cadence, independent of the event stream, exactly as
  // it would in production. `tick` is paginated, so a busy minute simply takes more
  // calls rather than a bigger one.
  let keeping = opts.runKeeper;
  const keeperLoop = async (): Promise<void> => {
    while (keeping) {
      try {
        const queued = await publicClient.readContract({
          address: deployment.whistleHook,
          abi: whistleHookAbi,
          functionName: "queueLength",
          args: [fixture.fixtureId],
        });
        const head = await publicClient.readContract({
          address: deployment.whistleHook,
          abi: whistleHookAbi,
          functionName: "queueHead",
          args: [fixture.fixtureId],
        });

        if (head < queued) {
          const hash = await keeperWallet.writeContract({
            address: deployment.whistleHook,
            abi: whistleHookAbi,
            functionName: "tick",
            // Paged by card: the expensive part of a tick is per card, so keeping
            // a card's orders together is what makes the batch worth batching.
            args: [fixture.fixtureId, opts.keeperCards, opts.keeperPage],
            chain,
            account: keeperAccount,
          });
          const receipt = await confirm(publicClient, hash, "tick", {
            from: keeperAccount.address,
          });
          // Same rule as the oracle's writes: mined is not the same as applied.
          if (receipt.status !== "success") throw new Error(`tick REVERTED on chain: ${hash}`);
          const fills = receipt.logs.length;
          beat.bump("ticks");
          beat.bump("fills", fills);
          console.log(
            `  keeper tick  head ${head}/${queued}  ${hash}  gas ${receipt.gasUsed}  logs ${fills}`,
          );
        }
        beat.set("queue", `${head}/${queued}`);
      } catch (err) {
        beat.bump("errors");
        console.error(`  keeper error: ${(err as Error).message.split("\n")[0]}`);
      }
      await sleep(opts.keeperIntervalSeconds * 1000);
    }
  };
  const keeperTask = keeperLoop();
  process.on("exit", () => beat.stop());

  // ------------------------------------------------------------- the match

  const perMinute = msPerMatchMinute(opts);
  const startedAt = Date.now();
  let lastMinute = 0;
  /** Where the paced clock is measured from; moves while fast-forwarding. */
  let pacedFrom = { minute: 0, at: startedAt };

  /*
   * Resuming a LIVE fixture: post only what the chain has not seen.
   *
   * The loop below used to start at 5' whatever the chain said. Anything before
   * the oracle's clock reverts `NonMonotonicMinute` and stopped the replay; worse,
   * anything AT the clock is accepted again (`postEvent` allows minute == clock),
   * which is how a minute-group gets applied twice and `postFinal` strands on
   * `FinalScoreMismatch`. So events before the clock are skipped, and those at
   * the clock are skipped if they are anywhere in the fixture's MatchEvent history.
   */
  if (state === FixtureState.LIVE) {
    const clock = Number(await publicClient.readContract({
      address: deployment.matchOracle, abi: matchOracleAbi, functionName: "matchClock", args: [fixture.fixtureId],
    }));
    const remaining: typeof fixture.events = [];
    for (const ev of fixture.events) {
      if (ev.minute < clock) continue;
      if (ev.minute === clock && await eventPostedSince(publicClient, {
        oracle: deployment.matchOracle, fixtureId: fixture.fixtureId, minute: ev.minute, eventType: ev.type, playerIds: ev.players,
      }, BigInt((deployment as { deployBlock?: number }).deployBlock ?? 0))) continue;
      remaining.push(ev);
    }
    console.log(`resuming at ${clock}': ${fixture.events.length - remaining.length} events already on chain, ${remaining.length} to post`);
    fixture.events = remaining;
    lastMinute = clock;
    pacedFrom = { minute: clock, at: startedAt };
  }

  /**
   * The warm-up, sent as one batch.
   *
   * "Back-to-back" used to mean "send the next one as soon as the last is
   * mined", which is a Sepolia block each: fourteen warm-up events cost about
   * 170 seconds, and the judges watched an empty board for most of it. Nothing
   * required that wait. `postEvent` only asks that minutes never go backwards
   * (`minute >= clock`) and that the source timestamp is not in the future and
   * not more than `L + staleTolerance` old — 630 seconds here. Sequential nonces
   * give the ordering; the staleness budget covers the whole batch comfortably.
   *
   * So the events go out together and only the last receipt is awaited.
   */
  const warmUp = fixture.events.filter((e) => e.minute <= opts.fastUntil);
  if (warmUp.length > 0) {
    console.log(
      `\nfast-forwarding: ${warmUp.length} events up to ${opts.fastUntil}' in one batch, ` +
        `then the compressed clock takes over.`,
    );
    const t0 = Date.now();
    const stamp = await chainNow();
    let nonce = await publicClient.getTransactionCount({
      address: oracleAccount.address,
      blockTag: "pending",
    });

    const hashes: Hash[] = [];
    for (const ev of warmUp) {
      hashes.push(
        await oracleWallet.writeContract({
          address: deployment.matchOracle,
          abi: matchOracleAbi,
          functionName: "postEvent",
          gas: POST_EVENT_GAS,
          args: [fixture.fixtureId, ev.minute, ev.type, ev.players, stamp],
          chain,
          account: oracleAccount,
          nonce: nonce++,
        }),
      );
      const names = ev.players.map((id) => fixture.players[id]?.name ?? `#${id}`).join(" -> ");
      console.log(`  queued ${ev.minute}' ${EventType[ev.type]}${names ? `  ${names}` : ""}`);
    }

    // Only the last one matters: nonces guarantee the rest landed before it.
    const last = hashes[hashes.length - 1]!;
    await confirm(publicClient, last, `warm-up to ${opts.fastUntil}'`);
    lastMinute = warmUp[warmUp.length - 1]!.minute;
    pacedFrom = { minute: lastMinute, at: Date.now() };
    console.log(
      `  warm-up complete at ${lastMinute}' in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
        `(${warmUp.length} events, 1 wait)\n`,
    );
    await printReferenceTable(publicClient, deployment.settlementPot, fixture, cards, warmUp[warmUp.length - 1]!);
  }

  for (const ev of fixture.events) {
    // Already sent in the warm-up batch above.
    if (ev.minute <= opts.fastUntil) continue;

    /**
     * After the warm-up the compressed clock resumes from *now* rather than from
     * kickoff, so the remaining minutes play at the advertised speed instead of
     * instantly catching up on the time the warm-up skipped.
     */
    const dueAt = pacedFrom.at + (ev.minute - pacedFrom.minute) * perMinute;
    const wait = dueAt - Date.now();
    if (process.env.WHISTLE_TRACE) {
      console.log(`  [trace] next ${ev.minute}' in ${Math.max(0, Math.round(wait / 1000))}s`);
    }
    if (wait > 0) await sleep(wait);
    if (process.env.WHISTLE_TRACE) console.log(`  [trace] woke for ${ev.minute}'`);

    const label = `${ev.minute}' ${EventType[ev.type]}`;
    const names = ev.players.map((id) => fixture.players[id]?.name ?? `#${id}`).join(" -> ");
    console.log(`${label}${names ? `  ${names}` : ""}${ev.note ? `   (${ev.note})` : ""}`);

    if (process.env.WHISTLE_TRACE) console.log(`  [trace] sending postEvent ${ev.minute}'`);
    await send(
      `postEvent ${ev.minute}' ${EventType[ev.type]}`,
      await oracleWallet.writeContract({
        address: deployment.matchOracle,
        abi: matchOracleAbi,
        functionName: "postEvent",
          gas: POST_EVENT_GAS,
        args: [fixture.fixtureId, ev.minute, ev.type, ev.players, await chainNow()],
        chain,
        account: oracleAccount,
      }),
      () =>
        eventAlreadyPosted(publicClient, {
          oracle: deployment.matchOracle,
          fixtureId: fixture.fixtureId,
          minute: ev.minute,
          eventType: ev.type,
          playerIds: ev.players,
        }),
    );

    if (process.env.WHISTLE_TRACE) console.log(`  [trace] reading R table`);
    await printReferenceTable(publicClient, deployment.settlementPot, fixture, cards, ev);
    lastMinute = ev.minute;
  }

  // ------------------------------------------------------------- settlement

  console.log("");
  console.log(`FULL TIME (clock ${lastMinute}')`);

  /*
   * Never strand at full time.
   *
   * The derived S[] is a cross-check; the pot pays on its own numbers either way.
   * So it is simulated first, and on `FinalScoreMismatch` the mismatch is printed
   * loudly — the chain applied a different event list from this file, which is
   * a bug to chase — and the fixture settles with an empty array, the contract's
   * "skip the check". Fixture A stranded at 93' on exactly this, after its 9'
   * goal was posted twice. Any other revert still stops the replay.
   */
  let expectedS: bigint[] = fixture.players.map((p) => derived.finalScores[p.id] ?? 0n);
  let mismatched = false;
  try {
    await publicClient.simulateContract({
      address: deployment.matchOracle, abi: matchOracleAbi, functionName: "postFinal",
      args: [fixture.fixtureId, expectedS], account: oracleAccount,
    });
  } catch (err) {
    const reverted = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
    if (!(reverted instanceof ContractFunctionRevertedError) || reverted.data?.errorName !== "FinalScoreMismatch") throw err;
    const [playerId, computed, expected] = reverted.data.args as [number, bigint, bigint];
    const name = fixture.players.find((p) => p.id === Number(playerId))?.name ?? `#${playerId}`;
    console.error("");
    console.error("  !!! FINAL SCORE MISMATCH !!!");
    console.error(`  player ${playerId} (${name}): chain ${formatUnits(computed, 18)}, derived ${formatUnits(expected, 18)}`);
    console.error("  The chain applied a different event list from the fixture file — check for a duplicated minute-group.");
    console.error("  Settling with an empty expectedS[] so the pot's own scores stand.");
    console.error("");
    expectedS = [];
    mismatched = true;
  }
  await send(
    "postFinal",
    await oracleWallet.writeContract({
      address: deployment.matchOracle,
      abi: matchOracleAbi,
      functionName: "postFinal",
      gas: POST_FINAL_GAS,
      args: [fixture.fixtureId, expectedS],
      chain,
      account: oracleAccount,
    }),
  );
  console.log(
    mismatched
      ? "  postFinal settled on the chain's own scores (derived S[] did NOT match — see above)."
      : "  postFinal accepted the derived S[] — off-chain and on-chain scoring agree.",
  );

  // Let the keeper drain anything still queued, then stop it.
  await sleep(opts.keeperIntervalSeconds * 1000 * 2);
  keeping = false;
  await keeperTask;

  const potLeft = await publicClient.readContract({
    address: deployment.settlementPot,
    abi: settlementPotAbi,
    functionName: "potBalance",
  });
  const snapshot = await publicClient.readContract({
    address: deployment.settlementPot,
    abi: settlementPotAbi,
    functionName: "potSnapshot",
  });
  console.log("");
  console.log(`settlement snapshot  ${fromUsdc(snapshot)} USDC`);
  console.log(`pot balance now      ${fromUsdc(potLeft)} USDC (drains as holders redeem)`);
}

/** The R table: what every card with supply is worth right now. */
/**
 * A wallet whose writes go one at a time, each after the last one is mined.
 *
 * The lock is a promise chain: every `writeContract` waits for the previous
 * send AND its inclusion, then sends. Waiting is bounded and failure is
 * swallowed here on purpose — the queue only promises not to race the nonce;
 * whether a transaction landed is still `confirm`'s call, at the call site,
 * with its dropped-versus-slow reasoning and the `postEvent` already-landed
 * check intact.
 */
function serialised<W extends { writeContract: (...args: never[]) => Promise<Hash> }>(
  wallet: W,
  publicClient: PublicClient,
): W {
  let tail: Promise<unknown> = Promise.resolve();
  const original = wallet.writeContract.bind(wallet) as (...args: unknown[]) => Promise<Hash>;
  const writeContract = (...args: unknown[]): Promise<Hash> => {
    const run = tail.then(async () => {
      const hash = await original(...args);
      await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 }).catch(() => undefined);
      return hash;
    });
    tail = run.catch(() => undefined);
    return run;
  };
  return { ...wallet, writeContract } as W;
}

async function printReferenceTable(
  publicClient: ReturnType<typeof connect>["publicClient"],
  pot: Address,
  fixture: Fixture,
  cards: Address[],
  ev: MatchEvent,
): Promise<void> {
  const touched = new Set(ev.players);

  const calls = fixture.players.flatMap((p) => {
    const card = cards[p.id];
    if (!card) return [];
    return [
      { address: pot, abi: settlementPotAbi, functionName: "referencePrice" as const, args: [card] as const },
      { address: pot, abi: settlementPotAbi, functionName: "supplyOf" as const, args: [card] as const },
    ];
  });

  const results = await chunkedMulticall(publicClient, calls);

  const rows: string[] = [];
  let i = 0;
  for (const p of fixture.players) {
    if (!cards[p.id]) continue;
    const r = results[i++] as bigint;
    const supply = results[i++] as bigint;
    if (supply === 0n) continue;
    rows.push(
      `    ${touched.has(p.id) ? "*" : " "} ${p.name.padEnd(20)} R = ${fromUsdc(r).padStart(10)} USDC`,
    );
  }

  console.log(rows.join("\n"));
  console.log("");
}

/**
 * Multicall in small batches rather than one large one.
 *
 * A single `eth_call` bundling fifty-odd reads is fine against a warm node and
 * pathological against a cold fork: every storage slot the batch touches has to be
 * backfilled from the upstream RPC before the call can return, so the whole table
 * blocks on the slowest fetch. Ten at a time keeps each round trip short while
 * still cutting the request count by an order of magnitude.
 */
const MULTICALL_CHUNK = 10;

async function chunkedMulticall(
  publicClient: ReturnType<typeof connect>["publicClient"],
  calls: readonly unknown[],
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < calls.length; i += MULTICALL_CHUNK) {
    const slice = calls.slice(i, i + MULTICALL_CHUNK);
    const part = await publicClient.multicall({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contracts: slice as any,
      allowFailure: false,
    });
    out.push(...(part as unknown[]));
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
