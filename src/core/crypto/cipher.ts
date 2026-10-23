/**
 * @module core/crypto/cipher
 *
 * Field-level encryption for everything stored at rest.
 *
 *  - {@link Cipher.encrypt}: AES-256-GCM with a random 96-bit IV. Output format
 *    `v1:<iv>:<tag>:<ciphertext>` (base64url); the version prefix allows key rotation later.
 *    The AAD ("additional authenticated data") is the column name (plus row key where useful),
 *    so a ciphertext copied into another column or row fails to decrypt.
 *  - {@link Cipher.index}: HMAC-SHA256 "blind index" so rows can be looked up by a secret
 *    value (e.g. a WhatsApp ID) without storing it.
 *
 * Both keys are derived from ENCRYPTION_KEY with HKDF, so one master key never serves two purposes.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const HKDF_SALT = Buffer.from('whatsapp-mcp/hkdf-salt/v1');

export class DecryptionError extends Error {}

const derive = (master: Buffer, info: string) => Buffer.from(hkdfSync('sha256', master, HKDF_SALT, info, KEY_BYTES));

/**
 * Field-level encryption for everything stored at rest.
 *
 * - `encrypt` uses AES-256-GCM with a random IV; the AAD binds a ciphertext to
 *   its column (and row key where useful), so values can't be swapped around.
 * - `index` is a keyed HMAC "blind index" so lookups (e.g. by JID) work without
 *   storing the plaintext.
 */
export class Cipher {
    private readonly encKey: Buffer;
    private readonly indexKey: Buffer;

    constructor(masterKey: Buffer) {
        if (masterKey.length !== KEY_BYTES) throw new Error(`Encryption key must be ${KEY_BYTES} bytes`);
        this.encKey = derive(masterKey, 'enc/aes-256-gcm/v1');
        this.indexKey = derive(masterKey, 'index/hmac-sha256/v1');
    }

    encrypt(plaintext: string, aad: string): string {
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
        cipher.setAAD(Buffer.from(aad));
        const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
    }

    decrypt(token: string, aad: string): string {
        const [version, iv, tag, ct] = token.split(':');
        if (version !== VERSION || !iv || !tag || ct === undefined) throw new DecryptionError('Unsupported ciphertext format');
        try {
            const decipher = createDecipheriv('aes-256-gcm', this.encKey, Buffer.from(iv, 'base64url'));
            decipher.setAAD(Buffer.from(aad));
            decipher.setAuthTag(Buffer.from(tag, 'base64url'));
            return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
        } catch {
            throw new DecryptionError('Decryption failed (wrong key or tampered data)');
        }
    }

    /** Binary variant for files: returns iv(12) | tag(16) | ciphertext. */
    encryptBytes(data: Buffer, aad: string): Buffer {
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
        cipher.setAAD(Buffer.from(aad));
        const ct = Buffer.concat([cipher.update(data), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), ct]);
    }

    decryptBytes(blob: Buffer, aad: string): Buffer {
        try {
            const decipher = createDecipheriv('aes-256-gcm', this.encKey, blob.subarray(0, IV_BYTES));
            decipher.setAAD(Buffer.from(aad));
            decipher.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + 16));
            return Buffer.concat([decipher.update(blob.subarray(IV_BYTES + 16)), decipher.final()]);
        } catch {
            throw new DecryptionError('Decryption failed (wrong key or tampered data)');
        }
    }

    encryptOptional(plaintext: string | null | undefined, aad: string): string | null {
        return plaintext == null || plaintext === '' ? null : this.encrypt(plaintext, aad);
    }

    decryptOptional(token: string | null | undefined, aad: string): string | null {
        return token ? this.decrypt(token, aad) : null;
    }

    encryptJson(value: unknown, aad: string, replacer?: (key: string, value: unknown) => unknown): string {
        return this.encrypt(JSON.stringify(value, replacer as never), aad);
    }

    decryptJson<T>(token: string, aad: string, reviver?: (key: string, value: unknown) => unknown): T {
        return JSON.parse(this.decrypt(token, aad), reviver as never) as T;
    }

    /** Deterministic keyed hash for lookups; `domain` separates different kinds of values. */
    index(value: string, domain: string): string {
        return createHmac('sha256', this.indexKey).update(domain).update('\0').update(value).digest('base64url');
    }
}
