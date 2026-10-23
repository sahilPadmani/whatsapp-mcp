/**
 * @module store/messages
 *
 * Repository for messages (text, media metadata and the raw WhatsApp message).
 *
 * Storage rules:
 *  - `text`, `media` and `raw` are AES-256-GCM encrypted; the column name is the AAD.
 *  - WhatsApp's own message id is stored only as an HMAC (`wa_id_hash`) for de-duplication
 *    and reply/reaction lookups, so it can't be read back.
 *  - Every message gets a random UUID; that is the only id ever shown to callers.
 *  - `seq` is a global, monotonically increasing cursor used by `get_new_messages`.
 *  - `incoming` = "for the agent to handle": from someone else, or a note-to-self typed on
 *    your phone. Messages this server sent are never incoming (prevents reply loops).
 *
 * The raw message is kept (encrypted, protobuf-encoded) because quoting, reactions,
 * read receipts and media downloads all need the original WhatsApp key/payload.
 */
import { randomUUID } from 'node:crypto';
import { proto, type WAMessage } from 'baileys';
import type { Cipher } from '../core/crypto/cipher.js';
import type { Database } from '../core/db/database.js';
import type { MediaInfo } from '../whatsapp/parser.js';

/** A message as stored (decrypted). */
export interface StoredMessage {
    /** Global cursor position. */
    seq: number;
    uuid: string;
    peerUuid: string;
    senderUuid: string | null;
    fromMe: boolean;
    /** For the agent to handle: from someone else, or a note-to-self sent from your phone. */
    incoming: boolean;
    ts: number;
    type: string;
    text: string;
    media: MediaInfo | null;
    replyToUuid: string | null;
}

/** Input for {@link MessageStore.insert}. */
export interface NewMessage {
    peerUuid: string;
    /** WhatsApp's message id (hashed before storage). */
    waId: string;
    senderUuid: string | null;
    fromMe: boolean;
    /** Defaults to `!fromMe`. */
    incoming?: boolean;
    ts: number;
    type: string;
    text: string;
    media?: MediaInfo;
    /** Full message, kept (encrypted) so it can be quoted, reacted to and marked as read. */
    raw?: WAMessage;
    /** WhatsApp id of the message this one quotes, if any. */
    replyToWaId?: string;
}

interface MessageRow {
    seq: number;
    uuid: string;
    peer_uuid: string;
    sender_uuid: string | null;
    from_me: number;
    incoming: number;
    ts: number;
    type: string;
    text_enc: string;
    media_enc: string | null;
    reply_to_uuid: string | null;
}

const AAD = { text: 'messages.text', raw: 'messages.raw', media: 'messages.media' };
const COLUMNS = 'seq, uuid, peer_uuid, sender_uuid, from_me, incoming, ts, type, text_enc, media_enc, reply_to_uuid';

export class MessageStore {
    constructor(
        private readonly db: Database,
        private readonly cipher: Cipher,
    ) {}

    private waHash = (waId: string) => this.cipher.index(waId, 'wa-message-id');

    private decode = (row: MessageRow): StoredMessage => ({
        seq: row.seq,
        uuid: row.uuid,
        peerUuid: row.peer_uuid,
        senderUuid: row.sender_uuid,
        fromMe: Boolean(row.from_me),
        incoming: Boolean(row.incoming),
        ts: row.ts,
        type: row.type,
        text: this.cipher.decrypt(row.text_enc, AAD.text),
        media: row.media_enc ? this.cipher.decryptJson<MediaInfo>(row.media_enc, AAD.media) : null,
        replyToUuid: row.reply_to_uuid,
    });

    /**
     * Inserts a message once. Re-inserting the same WhatsApp message (history sync,
     * our own send echoed back) returns the existing row.
     * @returns the stored row and whether it was newly inserted
     */
    insert(msg: NewMessage): { message: StoredMessage; inserted: boolean } {
        const waIdHash = this.waHash(msg.waId);
        const existing = this.db.get<MessageRow>(
            `SELECT ${COLUMNS} FROM messages WHERE peer_uuid = ? AND wa_id_hash = ?`,
            msg.peerUuid,
            waIdHash,
        );
        if (existing) return { message: this.decode(existing), inserted: false };

        const replyTo = msg.replyToWaId ? this.byWaId(msg.peerUuid, msg.replyToWaId)?.uuid : undefined;
        const raw = msg.raw ? Buffer.from(proto.WebMessageInfo.encode(msg.raw).finish()).toString('base64') : null;
        const uuid = randomUUID();
        const incoming = msg.incoming ?? !msg.fromMe;
        const result = this.db.run(
            `INSERT INTO messages (uuid, peer_uuid, wa_id_hash, sender_uuid, from_me, incoming, ts, type, text_enc, media_enc, raw_enc, reply_to_uuid)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            uuid,
            msg.peerUuid,
            waIdHash,
            msg.senderUuid,
            msg.fromMe,
            incoming,
            msg.ts,
            msg.type,
            this.cipher.encrypt(msg.text, AAD.text),
            msg.media ? this.cipher.encryptJson(msg.media, AAD.media) : null,
            raw ? this.cipher.encrypt(raw, AAD.raw) : null,
            replyTo ?? null,
        );
        return {
            message: {
                seq: Number(result.lastInsertRowid),
                uuid,
                peerUuid: msg.peerUuid,
                senderUuid: msg.senderUuid,
                fromMe: msg.fromMe,
                incoming,
                ts: msg.ts,
                type: msg.type,
                text: msg.text,
                media: msg.media ?? null,
                replyToUuid: replyTo ?? null,
            },
            inserted: true,
        };
    }

    /** Finds a stored message by its WhatsApp id within a chat. */
    byWaId(peerUuid: string, waId: string): StoredMessage | undefined {
        const row = this.db.get<MessageRow>(
            `SELECT ${COLUMNS} FROM messages WHERE peer_uuid = ? AND wa_id_hash = ?`,
            peerUuid,
            this.waHash(waId),
        );
        return row ? this.decode(row) : undefined;
    }

    byUuid(uuid: string): StoredMessage | undefined {
        const row = this.db.get<MessageRow>(`SELECT ${COLUMNS} FROM messages WHERE uuid = ?`, uuid.toLowerCase());
        return row ? this.decode(row) : undefined;
    }

    /** The original WhatsApp message (for quoting, reactions, receipts, downloads); undefined if not kept. */
    raw(uuid: string): WAMessage | undefined {
        const row = this.db.get<{ raw_enc: string | null }>('SELECT raw_enc FROM messages WHERE uuid = ?', uuid.toLowerCase());
        if (!row?.raw_enc) return undefined;
        const bytes = Buffer.from(this.cipher.decrypt(row.raw_enc, AAD.raw), 'base64');
        return proto.WebMessageInfo.decode(bytes) as WAMessage;
    }

    /** Messages in one chat, oldest → newest; `beforeTs` pages further back. */
    forPeer(peerUuid: string, limit: number, beforeTs?: number): StoredMessage[] {
        return this.db
            .all<MessageRow>(
                `SELECT ${COLUMNS} FROM messages WHERE peer_uuid = ? AND (? IS NULL OR ts < ?) ORDER BY ts DESC, seq DESC LIMIT ?`,
                peerUuid,
                beforeTs,
                beforeTs,
                limit,
            )
            .reverse()
            .map(this.decode);
    }

    /** Incoming messages (all chats) received after `cursor`, in arrival order. */
    incomingSince(cursor: number, limit: number): StoredMessage[] {
        return this.db
            .all<MessageRow>(`SELECT ${COLUMNS} FROM messages WHERE seq > ? AND incoming = 1 ORDER BY seq ASC LIMIT ?`, cursor, limit)
            .map(this.decode);
    }

    /** The newest `count` incoming messages of a chat (i.e. its unread ones), oldest → newest. */
    latestIncoming(peerUuid: string, count: number): StoredMessage[] {
        if (count <= 0) return [];
        return this.db
            .all<MessageRow>(
                `SELECT ${COLUMNS} FROM messages WHERE peer_uuid = ? AND incoming = 1 ORDER BY ts DESC, seq DESC LIMIT ?`,
                peerUuid,
                count,
            )
            .reverse()
            .map(this.decode);
    }

    /** The newest message of a chat (for previews), or undefined if the chat has none. */
    lastPreview(peerUuid: string): StoredMessage | undefined {
        const row = this.db.get<MessageRow>(
            `SELECT ${COLUMNS} FROM messages WHERE peer_uuid = ? ORDER BY ts DESC, seq DESC LIMIT 1`,
            peerUuid,
        );
        return row ? this.decode(row) : undefined;
    }

    /** Highest cursor value so far (0 when empty). */
    latestSeq(): number {
        return this.db.get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM messages')?.seq ?? 0;
    }

    count(): number {
        return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')?.n ?? 0;
    }

    /** Deletes all messages (logout). */
    clear() {
        this.db.exec('DELETE FROM messages;');
    }
}
