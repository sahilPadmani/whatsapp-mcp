/**
 * Architecture rules, enforced by scanning imports. If this fails, a module reached
 * across a layer boundary; see docs/ARCHITECTURE.md for the rules and why they exist.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

/** All .ts files under src, as paths relative to src (e.g. "services/inbox.service.ts"). */
function sourceFiles(dir = SRC): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith('.ts') ? [path.relative(SRC, full)] : [];
    });
}

/** Import specifiers of a file: package names as-is, relative imports resolved to src-relative paths. */
function importsOf(file: string): string[] {
    const text = readFileSync(path.join(SRC, file), 'utf8');
    return [...text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)].map(([, spec]) =>
        spec.startsWith('.') ? path.relative(SRC, path.resolve(path.dirname(path.join(SRC, file)), spec)).replace(/\.js$/, '.ts') : spec,
    );
}

const files = sourceFiles();
const inLayer = (layer: string) => files.filter((f) => f.startsWith(`${layer}/`));
const violations = (layerFiles: string[], forbidden: (imp: string) => boolean) =>
    layerFiles.flatMap((f) =>
        importsOf(f)
            .filter(forbidden)
            .map((imp) => `${f} → ${imp}`),
    );

describe('architecture', () => {
    it('core/ is generic: imports nothing from the application', () => {
        assert.deepEqual(
            violations(inLayer('core'), (imp) => !imp.startsWith('core/') && !imp.startsWith('node:') && imp.includes('/')),
            [],
        );
    });

    it("only whatsapp/ and store/ import 'baileys'", () => {
        const allowed = (f: string) => f.startsWith('whatsapp/') || f.startsWith('store/');
        assert.deepEqual(
            violations(
                files.filter((f) => !allowed(f)),
                (imp) => imp === 'baileys',
            ),
            [],
        );
    });

    it('only store/, core/ and app.ts touch the database', () => {
        const allowed = (f: string) => f.startsWith('store/') || f.startsWith('core/') || f === 'app.ts' || f === 'whatsapp/ingest.ts';
        assert.deepEqual(
            violations(
                files.filter((f) => !allowed(f)),
                (imp) => imp === 'core/db/database.ts' || imp === 'node:sqlite',
            ),
            [],
        );
    });

    it('services/ depend on the gateway interface, never on the Baileys client', () => {
        assert.deepEqual(
            violations(
                inLayer('services'),
                (imp) => imp === 'whatsapp/client.ts' || imp === 'whatsapp/ingest.ts' || imp.startsWith('mcp/'),
            ),
            [],
        );
    });

    it('mcp/ and http/ never reach into WhatsApp internals or the database', () => {
        assert.deepEqual(
            violations([...inLayer('mcp'), ...inLayer('http'), ...inLayer('integrations')], (imp) =>
                ['whatsapp/client.ts', 'whatsapp/ingest.ts', 'core/db/database.ts', 'baileys'].includes(imp),
            ),
            // http/app.ts only uses the WhatsAppClient *type* for its state/QR fields.
            ['http/app.ts → whatsapp/client.ts'],
        );
    });

    it('every source file starts with a module doc comment', () => {
        const missing = files.filter((f) => !readFileSync(path.join(SRC, f), 'utf8').trimStart().startsWith('/**'));
        assert.deepEqual(missing, []);
    });
});
