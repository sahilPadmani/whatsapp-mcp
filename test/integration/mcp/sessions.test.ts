import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { LoggingMessageNotificationSchema, ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from 'node:http';
import { INBOX_URI } from '../../../src/mcp/server.js';
import { McpSessionManager } from '../../../src/mcp/sessions.js';
import {
    ALICE,
    createTestServices,
    FakeGateway,
    findIdentifiers,
    mcpServerFactory,
    setup,
    silentLogger,
    waMessage,
} from '../../helpers/index.js';

describe('MCP HTTP sessions + notifications', () => {
    const env = setup();
    const gw = new FakeGateway();
    const sessions = new McpSessionManager(mcpServerFactory(env, createTestServices(env, gw)), env.guard, silentLogger, 60_000);
    env.bus.on('message.received', (e) => void sessions.broadcast(e));
    let server: Server;
    let url: URL;

    before(async () => {
        const app = createMcpExpressApp();
        app.post('/mcp', (req, res) => void sessions.handlePost(req, res));
        app.get('/mcp', (req, res) => void sessions.handleStream(req, res));
        app.delete('/mcp', (req, res) => void sessions.handleStream(req, res));
        server = app.listen(0, '127.0.0.1');
        await new Promise((r) => server.once('listening', r));
        url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    });

    after(async () => {
        await sessions.stop();
        server.close();
    });

    it('rejects requests without a session', async () => {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        assert.equal(res.status, 400);
    });

    it('pushes a guarded notification and an inbox update to a subscribed session', async () => {
        const client = new Client({ name: 'notify-test', version: '1.0.0' });
        const logs: Array<{ logger?: string; data: unknown }> = [];
        const updates: string[] = [];
        client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => void logs.push(n.params));
        client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => void updates.push(n.params.uri));
        await client.connect(new StreamableHTTPClientTransport(url));
        await client.subscribeResource({ uri: INBOX_URI });
        assert.equal(sessions.size, 1);
        await delay(200); // let the client open its GET SSE stream

        env.peers.update(ALICE, { name: 'Alice' });
        env.ingest.saveMessages([waMessage({ chat: ALICE, text: 'ping from 919876543210' })], true);

        for (let i = 0; i < 100 && (logs.length === 0 || updates.length === 0); i++) await delay(20);
        assert.equal(logs.length, 1);
        assert.equal(logs[0].logger, 'whatsapp.inbox');
        const data = logs[0].data as { chatName: string; chatId: string; preview: string };
        assert.equal(data.chatName, 'Alice');
        assert.equal(data.chatId, env.peers.byJid(ALICE)?.uuid);
        assert.equal(data.preview, 'ping from 919876543210');
        assert.deepEqual(findIdentifiers(data, ['919876543210']), []);
        assert.deepEqual(updates, [INBOX_URI]);

        const tools = await client.listTools();
        assert.equal(tools.tools.length, 11);
        await client.close();
    });

    it('expires idle sessions', async () => {
        const client = new Client({ name: 'idle-test', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(url));
        assert.ok(sessions.size >= 1);
        await sessions.sweep(Date.now() + 120_000);
        assert.equal(sessions.size, 0);
        await client.close().catch(() => undefined);
    });
});
