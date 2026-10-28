import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

test('bundled math renderer and every font match the verified package manifest', async () => {
    const root = new URL('../vendor/mathlive/', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
    assert.equal(manifest.version, '0.111.1');
    assert.equal(manifest.license, 'MIT');
    assert.ok(manifest.files.some(file => file.path === 'mathlive.min.js'));
    assert.ok(manifest.files.filter(file => file.path.endsWith('.woff2')).length >= 20);
    for (const entry of manifest.files) {
        assert.match(entry.path, /^(?:[\w.-]+|fonts\/[\w.-]+\.woff2)$/);
        const data = await readFile(new URL(entry.path, root));
        assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256, entry.path);
    }
    assert.match(await readFile(new URL('LICENSE.txt', root),'utf8'), /Permission is hereby granted, free of charge/);
});
