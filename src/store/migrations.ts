/**
 * @module store/migrations
 *
 * The database schema, as numbered migrations (see `MIGRATIONS` below).
 */
import type { Database } from '../core/db/database.js';

/**
 * Ordered schema migrations; index + 1 is the schema version (PRAGMA user_version).
 * Never edit a shipped migration; append a new one instead.
 *
 * Columns ending in `_enc` hold AES-256-GCM ciphertext, `_hash` hold HMAC blind indexes.
 */
const MIGRATIONS: string[] = [
    `
    CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    -- One row per person/group: the UUID <-> phone number mapping. Only the server can decrypt jid/phone.
    CREATE TABLE peers (
        uuid TEXT PRIMARY KEY,
        jid_hash TEXT NOT NULL UNIQUE,
        jid_enc TEXT NOT NULL,
        phone_enc TEXT,
        name_enc TEXT,
        notify_enc TEXT,
        is_group INTEGER NOT NULL DEFAULT 0,
        is_chat INTEGER NOT NULL DEFAULT 0,
        unread_count INTEGER NOT NULL DEFAULT 0,
        last_message_ts INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Old UUIDs that were merged into another peer (LID -> phone number) keep resolving.
    CREATE TABLE peer_aliases (
        uuid TEXT PRIMARY KEY,
        peer_uuid TEXT NOT NULL
    );

    CREATE TABLE lid_map (
        lid_hash TEXT PRIMARY KEY,
        pn_enc TEXT NOT NULL
    );

    CREATE TABLE messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        peer_uuid TEXT NOT NULL,
        wa_id_hash TEXT NOT NULL,
        sender_uuid TEXT,
        from_me INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        text_enc TEXT NOT NULL,
        raw_enc TEXT,
        reply_to_uuid TEXT,
        UNIQUE (peer_uuid, wa_id_hash)
    );
    CREATE INDEX messages_peer_ts ON messages (peer_uuid, ts);

    -- Encrypted Baileys auth state (credentials + Signal keys).
    CREATE TABLE auth_kv (
        key TEXT PRIMARY KEY,
        value_enc TEXT NOT NULL
    );

    CREATE TABLE webhook_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        payload_enc TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL
    );
    `,
    // 2: "incoming" = messages for the agent to handle: from others, plus notes you send
    // to your own chat from another device (a command channel to the agent).
    `
    ALTER TABLE messages ADD COLUMN incoming INTEGER NOT NULL DEFAULT 0;
    UPDATE messages SET incoming = 1 - from_me;
    CREATE INDEX messages_incoming_seq ON messages (incoming, seq);
    `,
    // 3: media metadata (kind, mime type, file name, size, caption) as encrypted JSON.
    `
    ALTER TABLE messages ADD COLUMN media_enc TEXT;
    `,
    // 4: emoji reactions, one per person per message (WhatsApp semantics).
    `
    CREATE TABLE reactions (
        message_uuid TEXT NOT NULL,
        reactor_uuid TEXT NOT NULL,
        emoji_enc TEXT NOT NULL,
        from_me INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (message_uuid, reactor_uuid)
    );
    `,
];

export function migrate(db: Database) {
    const current = db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
    for (let version = current; version < MIGRATIONS.length; version++) {
        db.transaction(() => {
            db.exec(MIGRATIONS[version]);
            db.exec(`PRAGMA user_version = ${version + 1}`);
        });
    }
}
