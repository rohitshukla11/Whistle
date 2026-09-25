/**
 * The one-window demo, driven end to end against a fork, with a signing wallet.
 *
 * The wallet is an injected EIP-1193 provider that forwards `eth_sendTransaction`
 * to anvil, which signs as the impersonated demo user — the same trick
 * `rehearse-ui.mjs` uses, so no private key is handled here either.
 *
 * Two beats are done as direct contract calls rather than through the form, and
 * both are said out loud in the log: the pre-match mint (setup) and the sell
 * queued during the pause. Neither changes what is being demonstrated — the
 * claim under test is that a paused match does not move the price, and that is
 * a property of the chain, not of the button that queued the order.
 *
 *   node scripts/sim-rehearse.mjs --out <dir>
 */

import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { createPublicClient, http, encodeFunctionData, parseAbi, parseEventLogs, formatUnits } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { sepolia } from "viem/chains";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg("out", "/tmp/sim-rehearse");
const RPC = arg("rpc", "http://127.0.0.1:8545");
const BASE = arg("url", "http://127.0.0.1:3100");
const TOKEN = process.env.SIM_ADMIN_TOKEN;
const USER = process.env.TOKYO2_USER_ADDRESS;
const D = JSON.parse(process.env.DEPLOYMENT_JSON);
mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const log = [];
const say = (s) => { const line = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`; console.log(line); log.push(line); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const abi = parseAbi([
  "function fixtures(uint256) view returns (address,uint8,uint16,uint16,uint32,uint64,uint64)",
  "function cardOf(uint256 fixtureId, uint16 playerId) view returns (address)",
  "function mintPreMatch(address card, uint256 units, address to) returns (uint256)",
  "function referencePrice(address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function queueOrder(uint256,address,uint8,uint256,uint16,bool) returns (uint256)",
  "function queueLength(uint256) view returns (uint256)",
  "function queueHead(uint256) view returns (uint256)",
  "function settled() view returns (bool)",
  "event OrderFilled(uint256 indexed orderId, address indexed card, uint256 units, uint256 usdc, uint256 referencePrice)",
  "event OrderQueued(uint256 indexed orderId, uint256 indexed fixtureId, address indexed card, address owner, uint8 side, uint256 amount)",
]);
const pc = createPublicClient({ chain: sepolia, transport: http(RPC) });
const rpc = (method, params = []) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
const send = async (to, data, from = USER) => {
  const r = await rpc("eth_sendTransaction", [{ from, to, data, gas: "0x2625a0" }]);
  if (r.error) throw new Error(r.error.message);
  await pc.waitForTransactionReceipt({ hash: r.result });
  return r.result;
};
const chain = async () => {
  const f = await pc.readContract({ address: D.matchOracle, abi, functionName: "fixtures", args: [BigInt(D.fixtureId)] });
  return { state: Number(f[1]), minute: Number(f[2]) };
};

// ---------------------------------------------------------------- browser
const provider = (rpcUrl, user) => `
  window.ethereum = {
    isMetaMask: true, chainId: "0xaa36a7",
    on(){}, removeListener(){},
    async request({ method, params }) {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return ["${user}"];
      if (method === "eth_chainId") return "0xaa36a7";
      if (method === "net_version") return "11155111";
      if (method === "wallet_switchEthereumChain") return null;
      const r = await fetch("${rpcUrl}", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }) }).then((x) => x.json());
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.result;
    },
  };`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1300 });
await page.evaluateOnNewDocument(provider(RPC, USER));
await page.evaluateOnNewDocument((t) => sessionStorage.setItem("whistle:sim:token", JSON.stringify(t)), TOKEN);
page.on("dialog", async (d) => { say(`  dialog: ${d.message().split("\n")[0].slice(0, 70)}`); await d.accept(); });

const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
const connect = async () => page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /^connect$/i.test(x.innerText.trim())); if (b) { b.click(); return true; } return false; });
const panelBtn = (re) => page.evaluate((r) => { const b = [...document.querySelectorAll('[data-testid="sim-panel"] button')].find((x) => new RegExp(r, "i").test(x.innerText)); if (!b) return "missing"; if (b.disabled) return "disabled"; b.click(); return "clicked"; }, re.source);
const status = () => page.evaluate(() => document.querySelector('[data-testid="sim-status"]')?.textContent?.trim() ?? "");
const minute = () => page.evaluate(() => document.querySelector('[data-testid="sim-minute"]')?.textContent?.trim() ?? "");

// ---- beat 1: mint two cards pre-match (direct call — setup, not the claim)
const abidal = await pc.readContract({ address: D.matchOracle, abi, functionName: "cardOf", args: [BigInt(D.fixtureId), 21n] });
const messi = await pc.readContract({ address: D.matchOracle, abi, functionName: "cardOf", args: [BigInt(D.fixtureId), 10n] });
await send(D.usdc, encodeFunctionData({ abi, functionName: "approve", args: [D.settlementPot, 10n ** 30n] }));
await send(D.settlementPot, encodeFunctionData({ abi, functionName: "mintPreMatch", args: [abidal, 20n * 10n ** 18n, USER] }));
await send(D.settlementPot, encodeFunctionData({ abi, functionName: "mintPreMatch", args: [messi, 10n * 10n ** 18n, USER] }));
say(`beat 1  minted 20 Abidal + 10 Messi pre-match (direct call, setup)`);

await page.goto(`${BASE}/fixture`, { waitUntil: "domcontentloaded", timeout: 60000 });
await wait(6000); await connect(); await wait(9000);
say(`beat 1  panel: ${await minute()} | ${await status()}`);
await shot("01-prematch-minted");

// ---- beat 2: create an agent through the UI
const fresh = privateKeyToAccount(generatePrivateKey());
await page.goto(`${BASE}/agents`, { waitUntil: "domcontentloaded", timeout: 60000 });
await wait(5000); await connect(); await wait(8000);
const typed = await page.evaluate((addr) => {
  const input = [...document.querySelectorAll("input")].find((i) => /0x…|0x\.\.\./.test(i.placeholder ?? ""));
  if (!input) return "no field";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, addr);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return "typed";
}, fresh.address);
await wait(1500);
const created = await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /^create agent-/i.test(x.innerText.trim())); if (!b) return "missing"; if (b.disabled) return `disabled: ${b.innerText.trim()}`; b.click(); return "clicked"; });
say(`beat 2  agent key ${typed}, create button ${created}`);
await wait(14000);
say(`beat 2  ${await page.evaluate(() => document.body.innerText.match(/Created [^\n]{0,60}/)?.[0] ?? "(no confirmation text)")}`);
await shot("02-agent-created");

// ---- beat 3: Start
await page.goto(`${BASE}/fixture`, { waitUntil: "domcontentloaded", timeout: 60000 });
await wait(6000); await connect(); await wait(9000);
say(`beat 3  Start: ${await panelBtn(/start simulation/)}`);
await wait(7000);
say(`beat 3  ${await minute()} | ${await status()}  chain=${JSON.stringify(await chain())}`);
await shot("03-started");

// ---- beat 4: Skip to 60'
say(`beat 4  Skip: ${await panelBtn(/skip to 60/)}`);
for (let i = 0; i < 40 && (await chain()).minute < 66; i++) await wait(3000);
say(`beat 4  reached ${JSON.stringify(await chain())}`);
await shot("04-skipped-to-60");

// ---- beat 5: the red card at 66'
for (let i = 0; i < 30 && (await chain()).minute < 66; i++) await wait(3000);
const atRed = await chain();
say(`beat 5  RED at 66' — chain now ${atRed.minute}'`);
await wait(4000);
await shot("05-red-card-66");

// ---- beat 6: Pause
say(`beat 6  Pause: ${await panelBtn(/^pause/)}`);
await wait(2500);
const pausedChain = await chain();
const priceAtQueue = await pc.readContract({ address: D.settlementPot, abi, functionName: "referencePrice", args: [abidal] });
say(`beat 6  paused at ${pausedChain.minute}'  Abidal R = ${formatUnits(priceAtQueue, 6)} USDC`);
await shot("06-paused");

// ---- beat 7: queue a sell on Abidal while paused (direct call — the claim is about price, not the form)
await send(abidal, encodeFunctionData({ abi, functionName: "approve", args: [D.whistleHook, 10n ** 30n] }));
const queueTx = await send(D.whistleHook, encodeFunctionData({ abi, functionName: "queueOrder", args: [BigInt(D.fixtureId), abidal, 1, 5n * 10n ** 18n, 1000, false] }));
const queueReceipt = await pc.getTransactionReceipt({ hash: queueTx });
// OrderFilled carries no owner, so the order is followed by its id.
const queuedEvent = parseEventLogs({ abi, eventName: "OrderQueued", logs: queueReceipt.logs })[0];
const orderId = queuedEvent?.args?.orderId;
say(`beat 7  queued SELL 5 Abidal while paused — order #${orderId}  ${queueTx.slice(0, 12)}…`);
await wait(16000);
const stillPaused = await chain();
const priceWhilePaused = await pc.readContract({ address: D.settlementPot, abi, functionName: "referencePrice", args: [abidal] });
say(`beat 7  16s later: chain ${stillPaused.minute}' (was ${pausedChain.minute}') — ${stillPaused.minute === pausedChain.minute ? "UNCHANGED" : "MOVED"}`);
say(`beat 7  Abidal R = ${formatUnits(priceWhilePaused, 6)} — ${priceWhilePaused === priceAtQueue ? "UNCHANGED" : "MOVED"}`);
await shot("07-order-queued-paused");

// ---- beat 8: Resume, and the paused order fills at the price it was queued at
say(`beat 8  Resume: ${await panelBtn(/^resume/)}`);
const fromBlock = await pc.getBlockNumber();
let fill = null;
for (let i = 0; i < 40 && !fill; i++) {
  await wait(3000);
  const logs = await pc.getLogs({ address: D.whistleHook, event: abi.find((a) => a.name === "OrderFilled"), fromBlock: fromBlock - 80n, toBlock: "latest" });
  fill = logs.find((l) => l.args.orderId === orderId) ?? null;
}
if (fill) {
  const p = fill.args.referencePrice;
  say(`beat 8  FILLED ${formatUnits(fill.args.units, 18)} Abidal at ${formatUnits(p, 6)} USDC  (queued at ${formatUnits(priceAtQueue, 6)}) — ${p === priceAtQueue ? "SAME PRICE" : `DIFFERS by ${formatUnits(p > priceAtQueue ? p - priceAtQueue : priceAtQueue - p, 6)}`}`);
} else {
  say(`beat 8  no fill observed for the paused order`);
}
await shot("08-resumed-filled");

// ---- beat 9: revoke an agent through the UI
await page.goto(`${BASE}/agents`, { waitUntil: "domcontentloaded", timeout: 60000 });
await wait(5000); await connect(); await wait(8000);
const revoked = await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /^revoke$/i.test(x.innerText.trim()) && !x.disabled); if (!b) return "missing"; b.click(); return "clicked"; });
say(`beat 9  Revoke: ${revoked}`);
await wait(16000);
say(`beat 9  ${await page.evaluate(() => document.body.innerText.match(/revoked [^\n]{0,50}/i)?.[0] ?? "(no confirmation)")}`);
await shot("09-revoked");

// ---- beat 10: run to full time
await page.goto(`${BASE}/fixture`, { waitUntil: "domcontentloaded", timeout: 60000 });
await wait(6000); await connect(); await wait(8000);
if (!(await page.evaluate(() => /Pause/.test(document.querySelector('[data-testid="sim-panel"]')?.innerText ?? "")))) {
  say(`beat 10 Resume: ${await panelBtn(/^resume/)}`);
}
let last = null;
for (let i = 0; i < 120; i++) {
  await wait(3000);
  const c = await chain();
  if (c.state === 2) { say(`beat 10 SETTLED at ${c.minute}'`); break; }
  if (c.minute !== last) { last = c.minute; if (c.minute % 10 === 0 || c.minute > 88) say(`beat 10 ${c.minute}' | ${await status()}`); }
}
const final = await chain();
const isSettled = await pc.readContract({ address: D.settlementPot, abi, functionName: "settled" });
say(`beat 10 final: chainState=${final.state} minute=${final.minute}' pot.settled=${isSettled}`);
await shot("10-full-time");

// ---- beat 11: settlement
await page.goto(`${BASE}/settlement`, { waitUntil: "domcontentloaded", timeout: 60000 });
await wait(18000);
say(`beat 11 settlement: ${await page.evaluate(() => (document.body.innerText.match(/FULL TIME|SETTLED|PRE.MATCH|payout/i) ?? ["(none)"])[0])}`);
await shot("11-settlement");

await browser.close();
writeFileSync(`${OUT}/run.log`, log.join("\n") + "\n");
say("done");
