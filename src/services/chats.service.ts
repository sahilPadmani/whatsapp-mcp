/**
 * @module services/chats.service
 *
 * Read-only access to the chat list and the contact directory.
 * Searching is by name only; numbers and WhatsApp IDs are rejected.
 */
import type { Peer, PeerStore } from '../store/peers.js';
import type { WhatsAppGateway } from '../whatsapp/gateway.js';
import type { ChatResolver } from './chat-resolver.js';
import { requireReadable } from './connection.js';

export interface ListChatsOptions {
    limit: number;
    /** Filter by chat/contact name. */
    query?: string;
    unreadOnly?: boolean;
}

export class ChatsService {
    constructor(
        private readonly peers: PeerStore,
        private readonly resolver: ChatResolver,
        private readonly wa: Pick<WhatsAppGateway, 'connected'>,
    ) {}

    /** Conversations, most recent first. */
    list(options: ListChatsOptions): Peer[] {
        requireReadable(this.wa, this.peers);
        if (options.query) this.resolver.assertNoIdentifiers(options.query);
        return this.peers.listChats(options);
    }

    /** People and groups whose name contains `query`, exact matches first. */
    search(query: string, limit: number): Peer[] {
        requireReadable(this.wa, this.peers);
        this.resolver.assertNoIdentifiers(query);
        return this.peers.search(query, limit);
    }
}
