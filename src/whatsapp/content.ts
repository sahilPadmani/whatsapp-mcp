/**
 * @module whatsapp/content
 *
 * Builds Baileys message payloads for outgoing files, and decides how a file is shown
 * in WhatsApp (photo, video, audio, voice note or document).
 *
 * Only the WhatsApp layer builds Baileys payloads; services describe *what* to send
 * with {@link OutgoingMedia}.
 */
import type { AnyMessageContent } from 'baileys';
import { extensionForMime } from '../core/files/uploads.js';
import type { MediaKind } from './parser.js';

/** A file to send, as described by the services layer. */
export interface OutgoingMedia {
    data: Buffer;
    mimeType: string;
    /** Shown for documents; defaults to `file.<ext>`. */
    fileName?: string;
    caption?: string;
    /** Send audio as a push-to-talk voice note instead of an audio file. */
    voiceNote?: boolean;
}

/**
 * How a file will appear in WhatsApp. Only formats WhatsApp shows inline become
 * photos/videos (e.g. GIF and MOV are sent as documents).
 */
export function mediaKindFor(mimeType: string, voiceNote = false): MediaKind {
    const base = mimeType.split(';')[0].trim();
    if (['image/jpeg', 'image/png', 'image/webp'].includes(base)) return 'image';
    if (['video/mp4', 'video/3gpp'].includes(base)) return 'video';
    if (base.startsWith('audio/')) return voiceNote ? 'voice' : 'audio';
    return 'document';
}

/** Builds the Baileys `sendMessage` content for a file. */
export function buildMediaContent(media: OutgoingMedia): { content: AnyMessageContent; kind: MediaKind } {
    const kind = mediaKindFor(media.mimeType, media.voiceNote);
    const caption = media.caption || undefined;
    switch (kind) {
        case 'image':
            return { kind, content: { image: media.data, mimetype: media.mimeType, caption } };
        case 'video':
            return { kind, content: { video: media.data, mimetype: media.mimeType, caption } };
        case 'voice':
            // WhatsApp only plays voice notes encoded as OGG/Opus.
            return { kind, content: { audio: media.data, mimetype: 'audio/ogg; codecs=opus', ptt: true } };
        case 'audio':
            return { kind, content: { audio: media.data, mimetype: media.mimeType } };
        default:
            return {
                kind: 'document',
                content: {
                    document: media.data,
                    mimetype: media.mimeType,
                    fileName: media.fileName ?? `file.${extensionForMime(media.mimeType)}`,
                    caption,
                },
            };
    }
}
