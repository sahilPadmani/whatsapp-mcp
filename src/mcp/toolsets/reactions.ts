/**
 * @module mcp/toolsets/reactions
 *
 * Toolset "reactions": `react_to_message`.
 */
import { z } from 'zod';
import { registerGuardedTool } from '../guarded-tool.js';
import { args, type Toolset } from './types.js';

export const reactionsToolset: Toolset = {
    name: 'reactions',
    description: 'React to messages with emoji.',
    register(ctx) {
        registerGuardedTool(
            ctx,
            'react_to_message',
            {
                title: 'React to message',
                description:
                    'React to a message with one emoji (e.g. 👍 ❤️ 😂). Pass an empty emoji to remove your reaction. Rate limited.',
                inputSchema: {
                    message_id: args.messageId(),
                    emoji: z.string().max(32).describe('A single emoji, or "" to remove your reaction'),
                },
                annotations: { openWorldHint: true, idempotentHint: true },
            },
            async ({ message_id, emoji }) => {
                const result = await ctx.services.messaging.react({ messageId: message_id, emoji });
                return {
                    messageId: result.message.uuid,
                    chat: ctx.present.ref(result.peer),
                    ...(result.emoji ? { reacted: result.emoji } : { removed: true }),
                };
            },
        );
    },
};
