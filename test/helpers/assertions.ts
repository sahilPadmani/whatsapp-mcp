/**
 * Leak scan used across tests: finds phone numbers or WhatsApp IDs anywhere in a
 * JSON-able value, except in message-content fields (which may legitimately contain them).
 */
const CONTENT_FIELDS = ['text', 'preview', 'lastMessage', 'caption', 'fileName'];

/** @returns paths of fields that contain a JID or one of `phones` (also without country code). */
export function findIdentifiers(value: unknown, phones: string[]): string[] {
    const hits: string[] = [];
    const walk = (v: unknown, key: string | null, path: string) => {
        if (key && CONTENT_FIELDS.includes(key)) return;
        if (typeof v === 'string') {
            if (/@(s\.whatsapp\.net|lid|g\.us|c\.us)/.test(v)) hits.push(`${path}: jid`);
            const digits = v.replace(/[^\d]/g, '');
            if (phones.some((p) => digits.includes(p) || digits.includes(p.slice(2)))) hits.push(`${path}: phone`);
        } else if (typeof v === 'number') {
            if (phones.includes(String(v))) hits.push(`${path}: phone number value`);
        } else if (Array.isArray(v)) v.forEach((item, i) => walk(item, key, `${path}[${i}]`));
        else if (v && typeof v === 'object') for (const [k, item] of Object.entries(v)) walk(item, k, `${path}.${k}`);
    };
    walk(value, null, '$');
    return hits;
}
