/**
 * Boots the real application (`createApp`) with a fake WhatsApp gateway: real database,
 * encryption, services, MCP over HTTP and the login page. Proves the wiring in app.ts.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, type App } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { generateEncryptionKey } from '../../src/core/crypto/keys.js';
import { FakeGateway, silentLogger } from '../helpers/index.js';

const API_KEY = 'app-test-key-0123456789';

describe('createApp (fake WhatsApp)', () => {
    let app: App;
    let url: string;
    const gateway = new FakeGateway();
    const dataDir = mkdtempSync(path.join(tmpdir(), 'wa-app-'));
    const encryptionKey = generateEncryptionKey();

    before(async () => {
        const config = loadConfig({ API_KEY, ENCRYPTION_KEY: encryptionKey, DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1' });
        app = createApp({ config, logger: silentLogger, createGateway: () => gateway, onLoginLink: () => undefined });
        ({ url } = await app.start());
    });

    after(async () => {
        await app.stop();
    });

    it('starts the gateway and serves health + the login page', async () => {
        assert.equal(gateway.started, true);
        assert.equal((await fetch(`${url}/healthz`)).status, 200);
        assert.equal((await fetch(`${url}/readyz`)).status, 200);
        assert.match(await (await fetch(`${url}/`)).text(), /WhatsApp is logged in/);
    });

    it('serves MCP over HTTP only with the API key', async () => {
        assert.equal((await fetch(`${url}/mcp`, { method: 'POST', body: '{}' })).status, 401);

        const client = new Client({ name: 'app-test', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } } }),
        );
        const tools = (await client.listTools()).tools.map((t) => t.name);
        assert.equal(tools.length, 11);
        const status = (await client.callTool({ name: 'whatsapp_status', arguments: {} })) as { content: Array<{ text: string }> };
        assert.equal(JSON.parse(status.content[0].text).connected, true);
        await client.close();
    });

    it('refuses to open the database with a different encryption key', async () => {
        const wrong = loadConfig({ API_KEY, ENCRYPTION_KEY: generateEncryptionKey(), DATA_DIR: dataDir, PORT: '0' });
        assert.throws(() => createApp({ config: wrong, logger: silentLogger, createGateway: () => new FakeGateway() }), /does not match/);
    });
});
