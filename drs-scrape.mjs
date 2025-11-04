// Headless DRS scraper → Airtable upsert
// Required secrets: DRS_BASE, DRS_USERNAME, DRS_PASSWORD, DRS_ORDERS_URL,
// AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE
import { chromium } from "playwright";
import Airtable from "airtable";

const env = must({
  DRS_BASE: "", DRS_USERNAME: "", DRS_PASSWORD: "",
  DRS_ORDERS_URL: "", // paste the URL of the DRS page that lists daily orders/routes
  AIRTABLE_API_KEY: "", AIRTABLE_BASE_ID: "", AIRTABLE_TABLE: "",
  DATE: "" // optional override "YYYY-MM-DD"; default = today
});

const targetDate = env.DATE || ymdUTC();

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 1) Login (update selectors to match your login form)
  await page.goto(env.DRS_BASE, { waitUntil: "domcontentloaded" });
  // Heuristics: try common login fields; replace if your page is different
  const userSel = 'input[name="username"], input#username, input[name="email"]';
  const passSel = 'input[name="password"], input#password';
  await page.waitForSelector(userSel, { timeout: 30000 });
  await page.fill(userSel, env.DRS_USERNAME);
  await page.fill(passSel, env.DRS_PASSWORD);
  // look for a button with "Log", "Sign", or submit
  const loginBtn = page.locator('button:has-text("Log"), button:has-text("Sign"), input[type="submit"]');
  await loginBtn.first().click();
  await page.waitForLoadState("domcontentloaded");

  // 2) Go to orders/route listing page
  await page.goto(env.DRS_ORDERS_URL, { waitUntil: "domcontentloaded" });

  // Try to set date filters if present
  // Adjust the selectors below once; the rest will keep working.
  const startSel = 'input[name="start"], input[name="from"], input#start_date, input#date';
  const endSel   = 'input[name="end"], input[name="to"], input#end_date';
  if (await page.$(startSel)) { await page.fill(startSel, targetDate); }
  if (await page.$(endSel))   { await page.fill(endSel,   targetDate); }
  const filterBtn = page.locator('button:has-text("Filter"), button:has-text("Apply"), button:has-text("Search"), input[type="submit"]');
  if (await filterBtn.first().count()) {
    await filterBtn.first().click();
    await page.waitForLoadState("domcontentloaded");
  }

  // 3) Extract the first meaningful table (auto-detect by headers)
  const rows = await extractTable(page);

  // 4) Upsert to Airtable
  const base = new Airtable({ apiKey: env.AIRTABLE_API_KEY }).base(env.AIRTABLE_BASE_ID);
  const table = base(env.AIRTABLE_TABLE);

  // map columns; rename to match your Airtable column names
  const mapped = rows.map(r => ({
    "Date": targetDate,
    "Customer": r.Customer ?? r.Name ?? r.Client ?? "",
    "Address": r.Address ?? r["Delivery Address"] ?? "",
    "Phone": r.Phone ?? r["Phone Number"] ?? "",
    "Dumpster Size": r.Size ?? r["Dumpster Size"] ?? "",
    "Order #": r.Order ?? r["Order ID"] ?? r.ID ?? "",
    "Status": r.Status ?? ""
  }));

  // Chunk writes 10 at a time
  for (let i = 0; i < mapped.length; i += 10) {
    const chunk = mapped.slice(i, i + 10).map(fields => ({ fields }));
    if (chunk.length) await table.create(chunk);
  }

  console.log(JSON.stringify({ date: targetDate, imported: mapped.length }, null, 2));
  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });

// ---- helpers ----
function must(obj) {
  const out = {}; for (const k of Object.keys(obj)) {
    const v = process.env[k]; if (!v && k !== "DATE") throw new Error(`Missing env ${k}`);
    out[k] = v || ""; } return out;
}
function ymdUTC(d=new Date()){ const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,"0"), day=String(d.getUTCDate()).padStart(2,"0"); return `${y}-${m}-${day}`; }

async function extractTable(page) {
  // pick table whose headers contain at least two of these keywords
  const mustHave = ["customer","address","phone","size","order","status"];
  const tables = await page.$$eval("table", (tbls, keys) => {
    function clean(s){return (s||"").replace(/\s+/g," ").trim();}
    return tbls.map(t => {
      const ths = Array.from(t.querySelectorAll("thead th, tr th")).map(th => clean(th.textContent||""));
      const score = ths.map(h=>h.toLowerCase()).filter(h=>keys.some(k=>h.includes(k))).length;
      const rows = Array.from(t.querySelectorAll("tbody tr")).map(tr => {
        const cells = Array.from(tr.querySelectorAll("td")).map(td => clean(td.textContent||""));
        const row = {}; ths.forEach((h,i)=>row[h||`col${i+1}`]=cells[i]||""); return row;
      });
      return { headers: ths, score, rows };
    });
  }, mustHave);

  const best = tables.sort((a,b)=>b.score-a.score)[0] || { headers:[], rows:[] };
  // Standardize keys (Title Case)
  const rows = best.rows.map(r => {
    const out = {};
    for (const [k,v] of Object.entries(r)) {
      const key = k.split(" ").map(w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(" ");
      out[key] = v;
    }
    return out;
  });
  return rows;
}
