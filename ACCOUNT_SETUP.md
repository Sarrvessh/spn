# Accounts, Encrypted Sync, and Notifications

For the current persistent-session, identity/vault and private-transfer setup,
follow [DEPLOYMENT.md](DEPLOYMENT.md) and [SECURITY.md](SECURITY.md).
The notes below describe the earlier small-capsule sync integration; its old
memory-only-session limitation is superseded by the HttpOnly refresh-cookie flow.

Set these environment variables in the API environment, then redeploy:

- SUPABASE_URL: your Supabase project URL.
- SUPABASE_ANON_KEY: the project public anon key (never use service_role here).
- RESEND_API_KEY: server-side sending key.
- NOTIFICATION_FROM: an address on a verified Resend sending domain.
- CRON_SECRET: existing cleanup/notification job secret.
- Existing Redis and optional Blob credentials remain required for storage.

Enable email/password authentication and email confirmation in Supabase. Configure
the production site URL and confirmation redirect allowlist. Confirm the email,
then sign in from Account & encrypted sync. Sessions are held in memory and expire;
refreshing the page requires sign-in. Account passwords do not decrypt workspaces.

Use a separate workspace encryption password. The server stores only an encrypted
snapshot in Redis for 90 days, with a 2 MB sync limit. Restore merges saved records,
preserves local records, and rejects capacity overflow. Revision checks prevent
overwriting another device's upload. Forgotten encryption passwords cannot be reset.

After sign-in, select a saved collection and enable emails. Owner capability is
verified and delivery uses the authenticated account's confirmed email. Email
contains neither submission content nor private links. Failed deliveries retry via
the existing authenticated cron job; daily cron may delay retries until the next
run. Resend idempotency keys suppress repeated sends. Verify delivery in a configured
staging environment before enabling the feature for production users.

Unfinished editor drafts stay on the device as plaintext, excluding passwords and
file bytes. Reset clears the corresponding draft. Encrypted cloud sync includes
saved exchanges and collection ownership, not plaintext drafts.

Reference: https://supabase.github.io/auth/ and
https://resend.com/docs/api-reference/emails/send-email
