const { isValidId, clientIp, checkRateLimit } = require("../_lib/capsule");
const { getKv, isKvConfigured } = require("../_lib/kv");
const { manageCapsule } = require("../_lib/store");
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!isKvConfigured()) return res.status(503).json({ error: "Storage is not configured." });
  if (!await checkRateLimit(getKv(), clientIp(req), "capsule-owner")) return res.status(429).json({ error: "Too many requests. Try later." });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!isValidId(body?.id)) return res.status(400).json({ error: "Invalid capsule id." });
    if (!["status", "revoke", "delete"].includes(body.action)) return res.status(400).json({ error: "Invalid action." });
    return res.status(200).json(await manageCapsule(body.id, (req.headers.authorization || "").replace(/^Bearer /, ""), body.action));
  } catch (error) { return res.status(error.status || 503).json({ error: error.status ? error.message : "Owner operation failed. Retry shortly." }); }
};
