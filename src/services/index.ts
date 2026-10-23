/**
 * @module services
 *
 * The application layer: business logic that doesn't depend on MCP or HTTP.
 * Tools, webhooks or a future CLI all call these services.
 *
 * {@link createServices} wires them together from stores and the WhatsApp gateway;
 * `app.ts` calls it once at start-up (tests call it with a fake gateway).
 */
import type { EventBus } from '../events.js';
import type { PrivacyGuard } from '../privacy/guard.js';
import type { MediaCache } from '../store/media-cache.js';
import type { MessageStore } from '../store/messages.js';
import type { PeerStore } from '../store/peers.js';
import type { SentMessageRecorder, WhatsAppGateway } from '../whatsapp/gateway.js';
import { ChatResolver } from './chat-resolver.js';
import { ChatsService } from './chats.service.js';
import { InboxService } from './inbox.service.js';
import { createNewChatLimiter, createSendLimiter } from './limits.js';
import { MediaService } from './media.service.js';
import { MessagingService } from './messaging.service.js';
import { Sender, type TypingSettings } from './sender.js';
import { StatusService } from './status.service.js';

export interface ServiceDeps {
    wa: WhatsAppGateway;
    recorder: SentMessageRecorder;
    peers: PeerStore;
    messages: MessageStore;
    mediaCache: MediaCache;
    bus: EventBus;
    guard: PrivacyGuard;
    settings: TypingSettings & {
        SEND_MIN_INTERVAL_MS: number;
        SEND_MAX_PER_HOUR: number;
        NEW_CHAT_MAX_PER_DAY: number;
        ALLOW_SEND_TO_PHONE: boolean;
        MEDIA_MAX_BYTES: number;
        MEDIA_SEND_DIR?: string;
    };
    /** Injectable delay for the typing indicator (tests pass a no-op). */
    sleep?: (ms: number) => Promise<void>;
}

/** All services, ready to use. */
export interface Services {
    resolver: ChatResolver;
    chats: ChatsService;
    inbox: InboxService;
    messaging: MessagingService;
    media: MediaService;
    status: StatusService;
}

export function createServices(deps: ServiceDeps): Services {
    const { wa, peers, messages, settings } = deps;
    const resolver = new ChatResolver(peers, messages, wa, deps.guard, { allowSendToPhone: settings.ALLOW_SEND_TO_PHONE });
    const sendLimiter = createSendLimiter({ minIntervalMs: settings.SEND_MIN_INTERVAL_MS, maxPerHour: settings.SEND_MAX_PER_HOUR });
    const sender = new Sender(wa, deps.recorder, sendLimiter, settings, deps.sleep);
    const media = new MediaService(messages, deps.mediaCache, wa, { maxBytes: settings.MEDIA_MAX_BYTES, sendDir: settings.MEDIA_SEND_DIR });
    const messaging = new MessagingService({
        peers,
        messages,
        wa,
        resolver,
        sender,
        media,
        newChats: createNewChatLimiter(settings.NEW_CHAT_MAX_PER_DAY),
    });
    return {
        resolver,
        chats: new ChatsService(peers, resolver, wa),
        inbox: new InboxService(peers, messages, wa, deps.bus, resolver),
        messaging,
        media,
        status: new StatusService(wa, peers, messages, messaging),
    };
}

export type { ChatResolver, ChatsService, InboxService, MessagingService, MediaService, StatusService };
