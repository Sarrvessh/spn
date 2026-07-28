/**
 * File limit analysis: local envelope sizing + minimal live upload checks.
 */

const API = process.env.CAPSULE_API || "https://capsule.sarveshpv.com/api/c";

const ATTACH_MAX_FILES = 5;
const ATTACH_MAX_EACH = 2 * 1024 * 1024;
const ATTACH_MAX_TOTAL = 5 * 1024 * 1024;
const MAX_BLOB_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 6 * 1024 * 1024;
const VERCEL_MAX_PAYLOAD = 4.5 * 1024 * 1024; // Vercel serverless request body limit

const textEncoder = new TextEncoder();

function u32Bytes(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
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

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fillRandom(data) {
  for (let offset = 0; offset < data.length; offset += 65536) {
    const slice = data.subarray(offset, Math.min(offset + 65536, data.length));
    crypto.getRandomValues(slice);
  }
}

function makeAttachment(name, sizeBytes, random = true) {
  const data = new Uint8Array(sizeBytes);
  if (random) fillRandom(data);
  else data.fill(0x41);
  return {
    id: "abcd1234",
    name,
    type: "application/octet-stream",
    size: sizeBytes,
    data: arrayBufferToBase64(data.buffer),
  };
}

function packCapsuleBinary(capsule) {
  const attachments = capsule.attachments;
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

async function deflateBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function bytesToBase64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function integritySeal(ciphertext) {
  const hash = await crypto.subtle.digest("SHA-256", textEncoder.encode(ciphertext));
  return Array.from(new Uint8Array(hash))
    .slice(0, 4)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function envelopeSizeFor(files, random = true) {
  const capsule = {
    kind: "file-drop",
    title: "Test",
    model: "",
    systemPrompt: "",
    userPrompt: "",
    temperature: null,
    topP: null,
    variables: {},
    notes: "",
    expectedOutput: "",
    tags: [],
    attachments: files.map((f) => makeAttachment(f.name, f.size, random)),
    createdAt: new Date().toISOString(),
    expiresAt: null,
    unlockAt: null,
  };

  const iv = randomBytes(12);
  const rawKey = randomBytes(32);
  const cryptoKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const packed = packCapsuleBinary(capsule);
  const compressed = await deflateBytes(packed);
  const bytes = compressed.length < packed.length ? compressed : packed;
  const pack = compressed.length < packed.length ? "bin-deflate-v1" : "bin-v1";
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, bytes);
  const ciphertext = bytesToBase64Url(new Uint8Array(encrypted));
  const envelope = {
    id: "test",
    iv: bytesToBase64Url(iv),
    ciphertext,
    pack,
    label: "test",
    guards: [],
    createdAt: Date.now(),
    alg: "AES-256-GCM",
    title: "Test",
    seal: await integritySeal(ciphertext),
  };
  const rawTotal = files.reduce((s, f) => s + f.size, 0);
  const envelopeBytes = textEncoder.encode(JSON.stringify(envelope)).length;
  return { rawTotal, envelopeBytes, storage: envelopeBytes <= MAX_BLOB_BYTES ? "inline" : "blob" };
}

function fmt(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function upload(envelope) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ envelope }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function buildAndUpload(files) {
  const capsule = {
    kind: "file-drop",
    title: "Live test",
    attachments: files.map((f) => makeAttachment(f.name, f.size, true)),
    createdAt: new Date().toISOString(),
  };
  const iv = randomBytes(12);
  const rawKey = randomBytes(32);
  const cryptoKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const packed = packCapsuleBinary(capsule);
  const compressed = await deflateBytes(packed);
  const bytes = compressed.length < packed.length ? compressed : packed;
  const pack = compressed.length < packed.length ? "bin-deflate-v1" : "bin-v1";
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, bytes);
  const ciphertext = bytesToBase64Url(new Uint8Array(encrypted));
  const envelope = {
    id: Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, "0")).join(""),
    iv: bytesToBase64Url(iv),
    ciphertext,
    pack,
    label: "test",
    guards: [],
    createdAt: Date.now(),
    alg: "AES-256-GCM",
    title: "Live test",
    seal: await integritySeal(ciphertext),
  };
  const uploadResult = await upload(envelope);
  let getStatus = null;
  if (uploadResult.status === 201 && uploadResult.body.id) {
    const got = await fetch(`${API}/${uploadResult.body.id}`);
    getStatus = got.status;
  }
  return { envelopeBytes: textEncoder.encode(JSON.stringify(envelope)).length, uploadResult, getStatus };
}

const MB = 1024 * 1024;
const KB = 1024;

console.log("=== Prompt Capsule file limits ===\n");
console.log("UI / client rules (app.js):");
console.log(`  Max files at once:     ${ATTACH_MAX_FILES}`);
console.log(`  Max per file:          ${fmt(ATTACH_MAX_EACH)}`);
console.log(`  Max total raw size:    ${fmt(ATTACH_MAX_TOTAL)}`);
console.log("\nServer rules (api):");
console.log(`  Inline KV threshold:   ${fmt(MAX_BLOB_BYTES)} encrypted envelope`);
console.log(`  Max encrypted envelope:${fmt(MAX_FILE_BYTES)}`);
console.log(`  Above ${fmt(MAX_BLOB_BYTES)} → Vercel Blob\n`);

console.log("--- Envelope sizing (incompressible / random bytes, realistic worst case) ---\n");
const sizingCases = [
  { label: "1 × 100 KB", files: [{ name: "a.bin", size: 100 * KB }] },
  { label: "1 × 200 KB", files: [{ name: "a.bin", size: 200 * KB }] },
  { label: "1 × 2 MB (max single)", files: [{ name: "a.bin", size: ATTACH_MAX_EACH }] },
  { label: "5 × 1 MB (5 MB total)", files: Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.bin`, size: 1 * MB })) },
  { label: "4 × 1 MB (4 MB total)", files: Array.from({ length: 4 }, (_, i) => ({ name: `f${i}.bin`, size: 1 * MB })) },
  { label: "2 × 2 MB (4 MB total)", files: [{ name: "a.bin", size: ATTACH_MAX_EACH }, { name: "b.bin", size: ATTACH_MAX_EACH }] },
  { label: "5 × 900 KB (~4.39 MB)", files: Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.bin`, size: 900 * KB })) },
];

for (const c of sizingCases) {
  const { rawTotal, envelopeBytes, storage } = await envelopeSizeFor(c.files);
  const fitsClient = c.files.length <= ATTACH_MAX_FILES
    && c.files.every((f) => f.size <= ATTACH_MAX_EACH)
    && rawTotal <= ATTACH_MAX_TOTAL;
  const fitsServer = envelopeBytes <= MAX_FILE_BYTES;
  const fitsVercel = envelopeBytes <= VERCEL_MAX_PAYLOAD;
  console.log(
    `${c.label}: raw ${fmt(rawTotal)} → envelope ${fmt(envelopeBytes)} (${storage}) · client ${fitsClient ? "OK" : "BLOCK"} · server ${fitsServer ? "OK" : "413"} · vercel ${fitsVercel ? "OK" : "413"}`,
  );
}

console.log("\n--- Finding max random-data group under Vercel ~4.5 MB payload ---");
let maxGroupVercel = null;
for (let totalMb = 5000; totalMb >= 2500; totalMb -= 25) {
  const total = Math.floor((totalMb / 1000) * MB);
  const count = 5;
  const each = Math.floor(total / count);
  const files = Array.from({ length: count }, (_, i) => ({ name: `f${i}.bin`, size: each }));
  const rawTotal = each * count;
  if (rawTotal > ATTACH_MAX_TOTAL) continue;
  const { envelopeBytes, storage } = await envelopeSizeFor(files);
  if (envelopeBytes <= VERCEL_MAX_PAYLOAD) {
    maxGroupVercel = { count, each, rawTotal, envelopeBytes, storage };
    break;
  }
}
if (maxGroupVercel) {
  console.log(
    `  Max group (Vercel): ${maxGroupVercel.count} files × ${fmt(maxGroupVercel.each)} = ${fmt(maxGroupVercel.rawTotal)} raw → ${fmt(maxGroupVercel.envelopeBytes)} envelope (${maxGroupVercel.storage})`,
  );
}

console.log("\n--- Finding max random-data group under 6 MB server cap ---");
let maxGroup = null;
for (let totalMb = 5000; totalMb >= 3500; totalMb -= 50) {
  const total = Math.floor((totalMb / 1000) * MB);
  const count = 5;
  const each = Math.floor(total / count);
  const files = Array.from({ length: count }, (_, i) => ({ name: `f${i}.bin`, size: each }));
  const rawTotal = each * count;
  if (rawTotal > ATTACH_MAX_TOTAL) continue;
  const { envelopeBytes, storage } = await envelopeSizeFor(files);
  if (envelopeBytes <= MAX_FILE_BYTES) {
    maxGroup = { count, each, rawTotal, envelopeBytes, storage };
    break;
  }
}
if (maxGroup) {
  console.log(
    `  Max group: ${maxGroup.count} files × ${fmt(maxGroup.each)} = ${fmt(maxGroup.rawTotal)} raw → ${fmt(maxGroup.envelopeBytes)} envelope (${maxGroup.storage})`,
  );
}

console.log("\n--- Live upload verification (skipped if rate-limited) ---");
const liveCases = [
  { label: "200 KB single (blob path)", files: [{ name: "blob-test.bin", size: 200 * KB }] },
  { label: "2 MB single (max per file)", files: [{ name: "max-single.bin", size: ATTACH_MAX_EACH }] },
];
if (maxGroupVercel) {
  liveCases.push({
    label: `Max Vercel group ${maxGroupVercel.count} × ${fmt(maxGroupVercel.each)}`,
    files: Array.from({ length: maxGroupVercel.count }, (_, i) => ({ name: `g${i}.bin`, size: maxGroupVercel.each })),
  });
}

for (const c of liveCases) {
  const { envelopeBytes, uploadResult, getStatus } = await buildAndUpload(c.files);
  const ok = uploadResult.status === 201;
  console.log(
    `${ok ? "✅" : "❌"} ${c.label}: envelope ${fmt(envelopeBytes)} · POST ${uploadResult.status}${uploadResult.body.storage ? ` (${uploadResult.body.storage})` : ""}${uploadResult.body.error ? ` · ${uploadResult.body.error}` : ""} · GET ${getStatus ?? "—"}`,
  );
}

console.log("\n--- Summary for user ---");
console.log(`Max files: ${ATTACH_MAX_FILES}`);
console.log(`Max single file: ${fmt(ATTACH_MAX_EACH)}`);
console.log(`Max group raw (UI): ${fmt(ATTACH_MAX_TOTAL)}`);
if (maxGroupVercel) {
  console.log(`Max group raw (Vercel + random data): ~${fmt(maxGroupVercel.rawTotal)} (${maxGroupVercel.count} files)`);
}
if (maxGroup) {
  console.log(`Max group raw (server code only, random data): ~${fmt(maxGroup.rawTotal)} — blocked by Vercel payload limit before server cap`);
}
console.log(`Note: compressible files (text, code) may use the full ${fmt(ATTACH_MAX_TOTAL)} UI cap because encryption shrinks the payload.`);
