import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALICE, BOB, setup, waMessage } from '../../helpers/index.js';

describe('MessageStore', () => {
    it('stores text encrypted and returns it decrypted', () => {
        const { db, peers, messages } = setup();
        const alice = peers.ensure(ALICE);
        messages.insert({
            peerUuid: alice.uuid,
            waId: 'W1',
            senderUuid: alice.uuid,
            fromMe: false,
            ts: 1,
            type: 'text',
            text: 'call me at 9876543210',
        });
        assert.ok(!JSON.stringify(db.all('SELECT * FROM messages')).includes('call me'));
        assert.equal(messages.forPeer(alice.uuid, 5)[0].text, 'call me at 9876543210');
    });

    it('deduplicates by WhatsApp message id per chat', () => {
        const { peers, messages } = setup();
        const alice = peers.ensure(ALICE);
        const base = { peerUuid: alice.uuid, waId: 'W1', senderUuid: null, fromMe: false, ts: 1, type: 'text', text: 'x' };
        const first = messages.insert(base);
        const second = messages.insert(base);
        assert.equal(first.inserted, true);
        assert.equal(second.inserted, false);
        assert.equal(second.message.uuid, first.message.uuid);
        assert.equal(messages.count(), 1);
    });

    it('pages with a global cursor over incoming messages only', () => {
        const { peers, messages } = setup();
        const alice = peers.ensure(ALICE);
        const bob = peers.ensure(BOB);
        const add = (peer: string, waId: string, fromMe: boolean, ts: number) =>
            messages.insert({ peerUuid: peer, waId, senderUuid: null, fromMe, ts, type: 'text', text: waId }).message;
        const a1 = add(alice.uuid, 'a1', false, 1);
        add(alice.uuid, 'me1', true, 2);
        const b1 = add(bob.uuid, 'b1', false, 3);

        assert.deepEqual(
            messages.incomingSince(0, 10).map((m) => m.text),
            ['a1', 'b1'],
        );
        assert.deepEqual(
            messages.incomingSince(a1.seq, 10).map((m) => m.text),
            ['b1'],
        );
        assert.equal(messages.incomingSince(b1.seq, 10).length, 0);
        assert.equal(messages.latestSeq(), b1.seq);
    });

    it('keeps the raw message (encrypted) for quoting, and links replies', () => {
        const { peers, messages } = setup();
        const alice = peers.ensure(ALICE);
        const raw = waMessage({ chat: ALICE, id: 'ORIG', text: 'original' });
        const original = messages.insert({
            peerUuid: alice.uuid,
            waId: 'ORIG',
            senderUuid: alice.uuid,
            fromMe: false,
            ts: 1,
            type: 'text',
            text: 'original',
            raw,
        }).message;
        const decoded = messages.raw(original.uuid)!;
        assert.equal(decoded.key.id, 'ORIG');
        assert.equal(decoded.key.remoteJid, ALICE);
        assert.equal(decoded.message?.conversation, 'original');

        const reply = messages.insert({
            peerUuid: alice.uuid,
            waId: 'R1',
            senderUuid: null,
            fromMe: true,
            ts: 2,
            type: 'text',
            text: 'reply',
            replyToWaId: 'ORIG',
        }).message;
        assert.equal(reply.replyToUuid, original.uuid);
    });

    it('returns the newest N incoming messages oldest-first (unread)', () => {
        const { peers, messages } = setup();
        const alice = peers.ensure(ALICE);
        for (let i = 1; i <= 4; i++) {
            messages.insert({ peerUuid: alice.uuid, waId: `w${i}`, senderUuid: null, fromMe: false, ts: i, type: 'text', text: `m${i}` });
        }
        assert.deepEqual(
            messages.latestIncoming(alice.uuid, 2).map((m) => m.text),
            ['m3', 'm4'],
        );
    });
});
