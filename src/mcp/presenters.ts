/**
 * @module mcp/presenters
 *
 * Converts stored data into the JSON shapes MCP clients see. This is the **only** place
 * output shapes are defined, and they contain opaque UUIDs and display names, never
 * phone numbers or WhatsApp IDs. (The privacy guard re-checks everything anyway.)
 */
import type { MessageStore, StoredMessage } from '../store/messages.js';
import type { Peer, PeerStore } from '../store/peers.js';
import type { Reaction, ReactionStore } from '../store/reactions.js';

const iso = (ts: number | null) => (ts ? new Date(ts * 1000).toISOString() : null);

export class Presenter {
    constructor(
        private readonly peers: PeerStore,
        private readonly messages: MessageStore,
        private readonly reactions: ReactionStore,
    ) {}

    /** `{ id, name }`: the minimal way to refer to a chat or person. */
    ref(peer: Peer) {
        return { id: peer.uuid, name: this.peers.label(peer) };
    }

    /** A chat-list entry with unread count and last-message preview. */
    chat(peer: Peer) {
        const last = this.messages.lastPreview(peer.uuid);
        return {
            id: peer.uuid,
            name: this.peers.label(peer),
            isGroup: peer.isGroup,
            unread: peer.unread,
            lastMessageAt: iso(peer.lastMessageTs),
            lastMessage: last ? `${last.fromMe ? 'me: ' : ''}${last.text.slice(0, 120)}` : null,
        };
    }

    /** A contact search result. */
    contact(peer: Peer) {
        return { id: peer.uuid, name: this.peers.label(peer), isGroup: peer.isGroup };
    }

    /** Messages with their reactions (loaded with one query). `includeChat` adds `{ chat: {id, name} }`. */
    messageList(list: StoredMessage[], opts: { includeChat?: boolean } = {}) {
        const reactions = this.reactions.forMessages(list.map((m) => m.uuid));
        return list.map((m) => this.message(m, { ...opts, reactions: reactions.get(m.uuid) }));
    }

    message(m: StoredMessage, opts: { includeChat?: boolean; reactions?: Reaction[] } = {}) {
        const sender = m.senderUuid ? this.peers.byUuid(m.senderUuid) : undefined;
        const chat = opts.includeChat ? this.peers.byUuid(m.peerUuid) : undefined;
        return {
            id: m.uuid,
            ...(chat ? { chat: this.ref(chat) } : {}),
            ts: m.ts,
            time: iso(m.ts),
            from: m.fromMe ? 'me' : sender ? this.peers.label(sender) : 'Unknown contact',
            ...(!m.fromMe && sender ? { fromId: sender.uuid } : {}),
            fromMe: m.fromMe,
            type: m.type,
            text: m.text,
            ...(m.media ? { media: m.media } : {}),
            ...(opts.reactions?.length ? { reactions: this.reactionList(opts.reactions) } : {}),
            ...(m.replyToUuid ? { replyTo: m.replyToUuid } : {}),
        };
    }

    /** Result of a send / reply. */
    sent(result: { peer: Peer; message: StoredMessage; newChat: boolean; replyTo?: string }) {
        return {
            sent: true,
            messageId: result.message.uuid,
            chat: this.ref(result.peer),
            ...(result.replyTo ? { replyTo: result.replyTo } : {}),
            ...(result.newChat ? { newChat: true } : {}),
            time: new Date(result.message.ts * 1000).toISOString(),
        };
    }

    private reactionList(reactions: Reaction[]) {
        return reactions.map((r) => {
            const reactor = this.peers.byUuid(r.reactorUuid);
            return {
                emoji: r.emoji,
                from: r.fromMe ? 'me' : reactor ? this.peers.label(reactor) : 'Unknown contact',
                ...(!r.fromMe && reactor ? { fromId: reactor.uuid } : {}),
            };
        });
    }
}
