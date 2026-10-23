/**
 * @module whatsapp/client
 *
 * The Baileys-backed implementation of {@link WhatsAppGateway}. Owns the WhatsApp Web
 * socket and its lifecycle:
 *  - QR login (`state = 'qr'`, QR exposed as a data URL for the login page),
 *  - a persistent, encrypted session (`EncryptedAuthStore`), reused across restarts,
 *  - reconnects with exponential backoff,
 *  - logout handling (wipes all account data via `onLoggedOut`).
 *
 * Incoming data is handled by the Ingestor; this class only connects it to the socket.
 *
 * WhatsApp quirks handled here (do not "simplify" them away):
 *  - Keep Baileys' default browser identity: `Browsers.macOS('Desktop')` is rejected with 428.
 *  - Close code 515 ("restart required") is normal right after a QR scan: reconnect immediately.
 *  - Every outgoing message gets an id we generate and register with the Ingestor first,
 *    so our own sends are never mistaken for notes-to-self (prevents agent reply loops).
 */
import makeWASocket, {
    DisconnectReason,
    downloadMediaMessage,
    generateMessageIDV2,
    type AnyMessageContent,
    type ConnectionState as BaileysConnectionState,
    type WASocket,
} from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { NotConnectedError } from '../core/errors.js';
import type { ConnectionState, EventBus } from '../events.js';
import type { Logger } from '../logger.js';
import type { EncryptedAuthStore } from '../store/auth-state.js';
import { buildMediaContent, type OutgoingMedia } from './content.js';
import type { Me, MessageKey, RawMessage, WhatsAppGateway } from './gateway.js';
import type { Ingestor } from './ingest.js';
import { jidToDigits, normalizeJid } from './jid.js';

export interface WhatsAppClientOptions {
    auth: EncryptedAuthStore;
    ingest: Ingestor;
    bus: EventBus;
    logger: Logger;
    /** Log level for Baileys' own (very chatty) logger. */
    baileysLogLevel: string;
    /** Called after WhatsApp reports a logout; must wipe all account data. */
    onLoggedOut: () => void;
}

const MAX_RECONNECT_DELAY_MS = 30_000;

export class WhatsAppClient implements WhatsAppGateway {
    state: ConnectionState = 'starting';
    /** Current QR code as a PNG data URL while `state === 'qr'`; otherwise null. */
    qrDataUrl: string | null = null;
    me: Me | null = null;

    private sock?: WASocket;
    private retries = 0;
    private stopped = false;
    private reconnectTimer?: NodeJS.Timeout;
    private readonly baileysLogger;

    constructor(private readonly opts: WhatsAppClientOptions) {
        this.baileysLogger = pino({ level: opts.baileysLogLevel });
    }

    get connected() {
        return this.state === 'open' && Boolean(this.sock);
    }

    /** Connects (showing a QR if there is no saved session). */
    async start() {
        this.stopped = false;
        this.connect();
    }

    /** Disconnects without logging out; the session stays saved. */
    async stop() {
        this.stopped = true;
        clearTimeout(this.reconnectTimer);
        this.sock?.end(undefined);
        this.sock = undefined;
    }

    /** Unlinks this device from WhatsApp; the close(loggedOut) handler wipes data and shows a new QR. */
    async logout() {
        if (this.sock && this.state === 'open') {
            await this.sock.logout();
            return;
        }
        await this.stop();
        this.opts.onLoggedOut();
        this.stopped = false;
        this.setState('connecting');
        this.connect();
    }

    // ---- WhatsAppGateway ----

    async sendText(jid: string, text: string, quoted?: RawMessage) {
        return this.sendContent(jid, { text }, quoted);
    }

    async sendMedia(jid: string, media: OutgoingMedia, quoted?: RawMessage) {
        return this.sendContent(jid, buildMediaContent(media).content, quoted);
    }

    async sendReaction(jid: string, target: MessageKey, emoji: string) {
        return this.sendContent(jid, { react: { text: emoji, key: target } });
    }

    async setTyping(jid: string, typing: boolean) {
        await this.socket().sendPresenceUpdate(typing ? 'composing' : 'paused', jid);
    }

    async markRead(keys: MessageKey[]) {
        await this.socket().readMessages(keys);
    }

    async downloadMedia(message: RawMessage): Promise<Buffer> {
        const sock = this.socket();
        // reuploadRequest asks the sender's phone to re-upload media whose CDN link expired.
        return downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage, logger: this.baileysLogger });
    }

    async lookupPhone(digits: string) {
        const [result] = (await this.socket().onWhatsApp(digits)) ?? [];
        return result?.exists ? normalizeJid(result.jid) : undefined;
    }

    async newChatQuota() {
        try {
            const cap = await this.socket().fetchNewChatMessageCap();
            return cap.total_quota != null ? { total: cap.total_quota, used: cap.used_quota ?? 0 } : null;
        } catch {
            return null; // not offered for every account
        }
    }

    // ---- Internals ----

    private setState(state: ConnectionState) {
        this.state = state;
        if (state !== 'qr') this.qrDataUrl = null;
        this.opts.bus.emit('connection.state', state);
    }

    private socket(): WASocket {
        if (!this.connected || !this.sock) throw new NotConnectedError();
        return this.sock;
    }

    /** Sends any Baileys payload with an id registered as "ours" first (see module docs). */
    private async sendContent(jid: string, content: AnyMessageContent, quoted?: RawMessage) {
        const sock = this.socket();
        const messageId = generateMessageIDV2(sock.user?.id);
        this.opts.ingest.markOutgoing(messageId);
        return sock.sendMessage(jid, content, { messageId, ...(quoted ? { quoted } : {}) });
    }

    private connect() {
        const { state: auth, saveCreds } = this.opts.auth.load();
        const sock = makeWASocket({
            auth,
            logger: this.baileysLogger,
            syncFullHistory: true,
            markOnlineOnConnect: false, // don't make the account look "online" just because the server runs
        });
        this.sock = sock;
        if (this.state !== 'qr') this.setState('connecting');

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', (update) => void this.onConnectionUpdate(sock, update));
        this.opts.ingest.attach(sock);
    }

    private async onConnectionUpdate(sock: WASocket, update: Partial<BaileysConnectionState>) {
        if (sock !== this.sock) return; // event from a socket we already replaced
        const { logger } = this.opts;

        if (update.qr) {
            this.qrDataUrl = await QRCode.toDataURL(update.qr, { margin: 1, width: 320 });
            this.setState('qr');
            logger.info('waiting for QR scan (open the login link)');
        }

        if (update.connection === 'open') {
            this.retries = 0;
            const jid = normalizeJid(sock.user?.id ?? '');
            this.me = { jid, phone: jidToDigits(jid) ?? null, name: sock.user?.name ?? sock.user?.notify ?? null };
            this.opts.ingest.setSelf(jid, sock.user?.lid);
            this.setState('open');
            logger.info('WhatsApp connected');
        }

        if (update.connection === 'close') {
            const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
            this.sock = undefined;
            this.me = null;
            if (this.stopped) return;

            if (code === DisconnectReason.loggedOut) {
                logger.warn('WhatsApp session logged out; wiping account data');
                this.opts.onLoggedOut();
                this.setState('connecting');
                this.connect();
                return;
            }

            const restart = code === DisconnectReason.restartRequired; // expected after a QR scan
            const delay = restart ? 0 : Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** this.retries++);
            if (!restart) logger.warn({ code, delayMs: delay }, 'WhatsApp connection closed; reconnecting');
            if (this.state !== 'qr') this.setState('connecting');
            this.reconnectTimer = setTimeout(() => this.connect(), delay);
        }
    }
}
