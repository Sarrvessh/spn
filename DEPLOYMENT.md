# Deploying Capsule

## Prerequisites and release gate

Use Node 22. Capsule has a static frontend and Vercel Node APIs. Supabase Auth/Postgres, Upstash Redis, private AWS S3-compatible storage and optional Resend are external services. No live credentials, schema migration or production deployment were performed during this implementation.

`TRANSFERS_ENABLED=false` is intentional. Enable only after the staging checklist below passes. `npm run dev` now serves the real API handlers and loads `.env.local` (ignored by Git). Use `PUBLIC_APP_URL=http://127.0.0.1:4174` for local development, and the exact HTTPS origin for deployment. No mock account or fake storage is used in the app. Missing credentials are shown as unavailable services.

## 1. Install and validate

```powershell
npm ci
npm run build
npm test
npm run benchmark
npm run release:check
```

`build` generates a small Lucide SVG symbol asset and syntax-checks project JavaScript. No browser code is bundled from server credentials. The benchmark creates synthetic slices, not multi-gigabyte disk fixtures. Read `reports/transfer-benchmark.json` for its limited scope.

## 2. Supabase

Create a staging Supabase project in a region suitable for your users and storage. Enable email/password authentication, require email confirmation, configure a production SMTP provider and set the exact site URL and permitted redirect URLs. Turn on Auth rate limits and abuse protections. Use a short access-token lifetime appropriate to the deployment (for example 15 minutes); test refresh across tabs.

Run `migrations/001_transfers.sql`, then `migrations/002_account_erasure.sql` **once**, as the database owner, in a new/staging project. If 001 is already applied, apply only 002. For a non-empty production database, back up first and review the migrations before applying. They are transactional, not idempotent `CREATE IF NOT EXISTS` repair scripts. No existing Redis data is migrated or deleted by the migrations.

The migration installs profiles/vaults, transfers, parts, recipient grants, download leases, usage limits, egress counters, notification outbox, indexes, RLS and a service-only transactional RPC. Do not grant the RPC to public clients. PostgREST must expose the public schema and see its new function after schema-cache refresh. Check RLS with actual anonymous and authenticated tokens in staging as well as running embedded-Postgres tests.

Account routes are `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/auth/confirm`, and `/account`. Allow the exact `/auth/confirm` URL in Supabase redirect settings. The app supports both standard Supabase confirmation/recovery links (session fragments are removed immediately and exchanged on an explicit click) and token-hash templates. Preferred templates, following [Supabase email template guidance](https://supabase.com/docs/guides/auth/auth-email-templates):

```html
<!-- Confirm signup -->
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup">Confirm your email</a>
<!-- Reset password -->
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery">Reset your password</a>
<p>Or enter this recovery code at /reset-password: {{ .Token }}</p>
```

The confirmation screen requires an explicit click before consuming a one-time token. Disable SMTP link tracking. Recovery changes only the account password, never the encryption-vault password. Account tokens stay in memory; rotating refresh credentials use a same-origin HttpOnly cookie. A pending recipient link is kept only in tab-scoped session storage for 15 minutes, including its fragment, never in a login query string. Test both link templates and OTP recovery in staging.

Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and server-only `SUPABASE_SERVICE_ROLE_KEY` in the deployment environment. Set `PUBLIC_APP_URL` to the exact HTTPS origin. Do not inject the service key into an HTML page or frontend build variable.

`GET /api/health` is a no-store liveness and configuration-readiness endpoint, not an external connectivity test. `npm run release:check` fails closed when required production configuration is absent. It does not apply migrations, send mail, probe bucket privacy, or approve a release: run the staging matrix and storage conformance test below as well.

## 3. Private storage

AWS S3 is the reference provider for this implementation. A capsule is an application-level multipart transfer comprising up to 661 independently encrypted objects under `transfers/v1/<UUID>/<part-index>`. This is **not** S3's CreateMultipartUpload protocol and requires no object composition: recipients decrypt/write each part directly. Each object is at most 8 MiB + 16 bytes. This supports per-part recovery without a 5 GB temporary object or duplicate local archive.

Supabase Storage supports S3/multipart and plan-dependent limits, but compatibility alone does not establish checksum guarantees. Other S3-compatible endpoints are supported through configuration only if they pass the conformance test. Do not remove checksum checks to make a provider pass. See [Supabase S3 uploads](https://supabase.com/docs/guides/storage/uploads/s3-uploads) and [file limits](https://supabase.com/docs/guides/storage/uploads/file-limits).

Create a **private**, dedicated bucket with Block Public Access enabled. Disable ACLs. Do not enable public read or a CDN/public origin. Use least-privilege server credentials scoped to listing that prefix and putting/getting/deleting those objects. Do not permit bucket-policy or ACL modification. Use a separate test bucket for conformance checks.

Configure `TRANSFER_S3_BUCKET`, `TRANSFER_S3_REGION`, `TRANSFER_S3_ACCESS_KEY_ID`, `TRANSFER_S3_SECRET_ACCESS_KEY`. Leave `TRANSFER_S3_ENDPOINT` empty for AWS. A compatible endpoint must use HTTPS and must validate SHA-256 PUT checksums and return SHA-256 from HEAD. Configure bucket CORS:

```json
[
  {
    "AllowedOrigins": ["https://YOUR-CAPSULE-ORIGIN"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type", "x-amz-checksum-sha256"],
    "ExposeHeaders": ["ETag", "x-amz-checksum-sha256"],
    "MaxAgeSeconds": 300
  }
]
```

The backend SDK also needs permission to retrieve checksums (including appropriate KMS permissions if using SSE-KMS). Avoid versioning, or configure noncurrent-version expiry and deletion; otherwise deleting an object may only create a delete marker. Add a bucket lifecycle expiry for the transfer prefix at 35 days as an orphan safety net, longer than Capsule's maximum 30-day availability. Also abort provider-native incomplete multipart uploads after one day as defense in depth, although this engine does not create those.

Load staging credentials into your local environment and run:

```powershell
node --env-file=.env.local scripts/check-storage.cjs
```

This creates random test bytes under a fresh UUID, validates signed PUT/GET, HEAD checksum/length, corrupt-PUT rejection and deletion. It does not test browser CORS. No credentials are printed. The committed CSP supports AWS/Supabase storage hosts; for another provider add **only its required origin**, never `*`.

## 4. Redis, old links and email

Configure Upstash REST URL/token using `.env.example`. Redis remains authoritative for legacy capsule links, collections, encrypted workspace snapshots and distributed API throttles. Keep its data when deploying this upgrade. Optional legacy `BLOB_READ_WRITE_TOKEN` belongs to the old small-envelope path, not the new private transfer bucket.

Verify a sending domain in Resend. Set `RESEND_API_KEY` and `NOTIFICATION_FROM`. Direct-delivery emails are opt-in in identity settings and use the Postgres outbox. Collection response emails use the existing Redis queue. Neither includes private content. Auth confirmation/recovery emails are Supabase SMTP configuration, separate from Capsule's notification API calls.

## 5. Cleanup, quota and deployment

Account erasure requires fresh password confirmation and exact same-origin requests. It disables discovery/notifications, revokes owned transfer access and queues hosted cleanup. Database triggers reject new uploads/profile writes after the request. The worker deletes object prefixes, marks them purged, then claims account erasure jobs with a five-minute worker lease. It removes owned transfer tombstones, encrypted cloud backup, and finally the Supabase identity via the Admin API. A failed step returns a retryable failure; account deletion is never reported complete before hosted purge. Received grants are removed; other senders' objects, anonymous owner-capability links, downloaded copies, and separate collection email subscriptions remain. The UI names these boundaries. Test password rejection, public-role denial, repeated requests, worker failure/retry, and actual Admin deletion in staging. Monitor cleanup failures, not only liveness.

Set a strong random `CRON_SECRET`. Vercel sends it as the Bearer credential for scheduled endpoints. `vercel.json` schedules transfer cleanup/outbox processing hourly and legacy cleanup daily. Hourly scheduling and the 300-second worker budget require a compatible hosting plan. Do not silently drop cleanup on a free-tier deployment: use an authenticated external scheduler or an appropriate plan. The endpoint accepts only GET with the secret. Monitor non-2xx results and last successful runs.

Each transfer cleanup pass removes at most 20 prefixes; scale worker frequency/limits when backlog grows. Expired/abandoned sessions are marked unavailable, then purged after ten minutes plus scheduler delay. Quota stays charged until confirmed purge. A provider lifecycle rule is the last-resort orphan bound, not a substitute for working cleanup.

Change product limits centrally in `capsule_limits`. Defaults are 5,000,000,000 bytes/capsule, 50 GB reserved storage/account, 100 GB/day of signed download issuance/account, max 30-day retention and 100 creations/account/day. The client currently advertises the maximum 5 GB; lowering the database limit enforces the lower cap but requires corresponding UI copy/config updates. Pricing/billing is not implemented.

Deploy the project through your normal Vercel deployment workflow after environment configuration. The checked-in rewrites preserve `/open?transfer=<UUID>#...`, `/c/...`, `/r/...`, `/f/...` and workspace pages. Validate the exact deployed origin. Never deploy a preview environment with production credentials or broad allowed redirects. Production uses HSTS, CSP, no-referrer and nosniff headers.

For local real-API development, use Vercel CLI with environment variables and Supabase/S3 staging resources. `npm run preview` is static-only; it runs on 4174, or `node scripts/preview.cjs 4175` if occupied.

## 6. Required staging acceptance

- Confirm two real test accounts, verify refresh/sign-out/recovery and exact opt-in handle discovery.
- Send an anonymous legacy link, open it in another context, verify its password and expiry.
- Send direct and link transfers; recipient B opens, unrelated C is rejected. Verify account A cannot mutate B's upload IDs.
- Test 10 MB, 100 MB, 500 MB, 1 GB and a 5 GB transfer over actual object storage. Measure browser memory, upload times and egress. The committed synthetic benchmark is not evidence of those network/browser results.
- Interrupt an upload after many chunks, refresh, reselect original files and resume. Reselect a changed file and verify rejection. Cancel and verify prefix deletion.
- Verify checksums, downloaded bytes and a deliberately corrupted test object. Never accept a successful corrupted download.
- Race two burn claims; only one lease should succeed. Complete download before cleanup, retry the same lease, revoke during transfer and verify newly requested URLs fail.
- Delete a transfer and verify the object prefix is empty after the worker runs. Test retry on storage failure and exhausted notification attempts.
- Test opt-out, direct-delivery notification, direct request delivery, encrypted response, owner review and export.
- Check mobile and desktop controls. Large progressive downloads require desktop File System Access; other browsers get a one-file fallback capped at 32 MiB and an explicit compatibility message above that cap.
- Audit logs for secrets. Set actual provider cost/bandwidth alarms, authentication alerts, cleanup backlog alerts and a working abuse-report contact.

## Operational caveats

Cost follows retained GB-days, retrievals, transfer fan-out and egress; direct sending avoids encrypting/storing separate 5 GB copies per recipient but does not eliminate per-recipient download cost. At the 50 GB reservation default, 100 fully utilized accounts can reserve 5 TB. Estimate costs using your chosen provider/region's current price sheet and set hard budgets before enabling signups. Signed-URL issuance counters are not exact billing meters because a URL can be reused within its validity window.

Account deletion is currently an operator procedure: revoke owned transfers, run and verify purge, delete transfer tombstones, remove that user's Redis workspace/notification references, and then delete the Supabase Auth account. Review backup retention separately. Do not promise immediate physical erasure or formal compliance.
