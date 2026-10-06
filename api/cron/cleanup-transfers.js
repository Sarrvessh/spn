const db = require("../_lib/transfer-db");
const { storage, configured } = require("../_lib/transfer-storage");
const { deliver } = require("../_lib/transfer-notifications");
const { getKv } = require("../_lib/kv");
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Use GET." });
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized." });
  if (!db.configured() || !configured()) return res.status(503).json({ error: "Transfer cleanup is not configured." });
  let deleted = 0, failed = 0;
  try {
    const batch = await db.rpc("cleanup", null);
    for (const id of batch.ids) {
      try { await storage().remove(id); await db.rpc("purged", null, { id }); deleted++; }
      catch { failed++; }
    }
    const notifications = await deliver();
    let erased = 0;
    const erasures = await db.accountRpc("claim", null);
    for (const userId of erasures.users) {
      try {
        await db.accountRpc("prepare", userId);
        if (!getKv()) throw new Error("Account cleanup requires Redis.");
        await getKv().del(`workspace:${userId}`);
        const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method:"DELETE", signal:AbortSignal.timeout(15000), headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`} });
        if (!response.ok && response.status !== 404) throw new Error("Identity cleanup failed.");
        erased++;
      } catch { failed++; }
    }
    return res.status(failed || notifications.failed ? 503 : 200).json({ deleted, erased, failed, notifications });
  } catch { return res.status(503).json({ error: "Cleanup must be retried." }); }
};
