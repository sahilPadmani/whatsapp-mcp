import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ALICE, BOB, findIdentifiers, PHONES } from '../../helpers/index.js';
import { createHarness, type Harness } from './harness.js';

describe('toolset: sending', () => {
    let h: Harness;
    beforeEach(async () => {
        h = await createHarness();
    });

    it('sends to a chat id; only the server knows the number', async () => {
        const { data: contacts } = await h.call('search_contacts', { query: 'Alice' });
        const out = await h.call('send_message', { to: contacts[0].id, text: 'hello Alice' });
        assert.equal(out.isError, false, out.text);
        assert.equal(h.gw.sent[0].jid, ALICE);
        assert.equal(out.data.chat.name, 'Alice');
        assert.match(out.data.messageId, /^[0-9a-f-]{36}$/);
        assert.deepEqual(findIdentifiers(out.data, PHONES), []);
    });

    it('reply_to_message sends a quoted reply in the original chat', async () => {
        const { data } = await h.call('get_messages', { chat: 'Alice' });
        const target = data.messages.at(-1);
        const out = await h.call('reply_to_message', { message_id: target.id, text: 'yes!' });
        assert.equal(out.isError, false, out.text);
        assert.equal(h.gw.sent[0].jid, ALICE);
        assert.equal(h.gw.sent[0].quoted?.key.id, 'A2');
        assert.equal(out.data.replyTo, target.id);
        const after = await h.call('get_messages', { chat: 'Alice' });
        assert.equal(after.data.messages.at(-1).replyTo, target.id);
    });

    it('send_message reply_to must belong to the same chat', async () => {
        const bobMsg = (await h.call('get_messages', { chat: 'Bob Builder' })).data.messages[0];
        const out = await h.call('send_message', { to: 'Alice', text: 'x', reply_to: bobMsg.id });
        assert.match(out.text, /from this chat/);
    });

    describe('to a phone number', () => {
        it('sends to an existing contact by number and returns only the chat id + name', async () => {
            const out = await h.call('send_message', { to: '+91 98765 43210', text: 'hi by number' });
            assert.equal(out.isError, false, out.text);
            assert.equal(h.gw.sent[0].jid, ALICE);
            assert.equal(out.data.chat.id, h.peers.byJid(ALICE)?.uuid);
            assert.equal(out.data.chat.name, 'Alice');
            assert.equal(out.data.newChat, undefined, 'existing conversation');
            assert.deepEqual(findIdentifiers(out, PHONES), []);
        });

        it('starts a new chat with a number that is not a saved contact', async () => {
            const out = await h.call('send_message', { to: '00447700900456', text: 'hello stranger' });
            assert.equal(out.isError, false, out.text);
            assert.equal(h.gw.sent[0].jid, '447700900456@s.whatsapp.net');
            assert.equal(out.data.newChat, true);
            assert.equal(out.data.chat.name, 'Unknown contact');
            assert.deepEqual(findIdentifiers(out, [...PHONES, '447700900456']), []);
            // The new chat now has a UUID and can be used like any other.
            const again = await h.call('send_message', { to: out.data.chat.id, text: 'follow-up' });
            assert.equal(again.isError, false);
            assert.equal(again.data.newChat, undefined);
        });

        it('errors clearly when the number is not on WhatsApp (without echoing it)', async () => {
            const out = await h.call('send_message', { to: '+91 99999 00000', text: 'x' });
            assert.equal(out.isError, true);
            assert.equal(out.text, 'This phone number is not on WhatsApp.');
            assert.equal(h.gw.sent.length, 0);
        });

        it('requires the country code', async () => {
            assert.match((await h.call('send_message', { to: '98765 43210', text: 'x' })).text, /country code/);
            assert.match((await h.call('send_message', { to: '098765 43210', text: 'x' })).text, /country code/);
            assert.equal(h.gw.lookups.length, 0);
        });

        it('send_media also accepts a phone number', async () => {
            const out = await h.call('send_media', {
                to: '+1 (415) 555-0123',
                data_base64: Buffer.from('a,b').toString('base64'),
                file_name: 'x.csv',
            });
            assert.equal(out.isError, false, out.text);
            assert.equal(h.gw.sent[0].jid, BOB);
        });

        it("limits new chats per day and respects WhatsApp's own new-chat quota", async () => {
            h.gw.registered = new Set(['447700900001', '447700900002', '447700900003', '447700900004']);
            for (const n of ['1', '2', '3']) {
                assert.equal((await h.call('send_message', { to: `+44770090000${n}`, text: 'x' })).isError, false);
            }
            assert.match((await h.call('send_message', { to: '+447700900004', text: 'x' })).text, /Daily limit for starting new chats/);
            assert.equal((await h.call('whatsapp_status')).data.newChatsStartedToday, 3);

            const fresh = await createHarness();
            fresh.gw.registered.add('447700900005');
            fresh.gw.quota = { total: 5, used: 5 };
            assert.match((await fresh.call('send_message', { to: '+447700900005', text: 'x' })).text, /own limit/);
            assert.equal((await fresh.call('send_message', { to: 'Alice', text: 'existing chats are not limited' })).isError, false);
        });

        it('can be disabled with ALLOW_SEND_TO_PHONE=false', async () => {
            const strict = await createHarness({ settings: { ALLOW_SEND_TO_PHONE: false } });
            assert.match((await strict.call('send_message', { to: '+91 98765 43210', text: 'x' })).text, /disabled/);
        });
    });
});
