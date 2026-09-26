/**
 * World ID, the six protected-action cases, against the real sandbox IdP and an
 * anvil fork.
 *
 *   APPROVER=human    node scripts/verify-world-fork.mjs <outDir>   # default
 *   APPROVER=headless node scripts/verify-world-fork.mjs <outDir>   # dry run
 *
 * The rule under test: increasing an agent's authority needs a fresh World ID
 * proof; decreasing it never does. Cases, each approved and not approved:
 *
 *   create     Demo 2 pre-match, "Verify with World ID · create agent-N"
 *   raise cap  live Demo 3, agent-10 / agent-15, 1 → 300 USDC
 *   resume     My agents, agent-8 / agent-9 (a raise from 0)
 *
 * The app runs at https://localhost:3100 against the fork (sim.world-fork.env).
 * The Whistle tabs are headless Chrome with the owner's wallet injected; every
 * action starts from the real button, and its World ID page opens in a tab that
 * stands in for "the human is on another device": it does not run the sandbox's
 * mock ceremony itself (it would approve itself with a fresh fake identity in
 * about two seconds), so an action happens only if someone opens the page's
 * Approval link and chooses Approve sign-in.
 *
 *   human     prints the three Approval links to approve and writes all six to
 *             <outDir>/links.json; the other three are left to run out.
 *   headless  a second headless browser approves the three (a mechanics check).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { appPage, BASE, clickText, connect, launch, log, opened, until, wait } from "./world-fork-lib.mjs";

const OUT = process.argv[2];
const MODE = process.env.APPROVER ?? "human";
const LIVE = "2026092703", PRE = "2026092702";
const RAISE_YES = "agent-10", RAISE_NO = "agent-15", RES_YES = "agent-8", RES_NO = "agent-9";
const NEW_CAP = "300";
mkdirSync(OUT, { recursive: true });

const browser = await launch();
const errors = [];
const results = [];
const check = (ok, what) => { results.push({ ok, what }); log(`${ok ? "PASS" : "FAIL"}  ${what}`); };
const newOpened = async (page, before) => until(async () => (await opened(page)).slice(before)[0], 60_000, 500);
const capSel = (label) => `[data-testid="cap-controls"][data-agent="${label}.tokyo.whistle.eth"]`;
const capText = (page, label) => page.evaluate((s) => document.querySelector(s)?.innerText.replace(/\s+/g, " ") ?? "", capSel(label));

async function shotOf(page, selector, name, up = "li, [class*='p-4']") {
  await page.bringToFront();
  const h = await page.evaluateHandle((sel, up) => { const el = document.querySelector(sel); return el?.closest(up) ?? el; }, selector, up);
  const el = h.asElement();
  if (!el) return log(`  (no element for ${name})`);
  try {
    await el.scrollIntoView(); await wait(500);
    await el.screenshot({ path: `${OUT}/${name}.png` });
    log(`  screenshot ${name}.png`);
  } catch (err) {
    log(`  (screenshot ${name} failed: ${String(err).slice(0, 80)}) — full page instead`);
    await page.screenshot({ path: `${OUT}/${name}.png` }).catch(() => {});
  }
}

// Hold the IdP page: no self-ceremony, no self-approval. Returns its Approval link.
async function idpHold(url, name) {
  const p = await browser.newPage();
  await p.setViewport({ width: 1100, height: 1000 });
  await p.setRequestInterception(true);
  p.on("request", (r) => (/\/(ceremony|approve)$/.test(r.url()) && r.method() === "POST" ? r.abort() : r.continue()));
  // Many tabs, one front: the IdP page polls only while it thinks it is visible.
  await p.evaluateOnNewDocument(() => {
    Object.defineProperty(document, "visibilityState", { get: () => "visible" });
    Object.defineProperty(document, "hidden", { get: () => false });
    document.hasFocus = () => true;
  });
  await p.goto(url, { waitUntil: "domcontentloaded" });
  const link = await until(() => p.evaluate(() => document.querySelector("#approval-link")?.value ?? null).catch(() => null), 30_000, 500);
  await p.bringToFront(); await wait(300);
  await p.screenshot({ path: `${OUT}/${name}-idp.png` }).catch(() => {});
  return link;
}

const attempts = [];
async function begin(name, page, click) {
  const before = (await opened(page)).length;
  const ok = await click();
  const url = ok ? await newOpened(page, before) : null;
  check(Boolean(url), `${name}: Verify pressed, World ID page opened`);
  if (!url) return;
  const link = await idpHold(url, name);
  attempts.push({ name, page, link, approve: name.endsWith("approved") });
  log(`  ${name}: approval link ${link ? "ready" : "MISSING"}`);
}

// Set a React-controlled input, then press the button its label now names.
async function raise(page, label, cap) {
  await page.evaluate((s, v) => {
    const input = document.querySelector(`${s} input`);
    input.scrollIntoView({ block: "center" });
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, capSel(label), cap);
  return until(() => page.evaluate((s) => {
    const b = [...document.querySelectorAll(`${s} button`)].find((x) => /raise cap to .* verify with world id/i.test(x.innerText) && !x.disabled);
    b?.click(); return Boolean(b);
  }, capSel(label)), 15_000, 500);
}
const resume = (page, label) => until(() => page.evaluate((s) => {
  const b = [...document.querySelectorAll(`${s} button`)].find((x) => /resume · verify with world id/i.test(x.innerText) && !x.disabled);
  if (b) { b.scrollIntoView({ block: "center" }); b.click(); } return Boolean(b);
}, capSel(label)), 15_000, 500);

// ------------------------------------------------------------ pages
const L = await appPage(browser, errors);
await L.setViewport({ width: 1440, height: 1000 });
await L.goto(`${BASE}/fixtures/${LIVE}`, { waitUntil: "domcontentloaded" });
await wait(3_000); await connect(L);
check(Boolean(await until(() => L.evaluate((a, b) => Boolean(document.querySelector(a) && document.querySelector(b)), capSel(RAISE_YES), capSel(RAISE_NO)), 240_000, 2_000)),
  "live screen shows cap controls on my agents");
await shotOf(L, capSel(RAISE_YES), "live-agents-before", "section");

const A = await appPage(browser, errors);
await A.setViewport({ width: 1440, height: 1000 });
await A.goto(`${BASE}/agents`, { waitUntil: "domcontentloaded" });
await wait(3_000); await connect(A);
check(Boolean(await until(() => A.evaluate((a, b) => /resume · verify/i.test(document.querySelector(a)?.innerText ?? "") && /resume · verify/i.test(document.querySelector(b)?.innerText ?? ""), capSel(RES_YES), capSel(RES_NO)), 240_000, 2_000)),
  `My agents shows Resume · verify with World ID on ${RES_YES} and ${RES_NO}`);

async function createPage() {
  const C = await appPage(browser, errors);
  await C.setViewport({ width: 1440, height: 1000 });
  await C.goto(`${BASE}/fixtures/${PRE}`, { waitUntil: "domcontentloaded" });
  await wait(3_000); await connect(C);
  await until(() => C.evaluate(() => { const x = [...document.querySelectorAll("button")].find((b) => /verify with world id · create agent-\d+/i.test(b.innerText)); return Boolean(x && !x.disabled); }), 240_000, 2_000);
  return C;
}
const C2 = await createPage();
const C1 = await createPage();

// ------------------------------------------------------------ start all six
// Not-approved cases first: they only have to run out. Approved ones last, so
// their five minutes start as late as possible.
await begin("raise-denied", L, () => raise(L, RAISE_NO, NEW_CAP));
await begin("resume-denied", A, () => resume(A, RES_NO));
await begin("create-denied", C2, () => clickText(C2, /verify with world id · create agent-/).then(Boolean));
await begin("create-approved", C1, () => clickText(C1, /verify with world id · create agent-/).then(Boolean));
await begin("raise-approved", L, () => raise(L, RAISE_YES, NEW_CAP));
await begin("resume-approved", A, () => resume(A, RES_YES));

const links = attempts.map((x) => ({ case: x.name, approve: x.approve, link: x.link }));
writeFileSync(`${OUT}/links.json`, JSON.stringify(links, null, 2));
log(`links written: ${OUT}/links.json`);
for (const x of attempts.filter((a) => a.approve)) log(`  APPROVE ${x.name}: ${x.link}`);
await shotOf(L, capSel(RAISE_YES), "raise-pending", "li");

// ------------------------------------------------------------ the human step
if (MODE === "headless") {
  const approver = await launch(`${OUT}/approver-profile`);
  for (const x of attempts.filter((a) => a.approve)) {
    const B = await approver.newPage();
    await B.goto(x.link, { waitUntil: "domcontentloaded" });
    const clickB = (src) => B.evaluate((s) => { const b = [...document.querySelectorAll("button")].find((y) => new RegExp(s, "i").test(y.innerText)); b?.click(); return b?.innerText ?? null; }, src).catch(() => null);
    await until(() => clickB("authenticate with world id|continue"), 20_000, 500);
    const ok = await until(() => clickB("approve sign-in"), 20_000, 500);
    const settled = await until(() => B.evaluate(() => /Sign-in approved/i.test(document.body.innerText)).catch(() => false), 30_000, 500);
    log(`  (dry run) approver: ${x.name} ${ok ? "approved" : "no Approve button"}${settled ? ", IdP says Sign-in approved" : ", IdP never confirmed"}`);
    await B.bringToFront(); await B.screenshot({ path: `${OUT}/${x.name}-approver.png` }).catch(() => {});
    await B.close();
  }
  await approver.close();
} else {
  log("waiting for the human: open each APPROVE link, Authenticate with World ID, then Approve sign-in");
}

// ------------------------------------------------------------ outcomes
const createText = (C) => C.evaluate(() => document.querySelector('[data-testid="world-create-agent"]')?.closest("div.space-y-4, div.space-y-5")?.innerText.replace(/\s+/g, " ") ?? "");
const NO = /Not approved within five minutes — nothing was changed/;
const all = await until(async () => {
  const [c1, c2, ry, rn, sy, sn] = await Promise.all([createText(C1), createText(C2), capText(L, RAISE_YES), capText(L, RAISE_NO), capText(A, RES_YES), capText(A, RES_NO)]);
  const done = /Created .*human-backed · World ID/.test(c1) && NO.test(c2) && /Cap raised .* after a World ID check/.test(ry) && NO.test(rn)
    && /Resumed at .* after a World ID check/.test(sy) && NO.test(sn);
  return done ? { c1, c2, ry, rn, sy, sn } : null;
}, 8 * 60_000, 5_000);
check(Boolean(all), "all six attempts reached their outcome");

const [c1, c2, ry, rn, sy, sn] = await Promise.all([createText(C1), createText(C2), capText(L, RAISE_YES), capText(L, RAISE_NO), capText(A, RES_YES), capText(A, RES_NO)]);
check(/Verified with World ID — done/.test(c1) && /human-backed · World ID/.test(c1), `create approved: "${(/Created[^.]*\.[^·]*· human-backed · World ID/.exec(c1) ?? [c1.slice(0, 140)])[0]}"`);
check(NO.test(c2), "create not approved: nothing was changed");
check(/Cap raised 1 → 300 USDC/.test(ry), `raise approved: "${(/Cap raised[^.]*\./.exec(ry) ?? [ry.slice(0, 120)])[0]}"`);
check(NO.test(rn), `raise not approved: ${RAISE_NO} keeps its cap`);
check(/Resumed at/.test(sy), `resume approved: "${(/Resumed at[^.]*\./.exec(sy) ?? [sy.slice(0, 120)])[0]}"`);
check(NO.test(sn), `resume not approved: ${RES_NO} stays paused`);

await shotOf(C1, '[data-testid="world-create-agent"]', "create-approved", "div.space-y-4");
await shotOf(C2, '[data-testid="world-create-agent"]', "create-denied", "div.space-y-4");
await shotOf(L, capSel(RAISE_YES), "raise-approved", "li");
await shotOf(L, capSel(RAISE_NO), "raise-denied", "li");
await shotOf(A, capSel(RES_YES), "resume-approved", "[class*='p-4']");
await shotOf(A, capSel(RES_NO), "resume-denied", "[class*='p-4']");
for (const [p, n] of [[C1, "page-prematch"], [L, "page-live"], [A, "page-agents"]]) { await p.bringToFront(); await p.screenshot({ path: `${OUT}/${n}.png`, fullPage: true }).catch(() => {}); }

// The chain, not the page: a fresh read of each agent's cap after a reload.
await L.reload({ waitUntil: "domcontentloaded" }); await wait(3_000); await connect(L);
await until(() => L.evaluate((s) => Boolean(document.querySelector(s)), capSel(RAISE_YES)), 120_000, 2_000);
await wait(4_000);
const liveRows = await L.evaluate(() => [...document.querySelectorAll('section[aria-label="My agents on this match"] li')].map((li) => li.innerText.replace(/\s+/g, " ").slice(0, 160)));
for (const r of liveRows) log(`  after reload: ${r}`);
check(liveRows.some((r) => r.includes(`${RAISE_YES}.`) && /cap 300/.test(r)), `${RAISE_YES} reads cap 300 from the chain`);
check(liveRows.some((r) => r.includes(`${RAISE_NO}.`) && /cap 1\b/.test(r)), `${RAISE_NO} still reads cap 1`);
check(liveRows.some((r) => r.includes(`${RES_YES}.`) && /READY/.test(r)), `${RES_YES} is running again`);
check(liveRows.some((r) => r.includes(`${RES_NO}.`) && /PAUSED/.test(r)), `${RES_NO} is still paused`);

// profiles: the human record
for (const [label, want] of [[RES_YES, true], [RAISE_YES, true], [RES_NO, false], [RAISE_NO, false]]) {
  const P = await appPage(browser, errors);
  await P.setViewport({ width: 1440, height: 900 });
  await P.goto(`${BASE}/profile/${label}.tokyo.whistle.eth`, { waitUntil: "domcontentloaded" });
  const badge = await until(() => P.evaluate(() => Boolean(document.querySelector('[data-testid="human-badge"]'))), want ? 60_000 : 20_000, 2_000);
  check(Boolean(badge) === want, `${label} ${want ? "shows" : "does not show"} human-backed · World ID`);
  await P.bringToFront(); await P.screenshot({ path: `${OUT}/profile-${label}.png` }).catch(() => {});
  await P.close();
}
const created = /Created (agent-\d+)\./.exec(c1)?.[1];
if (created) {
  const P = await appPage(browser, errors);
  await P.setViewport({ width: 1440, height: 900 });
  await P.goto(`${BASE}/profile/${created}.tokyo.whistle.eth`, { waitUntil: "domcontentloaded" });
  check(Boolean(await until(() => P.evaluate(() => Boolean(document.querySelector('[data-testid="human-badge"]'))), 60_000, 2_000)), `new ${created} shows human-backed · World ID`);
  await P.bringToFront(); await P.screenshot({ path: `${OUT}/profile-created.png` }).catch(() => {});
}

writeFileSync(`${OUT}/results.json`, JSON.stringify({ mode: MODE, results, errors: errors.slice(0, 20), links }, null, 2));
log(`${results.filter((r) => !r.ok).length} failed of ${results.length}; page errors: ${errors.length}`);
await browser.close();
