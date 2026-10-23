import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { UserError } from '../../../src/core/errors.js';
import { decodeBase64, extensionForMime, mimeFromFileName, readAllowedFile } from '../../../src/core/files/uploads.js';

describe('uploads', () => {
    it('guesses mime types from file names and extensions from mime types', () => {
        assert.equal(mimeFromFileName('a.JPG'), 'image/jpeg');
        assert.equal(mimeFromFileName('report.pdf'), 'application/pdf');
        assert.equal(mimeFromFileName('noext'), 'application/octet-stream');
        assert.equal(mimeFromFileName(undefined), 'application/octet-stream');
        assert.equal(extensionForMime('application/pdf'), 'pdf');
        assert.equal(extensionForMime('audio/ogg; codecs=opus'), 'ogg');
        assert.equal(extensionForMime('x/unknown'), 'bin');
    });

    it('decodes base64 (data: URLs allowed) with size limits', () => {
        assert.equal(decodeBase64('data:text/plain;base64,aGk=', 10).toString(), 'hi');
        assert.throws(() => decodeBase64('aGVsbG8gd29ybGQ=', 5), /larger than/);
        assert.throws(() => decodeBase64('', 5), /empty/);
        assert.throws(() => decodeBase64('!!!', 5), UserError);
    });

    it('reads files only from inside the allowed directory', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'wa-uploads-'));
        const sendDir = path.join(root, 'send');
        mkdirSync(sendDir);
        writeFileSync(path.join(sendDir, 'ok.txt'), 'hello');
        writeFileSync(path.join(root, 'secret.env'), 'API_KEY=x');
        symlinkSync(path.join(root, 'secret.env'), path.join(sendDir, 'link.env'));

        assert.equal(readAllowedFile('ok.txt', sendDir, 100).data.toString(), 'hello');
        assert.throws(() => readAllowedFile('../secret.env', sendDir, 100), /outside/);
        assert.throws(() => readAllowedFile('link.env', sendDir, 100), /outside/, 'symlinks are resolved');
        assert.throws(() => readAllowedFile('missing.txt', sendDir, 100), /not found/);
        assert.throws(() => readAllowedFile('ok.txt', sendDir, 2), /larger than/);
        assert.throws(() => readAllowedFile('ok.txt', undefined, 100), /disabled/);
    });
});
