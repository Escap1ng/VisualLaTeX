import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');

// Minimal selection/DOM model: exercises the real event handlers without dependencies.
function fixture() {
    class Element {
        constructor(tag) {
            this.nodeType = 1;
            this.tagName = tag.toUpperCase();
            this.attributes = new Map();
            this.childNodes = [];
            this.listeners = {};
            this.value = '';
            this.classList = {
                contains: name => this.className.split(/\s+/).includes(name),
                add: name => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), name])].join(' '); },
                remove: name => { this.className = this.className.split(/\s+/).filter(c => c !== name).join(' '); },
            };
        }
        get className() { return this.attributes.get('class') || ''; }
        set className(value) { this.attributes.set('class', value); }
        get parentElement() { return this.parentNode || null; }
        get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
        set textContent(value) { this.childNodes = []; this.appendChild(textNode(value)); }
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        removeAttribute(name) { this.attributes.delete(name); }
        appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child; }
        replaceChild(next, old) {
            const index = this.childNodes.indexOf(old);
            assert.notEqual(index, -1);
            this.childNodes[index] = next;
            next.parentNode = this;
            old.parentNode = null;
        }
        contains(child) { return child === this || this.childNodes.some(node => node === child || node.contains?.(child)); }
        closest(selector) {
            for (let node = this; node; node = node.parentElement) {
                if (selector.split(',').some(part => node.classList.contains(part.trim().slice(1)))) return node;
            }
            return null;
        }
        addEventListener(type, handler) { this.listeners[type] = handler; }
        focus() { document.activeElement = this; }
    }
    function textNode(value) {
        return { nodeType: 3, textContent: String(value), get parentElement() { return this.parentNode; } };
    }
    class Range {
        constructor(container, offset = 0) { this.commonAncestorContainer = container; this.offset = offset; this.deleted = false; }
        selectNodeContents(container) { this.commonAncestorContainer = container; this.offset = 0; }
        collapse(toStart) { if (!toStart) this.offset = this.commonAncestorContainer.childNodes.length; }
        deleteContents() { this.deleted = true; }
        insertNode(node) {
            node.parentNode = this.commonAncestorContainer;
            this.commonAncestorContainer.childNodes.splice(this.offset, 0, node);
        }
        setStartAfter(node) { this.commonAncestorContainer = node.parentNode; this.offset = node.parentNode.childNodes.indexOf(node) + 1; }
        setEndAfter() {}
        cloneRange() { return new Range(this.commonAncestorContainer, this.offset); }
    }
    const ids = Object.fromEntries(['editorArea', 'formulaModal', 'formulaInput', 'btnInsertFormula',
        'formulaModalClose', 'symbolPalette'].map(id => [id, new Element('div')]));
    const radios = ['inline', 'block'].map(value => ({ value, selected: value === 'inline' }));
    for (const radio of radios) Object.defineProperty(radio, 'checked', {
        get: () => radio.selected,
        set: value => { for (const other of radios) other.selected = other === radio && value; },
    });
    const selection = {
        ranges: [],
        get rangeCount() { return this.ranges.length; },
        get anchorNode() { return this.ranges[0]?.commonAncestorContainer || null; },
        getRangeAt(index) { return this.ranges[index]; },
        removeAllRanges() { this.ranges = []; },
        addRange(range) { this.ranges.push(range); },
    };
    const prompts = [];
    const calls = { prompts: 0, saves: 0, previews: 0, statuses: [] };
    const document = {
        listeners: {},
        addEventListener(type, handler) { this.listeners[type] = handler; },
        getElementById: id => ids[id],
        createElement: tag => new Element(tag),
        createTextNode: textNode,
        createRange: () => new Range(ids.editorArea),
        querySelector: selector => selector.includes(':checked') ? radios.find(r => r.checked)
            : radios.find(r => selector.includes(`value="${r.value}"`)),
        querySelectorAll: selector => selector === 'input[name="formulaMode"]' ? radios : [],
    };
    const context = vm.createContext({ document, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
        window: { getSelection: () => selection }, console,
        prompt: () => { calls.prompts++; return prompts.shift() ?? null; },
        __calls: calls, __editor: ids.editorArea });
    vm.runInContext(source, context);
    vm.runInContext(`editorArea=__editor;
        updatePreview=()=>__calls.previews++;
        saveDraft=()=>__calls.saves++;
        updateStatus=message=>__calls.statuses.push(message);`, context);
    function formula(latex, mode = 'inline') {
        const node = new Element(mode === 'inline' ? 'span' : 'div');
        context.configureFormulaNode(node, latex, mode);
        ids.editorArea.appendChild(node);
        return node;
    }
    return { context, ids, selection, prompts, calls, Element, Range, formula, radios, document };
}

function modalKey(f, key, properties = {}) {
    const event = {type: 'keydown', key, target: f.ids.formulaInput, defaultPrevented: false, propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...properties};
    // Match addEventListener's currentTarget/this binding and event bubbling.
    // Parent listeners are deliberately installed by each shortcut regression.
    f.ids.formulaModal.listeners.keydown.call(f.ids.formulaModal, event);
    if (!event.propagationStopped) f.document.listeners.keydown?.call(f.document, event);
    return event;
}

test('image insertion without an existing selection appends to the editor', () => {
    const f = fixture();
    f.prompts.push('figure.png', 'A caption', 'fig:test');
    f.context.insertImage();
    assert.equal(f.ids.editorArea.childNodes[0].tagName, 'IMG');
    assert.equal(f.ids.editorArea.childNodes[0].src, 'figure.png');
    assert.equal(f.ids.editorArea.childNodes[0].getAttribute('data-caption'), 'A caption');
    assert.equal(f.calls.saves, 1);
});

test('an external selection is never deleted or used for insertion', () => {
    const f = fixture();
    const outside = new f.Element('div');
    const externalRange = new f.Range(outside);
    f.selection.addRange(externalRange);
    f.prompts.push('figure.png', '', '');
    f.context.insertImage();
    assert.equal(externalRange.deleted, false);
    assert.equal(outside.childNodes.length, 0);
    assert.equal(f.ids.editorArea.childNodes[0].tagName, 'IMG');
});

test('image parameters from an asynchronous dialog restore the saved editor selection without native prompts', () => {
    const f = fixture();
    const original = new f.Element('p');
    original.textContent = 'Original text';
    f.ids.editorArea.appendChild(original);
    f.selection.addRange(new f.Range(f.ids.editorArea, 0));
    f.context.saveEditorSelection();
    f.selection.removeAllRanges();
    const outside = new f.Element('input');
    const externalRange = new f.Range(outside);
    f.selection.addRange(externalRange);
    f.context.insertImage({imagePath: 'figure.png', caption: '<b>Caption</b>', label: 'fig:async'});
    assert.equal(f.calls.prompts, 0);
    assert.equal(f.calls.saves, 1);
    assert.equal(externalRange.deleted, false);
    assert.equal(f.ids.editorArea.childNodes[0].tagName, 'IMG');
    assert.equal(f.ids.editorArea.childNodes[0].getAttribute('data-caption'), '<b>Caption</b>');
    assert.ok(f.ids.editorArea.childNodes.includes(original));
});

test('cancelling the image path immediately stops the interaction', () => {
    const f = fixture();
    f.prompts.push(null);
    f.context.insertImage();
    assert.equal(f.calls.prompts, 1);
    assert.equal(f.calls.saves, 0);
    assert.equal(f.ids.editorArea.childNodes.length, 0);
});

test('rich nodes are inserted after a raw source block, without deleting its source', () => {
    const f = fixture();
    const raw = new f.Element('div');
    raw.className = 'raw-tex';
    raw.textContent = String.raw`\begin{table}original\end{table}`;
    f.ids.editorArea.appendChild(raw);
    f.selection.addRange(new f.Range(raw));
    const image = new f.Element('img');
    f.context.insertNodeAtCursor(image);
    assert.equal(raw.textContent, String.raw`\begin{table}original\end{table}`);
    assert.equal(f.ids.editorArea.childNodes[1], image);
});

test('double-clicking an existing formula loads its value and mode', () => {
    const f = fixture();
    const formula = f.formula('x^2', 'block');
    f.context.initFormulaModal();
    let prevented = false;
    f.ids.editorArea.listeners.dblclick({ target: formula, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(f.ids.formulaInput.value, 'x^2');
    assert.equal(f.radios.find(r => r.checked).value, 'block');
    assert.equal(f.ids.btnInsertFormula.textContent, '更新公式');
});

test('a single click opens the formula editor from rendered children or their text', () => {
    for (const textTarget of [false, true]) {
        const f = fixture();
        const formula = f.formula(String.raw`\frac{x}{y}`, 'block');
        const rendered = new f.Element('span');
        rendered.textContent = 'rendered fraction';
        formula.appendChild(rendered);
        f.context.initFormulaModal();
        let prevented = false;
        f.ids.editorArea.listeners.click({type: 'click', target: textTarget ? rendered.childNodes[0] : rendered,
            preventDefault() { prevented = true; }});
        assert.equal(prevented, true);
        assert.equal(f.ids.formulaModal.classList.contains('show'), true);
        assert.equal(f.ids.formulaInput.value, String.raw`\frac{x}{y}`);
        assert.equal(f.radios.find(r => r.checked).value, 'block');
        assert.equal(f.ids.btnInsertFormula.textContent, '更新公式');
        assert.equal(f.calls.saves, 0);
    }
});

test('Enter and Space open a focused formula while ordinary typing and outside formulas do not', () => {
    for (const key of ['Enter', ' ', 'ArrowRight', 'a']) {
        const f = fixture();
        const formula = f.formula('x + 1');
        f.context.initFormulaModal();
        let prevented = false;
        f.ids.editorArea.listeners.keydown({type: 'keydown', key, target: formula,
            preventDefault() { prevented = true; }});
        const activated = key === 'Enter' || key === ' ';
        assert.equal(prevented, activated);
        assert.equal(f.ids.formulaModal.classList.contains('show'), activated);
        assert.equal(f.calls.saves, 0);
    }
    const f = fixture();
    f.context.initFormulaModal();
    const outside = new f.Element('span'); outside.className = 'formula-inline';
    let prevented = false;
    f.ids.editorArea.listeners.click({type: 'click', target: outside, preventDefault() { prevented = true; }});
    assert.equal(prevented, false);
    assert.equal(f.ids.formulaModal.classList.contains('show'), false);
});

for (const environment of ['equation', 'equation*', 'align', 'align*', 'gather', 'gather*']) {
    test('editing ' + environment + ' through formula events preserves exact environment boundaries', () => {
        const f = fixture();
        const original = '\r\nx &= 1\\\\\r\ny &= 2\\label{eq:result}\r\n';
        const updated = original.replace('x &= 1', 'x &= 3');
        const opening = '\\begin \t{' + environment + '}';
        const closing = '\\end\r\n{' + environment + '}';
        const formula = f.formula(original, 'block');
        formula.setAttribute('data-delimiter', 'environment');
        formula.setAttribute('data-environment', environment);
        formula.setAttribute('data-tex-env-open', opening);
        formula.setAttribute('data-tex-env-close', closing);
        formula.setAttribute('data-tex-source', opening + original + closing);
        formula.setAttribute('data-tex-snapshot', 'old snapshot');
        f.context.initFormulaModal();
        f.ids.editorArea.listeners.click({type: 'click', target: formula, preventDefault() {}});
        assert.equal(f.radios.find(r => r.checked).value, 'block');
        assert.ok(f.radios.every(r => r.disabled));
        f.ids.formulaInput.value = updated;
        f.ids.btnInsertFormula.listeners.click({type: 'click'});
        assert.equal(f.ids.editorArea.childNodes.length, 1);
        const replacement = f.ids.editorArea.childNodes[0];
        assert.notEqual(replacement, formula);
        assert.equal(replacement.getAttribute('data-formula'), updated);
        assert.equal(replacement.getAttribute('data-delimiter'), 'environment');
        assert.equal(replacement.getAttribute('data-environment'), environment);
        assert.equal(replacement.getAttribute('data-tex-env-open'), opening);
        assert.equal(replacement.getAttribute('data-tex-env-close'), closing);
        assert.equal(replacement.getAttribute('data-tex-source'), null);
        assert.equal(replacement.getAttribute('data-tex-snapshot'), null);
        assert.equal(f.context.convertNodeToLatex(replacement), opening + updated + closing);
        assert.equal(f.ids.formulaModal.classList.contains('show'), false);
        assert.equal(f.calls.saves, 1);
        assert.equal(f.calls.previews, 1);
        f.context.openFormulaModal('inline');
        assert.ok(f.radios.every(r => !r.disabled));
    });
}

test('cancelling environment edits with close or Escape preserves the original atom and source', () => {
    for (const action of ['close', 'escape']) {
        const f = fixture();
        const formula = f.formula('\nx = 1\\label{eq:original}\n', 'block');
        const source = '\\begin{equation}' + formula.getAttribute('data-formula') + '\\end{equation}';
        formula.setAttribute('data-delimiter', 'environment');
        formula.setAttribute('data-environment', 'equation');
        formula.setAttribute('data-tex-env-open', '\\begin{equation}');
        formula.setAttribute('data-tex-env-close', '\\end{equation}');
        formula.setAttribute('data-tex-source', source);
        f.context.initFormulaModal();
        f.ids.editorArea.listeners.keydown({type: 'keydown', key: 'Enter', target: formula, preventDefault() {}});
        f.ids.formulaInput.value = 'discarded';
        if (action === 'close') f.ids.formulaModalClose.listeners.click({type: 'click'});
        else f.document.listeners.keydown({type: 'keydown', key: 'Escape'});
        assert.equal(f.ids.editorArea.childNodes[0], formula);
        assert.equal(formula.getAttribute('data-tex-source'), source);
        assert.equal(formula.getAttribute('data-environment'), 'equation');
        assert.equal(f.ids.formulaModal.classList.contains('show'), false);
        assert.equal(f.calls.saves, 0);
    }
});

test('formula confirmation shortcuts edit once without reaching workspace compile handlers', () => {
    for (const modifier of ['ctrlKey', 'metaKey']) {
        const f = fixture();
        f.context.initFormulaModal();
        f.context.openFormulaModal('inline');
        f.ids.formulaInput.value = 'x + 1';
        const event = {key: 'Enter', [modifier]: true, defaultPrevented: false, propagationStopped: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.propagationStopped = true; }};
        f.ids.formulaInput.listeners.keydown(event);
        let compileCalls = 0;
        if (!event.propagationStopped) compileCalls++;
        assert.equal(event.defaultPrevented, true);
        assert.equal(compileCalls, 0);
        assert.equal(f.ids.editorArea.childNodes.filter(node => node.getAttribute?.('data-formula') === 'x + 1').length, 1);
        assert.equal(f.calls.saves, 1);
        assert.equal(f.ids.formulaModal.classList.contains('show'), false);
    }
});

test('modal Ctrl+S and Cmd+S commit the formula exactly once before document persistence', () => {
    for (const modifier of ['ctrlKey', 'metaKey']) {
        const f = fixture();
        const original = f.formula('x');
        f.context.initFormulaModal();
        f.context.openFormulaModal('inline', original);
        f.ids.formulaInput.value = 'x + 1';
        let documentSaves = 0;
        f.document.listeners.keydown = event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') documentSaves++;
        };
        const event = modalKey(f, modifier === 'ctrlKey' ? 's' : 'S', {[modifier]: true});
        assert.equal(event.defaultPrevented, true);
        assert.equal(event.propagationStopped, true);
        assert.equal(documentSaves, 0);
        assert.equal(f.calls.saves, 1);
        assert.equal(f.calls.previews, 1);
        assert.equal(f.ids.editorArea.childNodes.length, 1);
        assert.equal(f.ids.editorArea.childNodes[0].getAttribute('data-formula'), 'x + 1');
        assert.equal(f.ids.formulaModal.classList.contains('show'), false);
    }
});

test('modal undo shortcuts stay inside the formula field without preventing its native undo', () => {
    for (const modifier of ['ctrlKey', 'metaKey']) {
        const f = fixture();
        const original = f.formula('x');
        f.context.initFormulaModal();
        f.context.openFormulaModal('inline', original);
        f.ids.formulaInput.value = 'draft';
        let documentUndos = 0;
        f.document.listeners.keydown = () => documentUndos++;
        const event = modalKey(f, 'z', {[modifier]: true});
        assert.equal(event.propagationStopped, true);
        assert.equal(event.defaultPrevented, false);
        assert.equal(documentUndos, 0);
        assert.equal(f.ids.formulaModal.classList.contains('show'), true);
        assert.equal(f.ids.editorArea.childNodes[0], original);
        assert.equal(f.calls.saves, 0);
    }
});

test('modal Escape cancels the draft without propagating to document handlers', () => {
    const f = fixture();
    const original = f.formula('x');
    f.context.initFormulaModal();
    f.context.openFormulaModal('inline', original);
    f.ids.formulaInput.value = 'discarded';
    let documentKeys = 0;
    f.document.listeners.keydown = () => documentKeys++;
    const event = modalKey(f, 'Escape');
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
    assert.equal(documentKeys, 0);
    assert.equal(f.ids.formulaModal.classList.contains('show'), false);
    assert.equal(f.ids.editorArea.childNodes[0], original);
    assert.equal(original.getAttribute('data-formula'), 'x');
    assert.equal(f.calls.saves, 0);
    assert.equal(f.document.activeElement, f.ids.editorArea);
});

test('modal Tab loops only at visible enabled control boundaries', () => {
    const f = fixture();
    f.context.initFormulaModal();
    f.context.openFormulaModal('inline');
    const disabled = new f.Element('button'); disabled.disabled = true;
    const hidden = new f.Element('textarea');
    const fields = [disabled, f.ids.formulaModalClose, f.ids.formulaInput, f.ids.btnInsertFormula, hidden];
    for (const field of fields) field.getClientRects = () => [{}];
    hidden.getClientRects = () => [];
    f.ids.formulaModal.querySelectorAll = selector => {
        assert.equal(selector, 'button,input,textarea,summary,math-field');
        return fields;
    };
    let documentKeys = 0;
    f.document.listeners.keydown = () => documentKeys++;
    f.ids.btnInsertFormula.focus();
    assert.equal(modalKey(f, 'Tab').defaultPrevented, true);
    assert.equal(f.document.activeElement, f.ids.formulaModalClose);
    assert.equal(modalKey(f, 'Tab', {shiftKey: true}).defaultPrevented, true);
    assert.equal(f.document.activeElement, f.ids.btnInsertFormula);
    f.ids.formulaInput.focus();
    assert.equal(modalKey(f, 'Tab').defaultPrevented, false);
    assert.equal(f.document.activeElement, f.ids.formulaInput);
    assert.equal(documentKeys, 0);
    assert.equal(f.calls.saves, 0);
});

test('an empty formula confirmation remains in the modal without starting compilation', () => {
    const f = fixture();
    f.context.initFormulaModal();
    f.context.openFormulaModal('inline');
    let propagationStopped = false;
    f.ids.formulaInput.listeners.keydown({key: 'Enter', ctrlKey: true,
        preventDefault() {}, stopPropagation() { propagationStopped = true; }});
    assert.equal(propagationStopped, true);
    assert.equal(f.ids.formulaModal.classList.contains('show'), true);
    assert.equal(f.ids.editorArea.childNodes.length, 0);
    assert.equal(f.calls.saves, 0);
    assert.equal(f.calls.statuses.at(-1), '请输入公式内容');
});

test('editing an existing formula replaces it once and invalidates old source metadata', () => {
    const f = fixture();
    const formula = f.formula('x');
    formula.setAttribute('data-delimiter', String.raw`\(`);
    formula.setAttribute('data-tex-source', String.raw`\(x\)`);
    formula.setAttribute('data-tex-snapshot', 'old snapshot');
    f.context.openFormulaModal('inline', formula);
    f.ids.formulaInput.value = 'x + 1';
    f.context.insertFormulaFromInput();
    assert.equal(f.ids.editorArea.childNodes.length, 1);
    const updated = f.ids.editorArea.childNodes[0];
    assert.equal(updated.getAttribute('data-formula'), 'x + 1');
    assert.equal(updated.getAttribute('data-delimiter'), String.raw`\(`);
    assert.equal(updated.textContent, String.raw`\(x + 1\)`);
    assert.equal(updated.getAttribute('contenteditable'), 'false');
    assert.equal(updated.getAttribute('data-tex-source'), null);
    assert.equal(updated.getAttribute('data-tex-snapshot'), null);
    assert.equal(f.calls.saves, 1);
});

test('confirming an unchanged formula preserves its exact source and node', () => {
    const f = fixture();
    const formula = f.formula(' x + y ');
    formula.setAttribute('data-tex-source', '$ x + y $');
    f.context.openFormulaModal('inline', formula);
    f.context.insertFormulaFromInput();
    assert.equal(f.ids.editorArea.childNodes[0], formula);
    assert.equal(formula.getAttribute('data-tex-source'), '$ x + y $');
    assert.equal(f.calls.saves, 0);
});

test('changing formula mode resets the delimiter while keeping nested markup valid', () => {
    const f = fixture();
    const formula = f.formula('x');
    formula.setAttribute('data-delimiter', String.raw`\(`);
    f.context.openFormulaModal('inline', formula);
    f.radios.find(r => r.value === 'block').checked = true;
    f.context.insertFormulaFromInput();
    const updated = f.ids.editorArea.childNodes[0];
    assert.equal(updated.tagName, 'SPAN');
    assert.equal(updated.className, 'formula-block');
    assert.equal(updated.getAttribute('data-delimiter'), '$$');
});

test('closing a formula editor cancels edits and a later insertion does not replace it', () => {
    const f = fixture();
    const original = f.formula('x');
    f.context.openFormulaModal('inline', original);
    f.ids.formulaInput.value = 'discarded';
    f.context.closeFormulaModal();
    f.context.openFormulaModal('inline');
    assert.equal(f.ids.formulaInput.value, '');
    f.ids.formulaInput.value = 'y';
    f.context.insertFormulaFromInput();
    assert.equal(f.ids.editorArea.childNodes[0], original);
    assert.equal(original.getAttribute('data-formula'), 'x');
    assert.equal(f.ids.editorArea.childNodes[1].getAttribute('data-formula'), 'y');
});

test('new display formulas use a paragraph-safe span', () => {
    const f = fixture();
    f.context.insertFormulaNode('x+y', 'block');
    const formula = f.ids.editorArea.childNodes[0];
    assert.equal(formula.tagName, 'SPAN');
    assert.equal(formula.className, 'formula-block');
    assert.equal(formula.getAttribute('data-delimiter'), '$$');
});

test('editing a legacy block formula does not remove its equation numbering', () => {
    const f = fixture();
    const formula = f.formula('x', 'block');
    formula.removeAttribute('data-delimiter');
    f.context.openFormulaModal('block', formula);
    f.ids.formulaInput.value = 'y';
    f.context.insertFormulaFromInput();
    assert.equal(f.ids.editorArea.childNodes[0].getAttribute('data-delimiter'), 'equation');
});
