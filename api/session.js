// api/session.js
// Saves and retrieves full session timeline data via Upstash Redis
// Uses GU_ prefix env vars set up by Upstash integration

const KV_URL   = process.env.GU_KV_REST_API_URL;
const KV_TOKEN = process.env.GU_KV_REST_API_TOKEN;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const res = await fetch(`${KV_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.result ? JSON.parse(data.result) : null;
}

async function kvSet(key, value, exSeconds = 86400) {
  if (!KV_URL || !KV_TOKEN) return false;
  const res = await fetch(`${KV_URL}/set/${key}?ex=${exSeconds}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ value: JSON.stringify(value) })
  });
  return res.ok;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST");
  res.setHeader("Cache-Control", "no-store");

  // GET — load session data
  if (req.method === "GET") {
    try {
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const session = await kvGet(`session_${today}`);
      return res.status(200).json({ session: session || null, date: today });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST — append a snapshot to today's session
  if (req.method === "POST") {
    try {
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const key   = `session_${today}`;
      const snap  = req.body;

      // Load existing session
      let session = await kvGet(key) || { date: today, snapshots: [] };

      // Append new snapshot (keep full session — no limit)
      session.snapshots.push(snap);

      // Save back — expire after 7 days
      await kvSet(key, session, 604800);

      return res.status(200).json({ ok: true, count: session.snapshots.length });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
}
