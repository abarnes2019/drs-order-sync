// Headless DRS scraper → Airtable upsert
// - Robust login
// - Smarter table extraction (uses first row as headers if needed)
// - Optional column index overrides (AT_COL_*)
// - Skips blank rows so Airtable never gets empty records
// SECRETS required: DRS_BASE, DRS_USERNAME, DRS_PASSWORD, DRS_ORDERS_URL,
//                   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE
// Optional:         DRS_LOGIN_URL, DATE (YYYY-MM-DD)
// Optional field-name overrides (defaults shown):
// AT_FIELD_DATE="Date", AT_FIELD_CUSTOMER="Customer", AT_FIELD_ADDRESS="Address",
// AT_FIELD_PHONE="Phone", AT_FIELD_SIZE="Dumpster Size", AT_FIELD_ORDER="Order #", AT_FIELD_STATUS="Status"
// Optional column index overrides (1-based):
// AT_COL_CUSTOMER=, AT_COL_ADDRESS=, AT_COL_PHONE=, AT_COL_SIZE=, AT_COL_ORDER=, AT_COL_STATUS=

import fs from "node:fs/promises";
import { chromium } from "playwright";
import Airtable from "airtable";

const env = must({
  DRS_BASE: "", DRS_USERNAME: "", DRS_PASSWORD: "",
  DRS_ORDERS_URL: "", AIRTABLE_API_KEY: "", AIRTABLE_BASE_ID: "", AIRTABLE_TABLE: "",
  DRS_LOGIN_URL: "", DATE: ""
});

const F = {
  date:     process.env.AT_FIELD_DATE     || "Date",
  customer: process.env.AT_FIELD_CUSTOMER || "Customer",
  address:  process.env.AT_FIELD_ADDRESS  || "Address",
  phone:    process.env.AT_FIELD_PHONE    || "Phone",
  size:     process.env.AT_FIELD_SIZE     || "Dumpster Size",
  order:    process.env.AT_FIELD_ORDER    || "Order #",
  status:   process.env.AT_FIELD_STATUS   || "Status",
};

// Optional column index overrides (1-based)
const IDX = {
  customer: toIndex(process.env.AT_COL_CUSTOMER),
  address:  toIndex(process.env.AT_COL_ADDRESS),
  phone:    toIndex(process.env.AT_COL_PHONE),
  size:     toIndex(process.env.AT_COL_SIZE),
  order:    toIndex(process.env.AT_COL_ORDER),
  status:   toIndex(process.env.AT_COL_STATUS),
};

const targetDate = env.DATE || ymdUTC();

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // ---- 1) Login ----
  const candidates = [
    env.DRS_LOGIN_URL,
    `${trimSlash(env.DRS_BASE)}/login/`,
    `${trimSlash(env.DRS_BASE)}/users/login/`,
    `${trimSlash(env.DRS_BASE)}/account/login/`,
    `${trimSlash(env.DRS_BASE)}/admin/login/`,
    `${trimSlash(env.DRS_BASE)}/`
  ].filter(Boolean);

  let loggedIn = false;
  for (const url of candidates) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (await tryLogin(page, env.DRS_USERNAME, env.DRS_PASSWORD)) { loggedIn = true; break; }
    if (!(await hasPasswordField(page))) { loggedIn = true; break; }
  }
  if (!loggedIn) {
    await snapshot(page, "login-failed");
    throw new Error(`Login failed. See artifacts. URL: ${page.url()}`);
  }

  // ---- 2) Orders page ----
  await page.goto(env.DRS_ORDERS_URL, { waitUntil: "domcontentloaded" });

  // ---- 3) Date filter (best-effort) ----
  const startSel = 'input[name="start"], input[name="from"], input#start_date, input#date';
  const endSel   = 'input[name="end"], input[name="to"], input#end_date';
  if (await page.$(startSel)) { await page.fill(startSel, targetDate); }
  if (await page.$(endSel))   { await page.fill(endSel,   targetDate); }
  const filterBtn = page.locator('button:has-text("Filter"), button:has-text("Apply"), button:has-text("Search"), input[type="submit"]');
  if (await filterBtn.first().count()) {
    await Promise.all([ page.waitForLoadState("networkidle"), filterBtn.first().click() ]);
  }

  // ---- 4) Extract table ----
  const { rows, headers } = await extractTable(page);
  if (!rows.length) await snapshot(page, "no-rows");

  // Always write scraped payload for inspection
  await fs.writeFile(
    "/tmp/orders.json",
    JSON.stringify({ date: targetDate, count: rows.length, headers, map: F, idx: IDX, sample: rows[0] || null, rows }, null, 2),
    "utf8"
  );

  // ---- 5) Map → filter blanks → Airtable upsert ----
  const mapped = rows.map(r => ({
    [F.date]:     targetDate,
    [F.customer]: pick(r, ["Customer","Name","Client"]) || pickIndex(r, IDX.customer),
    [F.address]:  pick(r, ["Address","Delivery Address"]) || pickIndex(r, IDX.address),
    [F.phone]:    pick(r, ["Phone","Phone Number"]) || pickIndex(r, IDX.phone),
    [F.size]:     pick(r, ["Dumpster Size","Size"]) || pickIndex(r, IDX.size),
    [F.order]:    pick(r, ["Order","Order ID","ID"]) || pickIndex(r, IDX.order),
    [F.status]:   pick(r, ["Status"]) || pickIndex(r, IDX.status),
  }))
  // drop rows where everything (except Date) is blank
  .filter(obj => {
    const keys = [F.customer, F.address, F.phone, F.size, F.order, F.status];
    return keys.some(k => (obj[k] || "").toString().trim().length > 0);
  });

  let imported = 0;
  if (mapped.length) {
    const base = new Airtable({ apiKey: env.AIRTABLE_API_KEY }).base(env.AIRTABLE_BASE_ID);
    const table = base(env.AIRTABLE_TABLE);

    try {
      for (let i = 0; i < mapped.length; i += 10) {
        const chunk = mapped.slice(i, i + 10).map(fields => ({ fields }));
        if (chunk.length) {
          const created = await table.create(chunk);
          imported += created.length;
        }
      }
    } catch (e) {
      const msg = typeof e === "object" ? JSON.stringify(e, null, 2) : String(e);
      await fs.writeFile("/tmp/airtable-error.txt", msg, "utf8");
      throw e;
    }
  }

  console.log(JSON.stringify({
    date: targetDate,
    scraped: rows.length,
    kept: mapped.length,
    imported,
    table: env.AIRTABLE_TABLE,
    usedHeaders: headers,
    fields: F,
    indexOverrides: IDX
  }, null, 2));

  await browser.close();
})().catch(async (err) => {
  console.error(String(err));
  process.exit(1);
});

// ---------------- helpers ----------------
function must(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = process.env[k];
    if (!v && !["DRS_LOGIN_URL","DATE"].includes(k)) throw new Error(`Missing env ${k}`);
    out[k] = v || "";
  }
  return out;
}
function ymdUTC(d=new Date()){ const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,"0"), day=String(d.getUTCDate()).padStart(2,"0"); return `${y}-${m}-${day}`; }
function trimSlash(u){ return (u||"").replace(/\/+$/,""); }
function toIndex(s){ const n = parseInt(s || "", 10); return Number.isFinite(n) && n > 0 ? n : 0; }

async function hasPasswordField(page){
  const sel = 'input[placeholder="Password"], input[name="password"], input#password, input[type="password"]';
  return Boolean(await page.$(sel));
}

async function tryLogin(page, user, pass){
  await page.waitForLoadState("domcontentloaded");

  const userField =
    (await page.$('input[placeholder="Username"]')) ||
    (await page.$('input[name="username"]')) ||
    (await page.$('input#username')) ||
    (await page.$('input[type="text"]')) ||
    (await page.$('input[type="email"]'));
  if (!userField) return false;

  const pwdField =
    (await page.$('input[placeholder="Password"]')) ||
    (await page.$('input[name="password"]')) ||
    (await page.$('input#password')) ||
    (await page.$('input[type="password"]'));
  if (!pwdField) return false;

  await userField.fill(user);
  await pwdField.fill(pass);

  const submit = page.locator('button:has-text("Sign in"), button:has-text("Sign"), button:has-text("Log"), button[type="submit"], input[type="submit"]');
  if (await submit.first().count()) {
    await Promise.all([ page.waitForLoadState("networkidle"), submit.first().click() ]);
  } else {
    await page.keyboard.press("Enter");
    await page.waitForLoadState("networkidle");
  }

  const stillPwd = await hasPasswordField(page);
  const hasLogout = await page.$('a:has-text("Logout"), button:has-text("Logout")');
  return !stillPwd || Boolean(hasLogout);
}

function pick(obj, keys){ for (const k of keys) { const v = obj[k]; if (v && String(v).trim()) return v; } return ""; }
function pickIndex(row, idx){ if (!idx) return ""; const key = `col${idx}`; const v = row[key]; return v && String(v).trim() ? v : ""; }

async function snapshot(page, tag){
  try {
    const png = `/tmp/${tag}.png`;
    const html = `/tmp/${tag}.html`;
    await page.screenshot({ path: png, fullPage: true });
    await fs.writeFile(html, await page.content(), "utf8");
    console.log(`SNAPSHOT: wrote ${png} and ${html}`);
  } catch (e) { console.log(`SNAPSHOT failed: ${String(e)}`); }
}

async function extractTable(page) {
  try { await page.waitForSelector("table", { timeout: 10000 }); } catch {}
  const payload = await page.$$eval("table", (tbls) => {
    function clean(s){return (s||"").replace(/\s+/g," ").trim();}
    const keywords = ["customer","address","phone","size","order","status"];

    const packs = tbls.map(t => {
      const trs = Array.from(t.querySelectorAll("tr"));
      // headers: prefer thead/th; else first row tds if they look like headers
      let ths = Array.from(t.querySelectorAll("thead th, tr th")).map(th => clean(th.textContent||""));
      if (ths.length === 0 && trs.length > 0) {
        const firstTds = Array.from(trs[0].querySelectorAll("td")).map(td => clean(td.textContent||""));
        const scoreHdr = firstTds.map(h => h.toLowerCase()).filter(h => keywords.some(k => h.includes(k))).length;
        if (scoreHdr > 0) ths = firstTds;
      }

      const startRow = (ths.length && trs.length && t.querySelector("thead") == null) ? 1 : 0;
      const bodyRows = trs.slice(startRow).map(tr => {
        const cells = Array.from(tr.querySelectorAll("td")).map(td => clean(td.textContent||"")).filter(x => x !== "");
        if (cells.length === 0) return null;
        const row = {};
        const headers = ths.length ? ths : [];
        if (headers.length) {
          headers.forEach((h,i)=> row[h || `col${i+1}`] = cells[i] || "");
          // fill remaining as col#
          for (let i=headers.length; i<cells.length; i++) row[`col${i+1}`] = cells[i] || "";
        } else {
          cells.forEach((v,i)=> row[`col${i+1}`] = v);
        }
        return row;
      }).filter(Boolean);

      const hdrScore = ths.map(h=>h.toLowerCase()).filter(h=>keywords.some(k=>h.includes(k))).length;
      return { headers: ths, score: hdrScore, rows: bodyRows };
    });

    // choose table with most keyword matches, fallback to the one with most rows
    packs.sort((a,b)=> (b.score - a.score) || (b.rows.length - a.rows.length));
    const best = packs[0] || { headers:[], rows:[] };

    // Title Case headers; leave col# keys alone
    const normRows = best.rows.map(r => {
      const out = {};
      for (const [k,v] of Object.entries(r)) {
        if (/^col\d+$/i.test(k)) { out[k] = v; continue; }
        const key = k.split(" ").map(w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(" ");
        out[key] = v;
      }
      return out;
    });

    const titledHeaders = best.headers.map(h => h.split(" ").map(w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(" "));
    return { rows: normRows, headers: titledHeaders };
  });

  return payload;
}
