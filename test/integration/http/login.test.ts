import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../../../src/config.js';
import { EventBus, type ConnectionState } from '../../../src/events.js';
import { createHttpApp } from '../../../src/http/app.js';
import { LoginLink } from '../../../src/http/login-link.js';
import { McpSessionManager } from '../../../src/mcp/sessions.js';
import { PrivacyGuard } from '../../../src/privacy/guard.js';
import { silentLogger } from '../../helpers/index.js';

const API_KEY = 'test-api-key-0123456789abcdef';

describe('HTTP: one-time login link', () => {
    const bus = new EventBus();
    const wa = { state: 'qr' as ConnectionState, qrDataUrl: 'data:image/png;base64,QRDATA', connected: false };
    const printed: string[] = [];
    let base: string;
    const loginLink = new LoginLink('http://127.0.0.1', (url) => printed.push(url));
    const sessions = new McpSessionManager(
        () => {
            throw new Error('not used');
        },
        new PrivacyGuard(() => new Set()),
        silentLogger,
        60_000,
    );
    let server: Server;

    const get = async (path: string) => {
        const res = await fetch(`${base}${path}`);
        return { status: res.status, body: await res.text(), headers: res.headers };
    };
    const setState = (state: ConnectionState) => {
        wa.state = state;
        wa.connected = state === 'open';
        bus.emit('connection.state', state);
    };

    before(async () => {
        const config = loadConfig({ API_KEY, ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), HOST: '127.0.0.1' });
        server = createHttpApp({ config, wa, bus, sessions, loginLink, logger: silentLogger }).listen(0, '127.0.0.1');
        await new Promise((r) => server.once('listening', r));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => server.close());

    it('shows only a short sentence on other pages while logged out', async () => {
        const home = await get('/');
        assert.match(home.body, /<p>Open the login link printed in the server terminal\.<\/p>/);
        assert.ok(!home.body.includes('QRDATA'));
        assert.match((await get('/api/status')).body, /Open the login link/, 'old dashboard API is gone');
    });

    it('serves the QR page only with the valid token, and never uses the API key', async () => {
        const url = loginLink.issue();
        assert.equal(printed.at(-1), url);
        const token = url.split('/login/')[1];
        assert.notEqual(token, API_KEY);
        assert.ok(token.length >= 32);

        const page = await get(`/login/${token}`);
        assert.equal(page.status, 200);
        assert.match(page.body, /Linked devices/);
        assert.equal(page.headers.get('cache-control'), 'no-store');

        const wrong = await get('/login/not-the-token');
        assert.equal(wrong.status, 404);
        assert.match(wrong.body, /<p>This login link is not valid\.<\/p>/);
        assert.equal((await get(`/?key=${API_KEY}`)).body.includes('QRDATA'), false, '?key= no longer opens anything');
    });

    it('streams the QR, then "open" and closes when login succeeds; the link then only says logged in', async () => {
        const url = loginLink.active ? null : loginLink.issue();
        const token = (url ?? printed.at(-1)!).split('/login/')[1];
        const res = await fetch(`${base}/login/${token}/events`);
        const reader = res.body!.getReader();
        const read = async () => new TextDecoder().decode((await reader.read()).value);
        assert.match(await read(), /"qr":"data:image\/png;base64,QRDATA"/);

        loginLink.revoke();
        setState('open');
        assert.match(await read(), /"state":"open"/);
        assert.equal((await reader.read()).done, true, 'stream ends after login');

        for (const path of [`/login/${token}`, '/login/anything', '/', '/whatever']) {
            const page = await get(path);
            assert.match(page.body, /<body><p>WhatsApp is logged in\.<\/p><\/body>/, path);
            assert.ok(!page.body.includes('QRDATA') && !page.body.includes(API_KEY), path);
        }
    });

    it('keeps /mcp protected by the API key and health endpoints working', async () => {
        const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(res.status, 401);
        assert.equal((await get('/healthz')).status, 200);
    });
});

describe('LoginLink', () => {
    it('issues a new random token each time and revokes it', () => {
        const link = new LoginLink('http://x', () => undefined);
        const a = link.issue().split('/login/')[1];
        const b = link.issue().split('/login/')[1];
        assert.notEqual(a, b);
        assert.equal(link.isValid(a), false, 'old token replaced');
        assert.equal(link.isValid(b), true);
        link.revoke();
        assert.equal(link.isValid(b), false);
        assert.equal(link.active, false);
    });
});
