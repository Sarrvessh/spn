const { configured: authConfigured } = require("./_lib/account");
const { isKvConfigured } = require("./_lib/kv");
const db = require("./_lib/transfer-db");
const storage = require("./_lib/transfer-storage");
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Use GET." });
  const accounts = authConfigured() && isKvConfigured();
  const transfers = accounts && process.env.TRANSFERS_ENABLED === "true" && db.configured() && storage.configured();
  return res.status(200).json({ status: "ok", readiness: transfers ? "configured" : "incomplete", services: { accounts, transfers }, checked: "configuration" });
};
