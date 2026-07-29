const { getKv, isKvConfigured } = require("../_lib/kv");
const { cleanupExpiredBlobs, isBlobConfigured } = require("../_lib/store");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: "CRON_SECRET is not configured." });
  }
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!isKvConfigured() || !isBlobConfigured()) {
    return res.status(503).json({ error: "Capsule storage is not configured." });
  }

  try {
    const deleted = await cleanupExpiredBlobs(getKv(), 1000, true);
    return res.status(200).json({ deleted });
  } catch {
    return res.status(503).json({ error: "Blob cleanup failed." });
  }
};
