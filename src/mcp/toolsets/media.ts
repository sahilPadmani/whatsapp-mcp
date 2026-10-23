/**
 * @module mcp/toolsets/media
 *
 * Toolset "media": `get_media`, `send_media`.
 *
 * `get_media` returns the file as MCP content: images (and stickers) as image content so
 * multimodal agents can see them, audio/voice notes as audio content, other files as an
 * embedded resource.
 */
import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { MediaInfo } from '../../whatsapp/parser.js';
import { registerGuardedTool, WithAttachments } from '../guarded-tool.js';
import { args, type Toolset } from './types.js';

/** Wraps file bytes in the MCP content type that fits the media kind. */
function toContentBlock(messageId: string, info: MediaInfo, data: Buffer): ContentBlock {
    const mimeType = info.mimeType?.split(';')[0].trim() || 'application/octet-stream';
    const base64 = data.toString('base64');
    if (info.kind === 'image' || info.kind === 'sticker') return { type: 'image', data: base64, mimeType };
    if (info.kind === 'audio' || info.kind === 'voice') return { type: 'audio', data: base64, mimeType };
    return { type: 'resource', resource: { uri: `whatsapp://media/${messageId}`, mimeType, blob: base64 } };
}

export const mediaToolset: Toolset = {
    name: 'media',
    description: 'Download attachments and send photos, videos, audio, voice notes and documents.',
    register(ctx) {
        const { media, messaging } = ctx.services;

        registerGuardedTool(
            ctx,
            'get_media',
            {
                title: 'Get media',
                description:
                    'Download the file attached to a message (photo, sticker, video, voice note, audio, document). ' +
                    'Images are returned as images you can see, audio as audio, other files as an embedded file.',
                inputSchema: { message_id: args.messageId('Message id whose media to fetch (messages with a "media" field)') },
                annotations: { readOnlyHint: true },
            },
            async ({ message_id }) => {
                const { message, info, data } = await media.fetch(message_id);
                return new WithAttachments({ messageId: message.uuid, media: { ...info, size: data.length } }, [
                    toContentBlock(message.uuid, info, data),
                ]);
            },
        );

        registerGuardedTool(
            ctx,
            'send_media',
            {
                title: 'Send media',
                description:
                    'Send a photo, video, audio/voice note or document. "to" is a chat id, exact name, or phone number with country code. ' +
                    "Provide the file as data_base64, or as file_path inside the server's media send directory. JPEG/PNG/WebP are sent as photos, " +
                    'MP4 as video, audio as audio (voice_note=true for a voice note; OGG/Opus), anything else as a document. Optional caption and reply_to (quote).',
                inputSchema: {
                    to: args.sendTarget(),
                    data_base64: z.string().optional().describe('File contents, base64 (a data: URL prefix is fine)'),
                    file_path: z.string().max(500).optional().describe('Path relative to the media send directory (if enabled)'),
                    mime_type: z
                        .string()
                        .max(100)
                        .optional()
                        .describe('e.g. image/jpeg, application/pdf; guessed from file_name if omitted'),
                    file_name: z.string().max(200).optional().describe('Name shown for documents'),
                    caption: z.string().max(1024).optional(),
                    voice_note: z.boolean().default(false),
                    reply_to: z.string().uuid().optional().describe('Message id to quote'),
                },
                annotations: { openWorldHint: true },
            },
            async ({ to, data_base64, file_path, mime_type, file_name, caption, voice_note, reply_to }) => {
                const upload = media.readUpload({ dataBase64: data_base64, filePath: file_path, mimeType: mime_type, fileName: file_name });
                const result = await messaging.sendMedia({ to, upload, caption, voiceNote: voice_note, replyTo: reply_to });
                return {
                    ...ctx.present.sent(result),
                    media: {
                        kind: result.kind,
                        mimeType: upload.mimeType,
                        size: upload.data.length,
                        ...(upload.fileName ? { fileName: upload.fileName } : {}),
                    },
                };
            },
        );
    },
};
