/**
 * @module privacy/guard
 *
 * The last line of defence for "only the server knows phone numbers".
 *
 * Every payload leaving the server (tool results and errors, notifications, the inbox
 * resource, webhook bodies) passes through {@link PrivacyGuard.sanitize}. It replaces any
 * value that contains a WhatsApp ID, a phone-number-shaped string, or a number the server
 * knows belongs to someone, except in message-content fields (`text`, `caption`, …),
 * which are what people actually wrote. It fails closed and logs only field paths.
 */
import type { Logger } from '../logger.js';

/** Message content (incl. media captions/file names): may contain numbers people typed, so it is not inspected. */
export const CONTENT_FIELDS = new Set(['text', 'preview', 'lastMessage', 'caption', 'fileName']);
/** Fields holding a display name get a friendly replacement instead of "[redacted]". */
const NAME_FIELDS = new Set(['name', 'chatName', 'senderName', 'from']);

const REDACTED = '[redacted]';
const UNKNOWN_NAME = 'Unknown contact';
/** UUIDs and ISO timestamps are removed before scanning so their digits never look like phone numbers. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIME_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g;
const JID_RE = /@(s\.whatsapp\.net|c\.us|lid|g\.us|broadcast|newsletter)\b/i;
/** A run of digits with typical phone separators, e.g. "+91 98765-43210". */
const PHONE_RUN_RE = /\+?\d[\d\s().-]*\d/g;

export type IdentifierKind = 'jid' | 'phone';

export interface GuardResult<T> {
    value: T;
    redactions: string[];
}

/**
 * Egress middleware: every payload leaving the server (MCP tool results,
 * notifications, webhooks) passes through `sanitize`. Any non-content field
 * containing a JID, something shaped like a phone number, or a number the
 * server knows belongs to a contact is replaced (fail closed).
 */
export class PrivacyGuard {
    constructor(
        private readonly knownPhones: () => Set<string>,
        private readonly logger?: Logger,
    ) {}

    /** Classifies a string as containing a JID or phone number (null if clean). */
    detect(value: string, known: Set<string> = this.knownPhones()): IdentifierKind | null {
        const scrubbed = value.replace(UUID_RE, ' ').replace(ISO_TIME_RE, ' ');
        if (JID_RE.test(scrubbed)) return 'jid';
        for (const run of scrubbed.match(PHONE_RUN_RE) ?? []) {
            const digits = run.replace(/\D/g, '');
            if (digits.length < 7) continue;
            if (digits.length <= 15) return 'phone';
            // Longer digit strings: still catch a known number embedded inside.
            for (const phone of known) if (digits.includes(phone)) return 'phone';
        }
        return null;
    }

    /** Exact number, or its local form without country code ("9876543210" for "919876543210"). */
    private matchesKnown(digits: string, known: Set<string>): boolean {
        if (known.has(digits)) return true;
        for (const phone of known) if (phone.endsWith(digits)) return true;
        return false;
    }

    sanitize<T>(payload: T, context = 'payload'): GuardResult<T> {
        const known = this.knownPhones();
        const redactions: string[] = [];

        const visit = (value: unknown, path: string, key: string | null): unknown => {
            if (key && CONTENT_FIELDS.has(key)) return value;
            if (typeof value === 'string') {
                if (!this.detect(value, known)) return value;
                redactions.push(path);
                return key && NAME_FIELDS.has(key) ? UNKNOWN_NAME : REDACTED;
            }
            if (typeof value === 'number' || typeof value === 'bigint') {
                const digits = String(value);
                if (/^\d{7,15}$/.test(digits) && this.matchesKnown(digits, known)) {
                    redactions.push(path);
                    return REDACTED;
                }
                return value;
            }
            if (Array.isArray(value)) return value.map((item, i) => visit(item, `${path}[${i}]`, key));
            if (value && typeof value === 'object') {
                const out: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(value)) {
                    if (this.detect(k, known)) {
                        redactions.push(`${path}.<key>`);
                        continue;
                    }
                    out[k] = visit(v, `${path}.${k}`, k);
                }
                return out;
            }
            return value;
        };

        const value = visit(payload, context, null) as T;
        if (redactions.length) this.logger?.warn({ context, paths: redactions }, 'privacy guard redacted identifiers');
        return { value, redactions };
    }
}
