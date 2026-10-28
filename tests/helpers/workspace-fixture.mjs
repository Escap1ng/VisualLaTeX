import fs from 'node:fs';
import vm from 'node:vm';
import {createDocument, Element, Text} from './dom.mjs';

// Actual markup, production startup and event handlers; the local fixture adds
// basic form/events to the shared deterministic DOM. No browser engine, layout,
// automatic HTML repair, scripts in user text or OS clipboard are simulated.
const markup = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const sources = ['main.js', 'project-model.js', 'project-archive.js', 'workspace.js']
    .map(name => [name, fs.readFileSync(new URL('../../' + name, import.meta.url), 'utf8')]);

export async function fixture({denyStorage = false, denyDialogs = false, initialStorage = [], includeVisualReferences = false, includeVisualMath = false} = {}) {
    const root = new Element('fixture-root');
    root.innerHTML = markup;
    const storage = new Map(initialStorage);
    const prompts = [];
    const alerts = [];
    const blobs = [];
    const tasks = new Map();
    let timer = 0;
    let document;
    const addEvents = target => {
        target._events = new Map();
        target.addEventListener = (type, listener) => {
            if (!target._events.has(type)) target._events.set(type, []);
            target._events.get(type).push(listener);
        };
        target.removeEventListener = (type, listener) => {
            target._events.set(type, (target._events.get(type) || []).filter(item => item !== listener));
        };
    };
    async function emit(target, type, properties = {}) {
        const event = {type, target, defaultPrevented: false, propagationStopped: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.propagationStopped = true; }, ...properties};
        for (const listener of target._events?.get(type) || []) await listener(event);
        return event;
    }
    function enhance(node) {
        if (node.nodeType !== 1 || node._events) return node;
        addEvents(node);
        node.classList = {
            contains: name => node.className.split(/\s+/).includes(name),
            add(...names) { node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
            remove(...names) { node.className = node.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
            toggle(name, force) {
                const add = force ?? !this.contains(name);
                if (add) this.add(name); else this.remove(name);
                return add;
            },
        };
        node.replaceChildren = (...children) => {
            for (const child of [...node.childNodes]) child.remove();
            for (const child of children) node.appendChild(typeof child === 'string' ? new Text(child) : child);
        };
        node.replaceChild = (next, old) => { old.replaceWith(next); return old; };
        const queryAll = node.querySelectorAll.bind(node);
        node.querySelectorAll = selector => selector.includes(',')
            ? queryAll('*').filter(child => selector.split(',').some(part => child.matches(part.trim()))) : queryAll(selector);
        node.querySelector = selector => node.querySelectorAll(selector)[0] || null;
        node.closest = selector => {
            for (let current = node; current; current = current.parentElement) {
                if (selector.split(',').some(part => current.matches(part.trim()))) return current;
            }
            return null;
        };
        node.focus = () => { document.activeElement = node; };
        node.click = () => node.disabled ? Promise.resolve() : emit(node, 'click');
        node.scrollTop = 0;
        node.scrollLeft = 0;
        node.selectionStart = node.selectionEnd = 0;
        let value = node.getAttribute('value') || (node.tagName === 'TEXTAREA' ? node.textContent : '');
        Object.defineProperty(node, 'value', {
            configurable: true,
            get: () => value,
            set(next) {
                const normalized = String(next).replace(/\r\n?/g, '\n');
                if (normalized !== value) node.selectionStart = node.selectionEnd = normalized.length;
                value = normalized;
            },
        });
        Object.defineProperty(node, 'hidden', {
            get: () => node.getAttribute('hidden') !== null,
            set(hidden) { if (hidden) node.setAttribute('hidden', ''); else node.removeAttribute('hidden'); },
        });
        node.disabled = node.getAttribute('disabled') !== null;
        let checked = node.getAttribute('checked') !== null;
        Object.defineProperty(node, 'checked', {
            get: () => checked,
            set(value) {
                if (value && node.getAttribute('type') === 'radio') {
                    for (const other of root.querySelectorAll('input')) {
                        if (other !== node && other.getAttribute('type') === 'radio' && other.getAttribute('name') === node.getAttribute('name')) other.checked = false;
                    }
                }
                checked = Boolean(value);
            },
        });
        if (node.tagName === 'INPUT' && node.getAttribute('type') === 'file') node.files = [];
        node.setSelectionRange = (start, end) => {
            node.selectionStart = Math.max(0, Math.min(value.length, start));
            node.selectionEnd = Math.max(node.selectionStart, Math.min(value.length, end));
        };
        node.select = () => node.setSelectionRange(0, value.length);
        return node;
    }
    for (const node of root.querySelectorAll('*')) enhance(node);
    const ids = new Map(root.querySelectorAll('[id]').map(node => [node.getAttribute('id'), node]));
    const base = createDocument();
    document = {...base, body: root.querySelector('body'), activeElement: null, visibilityState: 'visible',
        getElementById: id => ids.get(id) || null,
        createElement: tag => enhance(base.createElement(tag)),
        createTextNode: value => new Text(String(value)),
        querySelector(selector) {
            if (selector.startsWith('input[name="formulaMode"]')) {
                const radios = root.querySelectorAll('input').filter(node => node.getAttribute('name') === 'formulaMode');
                if (selector.endsWith(':checked')) return radios.find(node => node.checked) || null;
                const requested = /\[value="([^"]+)"\]/.exec(selector)?.[1];
                return radios.find(node => node.value === requested) || null;
            }
            return root.querySelector(selector);
        },
        querySelectorAll(selector) {
            if (selector === 'input[name="formulaMode"]') return root.querySelectorAll('input').filter(node => node.getAttribute('name') === 'formulaMode');
            return root.querySelectorAll(selector);
        },
        execCommand() { return true; },
    };
    addEvents(document);
    // A minimal live Range for checking cursor restoration, not layout or a
    // replacement for browser acceptance. Mutations are real fixture DOM edits.
    class Range {
        constructor() { this.startContainer = document.body; this.endContainer = document.body; this.startOffset = this.endOffset = 0; }
        get commonAncestorContainer() {
            for (let node = this.startContainer; node; node = node.parentNode) {
                if (node === this.endContainer || node.contains?.(this.endContainer)) return node;
            }
            return document.body;
        }
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset; }
        setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; }
        setStartAfter(node) { this.setStart(node.parentNode, node.parentNode.childNodes.indexOf(node) + 1); }
        setEndAfter(node) { this.setEnd(node.parentNode, node.parentNode.childNodes.indexOf(node) + 1); }
        selectNodeContents(node) { this.setStart(node, 0); this.setEnd(node, node.nodeType === 3 ? node.textContent.length : node.childNodes.length); }
        collapse(toStart = false) {
            if (toStart) this.setEnd(this.startContainer, this.startOffset);
            else this.setStart(this.endContainer, this.endOffset);
        }
        cloneRange() { const clone = new Range(); Object.assign(clone, this); return clone; }
        deleteContents() {
            if (this.startContainer !== this.endContainer) throw new Error('The fixture supports selections within a single node');
            if (this.startContainer.nodeType === 3) {
                const node = this.startContainer;
                node.textContent = node.textContent.slice(0, this.startOffset) + node.textContent.slice(this.endOffset);
            } else for (const child of this.startContainer.childNodes.slice(this.startOffset, this.endOffset)) child.remove();
            this.collapse(true);
        }
        insertNode(node) {
            let parent = this.startContainer;
            let position = this.startOffset;
            if (parent.nodeType === 3) {
                const original = parent;
                const after = new Text(original.textContent.slice(position));
                original.textContent = original.textContent.slice(0, position);
                parent = original.parentNode;
                position = parent.childNodes.indexOf(original) + 1;
                after.parentNode = parent; parent.childNodes.splice(position, 0, after);
            }
            node.remove?.(); node.parentNode = parent; parent.childNodes.splice(position, 0, node);
        }
    }
    const selection = {ranges: [], get rangeCount() { return this.ranges.length; },
        get anchorNode() { return this.ranges[0]?.startContainer || null; },
        getRangeAt: index => selection.ranges[index], removeAllRanges() { this.ranges = []; }, addRange(range) { this.ranges.push(range); }};
    document.createRange = () => new Range();
    const window = {getSelection: () => selection};
    addEvents(window);
    const context = vm.createContext({document, window, Node: {ELEMENT_NODE: 1, TEXT_NODE: 3},
        TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, atob, btoa, Blob,
        DecompressionStream, ReadableStream, Date, console,
        localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key)},
        prompt: () => { if (denyDialogs) throw new Error('prompt() is not supported.'); return prompts.shift() ?? null; },
        confirm: () => { if (denyDialogs) throw new Error('confirm() is not supported.'); return true; },
        alert: message => alerts.push(message),
        setTimeout: callback => { const id = ++timer; tasks.set(id, callback); return id; },
        clearTimeout: id => tasks.delete(id),
        navigator: {clipboard: {writeText: async () => {}}},
        URL: {createObjectURL: blob => { blobs.push(blob); return 'blob:fixture/' + blobs.length; }, revokeObjectURL() {}},
    });
    let mathField = null;
    if (includeVisualMath) {
        // Instrument only the external custom element boundary. Production
        // adapter, palette buttons, modal and workspace handlers remain real.
        const field = ids.get('formulaMathField');
        mathField = {writes: [], inserts: []};
        let fieldValue = '';
        Object.defineProperty(field, 'value', {configurable: true,
            get: () => fieldValue,
            set(value) { fieldValue = String(value); mathField.writes.push(fieldValue); field.lastOffset = fieldValue.length + 5; },
        });
        field.insert = (latex, options) => {
            mathField.inserts.push({latex, options: {...options}});
            field.value += latex;
        };
        context.MathfieldElement = class MathfieldElement {};
        context.customElements = {get: name => ['math-field', 'math-span'].includes(name) ? context.MathfieldElement : undefined};
    }
    if (denyStorage) Object.defineProperty(context, 'localStorage', {
        get() { const error = new Error('Access to localStorage is denied'); error.name = 'SecurityError'; throw error; },
    });
    const loaded = [...sources];
    if (includeVisualMath) loaded.unshift(['visual-math.js', fs.readFileSync(new URL('../../visual-math.js', import.meta.url), 'utf8')]);
    if (includeVisualReferences) for (const name of ['visual-references.js', 'visual-references-ui.js']) {
        loaded.splice(loaded.length - 1, 0, [name, fs.readFileSync(new URL('../../' + name, import.meta.url), 'utf8')]);
    }
    for (const [filename, source] of loaded) vm.runInContext(source, context, {filename});
    await emit(document, 'DOMContentLoaded');
    const refresh = () => { for (const node of root.querySelectorAll('*')) enhance(node); };
    refresh();
    return {context, app: context.visualWorkspace, document, ids, storage, prompts, alerts, blobs, emit,
        refresh, selection, mathField,
        setCursor(node, offset) { const range = new Range(); range.setStart(node, offset); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); },
        node: id => ids.get(id), click: id => ids.get(id).click(),
        async input(id, value) {
            // Source-oriented scenarios explicitly open the source editor, as a
            // real user must now do from the default visual editing surface.
            if (id === 'sourceArea') await ids.get('modeSource').click();
            ids.get(id).value = value; await emit(ids.get(id), 'input');
        },
        async flushTimers() {
            const pending = [...tasks.values()]; tasks.clear();
            for (const callback of pending) await callback();
        },
    };
}

