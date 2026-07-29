const { clientIp, checkRateLimit } = require("../_lib/capsule");
const { getKv, isKvConfigured } = require("../_lib/kv");
const { initCapsule, isBlobConfigured } = require("../_lib/store");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!isKvConfigured()) {
    return res.status(503).json({ error: "KV storage is not configured." });
  }

  const kv = getKv();
  if (!(await checkRateLimit(kv, clientIp(req), "capsule-init"))) {
    return res.status(429).json({ error: "Too many uploads. Try again later." });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    return res.status(400).json({ error: "Invalid JSON body." });
  }

  const kind = typeof body.kind === "string" ? body.kind.slice(0, 48) : "capsule";
  if (body.expiresAt) {
    const expiry = new Date(body.expiresAt).getTime();
    if (!Number.isFinite(expiry)) return res.status(400).json({ error: "Invalid capsule expiry." });
    if (expiry <= Date.now()) return res.status(400).json({ error: "Capsule expiry must be in the future." });
  }

  try {
    const pending = await initCapsule({ kind, expiresAt: body.expiresAt || null });
    return res.status(201).json({
      ...pending,
      upload: {
        directBlob: isBlobConfigured(),
        maxDirectUploadBytes: 100 * 1024 * 1024,
        tokenEndpoint: "/api/upload-token",
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not initialize capsule." });
  }
};
