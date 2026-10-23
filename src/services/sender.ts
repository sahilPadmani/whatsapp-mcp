/**
 * @module services/sender
 *
 * Delivers outgoing messages the way a person would:
 *   1. check the send rate limit,
 *   2. show "typing…" for a time proportional to the text (if HUMANIZE_REPLIES),
 *   3. send through the gateway (optionally quoting a message),
 *   4. store the sent message and return it (so callers get its UUID).
 *
 * Reactions skip the typing step (WhatsApp shows none for reactions).
 */
import { AppError } from '../core/errors.js';
import type { RateLimiter } from '../core/limits/rate-limiter.js';
import type { StoredMessage } from '../store/messages.js';
import type { Peer } from '../store/peers.js';
import type { OutgoingMedia } from '../whatsapp/content.js';
import type { MessageKey, RawMessage, SentMessageRecorder, WhatsAppGateway } from '../whatsapp/gateway.js';

/** WhatsApp accepted the request but returned nothing, or the sent message could not be stored. */
export class SendError extends AppError {
    override name = 'SendError';
}

/** Settings for the typing indicator (subset of `Config`). */
export interface TypingSettings {
    HUMANIZE_REPLIES: boolean;
    TYPING_MS_PER_CHAR: number;
    TYPING_MIN_MS: number;
    TYPING_MAX_MS: number;
}

/** How long to show "typing…" before sending: proportional to the text length, clamped to [min, max]. */
export function typingDelayMs(text: string, settings: TypingSettings): number {
    if (!settings.HUMANIZE_REPLIES) return 0;
    const perChar = [...text].length * settings.TYPING_MS_PER_CHAR;
    return Math.min(settings.TYPING_MAX_MS, Math.max(settings.TYPING_MIN_MS, perChar));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Sender {
    /**
     * @param gateway   WhatsApp connection
     * @param recorder  stores sent messages (the Ingestor)
     * @param limiter   outgoing rate limit (see `services/limits.ts`)
     * @param typing    typing-indicator settings
     * @param sleep     injectable delay (tests pass a no-op)
     */
    constructor(
        private readonly gateway: WhatsAppGateway,
        private readonly recorder: SentMessageRecorder,
        private readonly limiter: RateLimiter,
        private readonly typing: TypingSettings,
        private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    ) {}

    /** Sends a text message. @throws {RateLimitError | SendError | NotConnectedError} */
    async send(peer: Peer, text: string, quoted?: RawMessage): Promise<StoredMessage> {
        return this.deliver(peer, text, () => this.gateway.sendText(peer.jid, text, quoted));
    }

    /** Sends a file; the "typing…" time follows the caption length. */
    async sendMedia(peer: Peer, media: OutgoingMedia, quoted?: RawMessage): Promise<StoredMessage> {
        return this.deliver(peer, media.caption ?? '', () => this.gateway.sendMedia(peer.jid, media, quoted));
    }

    /** Reacts to a message ('' removes the reaction). Rate limited, no typing delay. */
    async react(peer: Peer, target: MessageKey, emoji: string): Promise<void> {
        this.limiter.check();
        this.limiter.record();
        const sent = await this.gateway.sendReaction(peer.jid, target, emoji);
        if (!sent) throw new SendError('WhatsApp did not confirm the reaction.');
        this.recorder.saveSent(sent); // stores our own reaction
    }

    private async deliver(peer: Peer, typingText: string, send: () => Promise<RawMessage | undefined>): Promise<StoredMessage> {
        this.limiter.check();
        // Reserve the slot before the delay so concurrent calls can't bypass the limit.
        this.limiter.record();

        const delay = typingDelayMs(typingText, this.typing);
        if (delay > 0) {
            // Typing presence is cosmetic: never fail a send because of it.
            await this.gateway.setTyping(peer.jid, true).catch(() => undefined);
            await this.sleep(delay);
            await this.gateway.setTyping(peer.jid, false).catch(() => undefined);
        }

        const sent = await send();
        if (!sent) throw new SendError('WhatsApp did not confirm the message.');
        const stored = this.recorder.saveSent(sent);
        if (!stored) throw new SendError('Message was sent but could not be stored.');
        return stored;
    }
}
