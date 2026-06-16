const TRADIER_TOKEN = process.env.TRADIER_API_KEY || "SJ5hgXkjhlB1ZCllayTT64iAU44o";
const BASE = "https://api.tradier.com/v1";
const CACHE_TTL = 3000; // 3 seconds — matches Vercel Pro refresh interval

const HEADERS = {
  "Authorization": `Bearer ${TRADIER_TOKEN}`,
  "Accept": "application/json",
};

// In-memory cache — shared across all requests on same Vercel instance
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

// Futures metadata per underlying ETF
// futuresSymbols: ordered list to try for live futures price
// multApprox: fallback multiplier if futures price unavailable
// futuresLabel: display label (e.g. "NQ/MNQ", "ES/MES")
const TICKER_META = {
  QQQ: { futuresSymbols: ["/NQ", "NQ", "NQM25", "NQU25", "NQZ25"], multApprox: 40.5, futuresLabel: "NQ/MNQ" },
  SPY: { futuresSymbols: ["/ES", "ES", "ESM25", "ESU25", "ESZ25"], multApprox: 10.0, futuresLabel: "ES/MES" },
  IWM: { futuresSymbols: ["/RTY", "RTY", "RTYM25", "RTYU25", "RTYZ25"], multApprox: 10.0, futuresLabel: "RTY/M2K" },
};

// For equity tickers (NVDA, MSFT, etc.) — no futures conversion, mult = 1
function getTickerMeta(symbol) {
  const upper = symbol.toUpperCase();
  return TICKER_META[upper] || { futuresSymbols: [], multApprox: 1.0, futuresLabel: null };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "no-store");

  try {
    // symbol defaults to QQQ for backward compatibility
    const symbol = (req.query.symbol || "QQQ").toUpperCase();
    const { exp } = req.query;
    const cacheKey = `options_${symbol}_${exp || "all"}`;

    const cached = getCached(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json(cached);
    }
    res.setHeader("X-Cache", "MISS");

    const meta = getTickerMeta(symbol);

    // Spot price for the requested ETF/equity
    const quoteData = await fetchJSON(`${BASE}/markets/quotes?symbols=${symbol}&greeks=false`);
    const spot = quoteData?.quotes?.quote?.last ?? null;
    if (!spot) throw new Error(`No spot price for ${symbol} — check token or market hours`);

    // Expirations
    const expData = await fetchJSON(
      `${BASE}/markets/options/expirations?symbol=${symbol}&includeAllRoots=false&strikes=false`
    );
    const allExps = expData?.expirations?.date || [];
    if (!allExps.length) throw new Error(`No expirations returned for ${symbol}`);

    // Fetch nearest 4 expirations or a specific one
    const expsToFetch = (exp && exp !== "all") ? [exp] : allExps.slice(0, 4);

    const chainPromises = expsToFetch.map(e =>
      fetchJSON(`${BASE}/markets/options/chains?symbol=${symbol}&expiration=${e}&greeks=true`)
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

    // Per-strike OI map for PCR
    const strikeOIMap = {};
    for (const c of contracts) {
      const strike = c.details.strike_price;
      const type   = c.details.contract_type;
      const oi     = c.open_interest || 0;
      if (!strikeOIMap[strike]) strikeOIMap[strike] = { callOI: 0, putOI: 0 };
      if (type === "call") strikeOIMap[strike].callOI += oi;
      else strikeOIMap[strike].putOI += oi;
    }
    for (const c of contracts) {
      const m = strikeOIMap[c.details.strike_price];
      c.details.callOI = m?.callOI ?? 0;
      c.details.putOI  = m?.putOI  ?? 0;
      c.details.pcr    = m?.callOI > 0 ? (m.putOI / m.callOI) : 0;
    }

    if (contracts.length === 0) {
      throw new Error(`Options chain returned 0 contracts for ${symbol}. Market may be closed or token invalid.`);
    }

    // Futures price — only attempted for known ETF underlyings
    let futuresPrice = null;
    if (meta.futuresSymbols.length > 0) {
      for (const sym of meta.futuresSymbols) {
        try {
          const d = await fetchJSON(`${BASE}/markets/quotes?symbols=${encodeURIComponent(sym)}&greeks=false`);
          const p = d?.quotes?.quote?.last ?? null;
          if (p && p > 100) { futuresPrice = p; break; }
        } catch (_) {}
      }
    }

    // Multiplier logic:
    // - If we got a live futures price, use it
    // - If equity (mult=1), just return 1
    // - Otherwise fall back to approx
    let mult = null;
    if (meta.multApprox === 1.0) {
      // Direct equity — no conversion
      mult = 1.0;
    } else if (futuresPrice && futuresPrice > 100 && spot) {
      mult = futuresPrice / spot;
    } else {
      // No live futures — return null so frontend preserves its last known value
      mult = null;
    }

    const responseData = {
      symbol,
      spot,
      futuresPrice,
      mult,
      futuresLabel: meta.futuresLabel,  // "NQ/MNQ", "ES/MES", "RTY/M2K", or null for equities
      contracts,
      expirations: allExps.slice(0, 8),
      debug: {
        symbol,
        contractCount: contracts.length,
        expsLoaded: expsToFetch,
        hasGreeks: contracts[0]?.greeks?.gamma != null,
        sampleStrike: contracts[0]?.details?.strike_price ?? null,
        spotPrice: spot,
        futuresPrice,
        mult,
        futuresLabel: meta.futuresLabel,
      }
    };

    setCache(cacheKey, responseData);
    res.status(200).json(responseData);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
