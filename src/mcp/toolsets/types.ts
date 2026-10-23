/**
 * @module mcp/toolsets/types
 *
 * Shared types and argument schemas for toolsets.
 *
 * A **toolset** is a named group of related tools (pattern from github/github-mcp-server).
 * Toolsets can be switched on or off with the `TOOLSETS` setting, so a deployment can
 * e.g. expose read-only tools only.
 *
 * Tool handlers must stay thin: validate arguments (zod), call one service method,
 * return a presenter shape. No business logic, SQL or Baileys calls here.
 */
import { z } from 'zod';
import type { Services } from '../../services/index.js';
import type { GuardedToolContext } from '../guarded-tool.js';
import type { Presenter } from '../presenters.js';

/** Everything a toolset needs to register its tools. */
export interface ToolContext extends GuardedToolContext {
    services: Services;
    present: Presenter;
}

export interface Toolset {
    /** Used in the TOOLSETS setting. */
    name: string;
    description: string;
    register(ctx: ToolContext): void;
}

/** Argument schemas reused by several tools. */
export const args = {
    /** A chat for read tools: UUID or exact name. */
    chat: () => z.string().min(1).max(200).describe('Chat id from list_chats/search_contacts, or an exact contact/group name'),
    /** A send target: UUID, exact name, or phone number with country code. */
    sendTarget: () => z.string().min(1).max(200).describe('Chat id, exact contact/group name, or a phone number with country code'),
    messageId: (description = 'Message id from get_messages/get_new_messages') => z.string().uuid().describe(description),
    messageText: () => z.string().min(1).max(4096),
};
