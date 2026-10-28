import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const context = vm.createContext({document: {addEventListener() {}}, Node: {TEXT_NODE: 3, ELEMENT_NODE: 1}});
vm.runInContext(source, context);

// Minimal DOM model for the serializer. These tests do not claim browser layout coverage.
const html = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const T = value => ({nodeType: 3, textContent: value});
function E(tag, children = [], attributes = {}) {
    const attrs = new Map(Object.entries(attributes));
    const node = {
        nodeType: 1, tagName: tag.toUpperCase(), childNodes: children,
        get attributes() { return Array.from(attrs, ([name, value]) => ({name, value})); },
        getAttribute(name) { return attrs.get(name) ?? null; },
        setAttribute(name, value) { attrs.set(name, String(value)); },
        removeAttribute(name) { attrs.delete(name); },
        classList: {contains(name) { return (attrs.get('class') || '').split(/\s+/).includes(name); }},
        get textContent() { return this.childNodes.map(child => child.textContent).join(''); },
        get innerHTML() { return this.childNodes.map(child => child.nodeType === 3 ? html(child.textContent) : child.outerHTML).join(''); },
        get outerHTML() {
            const name = this.tagName.toLowerCase();
            const start = '<' + name + Array.from(attrs, ([key, value]) => ' ' + key + '="' + html(value) + '"').join('') + '>';
            return /^(img|br)$/.test(name) ? start : start + this.innerHTML + '</' + name + '>';
        },
    };
    node.style = {
        get textAlign() { return /(?:^|;)\s*text-align:\s*([^;]+)/.exec(attrs.get('style') || '')?.[1] || ''; },
        set textAlign(value) { attrs.set('style', 'text-align: ' + value + ';'); },
    };
    return node;
}
function imported(node, tex) {
    node.setAttribute('data-tex-source', tex);
    node.setAttribute('data-tex-snapshot', context.getTexNodeSnapshot(node));
    return node;
}
const convert = node => context.convertNodeToLatex(node);
const formula = (tex, delimiter, block = false) => E(block ? 'div' : 'span', [T(tex)], {
    class: block ? 'formula-block' : 'formula-inline', 'data-formula': tex, 'data-delimiter': delimiter,
});

test('untouched imported nodes retain every byte, including CRLF and comments', () => {
    const original = '\r\n\\section{Title} % keep this\r\n';
    assert.equal(convert(imported(E('h1', [T('Title')]), original)), original);
    const gap = imported(E('span', [], {class: 'tex-whitespace', hidden: ''}), '\r\n\t  ');
    assert.equal(convert(gap), '\r\n\t  ');
});

test('editing a paragraph preserves untouched inline TeX tokens and source of other roots', () => {
    const command = imported(E('span', [T('\\%')], {class: 'tex-cmd'}), '\\%');
    const bold = imported(E('b', [T('bold')]), '\\textbf {bold}');
    const paragraph = imported(E('p', [T('Rate 50'), command, T(' and '), bold]), 'Rate 50\\% and \\textbf {bold}');
    paragraph.childNodes[0].textContent = 'Rate 60';
    assert.equal(convert(paragraph), 'Rate 60\\% and \\textbf {bold}');
    const listingSource = '\\begin{lstlisting}\r\nx = 10 % 3;\r\n\\end{lstlisting}';
    const listing = imported(E('div', [T(listingSource)], {class: 'raw-tex'}), listingSource);
    assert.equal(convert(listing), listingSource);
});

test('root formatting and tag changes invalidate original-source snapshot', () => {
    const paragraph = imported(E('p', [T('Text')]), 'Text');
    paragraph.style.textAlign = 'center';
    assert.match(convert(paragraph), /^\\begin\{center\}/);
    const heading = imported(E('h1', [T('Title')]), '\\section{Title}');
    heading.tagName = 'H2';
    assert.equal(convert(heading), '\\subsection{Title}');
});

test('changing formula attributes invalidates original-source snapshot', () => {
    const node = imported(formula('x', '$'), '$x$');
    node.setAttribute('data-formula', 'y');
    assert.equal(convert(node), '$y$');
});

test('preservation metadata does not invalidate parent snapshots or grow recursively', () => {
    const child = E('b', [T('bold')]);
    const parent = imported(E('p', [child]), '\\textbf {bold}');
    const before = context.getTexNodeSnapshot(parent);
    imported(child, '\\textbf {bold}');
    assert.equal(context.getTexNodeSnapshot(parent), before);
    assert.equal(convert(parent), '\\textbf {bold}');
    child.childNodes[0].textContent = 'changed';
    assert.notEqual(context.getTexNodeSnapshot(parent), before);
    assert.equal(convert(parent), '\\textbf{changed}');
});

test('formulas retain math delimiters at root and inside a paragraph', () => {
    for (const [delimiter, expected, block] of [
        ['$', '$x^2$', false], ['$$', '$$x^2$$', true],
        ['\\(', '\\(x^2\\)', false], ['\\[', '\\[x^2\\]', true],
    ]) {
        assert.equal(convert(formula('x^2', delimiter, block)), expected);
        assert.equal(convert(E('p', [T('before '), formula('x^2', delimiter, block), T(' after')])), 'before ' + expected + ' after\n\n');
    }
});

test('paragraph images are exported, preserve captions, and do not introduce float H dependency', () => {
    const node = E('p', [T('Before '), E('img', [], {
        src: 'figure.png', 'data-caption': 'Rate 50% & value_1', 'data-label': 'fig:test',
    }), T(' after')]);
    const tex = convert(node);
    assert.match(tex, /\\begin\{figure\}\[htbp\]/);
    assert.match(tex, /\\includegraphics\[width=0\.6\\textwidth\]\{figure\.png\}/);
    assert.ok(tex.includes(String.raw`\caption{Rate 50\% \& value\_1}`));
    assert.ok(tex.endsWith(' after\n\n'));
    assert.ok(!tex.includes('[H]'));
});

test('edited imported image preserves requested placement and TeX caption', () => {
    const image = imported(E('img', [], {
        src: 'old.png', 'data-caption': '\\textbf{Caption}', 'data-caption-tex': 'true',
        'data-placement': 't', 'data-width': '0.3',
    }), '\\begin{figure}[t]...\\end{figure}');
    image.setAttribute('src', 'new.png');
    const tex = convert(image);
    assert.match(tex, /\\begin\{figure\}\[t\]/);
    assert.ok(tex.includes('\\caption{\\textbf{Caption}}'));
    assert.ok(tex.includes('{new.png}'));
    assert.ok(!tex.includes('fig:image'));
});

test('line breaks and nested paragraphs are not flattened', () => {
    assert.equal(convert(E('p', [T('first'), E('br'), T('second')])), 'first\\\\\nsecond\n\n');
    assert.equal(convert(E('div', [E('p', [T('first')]), E('p', [T('second')])])), 'first\n\nsecond\n\n\n\n');
});

test('splitting an imported paragraph inserts a real paragraph break even if attributes are cloned', () => {
    const first = imported(E('p', [T('first second')]), 'first second');
    const second = E('p', [T('second')], Object.fromEntries(first.attributes.map(attr => [attr.name, attr.value])));
    first.childNodes[0].textContent = 'first';
    assert.equal(context.convertEditorNodesToLatex([first, second]), 'first\n\nsecond');
    const newParagraph = E('div', [T('second')]);
    assert.equal(context.convertEditorNodesToLatex([first, newParagraph]), 'first\n\nsecond\n\n');
});

test('existing source gaps and unchanged neighboring roots are not reformatted', () => {
    const first = imported(E('p', [T('first')]), 'first');
    const second = imported(E('p', [T('second')]), 'second');
    const gap = imported(E('span', [], {class: 'tex-whitespace', hidden: ''}), '\r\n\r\n');
    assert.equal(context.convertEditorNodesToLatex([first, gap, second]), 'first\r\n\r\nsecond');
    assert.equal(context.convertEditorNodesToLatex([first, second]), 'firstsecond');
});

test('ordinary text is escaped consistently in headings, bold, italic, and list items', () => {
    const text = '100% & value_1 # {x} $ ~ ^ \\';
    const escaped = String.raw`100\% \& value\_1 \# \{x\} \$ \textasciitilde{} \textasciicircum{} \textbackslash{}`;
    assert.equal(convert(E('h1', [T(text)])), '\\section{' + escaped + '}\n\n');
    assert.equal(convert(E('b', [T(text)])), '\\textbf{' + escaped + '}');
    assert.equal(convert(E('i', [T(text)])), '\\textit{' + escaped + '}');
    assert.ok(convert(E('ul', [E('li', [T(text)])])).includes('\\item ' + escaped));
});

test('nested formatting, formulas, commands, and nested lists retain their semantics', () => {
    const list = E('ul', [E('li', [E('b', [T('bold '), E('i', [T('italic')])]), T(' '),
        formula('x_1', '$'), E('span', [T('\\cite{ref}')], {class: 'tex-cmd'}),
        E('ol', [E('li', [T('nested')])]),
    ])]);
    const tex = convert(list);
    assert.ok(tex.includes('\\textbf{bold \\textit{italic}}'));
    assert.ok(tex.includes('$x_1$\\cite{ref}'));
    assert.ok(tex.includes('\\begin{enumerate}'));
    assert.ok(tex.includes('\\item nested'));
});

test('editing an imported emph body retains the emph command', () => {
    const node = imported(E('em', [T('old')], {'data-tex-command': 'emph'}), '\\emph{old}');
    node.childNodes[0].textContent = 'new';
    assert.equal(convert(node), '\\emph{new}');
});

test('appending text after an imported hidden comment cannot swallow the new text', () => {
    const comment = imported(E('span', [T('% keep')], {class: 'tex-cmd', hidden: ''}), '% keep');
    const paragraph = imported(E('p', [T('Text '), comment]), 'Text % keep');
    assert.equal(convert(paragraph), 'Text % keep');
    paragraph.childNodes.push(T(' appended'));
    assert.equal(convert(paragraph), 'Text % keep\n appended');
    const terminated = E('p', [comment, T('\nnext line')]);
    assert.equal(convert(terminated), '% keep\nnext line\n\n');
});

test('new formatting around a terminal comment does not comment out the closing brace', () => {
    const comment = imported(E('span', [T('% keep')], {class: 'tex-cmd', hidden: ''}), '% keep');
    assert.equal(convert(E('b', [T('Text '), comment])), '\\textbf{Text % keep\n}');
});

test('editing simple imported figures preserves absent width, centering, and empty captions', () => {
    const image = imported(E('img', [], {
        src: 'old.png', 'data-width': '', 'data-centering': 'false', 'data-placement': '',
        'data-caption': '', 'data-caption-tex': 'true', 'data-has-caption': 'true',
    }), '\\begin{figure}\\includegraphics{old.png}\\caption{}\\end{figure}');
    image.setAttribute('src', 'new.png');
    const tex = convert(image);
    assert.ok(tex.includes('\\includegraphics{new.png}'));
    assert.ok(!tex.includes('width='));
    assert.ok(!tex.includes('\\centering'));
    assert.ok(tex.includes('\\caption{}'));
});

test('raw-block editing preserves existing text and contenteditable line breaks', () => {
    const raw = E('div', [T('first'), E('div', [T('second')]), E('div', [E('br')]), E('div', [T('last')])], {class: 'raw-tex'});
    assert.equal(convert(raw), 'first\nsecond\n\nlast');
    assert.equal(convert(E('div', [T('x = 10 % 3;\r\n')], {class: 'raw-tex'})), 'x = 10 % 3;\r\n');
});
