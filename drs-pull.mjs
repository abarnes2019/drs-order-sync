// Pulls JSON from your Cloudflare worker and upserts into Airtable (REST).
// Repo Secrets required:
//   WORKER_URL          = https://<your-worker-subdomain>.workers.dev
//   AIRTABLE_API_KEY    = pat.... (scopes: data.records:read, data.records:write)
//   AIRTABLE_BASE_ID    = appXXXXXXXXXXXXXX
//   AIRTABLE_TABLE      = Dumpsters  (or your table)
//
// Optional:
//   DATE                = YYYY-MM-DD  (defaults to today UTC)
//   START / END         = YYYY-MM-DD (use a range instead of DATE)
//   AT_FIELD_*          = custom Airtable column names (defaults below)
//
// Columns used (override via secrets):
const F = {
  date:     process.env.AT_FIELD_DATE     || "Date",
  customer: process.env.AT_FIELD_CUSTOMER || "Customer",
  address:  process.env.AT_FIELD_ADDRESS  || "Address",
  phone:    process.env.AT_FIELD_PHONE    || "Phone",
  size:     process.env.AT_FIELD_SIZE     || "Dumpster Size",
  order:    process.env.AT_FIELD_ORDER    || "Order #",
  status:   process.env.AT_FIELD_STATUS   || "Status",
  raw:      process.env.AT_FIELD_RAW      || ""   // optional text field to store JSON snapshot
};

const WORKER_URL = must("WORKER_URL");
const API_KEY    = must("AIRTABLE_API_KEY");
const BASE_ID    = must("AIRTABLE_BASE_ID");
const TABLE      = must("AIRTABLE_TABLE");

const date  = process.env.DATE || ymd();
const start = process.env.START || date;
const end   = process.env.END   || date;

(async () => {
  const u = new URL(WORKER_URL);
  if (process.env.START || process.env.END) { u.searchParams.set("start", start); u.searchParams.set("end", end); }
  else { u.searchParams.set("date", date); }

  const r = await fetch(u, { headers: { "Accept":"application/json" } });
  const body = await r.text();
  let data = null;
  try { data = JSON.parse(body); } catch {}
  if (!r.ok || !data || !Array.isArray(data.orders)) {
    console.error("Worker failed:", r.status, body.slice(0,500));
    process.exit(1);
  }

  const orders = data.orders;

  // map each order -> Airtable fields
  const mapped = orders.map(o => {
    const flat = flatten(o);
    const customer = pick(flat, ["customer","customer_name","name","client","contactname"]);
    const address  = pick(flat, ["delivery_address","address","location","site_address"]);
    const phone    = pick(flat, ["customer_phone","phone","contact_phone","mobile"]);
    const size     = pick(flat, ["dumpster_size","size","container_size","bin_size"]);
    const orderNo  = pick(flat, ["order_id","id","order","number","tracking","ticket_id","invoice_id"]);
    const status   = pick(flat, ["status","state","order_status"]);

    const rec = {
      [F.date]: ymd(new Date(start)),
      [F.customer]: customer,
      [F.address]: address,
      [F.phone]: phone,
      [F.size]: size,
      [F.order]: String(orderNo || "").replace(/^#/, ""),
      [F.status]: status
    };
    if (F.raw) rec[F.raw] = JSON.stringify(o);
    return rec;
  })
  // drop blanks (no customer, no address, no order number)
  .filter(r => (r[F.customer] || r[F.address] || r[F.order]) );

  // Upsert by (Date + Order #)
  let created = 0, updated = 0;
  for (const rec of mapped) {
    const key = String(rec[F.order] || "").replace(/'/g, "\\'");
    const dt  = String(rec[F.date] || "");
    let id = await findRecord(dt, key);
    if (id) {
      await airtableUpdate(id, rec);
      updated++;
    } else {
      await airtableCreate(rec);
      created++;
    }
  }

  console.log(JSON.stringify({
    fetched: orders.length, kept: mapped.length, created, updated,
    dateRange: (process.env.START || process.env.END) ? { start, end } : { date },
    fields: F
  }, null, 2));
})().catch(e => { console.error(e); process.exit(1); });

// ---------- helpers ----------
function must(k){ const v = process.env[k]; if (!v) { console.error(`Missing ${k}`); process.exit(1); } return v; }
function ymd(d=new Date()){ const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,"0"), da=String(d.getUTCDate()).padStart(2,"0"); return `${y}-${m}-${da}`; }
function pick(obj, keys){ for (const k of keys){ if (obj[k]) return obj[k]; } return ""; }
function flatten(obj,prefix="",out={}) {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k,v] of Object.entries(obj)) flatten(v, k.toLowerCase(), out);
  } else {
    out[prefix.toLowerCase()] = obj;
  }
  return out;
}

// Airtable REST
async function findRecord(dateVal, orderNo){
  if (!orderNo) return null;
  const formula = encodeURIComponent(`AND({${F.date}}='${dateVal}', {${F.order}}='${orderNo}')`);
  const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE)}?maxRecords=1&filterByFormula=${formula}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` }});
  const j = await r.json();
  return (j.records && j.records[0] && j.records[0].id) || null;
}
async function airtableCreate(fields){
  const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({ records:[{ fields }] })
  });
  if (!r.ok) throw new Error(`Airtable create failed ${r.status}: ${await r.text()}`);
}
async function airtableUpdate(id, fields){
  const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE)}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({ records:[{ id, fields }] })
  });
  if (!r.ok) throw new Error(`Airtable update failed ${r.status}: ${await r.text()}`);
}
