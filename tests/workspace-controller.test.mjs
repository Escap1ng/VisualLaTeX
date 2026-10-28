import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createDocument, Element} from './helpers/dom.mjs';

// Uses the actual source-first controller and actual LaTeX importer/exporter.
// The DOM fixture has no layout, rendering, script execution or browser event loop.
const scripts = ['main.js', 'project-model.js', 'workspace.js'].map(name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8'));
const tex = body => '\\documentclass{article}\n\\begin{document}\n' + body + '\n\\end{document}\n';
const textFile = (path, text) => ({path, kind: 'text', text, encoding: 'utf-8'});

function fixture(files, options = {}) {
    const document = createDocument();
    const visual = new Element('div');
    const preview = new Element('div');
    const status = new Element('span');
    const notices = [];
    const data = new Map();
    const controls = {failWrites: false};
    const context = vm.createContext({document, Node: {ELEMENT_NODE: 1, TEXT_NODE: 3},
        TextEncoder, TextDecoder, Uint8Array, atob, btoa, console,
        alert: message => notices.push(message),
        __visual: visual, __preview: preview, __status: status});
    for (const script of scripts) vm.runInContext(script, context);
    vm.runInContext('editorArea=__visual;previewArea=__preview;statusText=__status;updatePreview=()=>{};saveDraft=()=>true;', context);
    const sourceArea = {
        _value: '',
        get value() { return this._value; },
        set value(value) { this._value = String(value).replace(/\r\n?/g, '\n'); },
    };
    const ui = {sourceArea, saveState: {textContent: ''}};
    const storage = {getItem: key => data.get(key) ?? null, setItem: (key, value) => {
        if (controls.failWrites) throw new Error('QuotaExceededError');
        data.set(key, value);
    }};
    const model = new context.ProjectModel({files, ...options});
    const Controller = vm.runInContext('WorkspaceController', context);
    const core = {canVisual: source => Boolean(context.splitTexDocument(source)),
        loadVisual: (source, name) => context.applyImportedTex(source, name),
        exportVisual: () => context.domToLatex()};
    const app = new Controller({model, ui, core, storage, notify: message => notices.push(message)});
    app.show();
    return {app, ui, visual, data, controls, context, notices};
}

test('source editing preserves incomplete LaTeX and persists it without a document wrapper', () => {
    const f = fixture([textFile('main.tex', tex('Original'))]);
    const incomplete = String.raw`\documentclass{report}
\usepackage{custom}
\begin{document}
\cite{unfinished`;
    f.ui.sourceArea.value = incomplete;
    f.app.changed(false);
    assert.equal(f.app.model.get().text, incomplete);
    assert.equal(f.app.persist(), true);
    const restored = f.context.ProjectModel.deserialize(f.data.get('visuallatex_workspace_v1'));
    assert.equal(restored.get().text, incomplete);
    const exported = f.app.exportEntries().find(file => file.path === 'main.tex');
    assert.equal(new TextDecoder().decode(exported.bytes), incomplete);
});

test('a rejected visual switch does not replace incomplete source or clear the file', () => {
    const f = fixture([textFile('fragment.tex', '\\cite{')]);
    assert.equal(f.app.setMode('visual'), false);
    assert.equal(f.app.mode, 'source');
    assert.equal(f.app.model.get().text, '\\cite{');
    assert.equal(f.ui.sourceArea.value, '\\cite{');
    assert.equal(f.visual.childNodes.length, 0);
    assert.match(f.notices[0], /源码/);
});

for (const [path, source] of [
    ['drawing.ps', '%!PS-Adobe-3.0\n/Helvetica findfont 18 scalefont setfont\n(Hello) show\nshowpage\n'],
    ['drawing.eps', '%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n'],
    ['references.bib', '@article{key, title={Title}}\n'],
    ['chapter.tex', '\\section{Standalone fragment}\nBody.'],
]) {
    test(path + ' stays editable source and never gains LaTeX document framing', () => {
        const f = fixture([textFile(path, source)]);
        assert.equal(f.app.setMode('visual'), false);
        const edited = source + '% edited\n';
        f.ui.sourceArea.value = edited;
        f.app.changed(false);
        const exported = f.app.exportEntries().find(file => file.path === path);
        assert.equal(new TextDecoder().decode(exported.bytes), edited);
        assert.doesNotMatch(f.app.model.get().text, /\\documentclass/);
    });
}

test('source/visual switching preserves exact CRLF and source edits remain canonical', () => {
    const source = '% untouched prefix\r\n\\documentclass{article}\r\n\\begin{document}\r\nRate 50\\%, \\cite{old}.\r\n\\end{document}\r\n% tail\r\n';
    const f = fixture([textFile('main.tex', source)]);
    assert.ok(!f.ui.sourceArea.value.includes('\r'), 'fixture models textarea newline normalization');
    f.app.changed(false);
    assert.equal(f.app.model.get().text, source);
    assert.equal(f.app.setMode('visual'), true);
    assert.equal(f.app.setMode('source'), true);
    assert.equal(f.app.model.get().text, source);
    f.ui.sourceArea.value = f.ui.sourceArea.value.replace('\\cite{old}', '\\cite[see][p.2]{new,second}');
    f.app.changed(false);
    const edited = source.replace('\\cite{old}', '\\cite[see][p.2]{new,second}');
    assert.equal(f.app.model.get().text, edited);
    f.app.setMode('visual');
    f.app.setMode('source');
    assert.equal(f.app.model.get().text, edited);
});

test('visual edits synchronize before file switches and never leak another preamble or body', () => {
    const a = tex('First paragraph.');
    const b = '\\documentclass{report}\n\\begin{document}\nSecond paragraph.\n\\end{document}\n';
    const f = fixture([textFile('a.tex', a), textFile('b.tex', b), textFile('refs.bib', '@book{keep, title={Book}}')]);
    f.app.setMode('visual');
    f.visual.querySelector('p').textContent = 'Edited first paragraph.';
    f.app.switchFile('b.tex');
    assert.equal(f.app.model.get('a.tex').text, a.replace('First paragraph.', 'Edited first paragraph.'));
    assert.equal(f.app.model.get().text, b);
    f.app.setMode('visual');
    f.visual.querySelector('p').textContent = 'Edited second paragraph.';
    f.app.switchFile('a.tex');
    assert.match(f.ui.sourceArea.value, /documentclass\{article\}/);
    assert.doesNotMatch(f.ui.sourceArea.value, /Second paragraph|documentclass\{report\}/);
    assert.equal(f.app.model.get('b.tex').text, b.replace('Second paragraph.', 'Edited second paragraph.'));
    assert.equal(f.app.model.get('refs.bib').text, '@book{keep, title={Book}}');
});

test('undo and redo operate on the selected file across source and visual edits', () => {
    const f = fixture([textFile('main.tex', tex('Original.')), textFile('drawing.ps', '%!PS\nold')]);
    f.ui.sourceArea.value = tex('Source edit.');
    f.app.changed(false);
    f.app.setMode('visual');
    f.visual.querySelector('p').textContent = 'Visual edit.';
    f.app.changed(false);
    f.app.history('undo');
    assert.equal(f.app.mode, 'visual');
    assert.equal(f.visual.querySelector('p').textContent, 'Source edit.');
    f.app.switchFile('drawing.ps');
    f.ui.sourceArea.value = '%!PS\nnew';
    f.app.changed(false);
    f.app.history('undo');
    assert.equal(f.ui.sourceArea.value, '%!PS\nold');
    f.app.history('redo');
    assert.equal(f.ui.sourceArea.value, '%!PS\nnew');
    f.app.switchFile('main.tex');
    f.app.history('redo');
    assert.equal(f.app.model.get().text, tex('Visual edit.'));
});

test('project export includes non-active edits, literal source HTML and exact binary bytes', () => {
    const binary = Uint8Array.from([0, 255, 254, 200, 13, 10]);
    const base64 = Buffer.from(binary).toString('base64');
    const f = fixture([textFile('main.tex', tex('Text.')), textFile('references.bib', '@book{old, title={Old}}'),
        {path: 'images/a.bin', kind: 'binary', base64}]);
    f.app.switchFile('references.bib');
    f.ui.sourceArea.value = '@book{new, title={<img src=x onerror="bad()">}}';
    f.app.changed(false);
    f.app.switchFile('main.tex');
    const entries = f.app.exportEntries();
    assert.equal(new TextDecoder().decode(entries.find(file => file.path === 'references.bib').bytes), '@book{new, title={<img src=x onerror="bad()">}}');
    assert.deepEqual(Array.from(entries.find(file => file.path === 'images/a.bin').bytes), Array.from(binary));
    assert.equal(f.visual.querySelectorAll('img').length, 0);
});

test('save failure retains prior atomic project payload and current source for recovery', () => {
    const f = fixture([textFile('main.tex', tex('Saved.'))]);
    assert.equal(f.app.persist(), true);
    const saved = f.data.get('visuallatex_workspace_v1');
    f.ui.sourceArea.value = '\\cite{unfinished-new';
    f.controls.failWrites = true;
    assert.equal(f.app.persist(), false);
    assert.equal(f.data.get('visuallatex_workspace_v1'), saved);
    assert.equal(f.app.model.get().text, '\\cite{unfinished-new');
    assert.match(f.ui.saveState.textContent, /保存失败/);
});

test('blocked recovery never overwrites existing storage until an explicit replacement', () => {
    const f = fixture([textFile('main.tex', tex('Placeholder.'))]);
    f.data.set('visuallatex_workspace_v1', '{broken older project');
    f.app.recoveryBlocked = true;
    assert.equal(f.app.persist(), false);
    assert.equal(f.data.get('visuallatex_workspace_v1'), '{broken older project');
    f.app.replaceProject(new f.context.ProjectModel({files: [textFile('new.ps', '%!PS\nnew')]}));
    assert.equal(f.app.recoveryBlocked, false);
    assert.equal(f.context.ProjectModel.deserialize(f.data.get('visuallatex_workspace_v1')).activePath, 'new.ps');
});

test('PostScript Latin-1 and binary EPS imports retain original bytes', () => {
    const f = fixture([]);
    const psBytes = Uint8Array.from([37, 33, 80, 83, 10, 37, 32, 233, 10]);
    const ps = f.context.workspaceFile('drawing.ps', psBytes);
    assert.equal(ps.kind, 'text');
    assert.equal(ps.encoding, 'latin1');
    assert.deepEqual(Array.from(f.context.workspaceBytes(ps)), Array.from(psBytes));
    const epsBytes = Uint8Array.from([0xc5, 0xd0, 0xd3, 0xc6, 0, 1, 2, 255]);
    const eps = f.context.workspaceFile('drawing.eps', epsBytes);
    assert.equal(eps.kind, 'binary');
    assert.deepEqual(Array.from(f.context.workspaceBytes(eps)), Array.from(epsBytes));
});

test('custom project source extensions remain editable while binary assets preserve bytes', () => {
    const f = fixture([]);
    const bytes = new TextEncoder().encode('\\newcommand{\\custom}{Editable source}\r\n');
    for (const path of ['drawing.tikz', 'document.ltx', 'style.bbx', 'configuration', 'custom.source']) {
        const file = f.context.workspaceFile(path, bytes);
        assert.equal(file.kind, 'text', path);
        assert.deepEqual(Array.from(f.context.workspaceBytes(file)), Array.from(bytes));
    }
    const asset = f.context.workspaceFile('asset.pdf', new TextEncoder().encode('%PDF-1.7\nASCII contents'));
    assert.equal(asset.kind, 'binary');
    const unknown = Uint8Array.of(1, 2, 3, 0, 127);
    assert.equal(f.context.workspaceFile('binary.data', unknown).kind, 'binary');
});

test('clicking a later repeated citation locates that token, including inside formatting', () => {
    const source = tex('% hidden \\cite{same}\nFirst \\cite{same}.\n\nSecond \\textbf{also \\cite{same}}.').replace(/\n/g, '\r\n');
    const f = fixture([textFile('main.tex', source)]);
    f.app.setMode('visual');
    const tokens = f.visual.querySelectorAll('.tex-cmd').filter(node => node.textContent === '\\cite{same}');
    assert.equal(tokens.length, 2);
    const offset = f.context.locateWorkspaceToken(f.visual, tokens[1], f.app.model.get().text);
    assert.equal(offset, source.replace(/\r\n/g, '\n').lastIndexOf('\\cite{same}'));
    assert.equal(f.app.model.get().text, source);
});

test('project export at file-count limit retains all files without an extra manifest', () => {
    const files = Array.from({length: 500}, (_, index) => textFile('file' + index + '.txt', 'content'));
    const f = fixture(files);
    assert.equal(f.app.exportEntries().length, 500);
});

test('project export preserves user files whose names differ only in manifest casing', () => {
    const path = '.VISUAL-WORKSPACE/project.json';
    const f = fixture([textFile('main.tex', tex('Text.')), textFile(path, '{"user":"content"}')]);
    const entries = f.app.exportEntries();
    assert.equal(entries.length, 2);
    assert.equal(new TextDecoder().decode(entries.find(file => file.path === path).bytes), '{"user":"content"}');
});
