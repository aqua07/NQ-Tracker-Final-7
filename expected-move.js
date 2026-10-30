// api/expected-move.js
// Market-implied daily expected move from the nearest-expiration ATM straddle.
//
//   GET /api/expected-move?symbol=QQQ
//
// Response:
//   emPct      straddle / spot  (fraction, e.g. 0.0112 = 1.12%)  <- what Quantower uses
//   straddle   ATM straddle mid, interpolated to spot
//   ivEmPct    ATM mid IV / sqrt(252)  (1-sigma daily move from IV, for comparison)
//   expiration the expiration used (0DTE during the day; next one after 16:15 ET)
//
// Multiply emPct by the futures reference price (e.g. NQ RTH open) to get points.
// Note: a straddle prices the expected ABSOLUTE move (~0.8 sigma), so it runs a bit
// smaller than an IV/sqrt(252) 1-sigma move.

const TRADIER_TOKEN = process.env.TRADIER_API_KEY;   // no fallback: set it in Vercel
const BASE = "https://api.tradier.com/v1";
const CACHE_TTL = 60 * 1000;

const HEADERS = () => ({
  Authorization: `Bearer ${TRADIER_TOKEN}`,
  Accept: "application/json",
});

const _cache = {};

async function fetchJSON(url) {
  const res = await fetch(url, { headers: HEADERS() });
  const text = await res.text();
  if (!res.ok) throw new Error(`Tradier ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
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
  return { date, hm };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "no-store");

  try {
    if (!TRADIER_TOKEN) throw new Error("TRADIER_API_KEY not set");

    const symbol = (req.query.symbol || "QQQ").toUpperCase();
    const hit = _cache[symbol];
    if (hit && Date.now() - hit.ts < CACHE_TTL) return res.status(200).json(hit.data);

    // spot
    const q = await fetchJSON(`${BASE}/markets/quotes?symbols=${symbol}&greeks=false`);
    const spot = Number(q?.quotes?.quote?.last);
    if (!(spot > 0)) throw new Error(`No spot price for ${symbol}`);

    // expiration: today's until 16:15 ET, then the next one
    const { date: today, hm } = etNow();
    const ex = await fetchJSON(`${BASE}/markets/options/expirations?symbol=${symbol}&includeAllRoots=false&strikes=false`);
    let exps = ex?.expirations?.date || [];
    if (!Array.isArray(exps)) exps = [exps];
    const afterClose = hm >= "16:15";
    const expiration = exps.find(e => (afterClose ? e > today : e >= today));
    if (!expiration) throw new Error(`No usable expiration for ${symbol}`);

    // chain
    const ch = await fetchJSON(`${BASE}/markets/options/chains?symbol=${symbol}&expiration=${expiration}&greeks=true`);
    let opts = ch?.options?.option || [];
    if (!Array.isArray(opts)) opts = [opts];

    // straddle per strike
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

    // interpolate between the strikes bracketing spot
    let lo = rows[0], hi = rows[rows.length - 1];
    for (let i = 0; i < rows.length - 1; i++) {
      if (rows[i].k <= spot && rows[i + 1].k >= spot) { lo = rows[i]; hi = rows[i + 1]; break; }
    }
    const t = hi.k > lo.k ? (spot - lo.k) / (hi.k - lo.k) : 0;
    const straddle = lo.straddle + (hi.straddle - lo.straddle) * t;
    const atm = Math.abs(lo.k - spot) <= Math.abs(hi.k - spot) ? lo : hi;
    const atmIV = atm.iv;

    const data = {
      symbol,
      expiration,
      is0DTE: expiration === today,
      spot,
      atmStrike: atm.k,
      straddle: Number(straddle.toFixed(4)),
      emPct: Number((straddle / spot).toFixed(6)),
      atmIV,
      ivEmPct: atmIV ? Number((atmIV / Math.sqrt(252)).toFixed(6)) : null,
      asOf: new Date().toISOString(),
    };

    _cache[symbol] = { ts: Date.now(), data };
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
