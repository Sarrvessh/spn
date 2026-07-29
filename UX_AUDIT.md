# Capsule UX Audit

## Product Direction

Capsule should feel like a premium private exchange tool, not a dashboard or form builder. The core promise is simple: seal private work, share a short link, and let the receiver open it in a calm space with visible security state.

## Prompt

- Keep Prompt as the flagship workspace: title, model, system prompt, user prompt, variables, expected output, notes, and tags remain structured instead of collapsing into a textarea.
- Reduce ambient complexity by keeping advanced model/schema fields behind disclosure.
- Implemented live composer feedback for prompt length, detected `{{variables}}`, and active security guards.
- Implemented auto-growing textareas so the editor behaves more like a focused native writing surface.

## Files

- Files should create a `/c/` link as the primary outcome, with portable capsule download as backup.
- Implemented direct Blob upload activation for large encrypted envelopes so the browser no longer depends only on the Vercel request body limit.
- Improved attachment chips with file-kind badges and clearer ready/error states.
- Kept local encryption, drag/drop, paste, remove, size meter, burn-after-read, password, expiry, and scheduled unlock.

## Collect

- Requests and Forms are logically the same collection engine with different presets: one recipient vs multiple responses.
- Keep Collect as the decision point and retain Request/Form as specialized shapes under the same encrypted submission model.
- Keep advanced security settings disclosed so common collection creation stays focused.

## Receive

- Receive should be the quietest screen: open, verify, reveal, download/copy, then stop.
- Improved receive empty state with compact trust signals.
- Improved wrong-password, expired, burned, missing, and storage-configuration errors so the user understands what happened.
- Kept local decrypt, integrity seal, metadata, prompt readout, attachment downloads, and burn-after-read handling.

## Platform

- No traditional database.
- KV stores short-id pointers, state, TTL, burn flags, collection records, and audit receipts.
- Blob stores encrypted payloads that are too large or unsuitable for inline KV.
- URL fragments carry decryption keys so keys are not sent to the server.
