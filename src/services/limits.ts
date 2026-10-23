/**
 * @module services/limits
 *
 * The anti-ban safety limits, built from the generic {@link RateLimiter}:
 *  - outgoing messages/reactions: SEND_MAX_PER_HOUR, at least SEND_MIN_INTERVAL_MS apart;
 *  - new conversations (people never messaged before): NEW_CHAT_MAX_PER_DAY.
 *
 * Unsolicited or high-volume messaging is the main reason WhatsApp bans numbers.
 */
import { RateLimiter } from '../core/limits/rate-limiter.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface SendLimitOptions {
    minIntervalMs: number;
    maxPerHour: number;
    now?: () => number;
}

/** Limits all outgoing messages and reactions. */
export function createSendLimiter({ minIntervalMs, maxPerHour, now }: SendLimitOptions): RateLimiter {
    return new RateLimiter({
        max: maxPerHour,
        windowMs: HOUR_MS,
        minIntervalMs,
        now,
        limitMessage: `Hourly send limit (${maxPerHour}) reached; try again later.`,
        tooFastMessage: (wait) => `Sending too fast; wait ${wait}s and try again.`,
    });
}

/** Limits how many conversations with new people can be started per 24 hours. */
export function createNewChatLimiter(maxPerDay: number, now?: () => number): RateLimiter {
    return new RateLimiter({
        max: maxPerDay,
        windowMs: DAY_MS,
        now,
        limitMessage:
            `Daily limit for starting new chats (${maxPerDay}) reached. Messaging people who haven't chatted with you before ` +
            'is the main reason WhatsApp bans numbers; try again tomorrow.',
    });
}
