const { put, del } = require("@vercel/blob");
const {
  randomId,
  ttlFromEnvelope,
  envelopeByteSize,
  MAX_BLOB_BYTES,
  MAX_FILE_BYTES,
} = require("./capsule");
const { getKv } = require("./kv");

function isBlobConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function normalizeRecord(record) {
  if (!record) return null;
  if (record.envelope && !record.storage) {
    return { storage: "inline", envelope: record.envelope, burnAfterRead: record.burnAfterRead };
  }
  return record;
}

async function saveCapsule(envelope) {
  const kv = getKv();
  const size = envelopeByteSize(envelope);

  if (size > MAX_FILE_BYTES) {
    const error = new Error("Capsule exceeds 5 MB limit.");
    error.code = "TOO_LARGE";
    throw error;
  }

  const ttl = ttlFromEnvelope(envelope);
  const burnAfterRead = Array.isArray(envelope.guards) && envelope.guards.includes("burn-after-read");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = randomId();
    const existing = await kv.get(`capsule:${id}`);
    if (existing) continue;

    if (size <= MAX_BLOB_BYTES) {
      await kv.set(
        `capsule:${id}`,
        { storage: "inline", envelope, burnAfterRead },
        { ex: ttl },
      );
      return { id, storage: "inline" };
    }

    if (!isBlobConfigured()) {
      const error = new Error(
        "File drop is too large for link storage. Download the portable capsule instead.",
      );
      error.code = "BLOB_REQUIRED";
      throw error;
    }

    const blob = await put(`capsules/${id}.json`, JSON.stringify(envelope), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    await kv.set(
      `capsule:${id}`,
      { storage: "blob", blobUrl: blob.url, burnAfterRead },
      { ex: ttl },
    );
    return { id, storage: "blob" };
  }

  throw new Error("Could not allocate a short id.");
}

async function loadCapsule(id) {
  const kv = getKv();
  const record = normalizeRecord(await kv.get(`capsule:${id}`));
  if (!record) return null;

  let envelope;
  if (record.storage === "inline") {
    envelope = record.envelope;
  } else if (record.storage === "blob" && record.blobUrl) {
    const response = await fetch(record.blobUrl);
    if (!response.ok) return null;
    envelope = await response.json();
  } else {
    return null;
  }

  if (record.burnAfterRead) {
    await kv.del(`capsule:${id}`);
    if (record.storage === "blob" && record.blobUrl && isBlobConfigured()) {
      try {
        await del(record.blobUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
      } catch {
        // blob may already be gone
      }
    }
  }

  return envelope;
}

module.exports = { saveCapsule, loadCapsule, isBlobConfigured };
