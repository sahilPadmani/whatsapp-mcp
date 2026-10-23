# Changelog

All notable changes are listed here. The project follows [Semantic Versioning](https://semver.org).

## [0.1.0] – 2026-10-23

First public release.

### Features

- WhatsApp login with a one-time QR link; the session persists, encrypted, until you log out from your phone.
- 11 MCP tools in 6 toolsets (status, chats, messages, sending, media, reactions), configurable with `TOOLSETS`.
- Receiving through `get_new_messages` (cursor + long-poll), MCP notifications, and signed webhooks with a durable retry outbox.
- Quoted replies with a typing indicator; send rate limits and a daily cap on new chats.
- Media in and out: photos, videos, audio, voice notes, documents and stickers.
- Emoji reactions, sent and received.
- Sending to phone numbers (write-only) with a WhatsApp account check.

### Security

- AES-256-GCM field-level encryption for everything at rest, and HMAC blind indexes for lookups.
- Phone numbers and WhatsApp IDs never cross the MCP boundary; a privacy guard checks every outgoing payload.
- The API key is used only as a Bearer token and never appears in URLs. There is no web dashboard.

### Engineering

- Layered architecture (core → store → whatsapp → services → mcp/http), with architecture rules enforced by tests.
- 127 automated tests and about 95% line coverage.
