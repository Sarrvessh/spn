const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const PACK_STORAGE_KEY = "prompt-capsule-recent-pack";
const COLLECTION_STORAGE_KEY = "capsule-secure-collections";
const PACK_LIMIT = 25;
const ATTACH_MAX_FILES = 5;
const ATTACH_MAX_EACH = 2 * 1024 * 1024;
const ATTACH_MAX_TOTAL = 5 * 1024 * 1024;
const ATTACH_EXT = /\.(jpe?g|png|gif|webp|pdf|txt|md|json|csv|zip)$/i;
const DIRECT_UPLOAD_THRESHOLD = Math.floor(3.8 * 1024 * 1024);
const VERCEL_BLOB_API_URL = "https://vercel.com/api/blob";
const VERCEL_BLOB_API_VERSION = "12";

const state = {
  promptResult: {
    envelope: null,
    keyParam: "",
  },
  fileResult: {
    envelope: null,
    keyParam: "",
  },
  currentCapsule: null,
  pendingEnvelope: null,
  pendingKeyParam: "",
  importedPack: null,
  pendingAttachments: [],
  receiveOperation: 0,
  navigationOperation: 0,
  navigationInFlight: false,
  collections: {
    requestFields: [],
    formFields: [],
    requestDashboard: null,
    formDashboard: null,
    publicContext: null,
  },
  screen: "home",
};

const $ = (id) => document.getElementById(id);

const createPanel = $("createPanel");
const receivePanel = $("receivePanel");
const form = $("capsuleForm");
const fileForm = $("fileForm");
const shareLink = $("shareLink");
const linkSize = $("linkSize");
const linkWarning = $("linkWarning");
const createStatus = $("createStatus");
const receiveStatus = $("receiveStatus");
const passwordProtect = $("passwordProtect");
const autoExpiry = $("autoExpiry");
const scheduledUnlock = $("scheduledUnlock");
const passwordField = $("passwordField");
const expiryField = $("expiryField");
const unlockField = $("unlockField");
const passwordUnlock = $("passwordUnlock");
const capsuleView = $("capsuleView");
const keySummary = $("keySummary");
const receiveEmpty = $("receiveEmpty");
const createSeal = $("createSeal");
const viewSeal = $("viewSeal");
const packList = $("packList");
const attachmentList = $("attachmentList");
const attachStatus = $("attachStatus");
const resultHint = $("resultHint");
const resultPanel = document.querySelector("#promptScreen .result");
const fileResultPanel = document.querySelector("#fileScreen .result");

const filePasswordProtect = $("filePasswordProtect");
const fileAutoExpiry = $("fileAutoExpiry");
const fileScheduledUnlock = $("fileScheduledUnlock");
const filePasswordField = $("filePasswordField");
const fileExpiryField = $("fileExpiryField");
const fileUnlockField = $("fileUnlockField");
const fileShareLink = $("fileShareLink");
const fileLinkSize = $("fileLinkSize");
const fileLinkWarning = $("fileLinkWarning");
const fileCreateSeal = $("fileCreateSeal");
const fileStatus = $("fileStatus");
const fileResultHint = $("fileResultHint");
const attachBudget = $("attachBudget");
const attachCount = $("attachCount");
const attachTotal = $("attachTotal");
const attachBudgetFill = $("attachBudgetFill");
const attachBudgetTrack = $("attachBudgetTrack");
const attachShareMode = $("attachShareMode");
const fileCreateNote = $("fileCreateNote");

function bytesToBase64Url(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodeJson(value) {
  return bytesToBase64Url(textEncoder.encode(JSON.stringify(value)));
}

function decodeJson(value) {
  return JSON.parse(textDecoder.decode(base64UrlToBytes(value)));
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function u32Bytes(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function readU32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

function base64ToUint8(base64) {
  const binary = atob(base64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deflateBytes(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function packCapsuleBinary(capsule) {
  const attachments = Array.isArray(capsule.attachments) ? capsule.attachments : [];
  const meta = {
    ...capsule,
    attachments: attachments.map(({ id, name, type, size }) => ({ id, name, type, size })),
  };
  const metaBytes = textEncoder.encode(JSON.stringify(meta));
  const parts = [u32Bytes(metaBytes.length), metaBytes];
  for (const attachment of attachments) {
    const data = base64ToUint8(attachment.data);
    parts.push(u32Bytes(data.length), data);
  }
  return concatBytes(parts);
}

function unpackCapsuleBinary(bytes) {
  let offset = 0;
  const metaLen = readU32(bytes, offset);
  offset += 4;
  const meta = JSON.parse(textDecoder.decode(bytes.subarray(offset, offset + metaLen)));
  offset += metaLen;
  const attachments = Array.isArray(meta.attachments) ? meta.attachments : [];
  meta.attachments = attachments.map((item) => {
    const length = readU32(bytes, offset);
    offset += 4;
    const data = bytes.subarray(offset, offset + length);
    offset += length;
    return {
      ...item,
      data: arrayBufferToBase64(data),
    };
  });
  return meta;
}

async function capsuleToPlaintext(capsule) {
  const packed = packCapsuleBinary(capsule);
  const compressed = await deflateBytes(packed);
  if (compressed && compressed.length < packed.length) {
    return { bytes: compressed, pack: "bin-deflate-v1" };
  }
  return { bytes: packed, pack: "bin-v1" };
}

async function plaintextToCapsule(bytes, pack) {
  if (!pack) {
    return JSON.parse(textDecoder.decode(bytes));
  }
  const packed = pack === "bin-deflate-v1" ? await inflateBytes(bytes) : bytes;
  return unpackCapsuleBinary(packed);
}

async function encodeEnvelopePayload(envelope) {
  const jsonBytes = textEncoder.encode(JSON.stringify(envelope));
  const compressed = await deflateBytes(jsonBytes);
  if (compressed && compressed.length < jsonBytes.length) {
    return `z.${bytesToBase64Url(compressed)}`;
  }
  return bytesToBase64Url(jsonBytes);
}

async function decodeEnvelopePayload(value) {
  if (value.startsWith("z.")) {
    const inflated = await inflateBytes(base64UrlToBytes(value.slice(2)));
    return JSON.parse(textDecoder.decode(inflated));
  }
  return decodeJson(value);
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function importAesKey(rawKey) {
  return crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function generateShareKey() {
  const rawKey = randomBytes(32);
  return {
    rawKey,
    cryptoKey: await importAesKey(rawKey),
  };
}

async function derivePasswordKey(password, salt) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 210000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function integritySeal(ciphertext) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(ciphertext || ""));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 12).toUpperCase();
}

async function encryptCapsule(capsule, options) {
  const iv = randomBytes(12);
  const id = Array.from(randomBytes(16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  let keyParam = "";
  let cryptoKey;
  let kdf = null;

  if (options.password) {
    const salt = randomBytes(16);
    cryptoKey = await derivePasswordKey(options.password, salt);
    kdf = {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: 210000,
      salt: bytesToBase64Url(salt),
    };
  } else {
    const generated = await generateShareKey();
    cryptoKey = generated.cryptoKey;
    keyParam = bytesToBase64Url(generated.rawKey);
  }

  const packed = await capsuleToPlaintext(capsule);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, packed.bytes);
  const ciphertext = bytesToBase64Url(new Uint8Array(encrypted));
  const guards = [];

  if (options.burnAfterRead) guards.push("burn-after-read");
  if (options.password) guards.push("password-protected");
  if (options.expiresAt) guards.push("auto-expiry");
  if (options.unlockAt) guards.push("scheduled-unlock");

  return {
    keyParam,
    envelope: {
      id,
      iv: bytesToBase64Url(iv),
      ciphertext,
      pack: packed.pack,
      label: options.label || "prod",
      guards,
      createdAt: Date.now(),
      expiresAt: options.expiresAt,
      unlockAt: options.unlockAt,
      kdf,
      alg: "AES-256-GCM",
      title: capsule.title || "Untitled Capsule",
      seal: await integritySeal(ciphertext),
    },
  };
}

async function decryptCapsule(envelope, keyParam, password) {
  const iv = base64UrlToBytes(envelope.iv);
  const ciphertext = base64UrlToBytes(envelope.ciphertext);
  let cryptoKey;

  if (envelope.kdf) {
    if (!password) throw new Error("Password required");
    cryptoKey = await derivePasswordKey(password, base64UrlToBytes(envelope.kdf.salt));
  } else {
    if (!keyParam) throw new Error("Missing link key");
    cryptoKey = await importAesKey(base64UrlToBytes(keyParam));
  }

  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
  return plaintextToCapsule(new Uint8Array(decrypted), envelope.pack);
}

function parseVariables(input) {
  const value = input.trim();
  if (!value) return {};

  try {
    return JSON.parse(value);
  } catch {
    return Object.fromEntries(
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [key, ...rest] = line.split("=");
          return [key.trim(), rest.join("=").trim()];
        })
        .filter(([key]) => key),
    );
  }
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function fileKindLabel(item) {
  const type = item.type || "";
  const name = item.name || "";
  if (type.startsWith("image/")) return "Image";
  if (type === "application/pdf" || /\.pdf$/i.test(name)) return "PDF";
  if (type.includes("zip") || /\.zip$/i.test(name)) return "ZIP";
  if (type.includes("json") || /\.json$/i.test(name)) return "JSON";
  if (type.startsWith("text/") || /\.(txt|md|csv)$/i.test(name)) return "Text";
  return "File";
}

function isAllowedAttachment(file) {
  if (ATTACH_EXT.test(file.name)) return true;
  const type = file.type || "";
  return (
    type.startsWith("image/")
    || type === "application/pdf"
    || type.startsWith("text/")
    || type === "application/json"
    || type === "application/zip"
    || type === "application/x-zip-compressed"
  );
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBlob(base64, type) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: type || "application/octet-stream" });
}

function downloadAttachment(attachment) {
  const blob = base64ToBlob(attachment.data, attachment.type);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.name || "attachment";
  link.click();
  URL.revokeObjectURL(url);
}

function getFileShareExpectation(totalBytes, fileCount) {
  const countLabel = `${fileCount} / ${ATTACH_MAX_FILES} file${fileCount === 1 ? "" : "s"}`;
  const totalLabel = `${formatBytes(totalBytes)} / ${formatBytes(ATTACH_MAX_TOTAL)}`;
  const fillPct = Math.min(100, (totalBytes / ATTACH_MAX_TOTAL) * 100);

  if (!fileCount) {
    return {
      mode: "idle",
      budgetClass: "",
      fillPct: 0,
      countLabel: `0 / ${ATTACH_MAX_FILES} files`,
      totalLabel: `0 B / ${formatBytes(ATTACH_MAX_TOTAL)}`,
      message: "",
      createNote: "",
    };
  }

  if (totalBytes <= ATTACH_MAX_TOTAL) {
    return {
      mode: "short-link",
      budgetClass: "is-short-link",
      fillPct,
      countLabel,
      totalLabel,
      message: "Short /c/ link will be created for this drop.",
      createNote: "",
    };
  }

  return {
    mode: "over-limit",
    budgetClass: "is-over-limit",
    fillPct: 100,
    countLabel,
    totalLabel,
    message: "Over the 5 MB total limit.",
    createNote: "",
  };
}

function updateAttachBudget() {
  const files = state.pendingAttachments;
  const total = totalAttachmentSize(files);
  const expectation = getFileShareExpectation(total, files.length);

  if (attachBudget) {
    attachBudget.classList.toggle("is-hidden", expectation.mode === "idle");
    attachBudget.classList.remove("is-short-link", "is-portable", "is-over-limit");
    if (expectation.budgetClass) attachBudget.classList.add(expectation.budgetClass);
  }
  if (attachCount) attachCount.textContent = expectation.countLabel;
  if (attachTotal) attachTotal.textContent = expectation.totalLabel;
  if (attachBudgetFill) attachBudgetFill.style.width = `${expectation.fillPct}%`;
  if (attachBudgetTrack) {
    attachBudgetTrack.setAttribute("aria-valuenow", String(Math.round(expectation.fillPct)));
    attachBudgetTrack.setAttribute("aria-valuemin", "0");
    attachBudgetTrack.setAttribute("aria-valuemax", "100");
  }
  if (attachShareMode) attachShareMode.textContent = expectation.message;
  if (fileCreateNote) {
    fileCreateNote.textContent = expectation.createNote;
    fileCreateNote.classList.toggle("is-hidden", !expectation.createNote);
  }
  if (fileResultPanel) {
    fileResultPanel.classList.toggle("expects-portable", expectation.mode === "portable");
  }
}

function setFileResultMode(mode) {
  if (!fileResultPanel) return;
  fileResultPanel.classList.remove("expects-portable", "is-portable-fallback", "has-short-link");
  if (mode === "portable-fallback") fileResultPanel.classList.add("is-portable-fallback");
  if (mode === "short-link") fileResultPanel.classList.add("has-short-link");
}

function totalAttachmentSize(list) {
  return list.reduce((sum, item) => sum + (item.size || 0), 0);
}

async function readFileAsAttachment(file) {
  const buffer = await file.arrayBuffer();
  return {
    id: Array.from(randomBytes(8), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    data: arrayBufferToBase64(buffer),
  };
}

async function addAttachmentFiles(fileList) {
  const incoming = Array.from(fileList || []);
  if (!incoming.length) return;

  const next = [...state.pendingAttachments];
  const errors = [];

  for (const file of incoming) {
    if (next.length >= ATTACH_MAX_FILES) {
      errors.push(`Limit is ${ATTACH_MAX_FILES} files.`);
      break;
    }
    if (!isAllowedAttachment(file)) {
      errors.push(`${file.name}: unsupported type.`);
      continue;
    }
    if (file.size > ATTACH_MAX_EACH) {
      errors.push(`${file.name} exceeds 2 MB (max per file).`);
      continue;
    }
    if (totalAttachmentSize(next) + file.size > ATTACH_MAX_TOTAL) {
      errors.push(`Total exceeds 5 MB (max combined size).`);
      break;
    }
    if (next.some((item) => item.name === file.name && item.size === file.size)) {
      continue;
    }
    next.push(await readFileAsAttachment(file));
  }

  state.pendingAttachments = next;
  renderPendingAttachments();
  updateAttachBudget();
  if (errors.length) {
    setStatus(attachStatus, errors[0], true);
  } else {
    setStatus(
      attachStatus,
      next.length ? `${next.length} file(s) ready · ${formatBytes(totalAttachmentSize(next))}` : "",
    );
  }
}

function renderPendingAttachments() {
  if (!attachmentList) return;
  attachmentList.innerHTML = "";
  state.pendingAttachments.forEach((item) => {
    const li = document.createElement("li");
    li.className = "attach-chip";
    li.innerHTML = `<span class="attach-chip-kind"></span><div class="attach-chip-info"><strong></strong><span></span></div>`;
    li.querySelector(".attach-chip-kind").textContent = fileKindLabel(item);
    li.querySelector("strong").textContent = item.name;
    li.querySelector("span").textContent = formatBytes(item.size);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-attach";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      state.pendingAttachments = state.pendingAttachments.filter((entry) => entry.id !== item.id);
      renderPendingAttachments();
      updateAttachBudget();
      setStatus(
        attachStatus,
        state.pendingAttachments.length
          ? `${state.pendingAttachments.length} file(s) ready · ${formatBytes(totalAttachmentSize(state.pendingAttachments))}`
          : "",
      );
    });
    li.appendChild(remove);
    attachmentList.appendChild(li);
  });
}

function renderViewAttachments(attachments) {
  const block = $("attachmentsBlock");
  const list = $("viewAttachments");
  if (!block || !list) return;
  list.innerHTML = "";
  const items = Array.isArray(attachments) ? attachments : [];
  block.classList.toggle("is-hidden", items.length === 0);
  items.forEach((item) => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="attach-info"><strong></strong><span></span></div>`;
    li.querySelector("strong").textContent = item.name || "file";
    li.querySelector("span").textContent = formatBytes(item.size || 0);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Download";
    button.addEventListener("click", () => downloadAttachment(item));
    li.appendChild(button);
    list.appendChild(li);
  });
}

function buildCapsule() {
  const expiryChoice = $("expiresIn").value;
  const expiresAt =
    autoExpiry.checked && expiryChoice !== "never"
      ? Date.now() + Number(expiryChoice)
      : null;

  const unlockInput = $("unlockAt").value;
  const unlockAt =
    scheduledUnlock.checked && unlockInput
      ? new Date(unlockInput).getTime()
      : null;

  return {
    title: $("title").value.trim(),
    model: $("model").value.trim(),
    systemPrompt: $("systemPrompt").value.trim(),
    userPrompt: $("userPrompt").value.trim(),
    temperature: $("temperature").value === "" ? null : Number($("temperature").value),
    topP: $("topP").value === "" ? null : Number($("topP").value),
    variables: parseVariables($("variables").value),
    notes: $("notes").value.trim(),
    expectedOutput: $("expectedOutput").value.trim(),
    tags: $("tags").value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    attachments: [],
    kind: "prompt",
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    unlockAt: unlockAt ? new Date(unlockAt).toISOString() : null,
  };
}

function buildFileCapsule() {
  const expiryChoice = $("fileExpiresIn").value;
  const expiresAt =
    fileAutoExpiry.checked && expiryChoice !== "never"
      ? Date.now() + Number(expiryChoice)
      : null;
  const unlockInput = $("fileUnlockAt").value;
  const unlockAt =
    fileScheduledUnlock.checked && unlockInput
      ? new Date(unlockInput).getTime()
      : null;

  return {
    kind: "file-drop",
    title: $("fileTitle").value.trim() || "File drop",
    model: "",
    systemPrompt: "",
    userPrompt: "",
    temperature: null,
    topP: null,
    variables: {},
    notes: "",
    expectedOutput: "",
    tags: [],
    attachments: state.pendingAttachments.map((item) => ({ ...item })),
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    unlockAt: unlockAt ? new Date(unlockAt).toISOString() : null,
  };
}

function appRootUrl() {
  return new URL("/", window.location.href).toString().replace(/\/$/, "");
}

async function buildShareUrl(envelope, keyParam) {
  const baseUrl = `${appRootUrl()}?tab=receive`;
  const fragment = new URLSearchParams({ data: await encodeEnvelopePayload(envelope) });
  if (keyParam) fragment.set("key", keyParam);
  return `${baseUrl}#${fragment.toString()}`;
}

function buildShortShareUrl(id, keyParam) {
  const params = new URLSearchParams({ tab: "receive", id });
  const base = `${appRootUrl()}?${params.toString()}`;
  if (!keyParam) return base;
  const fragment = new URLSearchParams({ key: keyParam });
  return `${base}#${fragment.toString()}`;
}

function buildReceiveOnlyUrl() {
  return `${appRootUrl()}?tab=receive&kind=file`;
}

function isValidShortId(id) {
  return /^[A-Za-z0-9]{8}$/.test(id || "");
}

function isShortLinkPath(pathname = window.location.pathname, search = window.location.search) {
  if (/\/c\/[A-Za-z0-9]{8}\/?$/.test(pathname)) return true;
  return isValidShortId(new URLSearchParams(search).get("id"));
}

function readShortLinkId(pathname = window.location.pathname, search = window.location.search) {
  const fromPath = pathname.match(/\/c\/([A-Za-z0-9]{8})\/?$/);
  if (fromPath) return fromPath[1];
  const fromSearch = new URLSearchParams(search).get("id");
  if (isValidShortId(fromSearch)) return fromSearch;
  const fromHref = window.location.href.match(/\/c\/([A-Za-z0-9]{8})(?:[/?#]|$)/);
  if (fromHref) return fromHref[1];
  const fromHrefQuery = window.location.href.match(/[?&]id=([A-Za-z0-9]{8})(?:[&#]|$)/);
  return fromHrefQuery ? fromHrefQuery[1] : null;
}

async function initializeCapsule(kind, expiresAt) {
  const res = await fetch("/api/c/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, expiresAt: expiresAt || null }),
  });
  let payload = {};
  try {
    payload = await res.json();
  } catch {
    payload = {};
  }
  if (!res.ok) {
    throw new Error(payload.error || "Could not initialize capsule.");
  }
  return payload;
}

async function completeCapsuleUpload(id, envelope) {
  const body = JSON.stringify({ id, envelope });
  if (textEncoder.encode(body).byteLength > DIRECT_UPLOAD_THRESHOLD) {
    return completeCapsuleViaBlobUpload(id, envelope);
  }

  const res = await fetch("/api/c/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  let payload = {};
  try {
    payload = await res.json();
  } catch {
    payload = {};
  }
  if (res.status === 413) {
    return completeCapsuleViaBlobUpload(id, envelope);
  }
  if (!res.ok) {
    throw new Error(payload.error || "Short-link storage could not activate this capsule.");
  }
  return payload;
}

function blobStoreIdFromClientToken(clientToken) {
  const parts = String(clientToken || "").split("_");
  return parts[3] || "";
}

async function requestBlobClientToken(pathname, id) {
  const res = await fetch("/api/upload-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "blob.generate-client-token",
      payload: {
        pathname,
        clientPayload: JSON.stringify({ id }),
        multipart: false,
      },
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error || "Blob direct upload is not configured.");
  }
  if (!payload.clientToken) {
    throw new Error("Blob direct upload did not return a client token.");
  }
  return payload.clientToken;
}

async function uploadEnvelopeBlob(id, envelope) {
  const pathname = `capsules/uploads/${id}/envelope.json`;
  const body = JSON.stringify(envelope);
  const clientToken = await requestBlobClientToken(pathname, id);
  const storeId = blobStoreIdFromClientToken(clientToken);
  const url = `${VERCEL_BLOB_API_URL}/?${new URLSearchParams({ pathname }).toString()}`;
  const requestId = `${storeId || "store"}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${clientToken}`,
      "content-type": "application/json",
      "x-api-blob-request-id": requestId,
      "x-api-version": VERCEL_BLOB_API_VERSION,
      "x-content-length": String(textEncoder.encode(body).byteLength),
      "x-content-type": "application/json",
      "x-vercel-blob-access": "public",
      "x-vercel-blob-store-id": storeId,
    },
    body,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const blobError = payload.error?.message || payload.error || "Blob direct upload failed.";
    throw new Error(blobError);
  }
  return payload;
}

async function completeCapsuleViaBlobUpload(id, envelope) {
  const blob = await uploadEnvelopeBlob(id, envelope);
  const res = await fetch("/api/c/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, blob }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error || "Could not activate uploaded capsule.");
  }
  return payload;
}

async function uploadCapsule(envelope, options = {}) {
  const pending = await initializeCapsule(options.kind || "capsule", envelope.expiresAt);
  const payload = await completeCapsuleUpload(pending.id, envelope);
  return payload.id;
}

async function fetchCapsuleById(id) {
  const res = await fetch(`/api/c/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "open" }),
  });
  let payload = {};
  try {
    payload = await res.json();
  } catch {
    payload = {};
  }
  if (!res.ok) {
    throw new Error(payload.error || "Capsule not found or expired.");
  }
  return payload.envelope;
}

function readFragment() {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  return new URLSearchParams(hash);
}

function clearReceiveState({ clearStatus = true } = {}) {
  state.receiveOperation += 1;
  state.currentCapsule = null;
  state.pendingEnvelope = null;
  state.pendingKeyParam = "";
  state.importedPack = null;
  capsuleView.classList.add("is-hidden");
  passwordUnlock.classList.add("is-hidden");
  if ($("receivePassword")) $("receivePassword").value = "";
  if (packList) {
    packList.innerHTML = "";
    packList.classList.add("is-hidden");
  }
  if (clearStatus) setStatus(receiveStatus, "");
  updateReceiveEmpty();
}

function setScreen(screen) {
  const screens = ["home", "prompt", "file", "receive", "collect", "request", "form"];
  const next = screens.includes(screen) ? screen : "home";
  const previous = state.screen;
  if (previous === "receive" && next !== "receive") {
    clearReceiveState();
  }
  state.screen = next;
  document.body.dataset.screen = next;

  $("homeScreen")?.classList.toggle("is-hidden", next !== "home");
  $("promptScreen")?.classList.toggle("is-hidden", next !== "prompt");
  $("fileScreen")?.classList.toggle("is-hidden", next !== "file");
  $("receiveScreen")?.classList.toggle("is-hidden", next !== "receive");
  $("collectScreen")?.classList.toggle("is-hidden", next !== "collect");
  $("requestScreen")?.classList.toggle("is-hidden", next !== "request");
  $("formScreen")?.classList.toggle("is-hidden", next !== "form");

  document.querySelectorAll(".mobile-nav-item[data-screen], .nav-links [data-screen]").forEach((el) => {
    const target = el.getAttribute("data-screen");
    const active = target === next || (target === "collect" && ["request", "form"].includes(next));
    el.classList.toggle("is-active", active);
    if (active) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });

  const path = window.location.pathname;
  const hash = window.location.hash || "";
  const currentParams = new URLSearchParams(window.location.search);
  const onShortLink = isShortLinkPath(path);
  const onCollectionLink = /^\/[rf]\/[A-Za-z0-9_-]{20,80}\/?$/.test(path);
  const origin = window.location.origin;

  if (next === "home") {
    history.replaceState(null, "", `${origin}/`);
  } else if (next === "receive" && onShortLink) {
    // Keep /c/{id} path (and hash) for short share links.
  } else if (
    onCollectionLink
    && ((next === "request" && /^\/r\//.test(path)) || (next === "form" && /^\/f\//.test(path)))
  ) {
    // Keep active secure request/form paths.
  } else if (next === "receive") {
    const params = new URLSearchParams({ tab: "receive" });
    if (currentParams.get("kind") === "file") params.set("kind", "file");
    history.replaceState(null, "", `${origin}/?${params.toString()}${hash}`);
  } else {
    history.replaceState(null, "", `${origin}/?tab=${next}`);
  }
  updateReceiveEmpty();

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setMode(mode) {
  setScreen(mode === "receive" ? "receive" : "prompt");
}

function updateReceiveEmpty() {
  if (!receiveEmpty) return;
  const hasCapsule = !capsuleView.classList.contains("is-hidden");
  const needsPassword = !passwordUnlock.classList.contains("is-hidden");
  if (hasCapsule || needsPassword) {
    receiveEmpty.classList.add("is-hidden");
    return;
  }
  receiveEmpty.classList.remove("is-hidden");
  const title = $("receive-title");
  const copy = $("receiveEmptyCopy");
  const isFileReceive = new URLSearchParams(window.location.search).get("kind") === "file";
  if (title) title.textContent = isFileReceive ? "Open the file capsule" : "Open a capsule";
  if (copy) {
    copy.textContent = isFileReceive
      ? "Open the .capsule.html you were sent. File data is not in this link."
      : "Open a prompt or file capsule. Decryption stays in your browser.";
  }
}

function updateResultState() {
  if (resultPanel) resultPanel.classList.toggle("has-link", Boolean(shareLink.value));
  if (fileResultPanel) fileResultPanel.classList.toggle("has-link", Boolean(fileShareLink?.value));
}

function clearPromptResult() {
  state.promptResult.envelope = null;
  state.promptResult.keyParam = "";
  shareLink.value = "";
  $("copyLink").disabled = true;
  $("downloadCapsule").disabled = true;
  if (createSeal) createSeal.textContent = "—";
  if (resultHint) resultHint.textContent = "Short link stored encrypted on the server. Key stays in the URL fragment.";
  updateLinkMeter();
  updateKeySummary(false);
  updateResultState();
}

function clearFileResult() {
  state.fileResult.envelope = null;
  state.fileResult.keyParam = "";
  fileShareLink.value = "";
  $("fileCopyLink").disabled = true;
  $("fileDownloadCapsule").disabled = true;
  if (fileCreateSeal) fileCreateSeal.textContent = "—";
  if (fileResultHint) {
    fileResultHint.textContent = "Create a file capsule to get a short /c/ link. Download Capsule remains available as a backup.";
  }
  setFileResultMode("idle");
  updateFileLinkMeter();
  updateResultState();
}

function updateLinkMeter() {
  const value = shareLink.value.trim();
  if (isFileShortShareUrl(value)) {
    linkSize.textContent = "Short link · 8-char id";
    linkWarning.textContent = "";
    return;
  }
  const length = shareLink.value.length;
  linkSize.textContent = `${length.toLocaleString()} characters`;
  linkWarning.textContent = length > 7000 ? "Large link — prefer Download Capsule" : "";
}

function updateFileLinkMeter() {
  if (!fileShareLink || !fileLinkSize) return;
  const value = fileShareLink.value.trim();
  if (isFileShortShareUrl(value)) {
    fileLinkSize.textContent = "Short link · 8-char id";
    if (fileLinkWarning) fileLinkWarning.textContent = "";
    return;
  }
  if (value.includes("tab=receive")) {
    fileLinkSize.textContent = "Receive hint · use with capsule file";
    if (fileLinkWarning) fileLinkWarning.textContent = "";
    return;
  }
  fileLinkSize.textContent = value ? "Share link" : "Short link";
  if (fileLinkWarning) fileLinkWarning.textContent = "";
}

function isFileShortShareUrl(value) {
  return /\/c\/[A-Za-z0-9]{8}/.test(value || "") || /[?&]id=[A-Za-z0-9]{8}(?:[&#]|$)/.test(value || "");
}

function updateKeySummary(hasInlineKey, passwordProtected = false) {
  if (!keySummary) return;
  if (!shareLink.value) {
    keySummary.textContent = "#key when available";
    return;
  }
  if (isFileShortShareUrl(shareLink.value)) {
    keySummary.textContent = passwordProtected
      ? "password required"
      : hasInlineKey
        ? "#key in fragment"
        : "#key missing";
    return;
  }
  keySummary.textContent = passwordProtected
    ? "password required"
    : hasInlineKey
      ? "#key included"
      : "#key missing";
}

function setStatus(element, message, isError = false) {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("error", isError);
  element.classList.toggle("is-empty", !message);
}

function friendlyCapsuleError(error, fallback = "Could not open this capsule.") {
  const message = String(error?.message || "");
  if (/KV storage is not configured/i.test(message)) {
    return "Short-link storage is not configured on this deployment.";
  }
  if (/Blob storage is not configured/i.test(message)) {
    return "Blob storage is not configured for larger capsule links.";
  }
  if (/not found|expired/i.test(message)) {
    return "This capsule link is expired, already burned, or no longer exists.";
  }
  if (/request limit|too large|413/i.test(message)) {
    return "This capsule needs Blob direct upload before a short link can be created.";
  }
  if (/Failed to fetch|NetworkError|temporarily unavailable/i.test(message)) {
    return "Capsule storage is temporarily unreachable. Check the deployment and try again.";
  }
  return message || fallback;
}

function markButtonCopied(button, label) {
  if (!button) return;
  const previous = button.textContent;
  button.textContent = `${label} Copied`;
  button.classList.add("is-confirmed");
  window.setTimeout(() => {
    button.textContent = previous;
    button.classList.remove("is-confirmed");
  }, 1400);
}

function updatePromptMeter() {
  const userPrompt = $("userPrompt");
  const charTarget = $("promptCharCount");
  const variableTarget = $("promptVariableCount");
  const securityTarget = $("promptSecurityPreview");
  if (!userPrompt || !charTarget || !variableTarget || !securityTarget) return;

  const text = userPrompt.value || "";
  const variables = new Set(Array.from(text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g), (match) => match[1]));
  const activeGuards = [
    $("burnAfterRead")?.checked,
    $("passwordProtect")?.checked,
    $("autoExpiry")?.checked,
    $("scheduledUnlock")?.checked,
  ].filter(Boolean).length;
  charTarget.textContent = pluralize(text.length, "character");
  variableTarget.textContent = pluralize(variables.size, "variable");
  securityTarget.textContent = activeGuards ? pluralize(activeGuards, "guard") : "Key-only link";
}

function autoGrowTextarea(textarea) {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function formatDate(value) {
  if (!value) return "No set expiry";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function setOptionalBlock(blockId, textId, value) {
  const block = $(blockId);
  const text = $(textId);
  const hasValue = Boolean(value && String(value).trim());
  block.classList.toggle("is-hidden", !hasValue);
  text.textContent = hasValue ? value : "";
}

function safeFilename(title) {
  const base = (title || "prompt-capsule")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return base || "prompt-capsule";
}

function loadRecentPack() {
  try {
    const raw = localStorage.getItem(PACK_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecentPack(items) {
  localStorage.setItem(PACK_STORAGE_KEY, JSON.stringify(items.slice(0, PACK_LIMIT)));
}

function rememberPackItem(envelope, keyParam) {
  try {
    const items = loadRecentPack().filter((item) => item.envelope?.id !== envelope.id);
    items.unshift({
      envelope,
      key: keyParam || "",
      savedAt: Date.now(),
    });
    saveRecentPack(items);
  } catch {
    // localStorage may reject very large attachment envelopes
  }
}

function buildPortableCapsuleHtml(envelope, keyParam) {
  const payload = {
    version: 1,
    type: "prompt-capsule",
    envelope,
    key: keyParam || null,
  };
  const payloadJson = JSON.stringify(payload).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${(envelope.title || "Prompt Capsule").replace(/</g, "")}</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif; }
    body { margin: 0; background: #f5f5f7; color: #1d1d1f; -webkit-font-smoothing: antialiased; }
    main { width: min(720px, calc(100% - 32px)); margin: 48px auto; }
    .card { background: #fff; border-radius: 24px; box-shadow: 0 2px 8px rgba(0,0,0,.04), 0 12px 28px rgba(0,0,0,.05); padding: 28px; }
    h1 { margin: 0 0 8px; font-size: 1.75rem; letter-spacing: -0.02em; }
    p { color: #6e6e73; line-height: 1.4; }
    label { display: grid; gap: 8px; margin: 18px 0; color: #6e6e73; font-size: .85rem; }
    input { border: 0; border-radius: 12px; background: #f5f5f7; padding: 12px 14px; font: inherit; }
    button { min-height: 42px; border: 0; border-radius: 980px; padding: 0 20px; background: #0071e3; color: #fff; font: inherit; cursor: pointer; }
    pre { white-space: pre-wrap; background: #f5f5f7; border-radius: 16px; padding: 14px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .875rem; }
    .meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin: 18px 0; }
    .meta div { background: #f5f5f7; border-radius: 14px; padding: 12px; }
    .meta span { display: block; color: #6e6e73; font-size: .7rem; text-transform: uppercase; font-weight: 600; }
    .seal { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-weight: 600; letter-spacing: .04em; }
    .error { color: #d70015; }
    .hidden { display: none !important; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
    .secondary { background: #fff; color: #1d1d1f; border: 1px solid #d2d2d7; }
    .files { margin-top: 18px; display: grid; gap: 8px; }
    .files li { display: flex; align-items: center; justify-content: space-between; gap: 12px; list-style: none; background: #f5f5f7; border-radius: 12px; padding: 12px 14px; }
    .files ul { margin: 0; padding: 0; display: grid; gap: 8px; }
    .files strong { display: block; }
    .files span { color: #6e6e73; font-size: .75rem; }
  </style>
</head>
<body>
  <main>
    <div class="card" id="gate">
      <h1>Prompt Capsule</h1>
      <p>This portable file decrypts entirely in your browser. Nothing is uploaded.</p>
      <p>Integrity seal <span class="seal" id="seal">${envelope.seal || "—"}</span></p>
      <label id="passwordLabel" class="hidden">Password<input id="password" type="password" autocomplete="current-password" /></label>
      <button id="openBtn" type="button">Open Capsule</button>
      <p id="status"></p>
    </div>
    <div class="card hidden" id="view"></div>
  </main>
  <script type="application/json" id="capsule-payload">${payloadJson}</script>
  <script>
(function () {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const payload = JSON.parse(document.getElementById("capsule-payload").textContent);
  const envelope = payload.envelope;
  const embeddedKey = payload.key || "";
  const passwordLabel = document.getElementById("passwordLabel");
  const status = document.getElementById("status");
  const view = document.getElementById("view");
  const gate = document.getElementById("gate");
  const openBtn = document.getElementById("openBtn");
  let isOpening = false;

  if (envelope.kdf) passwordLabel.classList.remove("hidden");

  function b64ToBytes(value) {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  }

  async function derivePasswordKey(password, salt) {
    const baseKey = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function inflateBytes(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function readU32(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function unpackCapsuleBinary(bytes) {
    let offset = 0;
    const metaLen = readU32(bytes, offset);
    offset += 4;
    const meta = JSON.parse(textDecoder.decode(bytes.subarray(offset, offset + metaLen)));
    offset += metaLen;
    const attachments = Array.isArray(meta.attachments) ? meta.attachments : [];
    meta.attachments = attachments.map(function (item) {
      const length = readU32(bytes, offset);
      offset += 4;
      const data = bytes.subarray(offset, offset + length);
      offset += length;
      return Object.assign({}, item, { data: bytesToBase64(data) });
    });
    return meta;
  }

  async function plaintextToCapsule(bytes, pack) {
    if (!pack) return JSON.parse(textDecoder.decode(bytes));
    const packed = pack === "bin-deflate-v1" ? await inflateBytes(bytes) : bytes;
    return unpackCapsuleBinary(packed);
  }

  async function decrypt(password) {
    const iv = b64ToBytes(envelope.iv);
    const ciphertext = b64ToBytes(envelope.ciphertext);
    let cryptoKey;
    if (envelope.kdf) {
      if (!password) throw new Error("Password required");
      cryptoKey = await derivePasswordKey(password, b64ToBytes(envelope.kdf.salt));
    } else {
      if (!embeddedKey) throw new Error("Missing key");
      cryptoKey = await crypto.subtle.importKey("raw", b64ToBytes(embeddedKey), "AES-GCM", false, ["encrypt", "decrypt"]);
    }
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
    return plaintextToCapsule(new Uint8Array(decrypted), envelope.pack);
  }

  function formatDate(value) {
    if (!value) return "No set expiry";
    return new Date(value).toLocaleString();
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function formatBytes(size) {
    if (size < 1024) return size + " B";
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
    return (size / (1024 * 1024)).toFixed(2) + " MB";
  }

  function base64ToBlob(base64, type) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: type || "application/octet-stream" });
  }

  function downloadAttachment(item) {
    const url = URL.createObjectURL(base64ToBlob(item.data, item.type));
    const link = document.createElement("a");
    link.href = url;
    link.download = item.name || "attachment";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function openPortableCapsule() {
    if (isOpening) return;
    isOpening = true;
    openBtn.disabled = true;
    status.textContent = "Decrypting…";
    status.className = "";
    try {
      const capsule = await decrypt(document.getElementById("password").value);
      if (capsule.unlockAt && Date.now() < new Date(capsule.unlockAt).getTime()) {
        throw new Error("This capsule unlocks at " + formatDate(capsule.unlockAt));
      }
      if (capsule.expiresAt && Date.now() > new Date(capsule.expiresAt).getTime()) {
        throw new Error("This capsule has expired.");
      }
      const attachments = Array.isArray(capsule.attachments) ? capsule.attachments : [];
      const filesHtml = attachments.length
        ? "<div class=\\"files\\"><h3>Attachments</h3><ul>" +
          attachments.map(function (item, index) {
            return "<li><div><strong>" + escapeHtml(item.name || "file") +
              "</strong><span>" + escapeHtml(formatBytes(item.size || 0)) +
              "</span></div><button type=\\"button\\" data-attach=\\"" + index + "\\">Download</button></li>";
          }).join("") +
          "</ul></div>"
        : "";
      gate.classList.add("hidden");
      view.classList.remove("hidden");
      view.innerHTML =
        "<h1>" + escapeHtml(capsule.title || "Untitled Capsule") + "</h1>" +
        "<p class=\\"seal\\">Seal " + escapeHtml(envelope.seal || "—") + "</p>" +
        "<div class=\\"meta\\"><div><span>Model</span>" + escapeHtml(capsule.model || "-") +
        "</div><div><span>Expires</span>" + escapeHtml(formatDate(capsule.expiresAt)) +
        "</div><div><span>Unlocks</span>" + escapeHtml(formatDate(capsule.unlockAt)) +
        "</div><div><span>Label</span>" + escapeHtml(envelope.label || "prod") + "</div></div>" +
        "<h3>User Prompt</h3><pre id=\\"prompt\\">" + escapeHtml(capsule.userPrompt || "") + "</pre>" +
        (capsule.systemPrompt ? "<h3>System Prompt</h3><pre>" + escapeHtml(capsule.systemPrompt) + "</pre>" : "") +
        filesHtml +
        "<div class=\\"actions\\"><button type=\\"button\\" id=\\"copyPrompt\\">Copy Prompt</button>" +
        "<button type=\\"button\\" class=\\"secondary\\" id=\\"copyJson\\">Copy JSON</button></div>";
      document.getElementById("copyPrompt").onclick = () => navigator.clipboard.writeText(capsule.userPrompt || "");
      document.getElementById("copyJson").onclick = () => navigator.clipboard.writeText(JSON.stringify(capsule, null, 2));
      view.querySelectorAll("[data-attach]").forEach(function (button) {
        button.addEventListener("click", function () {
          downloadAttachment(attachments[Number(button.getAttribute("data-attach"))]);
        });
      });
    } catch (error) {
      status.textContent = error.message || "Unable to decrypt.";
      status.className = "error";
    } finally {
      isOpening = false;
      openBtn.disabled = false;
    }
  }

  openBtn.addEventListener("click", openPortableCapsule);
  document.getElementById("password").addEventListener("keydown", function (event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    openPortableCapsule();
  });
})();
  </script>
</body>
</html>`;
}

function renderCapsule(capsule, envelope) {
  state.currentCapsule = capsule;
  capsuleView.classList.remove("is-hidden");
  if (packList) packList.classList.add("is-hidden");
  updateReceiveEmpty();

  const attachments = Array.isArray(capsule.attachments) ? capsule.attachments : [];
  const isFileDrop =
    capsule.kind === "file-drop"
    || (!capsule.userPrompt && attachments.length > 0);

  $("viewLabel").textContent = isFileDrop ? "File drop" : envelope.label || "Capsule";
  $("viewTitle").textContent = capsule.title || (isFileDrop ? "Encrypted files" : "Untitled Capsule");
  $("viewModel").textContent = capsule.model || "-";
  $("viewTemperature").textContent = capsule.temperature ?? "-";
  $("viewTopP").textContent = capsule.topP ?? "-";
  $("viewExpires").textContent = formatDate(capsule.expiresAt);
  $("viewUnlocks").textContent = formatDate(capsule.unlockAt);
  if (viewSeal) viewSeal.textContent = envelope.seal || "—";
  $("viewUserPrompt").textContent = capsule.userPrompt || "";
  $("viewSystemPrompt").textContent = capsule.systemPrompt || "";
  $("viewVariables").textContent = JSON.stringify(capsule.variables || {}, null, 2);
  $("viewExpected").textContent = capsule.expectedOutput || "";
  $("viewNotes").textContent = capsule.notes || "";

  $("promptReadout")?.classList.toggle("is-hidden", isFileDrop);
  $("promptActions")?.classList.toggle("is-hidden", isFileDrop);
  $("viewMeta")?.classList.toggle("is-hidden", false);

  const metaKids = $("viewMeta")?.querySelectorAll(":scope > div");
  if (metaKids?.length >= 5) {
    metaKids[0].classList.toggle("is-hidden", isFileDrop);
    metaKids[1].classList.toggle("is-hidden", isFileDrop);
    metaKids[2].classList.toggle("is-hidden", isFileDrop);
  }

  if (!isFileDrop) {
    setOptionalBlock("systemBlock", "viewSystemPrompt", capsule.systemPrompt);
    setOptionalBlock(
      "variablesBlock",
      "viewVariables",
      Object.keys(capsule.variables || {}).length ? JSON.stringify(capsule.variables, null, 2) : "",
    );
    setOptionalBlock("expectedBlock", "viewExpected", capsule.expectedOutput);
    setOptionalBlock("notesBlock", "viewNotes", capsule.notes);
  }

  renderViewAttachments(attachments);

  const tags = $("viewTags");
  tags.innerHTML = "";
  (capsule.tags || []).forEach((tag) => {
    const pill = document.createElement("span");
    pill.className = "tag";
    pill.textContent = tag;
    tags.appendChild(pill);
  });
}

function isBurned(id) {
  return localStorage.getItem(`prompt-capsule-burned:${id}`) === "true";
}

function burnLocalCopy(envelope) {
  if (!envelope.guards?.includes("burn-after-read")) return;
  localStorage.setItem(`prompt-capsule-burned:${envelope.id}`, "true");
  history.replaceState(null, "", `${window.location.origin}/?tab=receive`);
}

async function openEnvelope(envelope, keyParam = "", password = "", operation = null) {
  const operationId = operation ?? ++state.receiveOperation;
  if (
    state.screen !== "receive"
    || (operation !== null && operationId !== state.receiveOperation)
  ) return;
  state.pendingEnvelope = envelope;
  state.pendingKeyParam = keyParam || "";
  capsuleView.classList.add("is-hidden");
  passwordUnlock.classList.add("is-hidden");
  state.currentCapsule = null;

  if (!envelope?.ciphertext) {
    setStatus(receiveStatus, "Invalid capsule file.", true);
    updateReceiveEmpty();
    return;
  }

  if (!envelope.seal) {
    envelope.seal = await integritySeal(envelope.ciphertext);
    if (operationId !== state.receiveOperation || state.screen !== "receive") return;
  }

  if (isBurned(envelope.id)) {
    setStatus(receiveStatus, "This capsule has already been burned on this device.", true);
    updateReceiveEmpty();
    return;
  }

  if (envelope.kdf && !password) {
    passwordUnlock.classList.remove("is-hidden");
    setStatus(receiveStatus, "Password required.");
    updateReceiveEmpty();
    return;
  }

  try {
    const capsule = await decryptCapsule(envelope, keyParam, password);
    if (operationId !== state.receiveOperation || state.screen !== "receive") return;
    if (capsule.unlockAt && Date.now() < new Date(capsule.unlockAt).getTime()) {
      if (envelope.kdf) passwordUnlock.classList.remove("is-hidden");
      setStatus(receiveStatus, `This capsule unlocks at ${formatDate(capsule.unlockAt)}.`, true);
      updateReceiveEmpty();
      return;
    }
    if (capsule.expiresAt && Date.now() > new Date(capsule.expiresAt).getTime()) {
      setStatus(receiveStatus, "This capsule has expired.", true);
      updateReceiveEmpty();
      return;
    }
    passwordUnlock.classList.add("is-hidden");
    setStatus(
      receiveStatus,
      envelope.guards?.includes("burn-after-read")
        ? "Opened and burned on this device."
        : "Capsule opened.",
    );
    renderCapsule(capsule, envelope);
    burnLocalCopy(envelope);
  } catch {
    if (operationId !== state.receiveOperation || state.screen !== "receive") return;
    if (envelope.kdf) passwordUnlock.classList.remove("is-hidden");
    setStatus(
      receiveStatus,
      envelope.kdf
        ? "That password did not unlock this capsule. Check the shared password and try again."
        : "This capsule could not be decrypted with the key in the link.",
      true,
    );
    updateReceiveEmpty();
  }
}

async function openFromUrl(password = "") {
  const operationId = ++state.receiveOperation;
  const params = readFragment();
  const encoded = params.get("data");
  const keyParam = params.get("key");

  if (!encoded) {
    if (state.pendingEnvelope && password) {
      await openEnvelope(state.pendingEnvelope, state.pendingKeyParam, password, operationId);
      return;
    }
    clearReceiveState();
    return;
  }

  let envelope;
  try {
    envelope = await decodeEnvelopePayload(encoded);
    if (operationId !== state.receiveOperation || state.screen !== "receive") return;
  } catch {
    setStatus(receiveStatus, "The capsule link is malformed.", true);
    updateReceiveEmpty();
    return;
  }

  await openEnvelope(envelope, keyParam || "", password, operationId);
}

async function openFromShortPath() {
  const operationId = ++state.receiveOperation;
  const id = readShortLinkId();
  if (!id) return false;

  setScreen("receive");
  setStatus(receiveStatus, "Opening capsule…");
  const keyParam = readFragment().get("key") || "";

  try {
    const envelope = await fetchCapsuleById(id);
    if (operationId !== state.receiveOperation || state.screen !== "receive") return true;
    await openEnvelope(envelope, keyParam, "", operationId);
  } catch (error) {
    if (operationId !== state.receiveOperation || state.screen !== "receive") return true;
    setStatus(receiveStatus, friendlyCapsuleError(error), true);
    updateReceiveEmpty();
  }
  return true;
}

function extractPayloadFromHtml(text) {
  const match = text.match(
    /<script[^>]*id=["']capsule-payload["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match) return null;
  return JSON.parse(match[1]);
}

async function openPortableFile(file) {
  const text = await file.text();
  let payload = null;

  try {
    if (file.name.endsWith(".html") || text.includes("capsule-payload")) {
      payload = extractPayloadFromHtml(text);
    } else {
      payload = JSON.parse(text);
    }
  } catch {
    setStatus(receiveStatus, "Could not read that capsule file.", true);
    updateReceiveEmpty();
    return;
  }

  if (payload?.type === "prompt-capsule-pack" && Array.isArray(payload.items)) {
    state.importedPack = payload;
    renderPackList(payload.items);
    setStatus(receiveStatus, `Pack loaded · ${payload.items.length} capsule(s).`);
    updateReceiveEmpty();
    return;
  }

  const envelope = payload?.envelope || payload;
  const keyParam = payload?.key || "";
  if (!envelope?.ciphertext) {
    setStatus(receiveStatus, "File is not a Prompt Capsule.", true);
    updateReceiveEmpty();
    return;
  }

  packList.classList.add("is-hidden");
  await openEnvelope(envelope, keyParam);
}

function renderPackList(items) {
  packList.innerHTML = "";
  packList.classList.remove("is-hidden");
  receiveEmpty.classList.remove("is-hidden");
  items.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    const title = item.envelope?.title || item.envelope?.label || `Capsule ${index + 1}`;
    const seal = item.envelope?.seal || "—";
    const strong = document.createElement("strong");
    const span = document.createElement("span");
    strong.textContent = title;
    span.textContent = `Seal ${seal}`;
    button.append(strong, span);
    button.addEventListener("click", async () => {
      await openEnvelope(item.envelope, item.key || "");
    });
    packList.appendChild(button);
  });
}

function downloadFile(filename, content, type = "application/json") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function copyText(text, statusElement, label, button = null) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(statusElement, `${label} copied.`);
    markButtonCopied(button, label);
    return true;
  } catch {
    setStatus(statusElement, `Could not copy ${label.toLowerCase()}. Select and copy it manually.`, true);
    return false;
  }
}

passwordProtect.addEventListener("change", () => {
  passwordField.classList.toggle("is-hidden", !passwordProtect.checked);
  updatePromptMeter();
});

autoExpiry.addEventListener("change", () => {
  expiryField.classList.toggle("is-hidden", !autoExpiry.checked);
  updatePromptMeter();
});

scheduledUnlock.addEventListener("change", () => {
  unlockField.classList.toggle("is-hidden", !scheduledUnlock.checked);
  if (scheduledUnlock.checked && !$("unlockAt").value) {
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    soon.setMinutes(soon.getMinutes() - soon.getTimezoneOffset());
    $("unlockAt").value = soon.toISOString().slice(0, 16);
  }
  updatePromptMeter();
});

$("burnAfterRead")?.addEventListener("change", updatePromptMeter);

filePasswordProtect?.addEventListener("change", () => {
  filePasswordField.classList.toggle("is-hidden", !filePasswordProtect.checked);
});

fileAutoExpiry?.addEventListener("change", () => {
  fileExpiryField.classList.toggle("is-hidden", !fileAutoExpiry.checked);
});

fileScheduledUnlock?.addEventListener("change", () => {
  fileUnlockField.classList.toggle("is-hidden", !fileScheduledUnlock.checked);
  if (fileScheduledUnlock.checked && !$("fileUnlockAt").value) {
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    soon.setMinutes(soon.getMinutes() - soon.getTimezoneOffset());
    $("fileUnlockAt").value = soon.toISOString().slice(0, 16);
  }
});

async function goScreen(screen) {
  if (state.navigationInFlight && screen === state.screen) return;
  const navigationId = ++state.navigationOperation;
  state.navigationInFlight = true;
  try {
    setScreen(screen);
    if (screen === "receive") {
      if (isShortLinkPath()) await openFromShortPath();
      else await openFromUrl();
    }
  } finally {
    if (navigationId === state.navigationOperation) {
      state.navigationInFlight = false;
    }
  }
}

document.querySelectorAll("[data-screen]").forEach((el) => {
  el.addEventListener("click", async (event) => {
    const screen = el.getAttribute("data-screen");
    if (!screen) return;
    if (el.tagName === "A" && screen === "home") {
      event.preventDefault();
    }
    await goScreen(screen);
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton.disabled) return;
  clearPromptResult();
  setStatus(createStatus, "Encrypting capsule...");

  const password = passwordProtect.checked ? $("password").value : "";
  if (passwordProtect.checked && !password) {
    setStatus(createStatus, "Password protection needs a password.", true);
    return;
  }

  if (scheduledUnlock.checked && !$("unlockAt").value) {
    setStatus(createStatus, "Scheduled unlock needs a date and time.", true);
    return;
  }

  try {
    submitButton.disabled = true;
    const capsule = buildCapsule();
    if (capsule.unlockAt && capsule.expiresAt) {
      if (new Date(capsule.unlockAt).getTime() >= new Date(capsule.expiresAt).getTime()) {
        setStatus(createStatus, "Unlock time must be before expiry.", true);
        return;
      }
    }

    const encrypted = await encryptCapsule(capsule, {
      password,
      burnAfterRead: $("burnAfterRead").checked,
      expiresAt: capsule.expiresAt,
      unlockAt: capsule.unlockAt,
      label: $("label").value.trim(),
    });

    state.promptResult.envelope = encrypted.envelope;
    state.promptResult.keyParam = encrypted.keyParam;
    rememberPackItem(encrypted.envelope, encrypted.keyParam);

    let shareUrl;
    try {
      const id = await uploadCapsule(encrypted.envelope, { kind: "prompt" });
      shareUrl = buildShortShareUrl(id, encrypted.keyParam);
    } catch (uploadError) {
      $("downloadCapsule").disabled = false;
      if (createSeal) createSeal.textContent = encrypted.envelope.seal || "—";
      updateResultState();
      setStatus(
        createStatus,
        `${friendlyCapsuleError(uploadError, "Could not create a short link.")} Portable download is available as a backup.`,
        true,
      );
      return;
    }

    shareLink.value = shareUrl;
    $("copyLink").disabled = false;
    $("downloadCapsule").disabled = false;
    if (createSeal) createSeal.textContent = encrypted.envelope.seal || "—";
    updateLinkMeter();
    updateKeySummary(Boolean(encrypted.keyParam), Boolean(password));
    updateResultState();
    if (resultHint) resultHint.textContent = "Short link stored encrypted on the server. Key stays in the URL fragment.";
    setStatus(
      createStatus,
      password
        ? "Capsule created. Share the short link — password required to open."
        : "Capsule created. Short link ready — #key stays in the fragment.",
    );
  } catch (error) {
    setStatus(createStatus, error.message || "Could not create capsule.", true);
  } finally {
    submitButton.disabled = false;
  }
});

fileForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = fileForm.querySelector('button[type="submit"]');
  if (submitButton.disabled) return;
  clearFileResult();
  setStatus(fileStatus, "Encrypting files...");

  if (!state.pendingAttachments.length) {
    setStatus(fileStatus, "Add at least one file.", true);
    return;
  }

  const password = filePasswordProtect.checked ? $("filePassword").value : "";
  if (filePasswordProtect.checked && !password) {
    setStatus(fileStatus, "Password protection needs a password.", true);
    return;
  }

  if (fileScheduledUnlock.checked && !$("fileUnlockAt").value) {
    setStatus(fileStatus, "Scheduled unlock needs a date and time.", true);
    return;
  }

  try {
    submitButton.disabled = true;
    const capsule = buildFileCapsule();
    if (capsule.unlockAt && capsule.expiresAt) {
      if (new Date(capsule.unlockAt).getTime() >= new Date(capsule.expiresAt).getTime()) {
        setStatus(fileStatus, "Unlock time must be before expiry.", true);
        return;
      }
    }

    const encrypted = await encryptCapsule(capsule, {
      password,
      burnAfterRead: $("fileBurnAfterRead").checked,
      expiresAt: capsule.expiresAt,
      unlockAt: capsule.unlockAt,
      label: $("fileLabel").value.trim(),
    });

    state.fileResult.envelope = encrypted.envelope;
    state.fileResult.keyParam = encrypted.keyParam;
    rememberPackItem(encrypted.envelope, encrypted.keyParam);
    $("fileDownloadCapsule").disabled = false;
    if (fileCreateSeal) fileCreateSeal.textContent = encrypted.envelope.seal || "—";

    const fileCount = capsule.attachments.length;
    const rawTotal = totalAttachmentSize(capsule.attachments);
    try {
      const id = await uploadCapsule(encrypted.envelope, { kind: "file-drop" });
      fileShareLink.value = buildShortShareUrl(id, encrypted.keyParam);
      $("fileCopyLink").disabled = false;
      setFileResultMode("short-link");
      updateFileLinkMeter();
      updateResultState();
      if (fileResultHint) {
        fileResultHint.textContent = `Short link ready · ${fileCount} file(s) · ${formatBytes(rawTotal)} encrypted on the server.`;
      }
      setStatus(
        fileStatus,
        password
          ? `File capsule ready with ${fileCount} file(s). Share the short link — password required.`
          : `File capsule ready with ${fileCount} file(s). Copy the short link to share.`,
      );
      $("fileCopyLink")?.focus({ preventScroll: true });
    } catch (uploadError) {
      fileShareLink.value = buildReceiveOnlyUrl();
      $("fileCopyLink").disabled = false;
      setFileResultMode("portable-fallback");
      updateFileLinkMeter();
      updateResultState();
      if (fileResultHint) {
        fileResultHint.textContent =
          "Short-link storage rejected this encrypted payload. Send the downloaded .capsule.html file instead.";
      }
      setStatus(
        fileStatus,
        `${friendlyCapsuleError(uploadError, "Could not create a short link.")} Portable download is available as a backup.`,
        true,
      );
      $("fileDownloadCapsule")?.focus({ preventScroll: true });
    }

    const fileResult = document.querySelector("#fileScreen .file-result");
    fileResult?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    setStatus(fileStatus, error.message || "Could not create file capsule.", true);
  } finally {
    submitButton.disabled = false;
  }
});

$("resetCreate").addEventListener("click", () => {
  form.reset();
  $("label").value = "prod";
  autoExpiry.checked = true;
  scheduledUnlock.checked = false;
  passwordField.classList.add("is-hidden");
  expiryField.classList.remove("is-hidden");
  unlockField.classList.add("is-hidden");
  clearPromptResult();
  setStatus(createStatus, "");
});

$("resetFile")?.addEventListener("click", () => {
  fileForm.reset();
  $("fileLabel").value = "prod";
  fileAutoExpiry.checked = true;
  fileScheduledUnlock.checked = false;
  filePasswordField.classList.add("is-hidden");
  fileExpiryField.classList.remove("is-hidden");
  fileUnlockField.classList.add("is-hidden");
  state.pendingAttachments = [];
  renderPendingAttachments();
  updateAttachBudget();
  setStatus(attachStatus, "");
  clearFileResult();
  setStatus(fileStatus, "");
});

$("copyLink").addEventListener("click", (event) => copyText(shareLink.value, createStatus, "Link", event.currentTarget));
$("fileCopyLink")?.addEventListener("click", () => {
  const url = fileShareLink.value.trim();
  if (isFileShortShareUrl(url)) {
    copyText(url, fileStatus, "Link", $("fileCopyLink"));
    return;
  }
  const message = `${url || buildReceiveOnlyUrl()}\n\nOpen this page, then use “Open Capsule file” with the .capsule.html you were sent.`;
  copyText(message, fileStatus, "Receive link", $("fileCopyLink"));
});

$("attachmentInput")?.addEventListener("change", async (event) => {
  const input = event.target;
  await addAttachmentFiles(input.files);
  input.value = "";
});

const dropZone = $("dropZone");
if (dropZone) {
  const isFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");

  document.addEventListener("dragover", (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
  });

  document.addEventListener("drop", (event) => {
    if (!isFileDrag(event) || dropZone.contains(event.target)) return;
    event.preventDefault();
    dropZone.classList.remove("is-dragover");
  });

  ["dragenter", "dragover"].forEach((type) => {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropZone.classList.add("is-dragover");
    });
  });
  ["dragleave", "drop"].forEach((type) => {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropZone.classList.remove("is-dragover");
    });
  });
  dropZone.addEventListener("drop", async (event) => {
    await addAttachmentFiles(event.dataTransfer?.files);
  });
}

document.addEventListener("paste", async (event) => {
  if (state.screen !== "file") return;
  const files = event.clipboardData?.files;
  if (!files?.length) return;
  event.preventDefault();
  await addAttachmentFiles(files);
});

$("downloadCapsule").addEventListener("click", () => {
  const { envelope, keyParam } = state.promptResult;
  if (!envelope) return;
  const html = buildPortableCapsuleHtml(envelope, keyParam);
  downloadFile(`${safeFilename(envelope.title)}.capsule.html`, html, "text/html");
  setStatus(createStatus, "Portable capsule downloaded.");
});

$("fileDownloadCapsule")?.addEventListener("click", () => {
  const { envelope, keyParam } = state.fileResult;
  if (!envelope) return;
  const html = buildPortableCapsuleHtml(envelope, keyParam);
  downloadFile(`${safeFilename(envelope.title)}.capsule.html`, html, "text/html");
  setStatus(fileStatus, "Portable capsule downloaded.");
});

$("exportPack").addEventListener("click", () => {
  const items = loadRecentPack();
  if (!items.length) {
    setStatus(createStatus, "No recent capsules to export. Create one first.", true);
    return;
  }
  const pack = {
    version: 1,
    type: "prompt-capsule-pack",
    createdAt: Date.now(),
    items,
  };
  downloadFile("prompt-capsule-pack.json", JSON.stringify(pack, null, 2), "application/json");
  setStatus(createStatus, `Exported pack with ${items.length} capsule(s).`);
});

$("openCapsuleFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  setScreen("receive");
  await openPortableFile(file);
  event.target.value = "";
});

$("importPackFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  setScreen("receive");
  await openPortableFile(file);
  event.target.value = "";
});

async function submitUnlock() {
  const button = $("unlockButton");
  if (button.disabled) return;
  const password = $("receivePassword").value;
  button.disabled = true;
  try {
    if (state.pendingEnvelope) {
      await openEnvelope(state.pendingEnvelope, state.pendingKeyParam, password);
    } else {
      await openFromUrl(password);
    }
  } finally {
    button.disabled = false;
  }
}

$("unlockButton").addEventListener("click", async () => {
  await submitUnlock();
});

$("receivePassword").addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  await submitUnlock();
});

$("copyPrompt").addEventListener("click", (event) => {
  if (state.currentCapsule) copyText(state.currentCapsule.userPrompt || "", receiveStatus, "Prompt", event.currentTarget);
});

$("copySystem").addEventListener("click", (event) => {
  if (state.currentCapsule) copyText(state.currentCapsule.systemPrompt || "", receiveStatus, "System prompt", event.currentTarget);
});

$("copyJson").addEventListener("click", (event) => {
  if (state.currentCapsule) copyText(JSON.stringify(state.currentCapsule, null, 2), receiveStatus, "JSON", event.currentTarget);
});

$("downloadJson").addEventListener("click", () => {
  if (!state.currentCapsule) return;
  downloadFile("prompt-capsule.json", JSON.stringify(state.currentCapsule, null, 2));
});

window.addEventListener("hashchange", async () => {
  if (isShortLinkPath()) {
    setScreen("receive");
    await openFromShortPath();
    return;
  }
  if (new URLSearchParams(window.location.search).get("tab") === "receive" || readFragment().has("data")) {
    setScreen("receive");
    await openFromUrl();
  }
});

document.querySelectorAll("textarea").forEach((textarea) => {
  autoGrowTextarea(textarea);
  textarea.addEventListener("input", () => autoGrowTextarea(textarea));
});

document.querySelector("[data-scroll-home]")?.addEventListener("click", () => {
  $("homeEditorial")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

["userPrompt", "systemPrompt", "variables", "expectedOutput", "notes"].forEach((id) => {
  $(id)?.addEventListener("input", updatePromptMeter);
});
updatePromptMeter();

async function bootApp() {
  const shortId = readShortLinkId();
  if (shortId) {
    await openFromShortPath();
    return;
  }

  const collectionMatch = window.location.pathname.match(/^\/([rf])\/[A-Za-z0-9_-]{20,80}\/?$/);
  if (collectionMatch) {
    setScreen(collectionMatch[1] === "r" ? "request" : "form");
    return;
  }

  const initialTab = new URLSearchParams(window.location.search).get("tab");
  if (initialTab === "receive" || readFragment().has("data")) {
    setScreen("receive");
    await openFromUrl();
  } else if (["prompt", "file", "collect", "request", "form"].includes(initialTab)) {
    setScreen(initialTab);
  } else {
    setScreen("home");
  }
}

bootApp();

updateLinkMeter();
updateFileLinkMeter();
updateAttachBudget();
updateKeySummary(false);
updateResultState();
updateReceiveEmpty();
renderPendingAttachments();
