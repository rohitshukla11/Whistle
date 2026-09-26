/**
 * Shared harness for the World ID fork checks: headless Chrome with an injected
 * wallet that is the owner (0x6834…), signing in Node and sending to the fork
 * only. `window.open` is captured so the IdP page opens in a tab we control.
 */
import { readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

export const BASE = process.env.BASE ?? "https://localhost:3100";
export const RPC = process.env.RPC ?? "http://127.0.0.1:8545";
if (!/127\.0\.0\.1|localhost/.test(RPC) || !/127\.0\.0\.1|localhost/.test(BASE)) throw new Error("fork only");

const env = Object.fromEntries(readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n").map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim().replace(/^["']|["']$/g, "")]));
const raw = env.DEPLOYER_PRIVATE_KEY;
export const owner = privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`);
const w = createWalletClient({ account: owner, chain: sepolia, transport: http(RPC) });

const t0 = Date.now();
export const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const until = async (fn, ms = 60_000, every = 1_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // A page mid-navigation throws "detached Frame"; the next try sees the new frame.
    const v = await Promise.resolve().then(fn).catch((e) => { if (!/detached|context was destroyed/i.test(String(e))) throw e; return null; });
    if (v) return v;
    await wait(every);
  }
  return null;
};

export async function launch(userDataDir) {
  return puppeteer.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: "new", acceptInsecureCerts: true, protocolTimeout: 120_000, args: ["--no-sandbox", "--ignore-certificate-errors",
      // Many tabs poll at once (the app's and the held IdP pages): none may be throttled.
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
    ...(userDataDir ? { userDataDir } : {}),
  });
}

export async function appPage(browser, errors = []) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("dialog", async (d) => d.accept());
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) log(`  nav ${f.url().replace(/^https:\/\/localhost:3100/, "").slice(0, 90)}`); });
  await page.exposeFunction("__wallet", async (method, params) => {
    if (method === "personal_sign") return owner.signMessage({ message: { raw: params[0] } });
    if (method === "eth_sendTransaction") {
      const tx = params[0];
      return w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n, ...(tx.gas ? { gas: BigInt(tx.gas) } : {}) });
    }
    throw new Error(`unsupported ${method}`);
  });
  await page.evaluateOnNewDocument(`window.open=(u)=>{(window.__opened=window.__opened||[]).push(String(u));return null};
window.ethereum={isMetaMask:true,chainId:"0xaa36a7",on(){},removeListener(){},async request({method,params}){
  if(method==="eth_accounts"||method==="eth_requestAccounts")return["${owner.address}"];
  if(method==="eth_chainId")return"0xaa36a7"; if(method==="net_version")return"11155111";
  if(method==="wallet_switchEthereumChain"||method==="wallet_revokePermissions")return null;
  if(method==="wallet_requestPermissions"||method==="wallet_getPermissions")return[{parentCapability:"eth_accounts"}];
  if(method==="personal_sign"||method==="eth_sendTransaction")return window.__wallet(method,params);
  if(/sign|send|wallet_/i.test(method))throw Object.assign(new Error(method+" refused"),{code:4001});
  const r=await fetch("${RPC}",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params:params??[]})}).then(x=>x.json());
  if(r.error)throw Object.assign(new Error(r.error.message),{code:r.error.code}); return r.result;}};`);
  return page;
}

export const connect = (page) => page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /^connect$/i.test(x.innerText.trim())); b?.click(); return Boolean(b); });
export const clickText = (page, re, scope = "") => page.evaluate((src, scope) => {
  const rx = new RegExp(src, "i");
  const root = scope ? document.querySelector(scope) : document;
  const b = [...(root ?? document).querySelectorAll("button, a")].find((x) => rx.test(x.innerText.trim()) && !x.disabled);
  if (b) { b.scrollIntoView({ block: "center" }); b.click(); return b.innerText.trim(); }
  return null;
}, re.source, scope);
export const opened = (page) => page.evaluate(() => (window.__opened ?? []).slice());
