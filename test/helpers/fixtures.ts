/**
 * Test fixtures: fictional WhatsApp ids and builders for raw WhatsApp messages.
 * All numbers here are made up; tests never contact real WhatsApp.
 */
import type { WAMessage, WAMessageKey } from 'baileys';

export const ME = '919000000001@s.whatsapp.net';
export const ME_LID = '900000000000001@lid';
export const ALICE = '919876543210@s.whatsapp.net';
export const BOB = '14155550123@s.whatsapp.net';
export const CAROL = '919811122233@s.whatsapp.net';
export const ALICE_LID = '123456789012345@lid';
export const GROUP = '120363000000000001@g.us';

/** Digits of every fictional number above (for leak scans). */
export const PHONES = ['919876543210', '14155550123', '919000000001', '919811122233'];

let counter = 0;

/** Builds a raw text message as Baileys would deliver it. */
export function waMessage(opts: {
    chat: string;
    text: string;
    id?: string;
    fromMe?: boolean;
    ts?: number;
    participant?: string;
    pushName?: string;
    quotedId?: string;
    remoteJidAlt?: string;
}): WAMessage {
    const key: WAMessageKey = {
        remoteJid: opts.chat,
        id: opts.id ?? `MSG${++counter}`,
        fromMe: opts.fromMe ?? false,
        participant: opts.participant,
        remoteJidAlt: opts.remoteJidAlt,
    };
    return {
        key,
        message: opts.quotedId
            ? { extendedTextMessage: { text: opts.text, contextInfo: { stanzaId: opts.quotedId } } }
            : { conversation: opts.text },
        messageTimestamp: opts.ts ?? Math.floor(Date.now() / 1000),
        pushName: opts.pushName,
    } as WAMessage;
}

/** Builds a raw reaction message (emoji '' = reaction removed). */
export function reactionMessage(opts: {
    chat: string;
    targetId: string;
    emoji: string;
    id?: string;
    fromMe?: boolean;
    participant?: string;
    ms?: number;
}): WAMessage {
    const m = waMessage({ chat: opts.chat, id: opts.id, text: '', fromMe: opts.fromMe, participant: opts.participant });
    m.message = {
        reactionMessage: { key: { remoteJid: opts.chat, id: opts.targetId }, text: opts.emoji, senderTimestampMs: opts.ms ?? Date.now() },
    };
    return m;
}
