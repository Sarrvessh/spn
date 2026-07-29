const crypto = require("crypto");
const { clientIp, checkRateLimit, envelopeByteSize, MAX_FILE_BYTES } = require("../_lib/capsule");
const { getKv, isKvConfigured } = require("../_lib/kv");
const { normalizeCreation, collectionTtl } = require("../_lib/collection");

function randomToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("base64url");
}

function audit(type, extra = {}) {
  return { type, at: Date.now(), ...extra };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!isKvConfigured()) return res.status(503).json({ error: "KV storage is not configured." });

  const kv = getKv();
  if (!(await checkRateLimit(kv, clientIp(req), "collection-create"))) return res.status(429).json({ error: "Too many uploads. Try again later." });

  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : req.body; } catch { return res.status(400).json({ error: "Invalid JSON body." }); }

  const kind = body?.kind;
  const encryptedTemplate = body?.encryptedTemplate;
  if (!["request", "form"].includes(kind)) return res.status(400).json({ error: "Invalid collection type." });
  if (!encryptedTemplate?.ciphertext || !encryptedTemplate?.iv) return res.status(400).json({ error: "Invalid encrypted template." });
  if (envelopeByteSize(encryptedTemplate) > MAX_FILE_BYTES) return res.status(413).json({ error: "Encrypted template exceeds storage limits." });

  const token = randomToken();
  const ownerToken = randomToken();
  const tokenHash = hashToken(token);
  const ownerHash = hashToken(ownerToken);
  const publicMeta = body.publicMeta || {};
  const publicPolicy = body.publicPolicy || {};
  const retention = body.retention || {};
  const now = Date.now();
  let normalized;
  try {
    normalized = normalizeCreation(body, now);
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  const record = {
    version: 1,
    kind,
    tokenHash,
    ownerHash,
    status: "active",
    encryptedTemplate,
    publicMeta: {
      kind,
      openAt: normalized.openAt,
      expiresAt: normalized.expiresAt,
      createdAt: now,
      maxRetentionAt: new Date(normalized.storageExpiresAt).toISOString(),
    },
    publicPolicy: {
      oneTime: Boolean(publicPolicy.oneTime),
      autoClose: Boolean(publicPolicy.autoClose),
      maxSubmissions: normalized.maxSubmissions,
      requirePassword: Boolean(publicPolicy.requirePassword),
      requireOtp: Boolean(publicPolicy.requireOtp),
      requireConsent: Boolean(publicPolicy.requireConsent),
      allowedEmailHash: publicPolicy.allowedEmailHash || "",
      accessPasswordHash: publicPolicy.accessPasswordHash || "",
      otpHash: publicPolicy.otpHash || "",
    },
    retention: {
      mode: normalized.retentionMode,
      burnAfterView: normalized.retentionMode === "view" || Boolean(retention.burnAfterView),
      burnAfterExport: normalized.retentionMode === "export" || Boolean(retention.burnAfterExport),
    },
    submissions: [],
    audit: [audit("collection_created")],
    storageExpiresAt: normalized.storageExpiresAt,
  };

  await kv.set(`collection:${tokenHash}`, record, { ex: collectionTtl(record, now) });
  return res.status(201).json({ token, ownerToken });
};