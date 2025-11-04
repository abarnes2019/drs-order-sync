// Headless DRS scraper → Airtable upsert (robust login + debug artifacts)
// Required repo SECRETS: DRS_BASE, DRS_USERNAME, DRS_PASSWORD, DRS_ORDERS_URL,
// AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE
// Optional SECRETS: DRS_LOGIN_URL (exact login page), DATE (YYYY-MM-DD)

import fs from "node:fs/promises";
import { chromium } from "playwright";
import Airtable from "airtable";

const env = must({
  DRS_BASE: "", DRS_USERNAME: "", DRS_PASSWORD: "",
  DRS_ORDERS_URL: "", AIRTABLE_API_KEY: "", AIRTABLE_BASE_ID: "", AIRTABLE_TABLE: "",
  DRS_LOGIN_URL: "", DATE: ""
});

const targetDate = env.DATE || ymdUTC();

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 1) Go to login page (explicit if provided; else try common paths and fallback to base)
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
    // If already authenticated, many apps show a dashboard; treat that as logged in.
    if (!(await hasPasswordField(page))) { loggedIn = true; break; }
  }
  if (!loggedIn) {
    await snapshot(page, "login-failed");
    throw new Error(`Login failed. See artifacts (screenshot/html). URL: ${page.url()}`);
  }

  // 2) Navigate to the orders list page you provided
  await page.goto(env.DRS_ORDERS_URL, { waitUntil: "domcontentloaded" });

  // 3) Set date filters if present (best-effort)
  const startSel = 'input[name="start"], input[name="from"], input#start_date, input#date';
  const endSel   = 'input[name="end"], input[name="to"], input#end_date';
  if (await page.$(startSel)) { await page.fill(startSel, targetDate); }
  if (await page.$(endSel))   { await page.fill(endSel,   targetDate); }
  const filterBtn = page.locator('button:has-text("Filter"), button:has-text("Apply"), button:has-text("Search"), input[type="submit"]');
  if (await filterBtn.first().count()) {
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      filterBtn.first().click()
    ]);
  }

  // 4) Extract the best-looking table
  const rows = await extractTable(page);

  // If no rows, dump a snapshot to artifacts to see what the page looks like
  if (!rows.length) {
    await snapshot(page, "no-rows");
  }

  // 5) Upsert to Airtable
  const base = new Airtable({ apiKey: env.AIRTABLE_API_KEY }).base(env.AIRTABLE_BASE_ID);
  const table = base(env.AIRTABLE_TABLE);

  const mapped = rows.map(r => ({
    "Date": targetDate,
    "Customer": pick(r, ["Customer","Name","Client"]),
    "Address": pick(r, ["Address","Delivery Address"]),
    "Phone": pick(r, ["Phone","Phone Number"]),
    "Dumpster Size": pick(r, ["Dumpster Size","Size"]),
    "Order #": pick(r, ["Order","Order ID","ID"]),
    "Status": pick(r, ["Status"])
  }));

  for (let i = 0; i < mapped.length; i += 10) {
    const chunk = mapped.slice(i, i + 10).map(fields => ({ fields }));
    if (chunk.length) await table.create(chunk);
  }

  console.log(JSON.stringify({ date: targetDate, imported: mapped.length, page: env.DRS_ORDERS_URL }, null, 2));
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
    if (!v && !["DRS_LOGIN_URL","DATE"].includes(k)) {
      throw new Error(`Missing env ${k}`);
    }
    out[k] = v || "";
  }
  return out;
}
function ymdUTC(d=new Date()){ const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,"0"), day=String(d.getUTCDate()).padStart(2,"0"); return `${y}-${m}-${day}`; }
function trimSlash(u){ return (u||"").replace(/\/+$/,""); }
async function hasPasswordField(page){
  return !!(await page.$('input[type="password"], input#password, input[name="password"]'));
}
async function tryLogin(page, user, pass){
  // Find any form that contains a password input; fill the first text-like before it
  const pwd = await page.$('input[type="password"], input#password, input[name="password"]');
  if (!pwd) return false;

  // Try a few username selectors; fallback to "first text input before password"
  const usernameSelectors = [
    'input[name="username"]', 'input#username', 'input[name="email"]',
    'input[type="email"]', 'input[type="text"]'
  ];
  let userField = null;
  for (const sel of usernameSelectors) {
    const h = await page.$(sel);
    if (h) { userField = h; break; }
  }
  if (!userField) {
    // walk DOM: the first text-like input preceding password
    userField = await page.$('input[type="text"], input[type="email"]');
  }
  if (!userField) return false;

  await userField.fill(user);
  await pwd.fill(pass);

  // Find a likely submit
  const submit = page.locator('button:has-text("Log"), button:has-text("Sign"), button[type="submit"], input[type="submit"]');
  if (await submit.first().count()) {
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      submit.first().click()
    ]);
  } else {
    await page.keyboard.press("Enter");
    await page.waitForLoadState("domcontentloaded");
  }

  // Heuristic: if password field is gone or we find "Logout", assume logged in.
  const stillHasPwd = await hasPasswordField(page);
  const hasLogout = await page.$('a:has-text("Logout"), button:has-text("Logout")');
  return !stillHasPwd || !!hasLogout;
}

function pick(obj, keys){
  for (const k of keys) { if (obj[k]) return obj[k]; }
  return "";
}

async function snapshot(page, tag){
  try {
    const png = `/tmp/${tag}.png`;
    const html = `/tmp/${tag}.html`;
    await page.screenshot({ path: png, fullPage: true });
    await fs.writeFile(html, await page.content(), "utf8");
    console.log(`SNAPSHOT: wrote ${png} and ${html}`);
  } catch (e) {
    console.log(`SNAPSHOT failed: ${String(e)}`);
  }
}

async function extractTable(page) {
  // Wait for any table-like structure to appear a bit, but don't block the job forever
  try { await page.waitForSelector("table", { timeout: 10000 }); } catch {}
  const rows = await page.$$eval("table", (tbls) => {
    function clean(s){return (s||"").replace(/\s+/g," ").trim();}
    const keys = ["customer","address","phone","size","order","status"];
    const packs = tbls.map(t => {
      const ths = Array.from(t.querySelectorAll("thead th, tr th")).map(th => clean(th.textContent||""));
      const score = ths.map(h => h.toLowerCase()).filter(h => keys.some(k => h.includes(k))).length;
      const trs = t.querySelectorAll("tbody tr");
      const rows = Array.from(trs).map(tr => {
        const tds = Array.from(tr.querySelectorAll("td")).map(td => clean(td.textContent||""));
        const row = {}; ths.forEach((h,i)=> row[h || `col${i+1}`] = tds[i] || "");
        return row;
      });
      return { headers: ths, score, rows };
    });
    const best = packs.sort((a,b)=>b.score-a.score)[0] || { headers:[], rows:[] };
    // Title Case keys
    return best.rows.map(r => {
      const out = {};
      for (const [k,v] of Object.entries(r)) {
        const key = k.split(" ").map(w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(" ");
        out[key] = v;
      }
      return out;
    });
  });
  return rows;
}
