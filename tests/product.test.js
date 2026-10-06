const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { once } = require("node:events");
const { paths, safeReturn } = require("../routes");
const { createServer, resolveEndpoint } = require("../scripts/preview.cjs");
const { inspect } = require("../scripts/release-check.cjs");

test("authentication return paths cannot redirect away or leak keys into the login URL", () => {
  const link = "/open?transfer=11111111-1111-4111-8111-111111111111#access=private&key=secret";
  assert.equal(safeReturn(link, "https://capsule.example"), link);
  assert.equal(safeReturn("/send/files"), "/send/files");
  for (const value of ["//evil.example", "https://evil.example", "/\\evil.example", "/login", "/auth/confirm?token_hash=x", "/account", "/unknown", "/api/account", "/workspace\n"]) assert.equal(safeReturn(value), null, value);
  const source = fs.readFileSync("accounts.js", "utf8");
  assert.ok(source.includes('sessionStorage.setItem(returnKey'));
  assert.ok(!source.includes('searchParams.set("next"'));
});

test("account-enabled config covers every product page and the dev server uses real API handlers", async () => {
  const config = JSON.parse(fs.readFileSync("vercel.accounts.json", "utf8"));
  for (const path of Object.values(paths)) assert.ok(config.rewrites.some((rule) => rule.source === path), path);
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of Object.values(paths)) {
      const response = await fetch(`${origin}${path}`); assert.equal(response.status, 200, path); assert.match(await response.text(), /accounts.js/);
    }
    const account = await fetch(`${origin}/api/account`); assert.equal(account.status, 200); assert.equal(typeof (await account.json()).available, "boolean");
    const health = await (await fetch(`${origin}/api/health`)).json(); assert.equal(health.status, "ok"); assert.equal(health.checked, "configuration");
    for (const path of ["/.env.local", "/api/_lib/account.js", "/scripts/preview.cjs", "/tests/regression.test.js", "/does-not-exist"]) assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
    assert.deepEqual(resolveEndpoint("/api/c/Ab12Cd34"), { file:"c/[id]", params:{id:"Ab12Cd34"} });
    assert.equal(resolveEndpoint("/api/c/../../account"), null);
  } finally { server.close(); await once(server, "close"); }
});

test("release checks fail closed for missing services and reject non-production origins", () => {
  assert.ok(Object.values(inspect({}, false)).every((value) => value === false));
  const env = { PUBLIC_APP_URL:"https://capsule.example", SUPABASE_URL:"https://project.supabase.co", SUPABASE_ANON_KEY:"a", SUPABASE_SERVICE_ROLE_KEY:"b", TRANSFER_S3_BUCKET:"private", TRANSFER_S3_REGION:"r", TRANSFER_S3_ACCESS_KEY_ID:"id", TRANSFER_S3_SECRET_ACCESS_KEY:"key", TRANSFERS_ENABLED:"true", CRON_SECRET:"a".repeat(32), RESEND_API_KEY:"key", NOTIFICATION_FROM:"Capsule <mail@example.com>" };
  assert.ok(Object.values(inspect(env, true)).every(Boolean));
  for (const PUBLIC_APP_URL of ["http://capsule.example", "https://capsule.example/subpath", "https://user:pass@capsule.example", "not a URL"]) assert.equal(inspect({...env,PUBLIC_APP_URL}, true)["Public HTTPS origin"], false);
});
