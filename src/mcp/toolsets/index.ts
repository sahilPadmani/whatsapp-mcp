/**
 * @module mcp/toolsets
 *
 * The toolset registry. To add a tool:
 *  1. put the logic in a service (`src/services/`),
 *  2. add the tool to the toolset it belongs to (or create a new toolset file and list it in
 *     {@link TOOLSETS}),
 *  3. add an integration test in `test/integration/mcp/`.
 * See CONTRIBUTING.md for the full checklist.
 */
import { ConfigError } from '../../core/errors.js';
import { chatsToolset } from './chats.js';
import { mediaToolset } from './media.js';
import { messagesToolset } from './messages.js';
import { reactionsToolset } from './reactions.js';
import { sendingToolset } from './sending.js';
import { statusToolset } from './status.js';
import type { ToolContext, Toolset } from './types.js';

/** All toolsets, in the order their tools are listed. */
export const TOOLSETS: readonly Toolset[] = [statusToolset, chatsToolset, messagesToolset, sendingToolset, mediaToolset, reactionsToolset];

/**
 * Turns the TOOLSETS setting into toolsets. `all` (or an empty list) enables every toolset.
 * @throws {ConfigError} for unknown names, listing the valid ones
 */
export function resolveToolsets(names: readonly string[]): Toolset[] {
    if (names.length === 0 || names.includes('all')) return [...TOOLSETS];
    const unknown = names.filter((n) => !TOOLSETS.some((t) => t.name === n));
    if (unknown.length) {
        throw new ConfigError(`Unknown TOOLSETS: ${unknown.join(', ')}. Valid: all, ${TOOLSETS.map((t) => t.name).join(', ')}`);
    }
    return TOOLSETS.filter((t) => names.includes(t.name));
}

/** Registers the tools of the given toolsets on `ctx.server`. */
export function registerToolsets(ctx: ToolContext, toolsets: readonly Toolset[]) {
    for (const toolset of toolsets) toolset.register(ctx);
}

export type { ToolContext, Toolset };
