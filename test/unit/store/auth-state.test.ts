import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EncryptedAuthStore } from '../../../src/store/auth-state.js';
import { setup } from '../../helpers/index.js';

describe('EncryptedAuthStore', () => {
    it('persists credentials and keys across reloads, encrypted', async () => {
        const { db, cipher } = setup();
        const store = new EncryptedAuthStore(db, cipher);
        assert.equal(store.hasSession(), false);

        const { state, saveCreds } = store.load();
        state.creds.me = { id: '919000000001:5@s.whatsapp.net', name: 'Me' };
        saveCreds();
        await state.keys.set({
            session: { 'a.1': Buffer.from('session-bytes') },
            'pre-key': { '7': { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 2) } },
        });

        const reloaded = new EncryptedAuthStore(db, cipher).load();
        assert.equal(reloaded.state.creds.me?.id, '919000000001:5@s.whatsapp.net');
        assert.deepEqual(reloaded.state.creds.noiseKey.public, state.creds.noiseKey.public);
        const sessions = await reloaded.state.keys.get('session', ['a.1', 'missing']);
        assert.equal(Buffer.from(sessions['a.1']).toString(), 'session-bytes');
        assert.equal(sessions.missing, undefined);
        const preKeys = await reloaded.state.keys.get('pre-key', ['7']);
        assert.deepEqual(Buffer.from(preKeys['7'].private), Buffer.alloc(32, 2));

        const dump = JSON.stringify(db.all('SELECT * FROM auth_kv'));
        assert.ok(!dump.includes('919000000001'), 'no plaintext phone/JID');
        assert.ok(!dump.includes('session-bytes'));
        assert.ok(new EncryptedAuthStore(db, cipher).hasSession());
    });

    it('deletes keys set to null and clears everything on logout', async () => {
        const { db, cipher } = setup();
        const store = new EncryptedAuthStore(db, cipher);
        const { state, saveCreds } = store.load();
        saveCreds();
        await state.keys.set({ session: { x: Buffer.from('1') } });
        await state.keys.set({ session: { x: null } });
        assert.deepEqual(await state.keys.get('session', ['x']), {});
        store.clear();
        assert.equal(store.hasSession(), false);
    });
});
