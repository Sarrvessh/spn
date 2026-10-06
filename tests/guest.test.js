const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { build, output } = require("../scripts/build-guest.cjs");
const { createServer } = require("../scripts/preview-guest.cjs");
const routes = require("../routes");
test("Git-triggered Vercel deployments build only the account-free edition", () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"));
  assert.equal(config.framework, null);
  assert.equal(config.buildCommand, "node scripts/build-guest.cjs");
  assert.equal(config.installCommand, "");
  assert.equal(config.outputDirectory, "guest-release/dist");
  assert.equal(config.crons, undefined);
  assert.equal(config.functions, undefined);
  assert.ok(config.headers[0].headers.some((header) => header.key === "Content-Security-Policy" && header.value.includes("connect-src 'none'")));
  assert.deepEqual(config.rewrites.map((rule) => rule.source), ["/workspace", "/send/prompt", "/send/files", "/open"]);
  const allowed = fs.readFileSync(path.join(__dirname, "..", ".vercelignore"), "utf8").split(/\r?\n/);
  assert.equal(allowed[0], "/*");
  for (const file of ["index.html", "app.js", "routes.js", "workspace.js", "features.js", "guest-ui.js", "styles.css", "workspace.css", "guest.css", "favicon.svg", "vercel.guest.json"]) assert.ok(allowed.includes(`!${file}`), file);
  assert.ok(allowed.includes("!/scripts/build-guest.cjs"));
  for (const file of ["api/", "accounts.js", "transfers.js", ".env", "reports/"]) assert.ok(!allowed.includes(`!${file}`), file);
});
test("account-free build includes only usable frontend assets and supports direct recipient routes", async () => {
  build();
  const html = fs.readFileSync(path.join(output, "index.html"), "utf8");
  for (const script of ["guest-config.js", "routes.js", "app.js", "workspace.js", "features.js", "guest-ui.js"]) assert.ok(html.includes(`src="/${script}"`));
  for (const excluded of ["accounts.js", "transfers.js", "collections.js", "transfer-recovery.js"]) assert.ok(!html.includes(`src="/${excluded}"`));
  assert.ok(fs.readFileSync(path.join(output, "_headers"), "utf8").includes("connect-src 'none'"));
  const vercel = JSON.parse(fs.readFileSync(path.join(output, "..", "vercel.json"), "utf8"));
  assert.equal(vercel.outputDirectory, "dist");
  assert.equal(vercel.crons, undefined);
  for (const route of ["/workspace", "/send/prompt", "/send/files", "/open"]) assert.ok(vercel.rewrites.some((rule) => rule.source === route && rule.destination === "/index.html"));
  assert.equal(routes.resolve("https://example.com/open#data=encrypted&key=secret").screen, "receive");
  const server = createServer(); await new Promise((resolve) => server.listen(0,"127.0.0.1",resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const route of ["/workspace", "/send/prompt", "/send/files", "/open"]) assert.equal((await fetch(origin + route)).status,200);
    for (const route of ["/.env", "/api/session", "/api/c/init", "/migrations/001_transfers.sql"]) assert.equal((await fetch(origin + route)).status,404);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
