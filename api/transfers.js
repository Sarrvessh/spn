const crypto = require("crypto");
const db = require("./_lib/transfer-db");
const objects = require("./_lib/transfer-storage");
const { user, configured: authConfigured } = require("./_lib/account");
const { getKv, isKvConfigured } = require("./_lib/kv");
const { clientIp } = require("./_lib/capsule");
const available = () => process.env.TRANSFERS_ENABLED === "true" && db.configured() && objects.configured() && authConfigured() && isKvConfigured();
const digest = (value) => crypto.createHash("sha256").update(value).digest("base64url");
const bad = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
const uuid = (value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value || "");
const secret = (value) => /^[A-Za-z0-9_-]{43}$/.test(value || "");
function encrypted(value, max = 350000) {
  if (!value || !/^[A-Za-z0-9_-]{16}$/.test(value.iv || "") || typeof value.data !== "string" || value.data.length < 22 || value.data.length > max || !/^[A-Za-z0-9_-]+$/.test(value.data)) bad("Invalid encrypted data.");
}
function validate(action, body) {
  const input = {};
  if (!["list", "profile", "profile-save", "discover"].includes(action)) {
    if (!uuid(body.id)) bad("Invalid transfer identifier."); input.id = body.id;
  }
  if (["part", "confirm", "download"].includes(action)) {
    if (!Number.isInteger(body.index) || body.index < 0 || body.index > 660) bad("Invalid chunk."); input.index = body.index;
  }
  if (action === "part") {
    if (!Number.isInteger(body.size) || body.size < 16 || body.size > 8388624 || !secret(body.checksum)) bad("Invalid chunk dimensions.");
    Object.assign(input, { size: body.size, checksum: body.checksum });
  }
  if (action === "create") {
    if (!Number.isSafeInteger(body.bytes) || body.bytes < 0 || body.bytes > 5e9 || !Array.isArray(body.sizes) || body.sizes.length < 1 || body.sizes.length > 661 || body.sizes.some((n) => !Number.isInteger(n) || n < 0 || n > 8388608) || body.sizes.reduce((a,b) => a+b,0) !== body.bytes) bad("The maximum capsule size is 5 GB.");
    if (!["link", "direct"].includes(body.mode) || !Array.isArray(body.grants) || body.grants.length > 17 || typeof body.burn !== "boolean") bad("Invalid delivery options.");
    const expiry = Date.parse(body.expires), unlock = body.unlock ? Date.parse(body.unlock) : null;
    if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 30 * 864e5 || (unlock !== null && (!Number.isFinite(unlock) || unlock >= expiry))) bad("Invalid expiry or scheduled unlock.");
    const ids = new Set();
    const grants = body.grants.map((g) => {
      if (!uuid(g.userId) || ids.has(g.userId) || g.keyVersion !== 1 || !/^[A-Za-z0-9_-]{512}$/.test(g.wrappedKey || "")) bad("Invalid recipient grant.");
      ids.add(g.userId); return { userId: g.userId, keyVersion: 1, wrappedKey: g.wrappedKey };
    });
    if (body.mode === "link" && !secret(body.access)) bad("Missing link capability.");
    if (body.passwordBox) {
      encrypted(body.passwordBox, 1024);
      if (body.mode !== "link" || !/^[A-Za-z0-9_-]{22}$/.test(body.passwordBox.salt || "")) bad("Invalid password protection.");
    }
    Object.assign(input, { bytes: body.bytes, sizes: body.sizes, mode: body.mode, grants, burn: body.burn, expires: new Date(expiry).toISOString(), unlock: unlock === null ? null : new Date(unlock).toISOString(), accessHash: body.mode === "link" ? digest(body.access) : null, passwordBox: body.passwordBox || null });
  }
  if (action === "finalize") { encrypted(body.manifest); input.manifest = { iv: body.manifest.iv, data: body.manifest.data }; }
  if (["open", "claim"].includes(action) && body.access) { if (!secret(body.access)) bad("Invalid access capability."); input.accessHash = digest(body.access); }
  if (["claim", "download", "finish"].includes(action)) { if (!secret(body.lease)) bad("Invalid download lease."); input.leaseHash = digest(body.lease); }
  if (action === "profile-save") {
    if (!/^[a-z][a-z0-9_]{2,29}$/.test(body.handle || "") || typeof body.displayName !== "string" || !body.displayName.trim() || body.displayName.length > 80 || typeof body.discoverable !== "boolean") bad("Choose a valid handle and display name.");
    if (body.publicKey) {
      const jwk = body.publicKey;
      if (jwk.kty !== "RSA" || jwk.d || jwk.alg !== "RSA-OAEP-256" || jwk.e !== "AQAB" || !/^[A-Za-z0-9_-]{512}$/.test(jwk.n || "")) bad("Invalid recipient public key.");
      encrypted(body.privateKey, 12000);
      if (!/^[A-Za-z0-9_-]{22}$/.test(body.privateKey.salt || "")) bad("Invalid private-key protection.");
    }
    Object.assign(input, { handle: body.handle, displayName: body.displayName.trim(), discoverable: body.discoverable, emailNotifications: body.emailNotifications === true, publicKey: body.publicKey, privateKey: body.privateKey });
  }
  if (action === "discover") { if (!/^[a-z][a-z0-9_]{2,29}$/.test(body.handle || "")) bad("Enter the complete recipient handle."); input.handle = body.handle; }
  if (action === "list") {
    if (!["sent","received","drafts"].includes(body.folder)) bad("Invalid folder."); input.folder = body.folder;
    if (body.before) { if (!Number.isFinite(Date.parse(body.before)) || !uuid(body.beforeId)) bad("Invalid page cursor."); input.before = body.before; input.beforeId = body.beforeId; }
  }
  return input;
}
async function limit(subject, action) {
  const discovery = action === "discover", maximum = discovery ? 20 : 300;
  const key = `transfer-rate:${discovery ? "discovery" : "api"}:${digest(subject)}`;
  const count = await getKv().eval("local n=redis.call('incr',KEYS[1]); if n==1 then redis.call('expire',KEYS[1],ARGV[1]); end; return n", [key], [discovery ? 3600 : 60]);
  if (!Number.isFinite(Number(count))) throw new Error("Rate limiter unavailable.");
  if (Number(count) > maximum) throw Object.assign(new Error("Too many requests. Try again shortly."), { status: 429 });
}
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return res.status(200).json({ available: available(), maxBytes: 5e9, chunkBytes: 8388608, maxFiles: 64 });
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!available()) return res.status(503).json({ error: "Large transfers are not configured on this deployment." });
  const started = Date.now(); let action = "invalid";
  try {
    if (Number(req.headers["content-length"]) > 400000 || Buffer.byteLength(typeof req.body === "string" ? req.body : JSON.stringify(req.body || {})) > 400000) return res.status(413).json({ error: "Transfer metadata exceeds the request limit." });
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    action = body?.action;
    if (!["create","resume","part","confirm","finalize","open","claim","download","finish","revoke","delete","list","profile","profile-save","discover"].includes(action)) { action = "invalid"; bad("Invalid transfer operation."); }
    await limit(clientIp(req), action);
    const publicOperation = ["open","claim","download","finish"].includes(action);
    const identity = !publicOperation || req.headers.authorization ? await user(req) : null;
    if (identity) await limit(identity.id, action);
    const input = validate(action, body);
    if (action === "profile-save") {
      const existing = await db.rpc("profile", identity.id);
      if (existing?.user_id) Object.assign(input, { publicKey: existing.public_key, privateKey: existing.private_key });
      else if (!input.publicKey) bad("Create your encryption vault first.");
    }
    let result = await db.rpc(action, identity?.id, input);
    if (action === "part") result = await objects.storage().upload(input.id, result);
    if (action === "confirm") {
      await objects.storage().verify(input.id, result);
      result = await db.rpc("confirm", identity.id, { ...input, verified: true });
    }
    if (action === "download") result = await objects.storage().download(input.id, result);
    return res.status(200).json(result);
  } catch (error) {
    const status = error.status || (error instanceof SyntaxError ? 400 : 503);
    // No IDs, handles, tokens, ciphertext, URLs, or upstream error payloads in telemetry.
    console.warn(JSON.stringify({ event: "transfer_error", action: typeof action === "string" && action.length < 20 ? action : "invalid", status, ms: Date.now() - started }));
    return res.status(status).json({ error: error.status ? error.message : "Transfer service is temporarily unavailable. Your upload can be resumed." });
  }
};
module.exports.validate = validate;
