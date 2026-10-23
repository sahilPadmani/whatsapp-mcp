import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { ALICE, findIdentifiers, PHONES, waMessage } from '../../helpers/index.js';
import { createHarness, type Harness } from './harness.js';

/** A valid 1×1 PNG. */
const PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082',
    'hex',
);

describe('toolset: media', () => {
    let h: Harness;
    beforeEach(async () => {
        h = await createHarness();
    });

    it('lists media metadata on messages and returns an image block from get_media (then caches it)', async () => {
        const photo = waMessage({ chat: ALICE, id: 'IMG1', text: '' });
        photo.message = { imageMessage: { mimetype: 'image/png', caption: 'look at this', fileLength: PNG.length } };
        h.ingest.saveMessages([photo], true);
        h.gw.files.set('IMG1', PNG);

        const { data } = await h.call('get_messages', { chat: 'Alice' });
        const msg = data.messages.at(-1);
        assert.equal(msg.type, 'image');
        assert.equal(msg.media.kind, 'image');
        assert.equal(msg.media.caption, 'look at this');

        const out = await h.call('get_media', { message_id: msg.id });
        assert.equal(out.isError, false, out.text);
        assert.equal(out.blocks[1].type, 'image');
        assert.equal(out.blocks[1].mimeType, 'image/png');
        assert.deepEqual(Buffer.from(out.blocks[1].data!, 'base64'), PNG);

        await h.call('get_media', { message_id: msg.id });
        assert.equal(h.gw.downloads.length, 1, 'second call served from the encrypted cache');
    });

    it('returns voice notes as audio and documents as embedded files', async () => {
        const voice = waMessage({ chat: ALICE, id: 'VN1', text: '' });
        voice.message = { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 3 } };
        const doc = waMessage({ chat: ALICE, id: 'DOC1', text: '' });
        doc.message = { documentMessage: { mimetype: 'application/pdf', fileName: 'invoice-9876543210.pdf' } };
        h.ingest.saveMessages([voice, doc], true);
        h.gw.files.set('VN1', Buffer.from('OggS-fake'));
        h.gw.files.set('DOC1', Buffer.from('%PDF-1.4 fake'));
        const { data } = await h.call('get_messages', { chat: 'Alice' });
        const [vn, pdf] = data.messages.slice(-2);
        assert.equal(vn.media.kind, 'voice');
        assert.equal(pdf.media.fileName, 'invoice-9876543210.pdf', 'file names are content and pass through');

        const audio = await h.call('get_media', { message_id: vn.id });
        assert.equal(audio.blocks[1].type, 'audio');
        assert.equal(audio.blocks[1].mimeType, 'audio/ogg');
        const file = await h.call('get_media', { message_id: pdf.id });
        assert.equal(file.blocks[1].type, 'resource');
        assert.equal(file.blocks[1].resource!.mimeType, 'application/pdf');
        assert.equal(Buffer.from(file.blocks[1].resource!.blob, 'base64').toString(), '%PDF-1.4 fake');
        assert.deepEqual(findIdentifiers(file.data, PHONES), []);
    });

    it('rejects get_media for text messages, oversized files and failed downloads', async () => {
        const { data } = await h.call('get_messages', { chat: 'Alice' });
        assert.match((await h.call('get_media', { message_id: data.messages[0].id })).text, /no media/);

        const big = waMessage({ chat: ALICE, id: 'BIG', text: '' });
        big.message = { videoMessage: { mimetype: 'video/mp4', fileLength: 50 * 1024 * 1024 } };
        const gone = waMessage({ chat: ALICE, id: 'GONE', text: '' });
        gone.message = { imageMessage: { mimetype: 'image/jpeg' } };
        h.ingest.saveMessages([big, gone], false);
        const [bigMsg, goneMsg] = (await h.call('get_messages', { chat: 'Alice' })).data.messages.slice(-2);
        assert.match((await h.call('get_media', { message_id: bigMsg.id })).text, /larger than/);
        assert.match((await h.call('get_media', { message_id: goneMsg.id })).text, /Could not download/);
    });

    it('send_media sends base64 images as photos with caption and quote', async () => {
        const { data } = await h.call('get_messages', { chat: 'Alice' });
        const out = await h.call('send_media', {
            to: 'Alice',
            data_base64: `data:image/png;base64,${PNG.toString('base64')}`,
            mime_type: 'image/png',
            caption: 'here you go',
            reply_to: data.messages.at(-1).id,
        });
        assert.equal(out.isError, false, out.text);
        const sent = h.gw.sent[0].content as { image: Buffer; caption: string };
        assert.deepEqual(sent.image, PNG);
        assert.equal(sent.caption, 'here you go');
        assert.equal(h.gw.sent[0].quoted?.key.id, 'A2');
        assert.equal(out.data.media.kind, 'image');
        const stored = (await h.call('get_messages', { chat: 'Alice' })).data.messages.at(-1);
        assert.equal(stored.media.kind, 'image');
        assert.deepEqual(findIdentifiers(out.data, PHONES), []);

        // Sent files are cached, so fetching them back needs no download.
        await h.call('get_media', { message_id: out.data.messageId });
        assert.equal(h.gw.downloads.length, 0);
    });

    it('send_media sends other files as documents and voice notes as ptt', async () => {
        await h.call('send_media', { to: 'Alice', data_base64: Buffer.from('a,b').toString('base64'), file_name: 'report.csv' });
        const doc = h.gw.sent[0].content as { document: Buffer; mimetype: string; fileName: string };
        assert.equal(doc.mimetype, 'text/csv');
        assert.equal(doc.fileName, 'report.csv');
        await h.call('send_media', {
            to: 'Alice',
            data_base64: Buffer.from('OggS').toString('base64'),
            mime_type: 'audio/ogg',
            voice_note: true,
        });
        assert.equal((h.gw.sent[1].content as { ptt: boolean }).ptt, true);
    });

    it('send_media file_path only allows files inside the send directory', async () => {
        mkdirSync(h.sendDir, { recursive: true });
        writeFileSync(path.join(h.sendDir, 'photo.png'), PNG);
        writeFileSync(path.join(h.dataDir, 'secret.env'), 'API_KEY=x');
        symlinkSync(path.join(h.dataDir, 'secret.env'), path.join(h.sendDir, 'link.env'));

        const ok = await h.call('send_media', { to: 'Alice', file_path: 'photo.png' });
        assert.equal(ok.isError, false, ok.text);
        assert.equal((h.gw.sent[0].content as { mimetype: string }).mimetype, 'image/png');

        for (const bad of ['../secret.env', path.join(h.dataDir, 'secret.env'), 'link.env', 'missing.png']) {
            assert.equal((await h.call('send_media', { to: 'Alice', file_path: bad })).isError, true, bad);
        }
        assert.equal(h.gw.sent.length, 1);
    });

    it('send_media validates input', async () => {
        assert.match((await h.call('send_media', { to: 'Alice' })).text, /exactly one/);
        assert.match((await h.call('send_media', { to: 'Alice', data_base64: '!!!' })).text, /not valid base64/);
    });
});
