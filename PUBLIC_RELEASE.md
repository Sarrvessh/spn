# Capsule Account-Free Release

## Current Hosting Status

On 2026-10-06 the user requested removing the temporary Sites hosting and using
the existing Vercel deployment instead. Public access to the Sites project was
revoked; it is owner-private, not deleted or unpublished. The available Sites
tools do not expose a deletion/unpublish operation. Do not republish it publicly.

Vercel migration is prepared but not deployed. The user identified the existing
project as `spn` in `sarrvesshs-projects`, with deployment hostname
`spn-2tcdw9kps-sarrvesshs-projects.vercel.app` and dashboard deployment
`8T4tKiFAoS3R17ghnLfqYgd4fEXD`. The Vercel integration is connected, but both
project and deployment inspection return 403: the connection is not authorized
for this team. Reconnect with access to `sarrvesshs-projects` before deploying.
No CLI credentials or `.vercel/project.json` are available as a fallback.
The signed-in Vercel dashboard independently confirms the repository link to
`Sarrvessh/spn`, production branch `main`, and domain `capsule.sarveshpv.com`.
GitHub push authentication was verified. Use the existing Git integration rather
than creating a new Vercel project.

The previous Sites URL was:
https://capsule-private-sharing.sarrvessh.chatgpt.site

## Included

- White responsive workspace with Send prompt, Send files and Open routes.
- AES-256-GCM encrypted prompt links with optional password protection.
- Encrypted portable file capsules: 5 files, 2 MB each, 5 MB total.
- Prompt templates, local draft recovery, history, duplication and encrypted backup/restore.
- Explicit device-storage disclosure and local data removal.
- No accounts, account providers, backend requests or user-content uploads.

Prompt links are capped at 12,000 characters; larger prompts use an encrypted
Capsule download. Files are shared as downloads, not hosted links. Copies cannot
be revoked. Burn-after-read, expiry, scheduled unlock, collections, large hosted
transfers and cloud inboxes are excluded rather than simulated.

Local history can include decryption keys. Drafts are stored unencrypted on the
device. Password protection is optional; anyone with a key-bearing link or file
can open it. Share passwords separately.

## Evidence

- 44 automated tests passed; build and syntax checks passed.
- Browser verified prompt creation and direct-link decryption on `/open`.
- Browser verified selecting a synthetic attachment and local file encryption.
- Download control ran, but the in-app browser did not expose a completion event;
  saved download bytes were not independently verified in that browser.
- Mobile screenshot and DOM check: white background, 390px width, no horizontal overflow.
- Desktop accessibility tree checked; final desktop screenshot capture failed.
- Hosting reported deployment `succeeded` with the public URL above.

## Rebuild And Deploy To Vercel

Run `npm run build:guest`. The frontend-only staging folder is `guest-release`;
its `vercel.json` is copied from `vercel.guest.json`, serving only `dist` with
explicit rewrites for `/workspace`, `/send/prompt`, `/send/files` and `/open`.
Link this directory to the verified existing Vercel project before deploying.
Preserve that project's identity, domain and environment; do not create a new
project or overwrite its settings without checking its current deployment.

For Git-triggered deployments from the repository root, `vercel.json` builds the
account-free output with `node scripts/build-guest.cjs`. The deployment allowlist
in `.vercelignore` excludes `api`, account code, reports and local credentials.
The original account-enabled configuration is preserved in `vercel.accounts.json`.
Pushing the release commit to `main` triggers the existing Vercel project.

## Previous Sites Publication (Historical)

Run `npm run build:guest`. The allowlisted build excludes backend source, secrets,
tests, reports and local user data. `guest-release/.openai/hosting.json` retains
the Site identity and SPA route fallback. Keep this manifest; do not create a new
Site for subsequent edits. Use the Sites workflow to push, package, save and
deploy the exact rebuilt source only if explicitly requested again. Source credentials are temporary and must not
be written to disk.

On Windows the publisher requires Git Bash on PATH. Set `TAR_OPTIONS=--force-local`
to prevent drive-letter paths being interpreted as remote archive locations.
If an elevated publisher differs from the checkout owner, limit any temporary
Git safe-directory exception to `E:/spn/guest-release`, not all repositories.

Site: appgprj_6ac4d385877c81919d0256b72c4b9198
Version: appgprj_6ac4d385877c81919d0256b72c4b9198~appgver_b433b55273588191a07a6f6735f12f9f
Deployment: appgdep_6ac4f14294688191bb6f4ad542e94c53
Source: b17b3a19a1eb840732d0493b80b2b3e6e0e75727
