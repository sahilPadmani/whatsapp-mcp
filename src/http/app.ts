/**
 * @module http/app
 *
 * The Express application:
 *  - `POST|GET|DELETE /mcp`: MCP over Streamable HTTP (Bearer API key required);
 *  - `/login/<token>` + `/login/<token>/events`: the one-time QR login page and its live updates;
 *  - `/healthz`, `/readyz`: liveness / WhatsApp-connected checks;
 *  - every other page: one sentence ("WhatsApp is logged in." or "Open the login link…").
 *
 * There is deliberately no dashboard: nothing on the web exposes status, numbers or keys.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostHeaderValidation, localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Config } from '../config.js';
import type { EventBus } from '../events.js';
import type { Logger } from '../logger.js';
import type { McpSessionManager } from '../mcp/sessions.js';
import type { WhatsAppClient } from '../whatsapp/client.js';
import { bearerAuth } from './auth.js';
import type { LoginLink } from './login-link.js';

export const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

interface AppDeps {
    config: Config;
    wa: Pick<WhatsAppClient, 'state' | 'qrDataUrl' | 'connected'>;
    bus: EventBus;
    sessions: McpSessionManager;
    loginLink: LoginLink;
    logger: Logger;
}

const LOGGED_IN = 'WhatsApp is logged in.';
const NOT_LOGGED_IN = 'Open the login link printed in the server terminal.';
const INVALID_LINK = 'This login link is not valid.';

/** A page with one short sentence and nothing else. */
const simplePage = (text: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WhatsApp MCP</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
       font: 17px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; background: #f4f5f3; color: #1b1f1d; }
@media (prefers-color-scheme: dark) { body { background: #101413; color: #e8ece9; } }
</style>
</head>
<body><p>${text}</p></body>
</html>`;

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    );
    next();
}

export function createHttpApp({ config, wa, bus, sessions, loginLink, logger }: AppDeps) {
    const app = express();
    app.disable('x-powered-by');
    // DNS-rebinding protection (same as the SDK's createMcpExpressApp) for local binds.
    if (['127.0.0.1', 'localhost', '::1'].includes(config.HOST)) app.use(localhostHostValidation());
    else if (config.PUBLIC_URL) app.use(hostHeaderValidation([new URL(config.PUBLIC_URL).hostname]));
    // base64 media uploads: allow the media limit plus encoding overhead.
    app.use(express.json({ limit: Math.ceil(config.MEDIA_MAX_BYTES * 1.4) + 1024 * 1024 }));
    app.use(securityHeaders);

    // ---- Health ----
    app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
    app.get('/readyz', (_req, res) => res.status(wa.connected ? 200 : 503).json({ whatsapp: wa.state }));

    // ---- MCP (stateful Streamable HTTP) ----
    const requireKey = bearerAuth(config.API_KEY);
    const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
        try {
            await fn(req, res);
        } catch (err) {
            logger.error({ err }, 'MCP request failed');
            if (!res.headersSent)
                res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
        }
    };
    app.post(
        '/mcp',
        requireKey,
        wrap((req, res) => sessions.handlePost(req, res)),
    );
    app.get(
        '/mcp',
        requireKey,
        wrap((req, res) => sessions.handleStream(req, res)),
    );
    app.delete(
        '/mcp',
        requireKey,
        wrap((req, res) => sessions.handleStream(req, res)),
    );

    // ---- WhatsApp login (one-time link, no API key in URLs) ----
    const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

    app.get('/login/:token', (req, res) => {
        noStore(res);
        if (wa.connected) return res.type('html').send(simplePage(LOGGED_IN));
        if (!loginLink.isValid(req.params.token)) return res.status(404).type('html').send(simplePage(INVALID_LINK));
        res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
    });

    /** Live QR updates for the login page; ends once WhatsApp is logged in. */
    app.get('/login/:token/events', (req, res) => {
        noStore(res);
        if (!wa.connected && !loginLink.isValid(req.params.token)) return res.status(404).end();
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        const send = () => {
            res.write(`data: ${JSON.stringify(wa.connected ? { state: 'open' } : { state: wa.state, qr: wa.qrDataUrl })}\n\n`);
            if (wa.connected) res.end();
        };
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        bus.on('connection.state', send);
        req.on('close', () => {
            clearInterval(ping);
            bus.off('connection.state', send);
        });
        send();
    });

    // Every other page: one short sentence, nothing else.
    app.use((req, res) => {
        noStore(res);
        if (req.method !== 'GET') return res.status(404).end();
        res.type('html').send(simplePage(wa.connected ? LOGGED_IN : NOT_LOGGED_IN));
    });

    return app;
}
