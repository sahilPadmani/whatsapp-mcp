/**
 * @module store/peers
 *
 * Repository for people and groups ("peers"): **the UUID ↔ phone number mapping**.
 *
 * This is the only place phone numbers and WhatsApp IDs (JIDs) are stored:
 *  - JID, phone number and names are AES-256-GCM encrypted in the `peers` table;
 *  - lookups by JID use an HMAC blind index (`jid_hash`), so no plaintext is needed;
 *  - callers only ever see the random `uuid`.
 *
 * WhatsApp identifies some people by a "LID" (`…@lid`) instead of their phone number.
 * When the mapping LID → phone number becomes known, the LID peer is merged into the
 * phone-number peer and its old UUID keeps working as an alias.
 *
 * A decrypted copy of the directory is kept in memory for name search, display names
 * and the privacy guard's list of known numbers (fine at personal scale: thousands).
 */
import { randomUUID } from 'node:crypto';
import type { Cipher } from '../core/crypto/cipher.js';
import type { Database } from '../core/db/database.js';
import { isIgnoredJid, isJidGroup, isLidUser, jidToDigits, normalizeJid } from '../whatsapp/jid.js';

/** A person or group, decrypted. `jid` and `phone` must never be returned to callers. */
export interface Peer {
    /** The only identifier callers see. */
    uuid: string;
    jid: string;
    /** Digits only, e.g. "919876543210". Never leaves the server. */
    phone: string | null;
    /** Name you saved for the contact (or the group subject). */
    name: string | null;
    /** Name the person set on their own WhatsApp profile ("push name"). */
    notify: string | null;
    isGroup: boolean;
    /** True once there is a conversation (as opposed to a contact you never talked to). */
    isChat: boolean;
    unread: number;
    lastMessageTs: number | null;
}

/** Fields that {@link PeerStore.update} may change. Empty values never overwrite stored ones. */
export interface PeerUpdate {
    name?: string | null;
    notify?: string | null;
    isChat?: boolean;
    unread?: number | null;
    lastMessageTs?: number | null;
}

interface PeerRow {
    uuid: string;
    jid_enc: string;
    phone_enc: string | null;
    name_enc: string | null;
    notify_enc: string | null;
    is_group: number;
    is_chat: number;
    unread_count: number;
    last_message_ts: number | null;
}

const AAD = { jid: 'peers.jid', phone: 'peers.phone', name: 'peers.name', notify: 'peers.notify', lid: 'lid_map.pn' };

export class PeerStore {
    private byId = new Map<string, Peer>();
    private byHash = new Map<string, string>();
    private aliases = new Map<string, string>();
    private lidToPn = new Map<string, string>();

    constructor(
        private readonly db: Database,
        private readonly cipher: Cipher,
    ) {
        this.load();
    }

    private hash = (jid: string) => this.cipher.index(jid, 'jid');

    private load() {
        for (const row of this.db.all<PeerRow & { jid_hash: string }>('SELECT * FROM peers')) {
            const peer = this.decode(row);
            this.byId.set(peer.uuid, peer);
            this.byHash.set(row.jid_hash, peer.uuid);
        }
        for (const row of this.db.all<{ uuid: string; peer_uuid: string }>('SELECT * FROM peer_aliases')) {
            this.aliases.set(row.uuid, row.peer_uuid);
        }
        for (const row of this.db.all<{ lid_hash: string; pn_enc: string }>('SELECT * FROM lid_map')) {
            this.lidToPn.set(row.lid_hash, this.cipher.decrypt(row.pn_enc, AAD.lid));
        }
    }

    private decode(row: PeerRow): Peer {
        return {
            uuid: row.uuid,
            jid: this.cipher.decrypt(row.jid_enc, AAD.jid),
            phone: this.cipher.decryptOptional(row.phone_enc, AAD.phone),
            name: this.cipher.decryptOptional(row.name_enc, AAD.name),
            notify: this.cipher.decryptOptional(row.notify_enc, AAD.notify),
            isGroup: Boolean(row.is_group),
            isChat: Boolean(row.is_chat),
            unread: row.unread_count,
            lastMessageTs: row.last_message_ts,
        };
    }

    private persist(peer: Peer) {
        this.db.run(
            `UPDATE peers SET jid_hash = ?, jid_enc = ?, phone_enc = ?, name_enc = ?, notify_enc = ?,
                is_group = ?, is_chat = ?, unread_count = ?, last_message_ts = ? WHERE uuid = ?`,
            this.hash(peer.jid),
            this.cipher.encrypt(peer.jid, AAD.jid),
            this.cipher.encryptOptional(peer.phone, AAD.phone),
            this.cipher.encryptOptional(peer.name, AAD.name),
            this.cipher.encryptOptional(peer.notify, AAD.notify),
            peer.isGroup,
            peer.isChat,
            peer.unread,
            peer.lastMessageTs,
            peer.uuid,
        );
    }

    /** Maps a LID to its phone-number JID when known, so one person is one peer. */
    canonical(jid: string): string {
        const normalized = normalizeJid(jid);
        return isLidUser(normalized) ? (this.lidToPn.get(this.hash(normalized)) ?? normalized) : normalized;
    }

    byJid(jid: string): Peer | undefined {
        const uuid = this.byHash.get(this.hash(this.canonical(jid)));
        return uuid ? this.byId.get(uuid) : undefined;
    }

    byUuid(uuid: string): Peer | undefined {
        const id = uuid.toLowerCase();
        return this.byId.get(this.aliases.get(id) ?? id);
    }

    /** Get or create the peer for a JID. */
    ensure(jid: string): Peer {
        const canonical = this.canonical(jid);
        const existing = this.byJid(canonical);
        if (existing) return existing;

        const peer: Peer = {
            uuid: randomUUID(),
            jid: canonical,
            phone: jidToDigits(canonical) ?? null,
            name: null,
            notify: null,
            isGroup: Boolean(isJidGroup(canonical)),
            isChat: false,
            unread: 0,
            lastMessageTs: null,
        };
        const hash = this.hash(canonical);
        this.db.run(
            'INSERT INTO peers (uuid, jid_hash, jid_enc, phone_enc, is_group) VALUES (?, ?, ?, ?, ?)',
            peer.uuid,
            hash,
            this.cipher.encrypt(canonical, AAD.jid),
            this.cipher.encryptOptional(peer.phone, AAD.phone),
            peer.isGroup,
        );
        this.byId.set(peer.uuid, peer);
        this.byHash.set(hash, peer.uuid);
        return peer;
    }

    /** Merge-style update: undefined/null/empty values keep what is stored; lastMessageTs only moves forward. */
    update(jid: string, changes: PeerUpdate): Peer {
        const peer = this.ensure(jid);
        let dirty = false;
        const set = <K extends keyof Peer>(key: K, value: Peer[K]) => {
            if (peer[key] !== value) {
                peer[key] = value;
                dirty = true;
            }
        };
        if (changes.name) set('name', changes.name);
        if (changes.notify) set('notify', changes.notify);
        if (changes.isChat) set('isChat', true);
        if (changes.unread != null) set('unread', Math.max(0, changes.unread));
        if (changes.lastMessageTs && changes.lastMessageTs > (peer.lastMessageTs ?? 0)) set('lastMessageTs', changes.lastMessageTs);
        if (dirty) this.persist(peer);
        return peer;
    }

    incrementUnread(uuid: string) {
        const peer = this.byUuid(uuid);
        if (!peer) return;
        peer.unread++;
        this.db.run('UPDATE peers SET unread_count = unread_count + 1 WHERE uuid = ?', peer.uuid);
    }

    setUnread(uuid: string, count: number) {
        const peer = this.byUuid(uuid);
        if (!peer) return;
        peer.unread = count;
        this.db.run('UPDATE peers SET unread_count = ? WHERE uuid = ?', count, peer.uuid);
    }

    /**
     * Records that a LID and a phone-number JID are the same person. Anything
     * stored under the LID moves to the phone-number peer; the LID's UUID stays
     * valid as an alias.
     */
    addLidMapping(lid: string, pn: string) {
        lid = normalizeJid(lid);
        pn = normalizeJid(pn);
        if (!lid || !pn || lid === pn || !isLidUser(lid)) return;
        const lidHash = this.hash(lid);
        if (this.lidToPn.get(lidHash) === pn) return;

        this.db.transaction(() => {
            this.db.run('INSERT OR REPLACE INTO lid_map (lid_hash, pn_enc) VALUES (?, ?)', lidHash, this.cipher.encrypt(pn, AAD.lid));
            this.lidToPn.set(lidHash, pn);

            const lidUuid = this.byHash.get(lidHash);
            if (!lidUuid) return;
            const lidPeer = this.byId.get(lidUuid)!;
            const pnUuid = this.byHash.get(this.hash(pn));

            if (!pnUuid) {
                // Re-key the LID peer to the phone number; its UUID is unchanged.
                this.byHash.delete(lidHash);
                lidPeer.jid = pn;
                lidPeer.phone = jidToDigits(pn) ?? null;
                this.persist(lidPeer);
                this.byHash.set(this.hash(pn), lidPeer.uuid);
                return;
            }

            const pnPeer = this.byId.get(pnUuid)!;
            this.db.run('UPDATE OR IGNORE messages SET peer_uuid = ? WHERE peer_uuid = ?', pnUuid, lidUuid);
            this.db.run('DELETE FROM messages WHERE peer_uuid = ?', lidUuid);
            this.db.run('UPDATE messages SET sender_uuid = ? WHERE sender_uuid = ?', pnUuid, lidUuid);
            this.db.run('UPDATE OR IGNORE reactions SET reactor_uuid = ? WHERE reactor_uuid = ?', pnUuid, lidUuid);
            this.db.run('DELETE FROM reactions WHERE reactor_uuid = ?', lidUuid);
            pnPeer.name ??= lidPeer.name;
            pnPeer.notify ??= lidPeer.notify;
            pnPeer.isChat ||= lidPeer.isChat;
            pnPeer.unread = Math.max(pnPeer.unread, lidPeer.unread);
            pnPeer.lastMessageTs = Math.max(pnPeer.lastMessageTs ?? 0, lidPeer.lastMessageTs ?? 0) || null;
            this.persist(pnPeer);

            this.db.run('DELETE FROM peers WHERE uuid = ?', lidUuid);
            this.db.run('UPDATE peer_aliases SET peer_uuid = ? WHERE peer_uuid = ?', pnUuid, lidUuid);
            this.db.run('INSERT OR REPLACE INTO peer_aliases (uuid, peer_uuid) VALUES (?, ?)', lidUuid, pnUuid);
            for (const [alias, target] of this.aliases) if (target === lidUuid) this.aliases.set(alias, pnUuid);
            this.aliases.set(lidUuid, pnUuid);
            this.byId.delete(lidUuid);
            this.byHash.delete(lidHash);
        });
    }

    /** Saved name, else the person's own profile name, else null. */
    displayName(peer: Peer): string | null {
        return peer.name ?? peer.notify ?? null;
    }

    /** Display name with a neutral fallback; never falls back to the phone number. */
    label(peer: Peer): string {
        return this.displayName(peer) ?? (peer.isGroup ? 'Unnamed group' : 'Unknown contact');
    }

    /** Chats (conversations that have messages or came from chat sync), most recent first. */
    listChats(opts: { limit: number; query?: string; unreadOnly?: boolean }): Peer[] {
        const q = opts.query?.toLowerCase();
        return [...this.byId.values()]
            .filter((p) => p.isChat && !isIgnoredJid(p.jid))
            .filter((p) => !opts.unreadOnly || p.unread > 0)
            .filter((p) => !q || (this.displayName(p) ?? '').toLowerCase().includes(q))
            .sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0))
            .slice(0, opts.limit);
    }

    /** Name search only (never by number): exact matches first, then most recently active. */
    search(query: string, limit: number): Peer[] {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        const names = (p: Peer) => [p.name, p.notify].filter(Boolean).map((n) => n!.toLowerCase());
        return [...this.byId.values()]
            .filter((p) => !isIgnoredJid(p.jid) && names(p).some((n) => n.includes(q)))
            .sort((a, b) => {
                const exact = Number(names(b).includes(q)) - Number(names(a).includes(q));
                return exact || (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0);
            })
            .slice(0, limit);
    }

    /** Phone numbers (digits) known to the server, used by the privacy guard. */
    knownPhones(): Set<string> {
        const phones = new Set<string>();
        for (const peer of this.byId.values()) if (peer.phone) phones.add(peer.phone);
        for (const pn of this.lidToPn.values()) {
            const digits = jidToDigits(pn);
            if (digits) phones.add(digits);
        }
        return phones;
    }

    counts() {
        let chats = 0;
        for (const p of this.byId.values()) if (p.isChat && !isIgnoredJid(p.jid)) chats++;
        return { chats, contacts: this.byId.size };
    }

    clear() {
        this.db.exec('DELETE FROM peers; DELETE FROM peer_aliases; DELETE FROM lid_map;');
        this.byId.clear();
        this.byHash.clear();
        this.aliases.clear();
        this.lidToPn.clear();
    }
}
