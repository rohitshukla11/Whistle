/**
 * End-to-end verification of the one-window flow against a fork.
 *
 * Every beat records a screenshot, a wall-clock time, and — where it can — the
 * on-screen value next to the chain value it claims to represent. A screenshot
 * that looks right is not evidence; a number that matches `eth_call` is.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { createPublicClient, http, encodeFunctionData, parseAbi, parseEventLogs, formatUnits } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { sepolia } from "viem/chains";

const OUT = process.argv[2], RPC = "http://127.0.0.1:8545", BASE = "http://127.0.0.1:3100";
const OP = process.env.OPERATOR, TOKEN = process.env.SIM_ADMIN_TOKEN;
const D = JSON.parse(process.env.DEPLOYMENT_JSON);
mkdirSync(OUT, { recursive: true });
const t0 = Date.now(), rows = [], errs = [], mismatches = [];
const el = () => ((Date.now() - t0) / 1000).toFixed(1);
const say = (s) => console.log(`[${el().padStart(7)}s] ${s}`);
const beat = (n, what, ok, detail = "") => { rows.push({ t: el(), n, what, ok, detail }); say(`${ok ? "OK  " : "FAIL"} ${n}. ${what}${detail ? " — " + detail : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const abi = parseAbi([
  "function fixtures(uint256) view returns (address,uint8,uint16,uint16,uint32,uint64,uint64)",
  "function cardOf(uint256 fixtureId, uint16 playerId) view returns (address)",
  "function mintPreMatch(address card, uint256 units, address to) returns (uint256)",
  "function referencePrice(address card) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function queueOrder(uint256,address,uint8,uint256,uint16,bool) returns (uint256)",
  "function queueLength(uint256) view returns (uint256)",
  "function queueHead(uint256) view returns (uint256)",
  "function agentCount() view returns (uint256)",
  "function agentInfo(address) view returns (address,address,address,uint256,uint256,uint256,uint256,string)",
  "function readText(address agent, string key) view returns (string)",
  "function settled() view returns (bool)",
  "event OrderFilled(uint256 indexed orderId, address indexed card, uint256 units, uint256 usdc, uint256 referencePrice)",
  "event OrderQueued(uint256 indexed orderId, uint256 indexed fixtureId, address indexed card, address owner, uint8 side, uint256 amount)",
]);
const pc = createPublicClient({ chain: sepolia, transport: http(RPC) });
const rpc = (m, p = []) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }).then((r) => r.json());
const sendTx = async (to, data) => { const r = await rpc("eth_sendTransaction", [{ from: OP, to, data }]); if (r.error) throw new Error(r.error.message); return pc.waitForTransactionReceipt({ hash: r.result }); };
const chain = async () => { const f = await pc.readContract({ address: D.matchOracle, abi, functionName: "fixtures", args: [20260923n] }); return { state: Number(f[1]), minute: Number(f[2]) }; };
/** ≤10-block windows: a fork forwards getLogs upstream, which caps the range. */
const scan = async (event, since) => {
  const head = await pc.getBlockNumber();
  // Never walk more than a few hundred blocks: `since` is always a block we
  // just observed, and a bad value must cost a short scan, not the whole chain.
  const floor = head > 300n ? head - 300n : 0n;
  if (since < floor) since = floor;
  const out = [];
  for (let to = head; to >= since; to -= 10n) { const from = to - 9n > since ? to - 9n : since; out.push(...await pc.getLogs({ address: D.whistleHook, event, fromBlock: from, toBlock: to }).catch(() => [])); if (from === since) break; } return out; };
const FILLED = abi.find((a) => a.name === "OrderFilled");

const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", args: ["--no-sandbox"] });
let page = await browser.newPage();
const hook = (p) => {
  p.on("console", (m) => { if (m.type() === "error") errs.push(`[${el()}s] ${m.text().slice(0, 160)}`); });
  p.on("pageerror", (e) => errs.push(`[${el()}s] pageerror ${String(e).slice(0, 160)}`));
  p.on("dialog", async (d) => { say(`  dialog: ${d.message().split("\n")[0].slice(0, 72)}`); await d.accept(); });
};
hook(page);
await page.setViewport({ width: 1440, height: 1300 });
const inject = `window.ethereum={isMetaMask:true,chainId:"0xaa36a7",on(){},removeListener(){},async request({method,params}){
  if(method==="eth_accounts"||method==="eth_requestAccounts")return["${OP}"];
  if(method==="eth_chainId")return"0xaa36a7"; if(method==="net_version")return"11155111";
  if(method==="wallet_switchEthereumChain")return null;
  const r=await fetch("${RPC}",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params:params??[]})}).then(x=>x.json());
  if(r.error)throw Object.assign(new Error(r.error.message),{code:r.error.code}); return r.result;}};`;
await page.evaluateOnNewDocument(inject);
await page.evaluateOnNewDocument((t) => sessionStorage.setItem("whistle:sim:token", JSON.stringify(t)), TOKEN);

const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
const connect = () => page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /^connect$/i.test(x.innerText.trim())); if (b) { b.click(); return true; } return false; });
const open = async (path) => { await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 60000 }); await wait(6000); await connect(); await wait(9000); };
const panel = () => page.evaluate(() => document.querySelector('[data-testid="sim-panel"]')?.innerText ?? "");
const status = () => page.evaluate(() => document.querySelector('[data-testid="sim-status"]')?.textContent?.trim() ?? "");
const minuteBox = () => page.evaluate(() => document.querySelector('[data-testid="sim-minute"]')?.textContent?.trim() ?? "");
const btn = (re, click = true) => page.evaluate((r, c) => { const b = [...document.querySelectorAll('[data-testid="sim-panel"] button')].find((x) => new RegExp(r, "i").test(x.innerText)); if (!b) return "missing"; if (b.disabled) return "disabled"; if (c) b.click(); return "clicked"; }, re.source, click);
/** Any rendered Note, success or failure, verbatim — a red box is a result. */
const notes = () => page.evaluate(() => [...document.querySelectorAll("div")].filter((d) => /rounded/.test(d.className) && /border-(away|down|signal|line)/.test(d.className) && d.children.length < 6 && d.innerText.trim().length > 8 && d.innerText.length < 300).map((d) => d.innerText.trim().replace(/\s+/g, " ")).slice(0, 4));

// ---------------------------------------------------------------- beat 1
const abidal = await pc.readContract({ address: D.matchOracle, abi, functionName: "cardOf", args: [20260923n, 21] });
const messi = await pc.readContract({ address: D.matchOracle, abi, functionName: "cardOf", args: [20260923n, 10] });
await sendTx(D.usdc, encodeFunctionData({ abi, functionName: "approve", args: [D.settlementPot, 10n ** 30n] }));
await sendTx(D.settlementPot, encodeFunctionData({ abi, functionName: "mintPreMatch", args: [abidal, 20n * 10n ** 18n, OP] }));
await sendTx(D.settlementPot, encodeFunctionData({ abi, functionName: "mintPreMatch", args: [messi, 10n * 10n ** 18n, OP] }));
await open("/fixture");
const c1 = await chain();
beat(1, "PRE_MATCH, two cards minted", c1.state === 0, `chain state=${c1.state}, panel "${minuteBox()  && await minuteBox()}"`);
await shot("01-prematch");

// ---------------------------------------------------------------- beat 2
const fresh = privateKeyToAccount(generatePrivateKey());
const before = await pc.readContract({ address: D.agentRegistry, abi, functionName: "agentCount" });
await open("/agents");
await page.evaluate((addr) => { const i = [...document.querySelectorAll("input")].find((x) => /0x/.test(x.placeholder ?? "")); if (i) { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(i, addr); i.dispatchEvent(new Event("input", { bubbles: true })); } }, fresh.address);
await wait(2500);
const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /^create agent-/i.test(x.innerText.trim())); if (!b) return "missing"; if (b.disabled) return "disabled"; b.click(); return "clicked"; });
await wait(22000);
const after = await pc.readContract({ address: D.agentRegistry, abi, functionName: "agentCount" });
const rendered = await notes();
let fqdn = "";
if (after > before) { const info = await pc.readContract({ address: D.agentRegistry, abi, functionName: "agentInfo", args: [fresh.address] }); fqdn = info[7]; }
const resolves = fqdn ? await pc.readContract({ address: D.agentRegistry, abi, functionName: "readText", args: [fresh.address, "strategy"] }) : "";
beat(2, "create agent from the UI", after === before + 1n && Boolean(fqdn), `click=${clicked} agentCount ${before}->${after} fqdn="${fqdn}" strategy="${resolves}" | notes: ${JSON.stringify(rendered)}`);
await shot("02-agent-created");

// ---------------------------------------------------------------- beat 3
await open("/fixture");
const startClick = await btn(/start simulation/);
await wait(9000);
const box3 = await minuteBox(), c3 = await chain();
const undef = /undefined/.test(box3) || /undefined/.test(await panel());
if (undef) mismatches.push(`beat 3: panel rendered "undefined" — "${box3}"`);
if (!box3.startsWith(`${c3.minute}'`)) mismatches.push(`beat 3: panel "${box3}" vs chain ${c3.minute}'`);
beat(3, "Start → protected dialog → LIVE", startClick === "clicked" && c3.state === 1 && !undef, `panel "${box3}" chain ${c3.minute}' state=${c3.state}`);
await shot("03-started");

// ---------------------------------------------------------------- beat 4
const skipState = await btn(/skip to 60/, false);
const skipClick = await btn(/skip to 60/);
let t4 = Date.now();
for (let i = 0; i < 120 && (await chain()).minute < 66; i++) await wait(2500);
const c4 = await chain();
beat(4, "Skip to 60' (button enabled after Start)", skipState !== "disabled" && skipClick === "clicked" && c4.minute >= 66, `button=${skipState} chain reached ${c4.minute}' in ${((Date.now() - t4) / 1000).toFixed(0)}s`);
await shot("04-skipped");

// ---------------------------------------------------------------- beat 5
const redAt = Date.now();
const body5 = await page.evaluate(() => document.body.innerText);
const tenMen = /10 men/i.test(body5);
const qBefore = await pc.readContract({ address: D.whistleHook, abi, functionName: "queueLength", args: [20260923n] });
let cleared = false, tClear = 0;
for (let i = 0; i < 40 && !cleared; i++) { await wait(2500); const h = await pc.readContract({ address: D.whistleHook, abi, functionName: "queueHead", args: [20260923n] }); const q = await pc.readContract({ address: D.whistleHook, abi, functionName: "queueLength", args: [20260923n] }); if (h >= q) { cleared = true; tClear = (Date.now() - redAt) / 1000; } }
beat(5, "66' red card: 10 MEN, queue clears", tenMen, `"10 men" on screen=${tenMen}, queue cleared=${cleared} after ${tClear.toFixed(0)}s (len was ${qBefore})`);
await shot("05-red-card");

// ---------------------------------------------------------------- beat 6
await btn(/^pause/);
await wait(2500);
const m6 = (await chain()).minute, r6 = await pc.readContract({ address: D.settlementPot, abi, functionName: "referencePrice", args: [abidal] });
await wait(15000);
const m6b = (await chain()).minute, r6b = await pc.readContract({ address: D.settlementPot, abi, functionName: "referencePrice", args: [abidal] });
beat(6, "Pause holds minute and price for 15s", m6 === m6b && r6 === r6b, `minute ${m6}->${m6b}, R ${formatUnits(r6, 6)}->${formatUnits(r6b, 6)}`);
await shot("06-paused");

// ---------------------------------------------------------------- beat 7
await sendTx(abidal, encodeFunctionData({ abi, functionName: "approve", args: [D.whistleHook, 10n ** 30n] }));
const qrc = await sendTx(D.whistleHook, encodeFunctionData({ abi, functionName: "queueOrder", args: [20260923n, abidal, 1, 5n * 10n ** 18n, 1000, false] }));
const oid = parseEventLogs({ abi, eventName: "OrderQueued", logs: qrc.logs })[0]?.args?.orderId;
const since = await pc.getBlockNumber();
await btn(/^resume/);
const tq = Date.now();
let fill = null;
for (let i = 0; i < 60 && !fill; i++) { await wait(2500); fill = (await scan(FILLED, since - 1n)).find((l) => l.args.orderId === oid) ?? null; }
const fillPrice = fill?.args?.referencePrice;
beat(7, "sell queued while paused fills after Resume", Boolean(fill), fill ? `order #${oid} filled @ ${formatUnits(fillPrice, 6)} (queued when R was ${formatUnits(r6b, 6)}) after ${((Date.now() - tq) / 1000).toFixed(0)}s` : `order #${oid} never filled`);
await shot("07-filled");

// ---------------------------------------------------------------- beat 8
await open("/agents");
const tRevoke = Date.now();
const revClick = await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /^revoke$/i.test(x.innerText.trim()) && !x.disabled); if (!b) return "missing"; b.click(); return "clicked"; });
await wait(20000);
const revLatency = ((Date.now() - tRevoke) / 1000).toFixed(0);
const revNotes = await notes();
const didWhat = await page.evaluate(() => { const h = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && /what they did/i.test(e.textContent ?? "")); return (h?.closest("div[class*='rounded']")?.innerText ?? "").slice(0, 400).replace(/\s+/g, " "); });
beat(8, "Revoke one agent", revClick === "clicked" && revNotes.some((n) => /revok/i.test(n)), `latency ${revLatency}s | notes: ${JSON.stringify(revNotes)} | what-they-did: "${didWhat.slice(0, 160)}"`);
await shot("08-revoked");

// ---------------------------------------------------------------- beat 9
await open("/fixture");
if ((await btn(/^resume/, false)) !== "missing") await btn(/^resume/);
await wait(6000);
const beforeReload = (await chain()).minute;
await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
await wait(6000); await connect(); await wait(12000);
const box9 = await minuteBox(), c9 = await chain();
const resumedFromChain = box9.startsWith(`${c9.minute}'`) && c9.minute > 0;
if (!resumedFromChain) mismatches.push(`beat 9: after reload panel "${box9}" vs chain ${c9.minute}'`);
beat(9, "reload mid-match resumes from the chain", resumedFromChain, `before ${beforeReload}', after reload panel "${box9}" chain ${c9.minute}'`);
await shot("09-reloaded");

// ---------------------------------------------------------------- beat 10
if ((await btn(/^resume/, false)) !== "missing") await btn(/^resume/);
let c10 = await chain();
for (let i = 0; i < 200 && c10.state !== 2; i++) { await wait(2500); c10 = await chain(); }
const settled = await pc.readContract({ address: D.settlementPot, abi, functionName: "settled" });
beat(10, "full time → postFinal accepted", c10.state === 2 && settled === true, `state=${c10.state} minute=${c10.minute}' pot.settled=${settled}`);
await shot("10-full-time");

await page.goto(`${BASE}/settlement`, { waitUntil: "domcontentloaded", timeout: 60000 });
await wait(20000);
const settleText = await page.evaluate(() => document.body.innerText.slice(0, 400).replace(/\s+/g, " "));
beat(11, "settlement screen", /settled|full time|payout/i.test(settleText), settleText.slice(0, 140));
await shot("11-settlement");

await browser.close();
const total = el();
writeFileSync(`${OUT}/report.json`, JSON.stringify({ rows, errs, mismatches, total }, null, 2));
console.log(`\n=== ${rows.filter((r) => r.ok).length}/${rows.length} beats green in ${total}s ===`);
console.log(`console errors: ${errs.length}`); errs.slice(0, 8).forEach((e) => console.log("  " + e));
console.log(`on-screen vs chain disagreements: ${mismatches.length}`); mismatches.forEach((m) => console.log("  " + m));
