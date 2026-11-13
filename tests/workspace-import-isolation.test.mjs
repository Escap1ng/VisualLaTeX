import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/workspace-fixture.mjs';

const encode = source => new TextEncoder().encode(source);

for (const replacement of ['new project', 'imported project']) {
    test('pending Add Files cannot enter a later ' + replacement, async () => {
        const f = await fixture();
        const previousModel = f.app.model;
        let finishReading;
        const bytes = encode('This belongs to the old project.');
        f.node('importFiles').files = [{name: 'old-project-only.txt', size: bytes.length,
            arrayBuffer: () => new Promise(resolve => { finishReading = resolve; })}];
        const importing = f.emit(f.node('importFiles'), 'change');
        if (replacement === 'new project') await f.click('btnNewProject');
        else {
            const project = JSON.stringify({format: 'visual-workspace', version: 1, name: 'Replacement',
                files: [{path: 'main.tex', kind: 'text', text: 'Imported project.'}], activePath: 'main.tex', mainPath: 'main.tex'});
            f.node('importProject').files = [{name: 'replacement.vlproj', size: project.length, text: async () => project}];
            await f.emit(f.node('importProject'), 'change');
        }
        assert.notEqual(f.app.model, previousModel);
        await f.input('sourceArea', 'The replacement project has its own edits.');
        f.app.persist();
        const expected = f.app.model.serialize();
        const saved = f.storage.get('visuallatex_workspace_v1');
        const status = f.node('statusText').textContent;
        finishReading(bytes.buffer);
        await importing;
        assert.equal(f.app.model.serialize(), expected);
        assert.equal(f.storage.get('visuallatex_workspace_v1'), saved);
        assert.equal(f.node('sourceArea').value, 'The replacement project has its own edits.');
        assert.equal(f.node('statusText').textContent, status);
        assert.equal(previousModel.get('old-project-only.txt'), null);
    });
}

test('failed reads from a replaced project do not overwrite the current project status', async () => {
    const f = await fixture();
    let rejectReading;
    f.node('importFiles').files = [{name: 'unavailable.txt', size: 10,
        arrayBuffer: () => new Promise((resolve, reject) => { rejectReading = reject; })}];
    const importing = f.emit(f.node('importFiles'), 'change');
    await f.click('btnNewProject');
    f.node('statusText').textContent = 'Current project status';
    const expected = f.app.model.serialize();
    rejectReading(new Error('Old file read failed'));
    await importing;
    assert.equal(f.app.model.serialize(), expected);
    assert.equal(f.node('statusText').textContent, 'Current project status');
});

test('Add Files still reports read failures for its current project', async () => {
    const f = await fixture();
    const expected = f.app.model.serialize();
    f.node('importFiles').files = [{name: 'unavailable.txt', size: 10,
        arrayBuffer: async () => { throw new Error('Current file read failed'); }}];
    await f.emit(f.node('importFiles'), 'change');
    assert.equal(f.app.model.serialize(), expected);
    assert.equal(f.node('statusText').textContent, 'Current file read failed');
});

test('new files, renamed files and ZIP imports reject file-directory conflicts before changing the draft', async () => {
    const f = await fixture();
    f.prompts.push('sections/intro.tex');
    await f.click('newFile');
    await f.input('sourceArea', 'An existing chapter.');
    f.app.persist();
    const expected = f.app.model.serialize();
    const saved = f.storage.get('visuallatex_workspace_v1');
    f.prompts.push('SECTIONS');
    await f.click('newFile');
    assert.equal(f.app.model.serialize(), expected);
    assert.equal(f.storage.get('visuallatex_workspace_v1'), saved);
    assert.match(f.node('statusText').textContent, /文件与目录路径冲突/);
    f.app.switchFile('main.tex');
    const beforeRename = f.app.model.serialize();
    f.prompts.push('sections');
    await f.click('renameFile');
    assert.equal(f.app.model.serialize(), beforeRename);
    assert.match(f.node('statusText').textContent, /文件与目录路径冲突/);

    const bytes = f.context.ProjectArchive.writeZip([{path: 'notes', bytes: encode('File')},
        {path: 'notes/chapter.tex', bytes: encode('Chapter')}]);
    f.node('importProject').files = [{name: 'conflict.zip', size: bytes.length, arrayBuffer: async () => bytes.buffer}];
    const beforeImport = f.storage.get('visuallatex_workspace_v1');
    await f.emit(f.node('importProject'), 'change');
    assert.equal(f.app.model.serialize(), beforeRename);
    assert.equal(f.storage.get('visuallatex_workspace_v1'), beforeImport);
    assert.match(f.node('statusText').textContent, /文件与目录路径冲突/);
    assert.equal(f.app.model.get('sections/intro.tex').text, 'An existing chapter.');
});
