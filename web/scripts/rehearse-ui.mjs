/**
 * Drive the demo through a real browser and time every beat.
 *
 * "The screens render" and "the demo works" are different claims. This clicks the
 * real buttons, sends real transactions, and compares what is on screen against a
 * direct `eth_call` taken at the same moment — so a number that is stale, or a
 * badge that moved before the chain did, shows up as a disagreement rather than
 * as a screenshot that looks fine.
 *
 * It runs against a FORK. The wallet is an injected EIP-1193 provider that
 * forwards `eth_sendTransaction` to anvil, which signs as the impersonated demo
 * user — so no private key is handled here at all.
 *
 *   node scripts/rehearse-ui.mjs --url https://localhost:3100 --rpc http://127.0.0.1:8545
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import puppeteer from "puppeteer-core";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const BASE = arg("url", "https://localhost:3100");
const RPC = arg("rpc", "http://127.0.0.1:8545");
const USER = arg("user", "");
const OUT = resolve(arg("out", "docs/screens/rehearsal"));
const FIXTURE = arg("fixture", "20260923");
const SETTLED = arg("settled", "20090506");

mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

// ------------------------------------------------------------------ chain

let rpcId = 0;
async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  }).then((r) => r.json());
  if (res.error) throw new Error(`${method}: ${res.error.message}`);
  return res.result;
}

const registryAbi = parseAbi([
  "function agentCount() view returns (uint256)",
  "function allAgents(uint256 index) view returns (address)",
  "function agentInfo(address agent) view returns (address user, address registry, address resolver, uint256 tokenId, uint256 fixtureId, uint256 templateId, uint256 spentUSDC, string fqdn)",
  "function readText(address agent, string key) view returns (string)",
]);

const ensRegistryAbi = parseAbi(["function getStatus(uint256 id) view returns (uint8)"]);

const oracleAbi = parseAbi([
  "function fixtures(uint256 fixtureId) view returns (address pot, uint8 state, uint16 clock, uint16 playerCount, uint32 orderDelayL, uint32 staleTolerance, uint64 lastEventAt, bool team0Conceded, bool team1Conceded, bool finalized)",
]);

async function call(abi, functionName, to, args) {
  const data = encodeFunctionData({ abi, functionName, args });
  const raw = await rpc("eth_call", [{ to, data }, "latest"]);
  return decodeFunctionResult({ abi, functionName, data: raw });
}

/** Every mandate on this fixture, by label. */
async function mandates(registry, fixtureId) {
  const n = await call(registryAbi, "agentCount", registry, []);
  const out = new Map();
  for (let i = 0n; i < n; i += 1n) {
    const a = await call(registryAbi, "allAgents", registry, [i]);
    let info;
    try {
      info = await call(registryAbi, "agentInfo", registry, [a]);
    } catch {
      continue;
    }
    if (info[4].toString() !== String(fixtureId)) continue;
    out.set(info[7].split(".")[0], { agent: a, registry: info[1], tokenId: info[3], fqdn: info[7] });
  }
  return out;
}

/**
 * Wait for the CHAIN to agree, not the badge.
 *
 * The agents screen moves its badge the moment you click, on purpose — a button
 * that only greys out for twenty-five seconds reads as a dead click. That makes
 * the badge useless as a latency measurement: it reports zero every time. These
 * poll the contracts instead.
 */
async function untilChain(read, want, timeoutMs, label) {
  const started = now();
  for (;;) {
    let v;
    try {
      v = await read();
    } catch {
      v = undefined;
    }
    if (want(v)) return now() - started;
    if (now() - started > timeoutMs) throw new Error(`chain never showed ${label} within ${timeoutMs}ms`);
    await sleep(500);
  }
}

/** The fixture's own clock, straight from the oracle, with no UI in between. */
async function chainClock(oracle, fixtureId) {
  const data = encodeFunctionData({ abi: oracleAbi, functionName: "fixtures", args: [BigInt(fixtureId)] });
  const raw = await rpc("eth_call", [{ to: oracle, data }, "latest"]);
  const out = decodeFunctionResult({ abi: oracleAbi, functionName: "fixtures", data: raw });
  return { state: Number(out[1]), clock: Number(out[2]) };
}

// ------------------------------------------------------------------ browser

const provider = (rpcUrl, user) => `
  (() => {
    const accounts = ${JSON.stringify(user ? [user] : [])};
    let id = 0;
    const listeners = new Map();
    window.ethereum = {
      isMetaMask: true,
      chainId: "0xaa36a7",
      on: (e, fn) => listeners.set(e, [...(listeners.get(e) ?? []), fn]),
      removeListener: (e, fn) =>
        listeners.set(e, (listeners.get(e) ?? []).filter((f) => f !== fn)),
      async request({ method, params }) {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return accounts;
        if (method === "eth_chainId") return "0xaa36a7";
        if (method === "net_version") return "11155111";
        if (method === "wallet_switchEthereumChain") return null;
        // eth_sendTransaction goes straight through: anvil signs as the
        // impersonated account, so nothing here ever holds a key.
        const res = await fetch(${JSON.stringify(rpcUrl)}, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
        }).then((r) => r.json());
        if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code });
        return res.result;
      },
    };
  })();
`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox"],
});

const errors = [];
const page = await browser.newPage();
page.on("console", (m) => m.type() === "error" && errors.push({ at: now(), text: m.text().slice(0, 180) }));
page.on("pageerror", (e) => errors.push({ at: now(), text: String(e).slice(0, 180) }));
await page.evaluateOnNewDocument(provider(RPC, USER));
await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 2 });

async function go(path) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2", timeout: 90_000 });
  if (USER) {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Connect");
      b?.click();
    });
  }
}

const textOf = () => page.evaluate(() => document.body.innerText);

async function clickText(label) {
  return page.evaluate((l) => {
    const el = [...document.querySelectorAll("button, a")].find(
      (b) => b.textContent?.trim().toLowerCase() === l.toLowerCase(),
    );
    if (!el) return false;
    el.click();
    return true;
  }, label);
}

/**
 * Poll until `check(text)` is true, or give up. Returns ms waited.
 *
 * The text is lowercased first. Every badge in the app is lowercase in the DOM
 * with CSS uppercasing it, and `innerText` applies `text-transform` in some
 * engines and not others — a matcher that cared would pass or fail depending on
 * the browser rather than on the app.
 */
async function until(check, timeoutMs, label) {
  const started = now();
  for (;;) {
    const t = (await textOf()).toLowerCase();
    if (check(t)) return now() - started;
    if (now() - started > timeoutMs) {
      throw new Error(
        `timed out waiting for ${label} after ${timeoutMs}ms; page said: ${t.replace(/\s+/g, " ").slice(0, 300)}`,
      );
    }
    await sleep(1_000);
  }
}

// ------------------------------------------------------------------- beats

const beats = [];
let errorsSeen = 0;

async function beat(n, name, fn) {
  const started = now();
  const before = errors.length;
  let note = "";
  let waits = [];
  try {
    const r = (await fn({ waits })) ?? {};
    note = r.note ?? "";
  } catch (err) {
    note = `FAILED: ${String(err).slice(0, 160)}`;
  }
  const file = `${OUT}/beat-${n}-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`;
  await page.screenshot({ path: file, fullPage: true });
  const row = {
    n,
    name,
    seconds: ((now() - started) / 1000).toFixed(1),
    waits: waits.filter((w) => w.ms >= 10_000),
    consoleErrors: errors.length - before,
    note,
    file,
  };
  beats.push(row);
  errorsSeen = errors.length;
  console.log(
    `beat ${n} ${name.padEnd(30)} ${row.seconds}s  ${row.consoleErrors} console errors  ${row.note}`,
  );
  return row;
}

// --------------------------------------------------------------------- run

const deployment = JSON.parse(readFileSync(resolve("vendor/fixtures.json"), "utf8")).find(
  (f) => f.fixtureId === FIXTURE,
);
if (!deployment) throw new Error(`no deployment for fixture ${FIXTURE} in vendor/fixtures.json`);

console.log(`driving ${BASE} against ${RPC}`);
console.log(`fixture ${FIXTURE} · oracle ${deployment.matchOracle}`);
{
  const c = await chainClock(deployment.matchOracle, FIXTURE);
  console.log(`chain says state ${c.state}, clock ${c.clock}'`);
}

const t0 = now();

await go("/fixture");
console.log("board loaded; waiting for 60'");

// ---- beat 1: the board at 60'
await beat(1, "fixture pitch at 60", async ({ waits }) => {
  const started = now();
  await until((t) => /\b6[0-9]'/.test(t) || /full time/.test(t), 300_000, "clock to reach 60'");
  waits.push({ ms: now() - started, cause: "replay fast-forward to 60'" });
  const chain = await chainClock(deployment.matchOracle, FIXTURE);
  const t = await textOf();
  const shown = /(\d{1,3})'/.exec(t)?.[1];
  const disagree =
    shown !== undefined && Math.abs(Number(shown) - chain.clock) > 2
      ? `UI clock ${shown}' vs chain ${chain.clock}'`
      : "";
  return { note: `chain ${chain.clock}' state ${chain.state}${disagree ? ` — ${disagree}` : " — agrees"}` };
});

// ---- beat 2: the 66' red card
await beat(2, "66 red card", async ({ waits }) => {
  const started = now();
  await until((t) => /10 men/.test(t), 240_000, "the away side to go to ten");
  const seen = now();
  waits.push({ ms: seen - started, cause: "waiting for the 66' RED to land" });
  const chain = await chainClock(deployment.matchOracle, FIXTURE);
  return { note: `10 MEN visible at chain ${chain.clock}', ${((seen - started) / 1000).toFixed(1)}s after beat 1` };
});

// ---- beat 3: pause and revoke
await beat(3, "agents pause and revoke", async ({ waits }) => {
  await go("/agents");
  await until((t) => /agent-1\./.test(t), 90_000, "the mandate list");

  const live = await mandates(deployment.agentRegistry, FIXTURE);
  const pauseTarget = live.get("agent-1");
  const revokeTarget = live.get("agent-6");

  const pauseStarted = now();
  if (!(await clickText("Pause"))) return { note: "FAILED: no Pause button" };
  const pauseBadgeMs = await until((t) => /paused/.test(t), 180_000, "the PAUSED badge");
  const pauseChainMs = await untilChain(
    () => call(registryAbi, "readText", deployment.agentRegistry, [pauseTarget.agent, "spend-cap"]),
    (v) => v === "0",
    180_000,
    "spend-cap = 0",
  );
  waits.push({ ms: pauseChainMs, cause: "Pause → spend-cap = 0 on chain" });

  // Revoke the last live mandate rather than the one just paused.
  const revokeStarted = now();
  const clicked = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("section")];
    for (let i = cards.length - 1; i >= 0; i -= 1) {
      const c = cards[i];
      if (!/agent-6\./.test(c.textContent ?? "")) continue;
      const b = [...c.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Revoke");
      if (b) {
        b.click();
        return true;
      }
    }
    return false;
  });
  if (!clicked) return { note: `paused; no Revoke button for agent-6` };

  const revokeBadgeMs = await until((t) => /revoked/.test(t), 240_000, "the REVOKED badge");
  const revokeChainMs = await untilChain(
    () => call(ensRegistryAbi, "getStatus", revokeTarget.registry, [revokeTarget.tokenId]),
    (v) => v !== undefined && Number(v) !== 2,
    240_000,
    "the name to stop being REGISTERED",
  );
  waits.push({ ms: revokeChainMs, cause: "Revoke → name unregistered on chain" });

  let revertMs = 0;
  try {
    revertMs = await until((t) => /mandate revoked/.test(t), 120_000, "the revert proof");
    waits.push({ ms: now() - revokeStarted, cause: "Revoke click → revert proof on screen" });
  } catch {
    /* proof panel is best effort */
  }
  const ms = (x) => `${(x / 1000).toFixed(1)}s`;
  return {
    note:
      `Pause badge ${ms(pauseBadgeMs)} / chain ${ms(pauseChainMs)}; ` +
      `Revoke badge ${ms(revokeBadgeMs)} / chain ${ms(revokeChainMs)}; ` +
      `revoke→revert proof ${ms(revertMs)}`,
  };
});

// ---- beat 4: the revoked agent's profile
await beat(4, "revoked agent profile", async () => {
  await go("/profile/agent-6");
  await until((t) => /on-chain records/.test(t), 120_000, "the records table");

  // "revoked" appears on every profile — it is one of the record keys. The
  // header line below is rendered only when the name is actually unregistered.
  const revoked = await until(
    (t) => /name unregistered/.test(t),
    90_000,
    "the revoked header",
  ).then(() => true, () => false);

  // The writer scan is a separate pass over the resolver's history; snapshotting
  // the moment the table paints raced it and reported a missing attribution that
  // arrived a second later.
  const creationMs = await until((t) => /at creation/.test(t), 60_000, "creation attribution").then(
    (ms) => ms,
    () => -1,
  );

  const rows = await page.evaluate(
    () => document.querySelectorAll("table tbody tr").length,
  );
  return {
    note:
      `${revoked ? "REVOKED header" : "NOT revoked"}; ${rows} record rows; ` +
      `creation attribution ${creationMs >= 0 ? `after ${(creationMs / 1000).toFixed(1)}s` : "MISSING"}`,
  };
});

// ---- beat 5: settlement on the settled fixture
await beat(5, "settlement", async ({ waits }) => {
  const started = now();
  await go(`/settlement?f=${SETTLED}`);
  await until((t) => /payouts/.test(t), 120_000, "the payouts panel");

  // A heading is not data. Wait for rows, and for a real "paid in" basis in one
  // of them — that is the number the history scan exists to produce.
  const rowsMs = await untilChain(
    () => page.evaluate(() => document.querySelectorAll("table tbody tr").length),
    (n) => n > 5,
    180_000,
    "payout rows",
  );
  waits.push({ ms: now() - started, cause: "settlement first paint (rows on screen)" });

  const basisMs = await untilChain(
    () =>
      page.evaluate(() => {
        const cells = [...document.querySelectorAll("table tbody tr td:nth-child(4)")];
        return cells.filter((c) => /\d/.test(c.textContent ?? "")).length;
      }),
    (n) => n > 0,
    180_000,
    "a recovered mint basis",
  ).catch(() => -1);

  const t = (await textOf()).toLowerCase();
  const saved = /what your agents did/.test(t);
  return {
    note:
      `${(rowsMs / 1000).toFixed(1)}s to rows, ` +
      `${basisMs >= 0 ? `${(basisMs / 1000).toFixed(1)}s to basis` : "basis never arrived"}; ` +
      `agent-result panel ${saved ? "shown" : "hidden (no qualifying fills)"}`,
  };
});

const totalSeconds = ((now() - t0) / 1000).toFixed(1);

await browser.close();

const report = { totalSeconds, beats, consoleErrors: errors.map((e) => e.text) };
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));

console.log(`\ntotal 60' → settlement screen: ${totalSeconds}s`);
console.log(`screenshots + report in ${OUT}`);
