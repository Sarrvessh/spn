// Opt-in staging conformance check. Writes only random ciphertext-like test bytes.
const { storage, configured } = require('../api/_lib/transfer-storage');
const crypto = require('node:crypto');
async function main() {
  if (!configured()) throw new Error('Set TRANSFER_S3_* server environment variables before running this check.');
  const id = crypto.randomUUID(), bytes = crypto.randomBytes(1040), object = storage();
  const part = {index:0,size:bytes.length,checksum:crypto.createHash('sha256').update(bytes).digest('base64url')};
  try {
    const target = await object.upload(id,part);
    const uploaded = await fetch(target.url,{method:'PUT',headers:target.headers,body:bytes,signal:AbortSignal.timeout(30000)});
    if (!uploaded.ok) throw new Error(`PUT failed (${uploaded.status}).`);
    await object.verify(id,part);
    const source = await object.download(id,part);
    const anonymousUrl = new URL(source.url); anonymousUrl.search = "";
    const anonymous = await fetch(anonymousUrl,{signal:AbortSignal.timeout(30000)});
    if (anonymous.ok) throw new Error('Bucket permits anonymous object access. Do not enable transfers.');
    const response = await fetch(source.url,{signal:AbortSignal.timeout(30000)});
    if (!response.ok || !Buffer.from(await response.arrayBuffer()).equals(bytes)) throw new Error('Download integrity mismatch.');
    // A checksum-bound signature must reject mutated bytes.
    const corrupted = Buffer.from(bytes); corrupted[0] ^= 1;
    const rejected = await fetch(target.url,{method:'PUT',headers:target.headers,body:corrupted,signal:AbortSignal.timeout(30000)});
    if (rejected.ok) throw new Error('Provider accepted a corrupt chunk. Do not enable transfers.');
    console.log('PASS: signed PUT/GET, exact length, SHA-256 validation and private-object round trip.');
  } finally { await object.remove(id); }
  console.log('PASS: test objects removed. Verify bucket CORS from a staging browser separately.');
}
main().catch((error) => { console.error(error.message); process.exitCode=1; });
