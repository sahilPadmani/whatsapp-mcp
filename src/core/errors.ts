/**
 * @module core/errors
 *
 * Error types shared by every layer.
 *
 * The rule that keeps error messages safe: the message of an {@link AppError} may be
 * shown to an MCP client as-is, so it must never contain secrets, phone numbers or
 * WhatsApp IDs. Any other thrown error is treated as an internal bug and reported to
 * clients only as "Internal error" (details go to the server log).
 */

/** Invalid or missing configuration; stops the server at start-up. */
export class ConfigError extends Error {
    override name = 'ConfigError';
}

/** Base class for expected failures whose message is safe to show to callers. */
export class AppError extends Error {
    override name = 'AppError';
}

/** The caller's input is invalid, ambiguous, or refers to something that doesn't exist. */
export class UserError extends AppError {
    override name = 'UserError';
}

/** A safety limit (send rate, new chats per day, ...) was reached. */
export class RateLimitError extends AppError {
    override name = 'RateLimitError';
}

/** WhatsApp isn't logged in / connected right now. MCP replaces the message with a login hint. */
export class NotConnectedError extends AppError {
    override name = 'NotConnectedError';
    constructor() {
        super('WhatsApp is not connected');
    }
}
