const { auth, user, configured: authConfigured } = require("./_lib/account");
const { sameOrigin, clearCookie } = require("./session");
const { isKvConfigured, getKv } = require("./_lib/kv");
const { checkRateLimit, clientIp } = require("./_lib/capsule");
const db = require("./_lib/transfer-db");
const storage = require("./_lib/transfer-storage");
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!sameOrigin(req)) return res.status(403).json({ error: "Request origin is not allowed." });
  if (!db.configured() || !authConfigured() || !isKvConfigured() || !storage.configured() || !process.env.CRON_SECRET) return res.status(503).json({ error: "Account deletion is not configured." });
  try {
    if (!await checkRateLimit(getKv(), clientIp(req), "account-erasure")) return res.status(429).json({ error: "Too many requests. Try again later." });
    const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    if (Buffer.byteLength(raw) > 4096) return res.status(413).json({ error: "Request too large." });
    let body; try { body = JSON.parse(raw); } catch { return res.status(400).json({ error: "Invalid request." }); }
    const identity = await user(req);
    if (body?.action === "status") return res.status(200).json(await db.accountRpc("status", identity.id));
    if (body?.action !== "request" || body.confirmation !== "DELETE" || typeof body.password !== "string" || !body.password.length || body.password.length > 256) return res.status(400).json({ error: "Enter your current account password and type DELETE." });
    const verified = await auth("token?grant_type=password", { email: identity.email, password: body.password });
    if (verified.user?.id !== identity.id) return res.status(403).json({ error: "Account confirmation failed." });
    try { await db.accountRpc("request", identity.id); }
    finally { try { if (verified.access_token) await auth("logout?scope=local", {}, verified.access_token); } catch {} }
    clearCookie(res);
    try { await auth("logout?scope=global", {}, (req.headers.authorization || "").replace(/^Bearer /, "")); } catch {}
    return res.status(202).json({ pending: true, message: "Account deletion requested. File access is revoked. Hosted cleanup completes before your identity is removed. Anonymous links and copies already downloaded are not removed." });
  } catch (error) { return res.status(error.status || 503).json({ error: error.status === 401 ? "Check your account password and sign-in session." : error.status === 409 ? error.message : "Account deletion is temporarily unavailable. Try again." }); }
};
