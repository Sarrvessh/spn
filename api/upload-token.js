const { handleUpload } = require("@vercel/blob/client");
const { isValidId } = require("./_lib/capsule");
const { isKvConfigured } = require("./_lib/kv");
const { isBlobConfigured, registerPendingBlob } = require("./_lib/store");

const MAX_DIRECT_UPLOAD_BYTES = 100 * 1024 * 1024;
const ALLOWED_ENCRYPTED_TYPES = [
  "application/octet-stream",
  "application/json",
  "text/plain",
];

function parsePayload(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!isKvConfigured()) return res.status(503).json({ error: "KV storage is not configured." });
  if (!isBlobConfigured()) return res.status(503).json({ error: "Blob storage is not configured." });

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: "Invalid JSON body." });
  }

  try {
    const result = await handleUpload({
      request: req,
      body,
      async onBeforeGenerateToken(pathname, clientPayload) {
        const payload = parsePayload(clientPayload);
        const id = payload.id;
        if (!isValidId(id)) throw new Error("Invalid capsule id.");
        const prefix = `capsules/uploads/${id}/`;
        if (!pathname.startsWith(prefix)) {
          throw new Error("Upload path does not match this capsule.");
        }
        return {
          allowedContentTypes: ALLOWED_ENCRYPTED_TYPES,
          maximumSizeInBytes: MAX_DIRECT_UPLOAD_BYTES,
          validUntil: Date.now() + 15 * 60 * 1000,
          addRandomSuffix: false,
          allowOverwrite: false,
          tokenPayload: JSON.stringify({ id }),
        };
      },
      async onUploadCompleted({ blob, tokenPayload }) {
        const payload = parsePayload(tokenPayload);
        if (isValidId(payload.id)) await registerPendingBlob(payload.id, blob);
      },
    });
    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message || "Could not prepare upload." });
  }
};
