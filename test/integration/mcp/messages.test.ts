import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { BOB, waMessage } from '../../helpers/index.js';
import { createHarness, type Harness } from './harness.js';

describe('toolset: messages', () => {
    let h: Harness;
    beforeEach(async () => {
        h = await createHarness();
    });

    it('get_new_messages returns unread, then waits for and returns new arrivals', async () => {
        const first = await h.call('get_new_messages');
        assert.equal(first.data.messages.length, 5);
        assert.equal(first.data.messages[0].chat.name, 'Alice');

        const cursor = first.data.next_cursor;
        setTimeout(() => h.ingest.saveMessages([waMessage({ chat: BOB, id: 'B2', text: 'new one' })], true), 50);
        const started = Date.now();
        const waited = await h.call('get_new_messages', { cursor, wait_seconds: 10 });
        assert.ok(Date.now() - started < 5000, 'returned as soon as the message arrived');
        assert.deepEqual(
            waited.data.messages.map((m: { text: string }) => m.text),
            ['new one'],
        );
        assert.ok(waited.data.next_cursor > cursor);

        const empty = await h.call('get_new_messages', { cursor: waited.data.next_cursor });
        assert.equal(empty.data.messages.length, 0);
        assert.equal(empty.data.next_cursor, waited.data.next_cursor);
    });

    it('get_messages pages back with before_ts', async () => {
        const page = await h.call('get_messages', { chat: 'Alice', limit: 1 });
        assert.equal(page.data.messages[0].text, 'you there?');
        const older = await h.call('get_messages', { chat: 'Alice', limit: 1, before_ts: page.data.messages[0].ts });
        assert.equal(older.data.messages[0].text, 'hi, my number is 919876543210');
    });

    it('mark_as_read sends read receipts and resets unread', async () => {
        const out = await h.call('mark_as_read', { chat: 'Alice' });
        assert.equal(out.data.marked, 2);
        assert.deepEqual(h.gw.read.map((k) => k.id).sort(), ['A1', 'A2']);
        const unread = await h.call('list_chats', { unread_only: true });
        assert.ok(!unread.data.some((c: { name: string }) => c.name === 'Alice'));
    });
});
