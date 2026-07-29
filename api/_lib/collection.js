const MAX_COLLECTION_TTL_SEC = 90 * 24 * 60 * 60;
const MIN_COLLECTION_TTL_SEC = 60;
const VALID_RETENTION_MODES = new Set(["view", "export", "86400000", "604800000", "close", "manual"]);

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function parseOptionalDate(value, field) {
  if (value === undefined || value === null || value === "") return "";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw validationError(`${field} must be a valid date.`);
  return new Date(timestamp).toISOString();
}

function validateHash(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw validationError(`${field} must be a SHA-256 base64url hash.`);
  }
}

function normalizeCreation(body, now = Date.now()) {
  const publicMeta = body.publicMeta || {};
  const policy = body.publicPolicy || {};
  const retention = body.retention || {};
  const openAt = parseOptionalDate(publicMeta.openAt, "openAt");
  const expiresAt = parseOptionalDate(
    publicMeta.expiresAt || body.encryptedTemplate?.expiresAt,
    "expiresAt",
  );
  const openMs = openAt ? new Date(openAt).getTime() : 0;
  const expiryMs = expiresAt ? new Date(expiresAt).getTime() : 0;

  if (expiryMs && expiryMs <= now) throw validationError("expiresAt must be in the future.");
  if (openMs && expiryMs && openMs >= expiryMs) {
    throw validationError("openAt must be before expiresAt.");
  }

  const maxSubmissions = Number(policy.maxSubmissions);
  if (!Number.isInteger(maxSubmissions) || maxSubmissions < 1 || maxSubmissions > 500) {
    throw validationError("maxSubmissions must be an integer between 1 and 500.");
  }
  if (policy.requirePassword) validateHash(policy.accessPasswordHash, "accessPasswordHash");
  if (policy.requireOtp) validateHash(policy.otpHash, "otpHash");
  if (policy.allowedEmailHash) validateHash(policy.allowedEmailHash, "allowedEmailHash");

  const mode = String(retention.mode || "manual");
  if (!VALID_RETENTION_MODES.has(mode)) {
    throw validationError("retention.mode is invalid.");
  }

  const storageExpiresAt = now + MAX_COLLECTION_TTL_SEC * 1000;
  if (expiryMs > storageExpiresAt) {
    throw validationError("expiresAt cannot exceed the 90-day collection retention limit.");
  }

  return {
    openAt,
    expiresAt,
    maxSubmissions,
    retentionMode: mode,
    storageExpiresAt,
  };
}

function collectionTtl(record, now = Date.now()) {
  const deadline = Number(record.storageExpiresAt);
  if (!Number.isFinite(deadline)) return MAX_COLLECTION_TTL_SEC;
  return Math.min(
    MAX_COLLECTION_TTL_SEC,
    Math.max(MIN_COLLECTION_TTL_SEC, Math.ceil((deadline - now) / 1000)),
  );
}

function burnSubmission(item, burnedAt) {
  return {
    id: item.id,
    receiptId: item.receiptId,
    submittedAt: item.submittedAt,
    status: "burned",
    burnStatus: "encrypted_payload_removed",
    burnedAt,
  };
}

function applyRetention(record, now = Date.now()) {
  const mode = String(record.retention?.mode || "manual");
  let cutoff = 0;
  let reason = "";
  if (mode === "86400000" || mode === "604800000") {
    cutoff = now - Number(mode);
    reason = mode === "86400000" ? "24_hours" : "7_days";
  } else if (mode === "close") {
    const expiresAt = record.publicMeta?.expiresAt
      ? new Date(record.publicMeta.expiresAt).getTime()
      : 0;
    const storageExpiresAt = Number(record.storageExpiresAt) || 0;
    if (
      record.status === "completed" ||
      (expiresAt && now >= expiresAt) ||
      (storageExpiresAt && now >= storageExpiresAt)
    ) {
      cutoff = Number.POSITIVE_INFINITY;
      reason = "collection_closed";
    }
  }
  if (!cutoff) return 0;

  let burned = 0;
  record.submissions = (record.submissions || []).map((item) => {
    if (item.status === "burned" || Number(item.submittedAt) > cutoff) return item;
    burned += 1;
    return burnSubmission(item, now);
  });
  if (burned) {
    record.audit = [
      ...(record.audit || []),
      { type: "retention_burn", at: now, count: burned, reason },
    ];
  }
  return burned;
}

module.exports = {
  MAX_COLLECTION_TTL_SEC,
  parseOptionalDate,
  normalizeCreation,
  collectionTtl,
  burnSubmission,
  applyRetention,
};
