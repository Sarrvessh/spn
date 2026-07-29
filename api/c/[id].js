const { isValidId } = require("../_lib/capsule");
const { getKv, isKvConfigured } = require("../_lib/kv");
const { loadCapsule } = require("../_lib/store");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET,POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isKvConfigured()) {
    return res.status(503).json({ error: "KV storage is not configured." });
  }

  const id = req.query.id;
  if (!isValidId(id)) {
    return res.status(400).json({ error: "Invalid capsule id." });
  }

  try {
    const envelope = await loadCapsule(id, { consumeBurn: req.method === "POST" });
    if (!envelope) {
      return res.status(404).json({ error: "Capsule not found or expired." });
    }
    return res.status(200).json({ envelope });
  } catch (error) {
    if (error.code === "BURN_REQUIRES_CONSUME") {
      return res.status(error.status || 409).json({ error: error.message });
    }
    if (error.code?.startsWith("BLOB_")) {
      return res.status(error.status || 503).json({ error: error.message });
    }
    return res.status(503).json({ error: "Capsule storage is temporarily unavailable." });
  }
};
