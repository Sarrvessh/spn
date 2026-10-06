const fs = require("node:fs");
const path = require("node:path");
const { isKvConfigured } = require("../api/_lib/kv");
function inspect(env = process.env, kv = isKvConfigured()) {
  const checks = {
    "Public HTTPS origin": (() => { try { const u = new URL(env.PUBLIC_APP_URL); return u.protocol === "https:" && u.pathname === "/" && !u.search && !u.hash && !u.username && !u.password; } catch { return false; } })(),
    "Supabase Auth and service role": Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY),
    "Redis rate limits and legacy links": kv,
    "Private transfer storage": Boolean(env.TRANSFER_S3_BUCKET && env.TRANSFER_S3_REGION && env.TRANSFER_S3_ACCESS_KEY_ID && env.TRANSFER_S3_SECRET_ACCESS_KEY),
    "Transfer release flag enabled": env.TRANSFERS_ENABLED === "true",
    "Cleanup secret (32+ characters)": Boolean(env.CRON_SECRET && env.CRON_SECRET.length >= 32),
    "Resend delivery notifications": Boolean(env.RESEND_API_KEY && env.NOTIFICATION_FROM)
  };
  return checks;
}
if (require.main === module) {
  const env = path.resolve(__dirname, "../.env.local"); if (fs.existsSync(env)) process.loadEnvFile(env);
  const checks = inspect();
  for (const [name, passed] of Object.entries(checks)) console.log(`${passed ? "PASS" : "MISSING"}: ${name}`);
  console.log("Configuration only. Staging must also verify email, migration/RLS, private storage/CORS, cron and browser transfers. See DEPLOYMENT.md.");
  if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
}
module.exports = { inspect };
