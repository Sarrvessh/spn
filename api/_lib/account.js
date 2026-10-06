function configured() { return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY); }
async function auth(path, body, token, method) {
  if (!configured()) throw Object.assign(new Error("Accounts are not configured."), { status: 503 });
  const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/${path}`, { signal: AbortSignal.timeout(8000), method: method || (body ? "POST" : "GET"), headers: { apikey: process.env.SUPABASE_ANON_KEY, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.msg || data.error_description || "Authentication failed."), { status: response.status === 429 ? 429 : response.status >= 500 ? 503 : 401 });
  return data;
}
async function user(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!token) throw Object.assign(new Error("Sign in first."), { status: 401 });
  const identity = await auth("user", null, token);
  if (!identity.id || !identity.email_confirmed_at) throw Object.assign(new Error("Confirm your email first."), { status: 403 });
  return identity;
}
module.exports = { auth, user, configured };
