/* Semantic reference labels and lossless edits. All output is plain text, never HTML. */
(function (global) {
    'use strict';

    const citations = new Set(['cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'citeyearpar',
        'autocite', 'parencite', 'textcite', 'nocite', 'footcite', 'footcitetext', 'smartcite', 'supercite', 'fullcite']);
    const references = new Set(['ref', 'eqref', 'autoref', 'pageref', 'nameref', 'cref', 'vref', 'vpageref']);
    const headings = new Set(['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph']);
    const verbatim = new Set(['verbatim', 'Verbatim', 'lstlisting', 'minted', 'comment']);
    const cache = new WeakMap();

    function skipTrivia(text, start) {
        let i = start;
        while (i < text.length) {
            if (/\s/.test(text[i])) { i++; continue; }
            if (text[i] === '%') { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end + 1; continue; }
            break;
        }
        return i;
    }

    function group(text, start, open = '{', close = '}') {
        if (text[start] !== open) return null;
        let depth = 1;
        let braces = 0;
        for (let i = start + 1; i < text.length; i++) {
            if (text[i] === '\\') { i++; continue; }
            if (text[i] === '%') { const end = text.indexOf('\n', i); if (end < 0) return null; i = end; continue; }
            if (open === '[') {
                if (text[i] === '{') { braces++; continue; }
                if (text[i] === '}') { if (--braces < 0) return null; continue; }
                if (braces) continue;
            }
            if (text[i] === open) depth++;
            else if (text[i] === close && --depth === 0) return {start, end: i + 1, content: text.slice(start + 1, i)};
        }
        return null;
    }

    function commandAt(text, start) {
        if (text[start] !== '\\') return null;
        const match = /^\\([A-Za-z@]+\*?|[^\r\n])/.exec(text.slice(start));
        return match ? {command: match[1], name: match[1].replace(/\*$/, '').toLowerCase(), end: start + match[0].length} : null;
    }

    function kindOf(name) {
        if (citations.has(name)) return 'citation';
        if (references.has(name)) return 'reference';
        if (name === 'label') return 'label';
        if (name === 'input' || name === 'include') return 'include';
        if (['bibliography', 'addbibresource', 'printbibliography'].includes(name)) return 'bibliography';
        if (name === 'bibliographystyle') return 'style';
        return null;
    }

    function parse(source) {
        if (typeof source !== 'string') return null;
        const token = commandAt(source, skipTrivia(source, 0));
        if (!token) return null;
        const kind = kindOf(token.name);
        if (!kind) return null;
        let i = skipTrivia(source, token.end);
        const options = [];
        while (source[i] === '[') {
            const option = group(source, i, '[', ']');
            if (!option) return null;
            options.push(option);
            i = skipTrivia(source, option.end);
        }
        const argument = token.name === 'printbibliography' ? null : group(source, i);
        if (!argument && token.name !== 'printbibliography') return null;
        if (skipTrivia(source, argument ? argument.end : i) !== source.length) return null;
        const key = argument ? argument.content.trim() : '';
        const multi = kind === 'citation' || token.name === 'bibliography' || ['cref', 'vref'].includes(token.name);
        return {...token, kind, options, argument, key, keys: multi ? key.split(',').map(value => value.trim()).filter(Boolean) : key ? [key] : [], multi};
    }

    // This is a readable metadata approximation, not expansion of arbitrary TeX macros.
    function plainText(text) {
        return String(text || '').replace(/\\(?:[A-Za-z@]+\*?|.)|%[^\r\n]*/g, token => token[0] === '%' ? '' : token).replace(/\\([%&#_$])/g, '$1')
            .replace(/\\(?:LaTeX|TeX)\b/g, match => match.slice(1)).replace(/\\[A-Za-z@]+\*?/g, '')
            .replace(/\\["'`^~=.]\s*/g, '').replace(/[{}$]/g, '').replace(/\\ /g, ' ').replace(/~/g, ' ')
            .replace(/\s+/g, ' ').trim();
    }

    function scanLabels(text, path, output) {
        let title = '';
        const environments = [];
        let mathDelimiter = '';
        for (let i = 0; i < text.length;) {
            if (text[i] === '%') { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end + 1; continue; }
            if (text[i] !== '\\') { i++; continue; }
            const offset = i;
            const token = commandAt(text, i);
            if (!token) { i++; continue; }
            i = token.end;
            if (token.command === '[' || token.command === '(') mathDelimiter = token.command;
            else if ((token.command === ']' && mathDelimiter === '[') || (token.command === ')' && mathDelimiter === '(')) mathDelimiter = '';
            if (token.name === 'verb' || token.name === 'lstinline') {
                if (token.name === 'lstinline') {
                    const option = group(text, skipTrivia(text, i), '[', ']');
                    if (option) i = option.end;
                }
                const delimiter = text[i];
                if (delimiter && !/\s/.test(delimiter)) {
                    const end = text.indexOf(delimiter, i + 1);
                    const newline = text.indexOf('\n', i + 1);
                    i = end >= 0 && (newline < 0 || end < newline) ? end + 1 : newline < 0 ? text.length : newline + 1;
                }
                continue;
            }
            let cursor = skipTrivia(text, i);
            while (text[cursor] === '[') {
                const option = group(text, cursor, '[', ']');
                if (!option) break;
                cursor = skipTrivia(text, option.end);
            }
            const argument = group(text, cursor);
            if (!argument) continue;
            if (token.name === 'begin' && verbatim.has(argument.content)) {
                const closing = '\\end{' + argument.content + '}';
                const end = text.indexOf(closing, argument.end);
                i = end < 0 ? text.length : end + closing.length;
            } else if (token.name === 'begin') {
                environments.push(argument.content);
                i = argument.end;
            } else if (token.name === 'end') {
                if (environments[environments.length - 1] === argument.content) environments.pop();
                i = argument.end;
            } else if (headings.has(token.name)) {
                title = plainText(argument.content);
                i = argument.end;
            } else if (token.name === 'label') {
                const key = argument.content.trim();
                const equation = !!mathDelimiter || environments.some(name => /^(?:equation|align|alignat|flalign|gather|multline|displaymath|math)\*?$/.test(name));
                if (key) output.push({key, path, offset, title, equation});
                i = argument.end;
            }
        }
    }

    function bibEntry(text, start, close) {
        let depth = 0;
        let quoted = false;
        for (let i = start; i < text.length; i++) {
            if (text[i] === '\\') { i++; continue; }
            if (!quoted && text[i] === '%') { const end = text.indexOf('\n', i); if (end < 0) return null; i = end; continue; }
            if (text[i] === '"' && depth === 0) { quoted = !quoted; continue; }
            if (text[i] === '{') depth++;
            else if (text[i] === '}' && depth) depth--;
            else if (!depth && !quoted && text[i] === close) return {content: text.slice(start, i), end: i + 1};
        }
        return null;
    }

    function splitBibFields(text) {
        // Comments can contain arbitrary braces/commas; remove them before splitting fields.
        let clean = '';
        let commentDepth = 0;
        let commentQuoted = false;
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\\') { clean += text.slice(i, i + 2); i++; continue; }
            if (text[i] === '%' && !commentQuoted) {
                const end = text.indexOf('\n', i);
                if (end < 0) break;
                clean += '\n';
                i = end;
                continue;
            }
            if (text[i] === '"' && !commentDepth) commentQuoted = !commentQuoted;
            if (text[i] === '{') commentDepth++;
            else if (text[i] === '}') commentDepth--;
            clean += text[i];
        }
        text = clean;
        const fields = [];
        let depth = 0;
        let quoted = false;
        let start = 0;
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\\') { i++; continue; }
            if (text[i] === '"' && depth === 0) quoted = !quoted;
            else if (text[i] === '{') depth++;
            else if (text[i] === '}') depth--;
            else if (text[i] === ',' && !depth && !quoted) { fields.push(text.slice(start, i)); start = i + 1; }
        }
        fields.push(text.slice(start));
        return fields;
    }

    function scanBibliography(text, path, output) {
        for (let i = 0; i < text.length;) {
            if (text[i] === '%') { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end + 1; continue; }
            if (text[i] !== '@') { i++; continue; }
            const match = /^@([A-Za-z]+)\s*([{(])/.exec(text.slice(i));
            if (!match) { i++; continue; }
            const offset = i;
            const entry = bibEntry(text, i + match[0].length, match[2] === '{' ? '}' : ')');
            if (!entry) { i += match[0].length; continue; }
            i = entry.end;
            const type = match[1].toLowerCase();
            if (['comment', 'preamble', 'string'].includes(type)) continue;
            const fields = splitBibFields(entry.content);
            const key = fields.shift().trim();
            if (!key) continue;
            const metadata = {};
            for (const field of fields) {
                const pair = /^\s*([A-Za-z]+)\s*=\s*([\s\S]*)$/.exec(field);
                if (!pair) continue;
                const name = pair[1].toLowerCase();
                if (!['author', 'title', 'year', 'date'].includes(name)) continue;
                const value = pair[2].trim().replace(/^"([\s\S]*)"$/, '$1');
                metadata[name] = plainText(value);
            }
            output.push({key, path, offset, type, ...metadata});
        }
    }

    function projectFiles(model) {
        if (!model) return [];
        const files = typeof model.list === 'function' ? model.list() : Array.isArray(model.files) ? model.files : [];
        return files.filter(file => file && typeof file.path === 'string' && typeof file.text === 'string' && file.kind !== 'binary');
    }

    function index(model) {
        const files = projectFiles(model);
        const previous = model && typeof model === 'object' ? cache.get(model) : null;
        if (previous && previous.files.length === files.length && files.every((file, i) => file.path === previous.files[i].path && file.text === previous.files[i].text)) return previous;
        const result = {files, labels: [], bibliography: []};
        for (const file of files) {
            if (/\.(?:tex|latex|ltx|sty|cls)$/i.test(file.path)) scanLabels(file.text, file.path, result.labels);
            else if (/\.bib$/i.test(file.path)) scanBibliography(file.text, file.path, result.bibliography);
        }
        if (model && typeof model === 'object') cache.set(model, result);
        return result;
    }

    function bibLabel(entry) {
        return [entry.author, entry.title].filter(Boolean).join(' — ') || entry.key;
    }

    function describe(source, model) {
        const token = parse(source);
        if (!token) return null;
        const entries = index(model);
        const result = {kind: token.kind, command: token.command, cmd: token.command, key: token.key, keys: token.keys,
            options: token.options.map(option => option.content), label: '', detail: '', editable: !!token.argument};
        if (token.kind === 'citation') {
            const found = token.keys.map(key => entries.bibliography.filter(entry => entry.key === key));
            result.label = token.name === 'nocite' && token.key === '*' ? '收录全部参考文献' : token.keys.map((key, i) => found[i].length === 1 ? bibLabel(found[i][0]) : found[i].length > 1 ? '文献键重复：' + key : '文献：' + key).join('；');
            result.detail = token.keys.map((key, i) => found[i].length === 1 ? [key, found[i][0].year || found[i][0].date, found[i][0].path].filter(Boolean).join(' · ') : key === '*' && token.name === 'nocite' ? '将文献库中全部条目加入参考文献列表' : (found[i].length ? '存在重复文献键：' : '未找到文献：') + key).join('；');
            if (token.name === 'nocite' && token.key !== '*') result.label = '收录文献：' + result.label;
        } else if (token.kind === 'reference' || token.kind === 'label') {
            const found = token.keys.map(key => entries.labels.filter(entry => entry.key === key));
            const titles = token.keys.map((key, i) => found[i].length === 1 ? found[i][0].equation ? '公式：' + key : found[i][0].title || key : key);
            if (token.kind === 'label') result.label = '标签：' + token.key;
            else if (['pageref', 'vpageref'].includes(token.name)) result.label = titles.join('、') + ' · 页码待编译';
            else if (token.name === 'eqref') result.label = '公式：' + token.keys.join('、');
            else result.label = titles.join('、') || '未设置引用';
            result.detail = token.keys.map((key, i) => found[i].length === 1 ? [key, found[i][0].title, found[i][0].path].filter(Boolean).join(' · ') : (found[i].length ? '存在重复标签：' : '未找到标签：') + key).join('；');
        } else if (token.kind === 'include') {
            result.label = '引入文件：' + token.key;
            result.detail = token.name === 'include' ? '独立章节文件，编译时前后分页' : '在当前位置插入文件内容';
        } else if (token.kind === 'bibliography') {
            result.label = token.name === 'printbibliography' ? '参考文献列表' : '文献库：' + token.keys.join('、');
            result.detail = token.name === 'printbibliography' ? '编译后显示文献列表' : '用于解析正文引用的参考文献文件';
        } else {
            result.label = '文献样式：' + token.key;
            result.detail = '控制参考文献的排序与显示格式';
        }
        return result;
    }

    function getChoices(kind, model) {
        const entries = index(model);
        if (kind === 'citation') return entries.bibliography.map(entry => ({value: entry.key, label: bibLabel(entry), detail: [entry.key, entry.year || entry.date, entry.path].filter(Boolean).join(' · '), path: entry.path}));
        if (kind === 'reference' || kind === 'label') return entries.labels.map(entry => ({value: entry.key, label: entry.equation ? '公式：' + entry.key : entry.title || entry.key, detail: [entry.key, entry.title, entry.path].filter(Boolean).join(' · '), path: entry.path}));
        if (kind === 'include' || kind === 'bibliography') return entries.files.filter(file => kind === 'include' ? /\.(?:tex|latex|ltx)$/i.test(file.path) : /\.bib$/i.test(file.path)).map(file => ({value: file.path, label: file.path, detail: kind === 'include' ? '项目章节文件' : '项目文献库', path: file.path}));
        if (kind === 'style') return ['plain', 'unsrt', 'alpha', 'abbrv'].map(value => ({value, label: value, detail: 'BibTeX 文献样式'}));
        return [];
    }

    function validateKeys(values, token) {
        if (!values.length || values.some(value => typeof value !== 'string' || !value.trim())) throw new Error('引用键不能为空');
        if (!token.multi && values.length !== 1) throw new Error('此命令只接受一个键');
        return values.map(value => {
            const key = value.trim();
            if (/[\\{}\[\],%#$&^~\u0000-\u001f\u007f]/.test(key) || (['citation', 'reference', 'label', 'style'].includes(token.kind) && /\s/.test(key))) throw new Error('引用键不能包含空白、括号、反斜杠或 LaTeX 控制字符');
            if (key.includes('*') && !(token.name === 'nocite' && key === '*')) throw new Error('此命令不支持通配符');
            return key;
        });
    }

    function rewrite(source, changes = {}) {
        const token = parse(source);
        if (!token || !token.argument) throw new Error('此命令不能通过引用编辑器修改');
        const patches = [];
        const changedKey = Object.prototype.hasOwnProperty.call(changes, 'keys') || Object.prototype.hasOwnProperty.call(changes, 'key');
        if (changedKey) {
            const supplied = Object.prototype.hasOwnProperty.call(changes, 'keys') ? changes.keys : changes.key;
            if (!Array.isArray(supplied) && typeof supplied !== 'string') throw new Error('引用键必须是文本');
            const values = validateKeys(Array.isArray(supplied) ? supplied : token.multi ? supplied.split(',') : [supplied], token);
            if (values.length !== token.keys.length || values.some((value, i) => value !== token.keys[i])) {
                const content = token.argument.content;
                patches.push({start: token.argument.start + 1, end: token.argument.end - 1, value: /^\s*/.exec(content)[0] + values.join(', ') + /\s*$/.exec(content)[0]});
            }
        }
        if (Object.prototype.hasOwnProperty.call(changes, 'options')) {
            if (!Array.isArray(changes.options)) throw new Error('可选注必须是文本数组');
            for (const option of changes.options) {
                if (typeof option !== 'string') throw new Error('可选注必须是文本');
                const parsed = group('[' + option + ']', 0, '[', ']');
                if (!parsed || parsed.end !== option.length + 2) throw new Error('可选注包含不匹配的括号');
            }
            const shared = Math.min(changes.options.length, token.options.length);
            for (let i = 0; i < shared; i++) if (changes.options[i] !== token.options[i].content) patches.push({start: token.options[i].start + 1, end: token.options[i].end - 1, value: changes.options[i]});
            for (let i = shared; i < token.options.length; i++) patches.push({start: token.options[i].start, end: token.options[i].end, value: ''});
            if (changes.options.length > shared) patches.push({start: token.argument.start, end: token.argument.start, value: changes.options.slice(shared).map(option => '[' + option + ']').join('')});
        }
        let result = source;
        for (const patch of patches.sort((a, b) => b.start - a.start)) result = result.slice(0, patch.start) + patch.value + result.slice(patch.end);
        return result;
    }

    global.VisualReferences = Object.freeze({describe, getChoices, rewrite});
})(globalThis);
