/**
 * Screenshot the app at desktop and phone widths.
 *
 * Headless Chrome has no wallet extension, so one is injected: a minimal
 * EIP-1193 provider that answers `eth_accounts` with a demo address and forwards
 * everything else to the same RPC the page uses. It signs nothing — these are
 * screenshots, and a provider that could sign would be a provider that could
 * spend.
 *
 *   node scripts/shots.mjs --url http://127.0.0.1:3100 --wallet 0x… --rpc http://127.0.0.1:8545
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const BASE = arg("url", "http://127.0.0.1:3100");
const RPC = arg("rpc", "http://127.0.0.1:8545");
const WALLET = arg("wallet", "");
const OUT = resolve(arg("out", "docs/screens"));
const ONLY = arg("only", "");

/** Long enough for a multicall table and a log scan to land. */
const SETTLE_MS = Number(arg("settle", "14000"));

const SHOTS = [
  { name: "fixture-1440", path: "/fixture", width: 1440, height: 1200 },
  { name: "agents-1440", path: "/agents", width: 1440, height: 1200 },
  { name: "profile-agent-1-1440", path: "/profile/agent-1", width: 1440, height: 1400 },
  { name: "settlement-settled-1440", path: "/settlement?f=20090506", width: 1440, height: 1300 },
  // The current fixture is PRE_MATCH on chain — it is waiting for the demo, not
  // being played — so this is what /settlement looks like before kick-off.
  { name: "settlement-prematch-1440", path: "/settlement", width: 1440, height: 1300 },
  // 20090506 was redeemed to the last unit, so its Redeem card is empty by
  // definition. This one is settled with positions still open.
  { name: "settlement-settled-holdings-1440", path: "/settlement?f=20260922", width: 1440, height: 1300 },
  // The pitch is laid out differently on a phone — the shirts need room to be
  // tappable — so it gets its own shot rather than being assumed from 1440.
  { name: "fixture-390", path: "/fixture", width: 390, height: 1600 },
  { name: "agents-390", path: "/agents", width: 390, height: 1600 },
  { name: "settlement-390", path: "/settlement?f=20090506", width: 390, height: 1600 },
];

const provider = (wallet, rpc) => `
  (() => {
    const accounts = ${JSON.stringify(wallet ? [wallet] : [])};
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
        if (method === "wallet_switchEthereumChain") return null;
        if (method === "net_version") return "11155111";
        if (method.startsWith("eth_send") || method.startsWith("personal_") || method.startsWith("eth_sign")) {
          throw Object.assign(new Error("screenshot provider cannot sign"), { code: 4001 });
        }
        const res = await fetch(${JSON.stringify(rpc)}, {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--force-device-scale-factor=2"],
});

for (const shot of SHOTS) {
  if (ONLY && !shot.name.includes(ONLY)) continue;

  const page = await browser.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));

  await page.evaluateOnNewDocument(provider(WALLET, RPC));
  await page.setViewport({ width: shot.width, height: shot.height, deviceScaleFactor: 2 });
  await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle2", timeout: 60_000 });

  // Connect the injected wallet, if the header is offering.
  if (WALLET) {
    try {
      await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find(
          (b) => b.textContent?.trim() === "Connect",
        );
        button?.click();
      });
    } catch {
      /* already connected */
    }
  }

  await sleep(SETTLE_MS);

  const file = `${OUT}/${shot.name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  const height = await page.evaluate(() => document.body.scrollHeight);
  console.log(
    `${shot.name.padEnd(28)} ${shot.width}w  page ${height}px  ${
      errors.length ? `${errors.length} console errors` : "clean"
    }`,
  );
  for (const e of [...new Set(errors)].slice(0, 5)) console.log(`   ! ${e}`);
  await page.close();
}

await browser.close();
