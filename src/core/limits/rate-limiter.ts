/**
 * @module core/limits/rate-limiter
 *
 * A small in-memory sliding-window rate limiter with an optional minimum gap between
 * events. Used for "max N messages per hour, at least 3 s apart" and "max N new chats
 * per day". Generic: the caller supplies the limits and the error messages.
 */
import { RateLimitError } from '../errors.js';

export interface RateLimiterOptions {
    /** Maximum number of events inside the window. */
    max: number;
    /** Window length in milliseconds (e.g. 1 hour, 1 day). */
    windowMs: number;
    /** Minimum time between two events (0 = no minimum). */
    minIntervalMs?: number;
    /** Error message when `max` is reached. */
    limitMessage: string;
    /** Error message when events come faster than `minIntervalMs`; receives the seconds to wait. */
    tooFastMessage?: (waitSeconds: number) => string;
    /** Clock, injectable for tests. */
    now?: () => number;
}

/**
 * Call {@link check} before an action and {@link record} once it is committed.
 * (Recording before a slow action, e.g. a typing delay, prevents concurrent callers
 * from slipping past the limit.)
 */
export class RateLimiter {
    private events: number[] = [];
    private readonly now: () => number;

    constructor(private readonly options: RateLimiterOptions) {
        this.now = options.now ?? Date.now;
    }

    private prune(now: number) {
        this.events = this.events.filter((t) => now - t < this.options.windowMs);
    }

    /** @throws {RateLimitError} if the action is not allowed right now. */
    check(): void {
        const now = this.now();
        this.prune(now);
        const last = this.events.at(-1);
        const minInterval = this.options.minIntervalMs ?? 0;
        if (last !== undefined && now - last < minInterval) {
            const wait = Math.ceil((minInterval - (now - last)) / 1000);
            throw new RateLimitError(this.options.tooFastMessage?.(wait) ?? `Too fast; wait ${wait}s and try again.`);
        }
        if (this.events.length >= this.options.max) throw new RateLimitError(this.options.limitMessage);
    }

    /** Counts one event now. */
    record(): void {
        this.events.push(this.now());
    }

    /** Number of events inside the current window. */
    used(): number {
        this.prune(this.now());
        return this.events.length;
    }
}
