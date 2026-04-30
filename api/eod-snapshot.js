// api/eod-snapshot.js
// Called by Vercel Cron at 4:05 PM ET (21:05 UTC) on weekdays
// Calculates OI-based gamma walls and saves them to KV store

const TRADIER_TOKEN = process.env.TRADIER_API_KEY || "SJ5hgXkjhlB1ZCllayTT64iAU44o";
const BASE = "https://api.tradier.com/v1";
const HEADERS = {
  "Authorization": `Bearer ${TRADIER_TOKEN}`,
  "Accept": "application/json",
};

async function fetchJSON(url) {
  const res = await fetch(url, { headers: HEADERS });
  const text = await res.text();
  if (!res.ok) throw new Error(`Tradier ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function computeLevels(spot, contracts) {
  const map = {};

  for (const c of contracts) {
    const strike = c.details?.strike_price;
    const type = c.details?.contract_type;
    const gamma = c.greeks?.gamma;
    const delta = c.greeks?.delta;
    const oi = c.open_interest || 0;

    if (!strike || !type || !oi) continue;
    if (!map[strike]) map[strike] = {
      strike,
      callOI: 0, putOI: 0,
      callGex: 0, putGex: 0,
      callDex: 0, putDex: 0,
    };

    if (type === "call") { map[strike].callOI += oi; }
    else { map[strike].putOI += oi; }

    if (gamma && oi) {
      const g = gamma * oi * 100 * spot * spot / 100;
      if (type === "call") map[strike].callGex += g;
      else map[strike].putGex -= g;
    }
    if (delta != null && oi) {
      const d = delta * oi * 100;
      if (type === "call") map[strike].callDex += d;
      else map[strike].putDex += d;
    }
  }

  const rows = Object.values(map)
    .filter(s => s.strike >= spot * 0.85 && s.strike <= spot * 1.15)
    .sort((a, b) => a.strike - b.strike)
    .map(s => ({
      strike: s.strike,
      callOI: s.callOI, putOI: s.putOI,
      netGex: s.callGex + s.putGex,
      netDex: s.callDex + s.putDex,
    }));

  // Gamma flip
  const ai = rows.reduce((b, s, i) =>
    Math.abs(s.strike - spot) < Math.abs(rows[b].strike - spot) ? i : b, 0);
  let flip = null, cum = 0;
  for (let i = ai; i < rows.length; i++) {
    cum += rows[i].netGex;
    if (i > ai && Math.sign(cum) !== Math.sign(rows[ai].netGex)) {
      flip = (rows[i - 1].strike + rows[i].strike) / 2; break;
    }
  }
  if (!flip) {
    cum = 0;
    for (let i = ai; i >= 0; i--) {
      cum += rows[i].netGex;
      if (i < ai && Math.sign(cum) !== Math.sign(rows[ai].netGex)) {
        flip = (rows[i].strike + rows[i + 1].strike) / 2; break;
      }
    }
  }

  // Key walls by OI
  const callOIWall = [...rows].sort((a, b) => b.callOI - a.callOI)[0];
  const putOIWall  = [...rows].sort((a, b) => b.putOI  - a.putOI)[0];

  // Top 10 positive and negative GEX strikes
  const sorted = [...rows].sort((a, b) => b.netGex - a.netGex);
  const topPositive = sorted.slice(0, 10).filter(s => s.netGex > 0);
  const topNegative = [...sorted].reverse().slice(0, 10).filter(s => s.netGex < 0);

  // Total GEX
  const totalGex = rows.reduce((s, c) => s + c.netGex, 0);

  return {
    spot,
    flip,
    totalGex,
    regime: spot < (flip || 0) ? "NEGATIVE" : (totalGex < 0 ? "NEGATIVE" : "POSITIVE"),
    callOIWall: callOIWall?.strike ?? null,
    putOIWall:  putOIWall?.strike  ?? null,
    topPositive,
    topNegative,
    allStrikes: rows,
    capturedAt: new Date().toISOString(),
    tradingDate: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  // Allow manual trigger via GET, cron via GET as well
  try {
    // Fetch spot
    const quoteData = await fetchJSON(`${BASE}/markets/quotes?symbols=QQQ&greeks=false`);
    const spot = quoteData?.quotes?.quote?.last ?? null;
    if (!spot) throw new Error("No QQQ spot price");

    // NQ price
    let nqPrice = null;
    for (const sym of ["NQM25", "NQU25", "NQZ25"]) {
      try {
        const d = await fetchJSON(`${BASE}/markets/quotes?symbols=${sym}&greeks=false`);
        const p = d?.quotes?.quote?.last ?? null;
        if (p && p > 1000) { nqPrice = p; break; }
      } catch (_) {}
    }
    const mult = nqPrice ? nqPrice / spot : 40.5;

    // Fetch expirations
    const expData = await fetchJSON(
      `${BASE}/markets/options/expirations?symbol=QQQ&includeAllRoots=false&strikes=false`
    );
    const allExps = expData?.expirations?.date || [];
    if (!allExps.length) throw new Error("No expirations");

    // Fetch nearest 4 chains in parallel
    const chains = await Promise.all(
      allExps.slice(0, 4).map(e =>
        fetchJSON(`${BASE}/markets/options/chains?symbol=QQQ&expiration=${e}&greeks=true`)
          .then(d => ({ exp: e, options: d?.options?.option || [] }))
          .catch(() => ({ exp: e, options: [] }))
      )
    );

    // Flatten
    const contracts = [];
    for (const chain of chains) {
      for (const opt of chain.options) {
        contracts.push({
          details: {
            strike_price: opt.strike,
            contract_type: opt.option_type === "call" ? "call" : "put",
            expiration_date: chain.exp,
          },
          greeks: {
            delta: opt.greeks?.delta ?? null,
            gamma: opt.greeks?.gamma ?? null,
          },
          open_interest: opt.open_interest ?? 0,
          day: { volume: opt.volume ?? 0 },
        });
      }
    }

    if (!contracts.length) throw new Error("No contracts returned");

    // Compute levels
    const levels = computeLevels(spot, contracts);
    levels.nqPrice = nqPrice;
    levels.mult = mult;

    // Add NQ equivalents to key levels
    levels.callOIWallNQ = levels.callOIWall ? Math.round(levels.callOIWall * mult) : null;
    levels.putOIWallNQ  = levels.putOIWall  ? Math.round(levels.putOIWall  * mult) : null;
    levels.flipNQ       = levels.flip       ? Math.round(levels.flip       * mult) : null;

    // Add NQ to all strikes
    levels.allStrikes = levels.allStrikes.map(s => ({
      ...s, nq: Math.round(s.strike * mult)
    }));
    levels.topPositive = levels.topPositive.map(s => ({
      ...s, nq: Math.round(s.strike * mult)
    }));
    levels.topNegative = levels.topNegative.map(s => ({
      ...s, nq: Math.round(s.strike * mult)
    }));

    // Store in Vercel KV if available, otherwise return directly
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      await fetch(`${process.env.KV_REST_API_URL}/set/eod_snapshot`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.KV_REST_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: JSON.stringify(levels) }),
      });
    }

    res.status(200).json({
      success: true,
      message: `EOD snapshot captured at ${levels.capturedAt}`,
      levels,
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
