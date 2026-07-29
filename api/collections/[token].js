const crypto = require("crypto");
const { envelopeByteSize, MAX_FILE_BYTES, clientIp, checkRateLimit } = require("../_lib/capsule");
const { getKv, isKvConfigured, withRedisLock } = require("../_lib/kv");
const {
  parseOptionalDate,
  collectionTtl,
  burnSubmission,
  applyRetention,
} = require("../_lib/collection");

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("base64url");
}

function receiptId() {
  return `RCPT-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

function submissionId() {
  return crypto.randomBytes(10).toString("base64url");
}

function audit(type, extra = {}) {
  return { type, at: Date.now(), ...extra };
}

function requestError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function publicState(record) {
  const now = Date.now();
  const opensAt = record.publicMeta?.openAt ? new Date(record.publicMeta.openAt).getTime() : 0;
  const expiresAt = record.publicMeta?.expiresAt ? new Date(record.publicMeta.expiresAt).getTime() : 0;
  const maxRetentionAt = Number(record.storageExpiresAt) || 0;
  const totalSubmissions = (record.submissions || []).length;
  if (record.status === "revoked") return { status: "revoked", message: "This secure link has been revoked." };
  if (record.status === "completed") return { status: "submitted", message: "This secure link has already been completed." };
  if (opensAt && now < opensAt) return { status: "pending", message: "This secure link is not open yet." };
  if (maxRetentionAt && now >= maxRetentionAt) return { status: "expired", message: "This secure link has reached its maximum retention period." };
  if (expiresAt && now >= expiresAt) return { status: "expired", message: "This secure link has expired." };
  if (totalSubmissions >= Number(record.publicPolicy?.maxSubmissions || 1)) return { status: "maxed", message: "Maximum submission count reached." };
  return { status: "active", message: "Active" };
}

function publicPayload(record) {
  const state = publicState(record);
  const policy = record.publicPolicy || {};
  return {
    kind: record.kind,
    status: state.status,
    message: state.message,
    encryptedTemplate: record.encryptedTemplate,
    publicPolicy: {
      oneTime: Boolean(policy.oneTime),
      autoClose: Boolean(policy.autoClose),
      requirePassword: Boolean(policy.requirePassword),
      requireOtp: Boolean(policy.requireOtp),
      requireConsent: Boolean(policy.requireConsent),
      requireEmailVerification: Boolean(policy.allowedEmailHash),
      maxSubmissions: Number(policy.maxSubmissions || 1),
      submissionCount: (record.submissions || []).length,
    },
    expiresAt: record.publicMeta?.expiresAt || "",
    maxRetentionAt: record.publicMeta?.maxRetentionAt || "",
  };
}

function ownerPayload(record) {
  return {
    ...publicPayload(record),
    retention: record.retention || {},
    audit: record.audit || [],
    submissions: (record.submissions || []).map((item) => ({
      id: item.id,
      receiptId: item.receiptId,
      submittedAt: item.submittedAt,
      status: item.status,
      burnStatus: item.burnStatus || "stored",
      encryptedPayload: item.status === "burned" ? null : item.encryptedPayload,
    })),
  };
}

async function save(kv, key, record) {
  await kv.set(key, record, { ex: collectionTtl(record) });
}

function parseBody(req) {
  try {
    return typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch {
    throw requestError(400, "Invalid JSON body.");
  }
}

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST", "PATCH", "DELETE"].includes(req.method)) {
    res.setHeader("Allow", "GET,POST,PATCH,DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!isKvConfigured()) return res.status(503).json({ error: "KV storage is not configured." });

  const token = req.query.token;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,80}$/.test(token)) {
    return res.status(400).json({ error: "Invalid secure link." });
  }

  const tokenHash = hashToken(token);
  const key = `collection:${tokenHash}`;
  const lockKey = `lock:${key}`;
  const kv = getKv();

  if (req.method === "POST") {
    if (!(await checkRateLimit(kv, clientIp(req), "collection-submit"))) {
      return res.status(429).json({ error: "Too many submissions. Try again later." });
    }
  }

  let body = {};
  if (req.method !== "GET") {
    try {
      body = parseBody(req);
    } catch (error) {
      return res.status(error.status).json({ error: error.message });
    }
  }

  try {
    const result = await withRedisLock(kv, lockKey, async () => {
      const record = await kv.get(key);
      if (!record) throw requestError(404, "Secure link not found or expired.");

      const ownerToken = req.query.owner || "";
      const isOwner = Boolean(ownerToken) && hashToken(ownerToken) === record.ownerHash;
      const retentionBurned = applyRetention(record);

      if (req.method === "GET") {
        if (retentionBurned) await save(kv, key, record);
        return { status: 200, payload: isOwner ? ownerPayload(record) : publicPayload(record) };
      }

      if (req.method === "POST") {
        const encryptedPayload = body.encryptedPayload;
        if (!encryptedPayload?.ciphertext || !encryptedPayload?.iv) {
          throw requestError(400, "Invalid encrypted submission.");
        }
        if (envelopeByteSize(encryptedPayload) > MAX_FILE_BYTES) {
          throw requestError(413, "Encrypted submission exceeds the 4.5 MB Vercel request limit.");
        }

        const state = publicState(record);
        if (state.status !== "active") {
          if (retentionBurned) await save(kv, key, record);
          throw requestError(409, state.message);
        }

        const verification = body.verification || {};
        const policy = record.publicPolicy || {};
        const verificationFailed =
          (policy.allowedEmailHash && verification.emailHash !== policy.allowedEmailHash) ||
          (policy.requirePassword && verification.passwordHash !== policy.accessPasswordHash) ||
          (policy.requireOtp && verification.otpHash !== policy.otpHash) ||
          (policy.requireConsent && verification.consent !== true);
        if (verificationFailed) {
          if (retentionBurned) await save(kv, key, record);
          throw requestError(403, "Verification failed.");
        }

        const submittedAt = Date.now();
        const item = {
          id: submissionId(),
          receiptId: receiptId(),
          submittedAt,
          status: "stored",
          encryptedPayload,
        };
        record.submissions = [...(record.submissions || []), item];
        record.audit = [...(record.audit || []), audit("submission_received", { receiptId: item.receiptId })];
        const total = record.submissions.length;
        const maximum = Number(policy.maxSubmissions || 1);
        if (policy.oneTime || (policy.autoClose && total >= maximum)) record.status = "completed";
        applyRetention(record);
        await save(kv, key, record);
        const storedItem = record.submissions.find((submission) => submission.id === item.id);
        return {
          status: 201,
          payload: { receiptId: item.receiptId, submittedAt, status: storedItem?.status || item.status },
        };
      }

      if (!isOwner) {
        if (retentionBurned) await save(kv, key, record);
        throw requestError(403, "Owner authorization required.");
      }

      if (req.method === "PATCH") {
        if (body.action === "revoke") {
          record.status = "revoked";
          record.audit = [...(record.audit || []), audit("link_revoked")];
          await save(kv, key, record);
          return { status: 200, payload: { status: "revoked" } };
        }

        if (body.action === "extend") {
          const expiresAt = parseOptionalDate(body.expiresAt, "expiresAt");
          if (!expiresAt) throw requestError(400, "expiresAt is required.");
          const expiryMs = new Date(expiresAt).getTime();
          if (expiryMs <= Date.now()) throw requestError(400, "expiresAt must be in the future.");
          if (expiryMs > Number(record.storageExpiresAt)) {
            throw requestError(400, "expiresAt cannot exceed the collection's maxRetentionAt.");
          }
          const openMs = record.publicMeta?.openAt
            ? new Date(record.publicMeta.openAt).getTime()
            : 0;
          if (openMs && expiryMs <= openMs) {
            throw requestError(400, "expiresAt must be after openAt.");
          }
          record.publicMeta = { ...(record.publicMeta || {}), expiresAt };
          if (record.status === "expired") record.status = "active";
          record.audit = [...(record.audit || []), audit("deadline_extended", { expiresAt })];
          await save(kv, key, record);
          return { status: 200, payload: { status: publicState(record).status, expiresAt } };
        }

        throw requestError(400, "Unsupported owner action.");
      }

      const target = typeof req.query.submission === "string" ? req.query.submission : "";
      const submissions = record.submissions || [];
      if (target && !submissions.some((item) => item.id === target)) {
        if (retentionBurned) await save(kv, key, record);
        throw requestError(404, "Submission not found.");
      }

      let burned = 0;
      const burnedAt = Date.now();
      record.submissions = submissions.map((item) => {
        if (item.status === "burned" || (target && item.id !== target)) return item;
        burned += 1;
        return burnSubmission(item, burnedAt);
      });
      record.audit = [
        ...(record.audit || []),
        audit(target ? "submission_burned" : "submissions_burned", { count: burned }),
      ];
      await save(kv, key, record);
      return {
        status: 200,
        payload: {
          burned,
          note: "Encrypted payloads were removed; audit receipts remain. Exported copies are outside this burn action.",
        },
      };
    });

    return res.status(result.status).json(result.payload);
  } catch (error) {
    const status = error.status || (error.code === "LOCK_TIMEOUT" ? 409 : 500);
    return res.status(status).json({ error: error.message || "Collection operation failed." });
  }
}

module.exports = handler;
module.exports.publicState = publicState;
module.exports.publicPayload = publicPayload;
