const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const crypto = require("crypto");
const ID_LENGTH = 8;
const MAX_BLOB_BYTES = 256 * 1024;
// Vercel Functions reject request bodies at roughly 4.5 MB, including JSON overhead.
const MAX_FILE_BYTES = Math.floor(4.4 * 1024 * 1024);
const DEFAULT_TTL_SEC = 30 * 24 * 60 * 60;
const MIN_TTL_SEC = 60;
const MAX_TTL_SEC = 30 * 24 * 60 * 60;
const RATE_LIMIT_POST = 20;
const RATE_LIMIT_SCRIPT =
  "local n=redis.call('incr',KEYS[1]); if n==1 then redis.call('expire',KEYS[1],ARGV[1]); end; return n";

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

async function checkRateLimit(kv, ip, context = "default") {
  const namespace = String(context).replace(/[^a-z0-9:_-]/gi, "_").slice(0, 64);
  const subject = crypto.createHash("sha256").update(String(ip)).digest("base64url").slice(0, 24);
  const key = `rate:v1:${namespace}:${subject}`;
  const count = Number(await kv.eval(RATE_LIMIT_SCRIPT, [key], ["3600"]));
  return Number.isFinite(count) && count <= RATE_LIMIT_POST;
}

module.exports = {
  BASE62,
  ID_LENGTH,
  MAX_BLOB_BYTES,
  MAX_FILE_BYTES,
  randomId,
  isValidId,
  ttlFromEnvelope,
  envelopeByteSize,
  clientIp,
  checkRateLimit,
};
