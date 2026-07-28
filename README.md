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

**File Drop** uses a portable `.capsule.html` download plus an optional short receive link (`?tab=receive&kind=file`). File bytes are not stored in KV.

## Security Model

- Plaintext is encrypted and decrypted only in the browser.
- AES-256-GCM for encryption; PBKDF2-SHA256 for password mode.
- The server stores opaque encrypted blobs only — no keys, no plaintext.
- Link `#key` fragments are not sent to the server during navigation.

## Deploy on Vercel (free)

1. Push this repo and import it in [Vercel](https://vercel.com).
2. In the project → **Storage** → create **KV** or **Upstash Redis** (free tier) and link it to the project.
3. Redeploy. Vercel injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.

### Local dev with API

```bash
npm install
npx vercel dev
```

Opening `index.html` directly works for UI, but short-link create/receive needs `vercel dev` or a deployed environment with KV configured.

## Guard Behavior

- **Burn after read:** deletes the KV blob on first fetch and marks burned locally.
- **Password protect:** requires the recipient password to derive the key.
- **Auto-expiry:** KV TTL follows the capsule expiry; expired links return 404.

## Run Locally (static only)

Open `index.html` in a modern browser. Short links require KV — use `vercel dev` or deploy.
