/**
 * @module mcp/sessions
 *
 * Stateful Streamable HTTP sessions. Each client that sends `initialize` gets its own
 * MCP server instance and a session id (header `mcp-session-id`). Keeping sessions open
 * is what allows the server to *push* notifications for new messages and reactions.
 * Idle sessions are closed after MCP_SESSION_IDLE_MS.
 */
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import type { IncomingMessageEvent, ReactionEvent } from '../events.js';
import type { Logger } from '../logger.js';
import type { PrivacyGuard } from '../privacy/guard.js';
import { INBOX_URI, type SessionServer } from './server.js';

interface Session {
    transport: StreamableHTTPServerTransport;
    mcp: SessionServer;
    lastSeen: number;
}

const rpcError = (res: Response, status: number, message: string) =>
    res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

/**
 * Stateful Streamable HTTP sessions. Each client gets its own MCP server and
 * session id; long-lived sessions let the server push new-message notifications.
 */
export class McpSessionManager {
    private readonly sessions = new Map<string, Session>();
    private sweeper?: NodeJS.Timeout;

    constructor(
        private readonly factory: () => SessionServer,
        private readonly guard: PrivacyGuard,
        private readonly logger: Logger,
        private readonly idleMs: number,
    ) {}

    get size() {
        return this.sessions.size;
    }

    start() {
        this.sweeper = setInterval(() => void this.sweep(), Math.min(60_000, this.idleMs));
        this.sweeper.unref();
    }

    async stop() {
        clearInterval(this.sweeper);
        await Promise.all([...this.sessions.values()].map((s) => s.transport.close().catch(() => undefined)));
        this.sessions.clear();
    }

    private session(req: Request): Session | undefined {
        const id = req.header('mcp-session-id');
        const session = id ? this.sessions.get(id) : undefined;
        if (session) session.lastSeen = Date.now();
        return session;
    }

    async handlePost(req: Request, res: Response) {
        const existing = this.session(req);
        if (existing) return existing.transport.handleRequest(req, res, req.body);
        if (req.header('mcp-session-id')) return rpcError(res, 404, 'Session not found; re-initialize.');
        if (!isInitializeRequest(req.body)) return rpcError(res, 400, 'Missing session; send an initialize request first.');

        const mcp = this.factory();
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: (id) => {
                this.sessions.set(id, { transport, mcp, lastSeen: Date.now() });
                this.logger.info({ sessions: this.sessions.size }, 'MCP session opened');
            },
        });
        transport.onclose = () => {
            if (transport.sessionId && this.sessions.delete(transport.sessionId)) {
                this.logger.info({ sessions: this.sessions.size }, 'MCP session closed');
            }
        };
        await mcp.server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    }

    /** GET opens the server→client SSE stream (notifications); DELETE ends the session. */
    async handleStream(req: Request, res: Response) {
        const session = this.session(req);
        if (!session) return rpcError(res, req.header('mcp-session-id') ? 404 : 400, 'Unknown or missing session.');
        await session.transport.handleRequest(req, res);
    }

    /** Pushes a new-message notification to every session (agent-safe, guarded). */
    async broadcast(event: IncomingMessageEvent) {
        const { value } = this.guard.sanitize(
            {
                event: 'message.received',
                messageId: event.messageId,
                chatId: event.chatId,
                chatName: event.chatName,
                senderId: event.senderId,
                senderName: event.senderName,
                isGroup: event.isGroup,
                time: event.time,
                cursor: event.seq,
                preview: event.text.slice(0, 200),
            },
            'notification',
        );
        await this.notifyAll(value, true);
    }

    /** Pushes a reaction notification to every session. */
    async broadcastReaction(event: ReactionEvent) {
        const { value } = this.guard.sanitize({ event: 'reaction.received', ...event }, 'notification');
        await this.notifyAll(value, false);
    }

    private async notifyAll(data: unknown, inboxChanged: boolean) {
        await Promise.all(
            [...this.sessions.values()].map(async ({ mcp }) => {
                try {
                    await mcp.server.server.sendLoggingMessage({ level: 'info', logger: 'whatsapp.inbox', data });
                    if (inboxChanged && mcp.isSubscribed(INBOX_URI)) await mcp.server.server.sendResourceUpdated({ uri: INBOX_URI });
                } catch (err) {
                    this.logger.debug({ err }, 'could not notify MCP session');
                }
            }),
        );
    }

    async sweep(now = Date.now()) {
        for (const [id, session] of this.sessions) {
            if (now - session.lastSeen > this.idleMs) {
                this.sessions.delete(id);
                await session.transport.close().catch(() => undefined);
                this.logger.info({ sessions: this.sessions.size }, 'MCP session expired');
            }
        }
    }
}
