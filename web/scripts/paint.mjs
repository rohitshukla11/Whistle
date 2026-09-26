/**
 * Time the settlement screen's first paint, in a tab with nothing cached.
 *
 * Every run launches a fresh browser profile, so `sessionStorage` starts empty
 * and the in-memory scan cache does not exist. That is the state a judge's
 * browser is in, and the only honest way to measure the wait they will actually
 * sit through.
 *
 *   node scripts/paint.mjs --url https://localhost:3100 --fixture 20090506 --runs 3
 */

import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const BASE = arg("url", "https://localhost:3100");
const FIXTURE = arg("fixture", "20090506");
const RUNS = Number(arg("runs", "3"));
const LABEL = arg("label", "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Rows on screen, and how many of them carry a recovered mint basis. */
const probe = () => {
  const rows = document.querySelectorAll("table tbody tr");
  const basis = [...document.querySelectorAll("table tbody tr td:nth-child(4)")].filter((c) =>
    /\d/.test(c.textContent ?? ""),
  ).length;
  return { rows: rows.length, basis };
};

const results = [];

for (let run = 0; run < RUNS; run += 1) {
  // A fresh browser per run, not a fresh page: a new page in the same browser
  // would share the origin's sessionStorage and measure a warm cache.
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--incognito"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 120)));

  const started = Date.now();
  await page.goto(`${BASE}/settlement?f=${FIXTURE}`, { waitUntil: "domcontentloaded", timeout: 90_000 });

  let rowsMs = -1;
  let basisMs = -1;
  const deadline = started + 180_000;
  while (Date.now() < deadline && (rowsMs < 0 || basisMs < 0)) {
    const { rows, basis } = await page.evaluate(probe);
    if (rowsMs < 0 && rows > 5) rowsMs = Date.now() - started;
    if (basisMs < 0 && basis > 0) basisMs = Date.now() - started;
    if (rowsMs >= 0 && basisMs >= 0) break;
    await sleep(250);
  }

  results.push({ rowsMs, basisMs, errors: errors.length });
  console.log(
    `run ${run + 1}: rows ${rowsMs < 0 ? "never" : `${(rowsMs / 1000).toFixed(1)}s`}, ` +
      `basis ${basisMs < 0 ? "never" : `${(basisMs / 1000).toFixed(1)}s`}, ` +
      `${errors.length} console errors`,
  );
  await browser.close();
}

const median = (xs) => {
  const ok = xs.filter((x) => x >= 0).sort((a, b) => a - b);
  return ok.length ? ok[Math.floor(ok.length / 2)] : -1;
};

const r = median(results.map((x) => x.rowsMs));
const b = median(results.map((x) => x.basisMs));
console.log(
  `\n${LABEL ? `${LABEL}: ` : ""}median of ${RUNS} fresh tabs — ` +
    `rows ${r < 0 ? "never" : `${(r / 1000).toFixed(1)}s`}, basis ${b < 0 ? "never" : `${(b / 1000).toFixed(1)}s`}`,
);
