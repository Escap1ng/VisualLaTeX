import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({TextEncoder});
for (const name of ['project-model.js', 'visual-references.js']) {
    vm.runInContext(fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8'), context);
}
const {ProjectModel, VisualReferences: api} = context;
const plain = value => JSON.parse(JSON.stringify(value));
const file = (path, text) => ({path, kind: 'text', text});
const model = files => new ProjectModel({files, activePath: files[0].path});

test('citation variants expose plain semantic data and preserve optional notes and star', () => {
    for (const command of ['cite', 'citep', 'citet', 'autocite', 'parencite', 'textcite', 'nocite']) {
        const value = api.describe('\\' + command + '* [see][pp. 1–2] { alpha, beta }');
        assert.equal(value.kind, 'citation');
        assert.equal(value.command, command + '*');
        assert.equal(value.cmd, value.command);
        assert.equal(value.key, 'alpha, beta');
        assert.deepEqual(plain(value.keys), ['alpha', 'beta']);
        assert.deepEqual(plain(value.options), ['see', 'pp. 1–2']);
        assert.equal(value.editable, true);
        assert.doesNotMatch(value.label, /\\/);
    }
});

test('unmodified values round trip byte for byte, including CRLF, comments and argument spacing', () => {
    const source = ' \r\n\\citep* % preserve\r\n [see {this}] [pp. 7–9]\t{ alpha ,beta } % tail\r\n';
    assert.equal(api.rewrite(source), source);
    assert.equal(api.rewrite(source, {key: 'alpha, beta'}), source);
    assert.equal(api.rewrite(source, {keys: ['alpha', 'beta'], options: ['see {this}', 'pp. 7–9']}), source);
    assert.equal(api.rewrite(source, {keys: ['gamma', 'beta']}), source.replace(' alpha ,beta ', ' gamma, beta '));
});

test('key edits preserve reference variants and only the required argument changes', () => {
    for (const command of ['ref', 'eqref', 'autoref', 'pageref', 'label', 'Cref']) {
        const source = '\\' + command + '* \t{ sec:old }';
        assert.equal(api.rewrite(source, {key: 'sec:new'}), '\\' + command + '* \t{ sec:new }');
    }
    assert.equal(api.rewrite('\\nocite{*}', {keys: ['entry']}), '\\nocite{entry}');
    assert.equal(api.describe('\\nocite{*}').label, '收录全部参考文献');
});

test('key validation prevents escaping arguments and injecting LaTeX commands', () => {
    for (const key of ['', 'a b', 'a\nb', 'a\\b', 'a}\\input{secret', 'a{b', 'a[b', 'a]b', 'a%b', 'a#b', 'a,b', 'a$b', 'a&b', 'a^b', 'a~b', 'a\0b', '*']) {
        assert.throws(() => api.rewrite('\\label{old}', {key}), /键|通配符/);
    }
    assert.throws(() => api.rewrite('\\cite{old}', {keys: ['one', 'two,three']}));
    assert.throws(() => api.rewrite('\\ref{old}', {keys: ['one', 'two']}));
    assert.throws(() => api.rewrite('\\ref{old}', {key: 2}));
    assert.throws(() => api.rewrite('\\cite{old}', {keys: ['one', '']}));
    assert.equal(api.rewrite('\\label{old}', {key: '章节:方法_2026.1-甲'}), '\\label{章节:方法_2026.1-甲}');
});

test('explicit optional note edits retain untouched notes and balanced TeX content', () => {
    const source = '\\citep* [see] % note\r\n [p. 2] {key}';
    assert.equal(api.rewrite(source, {options: ['compare', 'p. 2']}), source.replace('[see]', '[compare]'));
    assert.equal(api.rewrite('\\cite{a}', {options: ['see {A [B]}', 'p. 3'], key: 'b'}), '\\cite[see {A [B]}][p. 3]{b}');
    assert.equal(api.rewrite('\\cite[see][p. 2]{a}', {options: ['p. 3']}), '\\cite[p. 3]{a}');
    assert.equal(api.rewrite('\\cite[see]{a}', {options: []}), '\\cite{a}');
    for (const options of [['bad]\\input{other}'], ['bad{'], ['bad}'], ['bad%'], [42], 'bad']) {
        assert.throws(() => api.rewrite('\\cite{a}', {options}));
    }
});

test('unsupported and incomplete fragments remain outside the reference editor', () => {
    for (const source of ['plain', '\\textbf{word}', '\\cite{missing', '\\cite[missing{a}', '\\ref{a}{b}', '\\cite{a} trailing', '\\cite', '% \\label{fake}']) {
        assert.equal(api.describe(source), null, source);
        assert.throws(() => api.rewrite(source, {key: 'b'}));
    }
    assert.equal(api.describe(null), null);
});

test('references use actual project section titles and never invent compiled numbers', () => {
    const project = model([file('main.tex', String.raw`\section{Research \textbf{methods}}\label{sec:methods}
\subsection[Short]{Detailed setup}\label{sec:setup}`)]);
    assert.equal(api.describe('\\ref{sec:methods}', project).label, 'Research methods');
    assert.equal(api.describe('\\autoref{sec:setup}', project).label, 'Detailed setup');
    assert.equal(api.describe('\\label{sec:methods}', project).label, '标签：sec:methods');
    assert.match(api.describe('\\label{sec:methods}', project).detail, /Research methods.*main\.tex/);
    assert.equal(api.describe('\\pageref{sec:methods}', project).label, 'Research methods · 页码待编译');
    assert.equal(api.describe('\\eqref{sec:methods}', project).label, '公式：sec:methods');
    const missing = api.describe('\\ref{missing}', project);
    assert.equal(missing.label, 'missing');
    assert.equal(missing.detail, '未找到标签：missing');
});

test('formula references in the same section remain distinguishable by their actual label keys', () => {
    const project = model([file('main.tex', String.raw`\section{Visual mathematics}\label{sec:math}
\begin{equation}E=mc^2\label{eq:energy}\end{equation}
\begin{align*}a&=b\label{eq:second}\end{align*}
\[c=d\label{eq:display}\]
\label{sec:after}`)]);
    for (const key of ['eq:energy','eq:second','eq:display']) {
        assert.equal(api.describe('\\eqref{' + key + '}', project).label, '公式：' + key);
        assert.equal(api.describe('\\ref{' + key + '}', project).label, '公式：' + key);
        assert.equal(api.describe('\\autoref{' + key + '}', project).label, '公式：' + key);
        assert.match(api.describe('\\eqref{' + key + '}', project).detail, /Visual mathematics/);
    }
    assert.equal(api.describe('\\ref{sec:math}', project).label, 'Visual mathematics');
    assert.equal(api.describe('\\ref{sec:after}', project).label, 'Visual mathematics');
    assert.equal(api.describe('\\eqref{missing}', project).label, '公式：missing');
    assert.equal(api.getChoices('reference', project).find(choice => choice.value === 'eq:energy').label, '公式：eq:energy');
});

test('label indexing ignores comments, escaped backslashes, inline verbatim and verbatim environments', () => {
    const source = String.raw`% \section{Wrong}\label{comment}
\section{Real \% title}\label{real}
\verb|\label{inline}| \verb*+\label{star}+
\lstinline[language=TeX]!\label{listing}!
\begin{verbatim}\label{environment}\end{verbatim}
\begin{minted}{latex}\label{minted}\end{minted}
\begin{comment}\label{hidden}\end{comment}
\\label{escaped}
\label{after}`;
    const project = model([file('main.tex', source)]);
    assert.deepEqual(plain(api.getChoices('reference', project).map(item => item.value)), ['real', 'after']);
    assert.equal(api.describe('\\ref{real}', project).label, 'Real % title');
});

test('nested and quoted BibTeX metadata yields human-readable citation labels', () => {
    const project = model([file('main.tex', ''), file('refs.bib', String.raw`% @article{hidden, title={Hidden}}
@string{journal = "Not a reference"}
@comment{ @article{alsohidden, title={Hidden}} }
@article{lamport,
 author = {Lamport, Leslie and {Research Group}},
 title = {A {Nested {LaTeX}} \textit{Document}},
 year = 1994
}
@book(knuth, author = "Knuth, Donald", title = "The {TeX}book, Volume A", year={1984})`)]);
    const choices = plain(api.getChoices('citation', project));
    assert.deepEqual(choices.map(item => item.value), ['lamport', 'knuth']);
    assert.equal(choices[0].label, 'Lamport, Leslie and Research Group — A Nested LaTeX Document');
    assert.match(choices[1].label, /The TeXbook, Volume A/);
    const cited = api.describe('\\cite[see][p. 2]{lamport, knuth}', project);
    assert.match(cited.label, /Lamport.*Knuth/);
    assert.match(cited.detail, /1994.*refs\.bib.*1984/);
    assert.doesNotMatch(cited.label, /\\cite|\[1\]|\[2\]/);
    assert.match(api.describe('\\cite{unknown}', project).detail, /未找到文献/);
});

test('metadata stays plain text even when document headings and BibTeX contain markup', () => {
    const project = model([file('main.tex', '\\section{<img src=x onerror=alert(1)>}\\label{x}'),
        file('refs.bib', '@article{attack,title={<script>alert(1)</script>}}')]);
    assert.equal(api.describe('\\ref{x}', project).label, '<img src=x onerror=alert(1)>');
    assert.equal(api.describe('\\cite{attack}', project).label, '<script>alert(1)</script>');
    assert.equal(typeof api.describe('\\cite{attack}', project).label, 'string');
    assert.equal('html' in api.describe('\\ref{x}', project), false);
});

test('BibTeX comments cannot swallow metadata or introduce fake entries through unmatched braces', () => {
    const project = model([file('refs.bib', String.raw`@article{paper,
% misplaced { }, title={Wrong},
author = {A. Researcher}, % an unmatched },
title = {Results with 50\% improvement},
year = {2026}
}
% @article{fake, title={Fake}}
@article{next,title={Next paper}}`)]);
    const choices = plain(api.getChoices('citation', project));
    assert.deepEqual(choices.map(item => item.value), ['paper', 'next']);
    assert.equal(choices[0].label, 'A. Researcher — Results with 50% improvement');
    assert.match(choices[0].detail, /2026/);
});

test('duplicate labels and bibliography entries are explicit instead of picking an arbitrary target', () => {
    const project = model([file('main.tex', '\\section{First}\\label{same}'), file('chapter.tex', '\\section{Second}\\label{same}'),
        file('a.bib', '@article{same,title={First}}'), file('b.bib', '@article{same,title={Second}}')]);
    assert.match(api.describe('\\ref{same}', project).detail, /重复标签/);
    assert.match(api.describe('\\cite{same}', project).label, /文献键重复/);
});

test('file and bibliography setup commands have readable descriptions and safe edits', () => {
    const project = model([file('main.tex', ''), file('chapters/intro.tex', ''), file('refs.bib', ''), file('image.ps', '')]);
    assert.equal(api.describe('\\input{chapters/intro}').label, '引入文件：chapters/intro');
    assert.equal(api.describe('\\bibliography{refs,extra}').label, '文献库：refs、extra');
    assert.equal(api.describe('\\addbibresource[location=local]{refs.bib}').label, '文献库：refs.bib');
    assert.equal(api.describe('\\bibliographystyle{plain}').label, '文献样式：plain');
    assert.equal(api.describe('\\printbibliography[title={References}]').editable, false);
    assert.throws(() => api.rewrite('\\printbibliography', {key: 'refs'}));
    assert.equal(api.rewrite('\\addbibresource[location=local]{refs.bib}', {key: 'other.bib'}), '\\addbibresource[location=local]{other.bib}');
    assert.deepEqual(plain(api.getChoices('include', project).map(item => item.value)), ['main.tex', 'chapters/intro.tex']);
    assert.deepEqual(plain(api.getChoices('bibliography', project).map(item => item.value)), ['refs.bib']);
    assert.equal(api.getChoices('style', project).length, 4);
    assert.deepEqual(plain(api.getChoices('other', project)), []);
});

test('cached metadata updates when a project file changes', () => {
    const project = model([file('main.tex', '\\section{Before}\\label{target}')]);
    assert.equal(api.describe('\\ref{target}', project).label, 'Before');
    project.update('\\section{After}\\label{target}');
    assert.equal(api.describe('\\ref{target}', project).label, 'After');
    project.update('\\section{After}\\label{renamed}');
    assert.match(api.describe('\\ref{target}', project).detail, /未找到标签/);
});
