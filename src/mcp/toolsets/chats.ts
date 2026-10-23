/**
 * @module mcp/toolsets/chats
 *
 * Toolset "chats": `list_chats`, `search_contacts` (read-only).
 */
import { z } from 'zod';
import { registerGuardedTool } from '../guarded-tool.js';
import type { Toolset } from './types.js';

export const chatsToolset: Toolset = {
    name: 'chats',
    description: 'Browse chats and find contacts by name.',
    register(ctx) {
        const { chats } = ctx.services;

        registerGuardedTool(
            ctx,
            'list_chats',
            {
                title: 'List chats',
                description: 'List chats (people and groups), most recent first, with unread count and last message preview.',
                inputSchema: {
                    limit: z.number().int().min(1).max(100).default(20),
                    query: z.string().max(100).optional().describe('Filter by chat or contact name'),
                    unread_only: z.boolean().default(false),
                },
                annotations: { readOnlyHint: true },
            },
            ({ limit, query, unread_only }) => chats.list({ limit, query, unreadOnly: unread_only }).map((p) => ctx.present.chat(p)),
        );

        registerGuardedTool(
            ctx,
            'search_contacts',
            {
                title: 'Search contacts',
                description: 'Find contacts or groups by name. Returns the chat id to use with the other tools.',
                inputSchema: {
                    query: z.string().min(1).max(100).describe('Part of a contact or group name'),
                    limit: z.number().int().min(1).max(50).default(10),
                },
                annotations: { readOnlyHint: true },
            },
            ({ query, limit }) => chats.search(query, limit).map((p) => ctx.present.contact(p)),
        );
    },
};
