// Cloudflare Worker: DRS proxy (POST form only, JSON-only response)
// Env vars (Cloudflare > Workers > your worker > Settings > Variables):
//   DRS_BASE       = https://reliablerentalequipment.ourers.com
//   DRS_DEV_KEY    = your dev key (ERS "key")
//   DRS_API_TOKEN  = your API token (ERS "token")
//
// Usage from client:
//   GET https://<your-worker>/ ?date=YYYY-MM-DD
//   or ?start=YYYY-MM-DD&end=YYYY-MM-DD
//
// Returns: { orders: [...] }  (502 if the upstream isn’t valid JSON)

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return ok(null, cors());

    const url   = new URL(req.url);
    const base  = String(env.DRS_BASE || "").replace(/\/+$/, "");
    const key   = env.DRS_DEV_KEY || "";
    const token = env.DRS_API_TOKEN || "";

    if (!base || !key || !token) {
      return json({ error: "Worker missing DRS_BASE/DRS_DEV_KEY/DRS_API_TOKEN" }, 500);
    }

    const date  = url.searchParams.get("date") || ymd();
    const start = url.searchParams.get("start") || date;
    const end   = url.searchParams.get("end")   || date;

    const endpoints = [
      `${base}/api/read/order/${start}/${end}/`,
      `${base}/api/read/orders/${start}/${end}/`
    ];

    let diag = { status: 0, ct: "", len: 0, head: "", url: "" };

    for (const u of endpoints) {
      const { res, tried } = await postForm(u, { key, token });
      const ct  = (res.headers.get("content-type") || "").toLowerCase();
      const txt = await res.text();
      const head = txt.slice(0, 500);
      let data = null;
      try { data = JSON.parse(txt); } catch { /* not JSON */ }

      if (res.ok && data) {
        const orders = normalizeArray(data);
        if (Array.isArray(orders)) {
          return json({ orders }, 200);
        }
      }
      diag = { status: res.status, ct, len: txt.length, head, url: tried };
    }

    return json({ error: "DRS returned no JSON array", diagnostics: diag }, 502);
  }
};

// ---------- helpers ----------
function cors(h = new Headers()) {
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET,POST,OPTIONS");
  h.set("access-control-allow-headers", "*,authorization,content-type");
  return h;
}
function ok(body, h = new Headers()) { return new Response(body, { status: 200, headers: h }); }
function json(obj, status = 200) { const h = cors(); h.set("content-type","application/json; charset=utf-8"); return new Response(JSON.stringify(obj), { status, headers: h }); }
function ymd(d = new Date()) { const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,"0"), da=String(d.getUTCDate()).padStart(2,"0"); return `${y}-${m}-${da}`; }
function enc(x) { return encodeURIComponent(x ?? ""); }

async function postForm(url, fields) {
  const u = url.endsWith("/") ? url : url + "/";
  const body = Object.entries(fields).map(([k,v])=>`${k}=${enc(v)}`).join("&");
  const res = await fetch(u, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body,
    redirect: "follow"
  });
  // pass-through with CORS
  const h = new Headers(res.headers);
  cors(h);
  return { res: new Response(await res.body, { status: res.status, headers: h }), tried: u };
}

// Find the first reasonable array inside a DRS response
function normalizeArray(root) {
  if (Array.isArray(root)) return root;
  const keys = ["orders","order","rows","data","results","baskets","basket","list","items"];
  if (root && typeof root === "object") {
    for (const k of keys) if (Array.isArray(root[k])) return root[k];
  }
  // deep walk
  const seen = new Set();
  function walk(x) {
    if (!x || typeof x !== "object" || seen.has(x)) return null;
    seen.add(x);
    if (Array.isArray(x)) return x;
    for (const v of Object.values(x)) {
      const r = walk(v);
      if (r) return r;
    }
    return null;
  }
  return walk(root) || [];
}
