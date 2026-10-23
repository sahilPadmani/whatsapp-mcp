/**
 * A fake WhatsApp gateway that records what would have been sent. Lets services, tools
 * and the whole app be tested without a WhatsApp account or network.
 */
import type { AnyMessageContent, WAMessage, WAMessageKey } from 'baileys';
import type { ManagedGateway } from '../../src/app.js';
import { buildMediaContent, type OutgoingMedia } from '../../src/whatsapp/content.js';
import type { Me } from '../../src/whatsapp/gateway.js';
import { ME, waMessage } from './fixtures.js';

export class FakeGateway implements ManagedGateway {
    state: ManagedGateway['state'] = 'open';
    qrDataUrl: string | null = null;
    me: Me | null = { jid: ME, phone: '919000000001', name: 'Me' };

    /** Everything sent, with the Baileys payload the real client would have built. */
    sent: Array<{ jid: string; text: string; content: AnyMessageContent; quoted?: WAMessage }> = [];
    typing: Array<{ jid: string; typing: boolean }> = [];
    read: WAMessageKey[] = [];
    downloads: string[] = [];
    lookups: string[] = [];
    /** Phone numbers (digits) that "have WhatsApp". */
    registered = new Set<string>(['919876543210', '14155550123', '447700900456']);
    /** WhatsApp's new-contact quota to report (null = none). */
    quota: { total: number; used: number } | null = null;
    /** Bytes returned by downloadMedia, by WhatsApp message id. */
    files = new Map<string, Buffer>();
    started = false;

    get connected() {
        return this.state === 'open';
    }

    async start() {
        this.started = true;
    }

    async stop() {
        this.started = false;
    }

    async sendText(jid: string, text: string, quoted?: WAMessage) {
        return this.record(jid, { text }, quoted);
    }

    async sendMedia(jid: string, media: OutgoingMedia, quoted?: WAMessage) {
        return this.record(jid, buildMediaContent(media).content, quoted);
    }

    async sendReaction(jid: string, target: WAMessageKey, emoji: string) {
        return this.record(jid, { react: { text: emoji, key: target } });
    }

    async lookupPhone(digits: string) {
        this.lookups.push(digits);
        return this.registered.has(digits) ? `${digits}@s.whatsapp.net` : undefined;
    }

    async newChatQuota() {
        return this.quota;
    }

    async downloadMedia(message: WAMessage) {
        this.downloads.push(message.key.id!);
        const file = this.files.get(message.key.id!);
        if (!file) throw new Error('media not available');
        return file;
    }

    async setTyping(jid: string, typing: boolean) {
        this.typing.push({ jid, typing });
    }

    async markRead(keys: WAMessageKey[]) {
        this.read.push(...keys);
    }

    /** Records the send and returns the message WhatsApp would echo back. */
    private record(jid: string, content: AnyMessageContent, quoted?: WAMessage): WAMessage {
        const c = content as Record<string, unknown>;
        const text = typeof c.text === 'string' ? c.text : String(c.caption ?? '');
        this.sent.push({ jid, text, content, quoted });
        const msg = waMessage({ chat: jid, text, fromMe: true, id: `SENT${this.sent.length}`, quotedId: quoted?.key.id ?? undefined });
        const mimetype = c.mimetype as string | undefined;
        const size = (b: unknown) => (b as Buffer).length;
        if (c.react) msg.message = { reactionMessage: c.react as { text: string; key: WAMessageKey } };
        if (c.image) msg.message = { imageMessage: { mimetype, caption: c.caption as string, fileLength: size(c.image) } };
        if (c.document) msg.message = { documentMessage: { mimetype, fileName: c.fileName as string, fileLength: size(c.document) } };
        if (c.audio) msg.message = { audioMessage: { mimetype, ptt: Boolean(c.ptt), fileLength: size(c.audio) } };
        if (c.video) msg.message = { videoMessage: { mimetype, caption: c.caption as string, fileLength: size(c.video) } };
        return msg;
    }
}
