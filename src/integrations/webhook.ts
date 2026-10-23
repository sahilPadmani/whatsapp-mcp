/**
 * @module integrations/webhook
 *
 * Outbound webhooks for other services (`WEBHOOK_URL`). Each `message.received` /
 * `reaction.received` event is:
 *  1. privacy-guarded (UUIDs only, never phone numbers),
 *  2. written to the encrypted outbox (so nothing is lost if the server restarts),
 *  3. POSTed with an HMAC-SHA256 signature over "<timestamp>.<body>",
 *  4. retried with exponential backoff until delivered or WEBHOOK_MAX_ATTEMPTS is reached.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { Logger } from '../logger.js';
import type { PrivacyGuard } from '../privacy/guard.js';
import type { Outbox, OutboxItem } from '../store/outbox.js';
import type { EventBus, IncomingMessageEvent, ReactionEvent } from '../events.js';

export interface WebhookOptions {
    url: string;
    secret: string;
    maxAttempts: number;
    /** Delay before retry number `attempt` (1-based). */
    backoffMs?: (attempt: number) => number;
    pollIntervalMs?: number;
    timeoutMs?: number;
}

const defaultBackoff = (attempt: number) => Math.min(15 * 60_000, 5_000 * 2 ** (attempt - 1)) * (0.8 + Math.random() * 0.4);

/** `sha256=<hex HMAC of "<timestamp>.<body>">`, so receivers can verify origin and reject replays. */
export function signWebhook(secret: string, timestamp: string, body: string): string {
    return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/**
 * Delivers `message.received` events to WEBHOOK_URL. Events are written to the
 * encrypted outbox first (at-least-once delivery across restarts), signed with
 * HMAC-SHA256 and retried with exponential backoff.
 */
export class WebhookDispatcher {
    private timer?: NodeJS.Timeout;
    private running = false;
    private readonly onMessage = (event: IncomingMessageEvent) => this.enqueue('message.received', event);
    private readonly onReaction = (event: ReactionEvent) => this.enqueue('reaction.received', event);

    constructor(
        private readonly opts: WebhookOptions,
        private readonly outbox: Outbox,
        private readonly bus: EventBus,
        private readonly guard: PrivacyGuard,
        private readonly logger: Logger,
    ) {}

    start() {
        this.bus.on('message.received', this.onMessage);
        this.bus.on('reaction.received', this.onReaction);
        this.timer = setInterval(() => void this.flush(), this.opts.pollIntervalMs ?? 2000);
        void this.flush();
    }

    stop() {
        this.bus.off('message.received', this.onMessage);
        this.bus.off('reaction.received', this.onReaction);
        clearInterval(this.timer);
    }

    enqueue(type: string, data: unknown) {
        const id = randomUUID();
        const { value } = this.guard.sanitize({ id, type, createdAt: new Date().toISOString(), data }, 'webhook');
        this.outbox.enqueue(id, JSON.stringify(value));
        void this.flush();
    }

    /** Sends every due item once; safe to call concurrently. */
    async flush() {
        if (this.running) return;
        this.running = true;
        try {
            for (const item of this.outbox.due(50)) await this.deliver(item);
        } finally {
            this.running = false;
        }
    }

    private async deliver(item: OutboxItem) {
        const timestamp = String(Math.floor(Date.now() / 1000));
        let error: string | undefined;
        try {
            const res = await fetch(this.opts.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'whatsapp-mcp-webhook/1',
                    'X-Webhook-Id': item.eventId,
                    'X-Webhook-Timestamp': timestamp,
                    'X-Webhook-Signature': signWebhook(this.opts.secret, timestamp, item.body),
                },
                body: item.body,
                signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
            });
            if (res.ok) {
                this.outbox.delivered(item.id);
                return;
            }
            error = `HTTP ${res.status}`;
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        }

        const attempts = item.attempts + 1;
        if (attempts >= this.opts.maxAttempts) {
            this.logger.error({ eventId: item.eventId, attempts, error }, 'webhook delivery failed permanently; dropping event');
            this.outbox.delivered(item.id);
            return;
        }
        const delay = (this.opts.backoffMs ?? defaultBackoff)(attempts);
        this.logger.warn({ eventId: item.eventId, attempts, error, retryInMs: Math.round(delay) }, 'webhook delivery failed; will retry');
        this.outbox.retryLater(item.id, attempts, Date.now() + delay);
    }
}
