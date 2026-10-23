/**
 * @module whatsapp/ingest
 *
 * Turns Baileys events into stored data and application events:
 *
 *   history sync / contacts / chats / messages / reactions  (Baileys)
 *        → PeerStore, MessageStore, ReactionStore            (encrypted)
 *        → EventBus: message.received, reaction.received, data.changed
 *
 * Rules implemented here:
 *  - Only *live* messages (Baileys upsert type "notify") raise events and unread counts;
 *    history sync is stored silently.
 *  - A message counts as incoming if it is from someone else, or if it is a note you
 *    typed into your own "Message yourself" chat on your phone. Messages this server sent
 *    are tagged via {@link Ingestor.markOutgoing} and never count (no agent reply loops).
 *  - LID ↔ phone-number mappings are learned from every event that carries them.
 *  - A failure while handling one event is logged (without content) and never crashes
 *    the socket.
 */
import { normalizeMessageContent, type BaileysEventMap, type Contact, type proto, type WAMessage, type WASocket } from 'baileys';
import type { Database } from '../core/db/database.js';
import type { EventBus, IncomingMessageEvent } from '../events.js';
import type { Logger } from '../logger.js';
import type { MessageStore, StoredMessage } from '../store/messages.js';
import type { Peer, PeerStore } from '../store/peers.js';
import type { ReactionStore } from '../store/reactions.js';
import type { SentMessageRecorder } from './gateway.js';
import { isIgnoredJid, isJidGroup, isLidUser, isPnUser, normalizeJid } from './jid.js';
import { describeMessage, quotedMessageId, toSeconds } from './parser.js';

/** Max remembered outgoing message ids (only recent sends can echo back as live events). */
const OUTGOING_MEMORY = 500;

type ChatLike = {
    id?: string | null;
    name?: string | null;
    displayName?: string | null;
    unreadCount?: number | null;
    conversationTimestamp?: unknown;
};

export class Ingestor implements SentMessageRecorder {
    /** Our own JID, used as the sender of messages sent from this account. */
    selfJid: string | null = null;
    /** Our own JID and LID: the "Message yourself" chat can be addressed by either. */
    private selfChats = new Set<string>();
    /** Ids of messages this server sent (see {@link markOutgoing}). */
    private outgoing = new Set<string>();

    constructor(
        private readonly db: Database,
        private readonly peers: PeerStore,
        private readonly messages: MessageStore,
        private readonly reactions: ReactionStore,
        private readonly bus: EventBus,
        private readonly logger: Logger,
    ) {}

    /** Called by the client once logged in. */
    setSelf(jid: string, lid?: string | null) {
        this.selfJid = jid;
        this.selfChats = new Set([jid, ...(lid ? [normalizeJid(lid)] : [])]);
    }

    /** Registers the id of a message this server is about to send. */
    markOutgoing(waId: string) {
        this.outgoing.add(waId);
        if (this.outgoing.size > OUTGOING_MEMORY) this.outgoing.delete(this.outgoing.values().next().value!);
    }

    /** Subscribes to a (new) socket's events. */
    attach(sock: WASocket) {
        sock.ev.on('messaging-history.set', (e) => this.safely('history', () => this.onHistory(e)));
        sock.ev.on('lid-mapping.update', ({ lid, pn }) => this.safely('lid', () => this.peers.addLidMapping(lid, pn)));
        sock.ev.on('contacts.upsert', (contacts) => this.safely('contacts', () => this.saveContacts(contacts)));
        sock.ev.on('contacts.update', (contacts) =>
            this.safely('contacts', () => this.saveContacts(contacts.filter((c): c is Contact => Boolean(c.id)))),
        );
        sock.ev.on('chats.upsert', (chats) => this.safely('chats', () => this.saveChats(chats)));
        sock.ev.on('chats.update', (chats) => this.safely('chats', () => this.saveChats(chats)));
        sock.ev.on('messages.upsert', ({ messages, type }) =>
            this.safely('messages', () => this.db.transaction(() => this.saveMessages(messages, type === 'notify'))),
        );
    }

    /**
     * Stores messages (and reactions). For live, newly inserted incoming messages it also
     * bumps the chat's unread count and publishes `message.received`.
     * @param live true for real-time events, false for history sync
     */
    saveMessages(messages: WAMessage[], live: boolean): StoredMessage[] {
        const stored: StoredMessage[] = [];
        for (const msg of messages) {
            const result = this.saveMessage(msg, live);
            if (!result) continue;
            stored.push(result.message);
            if (live && result.inserted && result.message.incoming) {
                this.peers.incrementUnread(result.peer.uuid);
                this.bus.emit('message.received', this.toEvent(result.message, result.peer));
            }
        }
        return stored;
    }

    /** Stores a message this server just sent and returns its stored row. */
    saveSent(msg: WAMessage): StoredMessage | undefined {
        return this.db.transaction(() => this.saveMessage(msg, false)?.message);
    }

    /** Converts a stored message into the agent-safe `message.received` payload. */
    toEvent(message: StoredMessage, chat: Peer): IncomingMessageEvent {
        const sender = message.senderUuid ? this.peers.byUuid(message.senderUuid) : undefined;
        return {
            seq: message.seq,
            messageId: message.uuid,
            chatId: chat.uuid,
            chatName: this.peers.label(chat),
            isGroup: chat.isGroup,
            senderId: sender?.uuid ?? null,
            senderName: sender ? this.peers.label(sender) : 'Unknown contact',
            type: message.type,
            text: message.text,
            ts: message.ts,
            time: new Date(message.ts * 1000).toISOString(),
            replyToMessageId: message.replyToUuid,
        };
    }

    // ---- Internals ----

    /** A failing event must never crash the socket; log without message contents. */
    private safely(kind: string, fn: () => void) {
        try {
            fn();
            this.bus.emit('data.changed');
        } catch (err) {
            this.logger.error({ err, kind }, 'failed to ingest WhatsApp event');
        }
    }

    private onHistory({ chats, contacts, messages, lidPnMappings }: BaileysEventMap['messaging-history.set']) {
        this.db.transaction(() => {
            for (const m of lidPnMappings ?? []) this.peers.addLidMapping(m.lid, m.pn);
            this.saveContacts(contacts);
            for (const chat of chats) {
                if (chat.id && chat.pnJid && isLidUser(chat.id)) this.peers.addLidMapping(chat.id, chat.pnJid);
            }
            this.saveChats(chats);
            this.saveMessages(messages, false);
        });
        this.logger.info({ chats: chats.length, contacts: contacts.length, messages: messages.length }, 'history sync batch stored');
    }

    private saveContacts(contacts: Contact[]) {
        for (const c of contacts) {
            if (c.lid && c.phoneNumber) this.peers.addLidMapping(c.lid, c.phoneNumber);
            const jid = c.phoneNumber && isPnUser(c.phoneNumber) ? c.phoneNumber : c.id;
            if (!jid || isIgnoredJid(jid)) continue;
            this.peers.update(jid, { name: c.name, notify: c.notify ?? c.verifiedName });
        }
    }

    private saveChats(chats: ChatLike[]) {
        for (const chat of chats) {
            if (!chat.id || isIgnoredJid(chat.id)) continue;
            this.peers.update(chat.id, {
                name: chat.name ?? chat.displayName,
                isChat: true,
                unread: chat.unreadCount,
                lastMessageTs: chat.conversationTimestamp ? toSeconds(chat.conversationTimestamp) : null,
            });
        }
    }

    private saveMessage(msg: WAMessage, live: boolean): { message: StoredMessage; inserted: boolean; peer: Peer } | undefined {
        const key = msg.key;
        const chatJid = key.remoteJid;
        if (!chatJid || !key.id || isIgnoredJid(chatJid)) return undefined;

        // Learn LID → phone mappings carried on the message key.
        if (isLidUser(chatJid) && key.remoteJidAlt && isPnUser(key.remoteJidAlt)) this.peers.addLidMapping(chatJid, key.remoteJidAlt);
        if (key.participant && isLidUser(key.participant) && key.participantAlt && isPnUser(key.participantAlt)) {
            this.peers.addLidMapping(key.participant, key.participantAlt);
        }

        // Reactions arrive as messages but are stored separately.
        const reaction = normalizeMessageContent(msg.message)?.reactionMessage;
        if (reaction) {
            this.saveReaction(msg, reaction, live);
            return undefined;
        }

        const parsed = describeMessage(msg.message);
        if (!parsed) return undefined; // protocol/bookkeeping payload

        const fromMe = Boolean(key.fromMe);
        // A live note in your own chat that this server didn't send = something you typed for the agent.
        const selfNote = live && fromMe && this.selfChats.has(normalizeJid(chatJid)) && !this.outgoing.has(key.id);
        const ts = toSeconds(msg.messageTimestamp);
        const chat = this.peers.update(chatJid, { isChat: true, lastMessageTs: ts });

        const senderJid = fromMe ? this.selfJid : isJidGroup(chatJid) ? key.participant : chatJid;
        const sender = senderJid ? this.peers.update(senderJid, { notify: fromMe ? undefined : msg.pushName }) : undefined;

        const result = this.messages.insert({
            peerUuid: chat.uuid,
            waId: key.id,
            senderUuid: sender?.uuid ?? null,
            fromMe,
            incoming: !fromMe || selfNote,
            ts,
            type: parsed.type,
            text: parsed.text,
            media: parsed.media,
            raw: msg,
            replyToWaId: quotedMessageId(msg.message),
        });
        return { ...result, peer: chat };
    }

    /** Stores a reaction (emoji '' = removed) and announces live ones from other people. */
    private saveReaction(msg: WAMessage, reaction: proto.Message.IReactionMessage, live: boolean) {
        const chatJid = msg.key.remoteJid!;
        const targetId = reaction.key?.id;
        if (!targetId) return;
        const chat = this.peers.byJid(chatJid);
        const target = chat && this.messages.byWaId(chat.uuid, targetId);
        if (!chat || !target) return; // reaction to a message we don't have

        const fromMe = Boolean(msg.key.fromMe);
        const reactorJid = fromMe ? this.selfJid : isJidGroup(chatJid) ? (msg.key.participantAlt ?? msg.key.participant) : chatJid;
        if (!reactorJid) return;
        const reactor = this.peers.update(reactorJid, { notify: fromMe ? undefined : msg.pushName });
        const emoji = reaction.text ?? '';
        // senderTimestampMs is milliseconds; messageTimestamp is seconds.
        const ts = reaction.senderTimestampMs ? Math.floor(toSeconds(reaction.senderTimestampMs) / 1000) : toSeconds(msg.messageTimestamp);

        const changed = this.reactions.set(target.uuid, reactor.uuid, emoji, fromMe, ts);
        if (changed && live && !fromMe) {
            this.bus.emit('reaction.received', {
                messageId: target.uuid,
                chatId: chat.uuid,
                chatName: this.peers.label(chat),
                reactorId: reactor.uuid,
                reactorName: this.peers.label(reactor),
                emoji,
                removed: !emoji,
                time: new Date(ts * 1000).toISOString(),
            });
        }
    }
}
