import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { setup } from '../../helpers/index.js';

describe('MediaCache', () => {
    it('stores files encrypted on disk and reads them back', () => {
        const { media, dataDir } = setup();
        const id = '0b7f3c2e-6a1d-4e58-9c3b-2f8e4d6a1b90';
        media.put(id, Buffer.from('secret photo bytes'));
        const [file] = readdirSync(path.join(dataDir, 'media'));
        assert.equal(file, `${id}.bin`);
        assert.ok(!readFileSync(path.join(dataDir, 'media', file)).includes('secret photo bytes'));
        assert.equal(media.get(id)?.toString(), 'secret photo bytes');
        media.clear();
        assert.equal(media.get(id), undefined);
    });

    it('rejects ids that are not UUIDs (no path traversal)', () => {
        const { media } = setup();
        assert.throws(() => media.get('../../etc/passwd'));
    });
});
