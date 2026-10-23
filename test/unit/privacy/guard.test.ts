import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PrivacyGuard } from '../../../src/privacy/guard.js';

const guard = new PrivacyGuard(() => new Set(['919876543210', '14155550123']));

describe('PrivacyGuard', () => {
    it('redacts JIDs and phone numbers in nested non-content fields', () => {
        const { value, redactions } = guard.sanitize({
            chat: { id: '919876543210@s.whatsapp.net', name: '+91 98765-43210' },
            list: [{ other: 'group 120363000000000001@g.us' }, { other: 'lid 123@lid' }],
            note: 'call (415) 555-0123',
        });
        assert.deepEqual(value, {
            chat: { id: '[redacted]', name: 'Unknown contact' },
            list: [{ other: '[redacted]' }, { other: '[redacted]' }],
            note: '[redacted]',
        });
        assert.equal(redactions.length, 5);
    });

    it('catches a known number hidden in a name or given as a number', () => {
        const { value } = guard.sanitize({ senderName: 'Alice 919876543210', chatName: 'Bob', count: 919876543210, local: 9876543210 });
        assert.deepEqual(value, { senderName: 'Unknown contact', chatName: 'Bob', count: '[redacted]', local: '[redacted]' });
    });

    it('catches a known number embedded in a long digit string', () => {
        assert.equal(guard.detect('ref0000919876543210000'), 'phone');
    });

    it('leaves message content fields untouched', () => {
        const payload = { text: 'my number is +91 98765 43210', preview: '919876543210@s.whatsapp.net', lastMessage: 'ring 14155550123' };
        assert.deepEqual(guard.sanitize(payload).value, payload);
    });

    it('does not touch UUIDs, ISO times, timestamps, cursors or short numbers', () => {
        const payload = {
            id: '0b7f3c2e-6a1d-4e58-9c3b-2f8e4d6a1b90',
            time: '2026-10-23T08:22:47.000Z',
            ts: 1792743767,
            next_cursor: 4821,
            name: 'Room 42',
            unread: 3,
        };
        const { value, redactions } = guard.sanitize(payload);
        assert.deepEqual(value, payload);
        assert.equal(redactions.length, 0);
    });

    it('ignores digits inside UUIDs and timestamps embedded in longer text', () => {
        const text =
            'pick one: [{"id":"5d2c8e14-3b7a-4f96-a0d1-7e9c4b2f6a35"},{"id":"11111111-2222-4333-8444-555555555555"}] at 2026-10-23T08:22:47.000Z';
        assert.equal(guard.detect(text), null);
        assert.equal(guard.detect('id 5d2c8e14-3b7a-4f96-a0d1-7e9c4b2f6a35 or +91 98765 43210'), 'phone');
    });

    it('drops object keys that are identifiers', () => {
        assert.deepEqual(guard.sanitize({ map: { '919876543210@s.whatsapp.net': 1, ok: 2 } }).value, { map: { ok: 2 } });
    });

    it('detect() classifies input strings', () => {
        assert.equal(guard.detect('+91 98765 43210'), 'phone');
        assert.equal(guard.detect('919876543210@s.whatsapp.net'), 'jid');
        assert.equal(guard.detect('Alice Example'), null);
        assert.equal(guard.detect('0b7f3c2e-6a1d-4e58-9c3b-2f8e4d6a1b90'), null);
    });
});
