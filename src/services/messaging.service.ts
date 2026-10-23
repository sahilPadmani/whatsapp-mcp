/**
 * @module services/messaging.service
 *
 * Everything that sends something: text, files, quoted replies and reactions.
 *
 * Each send:
 *  1. resolves the target (chat UUID, exact name, or a phone number if allowed),
 *  2. validates `replyTo` belongs to that chat (quotes the original message),
 *  3. if it starts a conversation with someone new, checks NEW_CHAT_MAX_PER_DAY and
 *     WhatsApp's own new-contact quota,
 *  4. delivers through {@link Sender} (rate limit, typing indicator, storage).
 */
import { UserError } from '../core/errors.js';
import type { RateLimiter } from '../core/limits/rate-limiter.js';
import type { MessageStore, StoredMessage } from '../store/messages.js';
import type { Peer, PeerStore } from '../store/peers.js';
import { mediaKindFor } from '../whatsapp/content.js';
import type { RawMessage, WhatsAppGateway } from '../whatsapp/gateway.js';
import type { MediaKind } from '../whatsapp/parser.js';
import type { ChatResolver } from './chat-resolver.js';
import { requireConnected } from './connection.js';
import type { MediaService, Upload } from './media.service.js';
import type { Sender } from './sender.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** One user-perceived character that is an emoji (incl. skin tones, ZWJ sequences, flags). */
export function isSingleEmoji(value: string): boolean {
    const parts = [...graphemes.segment(value)];
    return parts.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value);
}

/** Outcome of a send. */
export interface SendResult {
    peer: Peer;
    message: StoredMessage;
    /** True if this message started a conversation with someone new. */
    newChat: boolean;
    replyTo?: string;
}

export interface MessagingDeps {
    peers: PeerStore;
    messages: MessageStore;
    wa: Pick<WhatsAppGateway, 'connected' | 'newChatQuota'>;
    resolver: ChatResolver;
    sender: Sender;
    media: MediaService;
    /** NEW_CHAT_MAX_PER_DAY limiter (see `services/limits.ts`). */
    newChats: RateLimiter;
}

export class MessagingService {
    constructor(private readonly deps: MessagingDeps) {}

    /** Sends a text message, optionally quoting `replyTo` (a message id from the same chat). */
    async sendText(input: { to: string; text: string; replyTo?: string }): Promise<SendResult> {
        requireConnected(this.deps.wa);
        const { peer, newChat } = await this.deps.resolver.resolveSendTarget(input.to);
        const quoted = this.quotedFor(peer, input.replyTo);
        await this.checkNewChat(newChat);
        const message = await this.deps.sender.send(peer, input.text, quoted);
        if (newChat) this.deps.newChats.record();
        return { peer, message, newChat, replyTo: input.replyTo };
    }

    /** Quoted reply to `messageId`, in the chat it came from. */
    async reply(input: { messageId: string; text: string }): Promise<SendResult> {
        requireConnected(this.deps.wa);
        const original = this.deps.messages.byUuid(input.messageId);
        if (!original) throw new UserError(`Unknown message id "${input.messageId}".`);
        const peer = this.deps.peers.byUuid(original.peerUuid);
        if (!peer) throw new UserError('The chat for this message no longer exists.');
        const message = await this.deps.sender.send(peer, input.text, this.deps.messages.raw(input.messageId));
        return { peer, message, newChat: false, replyTo: input.messageId };
    }

    /** Sends a file (see {@link MediaService.readUpload}); returns how WhatsApp will show it. */
    async sendMedia(input: {
        to: string;
        upload: Upload;
        caption?: string;
        voiceNote?: boolean;
        replyTo?: string;
    }): Promise<SendResult & { kind: MediaKind }> {
        requireConnected(this.deps.wa);
        const { peer, newChat } = await this.deps.resolver.resolveSendTarget(input.to);
        const quoted = this.quotedFor(peer, input.replyTo);
        await this.checkNewChat(newChat);
        const { data, mimeType, fileName } = input.upload;
        const message = await this.deps.sender.sendMedia(
            peer,
            { data, mimeType, fileName, caption: input.caption, voiceNote: input.voiceNote },
            quoted,
        );
        if (newChat) this.deps.newChats.record();
        this.deps.media.remember(message.uuid, data);
        return { peer, message, newChat, replyTo: input.replyTo, kind: mediaKindFor(mimeType, input.voiceNote) };
    }

    /**
     * Reacts to a message with one emoji; an empty string removes your reaction.
     * @throws {UserError} not a single emoji, unknown message, or original unavailable
     */
    async react(input: { messageId: string; emoji: string }): Promise<{ peer: Peer; message: StoredMessage; emoji: string }> {
        requireConnected(this.deps.wa);
        const emoji = input.emoji.trim();
        if (emoji && !isSingleEmoji(emoji)) throw new UserError('emoji must be exactly one emoji (or "" to remove the reaction).');
        const message = this.deps.messages.byUuid(input.messageId);
        if (!message) throw new UserError(`Unknown message id "${input.messageId}".`);
        const peer = this.deps.peers.byUuid(message.peerUuid);
        const key = this.deps.messages.raw(input.messageId)?.key;
        if (!peer || !key) throw new UserError('This message cannot be reacted to (original not available).');
        await this.deps.sender.react(peer, key, emoji);
        return { peer, message, emoji };
    }

    /** New conversations started in the last 24 hours. */
    newChatsStartedToday(): number {
        return this.deps.newChats.used();
    }

    /** The original message to quote; it must belong to the same chat. */
    private quotedFor(peer: Peer, replyTo?: string): RawMessage | undefined {
        if (!replyTo) return undefined;
        const original = this.deps.messages.byUuid(replyTo);
        if (!original || original.peerUuid !== peer.uuid) throw new UserError('reply_to must be a message id from this chat.');
        return this.deps.messages.raw(replyTo);
    }

    /** Extra protection before starting a conversation with someone new. */
    private async checkNewChat(newChat: boolean) {
        if (!newChat) return;
        this.deps.newChats.check();
        const quota = await this.deps.wa.newChatQuota();
        if (quota && quota.used >= quota.total) throw new UserError("WhatsApp's own limit for messaging new contacts is reached for now.");
    }
}
