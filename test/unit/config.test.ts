import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from '../../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = { API_KEY: 'x'.repeat(24), ENCRYPTION_KEY: 'k' };

/** Keys declared in the zod schema in src/config.ts. */
const schemaKeys = () => [...readFileSync(path.join(ROOT, 'src/config.ts'), 'utf8').matchAll(/^ {8}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);

/** Parses a dotenv file into { KEY: value }. */
const parseEnvFile = (file: string) =>
    Object.fromEntries([...readFileSync(path.join(ROOT, file), 'utf8').matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2]]));

describe('config', () => {
    it('applies defaults and derives publicUrl', () => {
        const c = loadConfig(base);
        assert.equal(c.PORT, 3000);
        assert.equal(c.publicUrl, 'http://127.0.0.1:3000');
        assert.deepEqual(c.TOOLSETS, ['all']);
        assert.equal(c.HUMANIZE_REPLIES, true);
        assert.equal(loadConfig({ ...base, HOST: '0.0.0.0', PUBLIC_URL: 'https://wa.example.com/' }).publicUrl, 'https://wa.example.com');
    });

    it('treats empty values as unset and parses lists and booleans', () => {
        const c = loadConfig({
            ...base,
            PUBLIC_URL: '',
            WEBHOOK_URL: '',
            MEDIA_SEND_DIR: '',
            TOOLSETS: 'chats, messages',
            HUMANIZE_REPLIES: 'false',
        });
        assert.equal(c.WEBHOOK_URL, undefined);
        assert.equal(c.MEDIA_SEND_DIR, undefined);
        assert.deepEqual(c.TOOLSETS, ['chats', 'messages']);
        assert.equal(c.HUMANIZE_REPLIES, false);
    });

    it('reports every invalid value at once', () => {
        assert.throws(
            () => loadConfig({ API_KEY: 'short', ENCRYPTION_KEY: 'k', PORT: 'abc' }),
            (e: Error) => e instanceof ConfigError && /API_KEY/.test(e.message) && /PORT/.test(e.message),
        );
        // Cross-field rules are checked once the individual fields are valid.
        assert.throws(() => loadConfig({ ...base, WEBHOOK_URL: 'https://x.example' }), /WEBHOOK_SECRET/);
    });

    it('.env.example lists every setting, and loads with only secrets added', () => {
        const example = parseEnvFile('.env.example');
        assert.deepEqual(Object.keys(example).sort(), schemaKeys().sort());
        assert.doesNotThrow(() => loadConfig({ ...example, ...base }));
    });
});
