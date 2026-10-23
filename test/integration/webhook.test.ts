import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { signWebhook, WebhookDispatcher } from '../../src/integrations/webhook.js';
import { Outbox } from '../../src/store/outbox.js';
import { setup, silentLogger } from '../helpers/index.js';

const SECRET = 'test-secret-0123456789';

async function receiver(statuses: number[]) {
    const calls: Array<{ headers: IncomingMessage['headers']; body: string }> = [];
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            calls.push({ headers: req.headers, body });
            res.writeHead(statuses.shift() ?? 200).end();
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, calls, close: () => server.close() };
}

describe('WebhookDispatcher', () => {
    it('delivers a signed, privacy-guarded event and retries after failure', async () => {
        const { db, cipher, bus, guard } = setup();
        const outbox = new Outbox(db, cipher);
        const hook = await receiver([500, 200]);
        const dispatcher = new WebhookDispatcher(
            { url: hook.url, secret: SECRET, maxAttempts: 5, backoffMs: () => 0, pollIntervalMs: 20 },
            outbox,
            bus,
            guard,
            silentLogger,
        );
        dispatcher.start();
        bus.emit('message.received', {
            seq: 1,
            messageId: '0b7f3c2e-6a1d-4e58-9c3b-2f8e4d6a1b90',
            chatId: '5d2c8e14-3b7a-4f96-a0d1-7e9c4b2f6a35',
            chatName: '+91 98765 43210', // a leaked number must be caught
            isGroup: false,
            senderId: null,
            senderName: 'Alice',
            type: 'text',
            text: 'call 919876543210',
            ts: 1,
            time: '2026-10-23T08:22:47.000Z',
            replyToMessageId: null,
        });

        for (let i = 0; i < 100 && (hook.calls.length < 2 || outbox.size() > 0); i++) await delay(20);
        dispatcher.stop();
        hook.close();

        assert.equal(hook.calls.length, 2, 'first attempt failed, second succeeded');
        const { headers, body } = hook.calls[1];
        assert.equal(headers['x-webhook-signature'], signWebhook(SECRET, String(headers['x-webhook-timestamp']), body));
        assert.equal(headers['x-webhook-id'], hook.calls[0].headers['x-webhook-id'], 'same event id on retry');
        const payload = JSON.parse(body);
        assert.equal(payload.type, 'message.received');
        assert.equal(payload.data.chatName, 'Unknown contact');
        assert.equal(payload.data.text, 'call 919876543210', 'message content is not altered');
        assert.equal(outbox.size(), 0);
    });

    it('drops an event after the maximum attempts', async () => {
        const { db, cipher, bus, guard } = setup();
        const outbox = new Outbox(db, cipher);
        const hook = await receiver([500, 500, 500]);
        const dispatcher = new WebhookDispatcher(
            { url: hook.url, secret: SECRET, maxAttempts: 2, backoffMs: () => 0, pollIntervalMs: 20 },
            outbox,
            bus,
            guard,
            silentLogger,
        );
        dispatcher.enqueue('test', { ok: true });
        for (let i = 0; i < 50 && (hook.calls.length < 2 || outbox.size() > 0); i++) {
            await dispatcher.flush();
            await delay(10);
        }
        hook.close();
        assert.equal(hook.calls.length, 2);
        assert.equal(outbox.size(), 0);
    });

    it('delivers reaction events too', async () => {
        const { db, cipher, bus, guard } = setup();
        const outbox = new Outbox(db, cipher);
        const hook = await receiver([200]);
        const dispatcher = new WebhookDispatcher(
            { url: hook.url, secret: SECRET, maxAttempts: 3, backoffMs: () => 0, pollIntervalMs: 20 },
            outbox,
            bus,
            guard,
            silentLogger,
        );
        dispatcher.start();
        bus.emit('reaction.received', {
            messageId: '0b7f3c2e-6a1d-4e58-9c3b-2f8e4d6a1b90',
            chatId: '5d2c8e14-3b7a-4f96-a0d1-7e9c4b2f6a35',
            chatName: 'Alice',
            reactorId: '5d2c8e14-3b7a-4f96-a0d1-7e9c4b2f6a35',
            reactorName: 'Alice',
            emoji: '❤️',
            removed: false,
            time: '2026-10-23T08:22:47.000Z',
        });
        for (let i = 0; i < 100 && (hook.calls.length < 1 || outbox.size() > 0); i++) await delay(20);
        dispatcher.stop();
        hook.close();
        const payload = JSON.parse(hook.calls[0].body);
        assert.equal(payload.type, 'reaction.received');
        assert.equal(payload.data.emoji, '❤️');
    });

    it('stores queued payloads encrypted', () => {
        const { db, cipher } = setup();
        new Outbox(db, cipher).enqueue('e1', JSON.stringify({ text: 'secret words' }));
        assert.ok(!JSON.stringify(db.all('SELECT * FROM webhook_outbox')).includes('secret words'));
    });
});
