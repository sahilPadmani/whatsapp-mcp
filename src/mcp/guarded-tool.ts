/**
 * @module mcp/guarded-tool
 *
 * The one way tools are registered. {@link registerGuardedTool} wraps a handler so that:
 *  - its return value is serialized as JSON text **after** passing the privacy guard;
 *  - binary attachments (images, audio, files) can be added with {@link WithAttachments};
 *  - errors become MCP tool errors: an `AppError` shows its (safe) message,
 *    `NotConnectedError` shows the login hint, anything else shows "Internal error"
 *    and is logged.
 *
 * Handlers therefore just return plain data or throw; they never build MCP results.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ContentBlock, ServerNotification, ServerRequest, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { AppError, NotConnectedError } from '../core/errors.js';
import type { Logger } from '../logger.js';
import type { PrivacyGuard } from '../privacy/guard.js';

/** Request context the SDK passes to handlers (cancellation `signal`, session id, ...). */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** What every tool registration needs. */
export interface GuardedToolContext {
    server: McpServer;
    guard: PrivacyGuard;
    logger: Logger;
    /** Shown instead of the error when WhatsApp isn't connected. */
    loginHint: string;
}

export interface GuardedToolConfig<Shape extends ZodRawShapeCompat> {
    title: string;
    /** Written for the agent: when to use the tool and what it returns. */
    description: string;
    /** zod schema for the arguments (omit for tools without arguments). */
    inputSchema?: Shape;
    annotations?: ToolAnnotations;
}

/**
 * A result with binary content (image/audio/file). `data` is guarded like any result;
 * the attachments are message content (the file itself) and are passed through as-is.
 */
export class WithAttachments {
    constructor(
        readonly data: unknown,
        readonly attachments: ContentBlock[],
    ) {}
}

/** Registers `name` on the server with privacy-guarded output and uniform error handling. */
export function registerGuardedTool<Shape extends ZodRawShapeCompat>(
    ctx: GuardedToolContext,
    name: string,
    config: GuardedToolConfig<Shape>,
    handler: (args: ShapeOutput<Shape>, extra: ToolExtra) => Promise<unknown> | unknown,
) {
    const run = async (args: ShapeOutput<Shape>, extra: ToolExtra): Promise<CallToolResult> => {
        try {
            const result = await handler(args, extra);
            const data = result instanceof WithAttachments ? result.data : result;
            const { value } = ctx.guard.sanitize(data, `tool:${name}`);
            const attachments = result instanceof WithAttachments ? result.attachments : [];
            return { content: [{ type: 'text', text: JSON.stringify(value, null, 1) }, ...attachments] };
        } catch (err) {
            return errorResult(ctx, name, err);
        }
    };
    ctx.server.registerTool(name, { ...config, inputSchema: config.inputSchema ?? ({} as Shape) }, run as never);
}

function errorResult(ctx: GuardedToolContext, tool: string, err: unknown): CallToolResult {
    let message: string;
    if (err instanceof NotConnectedError) message = ctx.loginHint;
    else if (err instanceof AppError) message = err.message;
    else {
        ctx.logger.error({ err, tool }, 'tool failed');
        message = 'Internal error while running the tool.';
    }
    // Even error text goes through the guard (it may echo caller input).
    const { value } = ctx.guard.sanitize({ error: message }, `tool:${tool}:error`);
    return { isError: true, content: [{ type: 'text', text: value.error }] };
}
