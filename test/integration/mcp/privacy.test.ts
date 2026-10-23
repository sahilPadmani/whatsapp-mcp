import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ALICE, findIdentifiers, GROUP, PHONES } from '../../helpers/index.js';
import { createHarness, type Harness } from './harness.js';

describe('MCP privacy rules', () => {
    let h: Harness;
    beforeEach(async () => {
        h = await createHarness();
    });

    it('never returns phone numbers or JIDs from read tools', async () => {
        const outputs = [
            await h.call('whatsapp_status'),
            await h.call('list_chats', { limit: 50 }),
            await h.call('search_contacts', { query: 'b' }),
            await h.call('get_messages', { chat: 'Alice' }),
            await h.call('get_new_messages'),
        ];
        for (const out of outputs) assert.deepEqual(findIdentifiers(out.data, PHONES), [], out.text);

        const chats = outputs[1].data as Array<{ name: string }>;
        assert.ok(
            chats.some((c) => c.name === 'Unknown contact'),
            'contact named after its number is redacted',
        );
        assert.equal(outputs[3].data.messages[0].text, 'hi, my number is 919876543210', 'message content passes through');
    });

    it('rejects JIDs anywhere, and phone numbers in read tools', async () => {
        for (const [tool, args] of [
            ['send_message', { to: ALICE, text: 'x' }],
            ['send_media', { to: GROUP, data_base64: 'aGk=' }],
            ['get_messages', { chat: '919876543210' }],
            ['search_contacts', { query: '98765 43210' }],
            ['list_chats', { query: '+14155550123' }],
        ] as const) {
            const out = await h.call(tool, args);
            assert.equal(out.isError, true, `${tool} ${JSON.stringify(args)}`);
            assert.match(out.text, /not accepted/);
        }
        assert.equal(h.gw.sent.length, 0);
    });

    it('resolves exact names and lists candidates (ids only) when ambiguous', async () => {
        h.peers.update('447700900123@s.whatsapp.net', { name: 'Alice Cooper' });
        const exact = await h.call('get_messages', { chat: 'alice' });
        assert.equal(exact.data.chat.name, 'Alice');
        const ambiguous = await h.call('get_messages', { chat: 'ali' });
        assert.equal(ambiguous.isError, true);
        assert.match(ambiguous.text, /matches several chats/);
        assert.deepEqual(findIdentifiers(ambiguous.text, PHONES), []);
    });

    it('returns the login hint when WhatsApp is disconnected', async () => {
        h.gw.state = 'qr';
        const out = await h.call('send_message', { to: 'Alice', text: 'x' });
        assert.equal(out.isError, true);
        assert.equal(out.text, 'LOGIN REQUIRED');
        const status = await h.call('whatsapp_status');
        assert.equal(status.data.connected, false);
        assert.equal(status.data.hint, 'LOGIN REQUIRED');
    });
});
