/**
 * @module app
 *
 * The composition root: the only place where modules are created and connected.
 * Reading this file top to bottom shows the whole architecture:
 *
 *   config → database + encryption → stores → WhatsApp (gateway + ingest)
 *          → services → MCP (toolsets, sessions) + webhook + HTTP (login page, /mcp)
 *
 * `createApp` returns an object you can start and stop, which keeps `index.ts` tiny and
 * lets integration tests boot the real app with a fake WhatsApp gateway.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Config } from './config.js';
import { Cipher } from './core/crypto/cipher.js';
import { parseEncryptionKey, verifyKey } from './core/crypto/keys.js';
import { Database } from './core/db/database.js';
import { EventBus } from './events.js';
import { createHttpApp } from './http/app.js';
import { LoginLink } from './http/login-link.js';
import { WebhookDispatcher } from './integrations/webhook.js';
import { createLogger, type Logger } from './logger.js';
import { Presenter } from './mcp/presenters.js';
import { createMcpServer } from './mcp/server.js';
import { McpSessionManager } from './mcp/sessions.js';
import { resolveToolsets } from './mcp/toolsets/index.js';
import { PrivacyGuard } from './privacy/guard.js';
import { createServices, type Services } from './services/index.js';
import { EncryptedAuthStore } from './store/auth-state.js';
import { MediaCache } from './store/media-cache.js';
import { MessageStore } from './store/messages.js';
import { migrate } from './store/migrations.js';
import { Outbox } from './store/outbox.js';
import { PeerStore } from './store/peers.js';
import { ReactionStore } from './store/reactions.js';
import { WhatsAppClient, type WhatsAppClientOptions } from './whatsapp/client.js';
import type { WhatsAppGateway } from './whatsapp/gateway.js';
import { Ingestor } from './whatsapp/ingest.js';

/** Database file inside DATA_DIR. */
export const DB_FILE = 'whatsapp-mcp.db';

/** A gateway the app can start/stop and whose QR the login page can show. */
export interface ManagedGateway extends WhatsAppGateway {
    qrDataUrl: string | null;
    start(): Promise<void>;
    stop(): Promise<void>;
}

export interface AppOptions {
    config: Config;
    logger?: Logger;
    /** Replaces the real Baileys client (tests). */
    createGateway?: (deps: WhatsAppClientOptions) => ManagedGateway;
    /** Where to show the one-time login link (default: printed to the console, not the log). */
    onLoginLink?: (url: string) => void;
    /** Injectable delay for the typing indicator (tests pass a no-op). */
    sleep?: (ms: number) => Promise<void>;
}

export interface App {
    services: Services;
    bus: EventBus;
    gateway: ManagedGateway;
    loginLink: LoginLink;
    /** Starts HTTP, sessions, webhook and WhatsApp. Resolves with the listening URL. */
    start(): Promise<{ url: string }>;
    /** Stops everything and closes the database (the WhatsApp session stays saved). */
    stop(): Promise<void>;
}

export function createApp(options: AppOptions): App {
    const { config } = options;
    const logger = options.logger ?? createLogger(config.LOG_LEVEL);

    // ---- Storage + encryption ----
    const db = new Database(path.resolve(config.DATA_DIR, DB_FILE));
    migrate(db);
    const cipher = new Cipher(parseEncryptionKey(config.ENCRYPTION_KEY));
    verifyKey(db, cipher);

    const peers = new PeerStore(db, cipher);
    const messages = new MessageStore(db, cipher);
    const reactions = new ReactionStore(db, cipher);
    const outbox = new Outbox(db, cipher);
    const auth = new EncryptedAuthStore(db, cipher);
    const mediaCache = new MediaCache(path.resolve(config.DATA_DIR), cipher);
    const bus = new EventBus();

    // ---- WhatsApp ----
    // The guard needs every number the server knows (contacts + our own) to catch leaks.
    const guard = new PrivacyGuard(() => {
        const phones = peers.knownPhones();
        if (gateway.me?.phone) phones.add(gateway.me.phone);
        return phones;
    }, logger);

    const ingest = new Ingestor(db, peers, messages, reactions, bus, logger);
    const gatewayDeps: WhatsAppClientOptions = {
        auth,
        ingest,
        bus,
        logger,
        baileysLogLevel: config.BAILEYS_LOG_LEVEL,
        // Logged out (from the phone): forget everything about the account.
        onLoggedOut: () => {
            db.transaction(() => {
                auth.clear();
                messages.clear();
                reactions.clear();
                peers.clear();
                outbox.clear();
            });
            mediaCache.clear();
            db.exec('VACUUM');
            bus.emit('data.changed');
        },
    };
    const gateway: ManagedGateway = options.createGateway?.(gatewayDeps) ?? new WhatsAppClient(gatewayDeps);

    // ---- Services ----
    const services = createServices({
        wa: gateway,
        recorder: ingest,
        peers,
        messages,
        mediaCache,
        bus,
        guard,
        settings: config,
        sleep: options.sleep,
    });

    // ---- MCP ----
    const toolsets = resolveToolsets(config.TOOLSETS);
    const present = new Presenter(peers, messages, reactions);
    const loginHint =
        'WhatsApp is not logged in. Ask the user to open the login link printed in the server terminal and scan the QR code (WhatsApp → Settings → Linked devices).';
    const sessions = new McpSessionManager(
        () => createMcpServer({ guard, logger, loginHint, services, present, toolsets }),
        guard,
        logger,
        config.MCP_SESSION_IDLE_MS,
    );
    bus.on('message.received', (event) => void sessions.broadcast(event));
    bus.on('reaction.received', (event) => void sessions.broadcastReaction(event));

    // ---- Webhook (optional) ----
    const webhook =
        config.WEBHOOK_URL && config.WEBHOOK_SECRET
            ? new WebhookDispatcher(
                  { url: config.WEBHOOK_URL, secret: config.WEBHOOK_SECRET, maxAttempts: config.WEBHOOK_MAX_ATTEMPTS },
                  outbox,
                  bus,
                  guard,
                  logger,
              )
            : undefined;

    // ---- Login link + HTTP ----
    // One-time QR login link: issued whenever WhatsApp needs a QR, revoked once logged in.
    // Printed rather than logged, so it never ends up in log pipelines.
    const loginLink = new LoginLink(config.publicUrl, options.onLoginLink ?? ((url) => console.log(`\n  WhatsApp login: ${url}\n`)));
    bus.on('connection.state', (state) => {
        if (state === 'open') loginLink.revoke();
        else if (state === 'qr' && !loginLink.active) loginLink.issue();
    });
    const http = createHttpApp({ config, wa: gateway, bus, sessions, loginLink, logger });
    let server: Server | undefined;

    return {
        services,
        bus,
        gateway,
        loginLink,

        async start() {
            server = http.listen(config.PORT, config.HOST);
            await new Promise<void>((resolve, reject) => {
                server!.once('listening', resolve);
                server!.once('error', reject);
            });
            const { port } = server.address() as AddressInfo;
            const url = config.PORT === 0 ? `http://${config.HOST}:${port}` : config.publicUrl;
            logger.info({ url, mcp: `${url}/mcp`, webhook: Boolean(webhook), toolsets: toolsets.map((t) => t.name) }, 'server listening');

            sessions.start();
            webhook?.start();
            await gateway.start();
            return { url };
        },

        async stop() {
            webhook?.stop();
            await sessions.stop();
            await gateway.stop();
            await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
            db.close();
        },
    };
}
