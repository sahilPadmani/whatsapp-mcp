/**
 * @module whatsapp/jid
 *
 * Helpers for WhatsApp IDs ("JIDs"):
 *  - `919876543210@s.whatsapp.net`: a person, by phone number;
 *  - `123456789@lid`: a person, by "LID" (WhatsApp's privacy id, mapped to a number later);
 *  - `…@g.us`: a group; `status@broadcast`, `…@newsletter`: ignored.
 * JIDs never leave the server.
 */
import { isJidGroup, isLidUser, isPnUser, jidNormalizedUser } from 'baileys';

export { isJidGroup, isLidUser, isPnUser };

export const normalizeJid = (jid: string) => jidNormalizedUser(jid) || jid;

/** "919876543210@s.whatsapp.net" → "919876543210"; undefined for groups, LIDs, etc. */
export function jidToDigits(jid: string | null | undefined): string | undefined {
    if (!jid || !isPnUser(jid)) return undefined;
    return normalizeJid(jid).split('@')[0];
}

/**
 * Parses a phone number given as send input. It must include the country code:
 * "+91 98765 43210", "0091…", or at least 11 digits ("919876543210").
 */
export function parsePhoneInput(value: string): { digits: string } | { error: string } {
    const trimmed = value.trim();
    const hasPrefix = trimmed.startsWith('+') || trimmed.startsWith('00');
    const digits = trimmed
        .replace(/[\s().-]/g, '')
        .replace(/^\+/, '')
        .replace(/^00/, '');
    if (!/^\d+$/.test(digits)) return { error: 'Not a valid phone number.' };
    if (digits.startsWith('0') || (!hasPrefix && digits.length < 11)) {
        return { error: 'Include the country code: +<country code><number>.' };
    }
    if (digits.length < 8 || digits.length > 15) return { error: 'Not a valid phone number.' };
    return { digits };
}

/** Chats that aren't conversations with a person or group. */
export const isIgnoredJid = (jid: string) => jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast');
