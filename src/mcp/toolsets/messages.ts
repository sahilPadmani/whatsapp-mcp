/**
 * @module mcp/toolsets/messages
 *
 * Toolset "messages": `get_messages`, `get_new_messages`, `mark_as_read`.
 */
import { z } from 'zod';
import { MAX_WAIT_SECONDS } from '../../services/inbox.service.js';
import { registerGuardedTool } from '../guarded-tool.js';
import { args, type Toolset } from './types.js';

export const messagesToolset: Toolset = {
    name: 'messages',
    description: 'Read conversations, receive new messages, send read receipts.',
    register(ctx) {
        const { inbox } = ctx.services;

        registerGuardedTool(
            ctx,
            'get_messages',
            {
                title: 'Get messages',
                description: 'Read messages from one chat, oldest to newest. Page back with before_ts = the earliest returned ts.',
                inputSchema: {
                    chat: args.chat(),
                    limit: z.number().int().min(1).max(200).default(20),
                    before_ts: z.number().int().optional().describe('Only messages older than this unix timestamp (seconds)'),
                },
                annotations: { readOnlyHint: true },
            },
            ({ chat, limit, before_ts }) => {
                const { peer, messages } = inbox.history(chat, limit, before_ts);
                return {
                    chat: ctx.present.ref(peer),
                    messages: ctx.present.messageList(messages),
                    ...(messages.length === 0 ? { note: 'No stored messages for this chat yet.' } : {}),
                };
            },
        );

        registerGuardedTool(
            ctx,
            'get_new_messages',
            {
                title: 'Get new messages',
                description:
                    'Incoming messages across all chats. Without cursor: current unread messages. With cursor: messages received after it. ' +
                    'Always keep the returned next_cursor for the next call. wait_seconds > 0 waits for a new message if there is none yet.',
                inputSchema: {
                    cursor: z.number().int().min(0).optional().describe('next_cursor from the previous call'),
                    wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(0),
                    limit: z.number().int().min(1).max(200).default(50),
                },
                annotations: { readOnlyHint: true },
            },
            async ({ cursor, wait_seconds, limit }, extra) => {
                const result = await inbox.newMessages({ cursor, waitSeconds: wait_seconds, limit, signal: extra.signal });
                return { messages: ctx.present.messageList(result.messages, { includeChat: true }), next_cursor: result.nextCursor };
            },
        );

        registerGuardedTool(
            ctx,
            'mark_as_read',
            {
                title: 'Mark chat as read',
                description: 'Mark the unread messages in a chat as read (sends blue ticks).',
                inputSchema: { chat: args.chat() },
                annotations: { idempotentHint: true },
            },
            async ({ chat }) => {
                const { peer, marked } = await inbox.markRead(chat);
                return { chat: ctx.present.ref(peer), marked };
            },
        );
    },
};
