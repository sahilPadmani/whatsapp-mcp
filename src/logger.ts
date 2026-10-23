/**
 * @module logger
 *
 * Structured JSON logging (pino).
 * Rule: never log message text, names, phone numbers, JIDs or keys. Log ids, counts and
 * error objects instead. `redact` below is only a safety net for common field names.
 */
import pino, { type Logger } from 'pino';

export type { Logger };

/**
 * Structured JSON logger. Callers must never log message text, names, phone
 * numbers or JIDs; `redact` is a last line of defence for common field names.
 */
export function createLogger(level: string): Logger {
    return pino({
        level,
        base: undefined,
        redact: {
            paths: [
                'text',
                'jid',
                'phone',
                'name',
                '*.text',
                '*.jid',
                '*.phone',
                '*.name',
                'req.headers.authorization',
                'req.headers.cookie',
            ],
            censor: '[redacted]',
        },
    });
}
