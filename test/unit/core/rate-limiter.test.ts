import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RateLimitError } from '../../../src/core/errors.js';
import { RateLimiter } from '../../../src/core/limits/rate-limiter.js';
import { createNewChatLimiter, createSendLimiter } from '../../../src/services/limits.js';

describe('RateLimiter', () => {
    it('enforces the window maximum and frees slots as they age out', () => {
        let now = 0;
        const limiter = new RateLimiter({ max: 2, windowMs: 1000, limitMessage: 'full', now: () => now });
        limiter.check();
        limiter.record();
        limiter.record();
        assert.throws(
            () => limiter.check(),
            (e: Error) => e instanceof RateLimitError && e.message === 'full',
        );
        assert.equal(limiter.used(), 2);
        now = 1001;
        limiter.check();
        assert.equal(limiter.used(), 0);
    });

    it('enforces the minimum interval with a wait hint', () => {
        let now = 0;
        const limiter = new RateLimiter({ max: 10, windowMs: 10_000, minIntervalMs: 3000, limitMessage: 'x', now: () => now });
        limiter.record();
        now = 1000;
        assert.throws(() => limiter.check(), /wait 2s/);
        now = 3000;
        limiter.check();
    });
});

describe('send / new-chat limits', () => {
    it('send limiter: minimum gap and hourly cap', () => {
        let now = 0;
        const limiter = createSendLimiter({ minIntervalMs: 3000, maxPerHour: 2, now: () => now });
        limiter.check();
        limiter.record();
        now = 1000;
        assert.throws(() => limiter.check(), /Sending too fast/);
        now = 4000;
        limiter.check();
        limiter.record();
        now = 10_000;
        assert.throws(() => limiter.check(), /Hourly send limit \(2\)/);
        now = 3_700_000;
        limiter.check();
    });

    it('new-chat limiter: daily cap with an explanation', () => {
        let now = 0;
        const limiter = createNewChatLimiter(1, () => now);
        limiter.record();
        assert.throws(() => limiter.check(), /Daily limit for starting new chats \(1\).*ban/);
        now = 86_400_001;
        limiter.check();
    });
});
