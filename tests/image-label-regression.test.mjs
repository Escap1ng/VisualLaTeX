import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {createDocument, Element} from './helpers/dom.mjs';

function fixture() {
    const document = createDocument();
    const createElement = document.createElement;
    document.createElement = tag => {
        const node = createElement(tag);
        for (const name of ['src', 'alt']) Object.defineProperty(node, name, {
            get() { return this.getAttribute(name); },
            set(value) { this.setAttribute(name, value); },
        });
        return node;
    };
    const editor = new Element('div');
    const statuses = [];
    const context = vm.createContext({document, TextEncoder, Node: {TEXT_NODE: 3, ELEMENT_NODE: 1},
        __editor: editor, __statuses: statuses});
    for (const name of ['main.js', 'project-model.js', 'visual-references.js']) {
        vm.runInContext(fs.readFileSync(new URL('../src/js/' + name, import.meta.url), 'utf8'), context);
    }
    // Only cursor placement and persistence notifications are outside this integration check.
    vm.runInContext(`editorArea = __editor;
        insertNodeAtCursor = node => Boolean(editorArea.appendChild(node));
        updatePreview = () => {}; saveDraft = () => true;
        updateStatus = message => __statuses.push(message);`, context);
    return {context, editor, statuses};
}

test('inserted image identifiers remain selectable and usable by the reference editor', () => {
    for (const label of ['fig:my_plot', '图:结果_2026.1-甲']) {
        const {context} = fixture();
        context.insertImage({imagePath: 'plot.png', caption: 'Rate 50% & value_1', label});
        const tex = context.domToLatex();
        assert.ok(tex.includes('\\label{' + label + '}'));
        assert.ok(tex.includes(String.raw`\caption{Rate 50\% \& value\_1}`));
        const model = new context.ProjectModel({files: [{path: 'main.tex', kind: 'text', text: tex}], activePath: 'main.tex'});
        const choices = context.VisualReferences.getChoices('reference', model);
        assert.equal(choices.length, 1);
        assert.equal(choices[0].value, label);
        assert.equal(context.VisualReferences.rewrite(String.raw`\ref{old}`, {key: choices[0].value}), '\\ref{' + label + '}');
    }
});

test('invalid new image labels leave the document intact and report the input error', () => {
    for (const label of ['fig:{bad}', String.raw`fig:bad\name`, 'fig:two words', 'fig:bad%name', 'fig:bad#name', 'fig:bad,name', 'fig:bad*name']) {
        const {context, editor, statuses} = fixture();
        editor.innerHTML = '<p>Keep this document.</p>';
        const before = context.domToLatex();
        context.insertImage({imagePath: 'plot.png', caption: 'Plot', label});
        assert.equal(context.domToLatex(), before);
        assert.equal(editor.querySelectorAll('img').length, 0);
        assert.match(statuses.at(-1), /标签/);
    }
});

test('empty image labels stay optional while surrounding whitespace is normalized', () => {
    for (const label of ['', '   ', '  fig:my_plot  ']) {
        const {context} = fixture();
        context.insertImage({imagePath: 'plot.png', caption: 'Plot', label});
        const tex = context.domToLatex();
        if (label.trim()) assert.ok(tex.includes('\\label{' + label.trim() + '}'));
        else assert.doesNotMatch(tex, /\\label\{/);
    }
});

test('image export rejects invalid legacy user labels instead of emitting malformed TeX', () => {
    const {context, editor} = fixture();
    editor.innerHTML = '<img src="plot.png" data-label="fig:{bad}">';
    assert.throws(() => context.domToLatex(), /标签/);
});

test('editing an imported image preserves its original TeX label and caption', () => {
    for (const label of ['fig:my_plot', String.raw`fig:\customkey`]) {
        const {context, editor} = fixture();
        const tex = String.raw`\documentclass{article}
\usepackage{graphicx}
\newcommand{\customkey}{imported}
\begin{document}
\begin{figure}\includegraphics{old.png}\caption{A \textbf{caption}}\label{${label}}\end{figure}
\end{document}`;
        context.applyImportedTex(tex, 'imported.tex');
        assert.equal(context.domToLatex(), tex);
        editor.querySelector('img').setAttribute('src', 'new.png');
        const edited = context.domToLatex();
        assert.ok(edited.includes(String.raw`\includegraphics{new.png}`));
        assert.ok(edited.includes(String.raw`\caption{A \textbf{caption}}`));
        assert.ok(edited.includes('\\label{' + label + '}'));
    }
});
