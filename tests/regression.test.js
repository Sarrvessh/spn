const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class FakeRedis {
  constructor() {
    this.values = new Map();
    this.options = new Map();
  }

  async get(key) {
    return clone(this.values.get(key) ?? null);
  }

  async set(key, value, options = {}) {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, clone(value));
    this.options.set(key, { ...options });
    return "OK";
  }

  async del(key) {
    return this.values.delete(key) ? 1 : 0;
  }

  async eval(script, keys, args) {
    const key = keys[0];
    if (script.includes("redis.call('incr'")) {
      const next = Number(this.values.get(key) || 0) + 1;
      this.values.set(key, next);
      return next;
    }
    if (script.includes("redis.call('get'")) {
      if (this.values.get(key) === args[0]) return this.del(key);
      return 0;
    }
    throw new Error("Unsupported fake Redis script");
  }

  multi() {
    const operations = [];
    const transaction = {
      get: (key) => {
        operations.push(["get", key]);
        return transaction;
      },
      del: (key) => {
        operations.push(["del", key]);
        return transaction;
      },
      exec: async () => {
        const results = [];
        for (const [command, key] of operations) {
          results.push(command === "get" ? await this.get(key) : await this.del(key));
        }
        return results;
      },
    };
    return transaction;
  }

  async zrange() {
    return [];
  }

  async zadd() {
    return 1;
  }

  async zrem() {
    return 1;
  }
}

function loadWithKvMock(modulePath, fakeRedis) {
  const kvPath = require.resolve("../api/_lib/kv");
  const targetPath = require.resolve(modulePath);
  const realKv = require(kvPath);
  const originalKvCache = require.cache[kvPath];
  const originalTargetCache = require.cache[targetPath];

  require.cache[kvPath] = {
    id: kvPath,
    filename: kvPath,
    loaded: true,
    exports: {
      ...realKv,
      getKv: () => fakeRedis,
      isKvConfigured: () => true,
    },
  };
  delete require.cache[targetPath];
  const loaded = require(targetPath);

  if (originalKvCache) require.cache[kvPath] = originalKvCache;
  else delete require.cache[kvPath];
  if (originalTargetCache) require.cache[targetPath] = originalTargetCache;
  else delete require.cache[targetPath];
  return loaded;
}

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("collection creation validates secrets, limits, and dates", () => {
  const { normalizeCreation, MAX_COLLECTION_TTL_SEC } = require("../api/_lib/collection");
  const now = Date.now();
  const base = {
    encryptedTemplate: { ciphertext: "ciphertext", iv: "iv" },
    publicMeta: {},
    publicPolicy: { maxSubmissions: 25 },
    retention: { mode: "manual" },
  };

  const normalized = normalizeCreation(base, now);
  assert.equal(normalized.maxSubmissions, 25);
  assert.equal(normalized.storageExpiresAt, now + MAX_COLLECTION_TTL_SEC * 1000);

  assert.throws(
    () => normalizeCreation({
      ...base,
      publicPolicy: { maxSubmissions: 25, requirePassword: true, accessPasswordHash: "" },
    }, now),
    /accessPasswordHash/,
  );
  assert.throws(
    () => normalizeCreation({
      ...base,
      publicMeta: { expiresAt: new Date(now - 1000).toISOString() },
    }, now),
    /future/,
  );
  assert.throws(
    () => normalizeCreation({
      ...base,
      publicPolicy: { maxSubmissions: 0 },
    }, now),
    /between 1 and 500/,
  );
});

test("collection retention burns payloads but preserves receipts", () => {
  const { applyRetention } = require("../api/_lib/collection");
  const now = Date.now();
  const timed = {
    status: "active",
    retention: { mode: "86400000" },
    submissions: [{
      id: "old",
      receiptId: "RCPT-OLD",
      submittedAt: now - 2 * 86400000,
      status: "stored",
      encryptedPayload: { ciphertext: "secret" },
    }],
    audit: [],
  };
  assert.equal(applyRetention(timed, now), 1);
  assert.equal(timed.submissions[0].status, "burned");
  assert.equal(timed.submissions[0].receiptId, "RCPT-OLD");
  assert.equal(timed.submissions[0].encryptedPayload, undefined);

  const closed = {
    status: "completed",
    retention: { mode: "close" },
    submissions: [{
      id: "closed",
      receiptId: "RCPT-CLOSED",
      submittedAt: now,
      status: "stored",
      encryptedPayload: { ciphertext: "secret" },
    }],
    audit: [],
  };
  assert.equal(applyRetention(closed, now), 1);
  assert.equal(closed.submissions[0].status, "burned");
});

test("auto-close remains active until the configured submission cap", () => {
  const { publicState } = require("../api/collections/[token]");
  const record = {
    status: "active",
    publicMeta: {},
    publicPolicy: { oneTime: false, autoClose: true, maxSubmissions: 25 },
    submissions: [{ id: "first", status: "stored" }],
  };
  assert.equal(publicState(record).status, "active");

  record.submissions = Array.from({ length: 25 }, (_, index) => ({
    id: String(index),
    status: "stored",
  }));
  assert.equal(publicState(record).status, "maxed");
});

test("Redis lock serializes concurrent collection operations", async () => {
  const { withRedisLock } = require("../api/_lib/kv");
  const redis = new FakeRedis();
  let active = 0;
  let maximumActive = 0;

  await Promise.all(Array.from({ length: 4 }, () => withRedisLock(
    redis,
    "lock:test",
    async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
    },
    { attempts: 100 },
  )));

  assert.equal(maximumActive, 1);
  assert.equal(await redis.get("lock:test"), null);
});

test("parallel collection submissions store exactly one response at a one-response cap", async () => {
  const redis = new FakeRedis();
  const token = "A".repeat(24);
  const tokenHash = crypto.createHash("sha256").update(token).digest("base64url");
  const key = `collection:${tokenHash}`;
  const now = Date.now();
  await redis.set(key, {
    version: 1,
    kind: "form",
    ownerHash: "owner",
    status: "active",
    encryptedTemplate: { ciphertext: "template", iv: "iv" },
    publicMeta: { openAt: "", expiresAt: "", maxRetentionAt: new Date(now + 86400000).toISOString() },
    publicPolicy: {
      oneTime: false,
      autoClose: true,
      maxSubmissions: 1,
      requirePassword: false,
      requireOtp: false,
      requireConsent: true,
    },
    retention: { mode: "manual" },
    submissions: [],
    audit: [],
    storageExpiresAt: now + 86400000,
  }, { ex: 86400 });

  const handler = loadWithKvMock("../api/collections/[token]", redis);
  const request = () => ({
    method: "POST",
    query: { token },
    headers: { "x-forwarded-for": "127.0.0.1" },
    body: {
      encryptedPayload: { ciphertext: "submission", iv: "iv" },
      verification: { consent: true },
    },
  });
  const first = mockResponse();
  const second = mockResponse();

  await Promise.all([
    handler(request(), first),
    handler(request(), second),
  ]);

  assert.deepEqual([first.statusCode, second.statusCode].sort(), [201, 409]);
  const stored = await redis.get(key);
  assert.equal(stored.submissions.length, 1);
  assert.equal(stored.status, "completed");
  assert.ok(redis.options.get(key).ex > 0, "mutation must preserve a Redis TTL");
});

test("server rejects a collection submission when required consent is absent", async () => {
  const redis = new FakeRedis();
  const token = "B".repeat(24);
  const tokenHash = crypto.createHash("sha256").update(token).digest("base64url");
  const key = `collection:${tokenHash}`;
  const now = Date.now();
  await redis.set(key, {
    kind: "request",
    ownerHash: "owner",
    status: "active",
    encryptedTemplate: { ciphertext: "template", iv: "iv" },
    publicMeta: { openAt: "", expiresAt: "" },
    publicPolicy: { maxSubmissions: 1, requireConsent: true },
    retention: { mode: "manual" },
    submissions: [],
    audit: [],
    storageExpiresAt: now + 86400000,
  }, { ex: 86400 });

  const handler = loadWithKvMock("../api/collections/[token]", redis);
  const response = mockResponse();
  await handler({
    method: "POST",
    query: { token },
    headers: { "x-forwarded-for": "127.0.0.2" },
    body: {
      encryptedPayload: { ciphertext: "submission", iv: "iv" },
      verification: {},
    },
  }, response);

  assert.equal(response.statusCode, 403);
  assert.equal((await redis.get(key)).submissions.length, 0);
});

test("burn-after-read is single-consumer and keeps pointer on Blob read failure", async () => {
  const inlineRedis = new FakeRedis();
  const now = Date.now();
  await inlineRedis.set("capsule:ABCDEFGH", {
    storage: "inline",
    envelope: { ciphertext: "ciphertext", iv: "iv" },
    burnAfterRead: true,
    expiresAt: now + 60000,
  }, { ex: 60 });
  const inlineStore = loadWithKvMock("../api/_lib/store", inlineRedis);
  await assert.rejects(
    () => inlineStore.loadCapsule("ABCDEFGH"),
    (error) => error.code === "BURN_REQUIRES_CONSUME",
  );
  assert.ok(await inlineRedis.get("capsule:ABCDEFGH"), "GET-style preview must not consume capsule");
  const reads = await Promise.all([
    inlineStore.loadCapsule("ABCDEFGH", { consumeBurn: true }),
    inlineStore.loadCapsule("ABCDEFGH", { consumeBurn: true }),
  ]);
  assert.equal(reads.filter(Boolean).length, 1);
  assert.equal(await inlineRedis.get("capsule:ABCDEFGH"), null);

  const blobRedis = new FakeRedis();
  await blobRedis.set("capsule:IJKLMNOP", {
    storage: "blob",
    blobUrl: "https://blob.invalid/capsule.json",
    burnAfterRead: true,
    expiresAt: now + 60000,
  }, { ex: 60 });
  const blobStore = loadWithKvMock("../api/_lib/store", blobRedis);
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("temporary outage");
  };
  try {
    await assert.rejects(
      () => blobStore.loadCapsule("IJKLMNOP", { consumeBurn: true }),
      (error) => error.code === "BLOB_UNAVAILABLE",
    );
  } finally {
    global.fetch = originalFetch;
  }
  assert.ok(await blobRedis.get("capsule:IJKLMNOP"), "failed read must not consume capsule");
});

test("larger capsules still get short-link storage when Blob is not configured", async () => {
  const redis = new FakeRedis();
  const previousBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  try {
    const { MAX_BLOB_BYTES } = require("../api/_lib/capsule");
    const store = loadWithKvMock("../api/_lib/store", redis);
    const envelope = {
      ciphertext: "x".repeat(MAX_BLOB_BYTES + 4096),
      iv: "iv",
      guards: [],
      createdAt: Date.now(),
    };

    const saved = await store.saveCapsule(envelope);
    assert.equal(saved.storage, "inline");
    const record = await redis.get(`capsule:${saved.id}`);
    assert.equal(record.storage, "inline");
    assert.equal(record.envelope.ciphertext.length, envelope.ciphertext.length);
  } finally {
    if (previousBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousBlobToken;
  }
});

test("capsule lifecycle reserves a short id and completes the same link", async () => {
  const redis = new FakeRedis();
  const store = loadWithKvMock("../api/_lib/store", redis);
  const pending = await store.initCapsule({ kind: "file-drop" });
  assert.match(pending.id, /^[A-Za-z0-9]{8}$/);

  const envelope = {
    ciphertext: "ciphertext",
    iv: "iv",
    guards: [],
    createdAt: Date.now(),
  };
  const saved = await store.completeCapsule(pending.id, envelope);
  assert.equal(saved.id, pending.id);
  assert.equal(saved.storage, "inline");
  assert.deepEqual(await store.loadCapsule(pending.id, { consumeBurn: true }), envelope);
});

test("direct-upload callbacks are attached to pending capsules before completion", async () => {
  const redis = new FakeRedis();
  const store = loadWithKvMock("../api/_lib/store", redis);
  const pending = await store.initCapsule({ kind: "file-drop" });
  const count = await store.registerPendingBlob(pending.id, {
    url: "https://example.public.blob.vercel-storage.com/encrypted.bin",
    downloadUrl: "https://example.public.blob.vercel-storage.com/encrypted.bin?download=1",
    pathname: `capsules/uploads/${pending.id}/encrypted.bin`,
    size: 1234,
    contentType: "application/octet-stream",
  });
  assert.equal(count, 1);
  const record = await redis.get(`capsule:${pending.id}`);
  assert.equal(record.uploads.length, 1);
  assert.equal(record.uploads[0].size, 1234);
});

test("direct-uploaded capsule Blob can complete the reserved short link", async () => {
  const redis = new FakeRedis();
  const store = loadWithKvMock("../api/_lib/store", redis);
  const pending = await store.initCapsule({ kind: "file-drop" });
  const envelope = {
    ciphertext: "ciphertext-from-direct-upload",
    iv: "iv",
    guards: ["burn-after-read"],
    createdAt: Date.now(),
  };
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => envelope,
  });

  try {
    const saved = await store.completeUploadedCapsule(pending.id, {
      url: "https://example.public.blob.vercel-storage.com/envelope.json",
      pathname: `capsules/uploads/${pending.id}/envelope.json`,
      size: 4096,
      contentType: "application/json",
    });
    assert.equal(saved.id, pending.id);
    assert.equal(saved.storage, "blob");
    const record = await redis.get(`capsule:${pending.id}`);
    assert.equal(record.storage, "blob");
    assert.equal(record.burnAfterRead, true);
    assert.deepEqual(await store.loadCapsule(pending.id, { consumeBurn: true }), envelope);
  } finally {
    global.fetch = originalFetch;
  }
});

test("client sources retain secrets only on active receive routes and keep public fields stable", () => {
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const collections = fs.readFileSync(path.join(ROOT, "collections.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

  assert.match(app, /onCollectionLink[\s\S]*Keep active secure request\/form paths/);
  assert.match(app, /promptResult:\s*\{[\s\S]*fileResult:\s*\{/);
  assert.match(app, /strong\.textContent = title/);
  assert.doesNotMatch(app, /\$\{origin\}\/\$\{hash\}/);
  assert.doesNotMatch(html, /option value="never"/);

  assert.match(collections, /data-public-container/);
  assert.match(collections, /publicVisibility\(values\)/);
  assert.match(collections, /verification:\s*\{[\s\S]*consent:\s*consentGiven/);
  assert.doesNotMatch(
    collections,
    /renderPublicFields\(readValues\(false\)\.values\)/,
  );
});
