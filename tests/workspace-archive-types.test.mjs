import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/workspace-fixture.mjs';

const encode = text => new TextEncoder().encode(text);
const text = (path, source, encoding = 'utf-8') => ({path, kind: 'text', text: source, encoding});
const binary = (path, bytes) => ({path, kind: 'binary', base64: Buffer.from(bytes).toString('base64')});

async function exportProject(f) {
    const count = f.blobs.length;
    await f.click('btnExportProject');
    assert.equal(f.blobs.length, count + 1, f.node('statusText').textContent);
    return new Uint8Array(await f.blobs.at(-1).arrayBuffer());
}

async function importProject(f, bytes) {
    f.node('importProject').files = [{name: 'round-trip.zip', size: bytes.length,
        arrayBuffer: async () => bytes.slice().buffer}];
    await f.emit(f.node('importProject'), 'change');
}

test('ZIP round-trip retains Latin-1 TeX, BibTeX and custom text with the original active and main file', async () => {
    const f = await fixture();
    await f.input('sourceArea', '\\documentclass{article}\r\n\\begin{document}\r\ncafé\r\n\\end{document}\r\n');
    f.prompts.push('latin1');
    await f.click('btnEncoding');
    f.app.model.add(text('legacy.bib', '@book{cafe,title={Café}}\r\n', 'latin1'));
    // These Latin-1 bytes also form valid UTF-8: detection alone changes the text.
    f.app.model.add(text('custom.source', 'Two Latin-1 characters: \u00c3\u00a9', 'latin1'));
    const expected = f.app.model.serialize();
    await importProject(f, await exportProject(f));
    assert.equal(f.app.model.serialize(), expected);
    assert.equal(f.app.model.mainPath, 'main.tex');
    assert.equal(f.app.model.activePath, 'main.tex');
    assert.equal(f.node('assetPanel').hidden, true);
    await f.click('modeSource');
    assert.equal(f.node('sourcePanel').hidden, false);
    assert.equal(f.node('btnEncoding').textContent, 'LATIN1');
});

test('ZIP round-trip preserves explicit UTF-8 text and binary kinds without changing any bytes', async () => {
    const f = await fixture();
    const files = [
        text('notes.txt', '\ufeff中文\r\ntext\r\n'),
        text('literal.pdf', 'This user-created file is text, despite its extension.'),
        text('control.source', 'Text with a literal NUL: \0 and form feed: \f'),
        binary('readable.dat', encode('ASCII bytes deliberately kept as a resource')),
        binary('image.png', Uint8Array.of(137, 80, 78, 71, 0, 255, 13, 10)),
    ];
    f.app.replaceProject(new f.context.ProjectModel({name: 'Kinds and bytes', files,
        mainPath: 'notes.txt', activePath: 'readable.dat'}));
    const expected = f.app.model.serialize();
    const original = f.app.exportEntries();
    const archive = await exportProject(f);
    await importProject(f, archive);
    assert.equal(f.app.model.serialize(), expected);
    for (const entry of f.app.exportEntries()) {
        assert.deepEqual(Array.from(entry.bytes), Array.from(original.find(item => item.path === entry.path).bytes), entry.path);
    }
    assert.equal(f.node('assetPanel').hidden, false);
});

test('older workspace ZIP metadata and third-party ZIPs continue using byte detection', async () => {
    const f = await fixture();
    const files = [{path: 'notes.txt', bytes: encode('ordinary UTF-8')},
        {path: 'legacy.ps', bytes: Uint8Array.of(37, 33, 80, 83, 10, 37, 233)},
        {path: 'image.png', bytes: Uint8Array.of(0, 255, 137)}];
    const comment = JSON.stringify({format: 'visual-workspace', version: 1, name: 'Older project',
        activePath: 'notes.txt', mainPath: 'legacy.ps'});
    await importProject(f, f.context.ProjectArchive.writeZip(files, {comment}));
    assert.equal(f.app.model.name, 'Older project');
    assert.equal(f.app.model.mainPath, 'legacy.ps');
    assert.equal(f.app.model.activePath, 'notes.txt');
    assert.equal(f.app.model.get('legacy.ps').encoding, 'latin1');
    assert.equal(f.app.model.get('image.png').kind, 'binary');
    await importProject(f, f.context.ProjectArchive.writeZip(files, {comment: 'Third-party ZIP comment'}));
    assert.equal(f.app.model.get('notes.txt').text, 'ordinary UTF-8');
    assert.equal(f.app.model.get('legacy.ps').encoding, 'latin1');
    assert.equal(f.app.model.get('image.png').kind, 'binary');
});

test('stale type metadata cannot reinterpret externally replaced or renamed ZIP members', async () => {
    const f = await fixture();
    f.app.replaceProject(new f.context.ProjectModel({files: [text('legacy.tex', 'café', 'latin1'), text('other.txt', 'UTF-8 中文')]}));
    const archive = await f.context.ProjectArchive.readZip(await exportProject(f), {includeComment: true});
    const replacement = encode('é!!'); // Same byte length, so the content binding must also be checked.
    await importProject(f, f.context.ProjectArchive.writeZip([{path: 'legacy.tex', bytes: replacement}], {comment: archive.comment}));
    assert.equal(f.app.model.get().encoding, 'utf-8');
    assert.equal(f.app.model.get().text, 'é!!');
    await importProject(f, f.context.ProjectArchive.writeZip([{path: 'renamed.tex', bytes: archive.files[0].bytes}], {comment: archive.comment}));
    assert.equal(f.app.model.get().kind, 'binary');
    assert.deepEqual(Array.from(f.app.exportEntries()[0].bytes), Array.from(archive.files[0].bytes));
    await importProject(f, f.context.ProjectArchive.writeZip([...archive.files].reverse(), {comment: archive.comment}));
    assert.equal(f.app.model.get('other.txt').text, 'UTF-8 中文');
    assert.equal(f.app.model.get('legacy.tex').kind, 'binary');
});

test('malformed and incompatible explicit encodings fall back without replacing invalid UTF-8 bytes', async () => {
    const f = await fixture();
    f.app.replaceProject(new f.context.ProjectModel({files: [text('legacy.tex', 'café', 'latin1')]}));
    const archive = await f.context.ProjectArchive.readZip(await exportProject(f), {includeComment: true});
    const metadata = JSON.parse(archive.comment);
    assert.ok(metadata.fileTypes?.length, 'an explicit encoding is needed for this Latin-1 TeX member');
    const incompatible = structuredClone(metadata);
    incompatible.fileTypes[0][1] = 'utf-8';
    for (const fileTypes of [incompatible.fileTypes, [metadata.fileTypes[0], metadata.fileTypes[0]],
        [[999, 'latin1', 0, 0, 0]], [['0', 'latin1', 0, 0, 0]], null, {0: metadata.fileTypes[0]}]) {
        const comment = JSON.stringify({...metadata, fileTypes});
        await importProject(f, f.context.ProjectArchive.writeZip(archive.files, {comment}));
        assert.equal(f.app.model.get().kind, 'binary');
        assert.deepEqual(Array.from(f.app.exportEntries()[0].bytes), Array.from(archive.files[0].bytes));
    }
});

test('500 long UTF-8 paths with explicit encodings still fit the ZIP comment limit and restore every file', async () => {
    const f = await fixture();
    const files = Array.from({length: 500}, (_, index) => text('中'.repeat(1000) + index + '.txt', 'é', 'latin1'));
    f.app.replaceProject(new f.context.ProjectModel({name: '文'.repeat(200), files,
        mainPath: files[0].path, activePath: files.at(-1).path}));
    const expected = f.app.model.serialize();
    const archive = await exportProject(f);
    const decoded = await f.context.ProjectArchive.readZip(archive, {includeComment: true});
    assert.ok(encode(decoded.comment).length <= 65535);
    await importProject(f, archive);
    assert.ok(f.app.model.serialize() === expected, 'all 500 files and project settings survive the ZIP round-trip');
});
