// api/oi-summary.js
// Options open interest tracker — aggregates OI across the chain for any symbol,
// snapshots one record per ET trading date into Upstash Redis (raw REST, no deps),
// returns today's totals + trailing history with deltas.
//
// GET /api/oi-summary?symbol=QQQ&maxDte=60&days=15
//
// Env vars — checks Gu_ prefixed names first (your Upstash integration prefix),
// then falls back to unprefixed:
//   Gu_KV_REST_API_URL   / KV_REST_API_URL
//   Gu_KV_REST_API_TOKEN / KV_REST_API_TOKEN
//   TRADIER_API_KEY

const TRADIER_TOKEN = process.env.TRADIER_API_KEY;
const KV_URL =
  process.env.Gu_KV_REST_API_URL ||
  process.env.GU_KV_REST_API_URL ||
  process.env.KV_REST_API_URL;
const KV_TOKEN =
  process.env.Gu_KV_REST_API_TOKEN ||
  process.env.GU_KV_REST_API_TOKEN ||
  process.env.KV_REST_API_TOKEN;

const TRADIER_BASE = "https://api.tradier.com/v1";
const CACHE_TTL_SECONDS = 4 * 60 * 60;      // OI is static intraday
const SNAPSHOT_RETENTION_DAYS = 120;

// ---------- KV helper (Upstash REST command endpoint, no SDK needed) ----------
async function kv(...command) {
  const r = await fetch(KV_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`KV ${command[0]} -> ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`KV ${command[0]}: ${j.error}`);
  return j.result;
}

// ---------- helpers ----------
function etDateString(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

async function tradierGet(path, params) {
  const url = new URL(TRADIER_BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${TRADIER_TOKEN}`,
      Accept: "application/json",
    },
  });
  if (!r.ok) throw new Error(`Tradier ${path} -> ${r.status}`);
  return r.json();
}

async function fetchExpirations(symbol, maxDte) {
  const j = await tradierGet("/markets/options/expirations", {
    symbol, includeAllRoots: "true",
  });
  const raw = j?.expirations?.date;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const today = new Date(etDateString() + "T00:00:00");
  return list.filter((exp) => {
    const dte = (new Date(exp + "T00:00:00") - today) / 86400000;
    return dte >= 0 && dte <= maxDte;
  });
}

async function fetchChainOI(symbol, expiration) {
  const j = await tradierGet("/markets/options/chains", { symbol, expiration });
  const raw = j?.options?.option;
  if (!raw) return { callOI: 0, putOI: 0 };
  const opts = Array.isArray(raw) ? raw : [raw];
  let callOI = 0, putOI = 0;
  for (const o of opts) {
    const oi = Number(o.open_interest) || 0;
    if (o.option_type === "call") callOI += oi;
    else if (o.option_type === "put") putOI += oi;
  }
  return { callOI, putOI };
}

async function aggregateOI(symbol, maxDte) {
  const expirations = await fetchExpirations(symbol, maxDte);
  if (expirations.length === 0)
    throw new Error(`No expirations found for ${symbol} within ${maxDte} DTE`);

  let callOI = 0, putOI = 0;
  const BATCH = 5; // stay well under Tradier rate limits
  for (let i = 0; i < expirations.length; i += BATCH) {
    const batch = expirations.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((e) => fetchChainOI(symbol, e)));
    for (const r of results) { callOI += r.callOI; putOI += r.putOI; }
  }
  return { callOI, putOI, expirationsCounted: expirations.length };
}

async function loadHistory(symbol, days) {
  const dates =
    (await kv("LRANGE", `oi:dates:${symbol}`, "0", String(days - 1))) || [];
  if (dates.length === 0) return [];
  const snaps = await kv("MGET", ...dates.map((d) => `oi:snap:${symbol}:${d}`));
  const history = [];
  for (let i = 0; i < dates.length; i++) {
    if (!snaps[i]) continue;
    try {
      history.push({ date: dates[i], ...JSON.parse(snaps[i]) });
    } catch { /* skip corrupt row */ }
  }
  return history; // newest first
}

async function saveSnapshot(symbol, date, snap) {
  const key = `oi:snap:${symbol}:${date}`;
  const exists = await kv("EXISTS", key);
  await kv("SET", key, JSON.stringify(snap), "EX",
    String(SNAPSHOT_RETENTION_DAYS * 86400));
  if (!Number(exists)) {
    await kv("LPUSH", `oi:dates:${symbol}`, date);
    await kv("LTRIM", `oi:dates:${symbol}`, "0",
      String(SNAPSHOT_RETENTION_DAYS - 1));
  }
}

// ---------- handler ----------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  try {
    if (!TRADIER_TOKEN) throw new Error("TRADIER_API_KEY not set");
    if (!KV_URL || !KV_TOKEN)
      throw new Error("KV env vars not set (checked Gu_KV_REST_API_URL / KV_REST_API_URL)");

    const symbol = String(req.query.symbol || "QQQ").toUpperCase().trim();
    const maxDte = Math.min(Math.max(parseInt(req.query.maxDte) || 60, 1), 365);
    const days = Math.min(Math.max(parseInt(req.query.days) || 15, 2), 90);
    const today = etDateString();

    // 1) Serve intraday cache if present (OI doesn't change intraday)
    const cacheKey = `oi:cache:${symbol}:${today}:${maxDte}`;
    if (req.query.force !== "1") {
      const cached = await kv("GET", cacheKey);
      if (cached) {
        const payload = JSON.parse(cached);
        payload.history = await loadHistory(symbol, days);
        payload.cached = true;
        return res.status(200).json(payload);
      }
    }

    // 2) Aggregate fresh from Tradier
    const { callOI, putOI, expirationsCounted } = await aggregateOI(symbol, maxDte);
    const totalOI = callOI + putOI;
    const snap = { callOI, putOI, totalOI, maxDte, expirationsCounted };

    // 3) Persist today's snapshot (one per ET date — survives everything)
    await saveSnapshot(symbol, today, snap);

    // 4) Build response with history + deltas vs prior snapshot
    const history = await loadHistory(symbol, days);
    const prior = history.find((h) => h.date !== today);
    const payload = {
      symbol,
      date: today,
      ...snap,
      pcRatio: callOI > 0 ? +(putOI / callOI).toFixed(3) : null,
      deltaCall: prior ? callOI - prior.callOI : null,
      deltaPut: prior ? putOI - prior.putOI : null,
      deltaTotal: prior ? totalOI - prior.totalOI : null,
      priorDate: prior ? prior.date : null,
      history,
      generatedAt: new Date().toISOString(),
    };

    await kv("SET", cacheKey, JSON.stringify(payload), "EX",
      String(CACHE_TTL_SECONDS));
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
