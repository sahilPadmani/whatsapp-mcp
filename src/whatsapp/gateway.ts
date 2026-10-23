/**
 * @module whatsapp/gateway
 *
 * The contract between the application and WhatsApp.
 *
 * Services depend on {@link WhatsAppGateway}, never on Baileys directly. That keeps
 * business logic testable with a fake gateway, and makes the protocol library
 * replaceable (e.g. a whatsmeow or Rust bridge) by writing one new implementation.
 * The real implementation is `WhatsAppClient` in `client.ts`.
 *
 * Raw protocol types are re-exported here under neutral names so that layers above
 * `whatsapp/` never import from 'baileys' themselves.
 */
import type { WAMessage, WAMessageKey } from 'baileys';
import type { ConnectionState } from '../events.js';
import type { StoredMessage } from '../store/messages.js';
import type { OutgoingMedia } from './content.js';

/** A full WhatsApp message as received from or sent to WhatsApp (needed for quoting/downloads). */
export type RawMessage = WAMessage;
/** Identifies one WhatsApp message (chat, id, sender); used for read receipts and reactions. */
export type MessageKey = WAMessageKey;

/** The logged-in account. Never sent over MCP. */
export interface Me {
    jid: string;
    /** Digits only. Used inside the server (privacy guard), never returned to callers. */
    phone: string | null;
    name: string | null;
}

/** Everything the application needs from WhatsApp. */
export interface WhatsAppGateway {
    readonly state: ConnectionState;
    readonly connected: boolean;
    readonly me: Me | null;

    /** Sends a text message, optionally quoting `quoted`. */
    sendText(jid: string, text: string, quoted?: RawMessage): Promise<RawMessage | undefined>;
    /** Sends a photo, video, audio, voice note or document. */
    sendMedia(jid: string, media: OutgoingMedia, quoted?: RawMessage): Promise<RawMessage | undefined>;
    /** Reacts to `target` with `emoji`; an empty emoji removes the reaction. */
    sendReaction(jid: string, target: MessageKey, emoji: string): Promise<RawMessage | undefined>;
    /** Shows or hides "typing…" in a chat. */
    setTyping(jid: string, typing: boolean): Promise<void>;
    /** Sends read receipts (blue ticks). */
    markRead(keys: MessageKey[]): Promise<void>;
    /** Downloads and decrypts the file attached to a message (re-requests expired media). */
    downloadMedia(message: RawMessage): Promise<Buffer>;
    /** The JID WhatsApp uses for a phone number (digits), or undefined if it has no WhatsApp account. */
    lookupPhone(digits: string): Promise<string | undefined>;
    /** WhatsApp's own quota for messaging new contacts, when the account has one. */
    newChatQuota(): Promise<{ total: number; used: number } | null>;
}

/** Stores a message this server just sent and returns the stored row (implemented by `Ingestor`). */
export interface SentMessageRecorder {
    saveSent(message: RawMessage): StoredMessage | undefined;
}
