/* Canonical project files and per-file editing history. No DOM or network access. */
(function (global) {
    'use strict';

    const MAX_FILES = 500;
    const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
    const HISTORY_LIMIT = 100;
    const HISTORY_BYTES = 8 * 1024 * 1024;
    const encoder = new TextEncoder();

    function validatePath(value) {
        if (typeof value !== 'string' || !value || value.length > 1024) throw new Error('文件路径不能为空且不能超过 1024 字符');
        const path = value.replace(/\\/g, '/');
        if (path.startsWith('/') || /[:\u0000-\u001f\u007f]/.test(path)) throw new Error('文件路径必须是项目内的相对路径');
        if (path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('文件路径不能包含空目录、. 或 ..');
        return path;
    }

    function language(path) {
        const extension = String(path).split('.').pop().toLowerCase();
        if (['tex', 'latex', 'sty', 'cls'].includes(extension)) return 'latex';
        if (extension === 'bib') return 'bibtex';
        if (extension === 'ps' || extension === 'eps') return 'postscript';
        return 'text';
    }

    const pathKey = path => path.normalize('NFC').toLowerCase();

    function checkText(text, encoding) {
        if (typeof text !== 'string') throw new Error('文本文件必须提供字符串内容');
        if (encoding === 'latin1') {
            for (let i = 0; i < text.length; i++) {
                if (text.charCodeAt(i) > 255) throw new Error('Latin-1 文件不能保存此字符；请先转换为 UTF-8 编码');
            }
            return text.length;
        }
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if (code >= 0xd800 && code <= 0xdbff) {
                const next = text.charCodeAt(++i);
                if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('文本包含不完整的 Unicode 字符');
            } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('文本包含不完整的 Unicode 字符');
        }
        return encoder.encode(text).length;
    }

    function normalizeFile(input) {
        if (!input || typeof input !== 'object') throw new Error('文件记录无效');
        const path = validatePath(input.path);
        if (input.kind === 'binary') {
            const base64 = input.base64;
            if (typeof base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
                throw new Error('二进制文件的 Base64 内容无效：' + path);
            }
            const size = base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
            return {file: {path, kind: 'binary', base64}, size};
        }
        if (input.kind !== undefined && input.kind !== 'text') throw new Error('未知文件类型：' + path);
        const encoding = input.encoding || 'utf-8';
        if (encoding !== 'utf-8' && encoding !== 'latin1') throw new Error('不支持的文本编码：' + encoding);
        const size = checkText(input.text, encoding);
        return {file: {path, kind: 'text', text: input.text, encoding}, size};
    }

    function readGroup(text, start, open = '{', close = '}') {
        if (text[start] !== open) return null;
        let depth = 1;
        let braces = 0;
        for (let i = start + 1; i < text.length; i++) {
            if (text[i] === '\\') { i++; continue; }
            if (text[i] === '%') {
                const end = text.indexOf('\n', i);
                if (end < 0) return null;
                i = end;
                continue;
            }
            if (open !== '{') {
                if (text[i] === '{') braces++;
                else if (text[i] === '}') braces--;
                if (braces > 0) continue;
            }
            if (text[i] === open) depth++;
            else if (text[i] === close && --depth === 0) return {start, end: i + 1, content: text.slice(start + 1, i)};
        }
        return null;
    }

    function scanLatex(text, path, result) {
        const citations = new Set(['cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'citeyearpar', 'nocite',
            'autocite', 'parencite', 'textcite', 'footcite', 'footcitetext', 'smartcite', 'supercite', 'fullcite']);
        const references = new Set(['ref', 'eqref', 'pageref', 'autoref', 'nameref', 'cref', 'vref', 'vpageref']);
        for (let i = 0; i < text.length;) {
            if (text[i] === '%') { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end + 1; continue; }
            if (text[i] !== '\\') { i++; continue; }
            const match = /^\\([A-Za-z@]+\*?|[^\r\n])/.exec(text.slice(i));
            if (!match) { i++; continue; }
            const start = i;
            const name = match[1].replace(/\*$/, '').toLowerCase();
            i += match[0].length;
            if (name === 'verb' || name === 'lstinline') {
                if (name === 'lstinline' && text[i] === '[') { const opt = readGroup(text, i, '[', ']'); if (opt) i = opt.end; }
                const delimiter = text[i];
                if (delimiter && !/\s/.test(delimiter)) { const end = text.indexOf(delimiter, i + 1); i = end < 0 ? text.length : end + 1; }
                continue;
            }
            while (/\s/.test(text[i] || '') && i < text.length) i++;
            if (name === 'begin') {
                const env = readGroup(text, i);
                if (env && /^(?:verbatim\*?|Verbatim|lstlisting|minted|comment)$/.test(env.content)) {
                    const closing = '\\end{' + env.content + '}';
                    const end = text.indexOf(closing, env.end);
                    i = end < 0 ? text.length : end + closing.length;
                }
                continue;
            }
            if (name !== 'label' && !citations.has(name) && !references.has(name)) continue;
            while (text[i] === '[') {
                const optional = readGroup(text, i, '[', ']');
                if (!optional) break;
                i = optional.end;
                while (/\s/.test(text[i] || '') && i < text.length) i++;
            }
            const group = readGroup(text, i);
            if (!group) continue; // Incomplete source remains editable; it simply has no index entry yet.
            const target = name === 'label' ? result.labels : citations.has(name) ? result.citations : result.references;
            for (const key of group.content.split(',').map(key => key.trim()).filter(Boolean)) {
                target.push({key, path, offset: start});
            }
            i = group.end;
        }
    }

    function scanBibtex(text, path, result) {
        for (let i = 0; i < text.length;) {
            if (text[i] === '%') { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end + 1; continue; }
            if (text[i] !== '@') { i++; continue; }
            const match = /^@([A-Za-z]+)\s*([{(])/.exec(text.slice(i));
            if (!match) { i++; continue; }
            const type = match[1].toLowerCase();
            const start = i;
            const groupStart = i + match[0].length - 1;
            const group = readGroup(text, groupStart, match[2], match[2] === '{' ? '}' : ')');
            if (!group) { i += match[0].length; continue; }
            if (!['comment', 'preamble', 'string'].includes(type)) {
                const key = /^\s*([^,\s{}()]+)\s*,/.exec(group.content);
                if (key) result.bibliography.push({key: key[1], path, offset: start, type});
            }
            i = group.end;
        }
    }

    class ProjectModel {
        constructor(options = {}) {
            if (!options || typeof options !== 'object') throw new Error('项目数据无效');
            this.name = options.name === undefined ? '未命名项目' : options.name;
            this._files = new Map();
            this._sizes = new Map();
            this._histories = new Map();
            this._activePath = null;
            this._mainPath = null;
            this.totalBytes = 0;
            if (options.files !== undefined && !Array.isArray(options.files)) throw new Error('项目文件列表无效');
            this.addMany(options.files || []);
            this.activePath = options.activePath === undefined ? this._activePath : options.activePath;
            this.mainPath = options.mainPath === undefined ? this._mainPath : options.mainPath;
        }

        static validatePath(path) { return validatePath(path); }
        static language(path) { return language(path); }
        language(path = this.activePath) { return language(path || ''); }
        get name() { return this._name; }
        set name(value) {
            if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('项目名称无效');
            this._name = value;
        }
        get activePath() { return this._activePath; }
        set activePath(path) {
            if (path === null && this._files.size === 0) { this._activePath = null; return; }
            const normalized = validatePath(path);
            if (!this._files.has(normalized)) throw new Error('文件不存在：' + normalized);
            if (this._activePath !== normalized) this._closeGroup(this._activePath);
            this._activePath = normalized;
        }
        get mainPath() { return this._mainPath; }
        set mainPath(path) {
            if (path === null) { this._mainPath = null; return; }
            const normalized = validatePath(path);
            if (this._files.get(normalized)?.kind !== 'text') throw new Error('主文件必须是项目中的文本文件');
            this._mainPath = normalized;
        }
        get(path = this.activePath) {
            const file = this._files.get(path);
            return file ? {...file, language: language(file.path)} : null;
        }
        list() { return Array.from(this._files.values(), file => ({...file, language: language(file.path)})); }
        select(path) { this.activePath = path; return this.get(); }

        add(file) { return this.addMany([file])[0]; }
        addMany(files) {
            if (!Array.isArray(files)) throw new Error('导入文件列表无效');
            if (this._files.size + files.length > MAX_FILES) throw new Error('项目最多包含 500 个文件');
            const names = new Set(Array.from(this._files.keys(), pathKey));
            let size = this.totalBytes;
            const records = files.map(input => {
                const record = normalizeFile(input);
                if (names.has(pathKey(record.file.path))) throw new Error('文件已存在：' + record.file.path);
                names.add(pathKey(record.file.path));
                size += record.size;
                if (size > MAX_TOTAL_BYTES) throw new Error('项目大小不能超过 50 MB');
                return record;
            });
            // All validation happens before any file is added.
            for (const {file, size: fileSize} of records) {
                this._files.set(file.path, file);
                this._sizes.set(file.path, fileSize);
                if (!this._activePath) this._activePath = file.path;
                if (!this._mainPath && file.kind === 'text') this._mainPath = file.path;
            }
            this.totalBytes = size;
            return records.map(({file}) => this.get(file.path));
        }

        rename(oldPath, nextPath) {
            const file = this._files.get(oldPath);
            if (!file) throw new Error('文件不存在：' + oldPath);
            const path = validatePath(nextPath);
            if (Array.from(this._files.keys()).some(name => name !== oldPath && pathKey(name) === pathKey(path))) throw new Error('文件已存在：' + path);
            if (oldPath === path) return this.get(path);
            this._files = new Map(Array.from(this._files, ([name, entry]) => name === oldPath ? [path, {...entry, path}] : [name, entry]));
            this._sizes.set(path, this._sizes.get(oldPath));
            this._sizes.delete(oldPath);
            if (this._histories.has(oldPath)) { this._histories.set(path, this._histories.get(oldPath)); this._histories.delete(oldPath); }
            if (this._activePath === oldPath) this._activePath = path;
            if (this._mainPath === oldPath) this._mainPath = path;
            this._closeGroup(path);
            return this.get(path);
        }

        remove(path) {
            const removed = this.get(path);
            if (!removed) throw new Error('文件不存在：' + path);
            this.totalBytes -= this._sizes.get(path);
            this._files.delete(path);
            this._sizes.delete(path);
            this._histories.delete(path);
            if (this._activePath === path) this._activePath = this._files.keys().next().value || null;
            if (this._mainPath === path) this._mainPath = Array.from(this._files.values()).find(file => file.kind === 'text')?.path || null;
            return removed;
        }

        _history(path) {
            if (!this._histories.has(path)) this._histories.set(path, {undo: [], redo: [], groupedAt: 0});
            return this._histories.get(path);
        }
        _closeGroup(path) { if (this._histories.has(path)) this._histories.get(path).groupedAt = 0; }
        _prune(entries, encoding) {
            let size = entries.reduce((sum, text) => sum + (encoding === 'latin1' ? text.length : encoder.encode(text).length), 0);
            while (entries.length > HISTORY_LIMIT || (entries.length > 1 && size > HISTORY_BYTES)) {
                const text = entries.shift();
                size -= encoding === 'latin1' ? text.length : encoder.encode(text).length;
            }
        }
        _replacementSize(file, text) {
            const size = checkText(text, file.encoding);
            if (this.totalBytes - this._sizes.get(file.path) + size > MAX_TOTAL_BYTES) throw new Error('项目大小不能超过 50 MB');
            return size;
        }
        _replace(file, text, size) {
            this.totalBytes += size - this._sizes.get(file.path);
            this._sizes.set(file.path, size);
            this._files.set(file.path, {...file, text});
            return this.get(file.path);
        }
        update(text, {group = false} = {}) {
            const file = this._files.get(this.activePath);
            if (!file || file.kind !== 'text') throw new Error('请选择可编辑的文本文件');
            if (text === file.text) return this.get();
            const size = this._replacementSize(file, text);
            const history = this._history(file.path);
            const now = Date.now();
            if (!group || !history.groupedAt || now - history.groupedAt > 700 || history.redo.length) history.undo.push(file.text);
            this._prune(history.undo, file.encoding);
            history.redo = [];
            history.groupedAt = group ? now : 0;
            return this._replace(file, text, size);
        }
        setEncoding(path, encoding) {
            const file = this._files.get(path);
            if (!file || file.kind !== 'text') throw new Error('请选择可编辑的文本文件');
            if (encoding !== 'utf-8' && encoding !== 'latin1') throw new Error('不支持的文本编码：' + encoding);
            if (encoding === file.encoding) return this.get(path);
            const converted = {...file, encoding};
            const size = this._replacementSize(converted, file.text);
            // An encoding change starts a new edit history so an old state cannot
            // silently restore characters that the chosen encoding cannot represent.
            this._histories.delete(path);
            return this._replace(converted, file.text, size);
        }
        canUndo() { return Boolean(this._histories.get(this.activePath)?.undo.length); }
        canRedo() { return Boolean(this._histories.get(this.activePath)?.redo.length); }
        undo() { return this._restore('undo', 'redo'); }
        redo() { return this._restore('redo', 'undo'); }
        _restore(from, to) {
            const file = this._files.get(this.activePath);
            const history = this._histories.get(this.activePath);
            if (!file || file.kind !== 'text' || !history?.[from].length) return null;
            const text = history[from][history[from].length - 1];
            const size = this._replacementSize(file, text);
            history[from].pop();
            history[to].push(file.text);
            this._prune(history[to], file.encoding);
            history.groupedAt = 0;
            return this._replace(file, text, size);
        }

        serialize() {
            return JSON.stringify({format: 'visual-workspace', version: 1, name: this.name,
                activePath: this.activePath, mainPath: this.mainPath, files: Array.from(this._files.values())});
        }
        static deserialize(serialized) {
            const data = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
            if (!data || data.format !== 'visual-workspace' || data.version !== 1) throw new Error('无法识别此项目文件版本');
            return new ProjectModel(data);
        }
        references() {
            const result = {labels: [], citations: [], bibliography: [], references: []};
            for (const file of this._files.values()) {
                if (file.kind !== 'text') continue;
                const type = language(file.path);
                if (type === 'latex') scanLatex(file.text, file.path, result);
                if (type === 'bibtex') scanBibtex(file.text, file.path, result);
            }
            return result;
        }
    }

    ProjectModel.MAX_FILES = MAX_FILES;
    ProjectModel.MAX_TOTAL_BYTES = MAX_TOTAL_BYTES;
    global.ProjectModel = ProjectModel;
})(globalThis);
