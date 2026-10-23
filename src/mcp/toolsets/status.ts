/**
 * @module mcp/toolsets/status
 *
 * Toolset "status": `whatsapp_status`.
 */
import { registerGuardedTool } from '../guarded-tool.js';
import type { Toolset } from './types.js';

export const statusToolset: Toolset = {
    name: 'status',
    description: 'Connection state and stored-data counts.',
    register(ctx) {
        registerGuardedTool(
            ctx,
            'whatsapp_status',
            {
                title: 'WhatsApp status',
                description: 'Check whether WhatsApp is connected and how much data is stored. me.id is the id of your own chat.',
                annotations: { readOnlyHint: true },
            },
            () => {
                const status = ctx.services.status.snapshot();
                return status.connected ? status : { ...status, hint: ctx.loginHint };
            },
        );
    },
};
