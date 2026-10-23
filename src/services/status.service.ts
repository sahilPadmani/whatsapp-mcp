/**
 * @module services/status.service
 *
 * A snapshot of the connection and stored data, for `whatsapp_status`.
 * Contains your profile name and your own chat's UUID, never your number.
 */
import type { MessageStore } from '../store/messages.js';
import type { PeerStore } from '../store/peers.js';
import type { WhatsAppGateway } from '../whatsapp/gateway.js';
import type { MessagingService } from './messaging.service.js';

export interface StatusSnapshot {
    connected: boolean;
    state: WhatsAppGateway['state'];
    /** Your profile name and the UUID of your own "Message yourself" chat. */
    me: { name: string | null; id: string | null } | null;
    stored: { chats: number; contacts: number; messages: number };
    latestCursor: number;
    newChatsStartedToday: number;
}

export class StatusService {
    constructor(
        private readonly wa: Pick<WhatsAppGateway, 'connected' | 'state' | 'me'>,
        private readonly peers: PeerStore,
        private readonly messages: MessageStore,
        private readonly messaging: MessagingService,
    ) {}

    snapshot(): StatusSnapshot {
        const me = this.wa.me;
        return {
            connected: this.wa.connected,
            state: this.wa.state,
            me: me ? { name: me.name, id: this.peers.byJid(me.jid)?.uuid ?? null } : null,
            stored: { ...this.peers.counts(), messages: this.messages.count() },
            latestCursor: this.messages.latestSeq(),
            newChatsStartedToday: this.messaging.newChatsStartedToday(),
        };
    }
}
