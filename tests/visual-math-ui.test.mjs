import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/workspace-fixture.mjs';

async function visual(body) {
    const f = await fixture({includeVisualMath: true});
    await f.input('sourceArea', '\\documentclass{article}\n\\begin{document}\n' + body + '\n\\end{document}\n');
    await f.click('modeVisual'); f.refresh();
    return f;
}
const formula = f => f.node('editorArea').querySelector('.formula-inline, .formula-block');
const open = f => f.emit(f.node('editorArea'), 'click', {target: formula(f)});

test('opening and confirming an untouched mathfield preserves source despite field normalization', async () => {
    const f = await visual('$  x + y \\label {eq:keep}% original note\n $');
    const original = f.app.model.get().text;
    const originalNode = formula(f);
    await open(f);
    assert.equal(f.document.activeElement, f.node('formulaMathField'));
    assert.equal(f.node('formulaMathField').mathVirtualKeyboardPolicy, 'manual');
    assert.equal(f.context.MathfieldElement.soundsDirectory, null);
    assert.equal(f.context.MathfieldElement.computeEngine, null);
    assert.doesNotMatch(f.node('formulaMathField').value, /\\label|original note/);
    // MathLive normalizes its display value on assignment without a user input
    // event. That must not overwrite the original mathematical source.
    f.node('formulaMathField').value = 'x+y';
    await f.click('btnInsertFormula');
    assert.equal(f.app.model.get().text, original);
    assert.equal(formula(f), originalNode);
    assert.equal(f.app.mode, 'visual');
    assert.equal(f.node('formulaModal').classList.contains('show'), false);
});

test('actual palette events give MathLive editable placeholder slots', async () => {
    const f = await visual('Text.');
    await f.click('btnInlineFormula');
    const palette = f.node('symbolPalette').querySelectorAll('button');
    await palette.find(button => button.textContent === '分数').click();
    await palette.find(button => button.textContent === '根式').click();
    assert.deepEqual(f.mathField.inserts, [
        {latex: String.raw`\frac{#?}{#?}`, options: {selectionMode: 'placeholder'}},
        {latex: String.raw`\sqrt{#?}`, options: {selectionMode: 'placeholder'}},
    ]);
    assert.equal(f.document.activeElement, f.node('formulaMathField'));
    await f.click('formulaModalClose');
    assert.equal(formula(f), null);
});

test('align and gather editors start inside their final cell and commit field input without wrapper leakage', async () => {
    for (const environment of ['align', 'gather*']) {
        const f = await visual('\\begin{' + environment + '}a=b\\\\c=d\\label{eq:last}\\end{' + environment + '}');
        await open(f);
        const field = f.node('formulaMathField');
        const wrapper = environment.startsWith('align') ? 'aligned' : 'gathered';
        assert.equal(field.value, '\\begin{' + wrapper + '}a=b\\\\c=d\\end{' + wrapper + '}');
        assert.equal(field.position, field.lastOffset - 1);
        field.value = '\\begin{' + wrapper + '}a=b\\\\c=d+1\\end{' + wrapper + '}';
        await f.emit(field, 'input');
        await f.click('btnInsertFormula');
        assert.equal(formula(f).getAttribute('data-formula'), String.raw`a=b\\c=d+1\label{eq:last}`);
        assert.equal(formula(f).getAttribute('data-environment'), environment);
        assert.doesNotMatch(f.app.model.get().text, /\\begin\{(?:aligned|gathered)\}/);
        assert.equal(f.app.mode, 'visual');
    }
});

test('label and display-number input events update only their exact source fields', async () => {
    const f = await visual(String.raw`\begin{equation} x = y \label {eq:old}\tag*{A 1}% retained
\end{equation}`);
    const original = f.app.model.get().text;
    await open(f);
    const inputs = f.node('formulaMetadata').querySelectorAll('input');
    assert.equal(inputs.length, 2);
    inputs[0].value = 'eq:new'; await f.emit(inputs[0], 'input');
    inputs[1].value = 'Result B 2'; await f.emit(inputs[1], 'input');
    await f.click('btnInsertFormula');
    assert.equal(f.app.model.get().text, original.replace('eq:old', 'eq:new').replace('A 1', 'Result B 2'));
    assert.match(formula(f).textContent, /eq:new/);
    assert.match(formula(f).textContent, /Result B 2/);
    assert.equal(f.app.mode, 'visual');
});

test('closing the visual formula editor discards mathematical and metadata edits', async () => {
    const f = await visual(String.raw`$x\label{eq:original}$`);
    const original = f.app.model.serialize();
    await open(f);
    f.node('formulaMathField').value = 'discarded';
    await f.emit(f.node('formulaMathField'), 'input');
    const input = f.node('formulaMetadata').querySelector('input');
    input.value = 'eq:discarded'; await f.emit(input, 'input');
    await f.click('formulaModalClose');
    assert.equal(f.app.model.serialize(), original);
    await open(f);
    assert.equal(f.node('formulaMathField').value, 'x');
    assert.equal(f.node('formulaMetadata').querySelector('input').value, 'eq:original');
    await f.click('btnInsertFormula');
    assert.equal(f.app.model.serialize(), original);
});

test('switching from advanced input back to graphical editing preserves newly entered labels and comments', async () => {
    const f = await visual(String.raw`$x\label{eq:old}$`);
    await open(f);
    f.node('formulaInput').focus();
    await f.input('formulaInput', 'y\\label{eq:new}% new comment\n');
    assert.equal(f.document.activeElement, f.node('formulaInput'), 'advanced typing must retain its focus');
    assert.equal(f.node('formulaMetadata').querySelector('input').value, 'eq:new');
    assert.doesNotMatch(f.node('formulaMathField').value, /\\label|new comment/);
    f.node('formulaMathField').value = 'y+1';
    await f.emit(f.node('formulaMathField'), 'input');
    await f.click('btnInsertFormula');
    const saved = formula(f).getAttribute('data-formula');
    assert.match(saved, /y\+1/);
    assert.match(saved, /\\label\{eq:new\}/);
    assert.match(saved, /% new comment/);
    assert.doesNotMatch(saved, /eq:old/);
    assert.equal(f.context.VisualMath.split(saved).metadata.filter(entry => entry.kind === 'label').length, 1);
    assert.equal(f.app.mode, 'visual');
});

test('advanced align edits rebuild row metadata and retain the graphical environment wrapper', async () => {
    const f = await visual(String.raw`\begin{align}x&=1\label{eq:old}\\y&=2\label{eq:oldlast}\end{align}`);
    await open(f);
    f.node('formulaInput').focus();
    await f.input('formulaInput', 'u&=3\\label{eq:first}% fresh\n\\\\v&=4\\label{eq:last}\\tag{B 2}');
    assert.equal(f.document.activeElement, f.node('formulaInput'));
    assert.equal(f.node('formulaMathField').value, '\\begin{aligned}u&=3\n\\\\v&=4\\end{aligned}');
    const inputs = f.node('formulaMetadata').querySelectorAll('input');
    assert.deepEqual(inputs.map(input => input.value), ['eq:first', 'eq:last', 'B 2']);
    inputs[2].value = 'B 3'; await f.emit(inputs[2], 'input');
    f.node('formulaMathField').value = String.raw`\begin{aligned}u&=3+1\\v&=4\end{aligned}`;
    await f.emit(f.node('formulaMathField'), 'input');
    await f.click('btnInsertFormula');
    const saved = formula(f).getAttribute('data-formula');
    const metadata = f.context.VisualMath.split(saved).metadata;
    assert.equal(formula(f).getAttribute('data-environment'), 'align');
    assert.deepEqual(Array.from(metadata.filter(entry => entry.kind !== 'comment'), entry => [entry.kind, entry.value, entry.row]), [
        ['label', 'eq:first', 0], ['label', 'eq:last', 1], ['tag', 'B 3', 1],
    ]);
    assert.equal(metadata.find(entry => entry.kind === 'comment').raw, '% fresh');
    assert.equal(metadata.find(entry => entry.kind === 'comment').row, 0);
    assert.doesNotMatch(saved, /eq:old|\\begin\{aligned\}/);
    assert.match(f.app.model.get().text, /\\begin\{align\}/);
    assert.match(f.app.model.get().text, /\\end\{align\}/);
});

test('URL-bearing formulas never reach the custom field or math renderer and remain lossless', async () => {
    const dangerous = String.raw`\href{javascript:alert(1)}{x}`;
    const f = await visual('$' + dangerous + '$');
    const original = f.app.model.get().text;
    assert.equal(formula(f).querySelectorAll('math-span').length, 0);
    assert.equal(formula(f).querySelectorAll('a').length, 0);
    assert.match(formula(f).textContent, /特殊排版指令/);
    assert.doesNotMatch(formula(f).textContent, /javascript:/);
    await open(f);
    assert.equal(f.node('formulaMathField').readOnly, true);
    assert.equal(f.node('formulaMathField').value, '');
    assert.equal(f.mathField.writes.some(value => value.includes('href') || value.includes('javascript:')), false);
    assert.match(f.node('formulaError').textContent, /已保留原文/);
    assert.equal(f.context.VisualMath.insert(String.raw`\frac{}{}`), false);
    assert.equal(f.mathField.inserts.length, 0);
    await f.click('btnInsertFormula');
    assert.equal(f.app.model.get().text, original);

    // Advanced edits are also gated before assigning the field value, while
    // keeping the explicitly entered source available for a later correction.
    await open(f);
    await f.input('formulaInput', String.raw`\href{https://example.test}{y}`);
    assert.equal(f.node('formulaMathField').value, '');
    assert.equal(f.mathField.writes.some(value => value.includes('href')), false);
    await f.click('formulaModalClose');
    assert.equal(f.app.model.get().text, original);
});

test('formula labels in the reference sidebar open their formula editor while retaining visual mode', async () => {
    const f = await fixture({includeVisualMath: true, includeVisualReferences: true});
    await f.input('sourceArea', String.raw`\documentclass{article}
\begin{document}
\begin{equation}x=1\label{eq:first}\end{equation}
\begin{equation}y=2\label{eq:second}\end{equation}
\end{document}`);
    await f.click('modeVisual'); f.refresh(); await f.flushTimers();
    const item = f.node('referenceList').querySelectorAll('button').find(button => button.textContent.startsWith('eq:second ·'));
    assert.ok(item);
    await item.click();
    assert.equal(f.app.mode, 'visual');
    assert.equal(f.node('sourcePanel').hidden, true);
    assert.equal(f.node('formulaModal').classList.contains('show'), true);
    assert.equal(f.node('formulaMathField').value, 'y=2');
    assert.equal(f.node('formulaMetadata').querySelector('input').value, 'eq:second');
    const label = f.node('formulaMetadata').querySelector('input');
    label.value = 'eq:edited'; await f.emit(label, 'input');
    await f.click('btnInsertFormula');
    assert.match(f.app.model.get().text, /x=1\\label\{eq:first\}/);
    assert.match(f.app.model.get().text, /y=2\\label\{eq:edited\}/);
    assert.doesNotMatch(f.app.model.get().text, /eq:second/);
    assert.equal(f.app.mode, 'visual');
});
