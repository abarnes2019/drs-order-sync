// Headless DRS scraper → Airtable upsert (with debug artifacts + Airtable field mapping)
// SECRETS required: DRS_BASE, DRS_USERNAME, DRS_PASSWORD, DRS_ORDERS_URL,
//                   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE
// Optional:         DRS_LOGIN_URL, DATE (YYYY-MM-DD)
// Optional field-name overrides (defaults shown):
// AT_FIELD_DATE="Date", AT_FIELD_CUSTOMER="Customer", AT_FIELD_ADDRESS="Address",
// AT_FIELD_PHONE="Phone", AT_FIELD_SIZE="Dumpster Size", AT_FIELD_ORDER="Order #", AT_FIELD_STATUS="Status"

import fs from "node:fs/promises";
import { chromium } from "playwright";
import Airtable from "airtable";

const env = must({
  DRS_BASE: "", DRS_USERNAME: "", DRS_PASSWORD: "",
  DRS_ORDERS_URL: "", AIRTABLE_API_KEY: "", AIRTABLE_BASE_ID: "", AIRTABLE_TABLE: "",
  DRS_LOGIN_URL: "", DATE: ""
});

const F = {
  date:    process.env.AT_FIELD_DATE    || "Date",
  customer:process.env.AT_FIELD_CUSTOMER|| "Customer",
  address: process.env.AT_FIELD_ADDRESS || "Address",
  phone:   process.env.AT_FIELD_PHONE   || "Phone",
  size:    process.env.AT_FIELD_SIZE    || "Dumpster Size",
  order:   process.env.AT_FIELD_ORDER   || "Order #",
  status:  process.env.AT_FIELD_STATUS  || "Status",
};

const targetDate = env.DATE || ymdUTC();

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // ----- 1) Login -----
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

  // ----- 2) Navigate to orders page -----
  await page.goto(env.DRS_ORDERS_URL, { waitUntil: "domcontentloaded" });

  // ----- 3) Apply date filter if inputs exist -----
  const startSel = 'input[name="start"], input[name="from"], input#start_date, input#date';
  const endSel   = 'input[name="end"], input[name="to"], input#end_date';
  if (await page.$(startSel)) { await page.fill(startSel, targetDate); }
  if (await page.$(endSel))   { await page.fill(endSel,   targetDate); }
  const filterBtn = page.locator('button:has-text("Filter"), button:has-text("Apply"), button:has-text("Search"), input[type="submit"]');
  if (await filterBtn.first().count()) {
    await Promise.all([ page.waitForLoadState("networkidle"), filterBtn.first().click() ]);
  }

  // ----- 4) Extract table -----
  const rows = await extractTable(page);
  if (!rows.length) await snapshot(page, "no-rows");

  // ALWAYS write what we scraped so you can inspect it
  await fs.writeFile("/tmp/orders.json", JSON.stringify({ date: targetDate, count: rows.length, map: F, sample: rows[0] || null, rows }, null, 2), "utf8");

  // ----- 5) Upsert to Airtable -----
  let imported = 0;
  if (rows.length) {
    const base = new Airtable({ apiKey: env.AIRTABLE_API_KEY }).base(env.AIRTABLE_BASE_ID);
    const table = base(env.AIRTABLE_TABLE);

    const mapped = rows.map(r => ({
      [F.date]:    targetDate,
      [F.customer]:pick(r, ["Customer","Name","Client"]),
      [F.address]: pick(r, ["Address","Delivery Address"]),
      [F.phone]:   pick(r, ["Phone","Phone Number"]),
      [F.size]:    pick(r, ["Dumpster Size","Size"]),
      [F.order]:   pick(r, ["Order","Order ID","ID"]),
      [F.status]:  pick(r, ["Status"])
    }));

    try {
      for (let i = 0; i < mapped.length; i += 10) {
        const chunk = mapped.slice(i, i + 10).map(fields => ({ fields }));
        if (chunk.length) {
          const created = await table.create(chunk);
          imported += created.length;
        }
      }
    } catch (e) {
      // Save the error so you can see exactly what Airtable objected to
      const msg = typeof e === "object" ? JSON.stringify(e, null, 2) : String(e);
      await fs.writeFile("/tmp/airtable-error.txt", msg, "utf8");
      throw e;
    }
  }

  console.log(JSON.stringify({ date: targetDate, scraped: rows.length, imported, table: env.AIRTABLE_TABLE, fields: F }, null, 2));
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

async function hasPasswordField(page){
  const sel = 'input[placeholder="Password"], input[name="password"], input#password, input[type="password"]';
  const el = await page.$(sel);
  return Boolean(el);
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

function pick(obj, keys){ for (const k of keys) { if (obj[k]) return obj[k]; } return ""; }

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
