/**
 * @module services/inbox.service
 *
 * Reading conversations and receiving new messages.
 *
 * New messages use a **global cursor** (`seq`): callers keep the `nextCursor` from each
 * call and pass it to the next one, so nothing is missed or repeated, even across
 * reconnects. With `waitSeconds` the call long-polls: it returns as soon as a message
 * arrives (via the event bus) or when the time is up.
 */
import type { EventBus } from '../events.js';
import type { MessageStore, StoredMessage } from '../store/messages.js';
import type { Peer, PeerStore } from '../store/peers.js';
import type { WhatsAppGateway } from '../whatsapp/gateway.js';
import type { ChatResolver } from './chat-resolver.js';
import { requireConnected, requireReadable } from './connection.js';

/** Upper bound for long-polling; keeps calls under typical MCP client timeouts (~60 s). */
export const MAX_WAIT_SECONDS = 50;

export interface NewMessagesQuery {
    /** `nextCursor` from the previous call; omit to get the current unread messages. */
    cursor?: number;
    /** Wait up to this many seconds for a message if there is none yet (0 = return immediately). */
    waitSeconds: number;
    limit: number;
    /** Cancels the wait (e.g. the MCP request was cancelled). */
    signal?: AbortSignal;
}

export class InboxService {
    constructor(
        private readonly peers: PeerStore,
        private readonly messages: MessageStore,
        private readonly wa: Pick<WhatsAppGateway, 'connected' | 'markRead'>,
        private readonly bus: EventBus,
        private readonly resolver: ChatResolver,
    ) {}

    /** Messages of one chat, oldest → newest. Page back with `beforeTs` = the earliest returned `ts`. */
    history(chat: string, limit: number, beforeTs?: number): { peer: Peer; messages: StoredMessage[] } {
        requireReadable(this.wa, this.peers);
        const peer = this.resolver.resolve(chat);
        return { peer, messages: this.messages.forPeer(peer.uuid, limit, beforeTs) };
    }

    /**
     * Incoming messages across all chats.
     * - no cursor: the current unread messages, and the latest cursor to continue from;
     * - with cursor: messages received after it (waiting up to `waitSeconds` if none yet).
     */
    async newMessages(query: NewMessagesQuery): Promise<{ messages: StoredMessage[]; nextCursor: number }> {
        requireReadable(this.wa, this.peers);
        const { cursor, limit } = query;

        if (cursor === undefined) {
            const latest = this.messages.latestSeq();
            const unread = this.peers
                .listChats({ limit: 100, unreadOnly: true })
                .flatMap((p) => this.messages.latestIncoming(p.uuid, Math.min(p.unread, limit)))
                .sort((a, b) => a.ts - b.ts)
                .slice(-limit);
            return { messages: unread, nextCursor: latest };
        }

        let list = this.messages.incomingSince(cursor, limit);
        if (list.length === 0 && query.waitSeconds > 0) {
            await this.waitForIncoming(Math.min(query.waitSeconds, MAX_WAIT_SECONDS) * 1000, query.signal);
            list = this.messages.incomingSince(cursor, limit);
        }
        const nextCursor = list.length ? list[list.length - 1].seq : Math.max(cursor, this.messages.latestSeq());
        return { messages: list, nextCursor };
    }

    /** Sends read receipts for a chat's unread messages and resets its unread count. */
    async markRead(chat: string): Promise<{ peer: Peer; marked: number }> {
        requireConnected(this.wa);
        const peer = this.resolver.resolve(chat);
        const unread = this.messages.latestIncoming(peer.uuid, peer.unread);
        const keys = unread.flatMap((m) => {
            const key = this.messages.raw(m.uuid)?.key;
            return key ? [key] : [];
        });
        if (keys.length) await this.wa.markRead(keys);
        this.peers.setUnread(peer.uuid, 0);
        return { peer, marked: unread.length };
    }

    /** Chats with unread messages and the latest cursor (for the `whatsapp://inbox` resource). */
    summary(): { latestCursor: number; unreadChats: Peer[] } {
        return { latestCursor: this.messages.latestSeq(), unreadChats: this.peers.listChats({ limit: 50, unreadOnly: true }) };
    }

    /** Resolves when a message arrives, the timeout passes, or `signal` aborts. */
    private waitForIncoming(timeoutMs: number, signal?: AbortSignal): Promise<void> {
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                this.bus.off('message.received', done);
                signal?.removeEventListener('abort', done);
                resolve();
            };
            const timer = setTimeout(done, timeoutMs);
            this.bus.on('message.received', done);
            signal?.addEventListener('abort', done);
        });
    }
}
