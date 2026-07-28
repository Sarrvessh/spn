const { kv } = require("@vercel/kv");
const {
  randomId,
  isValidId,
  ttlFromEnvelope,
  envelopeByteSize,
  clientIp,
  checkRateLimit,
  MAX_BLOB_BYTES,
} = require("../_lib/capsule");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return res.status(503).json({ error: "KV storage is not configured." });
  }

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
  if (size > MAX_BLOB_BYTES) {
    return res.status(413).json({ error: "Capsule exceeds 256 KB limit." });
  }

  const ip = clientIp(req);
  if (!(await checkRateLimit(kv, ip))) {
    return res.status(429).json({ error: "Too many uploads. Try again later." });
  }

  const ttl = ttlFromEnvelope(envelope);
  const burnAfterRead = Array.isArray(envelope.guards) && envelope.guards.includes("burn-after-read");
  const record = { envelope, burnAfterRead };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = randomId();
    const existing = await kv.get(`capsule:${id}`);
    if (existing) continue;

    await kv.set(`capsule:${id}`, record, { ex: ttl });
    return res.status(201).json({ id });
  }

  return res.status(500).json({ error: "Could not allocate a short id." });
};
