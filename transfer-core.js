(function (root) {
  "use strict";
  const CHUNK_SIZE = 8 * 1024 * 1024;
  const MAX_BYTES = 5_000_000_000;
  const MAX_FILES = 64;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fail = (message) => { throw Object.assign(new Error(message), { status: 422 }); };
  function encode(bytes) {
    let text = "";
    for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function decode(text) {
    if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) fail("Invalid encoded value.");
    return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (x) => x.charCodeAt(0));
  }
  const random = (n) => crypto.getRandomValues(new Uint8Array(n));
  const hash = async (bytes) => encode(await crypto.subtle.digest("SHA-256", bytes));
  const importKey = (bytes) => crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  const aad = (id, index, size) => encoder.encode(`capsule-transfer:1:${id}:${index}:${size}`);
  function abort(signal) { signal?.throwIfAborted(); }
  function deadline(signal, milliseconds) { return signal ? AbortSignal.any([signal, AbortSignal.timeout(milliseconds)]) : AbortSignal.timeout(milliseconds); }
  async function seal(key, value, context) {
    const iv = random(12);
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(context) }, key, encoder.encode(JSON.stringify(value)));
    return { iv: encode(iv), data: encode(data) };
  }
  async function unseal(key, value, context) {
    return JSON.parse(decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(value.iv), additionalData: encoder.encode(context) }, key, decode(value.data))));
  }
  async function passwordKey(password, salt) {
    if (typeof password !== "string" || password.length < 12) fail("Use a protection password of at least 12 characters.");
    const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function protectKey(raw, password) {
    const salt = random(16);
    return { salt: encode(salt), ...await seal(await passwordKey(password, salt), encode(raw), "capsule-password:1") };
  }
  async function recoverKey(envelope, password) {
    if (decode(envelope.salt).length !== 16) fail("Invalid protection envelope.");
    return decode(await unseal(await passwordKey(password, decode(envelope.salt)), envelope, "capsule-password:1"));
  }
  async function createVault(password) {
    const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["wrapKey", "unwrapKey"]);
    const salt = random(16);
    return {
      publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
      privateKey: { salt: encode(salt), ...await seal(await passwordKey(password, salt), await crypto.subtle.exportKey("jwk", pair.privateKey), "capsule-vault:1") }
    };
  }
  async function unlockVault(vault, password) {
    const jwk = await unseal(await passwordKey(password, decode(vault.salt)), vault, "capsule-vault:1");
    return crypto.subtle.importKey("jwk", jwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["unwrapKey"]);
  }
  async function wrap(raw, jwk) {
    const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["wrapKey"]);
    const contentKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
    return encode(await crypto.subtle.wrapKey("raw", contentKey, publicKey, { name: "RSA-OAEP" }));
  }
  async function unwrap(wrapped, privateKey) {
    return crypto.subtle.unwrapKey("raw", decode(wrapped), privateKey, { name: "RSA-OAEP" }, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  }
  async function prepare(files, options = {}) {
    if (!files.length || files.length > MAX_FILES || files.some((f) => !Number.isSafeInteger(f.size) || f.size < 0)) fail("Choose between 1 and 64 files.");
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    if (bytes > MAX_BYTES) fail("A capsule can contain at most 5 GB.");
    const session = { version: 1, id: crypto.randomUUID(), key: encode(random(32)), access: encode(random(32)), bytes, files: [], parts: [], created: Date.now(), options };
    let scanned = 0;
    for (let f = 0; f < files.length; f++) {
      const file = files[f], chunks = [];
      for (let start = 0; start < file.size || start === 0; start += CHUNK_SIZE) {
        abort(options.signal);
        const plain = await file.slice(start, Math.min(start + CHUNK_SIZE, file.size)).arrayBuffer();
        const index = session.parts.length;
        session.parts.push({ index, file: f, start, size: plain.byteLength, plainHash: await hash(plain), iv: encode(random(12)) });
        chunks.push(index); scanned += plain.byteLength;
        options.progress?.({ stage: "Preparing", completed: scanned, total: bytes });
      }
      session.files.push({ name: file.name, size: file.size, type: file.type || "application/octet-stream", chunks });
    }
    // Only data belongs in persisted recovery state, never callbacks or passwords.
    session.options = { expires: options.expires, unlock: options.unlock || null, burn: Boolean(options.burn), mode: options.mode || "link" };
    return session;
  }
  async function validateFiles(files, session, signal) {
    if (files.length !== session.files.length) fail("Reselect the same files in the original order.");
    for (let i = 0; i < files.length; i++) if (files[i].size !== session.files[i].size || files[i].name !== session.files[i].name) fail("The selected files do not match this transfer.");
    for (const part of session.parts) {
      abort(signal);
      if (await hash(await files[part.file].slice(part.start, part.start + part.size).arrayBuffer()) !== part.plainHash) fail("A file changed. Select the original files or start a new transfer.");
    }
  }
  async function retry(operation, signal, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    for (let attempt = 0; ; attempt++) {
      abort(signal);
      try { return await operation(); }
      catch (error) {
        abort(signal);
        if (attempt >= 4 || error.name === "OperationError" || (error.status && error.status < 500 && ![408, 429].includes(error.status))) throw error;
        await sleep(Math.min(16000, 500 * 2 ** attempt) + Math.random() * 250);
      }
    }
  }
  async function upload(files, session, { api, save, progress = () => {}, signal, concurrency = 2 }) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) fail("Transfer concurrency must be 1 or 2.");
    const key = await importKey(decode(session.key));
    const remote = await api("resume", { id: session.id });
    if (remote.ready) { progress({ stage: "Ready", completed: session.bytes, total: session.bytes }); return; }
    const done = new Set(remote.parts.filter((p) => p.confirmed).map((p) => p.index));
    let completed = session.parts.filter((p) => done.has(p.index)).reduce((n, p) => n + p.size, 0), cursor = 0;
    const pending = session.parts.filter((p) => !done.has(p.index));
    let saving = Promise.resolve(), failure;
    const persist = () => { saving = saving.then(() => save(session)); return saving; };
    async function worker() {
      while (cursor < pending.length && !failure) {
        abort(signal);
        const part = pending[cursor++];
        const plain = await files[part.file].slice(part.start, part.start + part.size).arrayBuffer();
        if (await hash(plain) !== part.plainHash) fail("A source file changed during upload.");
        const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: decode(part.iv), additionalData: aad(session.id, part.index, part.size) }, key, plain);
        part.cipherHash = await hash(ciphertext);
        await persist();
        await retry(async () => {
          const target = await api("part", { id: session.id, index: part.index, size: ciphertext.byteLength, checksum: part.cipherHash });
          const response = await fetch(target.url, { method: "PUT", body: ciphertext, headers: target.headers, signal: deadline(signal, 180000) });
          if (!response.ok) throw Object.assign(new Error("A chunk could not upload. This transfer can be resumed."), { status: response.status });
          await api("confirm", { id: session.id, index: part.index });
        }, signal);
        completed += part.size;
        progress({ stage: "Encrypting & uploading", completed, total: session.bytes });
      }
    }
    const results = await Promise.allSettled(Array.from({ length: concurrency }, () => worker().catch((error) => { failure = error; throw error; })));
    if (results.some((r) => r.status === "rejected")) throw failure;
    abort(signal);
    progress({ stage: "Finalizing", completed, total: session.bytes });
    const manifest = await seal(key, { version: 1, id: session.id, files: session.files, parts: session.parts, bytes: session.bytes }, `capsule-manifest:1:${session.id}`);
    await retry(() => api("finalize", { id: session.id, manifest }), signal);
    progress({ stage: "Ready", completed: session.bytes, total: session.bytes });
  }
  function validateManifest(manifest, id) {
    if (manifest.version !== 1 || manifest.id !== id || !Array.isArray(manifest.files) || !Array.isArray(manifest.parts) || manifest.files.length < 1 || manifest.files.length > MAX_FILES || manifest.parts.length > 661) fail("Invalid file manifest.");
    let total = 0, index = 0;
    for (let f = 0; f < manifest.files.length; f++) {
      const file = manifest.files[f]; let size = 0;
      if (typeof file.name !== "string" || !Array.isArray(file.chunks) || !file.chunks.length) fail("Invalid file metadata.");
      for (const n of file.chunks) {
        const p = manifest.parts[n];
        if (n !== index++ || !p || p.index !== n || p.file !== f || p.start !== size || !Number.isInteger(p.size) || p.size < 0 || p.size > CHUNK_SIZE || decode(p.iv).length !== 12 || decode(p.cipherHash).length !== 32 || decode(p.plainHash).length !== 32) fail("Invalid chunk manifest.");
        size += p.size;
      }
      if (file.size !== size) fail("File size does not match its chunks.");
      total += size;
    }
    if (index !== manifest.parts.length || total !== manifest.bytes || total > MAX_BYTES) fail("Incomplete file manifest.");
    return manifest;
  }
  async function readManifest(key, encrypted, id) { return validateManifest(await unseal(key, encrypted, `capsule-manifest:1:${id}`), id); }
  async function verifyDestination(manifest, fileIndex, file, signal) {
    validateManifest(manifest, manifest.id);
    const metadata = manifest.files[fileIndex];
    if (!metadata || !file || !Number.isSafeInteger(file.size) || file.size > metadata.size) fail("The saved file does not match this capsule.");
    let count = 0, bytes = 0;
    for (const n of metadata.chunks) {
      abort(signal);
      const part = manifest.parts[n];
      if (part.start + part.size > file.size) break;
      if (await hash(await file.slice(part.start, part.start + part.size).arrayBuffer()) !== part.plainHash) fail("The saved file has changed or belongs to another capsule. Choose a new destination.");
      count++; bytes += part.size;
    }
    return { count, bytes };
  }
  async function download(manifest, key, { api, sinks, signal, verified = [], progress = () => {} }) {
    validateManifest(manifest, manifest.id);
    if (sinks.length !== manifest.files.length) fail("Choose a destination for every file.");
    const offsets = manifest.files.map((file, i) => {
      const count = verified[i] || 0;
      if (!Number.isInteger(count) || count < 0 || count > file.chunks.length) fail("Invalid download checkpoint.");
      return file.chunks.slice(0, count).reduce((sum, n) => sum + manifest.parts[n].size, 0);
    });
    let completed = offsets.reduce((a, b) => a + b, 0);
    const closed = new Set();
    try {
      progress({ stage: "Decrypting & saving", completed, total: manifest.bytes });
      for (let f = 0; f < manifest.files.length; f++) {
        for (const n of manifest.files[f].chunks.slice(verified[f] || 0)) {
          const p = manifest.parts[n]; abort(signal);
          const plain = await retry(async () => {
            const target = await api("download", { id: manifest.id, index: n });
            const response = await fetch(target.url, { signal: deadline(signal, 120000) });
            if (!response.ok) throw Object.assign(new Error("A chunk could not download."), { status: response.status });
            // Limit the network stream too: a malicious store must not allocate a multi-GB buffer.
            const reader = response.body.getReader(), encrypted = new Uint8Array(p.size + 16);
            let length = 0;
            try {
              while (true) {
                const { done, value } = await reader.read(); if (done) break;
                if (length + value.length > encrypted.length) fail("Encrypted chunk exceeds its declared size.");
                encrypted.set(value, length); length += value.length;
              }
            } finally { await reader.cancel().catch(() => {}); }
            if (length !== encrypted.length || await hash(encrypted) !== p.cipherHash) fail("Encrypted chunk integrity check failed.");
            const output = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(p.iv), additionalData: aad(manifest.id, n, p.size) }, key, encrypted);
            if (await hash(output) !== p.plainHash) fail("Decrypted chunk integrity check failed.");
            return output;
          }, signal);
          await sinks[f].write(plain);
          offsets[f] += p.size; completed += p.size; progress({ stage: "Decrypting & saving", completed, total: manifest.bytes });
        }
        await sinks[f].close(); closed.add(f);
      }
      await api("finish", { id: manifest.id });
    } catch (error) {
      await Promise.allSettled(sinks.map(async (sink, i) => {
        if (closed.has(i)) return;
        try { if (sink.pause) await sink.pause(offsets[i]); else await sink.abort?.(); }
        catch { await sink.abort?.(); }
      }));
      throw error;
    }
  }
  const api = { CHUNK_SIZE, MAX_BYTES, MAX_FILES, encode, decode, random, hash, importKey, seal, unseal, passwordKey, protectKey, recoverKey, createVault, unlockVault, wrap, unwrap, prepare, validateFiles, retry, upload, readManifest, validateManifest, verifyDestination, download };
  if (typeof module !== "undefined") module.exports = api; else root.CapsuleTransfer = api;
})(typeof window !== "undefined" ? window : globalThis);
