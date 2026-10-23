/**
 * @module store/outbox
 *
 * Encrypted queue of webhook deliveries; survives restarts. See {@link Outbox}.
 */
import type { Cipher } from '../core/crypto/cipher.js';
import type { Database } from '../core/db/database.js';

export interface OutboxItem {
    id: number;
    eventId: string;
    body: string;
    attempts: number;
}

const aad = (eventId: string) => `webhook_outbox.payload:${eventId}`;

/** Durable, encrypted queue of webhook deliveries; survives restarts. */
export class Outbox {
    constructor(
        private readonly db: Database,
        private readonly cipher: Cipher,
    ) {}

    enqueue(eventId: string, body: string, now = Date.now()) {
        this.db.run(
            'INSERT OR IGNORE INTO webhook_outbox (event_id, payload_enc, next_attempt_at) VALUES (?, ?, ?)',
            eventId,
            this.cipher.encrypt(body, aad(eventId)),
            now,
        );
    }

    due(limit: number, now = Date.now()): OutboxItem[] {
        return this.db
            .all<{ id: number; event_id: string; payload_enc: string; attempts: number }>(
                'SELECT * FROM webhook_outbox WHERE next_attempt_at <= ? ORDER BY id LIMIT ?',
                now,
                limit,
            )
            .map((r) => ({
                id: r.id,
                eventId: r.event_id,
                body: this.cipher.decrypt(r.payload_enc, aad(r.event_id)),
                attempts: r.attempts,
            }));
    }

    delivered(id: number) {
        this.db.run('DELETE FROM webhook_outbox WHERE id = ?', id);
    }

    retryLater(id: number, attempts: number, nextAttemptAt: number) {
        this.db.run('UPDATE webhook_outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?', attempts, nextAttemptAt, id);
    }

    size(): number {
        return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM webhook_outbox')?.n ?? 0;
    }

    clear() {
        this.db.exec('DELETE FROM webhook_outbox;');
    }
}
