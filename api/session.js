const { auth, user, configured } = require("./_lib/account");
const { getKv, isKvConfigured } = require("./_lib/kv");
const { checkRateLimit, clientIp } = require("./_lib/capsule");
const cookieName = "capsule_refresh";
function sameOrigin(req) {
  const expected = process.env.PUBLIC_APP_URL || (process.env.NODE_ENV !== "production" ? `http://${req.headers.host}` : "");
  try { return Boolean(expected && req.headers.origin === new URL(expected).origin); } catch { return false; }
}
function cookie(res, token = "") {
  res.setHeader("Set-Cookie", `${cookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api/session; Max-Age=${token ? 2592000 : 0}${process.env.NODE_ENV === "production" || process.env.PUBLIC_APP_URL?.startsWith("https:") ? "; Secure" : ""}`);
}
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!sameOrigin(req)) return res.status(403).json({ error: "Request origin is not allowed." });
  const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
  if (Buffer.byteLength(rawBody) > 4096) return res.status(413).json({ error: "Request too large." });
  let body;
  try { body = JSON.parse(rawBody); } catch { return res.status(400).json({ error: "Invalid request." }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ error: "Invalid request." });
  if (body.action === "logout") {
    cookie(res);
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    try { if (token && configured()) await auth("logout?scope=local", {}, token); } catch {}
    return res.status(200).json({ signedIn: false });
  }
  // A guest refresh requires no infrastructure or rate-limit reservation.
  const refreshCookie = (req.headers.cookie || "").split(";").map((x) => x.trim()).find((x) => x.startsWith(`${cookieName}=`));
  if (body.action === "refresh" && !refreshCookie) return res.status(200).json({ signedIn: false });
  if (!configured() || !isKvConfigured()) return res.status(503).json({ error: "Accounts are not configured." });
  try {
    if (!await checkRateLimit(getKv(), clientIp(req), body.action === "refresh" ? "session-refresh" : "session")) return res.status(429).json({ error: "Too many account requests. Try again later." });
    let data;
    if (body.action === "refresh") {
      try { data = await auth("token?grant_type=refresh_token", { refresh_token: decodeURIComponent(refreshCookie.slice(cookieName.length + 1)) }); }
      catch (error) { if (error.status === 401) cookie(res); throw error; }
    } else if (body.action === "exchange") {
      if (typeof body.refreshToken !== "string" || body.refreshToken.length < 10 || body.refreshToken.length > 2048) return res.status(400).json({ error: "Invalid email link." });
      data = await auth("token?grant_type=refresh_token", { refresh_token: body.refreshToken });
    } else if (body.action === "verify") {
      if (!["signup", "recovery", "email"].includes(body.type) || !/^[A-Za-z0-9_-]{32,128}$/.test(body.tokenHash || "")) return res.status(400).json({ error: "Invalid email confirmation link." });
      data = await auth("verify", { type: body.type, token_hash: body.tokenHash });
    } else if (body.action === "update-password") {
      await user(req);
      if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 256) return res.status(400).json({ error: "Use at least 12 characters for your password." });
      await auth("user", { password: body.password }, (req.headers.authorization || "").replace(/^Bearer /, ""), "PUT");
      return res.status(200).json({ updated: true });
    } else if (["login","signup","recover","reset","resend"].includes(body.action)) {
      if (typeof body.email !== "string" || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return res.status(400).json({ error: "Enter a valid email address." });
      if (body.action === "recover") {
        // Always respond identically, including for addresses without an account.
        try { await auth(`recover?redirect_to=${encodeURIComponent(new URL("/auth/confirm", process.env.PUBLIC_APP_URL || req.headers.origin).href)}`, { email: body.email }); } catch (error) { if (error.status === 503 || error.status === 429) throw error; }
        return res.status(200).json({ message: "If an account exists, a recovery email has been sent." });
      }
      if (body.action === "resend") {
        try { await auth(`resend?redirect_to=${encodeURIComponent(new URL("/auth/confirm", process.env.PUBLIC_APP_URL || req.headers.origin).href)}`, { type: "signup", email: body.email }); } catch (error) { if (error.status === 503 || error.status === 429) throw error; }
        return res.status(200).json({ message: "If confirmation is needed, a new email has been sent." });
      }
      if (typeof body.password !== "string" || body.password.length < (body.action === "login" ? 1 : 12) || body.password.length > 256) return res.status(400).json({ error: "Use at least 12 characters for your password." });
      if (body.action === "reset") {
        if (!/^\d{6,10}$/.test(body.code || "")) return res.status(400).json({ error: "Enter the recovery code from your email." });
        data = await auth("verify", { type: "recovery", email: body.email, token: body.code });
        await auth("user", { password: body.password }, data.access_token, "PUT");
      } else data = await auth(body.action === "signup" ? `signup?redirect_to=${encodeURIComponent(new URL("/auth/confirm", process.env.PUBLIC_APP_URL || req.headers.origin).href)}` : "token?grant_type=password", { email: body.email, password: body.password });
    } else return res.status(400).json({ error: "Invalid session action." });
    if (data.refresh_token) cookie(res, data.refresh_token);
    return res.status(200).json({ access_token: data.access_token, expires_at: data.expires_at || Math.floor(Date.now()/1000) + (data.expires_in || 3600), email: data.user?.email, userId: data.user?.id, confirmationRequired: !data.access_token });
  } catch (error) { return res.status(error.status || 503).json({ error: error.status === 401 ? "Unable to authenticate. Check your credentials or request a new email link." : error.status === 429 ? "Too many account requests. Try again later." : "Account service is temporarily unavailable." }); }
};
module.exports.sameOrigin = sameOrigin;
module.exports.clearCookie = (res) => cookie(res);
