/**
 * @module services/chat-resolver
 *
 * Turns what a caller typed into exactly one chat (a {@link Peer}), and enforces the
 * input privacy rules:
 *
 * | Input                      | Read tools        | Send tools                          |
 * |----------------------------|-------------------|-------------------------------------|
 * | chat UUID                  | ok                | ok                                   |
 * | exact contact/group name   | ok                | ok                                   |
 * | phone number (+country)    | rejected          | if ALLOW_SEND_TO_PHONE (write-only)|
 * | raw WhatsApp ID (…@s.whatsapp.net) | rejected  | rejected                      |
 *
 * Read tools reject numbers so they can't be used to find out who a number belongs to.
 */
import { UserError } from '../core/errors.js';
import type { PrivacyGuard } from '../privacy/guard.js';
import type { MessageStore } from '../store/messages.js';
import type { Peer, PeerStore } from '../store/peers.js';
import type { WhatsAppGateway } from '../whatsapp/gateway.js';
import { parsePhoneInput } from '../whatsapp/jid.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for strings shaped like the ids this server hands out. */
export const isUuid = (value: string) => UUID_RE.test(value.trim());

export interface ChatResolverOptions {
    /** Whether send tools may target a phone number (ALLOW_SEND_TO_PHONE). */
    allowSendToPhone: boolean;
}

export class ChatResolver {
    constructor(
        private readonly peers: PeerStore,
        private readonly messages: MessageStore,
        private readonly wa: Pick<WhatsAppGateway, 'lookupPhone'>,
        private readonly guard: PrivacyGuard,
        private readonly options: ChatResolverOptions,
    ) {}

    /** @throws {UserError} if `value` contains a phone number or WhatsApp ID. */
    assertNoIdentifiers(value: string): void {
        if (this.guard.detect(value)) {
            throw new UserError('Phone numbers and WhatsApp IDs are not accepted. Use a chat id from list_chats or search_contacts.');
        }
    }

    /**
     * Chat UUID or exact contact/group name → peer.
     * A partial name is accepted when it matches exactly one chat.
     * @throws {UserError} unknown id, no match, several matches (the error lists their ids), or a number/JID
     */
    resolve(input: string): Peer {
        const value = input.trim();
        if (isUuid(value)) {
            const peer = this.peers.byUuid(value);
            if (!peer) throw new UserError(`Unknown chat id "${value}". Use list_chats or search_contacts to get a valid id.`);
            return peer;
        }
        this.assertNoIdentifiers(value);

        const matches = this.peers.search(value, 6);
        const lower = value.toLowerCase();
        const exact = matches.filter((p) => [p.name, p.notify].some((n) => n?.toLowerCase() === lower));
        if (exact.length === 1) return exact[0];
        if (exact.length > 1 || matches.length > 1) {
            const candidates = (exact.length > 1 ? exact : matches).map((p) => ({ id: p.uuid, name: this.peers.label(p) }));
            throw new UserError(`"${value}" matches several chats; pass one of these ids instead: ${JSON.stringify(candidates)}`);
        }
        if (matches.length === 1) return matches[0];
        throw new UserError(`No contact or chat matches "${value}". Try search_contacts.`);
    }

    /**
     * Like {@link resolve}, but also accepts a phone number with country code (if allowed).
     * The number is checked with WhatsApp and is never echoed back in errors or results.
     * @returns the peer, and whether this would start a conversation with someone new
     * @throws {UserError} disabled, malformed number, number not on WhatsApp, or as {@link resolve}
     */
    async resolveSendTarget(input: string): Promise<{ peer: Peer; newChat: boolean }> {
        const value = input.trim();
        let peer: Peer;
        if (!isUuid(value) && this.guard.detect(value) === 'phone') {
            if (!this.options.allowSendToPhone) {
                throw new UserError('Sending to phone numbers is disabled. Use a chat id from list_chats or search_contacts.');
            }
            const parsed = parsePhoneInput(value);
            if ('error' in parsed) throw new UserError(parsed.error);
            // WhatsApp silently drops messages to numbers without an account, so check first.
            const jid = await this.wa.lookupPhone(parsed.digits);
            if (!jid) throw new UserError('This phone number is not on WhatsApp.');
            peer = this.peers.ensure(jid);
        } else {
            peer = this.resolve(value);
        }
        return { peer, newChat: !peer.isChat && !this.messages.lastPreview(peer.uuid) };
    }
}
