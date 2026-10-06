const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const configured = () => Boolean(process.env.TRANSFER_S3_BUCKET && process.env.TRANSFER_S3_REGION && process.env.TRANSFER_S3_ACCESS_KEY_ID && process.env.TRANSFER_S3_SECRET_ACCESS_KEY);
function storage() {
  if (!configured()) throw new Error("Private object storage is not configured.");
  const client = new S3Client({ region: process.env.TRANSFER_S3_REGION, endpoint: process.env.TRANSFER_S3_ENDPOINT || undefined, forcePathStyle: Boolean(process.env.TRANSFER_S3_ENDPOINT), credentials: { accessKeyId: process.env.TRANSFER_S3_ACCESS_KEY_ID, secretAccessKey: process.env.TRANSFER_S3_SECRET_ACCESS_KEY } });
  const Bucket = process.env.TRANSFER_S3_BUCKET;
  function object(id, index) {
    if (!/^[a-f0-9-]{36}$/.test(id) || !Number.isInteger(index) || index < 0 || index > 660) throw new Error("Invalid object reference.");
    return `transfers/v1/${id}/${index}`;
  }
  const checksum = (part) => Buffer.from(part.checksum, "base64url").toString("base64");
  return {
    async upload(id, part) {
      const headers = { "Content-Type": "application/octet-stream", "x-amz-checksum-sha256": checksum(part) };
      const command = new PutObjectCommand({ Bucket, Key: object(id, part.index), ContentType: headers["Content-Type"], ContentLength: part.size, ChecksumSHA256: checksum(part) });
      return { url: await getSignedUrl(client, command, { expiresIn: 120, unhoistableHeaders: new Set(["x-amz-checksum-sha256"]) }), headers };
    },
    async verify(id, part) {
      const result = await client.send(new HeadObjectCommand({ Bucket, Key: object(id, part.index), ChecksumMode: "ENABLED" }), { abortSignal: AbortSignal.timeout(15000) });
      if (result.ContentLength !== part.size || result.ChecksumSHA256 !== checksum(part)) throw Object.assign(new Error("Stored chunk integrity check failed."), { status: 409 });
    },
    async download(id, part) {
      return { url: await getSignedUrl(client, new GetObjectCommand({ Bucket, Key: object(id, part.index), ResponseContentType: "application/octet-stream", ResponseCacheControl: "no-store", ResponseContentDisposition: "attachment" }), { expiresIn: 60 }) };
    },
    async remove(id) {
      object(id, 0);
      const Prefix = `transfers/v1/${id}/`;
      // All parts of one transfer fit a single page; loop also removes obsolete retry objects.
      for (let page = 0; page < 10; page++) {
        const found = await client.send(new ListObjectsV2Command({ Bucket, Prefix, MaxKeys: 1000 }), { abortSignal: AbortSignal.timeout(15000) });
        if (!found.Contents?.length) return;
        const result = await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: found.Contents.map(({ Key }) => ({ Key })), Quiet: true } }), { abortSignal: AbortSignal.timeout(15000) });
        if (result.Errors?.length) throw new Error("Object cleanup must be retried.");
      }
      throw new Error("Object cleanup page limit reached.");
    }
  };
}
module.exports = { storage, configured };
