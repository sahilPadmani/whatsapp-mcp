/**
 * @module services/connection
 *
 * Preconditions shared by services:
 *  - writes (send, react, mark as read, downloads) need a live WhatsApp connection;
 *  - reads are served from the encrypted local store, so they keep working while
 *    WhatsApp reconnects. They only fail if nothing was ever synced (never logged in).
 */
import { NotConnectedError } from '../core/errors.js';
import type { PeerStore } from '../store/peers.js';
import type { WhatsAppGateway } from '../whatsapp/gateway.js';

/** @throws {NotConnectedError} unless WhatsApp is connected. */
export function requireConnected(wa: Pick<WhatsAppGateway, 'connected'>): void {
    if (!wa.connected) throw new NotConnectedError();
}

/** @throws {NotConnectedError} if WhatsApp is disconnected and there is no stored data to read. */
export function requireReadable(wa: Pick<WhatsAppGateway, 'connected'>, peers: PeerStore): void {
    if (!wa.connected && peers.counts().contacts === 0) throw new NotConnectedError();
}
