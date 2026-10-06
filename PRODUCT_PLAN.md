# Capsule Product Build

Audience: individuals sharing private prompts and files. Preserve a white,
work-focused interface, existing recipient routes, browser encryption, and keys
in URL fragments. Deliver features sequentially with working controls.

## Phases

- [x] 1. Personal workspace: recent exchanges, search/filter, copy saved links,
  portable downloads, password-encrypted workspace backup and restore.
- [ ] 2. Reliability: fresh-browser create/open/decrypt tests, expiry/burn tests,
  old routes, failed-upload retry, deployment smoke tests with Redis configured.
- [ ] 3. Ownership: independent sender capability, status, revoke/delete,
  duplicate-as-new. Never send fragment keys for owner authentication.
- [ ] 4. Templates: editable prompt handoff and document/feedback presets.
- [ ] 5. Recipient experience: upload progress, retained-file retry, accessible
  keyboard/mobile states, precise deletion and identity wording.
- [ ] 6. Operations: redacted telemetry, storage/cleanup health, abuse protection.
- [ ] 7. Notifications: verified destinations, mail provider, idempotent jobs.
- [ ] 8. Optional accounts: authentication, encrypted sync and recovery design.
- [ ] 9. Optional teams: roles, membership, key distribution, audit history.
- [ ] 10. Billing: checkout/webhooks, enforced quotas, storage and retention plans.

## Service Dependencies

Email requires a sending provider and verified domain; accounts require identity
configuration; billing requires a merchant account. Do not present mock controls
as working integrations. Hosted link tests require API and Redis, not static preview.

## Verification

Syntax and behavioral checks per phase. Desktop/mobile browser verification. Never
log full share URLs, fragment keys, passwords, decrypted content, or owner tokens.

Phase 1 validation: existing 12 regression tests and two encrypted recovery tests
pass. Mobile recovery UI inspected. Static preview: http://127.0.0.1:4173.
Saved states are explicitly local observations, not server status. Old records
without hosted URLs retain portable download access. Backup restore merges records
and rejects capacity overflow instead of silently discarding records.
