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

module.exports = { getKv, isKvConfigured, resolveKvCredentials };
