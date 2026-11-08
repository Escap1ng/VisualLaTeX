import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDocument, Element } from './helpers/dom.mjs';

// These integration checks use real application functions with a minimal DOM
// fixture, not a browser engine. Browser execution and TeX compilation are separate.
const source = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
function fixture(storage = new Map()) {
    const document = createDocument();
    const editor = new Element('div');
    const preview = new Element('div');
    const status = new Element('span');
    const alerts = [];
    const errors = [];
    const documentEvents = {};
    const windowEvents = {};
    const controls = { failWrites: false, confirm: true, reloads: 0 };
    document.addEventListener = (type, handler) => { documentEvents[type] = handler; };
    document.getElementById = id => ({ editorArea: editor, previewArea: preview, statusText: status })[id];
    const context = vm.createContext({
        document, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, Date,
        console: { error: (...args) => errors.push(args) },
        alert: message => alerts.push(message),
        confirm: () => controls.confirm,
        clearTimeout() {}, setTimeout() { return 1; },
        location: { reload() { controls.reloads++; } },
        window: { addEventListener: (type, handler) => { windowEvents[type] = handler; } },
        localStorage: { getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => {
                if (controls.failWrites) throw new Error('QuotaExceededError');
                storage.set(key, String(value));
            }, removeItem: key => storage.delete(key) },
        __editor: editor, __preview: preview, __status: status,
    });
    vm.runInContext(source, context);
    vm.runInContext('editorArea=__editor;previewArea=__preview;statusText=__status;', context);
    function initialize() {
        // Run real startup and persistence callbacks while excluding unrelated UI setup.
        vm.runInContext('initToolbar=()=>{};initPanelTabs=()=>{};initFormulaModal=()=>{};', context);
        documentEvents.DOMContentLoaded();
    }
    return { context, editor, preview, status, storage, alerts, errors, controls, windowEvents, initialize };
}

const documentWith = body => '\\documentclass{article}\n\\begin{document}' + body + '\\end{document}\n';
const roundtripCases = [
    ['CRLF, comments, blank lines and tail', '\ufeff  % leading comment\r\n\\documentclass{article}\r\n\r\n\\begin{document}\r\n\r\nText % keep this comment\r\nnext line\r\n\r\n\\end{document}\r\n% trailing comment\r\n  '],
    ['same-line heading and reference', documentWith(String.raw`\section{A \textbf{bold} title}\label{sec:intro} First sentence.`)],
    ['multiple images and figure parameters', documentWith(String.raw`
\begin{figure}[t]
\includegraphics[width=.3\textwidth]{a.png}
\includegraphics[width=.4\textwidth]{b.png}
\caption{A \textbf{nested} caption}
\end{figure}
`)],
    ['optional list labels', documentWith(String.raw`\begin{itemize}\item[Important] Keep this\end{itemize}`)],
    ['literal code percent and HTML', documentWith(String.raw`\begin{lstlisting}
x = 10 % 3;
<img src=x onerror="bad()">
\end{lstlisting}`)],
    ['nested equation inside preserved environment', documentWith(String.raw`\begin{abstract}
\begin{equation}x=1\end{equation}
\end{abstract}`)],
    ['all math delimiters and escaped text', documentWith(String.raw`Cost \$5, rate 50\%, file\_name. $x$ $$y$$ \(z\) \[w\]`)],
    ['document markers inside comments, macro arguments and literal code', String.raw`% \begin{document}
\documentclass{article}
\newcommand{\sample}{\begin{document}}
\begin{document}
\begin{lstlisting}
literal \end{document}
\end{lstlisting}
\lstinline|\end{document}| and \verb|\begin{document}|
Done.
\end{document}
% tail`],
];

for (const [name, tex] of roundtripCases) {
    test('import/export preserves exact source: ' + name, () => {
        const f = fixture();
        f.context.applyImportedTex(tex, 'paper.tex');
        assert.deepEqual(f.alerts, []);
        assert.equal(f.context.domToLatex(), tex);
        assert.equal(f.preview.textContent, tex);
    });
}

test('editing one paragraph does not modify adjacent raw environments or document framing', () => {
    const raw = String.raw`\begin{figure}[t]
\includegraphics[width=.3\textwidth]{a.png}
\includegraphics[width=.4\textwidth]{b.png}
\caption{Keep \textbf{exactly}}
\end{figure}`;
    const tex = documentWith('\nOriginal paragraph.\n\n' + raw + '\n\nLast paragraph.\n');
    const f = fixture();
    f.context.applyImportedTex(tex, 'paper.tex');
    const paragraph = f.editor.querySelectorAll('p').find(node => node.textContent === 'Original paragraph.');
    assert.ok(paragraph, 'the simple paragraph must remain visually editable');
    paragraph.textContent = 'Edited paragraph.';
    assert.equal(f.context.domToLatex(), tex.replace('Original paragraph.', 'Edited paragraph.'));
});

test('source-looking HTML remains text and cannot create active elements on import', () => {
    const tex = documentWith('\n<img src=x onerror="bad()">\n<script>bad()</script>\n');
    const f = fixture();
    f.context.applyImportedTex(tex, 'untrusted.tex');
    assert.equal(f.editor.querySelectorAll('img').length, 0);
    assert.equal(f.editor.querySelectorAll('script').length, 0);
    assert.equal(f.context.domToLatex(), tex);
});

test('editing text retains adjacent escaped characters, commands and math delimiters', () => {
    const tex = documentWith('\n' + String.raw`Rate 50\%, file\_name, \cite{key}, $$x^2$$ and \(y\).` + '\n');
    const f = fixture();
    f.context.applyImportedTex(tex, 'paper.tex');
    const paragraph = f.editor.querySelector('p');
    const firstText = paragraph.childNodes.find(node => node.nodeType === 3 && node.textContent.startsWith('Rate '));
    assert.ok(firstText);
    firstText.textContent = firstText.textContent.replace('Rate ', 'Updated rate ');
    assert.equal(f.context.domToLatex(), tex.replace('Rate ', 'Updated rate '));
});

test('visual command and math decorations preserve original source and ancestor snapshots', () => {
    const tex = documentWith('\r\n' + String.raw`\textbf{See \cite[see][p. 7]{first,second} and \ref{sec:intro}.} \label{sec:intro} \(x^2\) $$y$$` + '\r\n');
    const f = fixture();
    f.context.applyImportedTex(tex, 'decorated.tex');
    const paragraph = f.editor.querySelector('p');
    const snapshot = f.context.getTexNodeSnapshot(paragraph);
    for (const command of f.editor.querySelectorAll('.tex-cmd')) {
        command.innerHTML = '<span class="reference-icon">↗</span><b>Readable reference</b>';
        command.setAttribute('title', 'Click to edit');
        command.setAttribute('aria-label', 'Edit reference');
        command.setAttribute('data-rendered', 'true');
    }
    for (const formula of [...f.editor.querySelectorAll('.formula-inline'), ...f.editor.querySelectorAll('.formula-block')]) {
        formula.innerHTML = '<span class="math-renderer"><sup>2</sup><span>rendered expression</span></span>';
        formula.setAttribute('title', 'Edit equation');
        formula.setAttribute('aria-label', 'x squared');
        formula.setAttribute('role', 'button');
    }
    assert.equal(f.context.getTexNodeSnapshot(paragraph), snapshot);
    assert.equal(f.context.domToLatex(), tex);
});

test('changing a displayed reference invalidates its ancestors and changes only its command', () => {
    const original = String.raw`\cite[see][p. 7]{first,second}`;
    const replacement = String.raw`\cite[compare][p. 9]{third,fourth}`;
    const tex = documentWith('\r\n' + String.raw`\textbf{See ` + original + String.raw` and \ref{sec:intro}.} \label{sec:intro} \(x^2\)` + '\r\n');
    const f = fixture();
    f.context.applyImportedTex(tex, 'references.tex');
    const paragraph = f.editor.querySelector('p');
    const snapshot = f.context.getTexNodeSnapshot(paragraph);
    for (const node of f.editor.querySelectorAll('.tex-cmd')) node.textContent = 'Readable label';
    const citation = f.editor.querySelectorAll('.tex-cmd').find(node => node.getAttribute('data-tex-source') === original);
    citation.setAttribute('data-tex-source', replacement);
    citation.innerHTML = '<b>Third and Fourth, p. 9</b>';
    assert.notEqual(f.context.getTexNodeSnapshot(paragraph), snapshot);
    assert.equal(f.context.domToLatex(), tex.replace(original, replacement));
});

test('rendered math and reference HTML never leaks into exports after neighboring text changes', () => {
    const tex = documentWith('\n' + String.raw`Before \ref{sec:a}, \label{sec:a}, $x+1$ and \[y^2\].` + '\n');
    const f = fixture();
    f.context.applyImportedTex(tex, 'math.tex');
    const paragraph = f.editor.querySelector('p');
    for (const node of paragraph.childNodes.filter(node => node.nodeType === 1)) {
        node.innerHTML = '<span>rendered HTML &amp; presentation</span>';
        node.setAttribute('aria-label', 'Spoken formula');
    }
    paragraph.childNodes[0].textContent = 'After ';
    assert.equal(f.context.domToLatex(), tex.replace('Before ', 'After '));
});

for (const [open, close] of [['$', '$'], ['$$', '$$'], ['\\(', '\\)'], ['\\[', '\\]']]) {
    test('editing rendered math retains ' + open + ' delimiters and changes only the formula', () => {
        const oldFormula = open + 'x + 1' + close;
        const tex = documentWith('\r\nPrefix ' + oldFormula + String.raw` and \ref{sec:a}.` + '\r\n');
        const f = fixture();
        f.context.applyImportedTex(tex, 'formula.tex');
        const formula = f.editor.querySelector('.formula-inline') || f.editor.querySelector('.formula-block');
        formula.innerHTML = '<span class="math-renderer">x²</span>';
        formula.setAttribute('data-formula', 'x^2 + 2');
        assert.equal(f.context.domToLatex(), tex.replace(oldFormula, () => open + 'x^2 + 2' + close));
    });
}

test('legacy command atoms without source metadata still export their TeX text', () => {
    const f = fixture();
    f.editor.innerHTML = '<p>See <span class="tex-cmd">\\ref{old:label}</span>.</p>';
    assert.equal(f.context.convertNodeToLatex(f.editor.querySelector('.tex-cmd')), String.raw`\ref{old:label}`);
});

for (const environment of ['equation', 'equation*', 'align', 'align*', 'gather', 'gather*']) {
    test(environment + ' renders as a source-preserving formula atom with editable content', () => {
        const body = '\r\nx &= 1 ' + String.raw`\label{eq:first} \\` + '\r\ny &= 2 ' + String.raw`\tag{A}` + '\r\n';
        const tex = documentWith('\r\nBefore.\r\n\\begin \t{' + environment + '}' + body + '\\end\r\n{' + environment + '}\r\nAfter.\r\n');
        const f = fixture();
        f.context.applyImportedTex(tex, 'equations.tex');
        const formula = f.editor.querySelector('.formula-block');
        assert.ok(formula);
        assert.equal(formula.getAttribute('data-environment'), environment);
        assert.equal(formula.getAttribute('data-delimiter'), 'environment');
        assert.equal(formula.getAttribute('data-formula'), body);
        formula.innerHTML = '<span class="math-renderer">Visual equation with label and tag</span>';
        formula.setAttribute('aria-label', 'Equation');
        assert.equal(f.context.domToLatex(), tex);
        formula.setAttribute('data-formula', body.replace('x &= 1', 'x &= 3'));
        assert.equal(f.context.domToLatex(), tex.replace('x &= 1', 'x &= 3'));
        assert.equal(f.context.saveDraft(), true);
        const reloaded = fixture(f.storage);
        reloaded.context.loadDraft();
        assert.deepEqual(reloaded.errors, []);
        assert.equal(reloaded.context.domToLatex(), tex.replace('x &= 1', 'x &= 3'));
    });
}

test('changing the equation environment invalidates source and uses matching environment boundaries', () => {
    const tex = documentWith(String.raw`\begin{equation}x=1\label{eq:first}\end{equation}`);
    const f = fixture();
    f.context.applyImportedTex(tex, 'equation.tex');
    const formula = f.editor.querySelector('.formula-block');
    formula.setAttribute('data-environment', 'gather*');
    assert.equal(f.context.domToLatex(), tex.replaceAll('{equation}', '{gather*}'));
});

test('empty document and metadata survive JSON draft save/reload', () => {
    const tex = '% prefix\r\n\\documentclass{report}\r\n\\begin {document}\\end {document}\r\n% tail\r\n';
    const f = fixture();
    f.context.applyImportedTex(tex, 'empty.tex');
    assert.equal(f.editor.innerHTML, '');
    const saved = JSON.parse(f.storage.get('visuellatex_document'));
    assert.equal(saved.html, '');
    assert.equal(saved.filename, 'empty.tex');
    const reloaded = fixture(f.storage);
    reloaded.editor.innerHTML = '<p>Welcome</p>';
    reloaded.context.loadDraft();
    assert.deepEqual(reloaded.errors, []);
    assert.equal(reloaded.editor.innerHTML, '');
    assert.equal(vm.runInContext('importedFileName', reloaded.context), 'empty.tex');
    assert.equal(reloaded.context.domToLatex(), tex);
});

test('nonempty draft restoration preserves source snapshots and command semantics', () => {
    const tex = documentWith('\r\nText ' + String.raw`\emph{emphasis} and \textbf{bold} plus $$x^2$$.` + '\r\n');
    const f = fixture();
    f.context.applyImportedTex(tex, 'styled.tex');
    const reloaded = fixture(f.storage);
    reloaded.context.loadDraft();
    assert.deepEqual(reloaded.errors, []);
    assert.equal(reloaded.context.domToLatex(), tex);
});

for (const edited of [false, true]) {
    test('legacy presentation snapshots migrate without losing ' + (edited ? 'unsaved source changes' : 'original source formatting'), () => {
        const tex = documentWith('\r\n' + String.raw`\section {See \ref{sec:a}}` + '\r\n' +
            String.raw`Original \textbf {math \(x + 1\)}.` + '\r\n');
        const f = fixture();
        f.context.applyImportedTex(tex, 'old-draft.tex');
        for (const node of f.editor.querySelectorAll('[data-tex-snapshot]')) {
            node.setAttribute('data-tex-snapshot', f.context.getTexNodeSnapshot(node, true));
        }
        if (edited) f.editor.querySelector('p').childNodes[0].textContent = 'Updated ';
        f.context.saveDraft();
        const reloaded = fixture(f.storage);
        reloaded.context.loadDraft();
        assert.deepEqual(reloaded.errors, []);
        assert.equal(reloaded.context.domToLatex(), edited ? tex.replace('Original ', 'Updated ') : tex);
        const heading = reloaded.editor.querySelector('h1');
        assert.equal(heading.getAttribute('data-tex-snapshot'), reloaded.context.getTexNodeSnapshot(heading));
    });
}

test('legacy drafts strip event handlers, active elements and unsafe image protocols', () => {
    const f = fixture(new Map([['visuellatex_draft',
        '<p onclick="bad()">Keep <b>bold</b></p><script>bad()</script>' +
        '<iframe src="https://example.invalid"></iframe><img src="javascript:bad()" onerror="bad()">']]));
    f.context.loadDraft();
    assert.deepEqual(f.errors, []);
    assert.equal(f.editor.querySelectorAll('script').length, 0);
    assert.equal(f.editor.querySelectorAll('iframe').length, 0);
    assert.equal(f.editor.querySelector('p').getAttribute('onclick'), null);
    assert.equal(f.editor.querySelector('img').getAttribute('onerror'), null);
    assert.equal(f.editor.querySelector('img').getAttribute('src'), null);
    assert.equal(f.editor.querySelector('b').textContent, 'bold');
});

test('legacy trimmed comments cannot swallow document boundaries after migration', () => {
    const preamble = '\\documentclass{article}\n% trailing preamble comment';
    const f = fixture(new Map([
        ['visuellatex_draft', '<div class="raw-tex">% trailing body comment</div>'],
        ['visuellatex_preamble', preamble],
        ['visuellatex_tail', '% trailing file comment'],
        ['visuellatex_filename', 'legacy.tex'],
    ]));
    f.context.loadDraft();
    assert.deepEqual(f.errors, []);
    const expected = preamble + '\n\n\\begin{document}\n\n' +
        '% trailing body comment\n\\end{document}\n% trailing file comment\n';
    assert.equal(f.context.domToLatex(), expected);
    assert.equal(vm.runInContext('importedFileName', f.context), 'legacy.tex');

    // Once migrated to JSON, restoring again must not append boundaries twice.
    assert.equal(f.context.saveDraft(), true);
    const reloaded = fixture(f.storage);
    reloaded.context.loadDraft();
    assert.deepEqual(reloaded.errors, []);
    assert.equal(reloaded.context.domToLatex(), expected);
});

test('draft sanitizer retains safe alignment and removes unrelated CSS', () => {
    const f = fixture();
    f.editor.innerHTML = f.context.sanitizeDraftHtml('<p style="text-align: center; background: url(https://example.invalid)">Keep</p>');
    assert.equal(f.editor.querySelector('p').style.textAlign, 'center');
    assert.equal(f.editor.querySelector('p').getAttribute('style'), 'text-align: center;');
});

for (const [name, payload] of [
    ['corrupted JSON', '{broken draft'],
    ['unknown draft version', JSON.stringify({version: 99, html: '<p>Keep this future draft</p>'})],
]) {
    test(name + ' survives flush and the registered pagehide callback', () => {
        const f = fixture(new Map([['visuellatex_document', payload]]));
        f.initialize();
        assert.equal(f.errors.length, 1);
        f.editor.innerHTML = '<p>Unrestored placeholder</p>';
        f.context.flushDraft();
        assert.equal(f.storage.get('visuellatex_document'), payload);
        assert.equal(typeof f.windowEvents.pagehide, 'function');
        f.windowEvents.pagehide();
        assert.equal(f.storage.get('visuellatex_document'), payload);
    });

    for (const action of ['import', 'new']) {
        test(name + ' can be deliberately replaced by explicit ' + action, () => {
            const f = fixture(new Map([['visuellatex_document', payload]]));
            f.context.loadDraft();
            if (action === 'import') f.context.applyImportedTex(documentWith('\nReplacement text.\n'), 'replacement.tex');
            else f.context.startNewDocument();
            const saved = JSON.parse(f.storage.get('visuellatex_document'));
            assert.equal(saved.version, 1);
            if (action === 'import') assert.equal(saved.filename, 'replacement.tex');
            else assert.equal(saved.filename, null);
            f.editor.innerHTML = '<p>Further edit</p>';
            f.context.flushDraft();
            assert.match(JSON.parse(f.storage.get('visuellatex_document')).html, /Further edit/);
        });
    }
}

test('clearing and reloading a draft prevents pagehide from recreating the removed data', () => {
    const keys = ['visuellatex_document', 'visuellatex_draft', 'visuellatex_draft_time',
        'visuellatex_preamble', 'visuellatex_tail', 'visuellatex_filename', 'modelpaper_draft', 'modelpaper_draft_time'];
    const f = fixture();
    f.context.applyImportedTex(documentWith('\nDiscard this draft.\n'), 'discard.tex');
    f.initialize();
    for (const key of keys.slice(1)) f.storage.set(key, 'legacy value');
    f.context.reloadAndClearDraft();
    assert.equal(f.controls.reloads, 1);
    for (const key of keys) assert.equal(f.storage.has(key), false, key + ' should be removed');
    f.context.flushDraft();
    f.windowEvents.pagehide();
    for (const key of keys) assert.equal(f.storage.has(key), false, key + ' should stay removed');
});

test('quota failure retains the previous atomic draft and displays a saving error', () => {
    const f = fixture();
    f.context.applyImportedTex(documentWith('\nPrevious saved text.\n'), 'paper.tex');
    const previousPayload = f.storage.get('visuellatex_document');
    f.editor.innerHTML = '<p>Unsaved newer content</p>';
    f.controls.failWrites = true;
    assert.equal(f.context.saveDraft(), false);
    assert.equal(f.storage.get('visuellatex_document'), previousPayload);
    assert.match(f.status.textContent, /保存失败/);
    assert.equal(f.errors.length, 1);
});

test('inserting an image into an imported paragraph adds graphicx only when needed', () => {
    const tex = '% exact prefix\n\\documentclass{article}\n\\begin{document}\nOriginal paragraph.\n\\end{document}\n';
    const f = fixture();
    f.context.applyImportedTex(tex, 'paper.tex');
    assert.equal(f.context.domToLatex(), tex, 'untouched import must not add a package or change its prefix');
    const image = new Element('img');
    image.setAttribute('src', 'figure.png');
    image.setAttribute('data-caption', 'A figure');
    image.setAttribute('data-label', 'fig:test');
    f.editor.querySelector('p').appendChild(image);
    const exported = f.context.domToLatex();
    assert.ok(exported.startsWith('% exact prefix\n\\documentclass{article}\n\\usepackage{graphicx}\n'));
    assert.match(exported, /\\includegraphics\[[^\]]*\]\{figure\.png\}/);
    assert.match(exported, /\\begin\{figure\}\[htbp\]/);
    assert.doesNotMatch(exported, /\\begin\{figure\}\[H\]/);
    assert.doesNotMatch(exported, /\\usepackage\{float\}/);
    assert.equal((exported.match(/\\usepackage\{graphicx\}/g) || []).length, 1);
});
