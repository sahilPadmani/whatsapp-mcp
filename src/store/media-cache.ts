/**
 * @module store/media-cache
 *
 * Encrypted on-disk cache of media files (`data/media/<message uuid>.bin`). See {@link MediaCache}.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Cipher } from '../core/crypto/cipher.js';

const aad = (messageUuid: string) => `media:${messageUuid}`;

/**
 * Encrypted on-disk cache of downloaded media, keyed by message UUID (which
 * reveals nothing). Avoids re-downloading from WhatsApp, whose media URLs expire.
 */
export class MediaCache {
    private readonly dir: string;

    constructor(
        dataDir: string,
        private readonly cipher: Cipher,
    ) {
        this.dir = path.join(dataDir, 'media');
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }

    private file(messageUuid: string) {
        if (!/^[0-9a-f-]{36}$/i.test(messageUuid)) throw new Error('invalid message id');
        return path.join(this.dir, `${messageUuid.toLowerCase()}.bin`);
    }

    get(messageUuid: string): Buffer | undefined {
        const file = this.file(messageUuid);
        return existsSync(file) ? this.cipher.decryptBytes(readFileSync(file), aad(messageUuid.toLowerCase())) : undefined;
    }

    put(messageUuid: string, data: Buffer) {
        writeFileSync(this.file(messageUuid), this.cipher.encryptBytes(data, aad(messageUuid.toLowerCase())), { mode: 0o600 });
    }

    clear() {
        rmSync(this.dir, { recursive: true, force: true });
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }
}
