const { isValidId, envelopeByteSize, MAX_FILE_BYTES } = require("../_lib/capsule");
const { isKvConfigured } = require("../_lib/kv");
const { completeCapsule, completeUploadedCapsule } = require("../_lib/store");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!isKvConfigured()) {
    return res.status(503).json({ error: "KV storage is not configured." });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: "Invalid JSON body." });
  }

  const id = body?.id;
  const envelope = body?.envelope;
  const uploadedBlob = body?.blob;
  if (!isValidId(id)) return res.status(400).json({ error: "Invalid capsule id." });
  if (uploadedBlob) {
    try {
      const saved = await completeUploadedCapsule(id, uploadedBlob);
      return res.status(201).json(saved);
    } catch (error) {
      if (error.code === "PENDING_NOT_FOUND") return res.status(404).json({ error: error.message });
      if (error.code === "UPLOAD_MISMATCH") return res.status(400).json({ error: error.message });
      return res.status(error.status || 500).json({ error: error.message || "Could not complete uploaded capsule." });
    }
  }
  if (!envelope?.ciphertext || !envelope?.iv) {
    return res.status(400).json({ error: "Invalid encrypted envelope." });
  }
  if (envelope.expiresAt) {
    const expiry = new Date(envelope.expiresAt).getTime();
    if (!Number.isFinite(expiry)) return res.status(400).json({ error: "Invalid capsule expiry." });
    if (expiry <= Date.now()) return res.status(400).json({ error: "Capsule expiry must be in the future." });
  }
  if (envelopeByteSize(envelope) > MAX_FILE_BYTES) {
    return res.status(413).json({ error: "Capsule exceeds the 4.5 MB Vercel request limit." });
  }

  try {
    const saved = await completeCapsule(id, envelope);
    return res.status(201).json(saved);
  } catch (error) {
    if (error.code === "PENDING_NOT_FOUND") return res.status(404).json({ error: error.message });
    if (error.code === "TOO_LARGE") return res.status(413).json({ error: error.message });
    return res.status(500).json({ error: error.message || "Could not complete capsule." });
  }
};
