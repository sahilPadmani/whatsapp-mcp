import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RateLimitError } from '../../../src/core/errors.js';
import { createSendLimiter } from '../../../src/services/limits.js';
import { Sender, typingDelayMs } from '../../../src/services/sender.js';
import { ALICE, FakeGateway, setup, waMessage } from '../../helpers/index.js';

const typing = { HUMANIZE_REPLIES: true, TYPING_MS_PER_CHAR: 40, TYPING_MIN_MS: 1000, TYPING_MAX_MS: 8000 };

describe('typingDelayMs', () => {
    it('scales with length and is clamped', () => {
        assert.equal(typingDelayMs('hi', typing), 1000);
        assert.equal(typingDelayMs('x'.repeat(50), typing), 2000);
        assert.equal(typingDelayMs('x'.repeat(1000), typing), 8000);
        assert.equal(typingDelayMs('x'.repeat(50), { ...typing, HUMANIZE_REPLIES: false }), 0);
    });
});

describe('Sender', () => {
    it('shows typing, waits, sends with the quote and stores the sent message', async () => {
        const { peers, messages, ingest } = setup();
        const gw = new FakeGateway();
        const sleeps: number[] = [];
        const sender = new Sender(gw, ingest, createSendLimiter({ minIntervalMs: 0, maxPerHour: 100 }), typing, async (ms) => {
            sleeps.push(ms);
        });
        const alice = peers.ensure(ALICE);
        const quoted = waMessage({ chat: ALICE, id: 'Q1', text: 'question?' });

        const stored = await sender.send(alice, 'answer', quoted);

        assert.deepEqual(gw.typing, [
            { jid: ALICE, typing: true },
            { jid: ALICE, typing: false },
        ]);
        assert.deepEqual(sleeps, [1000]);
        assert.equal(gw.sent[0].quoted, quoted);
        assert.equal(stored.fromMe, true);
        assert.equal(stored.incoming, false, 'our own sends are never "incoming"');
        assert.equal(stored.peerUuid, alice.uuid);
        assert.equal(messages.byUuid(stored.uuid)?.text, 'answer');
    });

    it('refuses to send past the rate limit', async () => {
        const { peers, ingest } = setup();
        const limiter = createSendLimiter({ minIntervalMs: 60_000, maxPerHour: 100 });
        const sender = new Sender(new FakeGateway(), ingest, limiter, { ...typing, HUMANIZE_REPLIES: false });
        const alice = peers.ensure(ALICE);
        await sender.send(alice, 'one');
        await assert.rejects(sender.send(alice, 'two'), RateLimitError);
    });

    it('reactions are rate limited too but show no typing', async () => {
        const { peers, ingest } = setup();
        const gw = new FakeGateway();
        const sender = new Sender(gw, ingest, createSendLimiter({ minIntervalMs: 0, maxPerHour: 1 }), typing, async () => undefined);
        const alice = peers.ensure(ALICE);
        await sender.react(alice, { remoteJid: ALICE, id: 'X' }, '👍');
        assert.equal(gw.typing.length, 0);
        await assert.rejects(sender.react(alice, { remoteJid: ALICE, id: 'X' }, '❤️'), /Hourly send limit/);
    });
});
