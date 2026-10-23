# Contributing

## Setup

```bash
npm install
npm run check   # lint + typecheck + format check + tests with coverage
npm run dev     # run locally (first start generates .env secrets and prints a login link)
```

Requires Node ≥ 22.13, for the built-in `node:sqlite`. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first.

## Conventions

- **One job per file.** The `@module` comment at the top says what the file does, why it exists, and what must never happen in it. The architecture test fails if a file has no such comment.
- **JSDoc on every export:** purpose, parameters and return value where they aren't obvious, the errors thrown (`@throws`), and any security notes.
- **Inline comments explain _why_,** never _what_. They're needed especially for WhatsApp quirks (428 browser error, expected 515, LIDs, self-notes).
- **Layer rules** ([ARCHITECTURE.md](docs/ARCHITECTURE.md#rules)) are enforced by `test/unit/architecture.test.ts`.
- **Errors:** throw `UserError` / `RateLimitError` / `NotConnectedError` from `src/core/errors.ts` for expected failures. Their messages are shown to agents, so **never include phone numbers, JIDs or secrets** in them.
- **Privacy:**
    - Outputs are built only in `mcp/presenters.ts`, using UUIDs and names.
    - New output fields must not carry numbers or JIDs.
    - Message content fields (`text`, `caption`, `fileName`, `preview`, `lastMessage`) are the only ones the guard skips.
- **Style:** Prettier (4 spaces, single quotes, width 140) and ESLint (`typescript-eslint`). Files are kebab-case; services are `<name>.service.ts`.

## Add a tool

1. **Logic → service.** Add a method to the fitting service in `src/services/`, or create `src/services/<area>.service.ts` and wire it in `src/services/index.ts`. The method:
    - takes plain inputs;
    - resolves chats with `ChatResolver`;
    - calls `requireConnected` / `requireReadable` (`services/connection.ts`);
    - throws `UserError` for bad input;
    - returns domain objects (`Peer`, `StoredMessage`).
2. **Tool → toolset.** In `src/mcp/toolsets/<area>.ts`, call `registerGuardedTool(ctx, 'tool_name', { title, description, inputSchema, annotations }, handler)`.
    - The handler only validates (zod), calls the service, and returns `ctx.present.*(…)`.
    - Write the `description` for the agent: when to use the tool and what it returns.
    - Set `readOnlyHint` / `openWorldHint` annotations.
3. **New toolset?** Create the file, export a `Toolset`, and add it to `TOOLSETS` in `src/mcp/toolsets/index.ts`. Its name becomes a valid `TOOLSETS` value.
4. **Output shape** → add or extend a method in `src/mcp/presenters.ts`.
5. **Tests:**
    - a unit test for the service in `test/unit/services/`;
    - an integration test through MCP in `test/integration/mcp/<area>.test.ts`, using `createHarness()`;
    - assert `findIdentifiers(result, PHONES)` is empty.
6. **Docs:** [docs/TOOLS.md](docs/TOOLS.md), the README tool table, and `INSTRUCTIONS` in `src/mcp/server.ts` if agents need to know.

## Add a migration

Append a new SQL string to `MIGRATIONS` in `src/store/migrations.ts`. **Never edit a shipped migration.** The database version (`PRAGMA user_version`) decides what runs. Name encrypted columns `*_enc` and HMAC columns `*_hash`. Add or extend the repository in `src/store/`, with a test that also checks no plaintext ends up in the table.

## Add a setting

1. Add it to the zod schema in `src/config.ts`, with a default and a doc comment.
2. Document it in `.env.example` and the README configuration table.
3. Read it in `src/app.ts` and pass it to the module that needs it. Modules don't read `process.env` themselves.

## Support a new WhatsApp message type

- **Incoming:** add a case to `describeMessage` in `src/whatsapp/parser.ts`, plus a test in `test/unit/whatsapp/`.
- **Outgoing:** add a builder in `src/whatsapp/content.ts` and a gateway method in `src/whatsapp/gateway.ts` + `client.ts`, then implement it in `test/helpers/fakes.ts`.

## Testing

| Command                                  | What                                                    |
| ---------------------------------------- | ------------------------------------------------------- |
| `npm test`                               | everything (about 2 s)                                  |
| `npm run test:unit` / `test:integration` | one level                                               |
| `npm run test:coverage`                  | with thresholds: lines 85%, branches 80%, functions 80% |

- Tests use `FakeGateway` and fictional numbers from `test/helpers/fixtures.ts`. **Never put real phone numbers or names in tests.**
- Use `setup()` for stores, `createTestServices()` for services, and `createHarness()` for MCP tools.

### Live testing

Automated tests never touch WhatsApp. To check a change against a real account:

1. Run `npm run build && npm start`, then scan the QR from the printed login link.
2. Drive the server with an MCP client, for example `npx @modelcontextprotocol/inspector`, or a short script using the SDK client.
3. **Only message your own chat** (`whatsapp_status` → `me.id`) unless the account owner explicitly names someone else.

## Pull request checklist

- [ ] `npm run check` passes
- [ ] New code has `@module` / JSDoc comments; layer rules respected
- [ ] Tests added (service unit test + MCP integration test for tools)
- [ ] No phone numbers, JIDs or secrets in outputs, errors, logs or test data
- [ ] Docs updated (README, docs/TOOLS.md, `.env.example` as needed)
