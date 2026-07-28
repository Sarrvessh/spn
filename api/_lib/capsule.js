const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 8;
const MAX_BLOB_BYTES = 256 * 1024;
const DEFAULT_TTL_SEC = 30 * 24 * 60 * 60;
const MIN_TTL_SEC = 60;
const MAX_TTL_SEC = 30 * 24 * 60 * 60;
const RATE_LIMIT_POST = 20;

function randomId() {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  let id = "";
  for (let i = 0; i < ID_LENGTH; i += 1) {
    id += BASE62[bytes[i] % BASE62.length];
  }
  return id;
}

function isValidId(id) {
  return typeof id === "string" && new RegExp(`^[A-Za-z0-9]{${ID_LENGTH}}$`).test(id);
}

function ttlFromEnvelope(envelope) {
  if (envelope?.expiresAt) {
    const seconds = Math.floor((new Date(envelope.expiresAt).getTime() - Date.now()) / 1000);
    if (seconds <= 0) return MIN_TTL_SEC;
    return Math.min(Math.max(seconds, MIN_TTL_SEC), MAX_TTL_SEC);
  }
  return DEFAULT_TTL_SEC;
}

function envelopeByteSize(envelope) {
  return new TextEncoder().encode(JSON.stringify(envelope)).length;
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

async function checkRateLimit(kv, ip) {
  const key = `rate:${ip}`;
  const count = (await kv.get(key)) || 0;
  if (count >= RATE_LIMIT_POST) {
    return false;
  }
  await kv.set(key, count + 1, { ex: 3600 });
  return true;
}

module.exports = {
  BASE62,
  ID_LENGTH,
  MAX_BLOB_BYTES,
  randomId,
  isValidId,
  ttlFromEnvelope,
  envelopeByteSize,
  clientIp,
  checkRateLimit,
};
