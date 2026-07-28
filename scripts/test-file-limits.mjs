/**
 * Live file-upload limit tests against Prompt Capsule production API.
 * Mirrors client packing + AES-GCM envelope shape from app.js.
 */

const API = process.env.CAPSULE_API || "https://capsule.sarveshpv.com/api/c";

const ATTACH_MAX_FILES = 5;
const ATTACH_MAX_EACH = 2 * 1024 * 1024;
const ATTACH_MAX_TOTAL = 5 * 1024 * 1024;
const MAX_BLOB_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 6 * 1024 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function u32Bytes(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

function readU32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

function concatBytes(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function bytesToBase64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function deflateBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
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
    const bin = atob(attachment.data);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) data[i] = bin.charCodeAt(i);
    parts.push(u32Bytes(data.length), data);
  }
  return concatBytes(parts);
}

async function capsuleToPlaintext(capsule) {
  const packed = packCapsuleBinary(capsule);
  const compressed = await deflateBytes(packed);
  if (compressed.length < packed.length) {
    return { bytes: compressed, pack: "bin-deflate-v1" };
  }
  return { bytes: packed, pack: "bin-v1" };
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

async function integritySeal(ciphertext) {
  const hash = await crypto.subtle.digest("SHA-256", textEncoder.encode(ciphertext));
  return Array.from(new Uint8Array(hash))
    .slice(0, 4)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function encryptFileCapsule(attachments) {
  const capsule = {
    kind: "file-drop",
    title: "Test drop",
    model: "",
    systemPrompt: "",
    userPrompt: "",
    temperature: null,
    topP: null,
    variables: {},
    notes: "",
    expectedOutput: "",
    tags: [],
    attachments,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    unlockAt: null,
  };

  const iv = randomBytes(12);
  const rawKey = randomBytes(32);
  const cryptoKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const packed = await capsuleToPlaintext(capsule);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, packed.bytes);
  const ciphertext = bytesToBase64Url(new Uint8Array(encrypted));

  const envelope = {
    id: Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, "0")).join(""),
    iv: bytesToBase64Url(iv),
    ciphertext,
    pack: packed.pack,
    label: "test",
    guards: [],
    createdAt: Date.now(),
    expiresAt: null,
    unlockAt: null,
    kdf: null,
    alg: "AES-256-GCM",
    title: "Test drop",
    seal: await integritySeal(ciphertext),
  };

  const envelopeBytes = textEncoder.encode(JSON.stringify(envelope)).length;
  return { envelope, envelopeBytes, rawBytes: attachments.reduce((s, a) => s + a.size, 0) };
}

function fillRandom(data) {
  const chunk = 65536;
  for (let offset = 0; offset < data.length; offset += chunk) {
    crypto.getRandomValues(data.subarray(offset, Math.min(offset + chunk, data.length)));
  }
}

function makeAttachment(name, sizeBytes, { random = false, fill = 0x41 } = {}) {
  const data = new Uint8Array(sizeBytes);
  if (random) {
    fillRandom(data);
  } else {
    data.fill(fill);
  }
  return {
    id: Array.from(randomBytes(8), (b) => b.toString(16).padStart(2, "0")).join(""),
    name,
    type: "application/octet-stream",
    size: sizeBytes,
    data: arrayBufferToBase64(data.buffer),
  };
}

function validateClient(files) {
  const errors = [];
  if (files.length > ATTACH_MAX_FILES) errors.push(`Limit is ${ATTACH_MAX_FILES} files.`);
  let total = 0;
  for (const f of files) {
    if (f.size > ATTACH_MAX_EACH) errors.push(`${f.name}: exceeds 2 MB.`);
    total += f.size;
  }
  if (total > ATTACH_MAX_TOTAL) errors.push("Total attachments exceed 5 MB.");
  return errors;
}

async function upload(envelope) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ envelope }),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

async function fetchCapsule(id) {
  const res = await fetch(`${API}/${id}`);
  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

async function runCase(label, files, { expectClientBlock = false } = {}) {
  const clientErrors = validateClient(files);
  if (expectClientBlock) {
    return {
      label,
      clientBlocked: clientErrors.length > 0,
      clientErrors,
      skipped: true,
    };
  }
  if (clientErrors.length) {
    return { label, clientBlocked: true, clientErrors, skipped: true };
  }

  const { envelope, envelopeBytes, rawBytes } = await encryptFileCapsule(files);
  const uploadResult = await upload(envelope);
  let roundTrip = null;
  if (uploadResult.status === 201 && uploadResult.body?.id) {
    const got = await fetchCapsule(uploadResult.body.id);
    roundTrip = got.status === 200;
  }

  return {
    label,
    files: files.length,
    rawBytes,
    envelopeBytes,
    storage: uploadResult.body?.storage || null,
    status: uploadResult.status,
    error: uploadResult.body?.error || null,
    roundTrip,
    inlineThreshold: envelopeBytes <= MAX_BLOB_BYTES ? "inline" : "blob",
  };
}

function mb(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

const KB = 1024;
const MB = 1024 * 1024;

const cases = [
  ["1 file · 100 KB random (inline path)", [makeAttachment("a.bin", 100 * KB, { random: true })]],
  ["1 file · 200 KB random (blob path)", [makeAttachment("a.bin", 200 * KB, { random: true })]],
  ["1 file · 2 MB random max single", [makeAttachment("max.bin", ATTACH_MAX_EACH, { random: true })]],
  [
    "5 files · 1 MB random each (5 MB total)",
    Array.from({ length: 5 }, (_, i) => makeAttachment(`f${i}.bin`, 1 * MB, { random: true })),
  ],
  [
    "5 files · 2 MB each (10 MB — client should block)",
    Array.from({ length: 5 }, (_, i) => makeAttachment(`f${i}.bin`, ATTACH_MAX_EACH, { random: true })),
    { expectClientBlock: true },
  ],
  [
    "6 files · 100 KB (count limit — client should block)",
    Array.from({ length: 6 }, (_, i) => makeAttachment(`f${i}.bin`, 100 * KB, { random: true })),
    { expectClientBlock: true },
  ],
  [
    "5 files · 1 MB random (max file count at 5 MB)",
    Array.from({ length: 5 }, (_, i) => makeAttachment(`f${i}.bin`, 1 * MB, { random: true })),
  ],
  [
    "1 file · 2 MB + 1 file · 3 MB (blocked — single >2 MB)",
    [makeAttachment("a.bin", ATTACH_MAX_EACH, { random: true }), makeAttachment("b.bin", 3 * MB, { random: true })],
    { expectClientBlock: true },
  ],
];

console.log(`Testing ${API}\n`);
console.log("Configured limits:");
console.log(`  Client: max ${ATTACH_MAX_FILES} files, ${mb(ATTACH_MAX_EACH)} each, ${mb(ATTACH_MAX_TOTAL)} total raw`);
console.log(`  Server: ${mb(MAX_BLOB_BYTES)} inline KV, ${mb(MAX_FILE_BYTES)} max encrypted envelope\n`);

const results = [];
for (const [label, files, opts] of cases) {
  const result = await runCase(label, files, opts || {});
  results.push(result);
  if (result.skipped) {
    console.log(`⛔ ${label}`);
    console.log(`   client blocked: ${result.clientErrors.join("; ")}\n`);
    continue;
  }
  const ok = result.status === 201;
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  console.log(
    `   raw ${mb(result.rawBytes)} · envelope ${mb(result.envelopeBytes)} · POST ${result.status} · storage ${result.storage || "—"} · GET ${result.roundTrip ? "ok" : "fail"}`,
  );
  if (result.error) console.log(`   error: ${result.error}`);
  console.log("");
}

// Binary search max single file that uploads successfully (client allows up to 2MB)
async function findMaxSingle() {
  let lo = 100 * KB;
  let hi = ATTACH_MAX_EACH;
  let best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const files = [makeAttachment("probe.bin", mid, { random: true })];
    const { envelope, envelopeBytes } = await encryptFileCapsule(files);
    if (envelopeBytes > MAX_FILE_BYTES) {
      hi = mid - 1;
      continue;
    }
    const { status, body } = await upload(envelope);
    if (status === 201) {
      best = { raw: mid, envelope: envelopeBytes, storage: body.storage };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

console.log("Finding max single file (within client 2 MB cap)…");
const maxSingle = await findMaxSingle();
if (maxSingle) {
  console.log(`  Max single file uploaded: raw ${mb(maxSingle.raw)}, envelope ${mb(maxSingle.envelope)}, storage ${maxSingle.storage}\n`);
}

// Max group within client rules: 5 files, 5 MB total
console.log("Finding max group total (5 files max, 5 MB client cap)…");
let bestGroup = null;
for (const total of [5 * MB, 4.9 * MB, 4.5 * MB]) {
  const each = Math.floor(total / 5);
  const files = Array.from({ length: 5 }, (_, i) => makeAttachment(`g${i}.bin`, each, { random: true }));
  const clientErrors = validateClient(files);
  if (clientErrors.length) continue;
  const { envelope, envelopeBytes, rawBytes } = await encryptFileCapsule(files);
  const { status, body } = await upload(envelope);
  if (status === 201) {
    bestGroup = { files: 5, rawBytes, envelopeBytes, storage: body.storage };
    break;
  }
}

if (bestGroup) {
  console.log(
    `  Max group uploaded: ${bestGroup.files} files, raw ${mb(bestGroup.rawBytes)}, envelope ${mb(bestGroup.envelopeBytes)}, storage ${bestGroup.storage}\n`,
  );
}

const passed = results.filter((r) => !r.skipped && r.status === 201).length;
const failed = results.filter((r) => !r.skipped && r.status !== 201).length;
console.log(`Summary: ${passed} upload cases passed, ${failed} failed, ${results.filter((r) => r.skipped).length} client-blocked as expected`);
