const TRADIER_TOKEN = process.env.TRADIER_API_KEY || "SJ5hgXkjhlB1ZCllayTT64iAU44o";
const BASE = "https://api.tradier.com/v1";
const CACHE_TTL = 13000; // 13 seconds — slightly under 15s refresh interval

const HEADERS = {
  "Authorization": `Bearer ${TRADIER_TOKEN}`,
  "Accept": "application/json",
};

// In-memory cache — shared across all requests on same Vercel instance
// Prevents multiple indicator instances from hammering Tradier simultaneously
const _cache = {};

function getCached(key) {
  const entry = _cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { delete _cache[key]; return null; }
  return entry.data;
}
function setCache(key, data) {
  _cache[key] = { data, ts: Date.now() };
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: HEADERS });
  const text = await res.text();
  if (!res.ok) throw new Error(`Tradier ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`Bad JSON: ${text.slice(0, 200)}`); }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "no-store");

  try {
    const { exp } = req.query;
    const cacheKey = `options_${exp || "all"}`;

    // Return cached response if fresh — serves all 6 indicator instances
    // from a single Tradier call, staying well within rate limits
    const cached = getCached(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json(cached);
    }
    res.setHeader("X-Cache", "MISS");

    // QQQ spot price
    const quoteData = await fetchJSON(`${BASE}/markets/quotes?symbols=QQQ&greeks=false`);
    const spot = quoteData?.quotes?.quote?.last ?? null;
    if (!spot) throw new Error("No QQQ spot price — check token or market hours");

    // Get expirations
    const expData = await fetchJSON(
      `${BASE}/markets/options/expirations?symbol=QQQ&includeAllRoots=false&strikes=false`
    );
    const allExps = expData?.expirations?.date || [];
    if (!allExps.length) throw new Error("No expirations returned");

    // Fetch nearest 4 expirations or specific one
    const expsToFetch = (exp && exp !== "all") ? [exp] : allExps.slice(0, 4);

    // Fetch chains in parallel
    const chainPromises = expsToFetch.map(e =>
      fetchJSON(`${BASE}/markets/options/chains?symbol=QQQ&expiration=${e}&greeks=true`)
        .then(d => ({ exp: e, options: d?.options?.option || [] }))
        .catch(err => ({ exp: e, options: [], error: err.message }))
    );
    const chains = await Promise.all(chainPromises);

    // Flatten contracts with 0DTE flag
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    let contracts = [];
    for (const chain of chains) {
      const is0DTE = chain.exp === today;
      for (const opt of chain.options) {
        contracts.push({
          details: {
            strike_price: opt.strike,
            contract_type: opt.option_type === "call" ? "call" : "put",
            expiration_date: chain.exp,
            is_0dte: is0DTE,
          },
          greeks: {
            delta: opt.greeks?.delta ?? null,
            gamma: opt.greeks?.gamma ?? null,
            theta: opt.greeks?.theta ?? null,
            vega:  opt.greeks?.vega  ?? null,
          },
          open_interest: opt.open_interest ?? 0,
          day: { volume: opt.volume ?? 0 },
          implied_volatility: opt.greeks?.mid_iv ?? null,
        });
      }
    }

    // Build per-strike callOI/putOI map for PCR calculation
    const strikeOIMap = {};
    for (const c of contracts) {
      const strike = c.details.strike_price;
      const type   = c.details.contract_type;
      const oi     = c.open_interest || 0;
      if (!strikeOIMap[strike]) strikeOIMap[strike] = { callOI: 0, putOI: 0 };
      if (type === "call") strikeOIMap[strike].callOI += oi;
      else strikeOIMap[strike].putOI += oi;
    }

    // Attach PCR to each contract's details
    for (const c of contracts) {
      const m = strikeOIMap[c.details.strike_price];
      c.details.callOI = m?.callOI ?? 0;
      c.details.putOI  = m?.putOI  ?? 0;
      c.details.pcr    = m?.callOI > 0 ? (m.putOI / m.callOI) : 0;
    }

    if (contracts.length === 0) {
      throw new Error("Options chain returned 0 contracts. Market may be closed or token invalid.");
    }

    // NQ futures price — try Tradier futures symbols
    // Note: Tradier may not carry NQ futures. If unavailable, mult will be
    // calculated from the last known good value or manual override.
    let nqPrice = null;
    for (const sym of ["/NQ", "NQ", "NQM25", "NQU25"]) {
      try {
        const d = await fetchJSON(`${BASE}/markets/quotes?symbols=${encodeURIComponent(sym)}&greeks=false`);
        const p = d?.quotes?.quote?.last ?? null;
        if (p && p > 1000) { nqPrice = p; break; }
      } catch (_) {}
    }

    // Do NOT use NDX as NQ proxy — NDX is the cash index, NQ futures trade at a premium
    // If nqPrice is null, frontend will use its last known multiplier

    // Calculate mult only if we have a real NQ futures price
    const mult = (nqPrice && nqPrice > 1000 && spot) ? nqPrice / spot : null;

    const responseData = {
      spot,
      nqPrice,
      mult,
      contracts,
      expirations: allExps.slice(0, 8),
      debug: {
        contractCount: contracts.length,
        expsLoaded: expsToFetch,
        hasGreeks: contracts[0]?.greeks?.gamma != null,
        sampleStrike: contracts[0]?.details?.strike_price ?? null,
        spotQQQ: spot,
        nqFutures: nqPrice,
        mult,
      }
    };

    // Cache for next requests from other indicator instances
    setCache(cacheKey, responseData);
    res.status(200).json(responseData);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
