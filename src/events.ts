/**
 * @module events
 *
 * Application events and the shared event bus.
 *
 * Producers: the WhatsApp client (`connection.state`) and ingest (`message.received`,
 * `reaction.received`, `data.changed`).
 * Consumers: MCP sessions (notifications), the webhook dispatcher, the login page and
 * `get_new_messages` long-polling.
 *
 * Event payloads are already **agent-safe**: UUIDs and display names only, never phone
 * numbers or WhatsApp IDs. Every consumer still runs them through the privacy guard.
 */
import { TypedEventBus } from './core/events/typed-event-bus.js';

/** WhatsApp connection lifecycle: `qr` = waiting for a scan, `open` = logged in and connected. */
export type ConnectionState = 'starting' | 'qr' | 'connecting' | 'open';

/** A newly received message (from someone else, or a note-to-self typed on your phone). */
export interface IncomingMessageEvent {
    /** Global cursor value; pass to `get_new_messages` to continue after this message. */
    seq: number;
    messageId: string;
    chatId: string;
    chatName: string;
    isGroup: boolean;
    senderId: string | null;
    senderName: string;
    type: string;
    text: string;
    ts: number;
    time: string;
    replyToMessageId: string | null;
}

/** Someone reacted to a message, changed their reaction, or removed it (`emoji` = ''). */
export interface ReactionEvent {
    messageId: string;
    chatId: string;
    chatName: string;
    reactorId: string;
    reactorName: string;
    emoji: string;
    removed: boolean;
    time: string;
}

/** Event name → listener arguments. */
export interface AppEvents {
    'message.received': [IncomingMessageEvent];
    'reaction.received': [ReactionEvent];
    'connection.state': [ConnectionState];
    /** Something was stored (used to refresh UIs; fires often during history sync). */
    'data.changed': [];
}

/** The application's event bus (one instance, created in `app.ts`). */
export class EventBus extends TypedEventBus<AppEvents> {}
