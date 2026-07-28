# Prompt Capsule

Prompt Capsule is a browser-only encrypted prompt and file sharing app.

## Link Format

New prompt capsules use a **short link** with an 8-character id:

```text
https://your-app.vercel.app/c/K7mQ9x2p
https://your-app.vercel.app/c/K7mQ9x2p#key=<base64url-key>
```

- The **encrypted envelope** is stored in Vercel KV (ciphertext only).
- The **AES key** stays in the URL `#key` fragment (never sent to the server).
- Password-protected capsules omit `#key`; the receiver derives the key with PBKDF2.

Legacy fragment links still work:

```text
https://example.com/?tab=receive#data=<base64url-envelope>&key=<base64url-key>
```

**File Drop** uses the same short-link flow when the encrypted drop fits storage limits:

- **≤256 KB** — stored inline in KV (same as prompts).
- **256 KB–5 MB** — ciphertext stored in **Vercel Blob**; KV holds only the blob pointer.
- **Upload fails or drop too large** — falls back to a portable `.capsule.html` download plus an optional receive hint link (`?tab=receive&kind=file`).

File bytes are never stored in plaintext — only encrypted envelopes.

## Security Model

- Plaintext is encrypted and decrypted only in the browser.
- AES-256-GCM for encryption; PBKDF2-SHA256 for password mode.
- The server stores opaque encrypted blobs only — no keys, no plaintext.
- Link `#key` fragments are not sent to the server during navigation.

## Deploy on Vercel (free)

1. Push this repo and import it in [Vercel](https://vercel.com).
2. In the project → **Storage** → create **KV** or **Upstash Redis** (free tier) and link it to the project.
3. For file drops over ~256 KB, also enable **Blob** storage on the same project (free tier). Vercel injects `BLOB_READ_WRITE_TOKEN` automatically.
4. Redeploy. Vercel injects Redis env vars automatically (often prefixed, e.g. `SPN_KV_REST_API_URL` — the API detects these).

### Local dev with API

```bash
npm install
npx vercel dev
```

Opening `index.html` directly works for UI, but short-link create/receive needs `vercel dev` or a deployed environment with KV configured.

## Guard Behavior

- **Burn after read:** deletes the stored capsule on first fetch (KV entry and Blob if used) and marks burned locally.
- **Password protect:** requires the recipient password to derive the key.
- **Auto-expiry:** KV TTL follows the capsule expiry; expired links return 404.

## Run Locally (static only)

Open `index.html` in a modern browser. Short links require KV — use `vercel dev` or deploy.
