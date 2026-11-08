import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/workspace-fixture.mjs';

test('actual workspace startup opens LaTeX in the editable visual surface', async () => {
    const f = await fixture();
    assert.ok(f.app);
    assert.equal(f.app.mode, 'visual');
    assert.equal(f.app.model.activePath, 'main.tex');
    assert.match(f.node('sourceArea').value, /\\documentclass\{article\}/);
    assert.equal(f.node('sourcePanel').hidden, true);
    assert.equal(f.node('visualPanel').hidden, false);
    assert.ok(f.node('editorArea').querySelector('h1'));
    assert.equal(f.node('languageBadge').textContent, 'LaTeX');
    assert.equal(f.node('fileTree').querySelectorAll('button').length, 3);
    assert.equal(f.node('modeVisual').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(f.alerts, []);
});

test('imported LaTeX is immediately editable visually and file navigation keeps visual changes', async () => {
    const f = await fixture();
    const source = '% untouched preamble\r\n\\documentclass{report}\r\n\\begin{document}\r\nAn imported paragraph.\r\n\\end{document}\r\n% untouched tail\r\n';
    const bytes = new TextEncoder().encode(source);
    f.node('importFiles').files = [{name: 'paper.ltx', size: bytes.length, arrayBuffer: async () => bytes.buffer}];
    await f.emit(f.node('importFiles'), 'change');
    assert.equal(f.app.mode, 'visual');
    assert.equal(f.app.model.get().text, source);
    assert.equal(f.node('btnBold').disabled, false, 'ltx documents must have the same visual tools as tex');
    assert.equal(f.node('modeVisual').disabled, false);
    f.node('editorArea').querySelector('p').textContent = 'An edited visual paragraph.';
    await f.emit(f.node('editorArea'), 'input');
    await f.flushTimers();
    const edited = source.replace('An imported paragraph.', 'An edited visual paragraph.');
    const file = path => f.node('fileTree').querySelectorAll('button').find(node => node.textContent.endsWith(path));
    await file('drawing.ps').click();
    assert.equal(f.app.mode, 'source');
    await file('paper.ltx').click();
    assert.equal(f.app.mode, 'visual');
    assert.equal(f.node('editorArea').querySelector('p').textContent, 'An edited visual paragraph.');
    assert.equal(f.app.model.get().text, edited);
    await f.click('btnUndo');
    assert.equal(f.app.mode, 'visual');
    assert.equal(f.app.model.get().text, source);
    assert.equal(f.node('editorArea').querySelector('p').textContent, 'An imported paragraph.');
    await f.click('btnRedo');
    assert.equal(f.app.model.get().text, edited);
    await f.click('modeSource');
    await file('drawing.ps').click();
    await file('paper.ltx').click();
    assert.equal(f.app.mode, 'source', 'explicit mode buttons set a per-file session preference');
    await f.click('btnDownload');
    assert.equal(new TextDecoder('utf-8', {ignoreBOM: true}).decode(await f.blobs.at(-1).arrayBuffer()), edited);
    const restored = await fixture({initialStorage: [...f.storage]});
    assert.equal(restored.app.mode, 'visual');
    assert.equal(restored.app.model.activePath, 'paper.ltx');
    assert.equal(restored.node('editorArea').querySelector('p').textContent, 'An edited visual paragraph.');
    assert.equal(restored.app.model.get().text, edited);
});

test('reference navigation opens source only for the navigation and ordinary file clicks restore visual editing', async () => {
    const f = await fixture();
    const citation = f.node('referenceList').querySelectorAll('button').find(node => node.textContent === 'example2026 · main.tex');
    assert.ok(citation);
    await citation.click();
    assert.equal(f.app.mode, 'source');
    assert.equal(f.node('sourcePanel').hidden, false);
    const file = path => f.node('fileTree').querySelectorAll('button').find(node => node.textContent.endsWith(path));
    await file('references.bib').click();
    await file('main.tex').click();
    assert.equal(f.app.mode, 'visual');
    assert.equal(f.node('visualPanel').hidden, false);
});

test('project name input persists before blur and survives editor renders, file changes and reload', async () => {
    const f = await fixture();
    f.node('projectName').focus();
    await f.input('projectName', '浏览器验收项目');
    assert.equal(f.app.model.name, '浏览器验收项目');
    assert.equal(f.node('saveState').textContent, '待保存');
    f.node('projectName').setSelectionRange(2, 4);
    f.app.onChange();
    assert.equal(f.node('projectName').value, '浏览器验收项目');
    assert.equal(f.node('projectName').selectionStart, 2);
    assert.equal(f.node('projectName').selectionEnd, 4);
    f.node('sourceArea').focus();
    await f.input('sourceArea', 'Edited source after renaming');
    f.app.switchFile('drawing.ps');
    await f.flushTimers();
    assert.equal(f.node('projectName').value, '浏览器验收项目');
    const restored = await fixture({initialStorage: [...f.storage]});
    assert.equal(restored.app.model.name, '浏览器验收项目');
    assert.equal(restored.node('projectName').value, '浏览器验收项目');
    assert.equal(restored.app.model.get('main.tex').text, 'Edited source after renaming');
});

test('project name editing keeps draft whitespace until change and shows names from replacement projects', async () => {
    const f = await fixture();
    f.node('projectName').focus();
    await f.input('projectName', '  Draft name  ');
    f.app.onChange();
    assert.equal(f.node('projectName').value, '  Draft name  ');
    assert.equal(f.app.model.name, 'Draft name');
    await f.emit(f.node('projectName'), 'change');
    assert.equal(f.node('projectName').value, 'Draft name');
    await f.input('projectName', '');
    f.app.onChange();
    assert.equal(f.node('projectName').value, '');
    await f.emit(f.node('projectName'), 'change');
    assert.equal(f.node('projectName').value, '未命名项目');
    const replacement = f.context.defaultWorkspace();
    replacement.name = 'Replacement project';
    f.app.replaceProject(replacement);
    assert.equal(f.node('projectName').value, 'Replacement project');
});

test('unsupported native prompts fall back to accessible input and create a real project file', async () => {
    const f = await fixture({denyDialogs: true});
    f.node('newFile').focus();
    const creating = f.click('newFile');
    await Promise.resolve();
    assert.equal(f.node('workspaceDialog').hidden, false);
    assert.equal(f.document.activeElement, f.node('workspaceDialogInput'));
    assert.equal(f.node('workspaceDialogInput').value, 'untitled.tex');
    assert.equal(f.document.querySelector('.container').getAttribute('inert'), '');
    f.node('workspaceDialogInput').value = 'sections/browser.tex';
    const entered = await f.emit(f.node('workspaceDialog'), 'keydown', {key: 'Enter', target: f.node('workspaceDialogInput')});
    await creating;
    assert.equal(entered.defaultPrevented, true);
    assert.equal(entered.propagationStopped, true);
    assert.equal(f.app.model.activePath, 'sections/browser.tex');
    assert.equal(f.node('workspaceDialog').hidden, true);
    assert.equal(f.document.querySelector('.container').getAttribute('inert'), null);
    assert.equal(f.document.activeElement, f.node('newFile'));
    assert.ok(JSON.parse(f.storage.get('visuallatex_workspace_v1')).files.some(file => file.path === 'sections/browser.tex'));
});

test('fallback prompts preserve source selection and reference commands through confirmation and cancellation', async () => {
    const f = await fixture({denyDialogs: true});
    await f.input('sourceArea', 'before after');
    f.node('sourceArea').setSelectionRange(7, 7);
    const inserting = f.click('btnInsertCitation');
    await Promise.resolve();
    f.node('workspaceDialogInput').value = 'browser2026';
    await f.click('workspaceDialogAccept');
    await inserting;
    assert.equal(f.app.model.get().text, String.raw`before \cite{browser2026}after`);
    const original = f.app.model.serialize();
    const renaming = f.click('renameFile');
    await Promise.resolve();
    f.node('workspaceDialogInput').value = 'discarded.tex';
    await f.emit(f.node('workspaceDialog'), 'keydown', {key: 'Escape'});
    await renaming;
    assert.equal(f.app.model.serialize(), original);
});

test('fallback confirmations require an explicit answer before destructive workspace changes', async () => {
    const f = await fixture({denyDialogs: true});
    const original = f.app.model.serialize();
    const cancelling = f.click('deleteFile');
    await Promise.resolve();
    assert.equal(f.node('workspaceDialogInput').hidden, true);
    assert.equal(f.document.activeElement, f.node('workspaceDialogCancel'));
    assert.equal(f.app.model.serialize(), original);
    await f.click('workspaceDialogCancel');
    await cancelling;
    assert.equal(f.app.model.serialize(), original);
    const deleting = f.click('deleteFile');
    await Promise.resolve();
    await f.click('workspaceDialogAccept');
    await deleting;
    assert.equal(f.app.model.get('main.tex'), null);
    assert.equal(f.node('workspaceDialog').hidden, true);
});

test('fallback dialog escapes text, traps focus, ignores IME Enter and cleans up between queued prompts', async () => {
    const f = await fixture({denyDialogs: true});
    const first = f.context.workspacePrompt('<img src=x onerror=alert(1)>', '<script>input</script>');
    const second = f.context.workspaceConfirm('Second answer');
    await Promise.resolve();
    assert.equal(f.node('workspaceDialogMessage').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(f.node('workspaceDialogMessage').querySelector('img'), null);
    assert.equal(f.node('workspaceDialogInput').value, '<script>input</script>');
    await f.emit(f.node('workspaceDialog'), 'keydown', {key: 'Enter', target: f.node('workspaceDialogInput'), isComposing: true});
    assert.equal(f.node('workspaceDialog').hidden, false);
    await f.emit(f.node('workspaceDialog'), 'keydown', {key: 'Tab', shiftKey: true});
    assert.equal(f.document.activeElement, f.node('workspaceDialogAccept'));
    await f.emit(f.node('workspaceDialog'), 'keydown', {key: 'Tab'});
    assert.equal(f.document.activeElement, f.node('workspaceDialogInput'));
    await f.click('workspaceDialogCancel');
    assert.equal(await first, null);
    await Promise.resolve();
    assert.equal(f.node('workspaceDialogMessage').textContent, 'Second answer');
    assert.equal(f.node('workspaceDialogAccept')._events.get('click').length, 1);
    await f.click('workspaceDialogAccept');
    assert.equal(await second, true);
    assert.equal(f.node('workspaceDialogAccept')._events.get('click').length, 0);
});

test('visual image insertion gathers all fallback answers and stops cleanly on cancellation', async () => {
    const f = await fixture({denyDialogs: true});
    await f.click('modeVisual');
    const images = [];
    f.context.insertImage = image => images.push(image);
    const inserting = f.click('btnImage');
    await new Promise(setImmediate);
    for (const [label, value] of [['图片路径', 'figures/chart.png'], ['图片标题', '<b>Caption</b>'], ['图片标签', 'fig:browser']]) {
        assert.equal(f.node('workspaceDialog').hidden, false);
        assert.ok(f.node('workspaceDialogMessage').textContent.includes(label));
        f.node('workspaceDialogInput').value = value;
        await f.click('workspaceDialogAccept');
        await new Promise(setImmediate);
    }
    await inserting;
    assert.equal(images.length, 1);
    assert.deepEqual({...images[0]}, {imagePath: 'figures/chart.png', caption: '<b>Caption</b>', label: 'fig:browser'});
    const cancelling = f.click('btnImage');
    await new Promise(setImmediate);
    f.node('workspaceDialogInput').value = 'ignored.png';
    await f.click('workspaceDialogAccept');
    await new Promise(setImmediate);
    await f.click('workspaceDialogCancel');
    await cancelling;
    assert.equal(images.length, 1);
    assert.equal(f.node('workspaceDialog').hidden, true);
});

test('source and visual mode buttons synchronize edits through actual handlers', async () => {
    const f = await fixture();
    const tex = '\\documentclass{article}\r\n\\begin{document}\r\nOriginal paragraph.\r\n\\end{document}\r\n';
    f.app.model.update(tex); f.app.show();
    await f.click('modeVisual');
    assert.equal(f.app.mode, 'visual');
    assert.equal(f.node('visualPanel').hidden, false);
    assert.equal(f.node('sourcePanel').hidden, true);
    const paragraph = f.node('editorArea').querySelector('p');
    assert.ok(paragraph);
    paragraph.textContent = 'Edited paragraph.';
    await f.emit(f.node('editorArea'), 'input');
    await f.click('modeSource');
    assert.equal(f.app.mode, 'source');
    assert.equal(f.app.model.get().text, tex.replace('Original paragraph.', 'Edited paragraph.'));
    assert.match(f.node('sourceArea').value, /Edited paragraph\./);
    await f.click('modeVisual');
    await f.click('modeSource');
    assert.equal(f.app.model.get().text, tex.replace('Original paragraph.', 'Edited paragraph.'));
});

test('PostScript file selection, find/replace and undo use actual UI events', async () => {
    const f = await fixture();
    const psButton = f.node('fileTree').querySelectorAll('button').find(node => node.textContent.includes('drawing.ps'));
    await psButton.click();
    assert.equal(f.app.model.activePath, 'drawing.ps');
    assert.equal(f.node('languageBadge').textContent, 'PostScript');
    assert.equal(f.node('modeVisual').disabled, true);
    const ps = '%!PS-Adobe-3.0\n/Helvetica findfont 12 scalefont setfont\n(Hello) show\nshowpage\n';
    await f.input('sourceArea', ps);
    assert.equal(f.app.model.get().text, ps);
    await f.click('btnFind');
    assert.equal(f.node('findPanel').hidden, false);
    f.node('findText').value = 'Hello';
    f.node('replaceText').value = 'Edited';
    await f.click('btnReplaceAll');
    assert.equal(f.app.model.get().text, ps.replace('Hello', 'Edited'));
    await f.click('btnUndo');
    assert.equal(f.app.model.get().text, ps);
    await f.click('btnRedo');
    assert.equal(f.app.model.get().text, ps.replace('Hello', 'Edited'));
});

test('new TeX files can be empty fragments and stay source-only until complete', async () => {
    const f = await fixture();
    f.prompts.push('sections/method.tex');
    await f.click('newFile');
    assert.equal(f.app.model.activePath, 'sections/method.tex');
    assert.equal(f.app.model.get().text, '');
    await f.input('sourceArea', String.raw`\section{Method}\label{sec:method}`);
    await f.click('modeVisual');
    assert.equal(f.app.mode, 'source');
    assert.equal(f.app.model.get().text, String.raw`\section{Method}\label{sec:method}`);
    assert.match(f.node('statusText').textContent, /源码|完整/);
});

test('Ctrl+S persists incomplete source through the registered document handler', async () => {
    const f = await fixture();
    const incomplete = String.raw`\documentclass{article}
\begin{document}
Unfinished \cite{`;
    await f.input('sourceArea', incomplete);
    const event = await f.emit(f.document, 'keydown', {target: f.node('sourceArea'), key: 's', ctrlKey: true});
    assert.equal(event.defaultPrevented, true);
    const saved = f.context.ProjectModel.deserialize(f.storage.get('visuallatex_workspace_v1'));
    assert.equal(saved.get().text, incomplete);
    assert.match(f.node('saveState').textContent, /已保存/);
});

test('HTML-looking source remains text during actual input and visual switching', async () => {
    const f = await fixture();
    const source = '\\documentclass{article}\n\\begin{document}\n<img src=x onerror="bad()"><script>bad()</script>\n\\end{document}\n';
    await f.input('sourceArea', source);
    assert.equal(f.node('sourcePanel').querySelectorAll('img').length, 0);
    assert.equal(f.node('sourcePanel').querySelectorAll('script').length, 0);
    await f.click('modeVisual');
    assert.equal(f.node('editorArea').querySelectorAll('img').length, 0);
    assert.equal(f.node('editorArea').querySelectorAll('script').length, 0);
    await f.click('modeSource');
    assert.equal(f.app.model.get().text, source);
});

test('ZIP export and project import preserve all edited files and replace the workspace only after validation', async () => {
    const f = await fixture();
    const select = async path => {
        const button = f.node('fileTree').querySelectorAll('button').find(node => node.textContent.includes(path));
        assert.ok(button, 'file tree contains ' + path);
        await button.click();
    };
    const section = String.raw`\section{Exported chapter}\label{sec:export}` + '\n';
    f.prompts.push('sections/chapter.tex');
    await f.click('newFile');
    await f.input('sourceArea', section);
    const bib = '@book{export2026,\n  title = {Edited bibliography},\n  year = {2026}\n}\n';
    await select('references.bib');
    await f.input('sourceArea', bib);
    const ps = '%!PS-Adobe-3.0\n(Edited PostScript) show\nshowpage\n';
    await select('drawing.ps');
    await f.input('sourceArea', ps);
    await f.click('setMainFile');
    const binary = Uint8Array.of(137, 80, 78, 71, 0, 255, 128, 13, 10);
    f.node('importFiles').files = [{name: 'figure.png', size: binary.length, arrayBuffer: async () => binary.slice().buffer}];
    await f.emit(f.node('importFiles'), 'change');
    await select('main.tex');
    const main = String.raw`\documentclass{article}
\begin{document}
\input{sections/chapter}
\cite{export2026}
\end{document}
`;
    await f.input('sourceArea', main);
    f.node('projectName').value = 'Round-trip project';
    await f.emit(f.node('projectName'), 'change');
    await f.click('btnExportProject');
    assert.equal(f.blobs.length, 1);
    const archive = f.blobs[0];
    assert.equal(archive.type, 'application/zip');
    const archiveBytes = await archive.arrayBuffer();

    await f.click('btnNewProject');
    await f.input('sourceArea', 'Keep this current draft unless project parsing succeeds.');
    const currentModel = f.app.model;
    const current = currentModel.serialize();
    f.node('importProject').files = [{name: 'broken.zip', size: 3, arrayBuffer: async () => Uint8Array.of(0, 1, 2).buffer}];
    await f.emit(f.node('importProject'), 'change');
    assert.equal(f.app.model, currentModel);
    assert.equal(f.app.model.serialize(), current);
    assert.match(f.node('statusText').textContent, /压缩包|ZIP|文件/);

    let finishReading;
    f.node('importProject').files = [{name: 'round-trip.zip', size: archive.size,
        arrayBuffer: () => new Promise(resolve => { finishReading = resolve; })}];
    const importing = f.emit(f.node('importProject'), 'change');
    assert.equal(f.app.model, currentModel, 'reading the archive must not replace the current project');
    assert.equal(f.app.model.serialize(), current);
    finishReading(archiveBytes);
    await importing;
    assert.notEqual(f.app.model, currentModel);
    assert.equal(f.app.model.name, 'Round-trip project');
    assert.equal(f.app.model.mainPath, 'drawing.ps');
    assert.equal(f.app.model.activePath, 'main.tex');
    assert.equal(f.node('projectName').value, 'Round-trip project');
    assert.equal(f.app.model.get('main.tex').text, main);
    assert.equal(f.app.model.get('sections/chapter.tex').text, section);
    assert.equal(f.app.model.get('references.bib').text, bib);
    assert.equal(f.app.model.get('drawing.ps').text, ps);
    const restoredBinary = f.app.model.get('figure.png');
    assert.equal(restoredBinary.kind, 'binary');
    assert.deepEqual(Uint8Array.from(atob(restoredBinary.base64), character => character.charCodeAt(0)), binary);
    assert.equal(f.app.model.list().length, 5);
});

test('reference controls insert editable commands and bibliography entries reject duplicate keys', async () => {
    const f = await fixture();
    await f.input('sourceArea', 'References: ');
    for (const [id, key] of [['btnInsertCitation', 'example2026,new2026'], ['btnInsertReference', 'sec:result'], ['btnInsertLabel', 'sec:result']]) {
        f.prompts.push(key);
        await f.click(id);
    }
    const commands = String.raw`References: \cite{example2026,new2026}\ref{sec:result}\label{sec:result}`;
    assert.equal(f.app.model.get().text, commands);
    assert.equal(f.node('sourceArea').value, commands);
    const oldBib = f.app.model.get('references.bib').text;
    f.prompts.push('new2026');
    await f.click('btnAddBibEntry');
    assert.equal(f.app.model.activePath, 'references.bib');
    assert.equal(f.app.mode, 'source');
    const entry = '\n@article{new2026,\n  author = {},\n  title = {},\n  journal = {},\n  year = {}\n}\n';
    assert.equal(f.app.model.get().text, oldBib + entry);
    await f.input('sourceArea', f.node('sourceArea').value.replace('title = {},', 'title = {An editable entry},'));
    assert.match(f.app.model.get().text, /title = \{An editable entry\}/);
    const unchanged = f.app.model.serialize();
    f.prompts.push('new2026');
    await f.click('btnAddBibEntry');
    assert.match(f.node('statusText').textContent, /文献键已存在/);
    assert.equal(f.app.model.serialize(), unchanged);
    assert.equal(f.app.model.get('main.tex').text, commands);
});

test('case-insensitive find and replace use original offsets after Unicode case expansion', async () => {
    const f = await fixture();
    await f.input('sourceArea', 'İ X');
    await f.click('btnFind');
    f.node('findText').value = 'X';
    f.node('replaceText').value = '$&';
    f.node('sourceArea').setSelectionRange(0, 0);
    await f.click('btnFindNext');
    assert.equal(f.node('sourceArea').selectionStart, 2);
    assert.equal(f.node('sourceArea').selectionEnd, 3);
    await f.click('btnReplace');
    assert.equal(f.app.model.get().text, 'İ $&');
    await f.input('sourceArea', 'İ X x');
    await f.click('btnReplaceAll');
    assert.equal(f.app.model.get().text, 'İ $& $&');
    assert.equal(f.node('findStatus').textContent, '已替换 2 处');
    await f.click('btnUndo');
    assert.equal(f.app.model.get().text, 'İ X x');
    f.node('findCase').checked = true;
    await f.click('btnReplaceAll');
    assert.equal(f.app.model.get().text, 'İ $& x');
    assert.equal(f.node('findStatus').textContent, '已替换 1 处');
});

test('find treats regular-expression symbols and replacement dollar tokens as literal text', async () => {
    const f = await fixture();
    const token = '[a].*+?^${}()|\\';
    const upper = token.replace('a', 'A');
    await f.input('sourceArea', token + ' / ' + upper + ' / unrelated');
    f.node('findText').value = token;
    f.node('replaceText').value = '$&';
    f.node('sourceArea').setSelectionRange(0, 0);
    await f.click('btnFindNext');
    assert.equal(f.node('sourceArea').selectionStart, 0);
    assert.equal(f.node('sourceArea').selectionEnd, token.length);
    await f.click('btnReplace');
    assert.equal(f.app.model.get().text, '$& / ' + upper + ' / unrelated');
    f.node('replaceText').value = '$& $1 $$';
    await f.click('btnReplaceAll');
    assert.equal(f.app.model.get().text, '$& / $& $1 $$ / unrelated');
    assert.equal(f.node('findStatus').textContent, '已替换 1 处');
});

test('creating the first file after deleting all files retains LaTeX and PostScript templates', async () => {
    for (const path of ['main.tex', 'drawing.ps']) {
        const f = await fixture();
        while (f.app.model.list().length) await f.click('deleteFile');
        assert.equal(f.app.model.activePath, null);
        assert.equal(f.node('sourceArea').value, '');
        f.prompts.push(path);
        await f.click('newFile');
        assert.equal(f.app.model.activePath, path);
        const template = f.app.model.get().text;
        if (path.endsWith('.tex')) {
            assert.match(template, /\\documentclass\{article\}/);
            assert.match(template, /\\begin\{document\}[\s\S]+\\end\{document\}/);
        } else {
            assert.match(template, /^%!PS-Adobe-3\.0\n/);
            assert.match(template, /showpage/);
        }
        assert.equal(f.node('sourceArea').value, template);
        assert.equal(f.context.ProjectModel.deserialize(f.storage.get('visuallatex_workspace_v1')).get().text, template);
    }
});

test('file import preserves existing undo history and edits made while awaiting file reads', async () => {
    const f = await fixture();
    const original = f.app.model.get().text;
    await f.input('sourceArea', 'Edit made before importing.');
    let finishReading;
    const imported = new TextEncoder().encode('Imported text file.');
    f.node('importFiles').files = [{name: 'notes.txt', size: imported.length,
        arrayBuffer: () => new Promise(resolve => { finishReading = resolve; })}];
    const importing = f.emit(f.node('importFiles'), 'change');
    const latest = 'Edit made while the imported file is still being read.';
    await f.input('sourceArea', latest);
    finishReading(imported.buffer);
    await importing;
    assert.equal(f.app.model.activePath, 'notes.txt');
    assert.equal(f.app.model.get().text, 'Imported text file.');
    const mainButton = f.node('fileTree').querySelectorAll('button').find(node => node.textContent.includes('main.tex'));
    await mainButton.click();
    assert.equal(f.node('sourceArea').value, latest);
    assert.equal(f.app.model.get().text, latest);
    assert.equal(f.node('btnUndo').disabled, false);
    let undoSteps = 0;
    while (f.app.model.get().text !== original && undoSteps < 2) {
        await f.click('btnUndo');
        undoSteps++;
    }
    assert.equal(f.app.model.get().text, original);
    for (let step = 0; step < undoSteps; step++) await f.click('btnRedo');
    assert.equal(f.app.model.get().text, latest);
    assert.equal(f.app.model.get('notes.txt').text, 'Imported text file.');
});

test('ZIP round-trip preserves a user project.json that resembles workspace metadata', async () => {
    const f = await fixture();
    const path = '.visual-workspace/project.json';
    const userJSON = JSON.stringify({format: 'visual-workspace', version: 1,
        name: 'User JSON name, not the project name', mainPath: 'main.tex', activePath: 'main.tex',
        userData: {keep: 'This is an ordinary editable project file.'}}, null, 2) + '\n';
    f.prompts.push(path);
    await f.click('newFile');
    await f.input('sourceArea', userJSON);
    const psButton = f.node('fileTree').querySelectorAll('button').find(node => node.textContent.includes('drawing.ps'));
    await psButton.click();
    await f.click('setMainFile');
    f.node('projectName').value = 'Actual project name';
    await f.emit(f.node('projectName'), 'change');
    const userFileButton = f.node('fileTree').querySelectorAll('button').find(node => node.textContent.includes(path));
    await userFileButton.click();
    assert.equal(f.app.model.list().length, 4);
    await f.click('btnExportProject');
    assert.equal(f.blobs.length, 1, 'a user metadata-like path must not prevent export');
    const archive = f.blobs[0];
    await f.click('btnNewProject');
    f.node('importProject').files = [{name: 'user-metadata.zip', size: archive.size,
        arrayBuffer: () => archive.arrayBuffer()}];
    await f.emit(f.node('importProject'), 'change');
    assert.equal(f.app.model.list().length, 4);
    assert.equal(f.app.model.get(path)?.text, userJSON);
    assert.equal(f.app.model.name, 'Actual project name');
    assert.equal(f.app.model.mainPath, 'drawing.ps');
    assert.equal(f.app.model.activePath, path);
    assert.equal(f.node('sourceArea').value, userJSON);
});

test('a denied localStorage accessor still allows editing and ZIP export without claiming drafts were saved', async () => {
    const oldDraft = 'The inaccessible original draft must never be overwritten.';
    const f = await fixture({denyStorage: true, initialStorage: [['visuallatex_workspace_v1', oldDraft]]});
    assert.ok(f.app);
    assert.equal(f.app.mode, 'visual');
    assert.equal(f.app.recoveryBlocked, true);
    assert.match(f.node('statusText').textContent, /项目恢复失败/);
    const tex = '\\documentclass{article}\n\\begin{document}\nEdited without storage.\n\\end{document}\n';
    await f.input('sourceArea', tex);
    const psButton = f.node('fileTree').querySelectorAll('button').find(node => node.textContent.includes('drawing.ps'));
    await psButton.click();
    const ps = '%!PS-Adobe-3.0\n(Edited without storage) show\nshowpage\n';
    await f.input('sourceArea', ps);
    await f.flushTimers();
    assert.equal(f.app.model.get('main.tex').text, tex);
    assert.equal(f.app.model.get('drawing.ps').text, ps);
    assert.equal(f.app.persist(), false);
    assert.doesNotMatch(f.node('saveState').textContent, /已保存/);
    assert.match(f.node('statusText').textContent, /已暂停覆盖/);
    assert.equal(f.storage.get('visuallatex_workspace_v1'), oldDraft);

    await f.click('btnExportProject');
    assert.equal(f.blobs.length, 1);
    assert.equal(f.blobs[0].type, 'application/zip');
    const files = await f.context.ProjectArchive.readZip(new Uint8Array(await f.blobs[0].arrayBuffer()));
    const exportedText = path => new TextDecoder().decode(files.find(file => file.path === path).bytes);
    assert.equal(exportedText('main.tex'), tex);
    assert.equal(exportedText('drawing.ps'), ps);
    assert.equal(f.app.recoveryBlocked, true);
    assert.equal(f.storage.get('visuallatex_workspace_v1'), oldDraft);

    // An explicit new-project action clears the recovery guard, but unavailable
    // storage must still report failure instead of claiming a successful save.
    await f.click('btnNewProject');
    assert.equal(f.app.recoveryBlocked, false);
    assert.equal(f.app.persist(), false);
    assert.match(f.node('saveState').textContent, /保存失败/);
    assert.match(f.node('statusText').textContent, /不允许本机存储/);
    assert.equal(f.storage.get('visuallatex_workspace_v1'), oldDraft);
    assert.equal(f.storage.size, 1);
});
