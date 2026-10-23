# Architecture

This guide explains how the WhatsApp MCP server is put together, so you can find your way around in about 15 minutes. Every source file also starts with a `@module` comment saying what it does and why it exists.

## The layers

```
                ┌──────────────────────────────────────────────┐
  MCP clients → │ mcp/          toolsets · presenters · sessions│ ← HTTP: http/ (/mcp, /login)
  webhooks    ← │ integrations/ webhook dispatcher              │
                ├──────────────────────────────────────────────┤
                │ services/     resolver · chats · inbox ·      │  business logic,
                │               messaging · media · status      │  no MCP / HTTP / Baileys
                ├──────────────────────────────────────────────┤
                │ whatsapp/     gateway (interface) · client ·  │  the only Baileys code
                │               ingest · parser · content       │
                ├──────────────────────────────────────────────┤
                │ store/        peers · messages · reactions ·  │  the only SQL
                │               auth-state · media-cache · outbox│
                ├──────────────────────────────────────────────┤
                │ core/         crypto · db · events · limits · │  generic, reusable
                │               files · errors                  │
                └──────────────────────────────────────────────┘
  cross-cutting: privacy/guard.ts (egress filter) · events.ts (app events) · config.ts · logger.ts
  composition:   app.ts builds everything; index.ts starts it
```

### Rules

The rules are enforced by `test/unit/architecture.test.ts`.

| Layer                            | May import                                                                                            | Must not                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `core/`                          | `core/`, Node built-ins, npm packages                                                                 | anything from the app                                         |
| `store/`                         | `core/`, `whatsapp/jid` helpers, `whatsapp/parser` types, `baileys` (only to serialize protocol data) | services, MCP, HTTP                                           |
| `whatsapp/`                      | `core/`, `store/`, `events`, `baileys`                                                                | services, MCP, HTTP                                           |
| `services/`                      | `store/`, `whatsapp/gateway.ts` (the interface), `whatsapp/content.ts`, `core/`, `privacy/`           | `whatsapp/client.ts`, `whatsapp/ingest.ts`, `baileys`, `mcp/` |
| `mcp/`, `http/`, `integrations/` | `services/`, presenters, `privacy/`, `events`                                                         | `baileys`, the database, the WhatsApp client internals        |

Why these rules exist:

- **WhatsApp can be swapped out.** Services only know `WhatsAppGateway`, so Baileys could be replaced (for example by a whatsmeow or Rust bridge) by writing one new `client.ts`.
- **Logic is reusable.** Services contain the rules (who can be messaged, limits, quoting, long-polling). MCP tools, webhooks or a future CLI all reuse them.
- **Everything is testable.** Tests run the real services and MCP server against a `FakeGateway`, with no WhatsApp account needed.
- **Privacy has one choke point.** Only `store/peers.ts` holds phone numbers, only presenters build outputs, and the guard checks everything on the way out.

## The life of an incoming message

```
WhatsApp ──► Baileys socket (whatsapp/client.ts)
               │ messages.upsert (type "notify" = live)
               ▼
         Ingestor (whatsapp/ingest.ts)
               │ • parse payload → {type, text, media}     (whatsapp/parser.ts)
               │ • LID ↔ phone mapping, sender/chat → UUID  (store/peers.ts)
               │ • insert encrypted, assign seq + UUID       (store/messages.ts)
               │ • reactions → store/reactions.ts
               ▼
         EventBus "message.received"  (events.ts, agent-safe payload)
               ├─► McpSessionManager.broadcast → notifications/message + inbox resource update
               ├─► WebhookDispatcher → encrypted outbox → signed POST with retries
               └─► InboxService long-poll wakes up → get_new_messages returns it
```

Details worth knowing:

- **History sync** (right after login) is stored but raises no events and no unread counts.
- **Notes to yourself:** a message you type into your own "Message yourself" chat on your phone counts as incoming. Messages the server sends are registered with `Ingestor.markOutgoing` first, so they never count. This prevents agent reply loops.
- **LIDs:** WhatsApp sometimes identifies people by a `…@lid` id. When the matching phone number becomes known, the two peers are merged, and the old UUID keeps working as an alias.

## The life of a tool call

```
MCP client ── POST /mcp (Bearer API key) ──► http/app.ts ─► McpSessionManager (session per client)
   │
   ▼
mcp/toolsets/<area>.ts   validate args (zod) → call ONE service method → presenter shape
   │                      (wrapped by registerGuardedTool)
   ▼
services/*.service.ts    rules: resolve chat (UUID / name / phone), limits, quoting, …
   │
   ├─► whatsapp/gateway (send, download, lookup)     ├─► store/* (read/write, encrypted)
   ▼
mcp/presenters.ts        { id: UUID, name, … }, never numbers
   │
   ▼
privacy/guard.ts         final scan of every non-content field; fails closed
   │
   ▼
JSON result (+ image/audio/file content for get_media)
```

Errors: services throw `UserError`, `RateLimitError` or `NotConnectedError` (from `core/errors.ts`). The tool wrapper shows their message, or the login hint for `NotConnectedError`. Any other error is logged and reported to the client only as "Internal error".

## Data and encryption

| Data                                             | Where                   | How                                                  |
| ------------------------------------------------ | ----------------------- | ---------------------------------------------------- |
| WhatsApp session (credentials, Signal keys)      | `auth_kv`               | AES-256-GCM per value                                |
| People / groups: JID, phone, names               | `peers`, `lid_map`      | AES-256-GCM; looked up by HMAC "blind index"         |
| Messages: text, media info, raw protocol message | `messages`              | AES-256-GCM; WhatsApp message id stored only as HMAC |
| Reactions                                        | `reactions`             | AES-256-GCM emoji                                    |
| Media files                                      | `data/media/<uuid>.bin` | AES-256-GCM, AAD = message UUID                      |
| Webhook queue                                    | `webhook_outbox`        | AES-256-GCM                                          |

Keys come from `ENCRYPTION_KEY` through HKDF (`core/crypto/cipher.ts`). Each ciphertext is bound to its column name (AAD), so values can't be swapped between fields. See [SECURITY.md](../SECURITY.md) for the threat model.

## Where to change things

| You want to…                        | Go to                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| add or change a tool                | `src/mcp/toolsets/` + a service in `src/services/` ([CONTRIBUTING.md](../CONTRIBUTING.md#add-a-tool)) |
| change who/how messages can be sent | `services/messaging.service.ts`, `services/chat-resolver.ts`, `services/limits.ts`                    |
| support a new WhatsApp message type | `whatsapp/parser.ts` (incoming), `whatsapp/content.ts` (outgoing)                                     |
| store something new                 | new migration in `store/migrations.ts` + a repository in `store/`                                     |
| add a setting                       | `config.ts`, `.env.example`, README configuration table                                               |
| change what agents see              | `mcp/presenters.ts` (and keep `privacy/guard.ts` tests green)                                         |
| change the login page               | `http/app.ts`, `public/login.html`                                                                    |
| replace Baileys                     | implement `WhatsAppGateway` (`whatsapp/gateway.ts`) and pass it via `createApp({ createGateway })`    |

## Tests

```
test/
  helpers/       FakeGateway, fixtures (fictional numbers), env (in-memory DB + services), leak scanner
  unit/          core, store, whatsapp, services, privacy, architecture rules
  integration/   mcp/ (one file per toolset + privacy + sessions), http/login, webhook, app (whole app boots)
```

Tests never contact WhatsApp. Live checks against a real account are done by hand (see [CONTRIBUTING.md](../CONTRIBUTING.md#live-testing)).
