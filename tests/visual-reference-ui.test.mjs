import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/workspace-fixture.mjs';

const documentText = body => '\\documentclass{article}\n\\begin{document}\n' + body + '\n\\end{document}\n';
async function visual(body) {
    const f = await fixture({includeVisualReferences: true});
    await f.input('sourceArea', documentText(body));
    await f.click('modeVisual'); f.refresh();
    return f;
}
const tokens = f => f.node('editorArea').querySelectorAll('.tex-cmd');
const tokenFor = (f, source) => tokens(f).find(node => node.getAttribute('data-tex-source') === source);
const activate = (f, node, type = 'click') => f.emit(f.node('editorArea'), type, {target: node, ...(type === 'keydown' ? {key: 'Enter'} : {})});

test('visual references replace visible commands while opening and saving preserve exact original source', async () => {
    const body = String.raw`\section{Overview}\label{sec:overview}
Read \citep[see][p.~4]{example2026}, \ref{sec:overview}, and \input{sections/method}.
\bibliographystyle{plain}\bibliography{references}\printbibliography`;
    const f = await visual(body);
    const original = f.app.model.get().text;
    assert.doesNotMatch(f.node('editorArea').textContent, /\\(?:citep|ref|label|input|bibliographystyle|bibliography|printbibliography)/);
    assert.match(f.node('editorArea').textContent, /An example reference/);
    assert.match(f.node('editorArea').textContent, /Overview/);
    assert.ok(tokens(f).every(node => node.getAttribute('data-visual-reference')));
    await f.emit(f.document, 'keydown', {key: 's', ctrlKey: true});
    assert.equal(f.app.model.get().text, original);
    const citation = tokenFor(f, String.raw`\citep[see][p.~4]{example2026}`);
    await activate(f, citation);
    assert.equal(f.node('referenceModal').hidden, false);
    assert.equal(f.document.activeElement, f.node('referenceKeys'));
    assert.equal(f.document.querySelector('.container').getAttribute('inert'), '');
    assert.equal(f.node('referenceKeys').value, 'example2026');
    const tab = await f.emit(f.node('referenceModal'), 'keydown', {key: 'Tab', shiftKey: true});
    assert.equal(tab.defaultPrevented, true);
    assert.equal(f.document.activeElement, f.node('referenceChoice'));
    await f.emit(f.node('referenceModal'), 'keydown', {key: 'Enter', target: f.node('referenceKeys'), isComposing: true});
    assert.equal(f.node('referenceModal').hidden, false);
    await f.click('referenceAccept');
    assert.equal(f.app.model.get().text, original);
    assert.equal(f.node('referenceModal').hidden, true);
    assert.equal(f.document.querySelector('.container').getAttribute('inert'), null);
    assert.equal(f.app.mode, 'visual');
});

test('clicking the second identical citation edits only that atom and supports undo and redo', async () => {
    const command = String.raw`\citep[see][p.~4]{example2026}`;
    const f = await visual('First ' + command + '. Second ' + command + '.');
    const original = f.app.model.get().text;
    const citations = tokens(f).filter(node => node.getAttribute('data-tex-source') === command);
    await activate(f, citations[1]);
    f.node('referenceKeys').value = 'updated2026';
    await f.click('referenceAccept');
    const updated = documentText('First ' + command + '. Second ' + String.raw`\citep[see][p.~4]{updated2026}` + '.');
    assert.equal(f.app.model.get().text, updated);
    assert.equal(citations[0].getAttribute('data-tex-source'), command);
    assert.equal(f.app.mode, 'visual');
    assert.equal(JSON.parse(f.storage.get('visuallatex_workspace_v1')).files.find(file => file.path === 'main.tex').text, updated);
    await f.click('btnUndo'); assert.equal(f.app.model.get().text, original);
    await f.click('btnRedo'); assert.equal(f.app.model.get().text, updated);
});

test('keyboard editing selects project labels and cancellation leaves bytes and history unchanged', async () => {
    const f = await visual(String.raw`\section{Method}\label{sec:method} See \ref{sec:old}.`);
    const reference = tokenFor(f, String.raw`\ref{sec:old}`);
    const event = await activate(f, reference, 'keydown');
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
    f.node('referenceChoice').value = 'sec:method';
    await f.emit(f.node('referenceChoice'), 'change');
    assert.equal(f.node('referenceKeys').value, 'sec:method');
    const saved = await f.emit(f.node('referenceModal'), 'keydown', {key: 'Enter', target: f.node('referenceKeys')});
    assert.equal(saved.propagationStopped, true);
    assert.match(f.app.model.get().text, /\\ref\{sec:method\}/);
    const original = f.app.model.serialize();
    await activate(f, reference);
    f.node('referenceKeys').value = 'discarded';
    await f.emit(f.node('referenceModal'), 'keydown', {key: 'Escape'});
    assert.equal(f.app.model.serialize(), original);
    assert.equal(f.node('referenceModal').hidden, true);
    assert.equal(f.app.mode, 'visual');
});

test('invalid keys remain in the accessible dialog without changing the source', async () => {
    const f = await visual(String.raw`Text \label{sec:old}.`);
    const original = f.app.model.serialize();
    await activate(f, tokenFor(f, String.raw`\label{sec:old}`));
    f.node('referenceKeys').value = String.raw`bad}\input{attack}`;
    await f.click('referenceAccept');
    assert.equal(f.app.model.serialize(), original);
    assert.equal(f.node('referenceModal').hidden, false);
    assert.equal(f.node('referenceKeys').getAttribute('aria-invalid'), 'true');
    assert.match(f.node('referenceError').textContent, /引用键/);
    await f.click('referenceCancel');
});

test('reference toolbar inserts at the saved visual cursor without opening source mode', async () => {
    const f = await visual('Before after.');
    const paragraph = f.node('editorArea').querySelector('p');
    const text = paragraph.childNodes.find(node => node.nodeType === 3 && node.textContent.includes('Before'));
    f.setCursor(text, 7);
    await f.emit(f.node('editorArea'), 'mouseup');
    await f.click('btnInsertCitation');
    assert.equal(f.node('referenceModal').hidden, false);
    assert.equal(f.app.mode, 'visual');
    f.node('referenceKeys').value = 'example2026';
    await f.click('referenceAccept');
    assert.equal(f.node('referenceModal').hidden, true);
    assert.match(f.app.model.get().text, /Before \\cite\{example2026\} after\./);
    assert.equal(f.app.mode, 'visual');
    assert.equal(f.node('sourcePanel').hidden, true);
    assert.equal(tokenFor(f, String.raw`\cite{example2026}`).getAttribute('role'), 'button');
    assert.equal(f.selection.rangeCount, 1);
});

test('source-mode reference insertion retains source selection while using the same editor', async () => {
    const f = await fixture({includeVisualReferences: true});
    await f.input('sourceArea', 'before after');
    f.node('sourceArea').setSelectionRange(7, 7);
    await f.click('btnInsertReference');
    f.node('referenceKeys').value = 'sec:method';
    await f.click('referenceAccept');
    assert.equal(f.app.model.get().text, String.raw`before \ref{sec:method}after`);
    assert.equal(f.app.mode, 'source');
});

test('file and bibliography commands edit visually, preserving resource option syntax', async () => {
    const f = await visual(String.raw`\input{old.tex}\addbibresource[location=local]{old.bib}\bibliography{old}`);
    await activate(f, tokenFor(f, String.raw`\input{old.tex}`));
    f.node('referenceKeys').value = 'sections/new.tex';
    await f.click('referenceAccept');
    await activate(f, tokenFor(f, String.raw`\addbibresource[location=local]{old.bib}`));
    f.node('referenceChoice').value = 'references.bib';
    await f.emit(f.node('referenceChoice'), 'change');
    await f.click('referenceAccept');
    await activate(f, tokenFor(f, String.raw`\bibliography{old}`));
    f.node('referenceChoice').value = 'references.bib';
    await f.emit(f.node('referenceChoice'), 'change');
    await f.click('referenceAccept');
    assert.match(f.app.model.get().text, /\\input\{sections\/new\.tex\}/);
    assert.match(f.app.model.get().text, /\\addbibresource\[location=local\]\{references\.bib\}/);
    assert.match(f.app.model.get().text, /\\bibliography\{references\}/);
    assert.equal(f.app.mode, 'visual');
});

test('reference sidebar opens the supported visual atom and double click never switches it to source', async () => {
    const f = await visual(String.raw`\section{Method}\label{sec:method} See \ref{sec:method}.`);
    await f.flushTimers();
    const label = tokenFor(f, String.raw`\label{sec:method}`);
    await f.emit(f.node('editorArea'), 'dblclick', {target: label});
    assert.equal(f.app.mode, 'visual');
    await f.node('referenceList').querySelector('button').click();
    assert.equal(f.node('referenceModal').hidden, false);
    assert.equal(f.node('referenceKeys').value, 'sec:method');
    assert.equal(f.app.mode, 'visual');
    await f.click('referenceCancel');
});

test('bibliography labels are literal text and cannot create active HTML', async () => {
    const f = await fixture({includeVisualReferences: true});
    f.app.switchFile('references.bib');
    await f.input('sourceArea', '@article{attack, title = {<img src=x onerror=alert(1)>}, author = {<script>alert(2)</script>}}');
    f.app.switchFile('main.tex');
    await f.input('sourceArea', documentText(String.raw`Read \cite{attack}.`));
    await f.click('modeVisual'); f.refresh();
    assert.match(f.node('editorArea').textContent, /<img src=x onerror=alert\(1\)>/);
    assert.equal(f.node('editorArea').querySelectorAll('img').length, 0);
    assert.equal(f.node('editorArea').querySelectorAll('script').length, 0);
    await activate(f, tokenFor(f, String.raw`\cite{attack}`));
    assert.equal(f.node('referenceChoice').querySelectorAll('img').length, 0);
    assert.equal(f.node('referenceChoice').querySelectorAll('script').length, 0);
    assert.match(f.node('referenceChoice').textContent, /<img src=x onerror=alert\(1\)>/);
});
