/**
 * Drive the demo end to end in a headless browser, and time every beat.
 *
 * This exists because "the screens render" and "the demo works" are different
 * claims. A screenshot proves a page painted; it does not prove that Pause wrote
 * to ENS, that Revoke made the next order revert, or that the number on screen
 * matched the chain at the moment it was read. So this clicks the real buttons,
 * signs with a real key, and compares each on-screen value against a direct
 * `eth_call` taken at the same time.
 *
 * The wallet is an injected EIP-1193 provider backed by the demo user's key —
 * headless Chrome has no extension, and mocking the contract calls instead would
 * test nothing. Reads go to the app's own RPC; `eth_sendTransaction` is signed
 * locally and forwarded.
 *
 *   pnpm rehearse -- --url https://localhost:3100
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import "dotenv/config";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { createPublicClient, formatUnits, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { agentRegistryAbi, matchOracleAbi, settlementPotAbi } from "../oracle/abi.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** These run inside the page, where the DOM exists; Node's lib does not have it. */
declare const document: any;

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = resolve("docs/screens/rehearsal");

interface Beat {
  n: number;
  name: string;
  startedAt: number;
  endedAt: number;
  chainWaitMs: number;
  uiWaitMs: number;
  shot: string;
  errors: string[];
  mismatches: string[];
}

const beats: Beat[] = [];
const consoleErrors: string[] = [];
let chainWaitMs = 0;
/** Time spent waiting for the UI to render what the chain already had. */
let uiWaitMs = 0;

const now = (): number => Date.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A wait that is explicitly attributed to waiting on the chain, not on us. */
async function chainWait(ms: number): Promise<void> {
  const t = now();
  await sleep(ms);
  chainWaitMs += now() - t;
}

async function beat<T>(n: number, name: string, page: Page, fn: () => Promise<string[]>): Promise<void> {
  const startedAt = now();
  const before = consoleErrors.length;
  chainWaitMs = 0;
  uiWaitMs = 0;
  let mismatches: string[] = [];
  try {
    mismatches = await fn();
  } catch (err) {
    mismatches = [`beat threw: ${String(err).slice(0, 200)}`];
  }
  const shot = `${SHOTS}/beat-${n}.png`;
  await page.screenshot({ path: shot as `${string}.png`, fullPage: true });
  beats.push({
    n, name, startedAt, endedAt: now(), chainWaitMs, uiWaitMs, shot,
    errors: consoleErrors.slice(before), mismatches,
  });
  const secs = ((now() - startedAt) / 1000).toFixed(1);
  console.log(`beat ${n} ${name} — ${secs}s (chain ${(chainWaitMs / 1000).toFixed(1)}s, ui ${(uiWaitMs / 1000).toFixed(1)}s)` +
    `${mismatches.length ? ` MISMATCH: ${mismatches.join("; ")}` : ""}`);
}

/**
 * An EIP-1193 provider that signs with a real key.
 *
 * Injected before any page script runs, so wagmi's `injected()` connector finds
 * it exactly as it would find a wallet extension.
 */
function injectedWalletSource(address: string, rpcUrl: string): string {
  return `
  (() => {
    const ADDRESS = ${JSON.stringify(address)};
    const RPC = ${JSON.stringify(rpcUrl)};
    let id = 0;
    async function raw(method, params) {
      const res = await fetch(RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
      });
      const json = await res.json();
      if (json.error) throw Object.assign(new Error(json.error.message), json.error);
      return json.result;
    }
    const provider = {
      isMetaMask: true,
      _events: {},
      async request({ method, params }) {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [ADDRESS];
        if (method === "eth_chainId") return "0xaa36a7";
        if (method === "net_version") return "11155111";
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        if (method === "eth_sendTransaction") {
          // Signed on the Node side, which holds the key.
          return await window.__signAndSend(params[0]);
        }
        return await raw(method, params);
      },
      on(event, handler) { (this._events[event] ||= []).push(handler); return this; },
      removeListener() { return this; },
    };
    Object.defineProperty(window, "ethereum", { value: provider, writable: false, configurable: true });
  })();`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const base = (argv.includes("--url") ? argv[argv.indexOf("--url") + 1] : undefined) ?? "https://localhost:3100";
  mkdirSync(SHOTS, { recursive: true });

  // `--rpc` lets the rehearsal run against a fork so the real PRE_MATCH fixture
  // is not consumed by a practice run.
  const rpcUrl =
    (argv.includes("--rpc") ? argv[argv.indexOf("--rpc") + 1] : undefined) ??
    process.env.SEPOLIA_RPC_URL_INFURA ??
    process.env.SEPOLIA_RPC_URL!;
  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });

  /**
   * The key that signs Pause and Revoke must be the mandate's *user*.
   *
   * Pointing an older fixture's user at a newer fixture's agents produces a
   * correct, specific revert ("revokeAgent reverted") that is easy to misread as
   * a UI fault. It is not: `revokeAgent` and the resolver's `setText` are both
   * gated on the user who granted the mandate.
   */
  const userKey = process.env.DEMO_USER_KEY ?? process.env.TOKYO_USER_KEY!;
  const user = privateKeyToAccount((userKey.startsWith("0x") ? userKey : `0x${userKey}`) as `0x${string}`);

  /**
   * Addresses come from the deployment, never from literals.
   *
   * A hard-coded pot and a hard-coded agent index made a correct run look broken:
   * the app drove the new fixture while the checks read the previous one's pot
   * and the previous user's agents, and reported three mismatches that were
   * entirely mine.
   */
  const dep = JSON.parse(readFileSync(resolve("deployments/11155111.json"), "utf8")) as {
    matchOracle: Address; agentRegistry: Address; settlementPot: Address; fixtureId: string;
  };
  const oracle = dep.matchOracle;
  const registry = dep.agentRegistry;
  const pot = dep.settlementPot;
  const LIVE = BigInt(
    (argv.includes("--fixture") ? argv[argv.indexOf("--fixture") + 1] : undefined) ?? "20260923",
  );
  const SETTLED = 20090506n;
  if (LIVE !== BigInt(dep.fixtureId)) {
    throw new Error(`--fixture ${LIVE} but deployments/11155111.json says ${dep.fixtureId}`);
  }

  const browser: Browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    defaultViewport: { width: 520, height: 1400, deviceScaleFactor: 1 },
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage();

  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));

  // The key lives here, not in the page.
  await page.exposeFunction("__signAndSend", async (tx: Record<string, string>) => {
    const walletClient = (await import("viem")).createWalletClient({
      account: user, chain: sepolia, transport: http(rpcUrl),
    });
    const t = now();
    const hash = await walletClient.sendTransaction({
      to: tx.to as Address,
      data: tx.data as `0x${string}`,
      value: tx.value ? BigInt(tx.value) : undefined,
      account: user,
      chain: sepolia,
    });
    await publicClient.waitForTransactionReceipt({ hash, timeout: 300_000 });
    chainWaitMs += now() - t;
    return hash;
  });
  await page.evaluateOnNewDocument(injectedWalletSource(user.address, rpcUrl));

  const text = async (): Promise<string> => page.evaluate(() => document.body.innerText);

  /**
   * Wait for the page to say something, rather than for a fixed number of
   * seconds. A fixed sleep reports "the agents list is empty" when the truth is
   * "the agents list had not finished loading" — which is what a first pass of
   * this script claimed.
   */
  const waitFor = async (re: RegExp, timeoutMs = 45_000): Promise<number> => {
    const t = now();
    while (now() - t < timeoutMs) {
      if (re.test(await text())) return now() - t;
      await sleep(1_000);
    }
    return -1;
  };
  const goto = async (path: string): Promise<void> => {
    await page.goto(`${base}${path}`, { waitUntil: "networkidle2", timeout: 90_000 });
  };
  /** Click the first button whose label matches, and say whether one was found. */
  const click = async (label: string): Promise<boolean> =>
    page.evaluate((l) => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === l);
      if (!b) return false;
      (b as any).click();
      return true;
    }, label);

  const t0 = now();

  // ---------------------------------------------------------------- beat 1
  await beat(1, "Kickoff and the board", page, async () => {
    await goto("/");
    const waited = await waitFor(/Michael Essien/);
    const body = await text();
    const out: string[] = [];
    if (waited < 0) out.push("lineups never rendered");
    uiWaitMs = waited > 0 ? waited : 0;
    const clock = await publicClient.readContract({
      address: oracle, abi: matchOracleAbi, functionName: "matchClock", args: [LIVE],
    });
    if (!body.includes("Whistle")) out.push("header missing");
    if (!/Michael Essien/.test(body)) out.push("Essien row missing");
    // The clock strip should agree with the chain within a minute of play.
    const shown = /(\d+)'/.exec(body)?.[1];
    if (shown !== undefined && Math.abs(Number(shown) - Number(clock)) > 2) {
      out.push(`clock shows ${shown}' chain says ${clock}'`);
    }
    return out;
  });

  // ---------------------------------------------------------------- beat 2
  await beat(2, "9' Essien reprice", page, async () => {
    await sleep(6_000);
    const body = await text();
    const out: string[] = [];
    const card = await publicClient.readContract({
      address: oracle, abi: matchOracleAbi, functionName: "cardOf", args: [LIVE, 5],
    });
    const r = await publicClient.readContract({
      address: pot, abi: settlementPotAbi, functionName: "referencePrice", args: [card],
    });
    const chainPrice = Number(formatUnits(r, 6)).toFixed(2);
    const m = /Michael Essien[^\n]*\n[^\n]*\n?\s*([\d.]+)/.exec(body);
    const shownPrice = /Michael Essien[\s\S]{0,120}?(\d+\.\d{2})/.exec(body)?.[1];
    if (shownPrice && Math.abs(Number(shownPrice) - Number(chainPrice)) > 0.05) {
      out.push(`Essien shows ${shownPrice} chain says ${chainPrice}`);
    }
    if (!shownPrice) out.push(`could not read Essien price from screen (${m ? "regex" : "no row"})`);
    return out;
  });

  // ---------------------------------------------------------------- beat 3
  await beat(3, "Agents screen and mandates", page, async () => {
    await goto("/agents");
    const waited = await waitFor(/agent-\d+\.\w+\.whistle\.eth/);
    const body = await text();
    const out: string[] = [];
    if (waited < 0) out.push("mandates never rendered");
    uiWaitMs = waited > 0 ? waited : 0;
    const count = await publicClient.readContract({
      address: registry, abi: agentRegistryAbi, functionName: "agentCount",
    });
    const shown = /Mandates\s*\n?\s*(\d+)/.exec(body)?.[1];
    if (!/agent-1\.[\w-]+\.whistle\.eth/.test(body)) out.push("no agent-1.<user>.whistle.eth listed");
    if (shown && Number(shown) !== 6) out.push(`mandate count ${shown}, expected 6 of ${count} total`);
    return out;
  });

  // ---------------------------------------------------------------- beat 4
  await beat(4, "66' red card", page, async () => {
    await goto("/");
    // The warm-up batch has already put the clock at 60'; this is the short wait
    // for 66' on the compressed clock, not a three-minute crawl.
    const t = now();
    for (let i = 0; i < 40; i++) {
      const clock = await publicClient.readContract({
        address: oracle, abi: matchOracleAbi, functionName: "matchClock", args: [LIVE],
      });
      if (Number(clock) >= 67) break;
      await sleep(3_000);
    }
    chainWaitMs += now() - t;
    await sleep(6_000);
    const body = await text();
    const out: string[] = [];
    const abidalCard = await publicClient.readContract({
      address: oracle, abi: matchOracleAbi, functionName: "cardOf", args: [LIVE, 21],
    });
    const r = await publicClient.readContract({
      address: pot, abi: settlementPotAbi, functionName: "referencePrice", args: [abidalCard],
    });
    const chainPrice = Number(formatUnits(r, 6));
    const shown = /Eric Abidal[\s\S]{0,140}?(\d+\.\d{2})/.exec(body)?.[1];
    if (shown && Math.abs(Number(shown) - chainPrice) > 0.05) {
      out.push(`Abidal shows ${shown} chain says ${chainPrice.toFixed(2)}`);
    }
    if (!/Sent off/.test(body)) out.push("Abidal not shown as Sent off");
    return out;
  });

  // ---------------------------------------------------------------- beat 5
  await beat(5, "Pause, Revoke, reverted attempt", page, async () => {
    await goto("/agents");
    uiWaitMs = Math.max(0, await waitFor(/agent-\d+\.\w+\.whistle\.eth/));
    const out: string[] = [];

    if (!(await click("Connect"))) out.push("no Connect button");
    await sleep(4_000);

    // The agent the UI will act on: the first one scoped to THIS fixture, which
    // is the order the page lists them in.
    const count = await publicClient.readContract({
      address: registry, abi: agentRegistryAbi, functionName: "agentCount",
    });
    let agent1: Address | undefined;
    for (let i = 0n; i < count; i++) {
      const a = (await publicClient.readContract({
        address: registry, abi: agentRegistryAbi, functionName: "allAgents", args: [i],
      })) as Address;
      const info = await publicClient.readContract({
        address: registry, abi: agentRegistryAbi, functionName: "agentInfo", args: [a],
      });
      if (info[4] === LIVE) { agent1 = a; break; }
    }
    if (!agent1) { out.push("no agent scoped to this fixture"); return out; }

    /**
     * Poll the chain for the effect, rather than sleeping a guessed interval.
     *
     * A fixed 25s wait reported "Pause did not write" on a run where it had —
     * the click fires an approve, a simulate and a send, and the receipt landed
     * a few seconds after the check gave up.
     */
    const until = async (what: string, ok: () => Promise<boolean>, timeoutMs = 120_000): Promise<void> => {
      const t = now();
      while (now() - t < timeoutMs) {
        if (await ok()) { chainWaitMs += now() - t; return; }
        await sleep(3_000);
      }
      chainWaitMs += now() - t;
      out.push(`${what} did not take effect within ${timeoutMs / 1000}s`);
    };

    if (!(await click("Pause"))) out.push("no Pause button");
    await until("Pause", async () => {
      const cap = await publicClient.readContract({
        address: registry, abi: agentRegistryAbi, functionName: "readText", args: [agent1, "spend-cap"],
      });
      return String(cap) === "0";
    });

    if (!(await click("Revoke"))) out.push("no Revoke button");
    await until("Revoke", async () => {
      const stillAgent = await publicClient.readContract({
        address: registry, abi: agentRegistryAbi, functionName: "isAgent", args: [agent1],
      });
      return !stillAgent;
    });
    // The UI needs a beat to run its revert probe and paint the panel.
    await sleep(8_000);

    const body = await text();
    if (!/revert|Unauthorized|Revoked|NotAuthorised|no longer/i.test(body)) {
      out.push("no reverted-attempt panel on screen after Revoke");
    }
    return out;
  });

  // ---------------------------------------------------------------- beat 6
  await beat(6, "Payouts on the settled fixture", page, async () => {
    await goto(`/settlement?f=${SETTLED}`);
    uiWaitMs = Math.max(0, await waitFor(/paid \d/, 90_000));
    const body = await text();
    const out: string[] = [];
    if (!/Settled/.test(body)) out.push("settled fixture does not say Settled");
    if (/never minted/.test(body)) out.push("payout basis missing");
    if (!/\+126\.\d%/.test(body)) out.push("Essien return not shown");
    if (!/−78\.\d%|-78\.\d%/.test(body)) out.push("Abidal return not shown");
    if (!/1,844,592/.test(body)) out.push("settled snapshot missing");
    return out;
  });

  const totalMs = now() - t0;
  const redToSettle = (beats.find((b) => b.n === 6)?.endedAt ?? 0) - (beats.find((b) => b.n === 4)?.startedAt ?? 0);
  const sitDownToPayouts = (beats.find((b) => b.n === 6)?.endedAt ?? 0) - (beats.find((b) => b.n === 4)?.startedAt ?? 0);

  writeFileSync(
    "docs/rehearsal.json",
    `${JSON.stringify({ totalMs, sitDownToPayoutsMs: sitDownToPayouts, beats, consoleErrors }, null, 2)}\n`,
  );

  console.log("\n--- rehearsal ---");
  for (const b of beats) {
    console.log(
      `${b.n} ${b.name.padEnd(34)} ${((b.endedAt - b.startedAt) / 1000).toFixed(1)}s ` +
        `chain ${(b.chainWaitMs / 1000).toFixed(1)}s ui ${(b.uiWaitMs / 1000).toFixed(1)}s errors ${b.errors.length} ` +
        `mismatch ${b.mismatches.length}`,
    );
  }
  console.log(`total ${(totalMs / 1000).toFixed(1)}s, judges sit down -> payouts ${(sitDownToPayouts / 1000).toFixed(1)}s`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
