/**
 * Record the Demo 1 video run from :3100, headless, 1440×900.
 *
 *   node scripts/record-demo1.mjs <outDir> <fixtureId>
 *
 * Raw capture: every Chrome screencast frame as a JPEG under <outDir>/frames,
 * with frames.json (file, wall-clock ms, beat). No ffmpeg on this machine, so
 * frames are the capture; encode them later at the recorded timestamps.
 *
 * Beats: /fixture (pitch) through 66' and the tick after it → /agents: Pause
 * the Contrarian, Revoke the Protect agent → the revoked agent's /profile →
 * /settlement until it reads SETTLED, then check the scoreline.
 *
 * The injected wallet is 0x6834…: it signs ONLY `setText` (pause) and
 * `revokeAgent`, on real Sepolia, and refuses everything else.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const OUT = process.argv[2], ID = process.argv[3] ?? "2026092701", BASE = "https://localhost:3100";
mkdirSync(`${OUT}/frames`, { recursive: true });
const env = Object.fromEntries(readFileSync("../.env", "utf8").split("\n").map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim().replace(/^["']|["']$/g, "")]));
const RPC = env.SEPOLIA_RPC_URL_INFURA;
const raw = env.DEPLOYER_PRIVATE_KEY; const owner = privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`);
const pc = createPublicClient({ chain: sepolia, transport: http(RPC) });
const w = createWalletClient({ account: owner, chain: sepolia, transport: http(RPC) });
const D = JSON.parse(readFileSync(`../deployments/fixture-${ID}.json`, "utf8"));
const oracleAbi = parseAbi(["function fixtures(uint256) view returns (address,uint8,uint16,uint16,uint32,uint32,uint64,bool,bool,bool)"]);
const hookAbi = parseAbi(["function queueHead(uint256) view returns (uint256)", "function queueLength(uint256) view returns (uint256)"]);
const ALLOWED = ["0xc7279f88", "0x7da6ac0d"]; // setText, revokeAgent

const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let beat = "boot";
const frames = [];
const chain = async () => { const f = await pc.readContract({ address: D.matchOracle, abi: oracleAbi, functionName: "fixtures", args: [BigInt(ID)] }); return { state: Number(f[1]), clock: Number(f[2]) }; };
const until = async (fn, ms, every = 1500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await wait(every); } return null; };

const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", args: ["--no-sandbox", "--window-size=1440,900"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
page.on("dialog", async (d) => { log(`dialog: ${d.message().slice(0, 60)}`); await d.accept(); });
await page.exposeFunction("__send", async (tx) => {
  if (!ALLOWED.some((s) => String(tx.data ?? "").startsWith(s))) throw new Error(`recorder refuses ${String(tx.data).slice(0, 10)}`);
  const hash = await w.sendTransaction({ to: tx.to, data: tx.data, value: 0n });
  log(`  signed ${String(tx.data).slice(0, 10)} ${hash}`);
  return hash;
});
await page.evaluateOnNewDocument(`window.ethereum={isMetaMask:true,chainId:"0xaa36a7",on(){},removeListener(){},async request({method,params}){
  if(method==="eth_accounts"||method==="eth_requestAccounts")return["${owner.address}"];
  if(method==="eth_chainId")return"0xaa36a7"; if(method==="net_version")return"11155111";
  if(method==="wallet_switchEthereumChain"||method==="wallet_revokePermissions")return null;
  if(method==="wallet_requestPermissions"||method==="wallet_getPermissions")return[{parentCapability:"eth_accounts"}];
  if(method==="eth_sendTransaction")return window.__send(params[0]);
  if(/sign|send|wallet_/i.test(method))throw Object.assign(new Error(method+" refused"),{code:4001});
  const r=await fetch("${RPC}",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params:params??[]})}).then(x=>x.json());
  if(r.error)throw Object.assign(new Error(r.error.message),{code:r.error.code}); return r.result;}};`);

const cdp = await page.createCDPSession();
cdp.on("Page.screencastFrame", async ({ data, sessionId }) => {
  const file = `frames/${String(frames.length).padStart(6, "0")}.jpg`;
  writeFileSync(`${OUT}/${file}`, Buffer.from(data, "base64"));
  frames.push({ file, ms: Date.now() - t0, beat });
  await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
const connect = () => page.evaluate(() => { [...document.querySelectorAll("button")].find((x) => /^connect$/i.test(x.innerText.trim()))?.click(); });
const go = async (path, name) => { beat = name; log(`beat: ${name} → ${path}`); await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" }); await wait(2500); await connect(); };

await page.goto(`${BASE}/fixture?f=${ID}`, { waitUntil: "domcontentloaded" });
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
await go(`/fixture?f=${ID}`, "fixture-pitch");
writeFileSync(`${OUT}/READY`, String(Date.now()));
log("ready — waiting for kickoff");

await until(async () => (await chain()).state === 1, 600_000, 2000);
log("kicked off");
await until(async () => (await chain()).clock >= 66, 600_000, 1500);
log("66' on chain");
const head0 = await pc.readContract({ address: D.whistleHook, abi: hookAbi, functionName: "queueHead", args: [BigInt(ID)] });
await until(async () => (await pc.readContract({ address: D.whistleHook, abi: hookAbi, functionName: "queueHead", args: [BigInt(ID)] })) > head0, 90_000, 2000);
log("tick after 66' landed");
await wait(4000);

await go(`/agents?f=${ID}`, "agents");
await wait(6000);
const clickIn = (fqdn, label) => page.evaluate((fqdn, label) => {
  const card = [...document.querySelectorAll("a")].find((a) => a.innerText.trim() === fqdn)?.closest("div.p-4, article, section, li") ?? null;
  let el = card; while (el && ![...el.querySelectorAll("button")].some((b) => b.innerText.trim().toLowerCase() === label)) el = el.parentElement;
  const b = el && [...el.querySelectorAll("button")].find((b) => b.innerText.trim().toLowerCase() === label);
  if (!b || b.disabled) return false; b.scrollIntoView({ block: "center" }); b.click(); return true;
}, fqdn, label);
const pageText = () => page.evaluate(() => document.querySelector("main")?.innerText ?? "");
beat = "pause";
log(`pause agent-13: ${await clickIn("agent-13.tokyo.whistle.eth", "pause")}`);
await until(async () => /paused agent-13|agent-13[\s\S]{0,200}paused/i.test(await pageText()), 120_000, 2000);
await wait(4000);
beat = "revoke";
log(`revoke agent-11: ${await clickIn("agent-11.tokyo.whistle.eth", "revoke")}`);
await until(async () => /revoked agent-11/i.test(await pageText()), 180_000, 2000);
await wait(6000);

await go(`/profile/${encodeURIComponent("agent-11.tokyo.whistle.eth")}?f=${ID}`, "profile-revoked");
await wait(10000);

await go(`/settlement?f=${ID}`, "settlement");
await until(async () => (await chain()).state === 2, 600_000, 3000);
log("settled on chain");
await page.reload({ waitUntil: "domcontentloaded" }); await wait(3000); await connect();
const score = await until(async () => { const t = await pageText(); return /FULL TIME · SETTLED/.test(t) ? t : null; }, 120_000, 2000);
await wait(8000);
await page.screenshot({ path: `${OUT}/settlement.png` });
await cdp.send("Page.stopScreencast");
const scoreline = /CHE\s*\n?\s*Chelsea\s*\n?\s*(\d+)\s*[–-]\s*(\d+)/.exec(score ?? "");
writeFileSync(`${OUT}/frames.json`, JSON.stringify({ viewport: "1440x900", startedAt: new Date(t0).toISOString(), frames }, null, 1));
log(`frames: ${frames.length}; scoreline on settlement: ${scoreline ? `${scoreline[1]}–${scoreline[2]}` : "not found"}`);
writeFileSync(`${OUT}/RESULT.txt`, `frames ${frames.length}\nscoreline ${scoreline ? `${scoreline[1]}-${scoreline[2]}` : "?"}\n`);
await browser.close();
