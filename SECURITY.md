# Security

## What is protected

| Asset                                        | Protection                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| WhatsApp session (credentials + Signal keys) | AES-256-GCM in `auth_kv`, never written as plaintext files. Anyone holding a plaintext copy could take over the account. |
| Message text and raw messages                | AES-256-GCM (`messages.text_enc`, `messages.raw_enc`)                                                                    |
| Phone numbers, JIDs, contact and group names | AES-256-GCM (`peers.*_enc`, `lid_map.pn_enc`)                                                                            |
| Webhook queue                                | AES-256-GCM (`webhook_outbox.payload_enc`)                                                                               |
| Downloaded / sent media                      | AES-256-GCM files in `data/media/<message uuid>.bin` (AAD binds each file to its message)                                |
| Media metadata (mime, file name, caption)    | AES-256-GCM (`messages.media_enc`)                                                                                       |
| Lookups (by JID, by WhatsApp message id)     | HMAC-SHA256 blind indexes; no plaintext is needed                                                                        |

Left in plaintext, because queries need them and they reveal no content: UUIDs, timestamps, counters, flags, and the HMAC hashes.

## Encryption design

- `ENCRYPTION_KEY` (32 random bytes) → HKDF-SHA256 → separate keys for encryption and for indexing.
- Each value is encrypted with a random 96-bit IV and stored as `v1:<iv>:<tag>:<ciphertext>`. The column name, and for auth state the key name, is bound as AAD, so ciphertexts can't be swapped between fields.
- An encrypted canary in `meta` detects a wrong key at start-up, so the server never writes data under the wrong key.
- SQLite runs with `secure_delete=ON`, and the database is `VACUUM`ed after logout.

### Key handling

- On first run the key is generated into `.env` (mode 600). **Back it up.** Without it the data is unrecoverable, and you would need to log in again.
- In production, inject `ENCRYPTION_KEY` and `API_KEY` from a secret manager (for example systemd credentials or Vault) instead of a file.
- The key is not stored next to the database. Keep `.env` out of backups of `data/` and out of version control.

## Phone numbers never cross the MCP boundary

1. **Presenters** build MCP and webhook payloads from UUIDs and display names only.
2. **Input validation:** read tools reject anything that looks like a phone number or JID, so they can't be used to look up who a number belongs to. Send tools accept a phone number as a write-only target: it is checked with WhatsApp, and only the chat UUID and name come back. Set `ALLOW_SEND_TO_PHONE=false` to turn this off.
3. **PrivacyGuard** (`src/privacy/guard.ts`) is egress middleware applied to every tool result, tool error, notification and webhook body. It checks every field except message content (`text`, `preview`, `lastMessage`, `caption`, `fileName`) for JIDs, phone-number patterns, and the exact numbers the server knows, including in object keys and numeric values. It fails closed: a matching value is replaced with `"[redacted]"` (or "Unknown contact" for names), and the event is logged with only the field path.

Message **content** is passed through unchanged: if someone types a phone number into a chat, the agent sees it as part of the message.

## Access control

- `/mcp` requires `Authorization: Bearer <API_KEY>`, checked with a constant-time comparison.
- WhatsApp login uses a **one-time link** (`/login/<token>`, 192-bit random token) that shows the QR code. The API key is never put in a URL. The link exists only while a QR is needed: it is revoked as soon as login succeeds, and a new one is created after a logout. Login pages are sent with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- After login, every page shows only "WhatsApp is logged in." There's no web dashboard that exposes status, numbers or keys, and no web logout button. To log out, remove the linked device on your phone.
- By default the server binds to `127.0.0.1`, and localhost requests get DNS-rebinding protection from the MCP SDK. If you expose it, use TLS (a reverse proxy) and set `PUBLIC_URL`.
- Security headers: CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`.

## Logging

Logs never include message text, names, phone numbers or JIDs. pino redaction is a second safeguard. The one-time login link is printed to the console only, not to the structured log.

## Known limits

- The unofficial WhatsApp Web protocol (Baileys) can break, and its use can get a number banned.
- The process memory holds decrypted data while it runs: the in-memory contact directory and the active session.
- Prompt injection: incoming messages are untrusted text. Agents should treat message content as data, not instructions, and the send rate limits restrict how much damage a misled agent can do.

## Reporting

Please report vulnerabilities **privately**: on GitHub, open the repository's **Security** tab → **Report a vulnerability** (private advisory). Don't open a public issue. Include the steps to reproduce, and leave out any real message content, phone numbers or keys.
