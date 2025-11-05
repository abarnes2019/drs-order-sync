// Cloudflare Worker: DRS proxy (POST form & header auth) + debug diagnostics
// Env vars:
//  DRS_BASE       = https://reliablerentalequipment.ourers.com
//  DRS_DEV_KEY    = <dev key>
//  DRS_API_TOKEN  = <api token>
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return ok(null, cors());

    const url   = new URL(req.url);
    const base  = String(env.DRS_BASE || "").replace(/\/+$/, "");
    const key   = env.DRS_DEV_KEY || "";
    const token = env.DRS_API_TOKEN || "";
    const debug = url.searchParams.get("debug") === "1";

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

    const attempts = [];
    for (const u of endpoints) {
      attempts.push(() => postForm(u, key, token, "post-form"));
      attempts.push(() => postHeaders(u, key, token, "post-headers"));
      attempts.push(() => getHeaders(u, key, token, "get-headers"));
    }

    let diag = { status: 0, ct: "", len: 0, head: "", url: "", mode: "", keys: [] };

    for (const tryOne of attempts) {
      const { res, tried, mode } = await tryOne();
      const ct  = (res.headers.get("content-type") || "").toLowerCase();
      const txt = await res.text();
      let parsed = null; try { parsed = JSON.parse(txt); } catch {}

      const keys = parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
      const head = txt.slice(0, 500);

      if (res.ok && parsed) {
        const orders = pickArray(parsed);
        if (Array.isArray(orders) && (orders.length > 0 || !debug)) {
          return json({ orders, source: mode }, 200);
        }
        // if debug, fall through so we can include diagnostics
        diag = { status: res.status, ct, len: txt.length, head, url: tried, mode, keys };
      } else {
        diag = { status: res.status, ct, len: txt.length, head, url: tried, mode, keys };
      }
    }

    // If we got here, no usable array found. In debug mode, include diagnostics.
    if (debug) {
      return json({ orders: [], diagnostics: diag }, 502);
    }
    // Non-debug: return empty but still JSON, so clients don’t crash.
    return json({ orders: [] , source: "no-array" }, 200);
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

async function postForm(url, key, token, mode) {
  const u = url.endsWith("/") ? url : url + "/";
  const body = `key=${enc(key)}&token=${enc(token)}`;
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
  return wrap(res, u, mode);
}

async function postHeaders(url, key, token, mode) {
  const u = url.endsWith("/") ? url : url + "/";
  const res = await fetch(u, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "ERS-DEV-KEY": key,
      "ERS-API-TOKEN": token,
      "X-Requested-With": "XMLHttpRequest",
    },
    redirect: "follow"
  });
  return wrap(res, u, mode);
}

async function getHeaders(url, key, token, mode) {
  const u = url.endsWith("/") ? url : url + "/";
  const res = await fetch(u, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "ERS-DEV-KEY": key,
      "ERS-API-TOKEN": token,
      "X-Requested-With": "XMLHttpRequest",
    },
    redirect: "follow"
  });
  return wrap(res, u, mode);
}

function wrap(res, tried, mode) {
  const h = new Headers(res.headers); cors(h);
  return { res: new Response(res.body, { status: res.status, headers: h }), tried, mode };
}

// Pull out first sensible array from a JSON object
function pickArray(root) {
  if (Array.isArray(root)) return root;
  const keys = ["orders","order","rows","data","results","baskets","basket","list","items"];
  if (root && typeof root === "object") {
    for (const k of keys) {
      const v = root[k]; if (Array.isArray(v)) return v;
    }
  }
  // deep walk
  const seen = new Set();
  function walk(x) {
    if (!x || typeof x !== "object" || seen.has(x)) return null;
    seen.add(x);
    if (Array.isArray(x)) return x;
    for (const v of Object.values(x)) {
      const r = walk(v); if (r) return r;
    }
    return null;
  }
  return walk(root) || [];
}
