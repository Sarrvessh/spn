const { isValidId } = require("../_lib/capsule");
const { getKv, isKvConfigured } = require("../_lib/kv");
const { loadCapsule } = require("../_lib/store");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isKvConfigured()) {
    return res.status(503).json({ error: "KV storage is not configured." });
  }

  const id = req.query.id;
  if (!isValidId(id)) {
    return res.status(400).json({ error: "Invalid capsule id." });
  }

  const envelope = await loadCapsule(id);
  if (!envelope) {
    return res.status(404).json({ error: "Capsule not found or expired." });
  }

  return res.status(200).json({ envelope });
};
