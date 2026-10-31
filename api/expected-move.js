// api/expected-move.js
// Market-implied expected move from the nearest-expiration ATM straddle,
// plus FROZEN snapshots so the reference never drifts when a client reloads.
//
//   GET /api/expected-move?symbol=QQQ
//
// Response:
//   live   straddle priced right now (shrinks through the day as 0DTE decays)
//   open   0DTE straddle captured 09:31-10:00 ET today       -> RTH reference (09:30 -> 16:00)
//   close  next-expiration straddle captured after 16:15 ET  -> Globex / full-day reference (close -> close)
//          keyed by the expiration it covers, so overnight and the next RTH session read the same one
//   emPct  = live.emPct (backward compatible)
//
// Snapshots are written to Upstash (GU_ vars) the first time this route is hit inside a capture
// window. Vercel Cron hits it at 09:31 and 16:20 ET so they exist even if nobody is watching.
// A snapshot is never overwritten once captured.
//
// emPct = straddle / spot. Multiply by the futures reference price for points.
// A straddle prices the expected ABSOLUTE move (~0.8 sigma).

const TRADIER_TOKEN = process.env.TRADIER_API_KEY;   // no fallback: set it in Vercel
const BASE = "https://api.tradier.com/v1";
// Upstash credentials: first name pair that exists wins (integration prefixes vary)
const KV_PAIRS = [
  ["GU_KV_REST_API_URL", "GU_KV_REST_API_TOKEN"],
  ["GU_UPSTASH_REDIS_REST_URL", "GU_UPSTASH_REDIS_REST_TOKEN"],
  ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
  ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
];
const KV_FOUND = KV_PAIRS.find(([u, t]) => process.env[u] && process.env[t]) || null;
const KV_URL = KV_FOUND ? process.env[KV_FOUND[0]] : null;
const KV_TOKEN = KV_FOUND ? process.env[KV_FOUND[1]] : null;
const CACHE_TTL = 60 * 1000;
const SNAP_TTL = 60 * 60 * 24 * 21;   // keep snapshots 3 weeks

const _cache = {};

// ---------------- helpers ----------------
async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Tradier ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// Upstash REST: POST the command as a JSON array to the base URL
async function kv(cmd) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(KV_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) return null;
  return (await r.json())?.result ?? null;
}

async function kvGet(key) {
  const v = await kv(["GET", key]);
  return v ? JSON.parse(v) : null;
}

// SET ... NX: only writes if the key doesn't exist yet (first capture wins)
async function kvSetNX(key, value) {
  return (await kv(["SET", key, JSON.stringify(value), "NX", "EX", String(SNAP_TTL)])) === "OK";
}

function mid(o) {
  const b = Number(o?.bid), a = Number(o?.ask), l = Number(o?.last);
  if (b > 0 && a > 0 && a >= b) return (a + b) / 2;
  return l > 0 ? l : null;
}

function etNow() {
  const now = new Date();
  const date = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const hm = now.toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour12: false }).slice(0, 5);
  const dow = new Date(date + "T12:00:00Z").getUTCDay();   // 0 Sun .. 6 Sat
  return { date, hm, weekday: dow >= 1 && dow <= 5 };
}

async function priceStraddle(symbol, expiration) {
  const q = await fetchJSON(`${BASE}/markets/quotes?symbols=${symbol}&greeks=false`);
  const spot = Number(q?.quotes?.quote?.last);
  if (!(spot > 0)) throw new Error(`No spot price for ${symbol}`);

  const ch = await fetchJSON(`${BASE}/markets/options/chains?symbol=${symbol}&expiration=${expiration}&greeks=true`);
  let opts = ch?.options?.option || [];
  if (!Array.isArray(opts)) opts = [opts];

  const byStrike = new Map();
  for (const o of opts) {
    const k = Number(o.strike);
    if (!byStrike.has(k)) byStrike.set(k, {});
    byStrike.get(k)[o.option_type] = o;
  }
  const rows = [...byStrike.entries()]
    .map(([k, v]) => {
      const c = mid(v.call), p = mid(v.put);
      const iv = [v.call?.greeks?.mid_iv, v.put?.greeks?.mid_iv].filter(x => x > 0);
      return { k, straddle: c != null && p != null ? c + p : null, iv: iv.length ? iv.reduce((a, b) => a + b) / iv.length : null };
    })
    .filter(r => r.straddle != null)
    .sort((a, b) => a.k - b.k);
  if (!rows.length) throw new Error(`No priced straddles for ${symbol} ${expiration}`);

  let lo = rows[0], hi = rows[rows.length - 1];
  for (let i = 0; i < rows.length - 1; i++) {
    if (rows[i].k <= spot && rows[i + 1].k >= spot) { lo = rows[i]; hi = rows[i + 1]; break; }
  }
  const t = hi.k > lo.k ? (spot - lo.k) / (hi.k - lo.k) : 0;
  const straddle = lo.straddle + (hi.straddle - lo.straddle) * t;
  const atm = Math.abs(lo.k - spot) <= Math.abs(hi.k - spot) ? lo : hi;

  return {
    symbol,
    expiration,
    spot,
    atmStrike: atm.k,
    straddle: Number(straddle.toFixed(4)),
    emPct: Number((straddle / spot).toFixed(6)),
    atmIV: atm.iv,
    ivEmPct: atm.iv ? Number((atm.iv / Math.sqrt(252)).toFixed(6)) : null,
    capturedAt: new Date().toISOString(),
  };
}

// ---------------- handler ----------------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "no-store");

  try {
    if (!TRADIER_TOKEN) throw new Error("TRADIER_API_KEY not set");

    const symbol = (req.query.symbol || "QQQ").toUpperCase();
    // cron calls (or ?capture=1) always skip the cache so a capture can't be missed
    const force = req.query.capture === "1" || /vercel-cron/i.test(req.headers?.["user-agent"] || "");
    const hit = _cache[symbol];
    if (!force && hit && Date.now() - hit.ts < CACHE_TTL) return res.status(200).json(hit.data);

    const { date: today, hm, weekday } = etNow();

    const ex = await fetchJSON(`${BASE}/markets/options/expirations?symbol=${symbol}&includeAllRoots=false&strikes=false`);
    let exps = ex?.expirations?.date || [];
    if (!Array.isArray(exps)) exps = [exps];

    const afterClose = hm >= "16:15";
    const liveExp = exps.find(e => (afterClose ? e > today : e >= today));
    if (!liveExp) throw new Error(`No usable expiration for ${symbol}`);

    const live = await priceStraddle(symbol, liveExp);

    // --- capture windows (first write wins) ---
    const openKey = `em_open_${symbol}_${today}`;
    if (weekday && liveExp === today && hm >= "09:31" && hm < "10:00") {
      await kvSetNX(openKey, { ...live, kind: "open" });
    }
    if (weekday && afterClose && hm < "20:00") {
      await kvSetNX(`em_close_${symbol}_${liveExp}`, { ...live, kind: "close" });
    }

    // --- read back the frozen references ---
    // close snapshot that covers the CURRENT trading period:
    //   after the close -> the next expiration (overnight into tomorrow)
    //   before it       -> today's expiration (captured at yesterday's close)
    const closeExp = afterClose ? liveExp : (exps.find(e => e >= today) || liveExp);
    const [open, close] = await Promise.all([kvGet(openKey), kvGet(`em_close_${symbol}_${closeExp}`)]);

    const data = {
      symbol,
      live,
      open,                 // null until captured today
      close,                // null if no close capture covers this period
      emPct: live.emPct,    // backward compatible
      expiration: live.expiration,
      is0DTE: live.expiration === today,
      kvConfigured: Boolean(KV_URL && KV_TOKEN),
      kvVars: KV_FOUND ? KV_FOUND[0] : "none found (checked: " + KV_PAIRS.map(p => p[0]).join(", ") + ")",
      // names only, never values: helps spot a mis-named variable
      kvLikeVarNames: Object.keys(process.env).filter(k => /KV|UPSTASH|REDIS/i.test(k)).sort(),
      asOf: new Date().toISOString(),
    };

    _cache[symbol] = { ts: Date.now(), data };
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
