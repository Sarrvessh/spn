const { put, del } = require("@vercel/blob");
const {
  randomId,
  ttlFromEnvelope,
  envelopeByteSize,
  MAX_BLOB_BYTES,
  MAX_FILE_BYTES,
} = require("./capsule");
const { getKv, withRedisLock } = require("./kv");

const BLOB_EXPIRY_INDEX = "capsule:blob-expiries:v1";
const PENDING_TTL_SEC = 60 * 60;

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

async function deleteBlobQuietly(blobUrl) {
  if (!blobUrl || !isBlobConfigured()) return false;
  try {
    await del(blobUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
    return true;
  } catch {
    // Opportunistic cleanup will retry indexed expired blobs.
    return false;
  }
}

async function cleanupExpiredBlobs(kv, limit = 10, strict = false) {
  if (!isBlobConfigured()) return 0;
  let deleted = 0;
  try {
    const urls = await kv.zrange(BLOB_EXPIRY_INDEX, 0, Date.now(), {
      byScore: true,
      count: limit,
      offset: 0,
    });
    for (const url of urls || []) {
      if (await deleteBlobQuietly(url)) {
        await kv.zrem(BLOB_EXPIRY_INDEX, url);
        deleted += 1;
      }
    }
  } catch (error) {
    if (strict) throw error;
    // Cleanup must not make a healthy capsule request fail.
  }
  return deleted;
}

function blobError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

async function saveCapsule(envelope) {
  const kv = getKv();
  const size = envelopeByteSize(envelope);

  if (size > MAX_FILE_BYTES) {
    const error = new Error("Capsule exceeds the 4.5 MB Vercel request limit.");
    error.code = "TOO_LARGE";
    throw error;
  }

  const ttl = ttlFromEnvelope(envelope);
  const expiresAt = Date.now() + ttl * 1000;
  const burnAfterRead = Array.isArray(envelope.guards) && envelope.guards.includes("burn-after-read");
  await cleanupExpiredBlobs(kv);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = randomId();
    const existing = await kv.get(`capsule:${id}`);
    if (existing) continue;

    if (size <= MAX_BLOB_BYTES || !isBlobConfigured()) {
      await kv.set(
        `capsule:${id}`,
        { storage: "inline", envelope, burnAfterRead, expiresAt },
        { ex: ttl },
      );
      return { id, storage: "inline" };
    }

    // The linked store is currently public. Independent high-entropy path
    // material prevents deriving the Blob URL from the public short id.
    const blobPath = `capsules/${randomId()}-${require("crypto").randomBytes(24).toString("base64url")}.json`;
    const blob = await put(blobPath, JSON.stringify(envelope), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    try {
      await kv.set(
        `capsule:${id}`,
        { storage: "blob", blobUrl: blob.url, burnAfterRead, expiresAt },
        { ex: ttl },
      );
    } catch (error) {
      if (!(await deleteBlobQuietly(blob.url))) {
        try {
          await kv.zadd(BLOB_EXPIRY_INDEX, { score: expiresAt, member: blob.url });
        } catch {
          // There is no further cleanup mechanism if both storage systems fail.
        }
      }
      throw error;
    }
    try {
      await kv.zadd(BLOB_EXPIRY_INDEX, { score: expiresAt, member: blob.url });
    } catch {
      // The live pointer remains valid; only opportunistic expiry cleanup is degraded.
    }
    return { id, storage: "blob" };
  }

  throw new Error("Could not allocate a short id.");
}

async function initCapsule({ kind = "capsule", expiresAt = null } = {}) {
  const kv = getKv();
  await cleanupExpiredBlobs(kv);
  const createdAt = Date.now();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = randomId();
    const key = `capsule:${id}`;
    const existing = await kv.get(key);
    if (existing) continue;

    await kv.set(
      key,
      {
        storage: "pending",
        status: "pending",
        kind,
        createdAt,
        expiresAt,
        uploads: [],
      },
      { ex: PENDING_TTL_SEC },
    );
    return { id, status: "pending", expiresAt: createdAt + PENDING_TTL_SEC * 1000 };
  }

  throw new Error("Could not allocate a short id.");
}

async function registerPendingBlob(id, blob) {
  const kv = getKv();
  const key = `capsule:${id}`;
  return withRedisLock(kv, `lock:${key}:uploads`, async () => {
    const record = normalizeRecord(await kv.get(key));
    if (!record || record.storage !== "pending" || record.status !== "pending") {
      const error = new Error("Pending capsule not found.");
      error.code = "PENDING_NOT_FOUND";
      throw error;
    }
    const uploads = Array.isArray(record.uploads) ? record.uploads : [];
    const next = {
      ...record,
      uploads: uploads.concat({
        url: blob.url,
        downloadUrl: blob.downloadUrl,
        pathname: blob.pathname,
        size: blob.size,
        contentType: blob.contentType,
        uploadedAt: blob.uploadedAt || new Date().toISOString(),
      }),
    };
    await kv.set(key, next, { ex: PENDING_TTL_SEC });
    return next.uploads.length;
  });
}

async function completeCapsule(id, envelope) {
  const kv = getKv();
  const key = `capsule:${id}`;
  return withRedisLock(kv, `lock:${key}:complete`, async () => {
    const pending = normalizeRecord(await kv.get(key));
    if (!pending || pending.storage !== "pending" || pending.status !== "pending") {
      const error = new Error("Pending capsule not found.");
      error.code = "PENDING_NOT_FOUND";
      throw error;
    }

    const size = envelopeByteSize(envelope);
    if (size > MAX_FILE_BYTES) {
      const error = new Error("Capsule exceeds the 4.5 MB Vercel request limit.");
      error.code = "TOO_LARGE";
      throw error;
    }

    const ttl = ttlFromEnvelope(envelope);
    const expiresAt = Date.now() + ttl * 1000;
    const burnAfterRead = Array.isArray(envelope.guards) && envelope.guards.includes("burn-after-read");

    if (size <= MAX_BLOB_BYTES || !isBlobConfigured()) {
      await kv.set(
        key,
        {
          storage: "inline",
          envelope,
          burnAfterRead,
          expiresAt,
          uploads: pending.uploads || [],
        },
        { ex: ttl },
      );
      try {
        for (const upload of pending.uploads || []) {
          if (upload.url) await kv.zadd(BLOB_EXPIRY_INDEX, { score: expiresAt, member: upload.url });
        }
      } catch {
        // Link stays usable; cleanup can fall back to TTL metadata.
      }
      return { id, storage: "inline" };
    }

    const blobPath = `capsules/${randomId()}-${require("crypto").randomBytes(24).toString("base64url")}.json`;
    const blob = await put(blobPath, JSON.stringify(envelope), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    try {
      await kv.set(
        key,
        {
          storage: "blob",
          blobUrl: blob.url,
          burnAfterRead,
          expiresAt,
          uploads: pending.uploads || [],
        },
        { ex: ttl },
      );
    } catch (error) {
      await deleteBlobQuietly(blob.url);
      throw error;
    }

    try {
      await kv.zadd(BLOB_EXPIRY_INDEX, { score: expiresAt, member: blob.url });
      for (const upload of pending.uploads || []) {
        if (upload.url) await kv.zadd(BLOB_EXPIRY_INDEX, { score: expiresAt, member: upload.url });
      }
    } catch {
      // Link stays usable; cleanup can fall back to TTL metadata.
    }

    return { id, storage: "blob" };
  });
}

async function completeUploadedCapsule(id, uploadedBlob) {
  const kv = getKv();
  const key = `capsule:${id}`;
  return withRedisLock(kv, `lock:${key}:complete`, async () => {
    const pending = normalizeRecord(await kv.get(key));
    if (!pending || pending.storage !== "pending" || pending.status !== "pending") {
      const error = new Error("Pending capsule not found.");
      error.code = "PENDING_NOT_FOUND";
      throw error;
    }

    const upload = uploadedBlob || {};
    const pathname = String(upload.pathname || "");
    const url = String(upload.url || "");
    if (!pathname.startsWith(`capsules/uploads/${id}/`) || !url) {
      const error = new Error("Uploaded capsule payload is not linked to this short id.");
      error.code = "UPLOAD_MISMATCH";
      throw error;
    }

    let response;
    try {
      response = await fetch(url);
    } catch {
      throw blobError("Blob storage is temporarily unavailable.", "BLOB_UNAVAILABLE", 503);
    }
    if (!response.ok) {
      throw blobError("Blob storage could not return the uploaded capsule.", "BLOB_UNAVAILABLE", 503);
    }

    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw blobError("Uploaded Blob is not a valid encrypted capsule.", "BLOB_INVALID", 422);
    }
    if (!envelope?.ciphertext || !envelope?.iv) {
      throw blobError("Uploaded Blob is not a valid encrypted capsule.", "BLOB_INVALID", 422);
    }

    const ttl = ttlFromEnvelope(envelope);
    const expiresAt = Date.now() + ttl * 1000;
    const burnAfterRead = Array.isArray(envelope.guards) && envelope.guards.includes("burn-after-read");

    await kv.set(
      key,
      {
        storage: "blob",
        blobUrl: url,
        burnAfterRead,
        expiresAt,
        uploads: pending.uploads || [],
      },
      { ex: ttl },
    );
    try {
      await kv.zadd(BLOB_EXPIRY_INDEX, { score: expiresAt, member: url });
    } catch {
      // The live pointer remains valid; only opportunistic expiry cleanup is degraded.
    }
    return { id, storage: "blob" };
  });
}

async function readCapsuleRecord(kv, key, record, consume) {
  if (record.expiresAt && Date.now() >= Number(record.expiresAt)) {
    await kv.del(key);
    if (record.storage === "blob") await deleteBlobQuietly(record.blobUrl);
    return null;
  }

  let envelope;
  if (record.storage === "inline") {
    envelope = record.envelope;
  } else if (record.storage === "blob" && record.blobUrl) {
    let response;
    try {
      response = await fetch(record.blobUrl);
    } catch {
      throw blobError("Blob storage is temporarily unavailable.", "BLOB_UNAVAILABLE", 503);
    }
    if (response.status === 404) {
      throw blobError("Capsule metadata exists but its Blob payload is missing.", "BLOB_MISSING", 502);
    }
    if (!response.ok) {
      throw blobError("Blob storage could not return the capsule.", "BLOB_UNAVAILABLE", 503);
    }
    try {
      envelope = await response.json();
    } catch {
      throw blobError("Blob storage returned an invalid capsule payload.", "BLOB_INVALID", 502);
    }
  } else {
    throw blobError("Capsule storage metadata is invalid.", "BLOB_INVALID", 502);
  }

  if (consume) {
    await kv.del(key);
    if (record.storage === "blob" && record.blobUrl) {
      if (await deleteBlobQuietly(record.blobUrl)) {
        try {
          await kv.zrem(BLOB_EXPIRY_INDEX, record.blobUrl);
        } catch {
          // The cleanup index can safely retain a stale member.
        }
      }
    }
  }

  return envelope;
}

async function loadCapsule(id, options = {}) {
  const kv = getKv();
  await cleanupExpiredBlobs(kv);
  const key = `capsule:${id}`;
  const initial = normalizeRecord(await kv.get(key));
  if (!initial) return null;

  if (!initial.burnAfterRead) {
    return readCapsuleRecord(kv, key, initial, false);
  }
  if (!options.consumeBurn) {
    throw blobError(
      "Burn-after-read capsules require an explicit open request.",
      "BURN_REQUIRES_CONSUME",
      409,
    );
  }

  return withRedisLock(kv, `lock:${key}:consume`, async () => {
    const record = normalizeRecord(await kv.get(key));
    if (!record) return null;
    return readCapsuleRecord(kv, key, record, true);
  });
}

module.exports = {
  saveCapsule,
  initCapsule,
  completeCapsule,
  completeUploadedCapsule,
  registerPendingBlob,
  loadCapsule,
  isBlobConfigured,
  cleanupExpiredBlobs,
};
