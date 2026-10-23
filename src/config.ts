/**
 * @module config
 *
 * All configuration comes from environment variables (usually `.env`). The schema
 * below is the single source of truth: types, defaults and validation. An invalid value
 * stops the server at start-up with a readable list of problems.
 *
 * To add a setting: add it here (with a default and a doc comment), document it in
 * `.env.example` and the README configuration table, then read it from `Config` in
 * `app.ts`.
 */
import { z } from 'zod';
import { ConfigError } from './core/errors.js';

export { ConfigError };

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const optionalString = z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined));

const logLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const schema = z
    .object({
        NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

        // ---- Server ----
        /** 0 picks a free port (used by tests). */
        PORT: z.coerce.number().int().min(0).max(65535).default(3000),
        HOST: z.string().min(1).default('127.0.0.1'),
        /** Base URL shown to users/agents; defaults to http://HOST:PORT. */
        PUBLIC_URL: optionalString.pipe(z.string().url().optional()),
        LOG_LEVEL: logLevel.default('info'),
        BAILEYS_LOG_LEVEL: logLevel.default('error'),

        // ---- Secrets (generated into .env on first run if missing) ----
        /** Bearer token MCP clients must send. */
        API_KEY: z.string().min(16, 'API_KEY must be at least 16 characters'),
        /** 32 random bytes, base64. Encrypts everything at rest. */
        ENCRYPTION_KEY: z.string().min(1, 'ENCRYPTION_KEY is required'),

        // ---- Storage ----
        DATA_DIR: z.string().min(1).default('./data'),

        // ---- Sending (anti-ban limits and human-like behaviour) ----
        SEND_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(3000),
        SEND_MAX_PER_HOUR: z.coerce.number().int().min(1).default(30),
        /** Let callers send to a phone number (write-only: numbers are still never returned). */
        ALLOW_SEND_TO_PHONE: bool.default(true),
        /** Max new conversations (people never messaged before) per 24h; unsolicited messages get numbers banned. */
        NEW_CHAT_MAX_PER_DAY: z.coerce.number().int().min(0).default(10),
        /** Show "typing…" before sending, for a time proportional to the text. */
        HUMANIZE_REPLIES: bool.default(true),
        TYPING_MS_PER_CHAR: z.coerce.number().int().min(0).default(40),
        TYPING_MIN_MS: z.coerce.number().int().min(0).default(1000),
        TYPING_MAX_MS: z.coerce.number().int().min(0).default(8000),

        // ---- Media ----
        /** Largest media file the server will download, send or return to an agent. */
        MEDIA_MAX_BYTES: z.coerce
            .number()
            .int()
            .min(1024)
            .default(16 * 1024 * 1024),
        /** Optional directory agents may send files from via send_media(file_path). Unset = base64 only. */
        MEDIA_SEND_DIR: optionalString,

        // ---- Webhook (optional) ----
        WEBHOOK_URL: optionalString.pipe(z.string().url().optional()),
        WEBHOOK_SECRET: optionalString,
        WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),

        // ---- MCP ----
        MCP_SESSION_IDLE_MS: z.coerce
            .number()
            .int()
            .min(10_000)
            .default(30 * 60_000),
        /** Comma-separated toolsets to expose (see src/mcp/toolsets), or "all". */
        TOOLSETS: z
            .string()
            .default('all')
            .transform((v) =>
                v
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
            ),
    })
    .refine((c) => !c.WEBHOOK_URL || (c.WEBHOOK_SECRET && c.WEBHOOK_SECRET.length >= 16), {
        message: 'WEBHOOK_SECRET (at least 16 characters) is required when WEBHOOK_URL is set',
        path: ['WEBHOOK_SECRET'],
    })
    .refine((c) => c.TYPING_MIN_MS <= c.TYPING_MAX_MS, {
        message: 'TYPING_MIN_MS must be <= TYPING_MAX_MS',
        path: ['TYPING_MIN_MS'],
    });

/** Validated configuration plus derived values. */
export type Config = z.infer<typeof schema> & {
    /** Base URL without trailing slash, e.g. "http://127.0.0.1:3000". */
    publicUrl: string;
};

/**
 * Parses and validates the environment.
 * @throws {ConfigError} listing every invalid or missing value
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const parsed = schema.safeParse(env);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new ConfigError(`Invalid configuration:\n${issues}`);
    }
    const c = parsed.data;
    const host = c.HOST === '0.0.0.0' || c.HOST === '::' ? 'localhost' : c.HOST;
    return { ...c, publicUrl: (c.PUBLIC_URL ?? `http://${host}:${c.PORT}`).replace(/\/$/, '') };
}
