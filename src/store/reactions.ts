/**
 * @module store/reactions
 *
 * Repository for emoji reactions. WhatsApp semantics: one reaction per person per
 * message; reacting again replaces it, an empty emoji removes it. Emojis are stored
 * encrypted. Rows reference messages and people only by UUID.
 */
import type { Cipher } from '../core/crypto/cipher.js';
import type { Database } from '../core/db/database.js';

/** One person's reaction to one message. */
export interface Reaction {
    reactorUuid: string;
    emoji: string;
    fromMe: boolean;
    ts: number;
}

interface ReactionRow {
    message_uuid: string;
    reactor_uuid: string;
    emoji_enc: string;
    from_me: number;
    ts: number;
}

const AAD = 'reactions.emoji';

export class ReactionStore {
    constructor(
        private readonly db: Database,
        private readonly cipher: Cipher,
    ) {}

    /**
     * Sets (or, with an empty emoji, removes) one person's reaction to a message.
     * Events older than what is stored are ignored (history sync can deliver them late).
     * @returns true if anything changed
     */
    set(messageUuid: string, reactorUuid: string, emoji: string, fromMe: boolean, ts: number): boolean {
        const current = this.db.get<{ ts: number }>(
            'SELECT ts FROM reactions WHERE message_uuid = ? AND reactor_uuid = ?',
            messageUuid,
            reactorUuid,
        );
        if (current && current.ts > ts) return false;
        if (!emoji) {
            return this.db.run('DELETE FROM reactions WHERE message_uuid = ? AND reactor_uuid = ?', messageUuid, reactorUuid).changes > 0;
        }
        this.db.run(
            `INSERT INTO reactions (message_uuid, reactor_uuid, emoji_enc, from_me, ts) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (message_uuid, reactor_uuid) DO UPDATE SET emoji_enc = excluded.emoji_enc, ts = excluded.ts`,
            messageUuid,
            reactorUuid,
            this.cipher.encrypt(emoji, AAD),
            fromMe,
            ts,
        );
        return true;
    }

    /** Reactions for a set of messages (one query), keyed by message UUID, oldest first. */
    forMessages(messageUuids: string[]): Map<string, Reaction[]> {
        const result = new Map<string, Reaction[]>();
        if (!messageUuids.length) return result;
        const rows = this.db.all<ReactionRow>(
            `SELECT * FROM reactions WHERE message_uuid IN (${messageUuids.map(() => '?').join(',')}) ORDER BY ts`,
            ...messageUuids,
        );
        for (const r of rows) {
            const list = result.get(r.message_uuid) ?? [];
            list.push({ reactorUuid: r.reactor_uuid, emoji: this.cipher.decrypt(r.emoji_enc, AAD), fromMe: Boolean(r.from_me), ts: r.ts });
            result.set(r.message_uuid, list);
        }
        return result;
    }

    /** Deletes all reactions (logout). */
    clear() {
        this.db.exec('DELETE FROM reactions;');
    }
}
