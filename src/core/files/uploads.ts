/**
 * @module core/files/uploads
 *
 * Helpers for files that callers hand to the server: MIME type guessing, safe reading
 * from an allow-listed directory, and size-checked base64 decoding. Nothing here is
 * WhatsApp-specific.
 *
 * Security: {@link readAllowedFile} is the only way a caller can make the server read a
 * file from disk. It resolves symlinks and refuses anything outside the configured
 * directory, so an agent can't send `.env`, keys or other private files.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { UserError } from '../errors.js';

const MIME_BY_EXT: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    '3gp': 'video/3gpp',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg; codecs=opus',
    opus: 'audio/ogg; codecs=opus',
    wav: 'audio/wav',
    pdf: 'application/pdf',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    zip: 'application/zip',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const EXT_BY_MIME: Record<string, string> = Object.fromEntries(
    Object.entries(MIME_BY_EXT)
        .map(([ext, mime]) => [mime.split(';')[0], ext])
        .reverse(),
);

const megabytes = (bytes: number) => Math.round(bytes / 1024 / 1024);

/** "report.pdf" → "application/pdf"; unknown or missing extension → "application/octet-stream". */
export const mimeFromFileName = (fileName?: string | null): string =>
    (fileName && MIME_BY_EXT[path.extname(fileName).slice(1).toLowerCase()]) || 'application/octet-stream';

/** "application/pdf" → "pdf"; unknown → "bin". Parameters like "; codecs=opus" are ignored. */
export const extensionForMime = (mimeType?: string | null): string => (mimeType && EXT_BY_MIME[mimeType.split(';')[0].trim()]) || 'bin';

/**
 * Reads a file that a caller asked to send. Only files inside `sendDir` are allowed
 * (after resolving symlinks and `..`).
 *
 * @param filePath  path relative to `sendDir` (absolute paths are accepted only if inside it)
 * @param sendDir   allow-listed directory; undefined disables reading files entirely
 * @param maxBytes  size limit
 * @throws {UserError} when disabled, not found, outside the directory, not a file, or too large
 */
export function readAllowedFile(filePath: string, sendDir: string | undefined, maxBytes: number): { data: Buffer; fileName: string } {
    if (!sendDir) throw new UserError('Sending files by path is disabled (MEDIA_SEND_DIR is not set). Use data_base64 instead.');
    let root: string;
    let resolved: string;
    try {
        root = realpathSync(sendDir);
        resolved = realpathSync(path.resolve(root, filePath));
    } catch {
        throw new UserError('File not found in the media send directory.');
    }
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new UserError('File is outside the media send directory.');
    const stat = statSync(resolved);
    if (!stat.isFile()) throw new UserError('Not a file.');
    if (stat.size > maxBytes) throw new UserError(`File is larger than the ${megabytes(maxBytes)} MB limit.`);
    return { data: readFileSync(resolved), fileName: path.basename(resolved) };
}

/**
 * Decodes base64 file data (a `data:<mime>;base64,` prefix is allowed).
 * @throws {UserError} if it isn't valid base64, is empty, or exceeds `maxBytes`
 */
export function decodeBase64(data: string, maxBytes: number): Buffer {
    const clean = data.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new UserError('data_base64 is not valid base64.');
    const buffer = Buffer.from(clean, 'base64');
    if (buffer.length === 0) throw new UserError('data_base64 is empty.');
    if (buffer.length > maxBytes) throw new UserError(`File is larger than the ${megabytes(maxBytes)} MB limit.`);
    return buffer;
}
