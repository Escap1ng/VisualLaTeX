/* Local MathLive adapter. Source attributes, never rendered DOM, are canonical. */
(function(root) {
    'use strict';
    const unsafe = /\\(?:href|url|html\w*|class|cssId|style|includegraphics)\b/i;
    function safe(source) { return typeof source === 'string' && !unsafe.test(source); }
    function groupEnd(source, start) {
        if (source[start] !== '{') return -1;
        let depth = 1;
        for (let i = start + 1; i < source.length; i++) {
            if (source[i] === '\\') { i++; continue; }
            if (source[i] === '%') { const end = source.indexOf('\n', i); if (end < 0) return -1; i = end; continue; }
            if (source[i] === '{') depth++;
            else if (source[i] === '}' && --depth === 0) return i + 1;
        }
        return -1;
    }
    function unwrap(source) {
        const opening = /^\s*\\begin\s*\{(aligned|gathered)\}/.exec(source);
        if (!opening) return source;
        const environment = opening[1];
        let depth = 1;
        for (let i = opening[0].length; i < source.length;) {
            if (source[i] === '%') { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end + 1; continue; }
            if (source[i] !== '\\') { i++; continue; }
            const token = /^\\(begin|end)\s*\{(aligned|gathered)\}/.exec(source.slice(i));
            if (!token || token[2] !== environment) { i += 2; continue; }
            if (token[1] === 'begin') depth++;
            else if (--depth === 0) return /^\s*$/.test(source.slice(i + token[0].length)) ? source.slice(opening[0].length, i) : source;
            i += token[0].length;
        }
        return source;
    }
    // Labels, explicit tags and comments are editorial metadata. Keep their
    // row association outside the mathfield, which normalizes mathematical LaTeX.
    function split(source) {
        const rows = [''], rawRows = [''], metadata = [], invalidMetadata = [];
        let depth = 0;
        let unmatchedBrace = false;
        const environments = [];
        for (let i = 0; i < source.length;) {
            const c = source[i];
            if (c === '%') {
                let end = source.indexOf('\n', i); if (end < 0) end = source.length;
                if (source[end-1] === '\r') end--;
                metadata.push({kind:'comment', raw:source.slice(i,end), row:rows.length-1, start:i, end});
                rawRows[rawRows.length-1] += source.slice(i,end);
                i = end; continue;
            }
            if (c === '\\') {
                const match = /^\\(label|tag)(\*)?\s*\{/.exec(source.slice(i));
                const argument = match ? i + match[0].length - 1 : -1;
                const end = match ? groupEnd(source, argument) : -1;
                if (match && end < 0) invalidMetadata.push(i);
                if (end >= 0) {
                    const raw = source.slice(i,end);
                    metadata.push({kind:match[1], raw, value:source.slice(argument+1,end-1), row:rows.length-1,
                        start:i, end, valueStart:argument+1, valueEnd:end-1});
                    rawRows[rawRows.length-1] += raw;
                    i = end; continue;
                }
                const environment = /^\\(begin|end)\s*\{([^{}]+)\}/.exec(source.slice(i));
                if (environment) {
                    if (environment[1] === 'begin') environments.push(environment[2]);
                    else if (environments[environments.length-1] === environment[2]) environments.pop();
                    rows[rows.length-1] += environment[0]; rawRows[rawRows.length-1] += environment[0];
                    i += environment[0].length; continue;
                }
                if (source[i+1] === '\\' && depth === 0 && environments.length === 0) {
                    rows.push(''); rawRows.push(''); i += 2; continue;
                }
                rows[rows.length-1] += source.slice(i,i+2); rawRows[rawRows.length-1] += source.slice(i,i+2); i += 2; continue;
            }
            if (c === '{') depth++;
            if (c === '}' && --depth < 0) unmatchedBrace = true;
            rows[rows.length-1] += c; rawRows[rawRows.length-1] += c; i++;
        }
        return {source, rows, rawRows, metadata, invalidMetadata, balanced:depth === 0 && !unmatchedBrace, clean:rows.join('\\\\')};
    }
    function validateValue(kind, value) {
        if (typeof value !== 'string' || /[{}\\%\u0000-\u001f\u007f]/.test(value) ||
            (kind === 'label' && /[\s\[\],#$&^~*]/.test(value))) throw new Error('标签不能包含空白、括号或 LaTeX 控制字符；编号可以包含空格。');
    }
    function combine(parts, edited, values = [], dirty = false) {
        const changes = parts.metadata.map((entry,i) => {
            if (entry.kind === 'comment') return entry.raw;
            const value = values[i] === undefined ? entry.value : values[i];
            if (value === entry.value) return entry.raw;
            validateValue(entry.kind,value);
            return value ? entry.raw.slice(0,entry.valueStart-entry.start)+value+entry.raw.slice(entry.valueEnd-entry.start) : '';
        });
        if (!dirty) {
            let result = parts.source;
            for (let i = parts.metadata.length-1; i >= 0; i--) {
                const entry = parts.metadata[i];
                result = result.slice(0,entry.start)+changes[i]+result.slice(entry.end);
            }
            return result;
        }
        if (parts.invalidMetadata.length || !parts.balanced) throw new Error('原公式有不匹配的括号，请先在高级输入中修正后再使用图形编辑。');
        // Only remove a wrapper introduced by mathValue/MathLive. A source-owned
        // aligned/gathered environment must remain part of the saved expression.
        function wrapperDepth(source) {
            let count = 0, body = source;
            while (unwrap(body) !== body) { body = unwrap(body); count++; }
            return count;
        }
        const body = wrapperDepth(edited) > wrapperDepth(parts.clean) ? unwrap(edited) : edited;
        if (body === parts.clean || edited === parts.clean) return combine(parts,edited,values,false);
        const clean = split(body);
        const rows = clean.rawRows.slice();
        if (clean.invalidMetadata.length || !clean.balanced) throw new Error('公式或标签包含不匹配的括号，请修正后保存。');
        clean.metadata.forEach(entry => {
            if (entry.kind === 'label') {
                if (!entry.value) throw new Error('公式标签不能为空。');
                validateValue('label',entry.value);
            }
        });
        parts.metadata.forEach((entry,i) => {
            if (!changes[i]) return;
            if (entry.row >= rows.length) throw new Error('被删除的公式行带有标签、编号或注释。请先清空标签和编号；注释可在高级输入中调整，再删除这一行。');
            const current = clean.metadata.filter(item => item.row === entry.row && item.kind === entry.kind);
            const value = values[i] === undefined ? entry.value : values[i];
            if (current.some(item => entry.kind === 'comment' ? item.raw === changes[i] : item.value === value)) return;
            if (entry.kind === 'tag' && current.length) {
                if (value !== entry.value) throw new Error('同一行的公式字段与编号输入包含不同编号，请统一后保存。');
                return;
            }
            const last = clean.metadata.filter(item => item.row === entry.row).at(-1);
            const endsInComment = last?.kind === 'comment' && rows[entry.row].endsWith(last.raw);
            rows[entry.row] += entry.kind === 'comment' ? '\n'+changes[i]+'\n' : (endsInComment ? '\n' : '')+changes[i];
        });
        return rows.join('\\\\');
    }
    function mathValue(parts, environment) {
        if (/^align/.test(environment || '')) return '\\begin{aligned}'+parts.clean+'\\end{aligned}';
        if (/^gather/.test(environment || '')) return '\\begin{gathered}'+parts.clean+'\\end{gathered}';
        return parts.clean;
    }
    function render(editor) {
        if (!editor || !root.customElements?.get('math-span')) return;
        editor.querySelectorAll('.formula-inline, .formula-block').forEach(node => {
            const source = node.getAttribute('data-formula') || '';
            const env = node.getAttribute('data-environment') || '';
            const fingerprint = JSON.stringify([source,env,node.classList.contains('formula-block')]);
            if (node._mathDisplay === fingerprint && node.querySelector('.visual-math-content')) return;
            node._mathDisplay = fingerprint;
            node.textContent = '';
            const view = document.createElement(safe(source) ? 'math-span' : 'span');
            view.className = 'visual-math-content';
            if (safe(source)) {
                view.setAttribute('mode', node.classList.contains('formula-block') ? 'displaystyle' : 'textstyle');
                view.textContent = mathValue(split(source),env);
            } else view.textContent = '含特殊排版指令的公式';
            node.appendChild(view);
            const labels = split(source).metadata.filter(item => item.kind !== 'comment');
            if (labels.length) {
                const badge = document.createElement('span'); badge.className = 'visual-math-label';
                badge.textContent = labels.map(item => (item.kind === 'label' ? '标签：' : '编号：')+item.value).join(' · ');
                node.appendChild(badge);
            }
            node.setAttribute('tabindex','0'); node.setAttribute('role','button');
            node.setAttribute('aria-label','编辑'+(node.classList.contains('formula-block') ? '行间' : '行内')+'公式'+(labels.length ? '，'+labels.map(item=>item.value).join('，') : ''));
            node.title = '点击编辑公式';
        });
    }
    let session = null;
    function open(source, node, focus = true) {
        const field = document.getElementById('formulaMathField');
        if (!field || !root.customElements?.get('math-field')) return false;
        const parts = split(source);
        session = {parts, dirty:false, values:[], field, node};
        const error = document.getElementById('formulaError'); error.textContent = '';
        field.readOnly = !safe(source);
        field.value = safe(source) ? mathValue(parts,node?.getAttribute('data-environment')) : '';
        if (/^(align|gather)/.test(node?.getAttribute('data-environment') || '')) field.position = Math.max(0,field.lastOffset-1);
        if (!safe(source)) error.textContent = '此公式包含网页排版指令，已保留原文。可在下方高级输入中修改。';
        const metadata = document.getElementById('formulaMetadata'); metadata.textContent = '';
        parts.metadata.forEach((entry,i) => {
            session.values[i] = entry.value;
            if (entry.kind === 'comment') return;
            const label = document.createElement('label');
            label.textContent = (entry.kind === 'label' ? '公式标签' : '显示编号')+(parts.rows.length > 1 ? '（第 '+(entry.row+1)+' 行）' : '');
            const input = document.createElement('input'); input.value = entry.value;
            input.setAttribute('aria-label',label.textContent);
            input.addEventListener('input',()=> { if(session) session.values[i]=input.value; });
            label.appendChild(input); metadata.appendChild(label);
        });
        if (focus) field.focus();
        return true;
    }
    function value() {
        if (!session) return document.getElementById('formulaInput').value;
        const {parts,field,values,dirty} = session;
        return combine(parts,field.value,values,dirty);
    }
    function initialize() {
        if (!root.MathfieldElement) return;
        root.MathfieldElement.fontsDirectory = './fonts';
        root.MathfieldElement.soundsDirectory = null;
        root.MathfieldElement.computeEngine = null;
        const field = document.getElementById('formulaMathField');
        field.mathVirtualKeyboardPolicy = 'manual'; field.keypressVibration = false;
        field.addEventListener('input',()=> {
            if (!session) return;
            session.dirty = true; session.advanced = false;
            try { document.getElementById('formulaInput').value = value(); } catch (_) { /* Commit reports row validation. */ }
        });
        document.getElementById('formulaInput').addEventListener('input',()=> {
            if (!session) return;
            const source=document.getElementById('formulaInput').value;
            open(source,session.node,false);
            session.advanced=true;
        });
        field.addEventListener('keydown',event=> {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault(); event.stopPropagation(); document.getElementById('btnInsertFormula').click();
            }
        });
    }
    root.VisualMath = {split,combine,safe,unwrap,mathValue,open,value,initialize,
        close(){session=null;}, insert(latex){
            if (!session || session.field.readOnly) return false;
            session.field.insert(latex.replace(/\{\}/g,'{#?}'),{selectionMode:'placeholder'}); session.dirty=true; session.advanced=false;
            session.field.focus(); return true;
        }};
    root.renderVisualMath = render;
    if (typeof module !== 'undefined') module.exports=root.VisualMath;
})(typeof globalThis !== 'undefined' ? globalThis : window);
