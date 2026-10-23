/**
 * @module services/media.service
 *
 * Media in both directions:
 *  - {@link MediaService.fetch}: the bytes of a message's attachment. Served from the
 *    encrypted cache if present, otherwise downloaded from WhatsApp and cached.
 *  - {@link MediaService.readUpload}: a file a caller wants to send, given as base64 or
 *    as a path inside MEDIA_SEND_DIR (never anywhere else on disk).
 */
import { UserError } from '../core/errors.js';
import { decodeBase64, mimeFromFileName, readAllowedFile } from '../core/files/uploads.js';
import type { MediaCache } from '../store/media-cache.js';
import type { MessageStore, StoredMessage } from '../store/messages.js';
import type { WhatsAppGateway } from '../whatsapp/gateway.js';
import type { MediaInfo } from '../whatsapp/parser.js';
import { requireConnected } from './connection.js';

export interface MediaServiceOptions {
    /** MEDIA_MAX_BYTES */
    maxBytes: number;
    /** MEDIA_SEND_DIR (undefined = base64 uploads only) */
    sendDir?: string;
}

/** Caller-supplied file: exactly one of `dataBase64` / `filePath`. */
export interface UploadInput {
    dataBase64?: string;
    filePath?: string;
    /** Guessed from `fileName` when omitted. */
    mimeType?: string;
    fileName?: string;
}

/** A validated file ready to send. */
export interface Upload {
    data: Buffer;
    mimeType: string;
    fileName?: string;
}

export class MediaService {
    constructor(
        private readonly messages: MessageStore,
        private readonly cache: MediaCache,
        private readonly wa: Pick<WhatsAppGateway, 'connected' | 'downloadMedia'>,
        private readonly options: MediaServiceOptions,
    ) {}

    /**
     * Returns the attachment of a message.
     * @throws {UserError} unknown message, no media, too large, original unavailable, or download failed
     * @throws {NotConnectedError} if it has to be downloaded while WhatsApp is disconnected
     */
    async fetch(messageId: string): Promise<{ message: StoredMessage; info: MediaInfo; data: Buffer }> {
        const message = this.messages.byUuid(messageId);
        if (!message) throw new UserError(`Unknown message id "${messageId}".`);
        const info = message.media;
        if (!info) throw new UserError('This message has no media.');
        this.assertSize(info.size);

        let data = this.cache.get(message.uuid);
        if (!data) {
            requireConnected(this.wa);
            const raw = this.messages.raw(message.uuid);
            if (!raw) throw new UserError('The original message is not available, so its media cannot be downloaded.');
            try {
                data = await this.wa.downloadMedia(raw);
            } catch {
                throw new UserError('Could not download this media from WhatsApp (it may have expired or been deleted).');
            }
            this.assertSize(data.length);
            this.cache.put(message.uuid, data);
        }
        return { message, info, data };
    }

    /**
     * Validates and loads a file to send.
     * @throws {UserError} if both or neither source is given, or the file is invalid/too large/outside MEDIA_SEND_DIR
     */
    readUpload(input: UploadInput): Upload {
        if (Boolean(input.dataBase64) === Boolean(input.filePath)) throw new UserError('Provide exactly one of data_base64 or file_path.');
        let data: Buffer;
        let fileName = input.fileName;
        if (input.filePath) {
            const file = readAllowedFile(input.filePath, this.options.sendDir, this.options.maxBytes);
            data = file.data;
            fileName ??= file.fileName;
        } else {
            data = decodeBase64(input.dataBase64!, this.options.maxBytes);
        }
        return { data, mimeType: input.mimeType ?? mimeFromFileName(fileName), fileName };
    }

    /** Caches a file we just sent, so fetching it later needs no download. */
    remember(messageId: string, data: Buffer): void {
        this.cache.put(messageId, data);
    }

    private assertSize(size: number | null | undefined) {
        if (size && size > this.options.maxBytes) throw new UserError('The file is larger than the configured media limit.');
    }
}
