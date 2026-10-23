/**
 * @module mcp/toolsets/sending
 *
 * Toolset "sending": `send_message`, `reply_to_message`.
 */
import { z } from 'zod';
import { registerGuardedTool } from '../guarded-tool.js';
import { args, type Toolset } from './types.js';

export const sendingToolset: Toolset = {
    name: 'sending',
    description: 'Send text messages and quoted replies.',
    register(ctx) {
        const { messaging } = ctx.services;

        registerGuardedTool(
            ctx,
            'send_message',
            {
                title: 'Send message',
                description:
                    'Send a text message. "to" is a chat id, an exact contact/group name, or a phone number with country code ' +
                    '(the number does not need to be a saved contact, but must be on WhatsApp). Optionally quote a message with reply_to. ' +
                    'Shows "typing…" first. Rate limited; starting new chats has a daily limit.',
                inputSchema: {
                    to: args.sendTarget(),
                    text: args.messageText(),
                    reply_to: z.string().uuid().optional().describe('Message id to quote'),
                },
                annotations: { openWorldHint: true },
            },
            async ({ to, text, reply_to }) => ctx.present.sent(await messaging.sendText({ to, text, replyTo: reply_to })),
        );

        registerGuardedTool(
            ctx,
            'reply_to_message',
            {
                title: 'Reply to message',
                description: 'Reply to a specific message (quoted reply) in the chat it came from. Shows "typing…" first. Rate limited.',
                inputSchema: {
                    message_id: args.messageId('Message id from get_new_messages/get_messages'),
                    text: args.messageText(),
                },
                annotations: { openWorldHint: true },
            },
            async ({ message_id, text }) => ctx.present.sent(await messaging.reply({ messageId: message_id, text })),
        );
    },
};
