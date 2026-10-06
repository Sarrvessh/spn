const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const { webcrypto } = require("node:crypto");

function workspace() {
  const nodes = new Map(), storage = new Map(), downloads = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: "", hidden: true, classList: { toggle() {} }, handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {} });
    return nodes.get(id);
  };
  const localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  const context = { TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, Blob, setTimeout: (fn) => fn(), localStorage, document: { getElementById: node, body: { dataset: {}, classList: { add() {} } }, createElement: () => ({ click() {} }) }, window: { addEventListener() {} }, MutationObserver: class { observe() {} }, URL: { createObjectURL(blob) { downloads.push(blob); return "blob:test"; }, revokeObjectURL() {} }, bytesToBase64Url: (bytes) => Buffer.from(bytes).toString("base64url"), base64UrlToBytes: (value) => new Uint8Array(Buffer.from(value, "base64url")) };
  vm.runInNewContext(fs.readFileSync(require.resolve("../workspace.js"), "utf8"), context);
  return { node, storage, downloads, async click(id) { const target = node(id); await target.handlers.click({ target }); }, async restore(backup) { const target = node("deskImport"); target.files = [new Blob([backup])]; await target.handlers.change({ target }); } };
}

test("workspace backup encrypts links and restores records without overwriting existing data", async () => {
  const app = workspace();
  const key = "prompt-capsule-recent-pack";
  app.storage.set(key, JSON.stringify([{ envelope: { id: "test-one", title: "Private title" }, key: "secret-key", shareUrl: "https://example.test/#key=secret-key" }]));
  app.node("deskPassword").value = "test-password-long";
  await app.click("deskExport");
  const backup = await app.downloads[0].text();
  assert.ok(!backup.includes("secret-key"));
  assert.ok(!backup.includes("Private title"));
  app.storage.set(key, JSON.stringify([{ envelope: { id: "test-two" } }]));
  app.node("deskPassword").value = "test-password-long";
  await app.restore(backup);
  assert.equal(JSON.parse(app.storage.get(key)).length, 2);
  assert.match(app.node("deskStatus").textContent, /restored/);
});

test("wrong backup password leaves the workspace unchanged", async () => {
  const app = workspace();
  app.node("deskPassword").value = "test-password-long";
  await app.click("deskExport");
  const backup = await app.downloads[0].text();
  app.node("deskPassword").value = "wrong-password-long";
  await app.restore(backup);
  assert.equal(app.storage.size, 0);
  assert.match(app.node("deskStatus").textContent, /incorrect/);
});
