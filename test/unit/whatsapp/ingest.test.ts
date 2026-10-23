import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IncomingMessageEvent } from '../../../src/events.js';
import { ALICE, ALICE_LID, GROUP, ME, setup, waMessage } from '../../helpers/index.js';

describe('Ingestor', () => {
    it('stores live incoming messages, bumps unread and publishes an agent-safe event', () => {
        const { ingest, bus, peers, guard } = setup();
        peers.update(ALICE, { name: 'Alice' });
        const events: IncomingMessageEvent[] = [];
        bus.on('message.received', (e) => events.push(e));

        ingest.saveMessages([waMessage({ chat: ALICE, text: 'hello', pushName: 'Ali' })], true);

        assert.equal(events.length, 1);
        const alice = peers.byJid(ALICE)!;
        assert.equal(events[0].chatId, alice.uuid);
        assert.equal(events[0].chatName, 'Alice');
        assert.equal(events[0].text, 'hello');
        assert.equal(alice.unread, 1);
        assert.equal(alice.notify, 'Ali');
        assert.equal(guard.sanitize(events[0]).redactions.length, 0);
    });

    it('does not publish history or own messages', () => {
        const { ingest, bus } = setup();
        let count = 0;
        bus.on('message.received', () => count++);
        ingest.saveMessages([waMessage({ chat: ALICE, text: 'old' })], false);
        ingest.saveMessages([waMessage({ chat: ALICE, text: 'mine', fromMe: true })], true);
        assert.equal(count, 0);
    });

    it('attributes group messages to the participant and own messages to self', () => {
        const { ingest, peers, messages } = setup();
        const [incoming, mine] = ingest.saveMessages(
            [waMessage({ chat: GROUP, text: 'hi all', participant: ALICE }), waMessage({ chat: GROUP, text: 'hey', fromMe: true })],
            false,
        );
        assert.equal(incoming.senderUuid, peers.byJid(ALICE)?.uuid);
        assert.equal(mine.senderUuid, peers.byJid(ME)?.uuid);
        assert.equal(messages.forPeer(peers.byJid(GROUP)!.uuid, 10).length, 2);
    });

    it('learns LID → phone mappings from message keys', () => {
        const { ingest, peers } = setup();
        ingest.saveMessages([waMessage({ chat: ALICE_LID, text: 'hi', remoteJidAlt: ALICE })], false);
        assert.equal(peers.byJid(ALICE_LID)?.uuid, peers.byJid(ALICE)?.uuid);
        assert.equal(peers.byJid(ALICE)?.phone, '919876543210');
    });

    it('treats notes you send to your own chat from your phone as incoming, but not messages this server sent', () => {
        const { ingest, bus, messages } = setup();
        const events: IncomingMessageEvent[] = [];
        bus.on('message.received', (e) => events.push(e));

        ingest.saveMessages([waMessage({ chat: ME, id: 'NOTE1', text: 'agent: reply to Alice', fromMe: true })], true);
        ingest.saveMessages([waMessage({ chat: '900000000000001@lid', id: 'NOTE2', text: 'via lid', fromMe: true })], true);
        ingest.markOutgoing('BOT1');
        ingest.saveMessages([waMessage({ chat: ME, id: 'BOT1', text: 'bot reply', fromMe: true })], true);
        ingest.saveMessages([waMessage({ chat: ALICE, id: 'OUT1', text: 'sent to Alice from phone', fromMe: true })], true);

        assert.deepEqual(
            events.map((e) => e.text),
            ['agent: reply to Alice', 'via lid'],
        );
        assert.deepEqual(
            messages.incomingSince(0, 10).map((m) => m.text),
            ['agent: reply to Alice', 'via lid'],
        );
    });

    it('ignores status broadcasts and protocol messages', () => {
        const { ingest, messages } = setup();
        ingest.saveMessages([waMessage({ chat: 'status@broadcast', text: 'story' })], true);
        const protocol = waMessage({ chat: ALICE, text: '' });
        protocol.message = { protocolMessage: { type: 0 } };
        ingest.saveMessages([protocol], true);
        assert.equal(messages.count(), 0);
    });
});
