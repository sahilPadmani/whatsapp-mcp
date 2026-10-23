/**
 * Unit tests for the services layer (no MCP involved): the business rules that used to
 * live inside tool handlers.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotConnectedError, RateLimitError, UserError } from '../../../src/core/errors.js';
import { isSingleEmoji } from '../../../src/services/messaging.service.js';
import { ALICE, BOB, createTestServices, FakeGateway, GROUP, ME, setup, waMessage } from '../../helpers/index.js';

function seeded(settings = {}) {
    const env = setup();
    const gw = new FakeGateway();
    const services = createTestServices(env, gw, settings);
    env.peers.update(ALICE, { name: 'Alice' });
    env.peers.update(BOB, { name: 'Bob' });
    env.peers.update(GROUP, { name: 'Team' });
    env.ingest.saveMessages(
        [waMessage({ chat: ALICE, id: 'A1', text: 'hi', ts: 100 }), waMessage({ chat: BOB, id: 'B1', text: 'yo', ts: 200 })],
        true,
    );
    return { ...env, gw, services };
}

describe('ChatResolver', () => {
    it('resolves UUIDs, exact names and unique partial names', () => {
        const { services, peers } = seeded();
        const alice = peers.byJid(ALICE)!;
        assert.equal(services.resolver.resolve(alice.uuid).uuid, alice.uuid);
        assert.equal(services.resolver.resolve('ALICE').uuid, alice.uuid);
        assert.equal(services.resolver.resolve('tea').uuid, peers.byJid(GROUP)!.uuid);
    });

    it('rejects numbers and JIDs, unknown ids and unknown names', () => {
        const { services } = seeded();
        assert.throws(() => services.resolver.resolve('+91 98765 43210'), /not accepted/);
        assert.throws(() => services.resolver.resolve(ALICE), /not accepted/);
        assert.throws(() => services.resolver.resolve('00000000-0000-4000-8000-000000000000'), /Unknown chat id/);
        assert.throws(
            () => services.resolver.resolve('Zed'),
            (e: Error) => e instanceof UserError && /No contact/.test(e.message),
        );
    });

    it('send targets: phone numbers are looked up on WhatsApp; new chats are flagged', async () => {
        const { services, gw } = seeded();
        const existing = await services.resolver.resolveSendTarget('+91 98765 43210');
        assert.equal(existing.peer.jid, ALICE);
        assert.equal(existing.newChat, false);
        const stranger = await services.resolver.resolveSendTarget('+44 7700 900456');
        assert.equal(stranger.newChat, true);
        assert.deepEqual(gw.lookups, ['919876543210', '447700900456']);
        await assert.rejects(services.resolver.resolveSendTarget('+91 99999 00000'), /not on WhatsApp/);
    });
});

describe('ChatsService', () => {
    it('lists and searches by name; refuses reads before any login', () => {
        const { services } = seeded();
        assert.deepEqual(
            services.chats.list({ limit: 10 }).map((p) => p.name),
            ['Bob', 'Alice'],
        );
        assert.deepEqual(
            services.chats.search('ali', 5).map((p) => p.name),
            ['Alice'],
        );

        const empty = setup();
        const gw = new FakeGateway();
        gw.state = 'qr';
        assert.throws(() => createTestServices(empty, gw).chats.list({ limit: 1 }), NotConnectedError);
    });
});

describe('InboxService', () => {
    it('returns unread without a cursor, then only newer messages with one', async () => {
        const { services, ingest } = seeded();
        const first = await services.inbox.newMessages({ waitSeconds: 0, limit: 10 });
        assert.deepEqual(
            first.messages.map((m) => m.text),
            ['hi', 'yo'],
        );
        ingest.saveMessages([waMessage({ chat: ALICE, id: 'A2', text: 'again' })], true);
        const next = await services.inbox.newMessages({ cursor: first.nextCursor, waitSeconds: 0, limit: 10 });
        assert.deepEqual(
            next.messages.map((m) => m.text),
            ['again'],
        );
    });

    it('a long-poll ends early when the request is cancelled', async () => {
        const { services } = seeded();
        const controller = new AbortController();
        const started = Date.now();
        setTimeout(() => controller.abort(), 30);
        const res = await services.inbox.newMessages({ cursor: 999, waitSeconds: 10, limit: 5, signal: controller.signal });
        assert.equal(res.messages.length, 0);
        assert.ok(Date.now() - started < 2000);
    });

    it('notes you type into your own chat count as incoming', async () => {
        const { services, ingest } = seeded();
        const { nextCursor } = await services.inbox.newMessages({ waitSeconds: 0, limit: 10 });
        ingest.saveMessages([waMessage({ chat: ME, id: 'N1', text: 'agent, summarise', fromMe: true })], true);
        const res = await services.inbox.newMessages({ cursor: nextCursor, waitSeconds: 0, limit: 10 });
        assert.deepEqual(
            res.messages.map((m) => m.text),
            ['agent, summarise'],
        );
    });
});

describe('MessagingService', () => {
    it('sends, records new chats, and enforces the new-chat limit', async () => {
        const { services, gw } = seeded({ NEW_CHAT_MAX_PER_DAY: 1 });
        gw.registered.add('447700900001').add('447700900002');
        const a = await services.messaging.sendText({ to: '+447700900001', text: 'hello' });
        assert.equal(a.newChat, true);
        assert.equal(services.messaging.newChatsStartedToday(), 1);
        await assert.rejects(services.messaging.sendText({ to: '+447700900002', text: 'hello' }), RateLimitError);
        // Existing conversations are never limited by the new-chat cap.
        assert.equal((await services.messaging.sendText({ to: 'Alice', text: 'hi' })).newChat, false);
    });

    it('requires a connection to send', async () => {
        const { services, gw } = seeded();
        gw.state = 'connecting';
        await assert.rejects(services.messaging.sendText({ to: 'Alice', text: 'x' }), NotConnectedError);
    });

    it('isSingleEmoji accepts one emoji incl. modifiers, flags and ZWJ sequences', () => {
        for (const ok of ['👍', '❤️', '👍🏽', '👨‍👩‍👧', '🇮🇳']) assert.ok(isSingleEmoji(ok), ok);
        for (const bad of ['', 'a', '👍👍', 'ok', '1']) assert.ok(!isSingleEmoji(bad), bad);
    });
});

describe('MediaService', () => {
    it('validates uploads and serves cached media without a connection', async () => {
        const { services, ingest, gw } = seeded();
        assert.throws(() => services.media.readUpload({}), /exactly one/);
        const upload = services.media.readUpload({ dataBase64: Buffer.from('a,b').toString('base64'), fileName: 'x.csv' });
        assert.equal(upload.mimeType, 'text/csv');

        const photo = waMessage({ chat: ALICE, id: 'P1', text: '' });
        photo.message = { imageMessage: { mimetype: 'image/jpeg' } };
        const [stored] = ingest.saveMessages([photo], false);
        gw.files.set('P1', Buffer.from('jpeg-bytes'));
        assert.equal((await services.media.fetch(stored.uuid)).data.toString(), 'jpeg-bytes');

        gw.state = 'qr'; // offline: served from the encrypted cache
        assert.equal((await services.media.fetch(stored.uuid)).data.toString(), 'jpeg-bytes');
        assert.equal(gw.downloads.length, 1);
    });
});

describe('StatusService', () => {
    it('reports your profile name and own chat id, never your number', () => {
        const { services, peers } = seeded();
        peers.ensure(ME);
        const status = services.status.snapshot();
        assert.equal(status.connected, true);
        assert.deepEqual(status.me, { name: 'Me', id: peers.byJid(ME)!.uuid });
        assert.ok(!JSON.stringify(status).includes('9000000001'));
    });
});
