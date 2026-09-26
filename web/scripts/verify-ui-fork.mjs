/**
 * Fork check for the fixture list and the one-screen pre-match flow.
 *
 *   BASE=http://127.0.0.1:3101 RPC=http://127.0.0.1:8545 node scripts/verify-ui-fork.mjs <outDir> <fixtureId>
 *
 * Drives headless Chrome with an injected wallet that is the owner (0x6834…):
 * reads go to the fork; `personal_sign` and `eth_sendTransaction` are signed
 * here in Node with DEPLOYER_PRIVATE_KEY and sent to the fork only. Refuses any
 * non-local RPC.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const OUT = process.argv[2], ID = process.argv[3] ?? "2026092702";
const BASE = process.env.BASE ?? "http://127.0.0.1:3101", RPC = process.env.RPC ?? "http://127.0.0.1:8545";
if (!/127\.0\.0\.1|localhost/.test(RPC) || !/127\.0\.0\.1|localhost/.test(BASE)) throw new Error("fork only");
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(readFileSync("../.env", "utf8").split("\n").map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim().replace(/^["']|["']$/g, "")]));
const raw = env.DEPLOYER_PRIVATE_KEY; const owner = privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`);
const w = createWalletClient({ account: owner, chain: sepolia, transport: http(RPC) });

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const log = (s) => console.log(`[${el()}s] ${s}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const results = [];
const check = (ok, what) => { results.push({ ok, what }); log(`${ok ? "PASS" : "FAIL"}  ${what}`); };

const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
page.on("dialog", async (d) => { log(`  dialog: ${d.message().split("\n")[0].slice(0, 80)}`); await d.accept(); });
await page.exposeFunction("__wallet", async (method, params) => {
  if (method === "personal_sign") return owner.signMessage({ message: { raw: params[0] } });
  if (method === "eth_sendTransaction") {
    const tx = params[0];
    return w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n, ...(tx.gas ? { gas: BigInt(tx.gas) } : {}) });
  }
  throw new Error(`unsupported ${method}`);
});
await page.evaluateOnNewDocument(`window.ethereum={isMetaMask:true,chainId:"0xaa36a7",on(){},removeListener(){},async request({method,params}){
  if(method==="eth_accounts"||method==="eth_requestAccounts")return["${owner.address}"];
  if(method==="eth_chainId")return"0xaa36a7"; if(method==="net_version")return"11155111";
  if(method==="wallet_switchEthereumChain"||method==="wallet_revokePermissions")return null;
  if(method==="wallet_requestPermissions"||method==="wallet_getPermissions")return[{parentCapability:"eth_accounts"}];
  if(method==="personal_sign"||method==="eth_sendTransaction")return window.__wallet(method,params);
  if(/sign|send|wallet_/i.test(method))throw Object.assign(new Error(method+" refused"),{code:4001});
  const r=await fetch("${RPC}",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params:params??[]})}).then(x=>x.json());
  if(r.error)throw Object.assign(new Error(r.error.message),{code:r.error.code}); return r.result;}};`);

const connect = () => page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /^connect$/i.test(x.innerText.trim())); b?.click(); return Boolean(b); });
const text = () => page.evaluate(() => document.querySelector("main")?.innerText ?? "");
const clickText = (re, scope = "") => page.evaluate((src, scope) => {
  const rx = new RegExp(src, "i");
  const root = scope ? document.querySelector(scope) : document;
  const b = [...(root ?? document).querySelectorAll("button, a")].find((x) => rx.test(x.innerText.trim()) && !x.disabled);
  if (b) { b.scrollIntoView({ block: "center" }); b.click(); return b.innerText.trim(); }
  return null;
}, re.source, scope);
const until = async (fn, ms = 60_000, every = 1_000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(every); } return null; };
const shot = async (name, width) => {
  await page.setViewport({ width, height: width < 600 ? 844 : 900 });
  await wait(1_500);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  log(`  screenshot ${name}.png`);
};

// ---------------------------------------------------------------- /fixtures
await page.setViewport({ width: 1440, height: 900 });
await page.goto(`${BASE}/fixtures`, { waitUntil: "domcontentloaded" });
await wait(3_000); await connect(); await wait(2_000);
const rows = await until(async () => {
  const r = await page.evaluate(() => [...document.querySelectorAll('section[aria-label="Fixtures"] li')].map((li) => li.innerText.replace(/\s+/g, " ").trim()));
  return r.length && r.every((t) => !t.includes("Reading the chain")) ? r : null;
}, 60_000, 2_000);
for (const r of rows ?? []) log(`  row: ${r.slice(0, 150)}`);
check(Boolean(rows?.length), `/fixtures lists ${rows?.length ?? 0} fixtures`);
check((rows ?? []).some((r) => /SETTLED.*Today/.test(r)), "Today reads SETTLED");
check((rows ?? []).some((r) => /SETTLED.*Demo 1/.test(r)), "Demo 1 reads SETTLED (played to full time)");
check((rows ?? []).filter((r) => /PRE-MATCH/.test(r)).length >= 2, "Demo 2–3 read PRE-MATCH");
await shot("fixtures-1440", 1440);
await shot("fixtures-390", 390);

// ------------------------------------------------------------ pre-match
await page.setViewport({ width: 1440, height: 900 });
await page.goto(`${BASE}/fixtures/${ID}`, { waitUntil: "domcontentloaded" });
await wait(3_000); await connect();
const tOpen = Date.now();
check(Boolean(await until(async () => /MY CARDS/.test(await text()), 240_000)), "pre-match screen renders (MY CARDS)");
// The market table is ready when its rows are: wait for them before minting.
await until(async () => page.evaluate(() => document.querySelectorAll('section[aria-label="Market"] ul li > button').length >= 20), 240_000, 2_000);
log(`  pre-match ready in ${((Date.now() - tOpen) / 1000).toFixed(1)}s (fork: every cold storage slot is fetched upstream)`);
await shot("prematch-1440-before", 1440);

// mint two players through the order bar
const minted = [];
for (const k of [0, 1]) {
  const name = await page.evaluate((k) => {
    // Each row is one button; its MINT is a label inside it.
    const rows = [...document.querySelectorAll('section[aria-label="Market"] ul li > button')].filter((b) => /MINT/.test(b.innerText));
    const b = rows[k]; if (!b) return null;
    b.scrollIntoView({ block: "center" }); b.click();
    return b.innerText.split("\n")[0] ?? "?";
  }, k);
  await wait(1_000);
  await page.evaluate(() => {
    const input = document.querySelector('section[aria-label="Market"] input[inputmode="decimal"]');
    if (input) { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(input, "5"); input.dispatchEvent(new Event("input", { bubbles: true })); }
  });
  await wait(500);
  const clicked = await until(() => clickText(/^confirm$/, 'section[aria-label="Market"]'), 20_000, 1_000);
  if (!clicked) log(`  order bar: ${(await page.evaluate(() => document.querySelector('[aria-label^="Order:"]')?.innerText ?? "(none)")).replace(/\s+/g, " ").slice(0, 200)}`);
  log(`  mint ${k + 1}: ${name} (clicked ${clicked})`);
  const done = await until(async () => {
    const t = await page.evaluate(() => document.querySelector('section[aria-label="My cards"]')?.innerText ?? "");
    const n = Number(/MY CARDS · (\d+)/.exec(t)?.[1] ?? 0);
    return n >= k + 1 ? n : null;
  }, 90_000, 2_000);
  minted.push(name);
  check(Boolean(done), `MY CARDS shows ${k + 1} after minting ${name}`);
}

// create an agent inline
await page.evaluate(() => {
  const labels = [...document.querySelectorAll('input[type="radio"]')].map((r) => r.closest("label"));
  labels.find((l) => /momentum/i.test(l?.innerText ?? ""))?.click();
});
const agentsBefore = Number(/MY AGENTS ON THIS MATCH · (\d+)/.exec(await text())?.[1] ?? 0);
const created = await clickText(/^create agent-/);
log(`  clicked ${created}`);
const agentNote = await until(async () => {
  const t = await text();
  return /Created .*managed key/i.test(t) ? /Created (\S+)/.exec(t)?.[1] : null;
}, 150_000, 2_000);
check(Boolean(agentNote) && !String(agentNote).startsWith("ERR"), `agent created inline: ${agentNote}`);
const agentsAfter = await until(async () => {
  const n = Number(/MY AGENTS ON THIS MATCH · (\d+)/.exec(await text())?.[1] ?? 0);
  return n > agentsBefore ? n : null;
}, 30_000);
check(Boolean(agentsAfter), `new agent appears in MY AGENTS ON THIS MATCH (${agentsBefore} → ${agentsAfter})`);
await shot("prematch-1440", 1440);
await shot("prematch-390", 390);
await page.setViewport({ width: 1440, height: 900 });

// select a player so we can check it survives the swap
const keep = await page.evaluate(() => {
  const b = [...document.querySelectorAll('section[aria-label="Market"] ul li > button')].filter((x) => /MINT/.test(x.innerText))[2];
  const name = b?.innerText.split("\n")[0]; b?.click(); return name;
});
log(`  selected before Start: ${keep}`);

// Activate if needed, then Start
if (await clickText(/^activate this fixture$/)) {
  log("  activating…");
}
// START MATCH enables once the market is this fixture's hook (a read every 8 s).
const started = await until(() => clickText(/^start match$/), 180_000, 2_000);
log(`  clicked ${started}`);
const tStart = Date.now();
const swapped = await until(async () => page.evaluate(() => Boolean(document.querySelector('[data-testid="sim-panel"]'))), 120_000, 250);
if (swapped) await page.screenshot({ path: `${OUT}/swap-prematch-to-live.png` });
check(Boolean(swapped), `same URL swapped to the live screen with the sim panel after ${((Date.now() - tStart) / 1000).toFixed(1)}s`);
check(page.url().endsWith(`/fixtures/${ID}`), `URL unchanged: ${page.url()}`);
const barText = await page.evaluate(() => document.body.innerText);
check(Boolean(keep) && barText.includes(keep.split(" ").slice(-1)[0]), `order bar kept the selection (${keep})`);
const signed = await page.evaluate(() => document.querySelector('[data-testid="sim-auth"]')?.innerText ?? "");
check(/Signed in as operator/i.test(signed), `operator session survived: "${signed.replace(/\s+/g, " ")}"`);

// run to full time
const settled = await until(async () => /Settlement|FULL TIME · SETTLED|Redeem/.test(await text()) && !(await page.evaluate(() => document.querySelector('[data-testid="sim-panel"]'))), 600_000, 3_000);
if (settled) await page.screenshot({ path: `${OUT}/settled.png`, fullPage: true });
check(Boolean(settled), `after full time the same URL shows the settlement screen (${((Date.now() - tStart) / 1000).toFixed(0)}s after Start)`);

writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, errors, minted, agent: agentNote }, null, 2));
log(`${results.filter((r) => !r.ok).length} failed of ${results.length}; page errors: ${errors.length}`);
for (const e of errors.slice(0, 8)) log(`  error: ${e}`);
await browser.close();
