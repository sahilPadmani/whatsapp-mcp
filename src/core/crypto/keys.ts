/**
 * @module core/crypto/keys
 *
 * Secret bootstrap and key verification:
 *  - {@link ensureSecrets} creates missing `API_KEY` / `ENCRYPTION_KEY` in `.env` on first run;
 *  - {@link parseEncryptionKey} validates the key format;
 *  - {@link verifyKey} stores an encrypted canary and checks it on every start, so a wrong
 *    key is detected before any data is written with it.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ConfigError } from '../errors.js';
import type { Database } from '../db/database.js';
import type { Cipher } from './cipher.js';

const KEY_BYTES = 32;
const CANARY = 'whatsapp-mcp-key-check';

/** 32 random bytes, base64 (same as `openssl rand -base64 32`). */
export const generateEncryptionKey = () => randomBytes(KEY_BYTES).toString('base64');
/** 48 hex characters. */
export const generateApiKey = () => randomBytes(24).toString('hex');

export function parseEncryptionKey(value: string): Buffer {
    const key = Buffer.from(value, 'base64');
    if (key.length !== KEY_BYTES) {
        throw new ConfigError(`ENCRYPTION_KEY must be ${KEY_BYTES} bytes encoded as base64 (generate one with: openssl rand -base64 32)`);
    }
    return key;
}

/**
 * First-run bootstrap: creates API_KEY / ENCRYPTION_KEY in the .env file when
 * missing. An empty `KEY=` line (as copied from .env.example) is filled in place;
 * otherwise the key is appended. Refuses to invent a new ENCRYPTION_KEY if an
 * encrypted database already exists, since that data could never be decrypted again.
 *
 * @returns the names of the secrets that were generated
 * @throws {ConfigError} if ENCRYPTION_KEY is missing but encrypted data exists
 */
export function ensureSecrets(envFile: string, env: NodeJS.ProcessEnv, databaseExists: boolean): string[] {
    const generated: Record<string, string> = {};

    if (!env.ENCRYPTION_KEY) {
        if (databaseExists) {
            throw new ConfigError(
                'ENCRYPTION_KEY is not set but an encrypted database exists. Restore the original key, ' +
                    'or delete the data directory to start over (this logs WhatsApp out and deletes stored messages).',
            );
        }
        generated.ENCRYPTION_KEY = generateEncryptionKey();
    }
    if (!env.API_KEY) generated.API_KEY = generateApiKey();

    const names = Object.keys(generated);
    if (names.length) {
        let content = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
        const appended: string[] = [];
        for (const name of names) {
            env[name] = generated[name];
            const emptyLine = new RegExp(`^${name}=[ \\t]*$`, 'm');
            if (emptyLine.test(content)) content = content.replace(emptyLine, `${name}=${generated[name]}`);
            else appended.push(`${name}=${generated[name]}`);
        }
        if (appended.length) {
            const prefix = content && !content.endsWith('\n') ? '\n' : '';
            content += `${prefix}# Generated on first run. Back these up; losing ENCRYPTION_KEY makes stored data unreadable.\n${appended.join('\n')}\n`;
        }
        writeFileSync(envFile, content, { mode: 0o600 });
        chmodSync(envFile, 0o600);
    }
    return names;
}

/** Stores an encrypted canary on first use and verifies it afterwards, so a wrong key fails fast. */
export function verifyKey(db: Database, cipher: Cipher) {
    const row = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'key_check'");
    if (!row) {
        db.run("INSERT INTO meta (key, value) VALUES ('key_check', ?)", cipher.encrypt(CANARY, 'meta.key_check'));
        return;
    }
    let ok: boolean;
    try {
        ok = cipher.decrypt(row.value, 'meta.key_check') === CANARY;
    } catch {
        ok = false;
    }
    if (!ok) throw new ConfigError('ENCRYPTION_KEY does not match the key this database was created with.');
}
