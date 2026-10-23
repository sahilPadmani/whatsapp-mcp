import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { Cipher, DecryptionError } from '../../../src/core/crypto/cipher.js';

describe('Cipher', () => {
    const cipher = new Cipher(randomBytes(32));

    it('round-trips text, including unicode', () => {
        const token = cipher.encrypt('hello 👋 नमस्ते', 'messages.text');
        assert.match(token, /^v1:/);
        assert.equal(cipher.decrypt(token, 'messages.text'), 'hello 👋 नमस्ते');
    });

    it('uses a random IV (same plaintext → different ciphertext)', () => {
        assert.notEqual(cipher.encrypt('same', 'a'), cipher.encrypt('same', 'a'));
    });

    it('never contains the plaintext', () => {
        assert.ok(!cipher.encrypt('919876543210@s.whatsapp.net', 'peers.jid').includes('9876543210'));
    });

    it('rejects tampered ciphertext', () => {
        const parts = cipher.encrypt('secret', 'a').split(':');
        const ct = Buffer.from(parts[3], 'base64url');
        ct[0] ^= 0xff;
        parts[3] = ct.toString('base64url');
        assert.throws(() => cipher.decrypt(parts.join(':'), 'a'), DecryptionError);
    });

    it('rejects a different AAD (value moved to another column)', () => {
        const token = cipher.encrypt('secret', 'peers.name');
        assert.throws(() => cipher.decrypt(token, 'messages.text'), DecryptionError);
    });

    it('rejects the wrong key', () => {
        const token = cipher.encrypt('secret', 'a');
        assert.throws(() => new Cipher(randomBytes(32)).decrypt(token, 'a'), DecryptionError);
    });

    it('blind index is deterministic, keyed and domain-separated', () => {
        assert.equal(cipher.index('x', 'jid'), cipher.index('x', 'jid'));
        assert.notEqual(cipher.index('x', 'jid'), cipher.index('x', 'wa-message-id'));
        assert.notEqual(cipher.index('x', 'jid'), new Cipher(randomBytes(32)).index('x', 'jid'));
    });

    it('requires a 32-byte key', () => {
        assert.throws(() => new Cipher(randomBytes(16)));
    });
});
