import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PeerStore } from '../../../src/store/peers.js';
import { ALICE, ALICE_LID, BOB, GROUP, setup } from '../../helpers/index.js';

describe('PeerStore', () => {
    it('gives each JID a stable UUID that survives a reload', () => {
        const { db, cipher, peers } = setup();
        const alice = peers.ensure(ALICE);
        assert.equal(peers.ensure(ALICE).uuid, alice.uuid);
        assert.equal(alice.phone, '919876543210');
        const reloaded = new PeerStore(db, cipher);
        assert.equal(reloaded.byJid(ALICE)?.uuid, alice.uuid);
        assert.equal(reloaded.byUuid(alice.uuid)?.jid, ALICE);
    });

    it('stores JIDs, phones and names only as ciphertext', () => {
        const { db, peers } = setup();
        peers.update(ALICE, { name: 'Alice Sharma', isChat: true });
        const dump = JSON.stringify(db.all('SELECT * FROM peers'));
        assert.ok(!dump.includes('9876543210'));
        assert.ok(!dump.includes('Alice'));
        assert.ok(!dump.includes('whatsapp.net'));
    });

    it('merges a LID peer into the phone-number peer and keeps the old UUID as an alias', () => {
        const { peers, messages } = setup();
        const lidPeer = peers.update(ALICE_LID, { notify: 'Alice', isChat: true, lastMessageTs: 100 });
        messages.insert({ peerUuid: lidPeer.uuid, waId: 'A1', senderUuid: lidPeer.uuid, fromMe: false, ts: 100, type: 'text', text: 'hi' });
        const pnPeer = peers.update(ALICE, { name: 'Alice Sharma', lastMessageTs: 50 });

        peers.addLidMapping(ALICE_LID, ALICE);

        assert.equal(peers.byUuid(lidPeer.uuid)?.uuid, pnPeer.uuid, 'old UUID resolves to merged peer');
        assert.equal(peers.byJid(ALICE_LID)?.uuid, pnPeer.uuid, 'LID resolves to phone-number peer');
        const merged = peers.byUuid(pnPeer.uuid)!;
        assert.equal(merged.name, 'Alice Sharma');
        assert.equal(merged.notify, 'Alice');
        assert.equal(merged.lastMessageTs, 100);
        assert.equal(messages.forPeer(pnPeer.uuid, 10)[0].text, 'hi');
    });

    it('re-keys a LID peer to the phone number when no phone peer exists (UUID unchanged)', () => {
        const { peers } = setup();
        const lidPeer = peers.ensure(ALICE_LID);
        peers.addLidMapping(ALICE_LID, ALICE);
        assert.equal(peers.byJid(ALICE)?.uuid, lidPeer.uuid);
        assert.equal(peers.byUuid(lidPeer.uuid)?.phone, '919876543210');
    });

    it('searches by name only, exact match first', () => {
        const { peers } = setup();
        peers.update(ALICE, { name: 'Alice', lastMessageTs: 1 });
        peers.update(BOB, { name: 'Alice Cooper', lastMessageTs: 2 });
        assert.deepEqual(
            peers.search('alice', 10).map((p) => p.name),
            ['Alice', 'Alice Cooper'],
        );
        assert.equal(peers.search('98765', 10).length, 0, 'numbers are not searchable');
    });

    it('lists only chats, most recent first, and filters unread', () => {
        const { peers } = setup();
        peers.update(ALICE, { name: 'Alice', isChat: true, lastMessageTs: 10, unread: 2 });
        peers.update(GROUP, { name: 'Team', isChat: true, lastMessageTs: 20 });
        peers.update(BOB, { name: 'Bob' }); // contact only
        assert.deepEqual(
            peers.listChats({ limit: 10 }).map((p) => p.name),
            ['Team', 'Alice'],
        );
        assert.deepEqual(
            peers.listChats({ limit: 10, unreadOnly: true }).map((p) => p.name),
            ['Alice'],
        );
        assert.ok(peers.byJid(GROUP)?.isGroup);
    });

    it('exposes known phone numbers for the privacy guard', () => {
        const { peers } = setup();
        peers.ensure(ALICE);
        peers.ensure(GROUP);
        assert.deepEqual([...peers.knownPhones()], ['919876543210']);
    });
});
