# Capsule security architecture

## Release status

This repository contains two formats: legacy small capsules/collections and version-1 private chunked transfers. The new transfer integration is **disabled by default** until its storage, database, identity, cleanup and staging acceptance tests are configured. Unit tests and a synthetic benchmark are not a security audit or production certification.

## What is encrypted

- New transfers encrypt file contents, filenames, MIME types, file/chunk hashes and the reconstruction manifest in the browser. Prompts and private request links can use the same account-delivery format.
- AES-256-GCM encrypts each 8 MiB slice with an independently random 96-bit nonce. Authenticated additional data binds protocol version, transfer UUID, chunk index and plaintext length. The manifest is separately authenticated and binds the transfer UUID.
- SHA-256 checks ciphertext against the private manifest before decryption; GCM authentication and a plaintext chunk hash are checked before any write. An authenticated manifest fixes file order, lengths and chunk order.
- Password links wrap the random content key with AES-GCM and PBKDF2-SHA-256 (600,000 iterations, random 128-bit salt). Passwords are not uploaded. The key is omitted from a password link.
- Legacy capsule encryption and legacy cloud-backup encryption retain their existing formats/KDF settings. Their metadata and guarantees are different; see below.

## Keys and identities

Accounts use Supabase Auth, not custom password authentication. Confirmed email is required for authenticated API operations. Short-lived access tokens stay in tab memory; the rotating refresh token is in an HttpOnly, SameSite=Strict cookie restricted to `/api/session`, Secure in production. Cookie-bearing session operations require the configured same origin. Sign-out revokes the current refresh session; already-issued access JWTs may remain valid until expiry.

Account delivery wraps a capsule's content key separately for each recipient using Web Crypto RSA-OAEP-3072/SHA-256. One ciphertext payload can have up to 16 recipient grants plus an owner grant. The database never receives the unwrapped content key. Sender identity setup ensures an owner grant supports access on another device.

The RSA private key is encrypted in the browser using a separate vault password and PBKDF2/AES-GCM before being stored in the user's profile. Only the authenticated owner can retrieve that encrypted private key through the API. Unlocking imports a non-extractable private key into tab memory. A second device signs in and supplies the same vault password. Losing that password loses access to existing recipient grants; resetting the account password cannot recover them. Key version 1 is immutable: rotation, hardware-backed devices and automatic rewrapping are not implemented. Locking the vault or signing out clears the tab's private-key reference; JavaScript cannot guarantee physical memory zeroization.

Exact-handle discovery is authenticated, rate limited and opt-in. There is no prefix search or email directory. Availability of an opted-in exact handle is intentionally observable. Public keys come from the trusted Capsule server; there is no independently audited key-transparency directory. The selector exposes a fingerprint for out-of-band comparison. A compromised application server could substitute keys or serve malicious JavaScript. Browser E2EE does not solve a compromised endpoint or actively malicious code delivery.

## Links and recovery

A new link contains a random 256-bit retrieval capability and, unless password protected, the content key in its URL fragment. Fragments are not sent by browser HTTP requests; the client submits the capability in a POST body and the server stores its SHA-256 digest. A stolen complete link grants its authority. Browser history, clipboard, extensions, screenshots and recipients themselves can disclose links. `Referrer-Policy: no-referrer` reduces accidental forwarding.

Upload recovery metadata (including content keys) is encrypted in IndexedDB with a non-extractable device AES key. The key is also held by that origin in IndexedDB. This protects against casual plaintext storage inspection, **not** XSS or a person controlling that browser profile. No file bytes are persisted. Refresh recovery requires selecting the original files in the original order; every chunk hash is rechecked before upload resumes. Private browsing, cleared site data, or denied IndexedDB can prevent local recovery. An upload is not started if recovery cannot be saved.

Download leases are high-entropy capabilities stored in sessionStorage for same-tab retry. Treat them like credentials. Retrying a large download can reuse its lease but currently restarts progressive writing from the beginning; cross-refresh file-output checkpoints are not implemented.

## Authorization and lifecycle

All new metadata uses Postgres constraints, foreign keys, RLS and a service-only RPC. `anon` and `authenticated` have no table privileges and cannot execute the RPC. The trusted API obtains the actor ID from a verified Supabase access token, strips untrusted privileged fields and only exposes a fixed operation allowlist. Internal cleanup and notification operations are cron-only. Never expose the service-role key in frontend configuration.

Upload creation reserves quota inside a transaction serialized per owner. Part size/index are fixed at creation; a reserved ciphertext checksum cannot change. Signed PUTs bind the checksum and length, and completion verifies both through object-store HEAD before confirming the part. The provider must reject checksum mismatch. Finalization requires every part confirmed.

Download access checks explicit recipient membership, ownership or the link capability. Expiry and scheduled unlock are server checks, not just UI guards. A transaction and row lock allocate the first burn lease. Merely opening the metadata page does not consume it. Selecting a download destination and claiming the transfer reserves its single slot for up to 24 hours, bounded by expiry. Completion means the client verified all chunks, closed its output writers and acknowledged completion. It does **not** prove a human read the material. An abandoned claim becomes unavailable when its lease expires. There is no read pixel or tracking beacon.

Revoke/delete immediately block future signed-URL issuance and invalidate download leases. Already-issued GET URLs may remain usable for up to 60 seconds, PUT URLs for up to 120 seconds, and already-started requests/copies cannot be recalled. Claims do not guarantee a recipient cannot save or redistribute information. The API cannot delete a recipient's external copy.

Burn, revoke, delete and expiry queue cleanup with a ten-minute grace period. The worker removes the entire random transfer prefix, then marks it purged and releases quota. It retries failed deletion; deletion requests are idempotent. Database metadata is retained as a tombstone without content keys or encrypted manifest after purge. Object-store versioning must be disabled or noncurrent versions must have a separate enforced deletion policy. Backups have their own retention, not an instantaneous-erasure guarantee.

## Server-visible metadata

The service sees account emails in Supabase Auth; public handles; opted-in discovery/notification preferences; owner/recipient relationships; sizes, chunk count and ciphertext checksums; timing, policies, statuses and operational network metadata. It does not need plaintext filenames, message text, form values, content keys or vault passwords for the new transfer path. Display names/handles are not encrypted. Inbox rows intentionally show generic file-capsule labels before decryption.

Notifications contain no filenames, titles, keys, secret URLs or form contents. New-delivery notifications use a transactional outbox, opt-in preference, bounded retries and Resend idempotency keys. Resend necessarily learns the email address and delivery timing. Durable queuing does not imply guaranteed exactly-once email delivery.

## Legacy boundaries

Existing small capsules and collection responses remain in Redis/Vercel Blob. Blob ciphertext is publicly retrievable by its opaque object URL; the new private-transfer guarantees do not retroactively apply. Legacy capsule envelope titles may be server-visible. Small anonymous file capsules retain their 5-file/2-MiB-per-file/5-MiB-total limits. Collection responses retain their approximately 4.2 MB encrypted request limit; they do not silently gain 5 GB uploads.

Legacy owner capabilities authorize management. New uploads now require the separate owner capability to mint upload tokens or complete an upload. Completion rejects non-Blob URLs, mismatched paths, redirects and oversized fetched envelopes. Collection owner credentials now leave the client in Authorization headers rather than URL query strings; the legacy server query parameter remains accepted for compatibility. Remove that compatibility path when old clients are retired and redact query strings in infrastructure logs.

An allowed collection email now requires the actual confirmed Supabase identity, not a self-asserted email hash. Collection shared passwords/codes remain response-access checks, not independent E2EE key derivation. Their templates and responses use the existing shared fragment key. Local legacy drafts are plaintext; saved legacy history contains link/key capabilities. Encrypted backups and cloud snapshots protect their contents but do not encrypt that original local storage.

## Threat review and operational controls

| Threat | Mitigation / residual risk |
| --- | --- |
| Database/object-store disclosure | Ciphertext and encrypted keys; metadata remains visible; offline attacks against weak vault/link passwords remain possible. |
| IDOR/BOLA, guessed IDs, replay | Verified actor, explicit grants/capability hashes, immutable chunks, transactional lifecycle; a valid capability remains replayable within its policy. |
| Upload abuse | Confirmed accounts, reserved storage quota, 100 creations/account/day, per-IP/per-account API limits, part length/checksum signatures, cleanup. Anonymous small flows have separate legacy limits. |
| Download abuse | Daily owner egress issuance budget and per-request throttles. Reuse of an already-issued signed URL can bypass issuance accounting; provider/WAF/budget alarms are required for actual bandwidth. |
| Enumeration | Exact opted-in handles only; authenticated discovery capped at 20/hour per user and IP. Account signup/recovery copy avoids confirming account existence. |
| XSS / malicious files | CSP, no external preview service, escaped metadata, plain-text rendering, downloads use octet-stream. No HTML/SVG/PDF active-content preview for large transfers. User-downloaded files can still be dangerous. |
| CSRF / session theft | Same-origin session requests, HttpOnly/Secure/SameSite refresh cookie, memory-only access token. XSS can still act as the user. Configure short JWT lifetime and Supabase protections. |
| Logging / notifications | Fixed telemetry action names/status/duration only. Disable body, cookie, Authorization and signed-URL logging at proxies/APM; no content analytics. |
| Revoke/burn races | Postgres row locks and leases for new transfers. Legacy Redis locks remain lease-based and have weaker long-operation guarantees. |
| Account deletion | Password-confirmed self-service erasure revokes owned transfers immediately. A durable worker waits for object purge, removes tombstones/cloud backup, then deletes the Auth identity. It needs migration 002 and live staging validation. Anonymous links, separate collection subscriptions, downloaded copies and provider backups have separate retention. |

Ciphertext cannot be meaningfully malware-scanned by this server. Do not silently add plaintext scanning. Provide an operator abuse-report channel, investigate metadata/quotas, and suspend abusive accounts. Before public launch: independent security review, two-user real-provider acceptance tests, alerting/budget limits, restore drills, jurisdiction-specific privacy/retention review and incident response ownership.

## Primary references

- [OWASP cryptographic storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
- [OWASP key management](https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html)
- [Supabase sessions](https://supabase.com/docs/guides/auth/sessions)
- [AWS SDK checksum support](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html)
- [S3 presigned URLs and their limitations](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
