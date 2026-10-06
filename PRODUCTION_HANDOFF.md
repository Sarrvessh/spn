# Capsule implementation handoff

Status: integrated release candidate, **not production-approved**. External services have not been provisioned or tested with real credentials. Do not advertise a verified production 5 GB service based only on the local benchmark.

## 1. Product summary

The white My Capsules / Send / Collect / Open workspace now has a dedicated private-transfer composer, native file selection/drop/paste, protection controls, progress, pause/resume/cancel, exact recipient lookup, account inbox folders and a unified transfer recipient page. Existing small anonymous links, portable backups, prompts, requests, forms and response tools remain available.

Dedicated `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/auth/confirm`, and `/account` pages are now part of the app shell. Account settings hold the vault/profile, encrypted sync, notification preferences, local data removal and password-confirmed account erasure. Pending recipient routes survive authentication without putting decryption keys into login query strings. Sign-out clears decrypted transfer views and cancels active operations; stale inbox responses cannot cross account boundaries.

## 2. Architecture

Vanilla browser JavaScript and Web Crypto; Vercel metadata APIs; Supabase Auth and Postgres for new transfers/identity/grants/leases/outbox; a private S3 adapter for encrypted parts; Upstash for distributed throttles and the existing small-capsule/collection services. New transfer objects never transit a Vercel request body. There is no invented demo backend or successful-looking response when services are unavailable.

## 3. Large file system

The enforced maximum is 5,000,000,000 bytes across up to 64 files. Preparation hashes source slices without storing file bytes. Two upload workers at most encrypt 8 MiB chunks, persist encrypted recovery metadata, obtain checksum-bound PUT URLs, upload, verify HEAD and confirm each part. Finalization requires all parts. Refresh recovery verifies reselected files and skips confirmed parts. The object format is an application-level multipart manifest, not provider-native S3 multipart composition.

Downloads validate ciphertext SHA-256, authenticate AES-GCM, verify plaintext SHA-256 and await progressive output writes. File System Access provides large output without a complete Blob. The fallback is restricted to one file <=32 MiB. No intermediate encrypted download is required. Large output is not supported in browsers without progressive filesystem output; the UI says so rather than allocating 5 GB.

## 4. Security model

See `SECURITY.md` for precise new/legacy boundaries, threat review and residual risks. New data and filenames are encrypted client-side. Random retrieval capabilities, owner/recipient authorization, service-only RPC privileges, private storage, immutable checksum reservations, quotas and transactional leases protect server operations. No compliance certification is claimed.

## 5. Direct sharing

Supabase users create an opt-in exact handle and password-encrypted RSA-OAEP vault. The sender wraps a content key for each recipient and the owner while uploading content once. Received/Sent/Drafts lists expose intentional operational metadata, not plaintext titles. Prompts and generated request links can be staged into the same direct-delivery flow; small prompt/request capsules can be read inline as inert text or an explicitly opened, same-origin request link. Email notifications use an opt-in transactional outbox.

## 6. Database changes

`migrations/001_transfers.sql` defines limits, profiles, transfers, parts, grants, leases, egress counters and the notification outbox. Constraints, foreign keys, indexes, RLS and private RPC permissions are included. Existing Redis data remains intact. The schema was executed in embedded PostgreSQL tests, **not** a live Supabase project.

`migrations/002_account_erasure.sql` adds the private erasure queue, write guards and leased cleanup RPC. Tests exercise service-role access, immediate revocation, rejection of new writes, purge-before-identity ordering, idempotent requests and isolation of other owners.

## 7. Tests

Latest local verification: **43 tests passed**, `npm run build` passed,
`git diff --check` passed, and `npm audit --omit=dev` reported zero vulnerabilities.

Run `npm test` and `npm run build`. Tests cover legacy behavior, routing, real Web Crypto encryption/wrapping, cross-recipient key rejection, passwords, bounded chunk reads, retry/resume/reconstruction/corruption, actual SQL authorization/lifecycle/quota constraints and public-role denial. Session tests use mocked identity responses, not a real signup. SQL tests use PGlite; concurrent independent connections and Supabase-specific integration still require staging.

`scripts/check-storage.cjs` is an opt-in real-provider conformance test for signatures, checksums, corruption rejection and deletion. It was not run without credentials. `npm audit` was clean after updating the compatible transitive HTTP dependency.

## 8. Browser QA

Verified locally: desktop/mobile transfer layout, visible upload icon, file chooser selection, delivery radio controls, protection disclosure, one-time option, recipient URL rendering, refresh preservation, return to workspace, back navigation and explicit unavailable-service errors. No horizontal overflow was observed at the mobile test size. A shared navigation handler bug that cancelled ordinary input/form clicks was fixed and regression-covered.

The new white login screen was checked at desktop and 390px mobile viewports: no horizontal overflow, visible account navigation, signup/recovery routes, password visibility, and recipient-to-login/back navigation. Screenshots: `reports/login-desktop.jpg` and `reports/login-mobile.jpg`. Real signup/recovery/erasure remains a staging requirement.

Not verified: actual hosted anonymous creation/open, two real account sign-ins/direct delivery, real-object-store interruption/recovery/download, email receipt, storage purge, account Admin deletion or a production request-response loop. The development server now runs real API handlers and reads `.env.local`, but no external credentials are configured. See the mandatory staging matrix in `DEPLOYMENT.md`.

## 9. Performance

`reports/transfer-benchmark.json` records a synthetic Node v22 Web Crypto run: 10 MB, 100 MB, 500 MB, 1 GB and 5 GB. The 5 GB case used 597 chunks, a maximum 8,388,608-byte slice and roughly 67.1 MB peak sampled ArrayBuffer memory, completing its local CPU/synthetic-sink work in 16.21 seconds. These are **not** network upload speeds, browser-memory readings or object-storage throughput. The test exercises the complete encryption loop without giant fixtures. Real browser profiling remains a release gate.

## 10. Deployment

Follow `DEPLOYMENT.md`: install/build/test, apply migrations 001 and 002, configure confirmed Auth/recovery emails, private storage/CORS/checksums, Redis, Resend, CSP origins, cron authentication, hourly cleanup and provider lifecycle policies. Run the storage conformance test, release configuration check and staging acceptance matrix, then enable `TRANSFERS_ENABLED`. The 4174 development server uses actual API handlers, not fake storage.

## 11. External configuration

See `.env.example`. Required for new transfers: Supabase URL/anon/service-role keys, private S3 bucket/region/access credentials, Upstash REST credentials, canonical app origin and cron secret. Optional delivery emails require Resend and a verified sending domain. Vercel's hourly cron/worker settings require a compatible plan or a correctly authenticated external scheduler. No secrets are committed.

## 12. Remaining limitations

- Production credentials, deployment, live migration and the real-provider acceptance matrix are outstanding.
- Progressive large downloads require File System Access. Download retries reuse a lease but restart output; there is no cross-refresh download checkpoint.
- Legacy response uploads and anonymous capsules retain their existing small-payload limits. Large request-response attachments have not been migrated to the new transfer protocol.
- Vault key rotation/device revocation/key-transparency and a product abuse-report workflow are not implemented. Operational procedures and provider safeguards are required. Self-service erasure is implemented in migration 002 and requires staging confirmation of cleanup/Admin deletion.
- Inbox rows do not perform encrypted-title search or live push updates. Refresh loads paginated metadata. Legacy local drafts remain plaintext.

## 13. Security caveats

An actively compromised frontend or endpoint can steal plaintext/keys; E2EE is not protection against malicious code delivery. Links and download leases are bearer capabilities. A lost vault password cannot be recovered by resetting account login. Previously downloaded copies cannot be revoked. Signed URLs have a short residual validity window. Server-visible account, size, relationship and timing metadata is intentional. Legacy public Blob ciphertext does not inherit the new private-bucket semantics. Independent security review remains necessary before inviting users to trust sensitive material.

## 14. Next five improvements

1. Complete and automate the real Supabase/S3/two-account staging matrix, including browser memory and connection-loss tests.
2. Add independent cryptographic/application security review and key-transparency/rotation design.
3. Migrate large collection response attachments onto recipient-specific transfer grants.
4. Add resumable progressive download checkpoints and broaden safe browser output support.
5. Add abuse reporting, cleanup/outbox alerts and actual provider bandwidth-budget enforcement.
