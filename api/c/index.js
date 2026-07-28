const { envelopeByteSize, clientIp, checkRateLimit, MAX_FILE_BYTES } = require("../_lib/capsule");
const { getKv, isKvConfigured } = require("../_lib/kv");
const { saveCapsule } = require("../_lib/store");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isKvConfigured()) {
    return res.status(503).json({ error: "KV storage is not configured." });
  }

  const kv = getKv();

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: "Invalid JSON body." });
  }

  const envelope = body?.envelope;
  if (!envelope?.ciphertext || !envelope?.iv) {
    return res.status(400).json({ error: "Invalid encrypted envelope." });
  }

  const size = envelopeByteSize(envelope);
  if (size > MAX_FILE_BYTES) {
    return res.status(413).json({ error: "Capsule exceeds 5 MB limit." });
  }

  const ip = clientIp(req);
  if (!(await checkRateLimit(kv, ip))) {
    return res.status(429).json({ error: "Too many uploads. Try again later." });
  }

  try {
    const saved = await saveCapsule(envelope);
    return res.status(201).json(saved);
  } catch (error) {
    if (error.code === "BLOB_REQUIRED") {
      return res.status(413).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message || "Could not store capsule." });
  }
};
