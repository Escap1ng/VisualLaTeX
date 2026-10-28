import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({TextEncoder});
vm.runInContext(fs.readFileSync(new URL('../project-model.js', import.meta.url), 'utf8'), context);
const ProjectModel = context.ProjectModel;
const textFile = (path, text = '') => ({path, kind: 'text', text});
const plain = value => JSON.parse(JSON.stringify(value));

test('all text formats preserve exact content, including incomplete source and CRLF', () => {
    const files = [textFile('main.tex', '\ufeff% header\r\n\\cite{unfinished'), textFile('refs.bib', '@article{key,\r\n'),
        textFile('graphics/image.eps', '%!PS-Adobe-3.0 EPSF-3.0\r\n%%BoundingBox: 0 0 100 100\r\n')];
    const model = new ProjectModel({name: 'Paper', files, activePath: 'refs.bib', mainPath: 'main.tex'});
    const restored = ProjectModel.deserialize(model.serialize());
    assert.equal(restored.activePath, 'refs.bib');
    assert.equal(restored.mainPath, 'main.tex');
    assert.deepEqual(restored.list().map(f => f.text).join('|'), files.map(f => f.text).join('|'));
    assert.equal(restored.get('graphics/image.eps').language, 'postscript');
});

test('recognizes LaTeX, BibTeX and PostScript extensions without changing filenames', () => {
    assert.equal(ProjectModel.language('a.TEX'), 'latex');
    assert.equal(ProjectModel.language('style.cls'), 'latex');
    assert.equal(ProjectModel.language('ref.bib'), 'bibtex');
    assert.equal(ProjectModel.language('drawing.PS'), 'postscript');
    assert.equal(ProjectModel.language('drawing.eps'), 'postscript');
    assert.equal(ProjectModel.language('notes.md'), 'text');
});

test('binary resources retain exact base64 through project serialization', () => {
    const binary = {path: 'images/picture.png', kind: 'binary', base64: 'AP9BQgo='};
    const model = ProjectModel.deserialize(new ProjectModel({files: [binary]}).serialize());
    assert.equal(model.get().base64, binary.base64);
    assert.equal(model.totalBytes, 5);
    assert.equal(model.mainPath, null);
    assert.throws(() => model.update('oops'), /文本文件/);
});

test('invalid paths and case-insensitive duplicates cannot enter projects', () => {
    for (const path of ['/absolute.tex', '../escape.tex', 'a/../b.tex', 'a/./b.tex', 'a//b.tex', 'C:\\file.tex', 'file\0.tex', 'scheme:file.tex']) {
        assert.throws(() => new ProjectModel({files: [textFile(path)]}));
    }
    assert.equal(ProjectModel.validatePath('chapters\\intro.tex'), 'chapters/intro.tex');
    const model = new ProjectModel({files: [textFile('Main.tex')]});
    assert.throws(() => model.add(textFile('main.tex')), /已存在/);
    assert.equal(model.list().length, 1);
    model.add(textFile('café.tex'));
    assert.throws(() => model.add(textFile('cafe\u0301.tex')), /已存在/);
});

test('batch import validates everything before adding any file', () => {
    const model = new ProjectModel({files: [textFile('main.tex', 'original')]});
    assert.throws(() => model.addMany([textFile('ok.tex'), textFile('../bad.tex')]));
    assert.deepEqual(plain(model.list().map(f => f.path)), ['main.tex']);
    assert.throws(() => model.addMany([textFile('new.tex'), textFile('NEW.tex')]));
    assert.equal(model.list().length, 1);
});

test('file mutations update active and main paths while keeping text/history', () => {
    const model = new ProjectModel({files: [textFile('main.tex', 'old'), textFile('refs.bib', 'bib')]});
    model.update('new');
    model.rename('main.tex', 'chapters/main.tex');
    assert.equal(model.activePath, 'chapters/main.tex');
    assert.equal(model.mainPath, 'chapters/main.tex');
    assert.equal(model.undo().text, 'old');
    model.remove('chapters/main.tex');
    assert.equal(model.activePath, 'refs.bib');
    assert.equal(model.mainPath, 'refs.bib');
    model.remove('refs.bib');
    assert.equal(model.activePath, null);
    assert.equal(model.get(), null);
    assert.equal(ProjectModel.deserialize(model.serialize()).list().length, 0);
});

test('history is isolated by file and redo is invalidated by a new edit', () => {
    const model = new ProjectModel({files: [textFile('a.tex', 'A'), textFile('b.ps', 'B')]});
    model.update('A1');
    model.select('b.ps');
    model.update('B1');
    assert.equal(model.undo().text, 'B');
    model.select('a.tex');
    assert.equal(model.undo().text, 'A');
    assert.equal(model.redo().text, 'A1');
    model.undo();
    model.update('A2');
    assert.equal(model.canRedo(), false);
    model.select('b.ps');
    assert.equal(model.redo().text, 'B1');
});

test('grouped typing forms one undo step and selection ends the group', () => {
    const model = new ProjectModel({files: [textFile('a.tex', ''), textFile('b.tex', '')]});
    model.update('a', {group: true});
    model.update('ab', {group: true});
    model.update('abc', {group: true});
    assert.equal(model.undo().text, '');
    assert.equal(model.undo(), null);
    model.redo();
    model.select('b.tex');
    model.select('a.tex');
    model.update('abcd', {group: true});
    assert.equal(model.undo().text, 'abc');
});

test('model snapshots cannot be changed by mutating returned records', () => {
    const model = new ProjectModel({files: [textFile('main.tex', 'kept')]});
    model.get().text = 'not saved';
    model.list()[0].text = 'also not saved';
    assert.equal(model.get().text, 'kept');
});

test('invalid file records and unsupported project versions are rejected', () => {
    assert.throws(() => new ProjectModel({files: [{path: 'a', kind: 'binary', base64: 'bad!'}]}));
    assert.throws(() => new ProjectModel({files: [{path: 'a', kind: 'text', text: null}]}));
    assert.throws(() => ProjectModel.deserialize('{broken'));
    assert.throws(() => ProjectModel.deserialize({format: 'visual-workspace', version: 99, files: []}));
    assert.throws(() => new ProjectModel({files: [textFile('a')], activePath: 'missing'}));
});

test('Latin-1 editing refuses unencodable text without changing content or history', () => {
    const model = new ProjectModel({files: [{path: 'legacy.ps', kind: 'text', encoding: 'latin1', text: '% café\r\n'}]});
    assert.throws(() => model.update('% 中文'), /Latin-1/);
    assert.equal(model.get().text, '% café\r\n');
    assert.equal(model.canUndo(), false);
    model.update('% été\r\n');
    assert.equal(model.get().encoding, 'latin1');
});

test('incomplete Unicode cannot be silently converted into replacement bytes', () => {
    const model = new ProjectModel({files: [textFile('main.tex', '😀')]});
    assert.throws(() => model.update('\ud800'), /Unicode/);
    assert.equal(model.get().text, '😀');
});

test('reference index finds live labels and citations with optional args across files', () => {
    const content = String.raw`% \label{hidden}
\section{Title}\label{sec:intro}
See \ref{sec:intro}, \Cref{fig:one,fig:two}; \cite[see][p. 2]{alpha,beta}.
\footnote{nested \citep{gamma}}
\verb|\cite{literal}|
\begin{lstlisting}
\cite{code}
\end{lstlisting}
\cite{unfinished`;
    const model = new ProjectModel({files: [textFile('main.tex', content), textFile('chapter.tex', '\\label{fig:one}'), textFile('draw.ps', '\\cite{postscript}') ]});
    const refs = plain(model.references());
    assert.deepEqual(refs.labels.map(x => x.key), ['sec:intro', 'fig:one']);
    assert.deepEqual(refs.citations.map(x => x.key), ['alpha', 'beta', 'gamma']);
    assert.deepEqual(refs.references.map(x => x.key), ['sec:intro', 'fig:one', 'fig:two']);
    assert.equal(content.slice(refs.citations[0].offset, refs.citations[0].offset + 5), '\\cite');
});

test('BibTeX index ignores comments and keeps entry locations for navigation', () => {
    const bib = '% @article{hidden, title={No}}\n@comment{ @article{fake, title={No}} }\n@string{venue="Test"}\n' +
        '@article{alpha, title={Nested {title}}, year={2026}}\n@book(beta, title="Book")\n';
    const model = new ProjectModel({files: [textFile('references.bib', bib)]});
    const entries = plain(model.references().bibliography);
    assert.deepEqual(entries.map(x => [x.key, x.type]), [['alpha', 'article'], ['beta', 'book']]);
    assert.equal(bib[entries[0].offset], '@');
});

test('history limit prevents unbounded edit snapshots', () => {
    const model = new ProjectModel({files: [textFile('a.tex', '0')]});
    for (let i = 1; i <= 110; i++) model.update(String(i));
    let undos = 0;
    while (model.undo()) undos++;
    assert.equal(undos, 100);
    assert.equal(model.get().text, '10');
});

test('project file count is bounded and rejection remains atomic', () => {
    const model = new ProjectModel();
    assert.throws(() => model.addMany(Array.from({length: 501}, (_, n) => textFile(n + '.tex'))), /500/);
    assert.equal(model.list().length, 0);
});

test('renaming a project validates names before replacing the current name', () => {
    const model = new ProjectModel({name: 'Keep'});
    assert.throws(() => { model.name = ' '; }, /名称/);
    assert.equal(model.name, 'Keep');
    model.name = 'Updated project';
    assert.equal(ProjectModel.deserialize(model.serialize()).name, 'Updated project');
});

test('explicit encoding conversion preserves text and permits Unicode only after UTF-8 conversion', () => {
    const model = new ProjectModel({files: [{path: 'legacy.ps', kind: 'text', encoding: 'latin1', text: '% café\r\n'}]});
    const priorSize = model.totalBytes;
    model.setEncoding('legacy.ps', 'utf-8');
    assert.equal(model.get().text, '% café\r\n');
    assert.equal(model.totalBytes, priorSize + 1);
    model.update('% 中文\r\n');
    assert.throws(() => model.setEncoding('legacy.ps', 'latin1'), /Latin-1/);
    assert.equal(model.get().encoding, 'utf-8');
    assert.equal(model.get().text, '% 中文\r\n');
    assert.equal(model.undo().text, '% café\r\n');
    model.setEncoding('legacy.ps', 'latin1');
    assert.equal(model.totalBytes, priorSize);
    assert.equal(model.canUndo(), false);
});
