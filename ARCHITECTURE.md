# Capsule Architecture

Capsule uses short links as stable pointers to encrypted content. The server never stores plaintext or keys.

## Storage Roles

- **Browser:** encrypts and decrypts prompts, files, collection templates, and submissions.
- **KV / Redis:** stores short-id records, status, expiry, burn state, and storage pointers.
- **Blob storage:** stores encrypted envelopes or direct-uploaded encrypted payloads when configured.
- **URL fragment:** carries the AES key as `#key=...` for non-password capsules. Fragments are not sent to the server.

## Capsule Lifecycle

1. `POST /api/c/init` reserves an 8-character id and writes a pending KV record.
2. The browser encrypts the capsule locally.
3. Small/compatible envelopes are sent to `POST /api/c/complete`.
4. Larger direct-upload payloads use `POST /api/upload-token`, upload encrypted bytes to Blob, then complete the manifest.
5. The receiver opens `/c/:id#key=...`; the app fetches the encrypted envelope and decrypts locally.

## KV Record States

```js
{
  storage: "pending" | "inline" | "blob",
  status: "pending",
  envelope: {},        // inline only
  blobUrl: "...",      // blob only
  uploads: [],         // direct-uploaded encrypted payload pointers
  burnAfterRead: true,
  expiresAt: 1780000000000
}
```

## Burn After Read

Burn-after-read opens use `POST /api/c/:id`, not a normal preview `GET`. The server serializes the consume operation with a Redis lock, deletes the KV pointer, and deletes Blob payloads when configured.

## Expiry

KV records use TTL. Blob URLs are added to a sorted expiry index and cleaned opportunistically during capsule traffic plus the daily cron route.

## Current Client Mode

The static client uses `init -> complete` for Prompt and Files, so short ids are reserved before activation. When the encrypted envelope is too large for a Vercel Function request, the browser asks `/api/upload-token` for a scoped Blob client token, uploads the encrypted envelope directly to Blob, then asks `/api/c/complete` to activate that uploaded Blob as the short-link payload.
