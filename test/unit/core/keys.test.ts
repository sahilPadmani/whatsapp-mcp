import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError } from '../../../src/config.js';
import { Cipher } from '../../../src/core/crypto/cipher.js';
import { ensureSecrets, generateEncryptionKey, parseEncryptionKey, verifyKey } from '../../../src/core/crypto/keys.js';
import { Database } from '../../../src/core/db/database.js';
import { migrate } from '../../../src/store/migrations.js';

describe('secrets bootstrap', () => {
    it('generates missing keys into .env with 0600 permissions', () => {
        const envFile = path.join(mkdtempSync(path.join(tmpdir(), 'wa-mcp-')), '.env');
        const env: NodeJS.ProcessEnv = {};
        assert.deepEqual(ensureSecrets(envFile, env, false).sort(), ['API_KEY', 'ENCRYPTION_KEY']);
        assert.equal(parseEncryptionKey(env.ENCRYPTION_KEY!).length, 32);
        assert.match(readFileSync(envFile, 'utf8'), /ENCRYPTION_KEY=.+\nAPI_KEY=.+/);
        assert.equal(statSync(envFile).mode & 0o777, 0o600);
    });

    it('fills empty KEY= lines copied from .env.example instead of duplicating them', () => {
        const envFile = path.join(mkdtempSync(path.join(tmpdir(), 'wa-mcp-')), '.env');
        writeFileSync(envFile, 'PORT=3000\nAPI_KEY=\nENCRYPTION_KEY=\nTOOLSETS=all\n');
        const env: NodeJS.ProcessEnv = { PORT: '3000', API_KEY: '', ENCRYPTION_KEY: '' };
        ensureSecrets(envFile, env, false);
        const content = readFileSync(envFile, 'utf8');
        assert.equal(content.match(/^API_KEY=/gm)?.length, 1);
        assert.equal(content.match(/^ENCRYPTION_KEY=/gm)?.length, 1);
        assert.match(content, new RegExp(`^API_KEY=${env.API_KEY}$`, 'm'));
        assert.match(content, /^TOOLSETS=all$/m, 'other lines untouched');
    });

    it('refuses to create a new encryption key when encrypted data exists', () => {
        const envFile = path.join(mkdtempSync(path.join(tmpdir(), 'wa-mcp-')), '.env');
        assert.throws(() => ensureSecrets(envFile, { API_KEY: 'x'.repeat(32) }, true), ConfigError);
    });

    it('rejects keys that are not 32 bytes', () => {
        assert.throws(() => parseEncryptionKey(Buffer.alloc(16).toString('base64')), ConfigError);
    });

    it('verifyKey accepts the original key and rejects a different one', () => {
        const db = new Database(':memory:');
        migrate(db);
        const key = parseEncryptionKey(generateEncryptionKey());
        verifyKey(db, new Cipher(key)); // stores canary
        verifyKey(db, new Cipher(key)); // same key passes
        assert.throws(() => verifyKey(db, new Cipher(parseEncryptionKey(generateEncryptionKey()))), ConfigError);
    });
});
