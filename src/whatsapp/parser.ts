/**
 * @module whatsapp/parser
 *
 * Converts WhatsApp message payloads into `{ type, text, media? }`: a readable text for
 * every kind of message (`[image] caption`, `[voice note]`, `[location …]`, …) plus media
 * metadata. Protocol/bookkeeping payloads return undefined and are not stored.
 */
import { getContentType, normalizeMessageContent, type proto } from 'baileys';

// Protocol/bookkeeping payloads that aren't user-visible messages.
const IGNORED = new Set([
    'protocolMessage',
    'senderKeyDistributionMessage',
    'messageContextInfo',
    'reactionMessage',
    'pollUpdateMessage',
    'keepInChatMessage',
    'encReactionMessage',
]);

export type MediaKind = 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';

/** Metadata of an attached file; the bytes are downloaded on demand. */
export interface MediaInfo {
    kind: MediaKind;
    mimeType: string | null;
    fileName: string | null;
    size: number | null;
    seconds: number | null;
    caption: string | null;
}

export interface ParsedMessage {
    type: string;
    text: string;
    media?: MediaInfo;
}

/** Long | number | null → number | null (protobuf int64 fields). */
const num = (value: unknown): number | null => (value == null ? null : toSeconds(value));

const mediaInfo = (
    kind: MediaKind,
    m:
        | { mimetype?: string | null; fileLength?: unknown; seconds?: number | null; caption?: string | null; fileName?: string | null }
        | null
        | undefined,
): MediaInfo => ({
    kind,
    mimeType: m?.mimetype ?? null,
    fileName: m?.fileName ?? null,
    size: num(m?.fileLength),
    seconds: m?.seconds ?? null,
    caption: m?.caption || null,
});

/** Turns a WhatsApp message payload into { type, text, media? }, or undefined for non-displayable payloads. */
export function describeMessage(message: proto.IMessage | null | undefined): ParsedMessage | undefined {
    const content = normalizeMessageContent(message);
    const type = getContentType(content);
    if (!content || !type || IGNORED.has(type)) return undefined;

    const caption = (prefix: string, text?: string | null) => (text ? `${prefix} ${text}` : prefix);

    switch (type) {
        case 'conversation':
            return { type: 'text', text: content.conversation ?? '' };
        case 'extendedTextMessage':
            return { type: 'text', text: content.extendedTextMessage?.text ?? '' };
        case 'imageMessage':
            return {
                type: 'image',
                text: caption('[image]', content.imageMessage?.caption),
                media: mediaInfo('image', content.imageMessage),
            };
        case 'videoMessage':
            return {
                type: 'video',
                text: caption('[video]', content.videoMessage?.caption),
                media: mediaInfo('video', content.videoMessage),
            };
        case 'audioMessage': {
            const voice = Boolean(content.audioMessage?.ptt);
            return {
                type: 'audio',
                text: voice ? '[voice note]' : '[audio]',
                media: mediaInfo(voice ? 'voice' : 'audio', content.audioMessage),
            };
        }
        case 'documentMessage':
        case 'documentWithCaptionMessage': {
            const doc = content.documentMessage ?? content.documentWithCaptionMessage?.message?.documentMessage;
            return {
                type: 'document',
                text: caption(`[document: ${doc?.fileName ?? 'file'}]`, doc?.caption),
                media: mediaInfo('document', doc),
            };
        }
        case 'stickerMessage':
            return { type: 'sticker', text: '[sticker]', media: mediaInfo('sticker', content.stickerMessage) };
        case 'locationMessage': {
            const loc = content.locationMessage;
            return { type: 'location', text: caption(`[location ${loc?.degreesLatitude},${loc?.degreesLongitude}]`, loc?.name) };
        }
        case 'contactMessage':
            return { type: 'contact', text: `[contact: ${content.contactMessage?.displayName ?? ''}]` };
        case 'pollCreationMessage':
        case 'pollCreationMessageV2':
        case 'pollCreationMessageV3': {
            const poll = content[type];
            return { type: 'poll', text: `[poll] ${poll?.name ?? ''}` };
        }
        default:
            return { type: type.replace(/Message$/, ''), text: `[${type.replace(/Message$/, '')}]` };
    }
}

/** messageTimestamp is number | Long depending on where the message came from. */
export function toSeconds(value: unknown): number {
    if (typeof value === 'number') return value;
    if (value && typeof (value as { toNumber?: () => number }).toNumber === 'function') {
        return (value as { toNumber: () => number }).toNumber();
    }
    return Number(value) || Math.floor(Date.now() / 1000);
}

/** WhatsApp message id this message quotes, if it is a reply. */
export function quotedMessageId(message: proto.IMessage | null | undefined): string | undefined {
    const content = normalizeMessageContent(message);
    const type = getContentType(content);
    if (!content || !type) return undefined;
    const inner = content[type] as { contextInfo?: proto.IContextInfo | null } | undefined;
    return inner && typeof inner === 'object' ? (inner.contextInfo?.stanzaId ?? undefined) : undefined;
}
