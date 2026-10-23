import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMediaContent, mediaKindFor } from '../../../src/whatsapp/content.js';
import { parsePhoneInput } from '../../../src/whatsapp/jid.js';
import { describeMessage } from '../../../src/whatsapp/parser.js';

describe('whatsapp/content', () => {
    it('decides how a file is shown in WhatsApp', () => {
        assert.equal(mediaKindFor('image/png'), 'image');
        assert.equal(mediaKindFor('image/gif'), 'document');
        assert.equal(mediaKindFor('video/mp4'), 'video');
        assert.equal(mediaKindFor('audio/mpeg'), 'audio');
        assert.equal(mediaKindFor('audio/ogg', true), 'voice');
        assert.equal(mediaKindFor('application/zip'), 'document');
    });

    it('builds Baileys content per kind', () => {
        const data = Buffer.from('x');
        assert.deepEqual(Object.keys(buildMediaContent({ data, mimeType: 'image/jpeg', caption: 'c' }).content).sort(), [
            'caption',
            'image',
            'mimetype',
        ]);
        const voice = buildMediaContent({ data, mimeType: 'audio/mpeg', voiceNote: true }).content as { ptt: boolean; mimetype: string };
        assert.equal(voice.ptt, true);
        assert.equal(voice.mimetype, 'audio/ogg; codecs=opus');
        const doc = buildMediaContent({ data, mimeType: 'application/pdf' }).content as { fileName: string };
        assert.equal(doc.fileName, 'file.pdf');
    });
});

describe('whatsapp/parser', () => {
    it('parses media metadata from incoming messages', () => {
        const parsed = describeMessage({
            documentMessage: { mimetype: 'application/pdf', fileName: 'a.pdf', fileLength: 1234, caption: 'see' },
        });
        assert.deepEqual(parsed?.media, {
            kind: 'document',
            mimeType: 'application/pdf',
            fileName: 'a.pdf',
            size: 1234,
            seconds: null,
            caption: 'see',
        });
        assert.equal(parsed?.text, '[document: a.pdf] see');
        assert.equal(describeMessage({ audioMessage: { ptt: true, seconds: 4 } })?.media?.kind, 'voice');
        assert.equal(describeMessage({ conversation: 'hi' })?.media, undefined);
        assert.equal(describeMessage({ protocolMessage: {} }), undefined, 'protocol payloads are ignored');
    });
});

describe('whatsapp/jid parsePhoneInput', () => {
    it('accepts numbers with a country code and rejects local ones', () => {
        assert.deepEqual(parsePhoneInput('+91 98765-43210'), { digits: '919876543210' });
        assert.deepEqual(parsePhoneInput('0091 98765 43210'), { digits: '919876543210' });
        assert.deepEqual(parsePhoneInput('919876543210'), { digits: '919876543210' });
        assert.deepEqual(parsePhoneInput('+45 12 34 56 78'), { digits: '4512345678' });
        assert.ok('error' in parsePhoneInput('9876543210'));
        assert.ok('error' in parsePhoneInput('09876543210'));
        assert.ok('error' in parsePhoneInput('+12'));
    });
});
