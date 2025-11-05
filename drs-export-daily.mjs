// drs-export-daily.mjs
// Automates DRS: login → Reports → Daily → Export CSV
// ENV required:
//   DRS_LOGIN_URL   (e.g. https://reliablerentalequipment.ourers.com/cp/autoforward)
//   DRS_USERNAME    (e.g. "Ashley B")
//   DRS_PASSWORD
// Optional ENV:
//   DRS_REPORTS_URL (direct URL to Reports page if you have it)
//   DATE            (YYYY-MM-DD; defaults to today local)
//   HEADLESS=0      (to see the browser)
//   OUT_DIR         (default: ./exports)

import fs from "node:fs/promises";
import { chromium } from "playwright";

const env = must([
  "DRS_LOGIN_URL",
  "DRS_USERNAME",
  "DRS_PASSWORD",
]);

const DATE = process.env.DATE || ymdLocal();
const OUT_DIR = process.env.OUT_DIR || "exports";
const HEADLESS = process.env.HEADLESS !== "0";

(async () => {
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  // 1) LOGIN
  await page.goto(process.env.DRS_LOGIN_URL, { waitUntil: "domcontentloaded" });
  await fillFirst(page, [
    'input[placeholder="Username"]',
    'input[name="username"]',
    '#username',
    'input[type="text"]',
    'input[type="email"]'
  ], process.env.DRS_USERNAME);

  await fillFirst(page, [
    'input[placeholder="Password"]',
    'input[name="password"]',
    '#password',
    'input[type="password"]'
  ], process.env.DRS_PASSWORD);

  await clickFirst(page, [
    'button:has-text("Sign in")',
    'button:has-text("Sign")',
    'button[type="submit"]',
    'input[type="submit"]'
  ]);

  // consider logged in when password field disappears or we see Reports
  await page.waitForLoadState("networkidle");
  const loggedIn = !(await page.$('input[type="password"], input[name="password"], #password'));

  if (!loggedIn) throw new Error("Login failed (password field still present).");

  // 2) REPORTS PAGE
  if (process.env.DRS_REPORTS_URL) {
    await page.goto(process.env.DRS_REPORTS_URL, { waitUntil: "domcontentloaded" });
  } else {
    // try menus
    await clickFirst(page, [
      'a:has-text("Reports")',
      'button:has-text("Reports")',
      'nav >> text=Reports',
      'text=Reports'
    ], { optional: true });
  }
  await page.waitForLoadState("domcontentloaded");

  // 3) SELECT DAILY REPORT
  await clickFirst(page, [
    'a:has-text("Daily")',
    'button:has-text("Daily")',
    '[role="tab"]:has-text("Daily")',
    'select[name*="report"], select#report, select[name*="Report"]'
  ], { optional: true });

  // if a <select>, set to "Daily"
  await selectIfPresent(page, [
    'select[name*="report"]',
    'select#report',
    'select[name*="Report"]'
  ], /daily/i);

  // 4) SET DATE (best effort)
  await setDateIfPresent(page, DATE);

  // 5) EXPORT CSV (capture download)
  const fileSafeDate = DATE;
  await fs.mkdir(OUT_DIR, { recursive: true }).catch(() => {});
  const targetPath = `${OUT_DIR}/DRS-Daily-${fileSafeDate}.csv`;

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    clickFirst(page, [
      'button:has-text("Export")',
      'button:has-text("CSV")',
      'a:has-text("Export")',
      'a:has-text("CSV")',
      '[aria-label*="Export"]',
      '[aria-label*="CSV"]',
      'text=/Export.*CSV/i',
      'text=/CSV/i'
    ])
  ]);

  await download.saveAs(targetPath);
  console.log(`SAVED ${targetPath}`);

  await browser.close();
})().catch(async (err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});

// ---------- helpers ----------
function must(list){
  for (const k of list) {
    if (!process.env[k] || String(process.env[k]).trim()==="") {
      console.error(`Missing env ${k}`);
      process.exit(2);
    }
  }
  return true;
}

async function fillFirst(page, selectors, value){
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) { await el.fill(value); return; }
  }
  throw new Error(`Unable to find input for selectors: ${selectors.join(" | ")}`);
}

async function clickFirst(page, selectors, opts = {}){
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count()) { await loc.click(); return; }
  }
  if (!opts.optional) throw new Error(`Unable to click any of: ${selectors.join(" | ")}`);
}

async function selectIfPresent(page, selectors, optionRegex){
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      const options = await page.$$eval(`${sel} option`, els => els.map(o => ({ value:o.value, text:o.textContent || "" })));
      const match = options.find(o => optionRegex.test(o.text));
      if (match) { await page.selectOption(sel, match.value); return true; }
    }
  }
  return false;
}

async function setDateIfPresent(page, dateStr){
  const picks = [
    'input[type="date"]',
    'input[name="date"]',
    '#date',
    'input[name="start"]',
    '#start_date',
    'input[name="from"]'
  ];
  for (const sel of picks) {
    const el = await page.$(sel);
    if (el) { await el.fill(dateStr); }
  }
  // if there is an "end" field, mirror the same date
  for (const sel of ['input[name="end"]', '#end_date', 'input[name="to"]']) {
    const el = await page.$(sel);
    if (el) { await el.fill(dateStr); }
  }
}

function ymdLocal(d = new Date()){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const da = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${da}`;
}
