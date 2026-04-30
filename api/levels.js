// api/levels.js
// Returns the last saved EOD snapshot
// Falls back to computing live if no snapshot exists

const TRADIER_TOKEN = process.env.TRADIER_API_KEY || "SJ5hgXkjhlB1ZCllayTT64iAU44o";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  try {
    // Try KV store first
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      const kvRes = await fetch(`${process.env.KV_REST_API_URL}/get/eod_snapshot`, {
        headers: { "Authorization": `Bearer ${process.env.KV_REST_API_TOKEN}` },
      });
      if (kvRes.ok) {
        const kvData = await kvRes.json();
        if (kvData?.result) {
          const snapshot = JSON.parse(kvData.result);
          return res.status(200).json({ source: "eod_snapshot", ...snapshot });
        }
      }
    }

    // No KV — return empty so frontend knows to use live data only
    res.status(200).json({ source: "none", message: "No EOD snapshot available yet. Run /api/eod-snapshot to capture." });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
