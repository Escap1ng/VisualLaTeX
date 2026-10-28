import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const context = vm.createContext({document: {addEventListener() {}}, TextDecoder});
vm.runInContext(source, context);
const parse = text => context.parseTexToHtml(text);

test('UTF-8 file decoding preserves BOM and refuses invalid or NUL-containing input', () => {
    const text = '\ufeff\\documentclass{article}\r\n中文';
    assert.equal(context.decodeTexFile(new TextEncoder().encode(text)), text);
    assert.throws(() => context.decodeTexFile(Uint8Array.from([0xff, 0xfe, 0x41])));
    assert.throws(() => context.decodeTexFile(Uint8Array.from([0x41, 0x00])));
});

function decodeAttribute(text) {
    return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot);/gi, (_, entity) => {
        if (entity[0] === '#') return String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
        return {amp: '&', lt: '<', gt: '>', quot: '"'}[entity];
    });
}

// Read only generated tags and attributes. This is not a browser DOM substitute;
// it checks parser token boundaries and that every original source byte is owned.
function elements(html) {
    const roots = [];
    const all = [];
    const stack = [];
    for (const match of html.matchAll(/<(\/?)([a-z\d]+)([^>]*)>/gi)) {
        const [, closing, tag, attrText] = match;
        if (closing) { stack.pop(); continue; }
        const attrs = {};
        for (const attr of attrText.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[attr[1]] = decodeAttribute(attr[2] || '');
        const node = {tag, attrs};
        all.push(node);
        if (!stack.length) roots.push(node);
        if (tag !== 'img' && tag !== 'br') stack.push(node);
    }
    return {roots, all};
}

function assertSourceCoverage(input) {
    const html = parse(input);
    const {roots} = elements(html);
    for (const root of roots) assert.ok(Object.hasOwn(root.attrs, 'data-tex-source'), 'every root must retain source');
    assert.equal(roots.map(n => n.attrs['data-tex-source']).join(''), input);
    return {html, ...elements(html)};
}

test('HTML-looking TeX is text, never active HTML', () => {
    for (const input of [
        '<img src=x onerror="window.__importExecuted=true">',
        '<script>alert(1)</script>',
        String.raw`\section{<img src=x onerror="alert(1)">} Tail`,
        String.raw`\begin{lstlisting}<iframe src="https://example.invalid"></iframe>\end{lstlisting}`,
    ]) {
        const {all} = assertSourceCoverage(input);
        assert.ok(all.every(node => !['img', 'script', 'iframe', 'svg'].includes(node.tag)));
        assert.ok(all.every(node => Object.keys(node.attrs).every(name => !/^on/i.test(name))));
    }
});

test('figure attribute contents cannot create event handlers', () => {
    const input = String.raw`\begin{figure}\includegraphics{x" onerror="alert(1)}\caption{<svg onload="alert(2)">}\end{figure}`;
    const {all} = assertSourceCoverage(input);
    assert.ok(all.every(node => Object.keys(node.attrs).every(name => !/^on/i.test(name))));
    assert.equal(all.filter(node => node.tag === 'svg').length, 0);
});

test('heading consumes balanced argument only, retaining following label/body', () => {
    const input = String.raw`\section{A \textbf{bold} title}\label{sec:intro} First sentence.`;
    const {roots, html} = assertSourceCoverage(input);
    assert.equal(roots[0].tag, 'h1');
    assert.equal(roots[0].attrs['data-tex-source'], String.raw`\section{A \textbf{bold} title}`);
    assert.ok(html.includes(' title'));
    assert.ok(roots.some(n => n.attrs['data-tex-source'].includes('First sentence.')));
});

test('starred/short headings and unsupported commands keep complete source', () => {
    for (const input of [String.raw`\section*[Short]{A {nested} title} tail`, String.raw`\custom[opt]{a{b}c}{d} after`]) {
        assertSourceCoverage(input);
    }
});

test('literal environments retain percent signs, HTML, and fake nested commands', () => {
    for (const name of ['lstlisting', 'verbatim', 'Verbatim', 'minted']) {
        const input = '\\begin{' + name + '}\r\nx = 10 % 3; <tag> \\begin{figure} $fake$\r\n\\end{' + name + '}';
        const {roots, html} = assertSourceCoverage(input);
        assert.equal(roots.length, 1);
        assert.equal(roots[0].attrs.class, 'raw-tex');
        assert.ok(html.includes('10 % 3;'));
        assert.ok(!html.includes('class="formula-inline"'));
    }
});

test('unknown outer environments are isolated before any inner conversion', () => {
    const input = String.raw`\begin{abstract}
\begin{equation}x=1\end{equation}
\end{abstract}`;
    const {roots, all} = assertSourceCoverage(input);
    assert.equal(roots.length, 1);
    assert.equal(all.length, 1);
    assert.equal(roots[0].attrs.class, 'raw-tex');
});

test('same-name nested and malformed environments are preserved as complete raw units', () => {
    for (const input of [
        String.raw`\begin{itemize}\item Outer\begin{itemize}\item Inner\end{itemize}\end{itemize}`,
        String.raw`\begin{custom}missing end`,
        String.raw`\begin{custom}\begin{other}mismatch\end{custom}`,
    ]) {
        const {roots} = assertSourceCoverage(input);
        assert.equal(roots[0].attrs.class, 'raw-tex');
    }
});

test('multiple images and unsupported figure options remain raw without omissions', () => {
    for (const input of [
        String.raw`\begin{figure}[t]\includegraphics[width=.3\textwidth]{a.png}\includegraphics[width=.4\textwidth]{b.png}\caption{Both}\end{figure}`,
        String.raw`\begin{figure}\includegraphics[angle=90]{a.png}\caption{Rotated}\end{figure}`,
        String.raw`\begin{figure}\includegraphics{https://example.invalid/tracker}\end{figure}`,
    ]) {
        const {roots, all} = assertSourceCoverage(input);
        assert.equal(roots[0].attrs.class, 'raw-tex');
        assert.ok(all.every(node => node.tag !== 'img'));
    }
});

test('simple single-image figure retains the visual path and original parameters', () => {
    const input = String.raw`\begin{figure}[t]
\centering
\includegraphics[width=.3\textwidth]{a.png}
\caption{A \textbf{nested} caption}\label{fig:a}
\end{figure}`;
    const {roots} = assertSourceCoverage(input);
    assert.equal(roots[0].tag, 'img');
    assert.equal(roots[0].attrs['data-width'], '.3');
    assert.equal(roots[0].attrs['data-placement'], 't');
    assert.equal(roots[0].attrs['data-caption'], String.raw`A \textbf{nested} caption`);
});

test('optional-label lists stay raw; basic lists stay visual', () => {
    for (const name of ['itemize', 'enumerate']) {
        const optional = '\\begin{' + name + '}\\item[Important] Keep this\\end{' + name + '}';
        const {roots} = assertSourceCoverage(optional);
        assert.equal(roots[0].attrs.class, 'raw-tex');
        const basic = '\\begin{' + name + '}\n\\item One\n\\item Two\n\\end{' + name + '}';
        const parsed = assertSourceCoverage(basic);
        assert.equal(parsed.roots[0].tag, name === 'itemize' ? 'ul' : 'ol');
        assert.equal(parsed.all.filter(node => node.tag === 'li').length, 2);
    }
});

test('all supported math delimiters remain distinct and escaped currency is not math', () => {
    const input = String.raw`A $x$ B $$x^2$$ C \(y\) D \[z\] E \$5 and \$10.`;
    const {all} = assertSourceCoverage(input);
    const formulas = all.filter(n => /formula-/.test(n.attrs.class || ''));
    assert.deepEqual(formulas.map(n => n.attrs['data-delimiter']), ['$', '$$', '\\(', '\\[']);
    assert.deepEqual(formulas.map(n => n.attrs['data-formula']), ['x', 'x^2', 'y', 'z']);
    assert.equal(all.filter(n => n.attrs.class === 'tex-cmd' && n.attrs['data-tex-source'] === '\\$').length, 2);
});

test('existing escapes and nested formatting are protected TeX tokens', () => {
    const input = String.raw`Rate 50\% and file\_name. \textbf{A \textit{nested} B} \cite[See]{key,{other}}`;
    const {all} = assertSourceCoverage(input);
    for (const token of ['\\%', '\\_', '\\cite[See]{key,{other}}']) {
        assert.ok(all.some(n => n.attrs.class === 'tex-cmd' && n.attrs['data-tex-source'] === token));
    }
    assert.ok(all.some(n => n.tag === 'b'));
    assert.ok(all.some(n => n.tag === 'i'));
});

test('comments and CRLF whitespace are represented without source normalization', () => {
    const input = ' \r\n% before\r\nHello% attached\r\nworld\r\n\r\n\\section{Next}\r\n\tTail  \r\n';
    const {html, all} = assertSourceCoverage(input);
    assert.ok(html.includes('&#13;&#10;'));
    assert.ok(all.some(n => n.attrs.class === 'tex-cmd' && n.attrs.hidden === '' && n.attrs['data-tex-source'].startsWith('%')));
    assertSourceCoverage(' \r\n\t\r\n');
    assert.equal(parse(''), '');
});

test('inline verbatim protects percent, math and fake environment tokens', () => {
    for (const input of [
        String.raw`Before \verb|x%y $z$ \begin{figure}| after`,
        String.raw`Before \verb*+a% \section{fake}+ after`,
        String.raw`Before \lstinline[language=C]!10 % 3;! after`,
    ]) {
        const {all, roots} = assertSourceCoverage(input);
        assert.equal(roots.length, 1);
        assert.equal(roots[0].tag, 'p');
        assert.ok(all.some(n => n.attrs.class === 'tex-cmd' && /\\(?:verb|lstinline)/.test(n.attrs['data-tex-source'])));
        assert.ok(all.every(n => !/formula-/.test(n.attrs.class || '')));
        assert.ok(all.every(n => !Object.hasOwn(n.attrs, 'hidden')));
    }
    const env = String.raw`\begin{custom}\verb|\end{custom}| tail\end{custom}`;
    const parsed = assertSourceCoverage(env);
    assert.equal(parsed.roots.length, 1);
    const malformed = 'Before \\verb|x%y\nvisible after';
    assertSourceCoverage(malformed);
});

test('line breaks retain optional length and starred variant on one token', () => {
    const input = String.raw`A\\[2pt]B\\*[1ex]C`;
    const {all} = assertSourceCoverage(input);
    assert.deepEqual(all.filter(n => n.tag === 'br').map(n => n.attrs['data-tex-source']), ['\\\\[2pt]', '\\\\*[1ex]']);
});
