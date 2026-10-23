/**
 * Test environments: an in-memory encrypted database with all stores, plus helpers that
 * build the services and a connected MCP client exactly like `app.ts` does, but with a
 * {@link FakeGateway}.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import pino from 'pino';
import { Cipher } from '../../src/core/crypto/cipher.js';
import { Database } from '../../src/core/db/database.js';
import { EventBus } from '../../src/events.js';
import { Presenter } from '../../src/mcp/presenters.js';
import { createMcpServer, type SessionServer } from '../../src/mcp/server.js';
import { resolveToolsets } from '../../src/mcp/toolsets/index.js';
import { PrivacyGuard } from '../../src/privacy/guard.js';
import { createServices, type ServiceDeps, type Services } from '../../src/services/index.js';
import { MediaCache } from '../../src/store/media-cache.js';
import { MessageStore } from '../../src/store/messages.js';
import { migrate } from '../../src/store/migrations.js';
import { PeerStore } from '../../src/store/peers.js';
import { ReactionStore } from '../../src/store/reactions.js';
import { Ingestor } from '../../src/whatsapp/ingest.js';
import { FakeGateway } from './fakes.js';
import { ME, ME_LID } from './fixtures.js';

export const silentLogger = pino({ level: 'silent' });

/** Stores, ingest and privacy guard on a fresh in-memory database. */
export function setup(masterKey = randomBytes(32)) {
    const db = new Database(':memory:');
    migrate(db);
    const cipher = new Cipher(masterKey);
    const peers = new PeerStore(db, cipher);
    const messages = new MessageStore(db, cipher);
    const reactions = new ReactionStore(db, cipher);
    const bus = new EventBus();
    const ingest = new Ingestor(db, peers, messages, reactions, bus, silentLogger);
    ingest.setSelf(ME, ME_LID);
    const guard = new PrivacyGuard(() => {
        const phones = peers.knownPhones();
        phones.add('919000000001');
        return phones;
    });
    const dataDir = mkdtempSync(path.join(tmpdir(), 'wa-mcp-test-'));
    const media = new MediaCache(dataDir, cipher);
    const sendDir = path.join(dataDir, 'send');
    return { db, cipher, peers, messages, reactions, bus, ingest, guard, masterKey, dataDir, media, sendDir };
}

export type TestEnv = ReturnType<typeof setup>;

/** Fast, permissive defaults; override per test. */
export const testSettings = (env: TestEnv): ServiceDeps['settings'] => ({
    HUMANIZE_REPLIES: false,
    TYPING_MS_PER_CHAR: 0,
    TYPING_MIN_MS: 0,
    TYPING_MAX_MS: 0,
    SEND_MIN_INTERVAL_MS: 0,
    SEND_MAX_PER_HOUR: 1000,
    NEW_CHAT_MAX_PER_DAY: 3,
    ALLOW_SEND_TO_PHONE: true,
    MEDIA_MAX_BYTES: 1024 * 1024,
    MEDIA_SEND_DIR: env.sendDir,
});

export function createTestServices(env: TestEnv, gw: FakeGateway, settings: Partial<ServiceDeps['settings']> = {}): Services {
    return createServices({
        wa: gw,
        recorder: env.ingest,
        peers: env.peers,
        messages: env.messages,
        mediaCache: env.media,
        bus: env.bus,
        guard: env.guard,
        settings: { ...testSettings(env), ...settings },
        sleep: async () => undefined,
    });
}

/** Factory for per-session MCP servers (same as app.ts), for in-memory or HTTP tests. */
export function mcpServerFactory(env: TestEnv, services: Services, toolsets: string[] = ['all']): () => SessionServer {
    const present = new Presenter(env.peers, env.messages, env.reactions);
    return () =>
        createMcpServer({
            guard: env.guard,
            logger: silentLogger,
            loginHint: 'LOGIN REQUIRED',
            services,
            present,
            toolsets: resolveToolsets(toolsets),
        });
}

/** A connected MCP client (in-memory transport) over the given services. */
export async function connectClient(env: TestEnv, services: Services, toolsets?: string[]) {
    const { server } = mcpServerFactory(env, services, toolsets)();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
    return client;
}

type Block = { type: string; text: string; data?: string; mimeType?: string; resource?: { uri: string; mimeType: string; blob: string } };

/** Calls a tool and parses its JSON result (or returns the error text). */
export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Block[] };
    const text = result.content[0].text;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests inspect arbitrary JSON
    const data: any = result.isError ? undefined : JSON.parse(text);
    return { isError: Boolean(result.isError), text, data, blocks: result.content };
}
