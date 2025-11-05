// Automates DRS: Login → Reports → click "Day" tab → set date → "Export To CSV"
// Usage (local):
//   npm i playwright
//   npx playwright install --with-deps chromium
//   DRS_LOGIN_URL='https://reliablerentalequipment.ourers.com/cp/autoforward' \
//   DRS_USERNAME='Ashley B' DRS_PASSWORD='YOUR_PASS' \
//   node drs-export-daily.mjs --date=2025-11-05 --out=./exports
//
// Optional ENV:
//   DRS_REPORTS_URL (direct URL to that "Reports: Order List" page)
//   HEADLESS=0  (to watch it run)
//   DATE=YYYY-MM-DD (alternative to --date)
//   OUT_DIR=./path

import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a, true];
}));

const DRS_LOGIN_URL   = need("DRS_LOGIN_URL");
const DRS_USERNAME    = need("DRS_USERNAME");
const DRS_PASSWORD    = need("DRS_PASSWORD");
const DRS_REPORTS_URL = process.env.DRS_REPORTS_URL || "";
const HEADLESS        = process.env.HEADLESS === "0" ? false : true;
const OUT_DIR         = process.env.OUT_DIR || args.out || "./exports";
const DATE_ISO        = (process.env.DATE || args.date || ymdLocal());
const DATE_MDY        = isoToMDY(DATE_ISO); // UI shows 11/05/2025

(async () => {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  // 1) Login
  await page.goto(DRS_LOGIN_URL, { waitUntil: "domcontentloaded" });
  await fillFirst(page, [
    'input[placeholder="Username"]',
    'input[name="username"]',
    '#username',
    'input[type="text"]',
    'input[type="email"]'
  ], DRS_USERNAME);

  await fillFirst(page, [
    'input[placeholder="Password"]',
    'input[name="password"]',
    '#password',
    'input[type="password"]'
  ], DRS_PASSWORD);

  await clickFirst(page, [
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'button[type="submit"]',
    'input[type="submit"]'
  ]);

  await page.waitForLoadState("networkidle");

  // 2) Go to Reports page
  if (DRS_REPORTS_URL) {
    await page.goto(DRS_REPORTS_URL, { waitUntil: "domcontentloaded" });
  } else {
    await clickFirst(page, [
      'a:has-text("Reports")',
      'button:has-text("Reports")',
      'nav >> text=Reports',
      'text=Reports'
    ], { optional: true });
  }
  await page.waitForLoadState("domcontentloaded");

  // 3) Click "Day" tab (your UI defaults to Month)
  await clickFirst(page, [
    'button:has-text("Day")',
    'a:has-text("Day")',
    '[role="tab"]:has-text("Day")',
    'text=/^\\s*Day\\s*$/'
  ], { optional: true });

  // 4) Put date into the MM/DD/YYYY input near the top controls
  await setDateInAnyDateBox(page, DATE_MDY);

  // 5) Export CSV (capture download)
  const fileName = `DRS-Daily-${DATE_ISO}.csv`;
  const savePath = path.join(OUT_DIR, fileName);

  const downloadP = page.waitForEvent("download", { timeout: 30000 }).catch(() => null);

  await clickFirst(page, [
    'button:has-text("Export To CSV")',
    'a:has-text("Export To CSV")',
    'button:has-text("CSV")',
    'a:has-text("CSV")',
    'text=/Export\\s*To\\s*CSV/i'
  ]);

  let dl = await downloadP;

  if (dl) {
    const suggested = dl.suggestedFilename() || fileName;
    const final = suggested.toLowerCase().endsWith(".csv") ? suggested : fileName;
    await dl.saveAs(path.join(OUT_DIR, final));
    console.log(`SAVED ${path.join(OUT_DIR, final)}`);
  } else {
    // Fallback: sometimes the CSV opens inline
    const maybe = await tryGrabCSVFromPage(page);
    if (!maybe) {
      await page.screenshot({ path: path.join(OUT_DIR, "no-download.png"), fullPage: true }).catch(()=>{});
      throw new Error("No CSV download detected and page wasn’t CSV. See no-download.png");
    }
    await fs.writeFile(savePath, maybe, "utf8");
    console.log(`SAVED ${savePath}`);
  }

  await browser.close();
})().catch(err => { console.error(err?.stack || String(err)); process.exit(1); });

// ---------- helpers ----------
function need(k){ const v = process.env[k]; if (!v) { console.error(`Missing env ${k}`); process.exit(2); } return v; }
function ymdLocal(d=new Date()){ const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), da=String(d.getDate()).padStart(2,"0"); return `${y}-${m}-${da}`; }
function isoToMDY(s){ const m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if(!m) return s; return `${m[2]}/${m[3]}/${m[1]}`; }

async function fillFirst(page, selectors, value){
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) { await el.fill(value); return true; }
  }
  return false;
}
async function clickFirst(page, selectors, opts = {}){
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count()) { await loc.click({ timeout: 8000 }); return true; }
  }
  if (opts.optional) return false;
  throw new Error(`Could not click any of: ${selectors.join(" | ")}`);
}

async function setDateInAnyDateBox(page, mdy){
  // Strategy:
  //  - prefer obvious date inputs
  //  - otherwise, find a text input whose value already matches MM/DD/YYYY and replace it
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
    if (el) { await el.fill(mdy); return true; }
  }

  const boxes = await page.$$('input[type="text"]');
  for (const el of boxes) {
    const v = (await el.inputValue()).trim();
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v)) {
      await el.fill(mdy);
      return true;
    }
  }
  return false;
}

async function tryGrabCSVFromPage(page){
  try {
    const url = page.url();
    if (/\.csv(\?|$)/i.test(url)) {
      const res = await fetch(url); if (res.ok) return await res.text();
    }
  } catch {}
  try {
    const text = await page.textContent("body");
    if (text && text.includes(",") && /\n/.test(text)) return text;
  } catch {}
  return "";
}
