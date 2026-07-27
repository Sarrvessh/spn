# Prompt Capsule

Prompt Capsule is a no-database, browser-only encrypted prompt sharing app.

## Link Format

Generated links use a VaultDrop-style fragment:

```text
https://example.com/?tab=receive#data=<base64url-envelope>&key=<base64url-key>
```

Password-protected links omit `key`; the receiver derives the AES key from the
password with PBKDF2.

```text
https://example.com/?tab=receive#data=<base64url-envelope>
```

## Security Model

- Prompt plaintext is encrypted and decrypted only in the browser.
- AES-256-GCM is used for encryption.
- Password mode derives the key with PBKDF2-SHA256.
- No database, backend API, or server-side prompt storage is required.
- Link fragments are not sent to the server during normal browser navigation.

## Guard Behavior

- **Burn after read:** marks the capsule as burned in the receiving browser and
  removes the fragment from the address bar after successful decryption.
- **Password protect:** requires the recipient password to derive the key.
- **Auto-expiry:** stores an expiration timestamp inside the encrypted capsule
  and refuses to render after that time.

Because there is no server storage, burn-after-read and expiry are client-side
guards. A copied link cannot be globally revoked without persistent server state.

## Run Locally

Open `index.html` in a modern browser.
