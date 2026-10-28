// A small deterministic DOM fixture for generated editor markup, NOT a browser
// engine. It models entity decoding, HTML newline normalization, tree traversal,
// inert templates and mutation/serialization; it does not execute scripts, load
// resources, calculate layout or implement HTML error-recovery rules.
const voidTags = new Set(['BR', 'IMG', 'INPUT', 'HR', 'META', 'LINK', 'EMBED']);
function decode(value) {
    return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity) => {
        if (/^#x/i.test(entity)) return String.fromCodePoint(parseInt(entity.slice(2), 16));
        if (entity[0] === '#') return String.fromCodePoint(parseInt(entity.slice(1), 10));
        return ({amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0'})[entity.toLowerCase()] ?? all;
    });
}
function textEscape(value) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function attrEscape(value) { return textEscape(value).replace(/"/g, '&quot;'); }

class Parent {
    constructor() { this.childNodes = []; }
    appendChild(node) { node.remove?.(); node.parentNode = this; this.childNodes.push(node); return node; }
    contains(node) { return node === this || this.childNodes.some(child => child === node || child.contains?.(node)); }
    get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
    set textContent(value) { this.childNodes = []; if (value) this.appendChild(new Text(String(value))); }
    get innerHTML() { return this.childNodes.map(serialize).join(''); }
    set innerHTML(html) { this.childNodes = []; parseInto(this, String(html)); }
    querySelectorAll(selector) {
        const result = [];
        const visit = parent => {
            for (const child of parent.childNodes) {
                if (child.nodeType !== 1) continue;
                if (child.matches(selector)) result.push(child);
                visit(child);
            }
        };
        visit(this);
        return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener() {}
    focus() {}
}

export class Text {
    constructor(value) { this.nodeType = 3; this.textContent = value; this.parentNode = null; }
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
    remove() {
        if (!this.parentNode) return;
        this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
        this.parentNode = null;
    }
}

export class Element extends Parent {
    constructor(tag) {
        super();
        this.nodeType = 1;
        this.tagName = tag.toUpperCase();
        this._attributes = new Map();
        this.classList = { contains: name => this.className.split(/\s+/).includes(name) };
        const self = this;
        this.style = {
            get textAlign() { return (self.getAttribute('style') || '').match(/(?:^|;)\s*text-align\s*:\s*([^;]+)/i)?.[1].trim() || ''; },
            set textAlign(value) { self.setAttribute('style', 'text-align: ' + value + ';'); },
        };
    }
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
    get attributes() { return Array.from(this._attributes, ([name, value]) => ({name, value})); }
    setAttribute(name, value) { this._attributes.set(name.toLowerCase(), String(value)); }
    getAttribute(name) { return this._attributes.get(name.toLowerCase()) ?? null; }
    removeAttribute(name) { this._attributes.delete(name.toLowerCase()); }
    get className() { return this.getAttribute('class') || ''; }
    set className(value) { this.setAttribute('class', value); }
    matches(selector) {
        if (selector === '*') return true;
        if (selector.startsWith('[')) return this.getAttribute(selector.slice(1, -1)) !== null;
        if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
        return this.tagName === selector.toUpperCase();
    }
    remove() { Text.prototype.remove.call(this); }
    replaceWith(...nodes) {
        const parent = this.parentNode;
        if (!parent) return;
        const position = parent.childNodes.indexOf(this);
        for (const node of nodes) node.remove?.();
        parent.childNodes.splice(position, 1, ...nodes);
        for (const node of nodes) node.parentNode = parent;
        this.parentNode = null;
    }
}

class Fragment extends Parent { constructor() { super(); this.nodeType = 11; } }
class Template extends Element {
    constructor() { super('template'); this.content = new Fragment(); }
    get innerHTML() { return this.content.innerHTML; }
    set innerHTML(value) { this.content.innerHTML = value; }
}
function serialize(node) {
    if (node.nodeType === 3) return textEscape(node.textContent);
    const tag = node.tagName.toLowerCase();
    const attrs = node.attributes.map(attr => ' ' + attr.name + '="' + attrEscape(attr.value) + '"').join('');
    return '<' + tag + attrs + '>' + (voidTags.has(node.tagName) ? '' : node.innerHTML + '</' + tag + '>');
}

function parseInto(root, markup) {
    // HTML tokenization normalizes source newlines before character references.
    const html = markup.replace(/\r\n?/g, '\n');
    const stack = [root];
    for (let i = 0; i < html.length;) {
        if (html.startsWith('<!--', i)) {
            const end = html.indexOf('-->', i + 4);
            i = end < 0 ? html.length : end + 3;
            continue;
        }
        if (html[i] !== '<' || !/^<\/?[a-z]/i.test(html.slice(i))) {
            let end = html.indexOf('<', i + 1);
            if (end < 0) end = html.length;
            stack.at(-1).appendChild(new Text(decode(html.slice(i, end))));
            i = end;
            continue;
        }
        let end = i + 1;
        let quote = null;
        for (; end < html.length; end++) {
            if (quote) { if (html[end] === quote) quote = null; }
            else if (html[end] === '"' || html[end] === "'") quote = html[end];
            else if (html[end] === '>') break;
        }
        const token = html.slice(i + 1, end);
        i = Math.min(end + 1, html.length);
        if (token[0] === '/') {
            const tag = token.slice(1).trim().toUpperCase();
            for (let j = stack.length - 1; j > 0; j--) {
                if (stack[j].tagName === tag) { stack.length = j; break; }
            }
            continue;
        }
        const match = token.match(/^([^\s/>]+)([\s\S]*)$/);
        const node = new Element(match[1]);
        for (const attr of match[2].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
            node.setAttribute(attr[1], decode(attr[2] ?? attr[3] ?? attr[4] ?? ''));
        }
        stack.at(-1).appendChild(node);
        if (!voidTags.has(node.tagName) && !token.endsWith('/')) stack.push(node);
    }
}

export function createDocument() {
    return {
        addEventListener() {},
        createElement: tag => tag.toLowerCase() === 'template' ? new Template() : new Element(tag),
        createTextNode: text => new Text(String(text)),
    };
}
