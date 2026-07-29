const { Redis } = require("@upstash/redis");

function resolveKvCredentials() {
  let url = process.env.KV_REST_API_URL;
  let token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    for (const key of Object.keys(process.env)) {
      const value = process.env[key];
      if (!value) continue;
      if (!url && key.endsWith("_KV_REST_API_URL")) url = value;
      if (!token && key.endsWith("_KV_REST_API_TOKEN") && !key.includes("READ_ONLY")) {
        token = value;
      }
    }
  }

  return {
    url: url || process.env.UPSTASH_REDIS_REST_URL,
    token: token || process.env.UPSTASH_REDIS_REST_TOKEN,
  };
}

let client = null;

const LOCK_RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

function getKv() {
  const { url, token } = resolveKvCredentials();
  if (!url || !token) return null;
  if (!client) client = new Redis({ url, token });
  return client;
}

function isKvConfigured() {
  const { url, token } = resolveKvCredentials();
  return Boolean(url && token);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function releaseLock(kv, key, token) {
  try {
    await kv.eval(LOCK_RELEASE_SCRIPT, [key], [token]);
  } catch {
    // The short expiry is the final safety net if Redis is unavailable here.
  }
}

async function withRedisLock(kv, key, operation, options = {}) {
  const ttlSeconds = options.ttlSeconds || 15;
  const attempts = options.attempts || 20;
  const token = require("crypto").randomBytes(24).toString("base64url");

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const acquired = await kv.set(key, token, { nx: true, ex: ttlSeconds });
    if (acquired) {
      try {
        return await operation();
      } finally {
        await releaseLock(kv, key, token);
      }
    }
    await sleep(20 + Math.floor(Math.random() * 35));
  }

  const error = new Error("The resource is busy. Try again.");
  error.code = "LOCK_TIMEOUT";
  throw error;
}

module.exports = {
  getKv,
  isKvConfigured,
  resolveKvCredentials,
  withRedisLock,
};
