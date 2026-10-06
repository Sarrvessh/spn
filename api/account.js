const crypto = require("crypto");
const { auth, user, configured } = require("./_lib/account");
const { getKv, isKvConfigured, withRedisLock } = require("./_lib/kv");
const { clientIp, checkRateLimit } = require("./_lib/capsule");
const db = require("./_lib/transfer-db");
const storage = require("./_lib/transfer-storage");
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return res.status(200).json({ available: configured() && isKvConfigured(), erasure: db.configured() && storage.configured() && Boolean(process.env.CRON_SECRET && isKvConfigured()), notifications: Boolean(process.env.RESEND_API_KEY && process.env.NOTIFICATION_FROM) });
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!configured() || !isKvConfigured()) return res.status(503).json({ error: "Accounts are not configured." });
  const kv = getKv();
  if (!await checkRateLimit(kv, clientIp(req), "account")) return res.status(429).json({ error: "Too many requests." });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (["login", "signup"].includes(body?.action)) {
      if (typeof body.email !== "string" || typeof body.password !== "string" || body.email.length > 254 || body.password.length < 12 || body.password.length > 256) return res.status(400).json({ error: "Use an email and a password of at least 12 characters." });
      const data = await auth(body.action === "signup" ? "signup" : "token?grant_type=password", { email: body.email, password: body.password });
      return res.status(200).json({ access_token: data.access_token, email: data.user?.email, confirmationRequired: !data.access_token });
    }
    const identity = await user(req);
    if (db.configured() && (await db.accountRpc("status", identity.id)).pending) return res.status(409).json({ error: "Account deletion is pending. Cloud backup and notifications cannot be changed." });
    const key = `workspace:${identity.id}`;
    if (body.action === "load") return res.status(200).json(await kv.get(key) || { revision: 0 });
    if (body.action === "save") {
      const encrypted = body.encrypted;
      if (encrypted?.format !== "capsule-workspace" || encrypted.version !== 1 || typeof encrypted.ciphertext !== "string" || encrypted.ciphertext.length > 2 * 1024 * 1024 || !/^[A-Za-z0-9_-]{22}$/.test(encrypted.salt || "") || !/^[A-Za-z0-9_-]{16}$/.test(encrypted.iv || "") || !/^[A-Za-z0-9_-]+$/.test(encrypted.ciphertext)) return res.status(400).json({ error: "Invalid encrypted workspace or exceeds the 2 MB sync limit." });
      const result = await withRedisLock(kv, `lock:${key}`, async () => {
        const current = await kv.get(key);
        if ((current?.revision || 0) !== body.revision) throw Object.assign(new Error("Cloud workspace changed. Restore it before saving."), { status: 409 });
        const next = { encrypted, revision: (current?.revision || 0) + 1, updatedAt: Date.now() };
        await kv.set(key, next, { ex: 90 * 86400 }); return { revision: next.revision };
      });
      return res.status(200).json(result);
    }
    if (body.action === "notifications") {
      if (!/^[A-Za-z0-9_-]{20,80}$/.test(body.token || "") || typeof body.ownerToken !== "string") return res.status(400).json({ error: "Invalid collection." });
      const hash = (value) => crypto.createHash("sha256").update(value).digest("base64url");
      const collectionKey = `collection:${hash(body.token)}`;
      await withRedisLock(kv, `lock:${collectionKey}`, async () => {
        const record = await kv.get(collectionKey);
        if (!record || record.ownerHash !== hash(body.ownerToken)) throw Object.assign(new Error("Collection owner access denied."), { status: 403 });
        record.notificationEmail = body.enabled ? identity.email : "";
        await kv.set(collectionKey, record, { ex: Math.max(1, Math.ceil((record.storageExpiresAt - Date.now()) / 1000)) });
      });
      return res.status(200).json({ enabled: Boolean(body.enabled) });
    }
    return res.status(400).json({ error: "Invalid account action." });
  } catch (error) { return res.status(error.status || 503).json({ error: error.status ? error.message : "Account service is temporarily unavailable." }); }
};
