/* Visual-first LaTeX workspace with complete source access. Runs offline without a build. */
const WORKSPACE_KEY = 'visuallatex_workspace_v1';

// Embedded browsers may throw instead of showing native JavaScript dialogs.
// Queue the fallback so every request receives its own explicit answer.
let workspaceDialogQueue = Promise.resolve();
function workspaceDialog(kind, message, defaultValue = '') {
    try {
        const native = globalThis[kind];
        if (typeof native === 'function') {
            const answer = native.call(globalThis, message, defaultValue);
            if (kind === 'prompt' ? answer === null || typeof answer === 'string' : typeof answer === 'boolean') {
                return Promise.resolve(answer);
            }
        }
    } catch (_) { /* Use the accessible in-page dialog below. */ }
    const request = workspaceDialogQueue.then(() => new Promise(resolve => {
        const $ = id => document.getElementById(id);
        const overlay = $('workspaceDialog');
        const input = $('workspaceDialogInput');
        const accept = $('workspaceDialogAccept');
        const cancel = $('workspaceDialogCancel');
        const previousFocus = document.activeElement;
        const background = Array.from(document.body.childNodes).filter(node => node.nodeType === 1 && node !== overlay);
        const wasInert = background.map(node => node.getAttribute('inert') !== null);
        const asking = kind === 'prompt';
        $('workspaceDialogTitle').textContent = asking ? '输入内容' : '确认操作';
        $('workspaceDialogMessage').textContent = message;
        input.value = defaultValue;
        input.hidden = !asking;
        overlay.hidden = false;
        background.forEach(node => node.setAttribute('inert', ''));
        let finished = false;
        function finish(answer) {
            if (finished) return;
            finished = true;
            overlay.hidden = true;
            accept.removeEventListener('click', approve);
            cancel.removeEventListener('click', dismiss);
            overlay.removeEventListener('keydown', keyboard);
            background.forEach((node, index) => { if (!wasInert[index]) node.removeAttribute('inert'); });
            previousFocus?.focus();
            resolve(answer);
        }
        function approve() { finish(asking ? input.value : true); }
        function dismiss() { finish(asking ? null : false); }
        function keyboard(event) {
            // Do not let workspace shortcuts act behind an open modal.
            event.stopPropagation();
            if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
            else if (event.key === 'Enter' && event.target === input && !event.isComposing) {
                event.preventDefault(); approve();
            } else if (event.key === 'Tab') {
                const controls = asking ? [input, cancel, accept] : [cancel, accept];
                const current = controls.indexOf(document.activeElement);
                const next = (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
                event.preventDefault(); controls[next].focus();
            }
        }
        accept.addEventListener('click', approve);
        cancel.addEventListener('click', dismiss);
        overlay.addEventListener('keydown', keyboard);
        (asking ? input : cancel).focus();
        if (asking) input.select();
    }));
    workspaceDialogQueue = request.catch(() => {});
    return request;
}
function workspacePrompt(message, defaultValue = '') { return workspaceDialog('prompt', message, defaultValue); }
function workspaceConfirm(message) { return workspaceDialog('confirm', message); }

function workspaceTemplate(path) {
    if (/\.eps$/i.test(path)) return '%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 300 180\n%%EndComments\n/Helvetica findfont 18 scalefont setfont\n30 90 moveto (Hello, EPS) show\n%%EOF\n';
    if (/\.ps$/i.test(path)) return '%!PS-Adobe-3.0\n%%Title: Untitled\n%%Pages: 1\n%%BoundingBox: 0 0 595 842\n%%EndComments\n%%Page: 1 1\n/Helvetica findfont 24 scalefont setfont\n72 720 moveto (Hello, PostScript) show\nshowpage\n%%EOF\n';
    if (/\.bib$/i.test(path)) return '@article{example2026,\n  author = {Author, A.},\n  title = {An example reference},\n  journal = {Journal name},\n  year = {2026}\n}\n';
    if (/(^|\/)main\.(tex|latex|ltx)$/i.test(path)) return '\\documentclass{article}\n\\usepackage[UTF8]{ctex}\n\\usepackage{amsmath,graphicx}\n\n\\begin{document}\n\\section{开始写作}\\label{sec:start}\n直接在这里修改文字与标题，用工具栏调整格式或插入公式。需要时可切换到完整源码。\n\n参考文献示例：\\cite{example2026}。\n\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n';
    return '';
}

function defaultWorkspace() {
    return new ProjectModel({name: '我的排版项目', activePath: 'main.tex', mainPath: 'main.tex', files: [
        {path: 'main.tex', kind: 'text', text: workspaceTemplate('main.tex'), encoding: 'utf-8'},
        {path: 'references.bib', kind: 'text', text: workspaceTemplate('references.bib'), encoding: 'utf-8'},
        {path: 'drawing.ps', kind: 'text', text: workspaceTemplate('drawing.ps'), encoding: 'utf-8'}
    ]});
}

function workspaceBytes(file) {
    if (file.kind === 'binary') return Uint8Array.from(atob(file.base64), c => c.charCodeAt(0));
    if (file.encoding === 'latin1') {
        if (Array.from(file.text).some(c => c.charCodeAt(0) > 255)) throw new Error('Latin-1 文件含无法编码的字符，请先转换为 UTF-8。');
        return Uint8Array.from(file.text, c => c.charCodeAt(0));
    }
    return new TextEncoder().encode(file.text);
}

function workspaceFile(path, bytes) {
    const binaryFormat = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|woff2?|ttf|otf|zip|gz|7z|rar)$/i.test(path);
    const binaryEPS = bytes.length >= 4 && bytes[0] === 0xc5 && bytes[1] === 0xd0 && bytes[2] === 0xd3 && bytes[3] === 0xc6;
    if (!binaryFormat && !binaryEPS) {
        try {
            const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
            // Custom TeX packages and project support files may use arbitrary
            // extensions. Detect readable UTF-8 without restricting their names.
            if (!/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) return {path, kind: 'text', text, encoding: 'utf-8'};
        } catch (_) { /* PostScript commonly uses an 8-bit text encoding. */ }
        if (/\.(ps|eps)$/i.test(path) && !bytes.includes(0)) {
            let text = '';
            for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
            return {path, kind: 'text', text, encoding: 'latin1'};
        }
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return {path, kind: 'binary', base64: btoa(binary)};
}

// Locate the clicked protected token within its own source unit, not the first
// identical citation elsewhere in the document. Offsets match textarea newlines.
function locateWorkspaceToken(editor, target, source) {
    const normalize = text => text.replace(/\r\n?/g, '\n');
    const parts = splitTexDocument(source);
    if (!parts) return -1;
    const body = normalize(parts.body);
    const prefix = normalize(parts.preamble + parts.open).length;
    function inside(node, text) {
        if (node === target) return 0;
        let cursor = 0;
        for (const child of node.childNodes || []) {
            const rendered = normalize(convertNodeToLatex(child));
            const index = text.indexOf(rendered, cursor);
            if (index < 0) continue;
            if (child === target || (child.contains && child.contains(target))) {
                const nested = inside(child, rendered);
                return nested < 0 ? -1 : index + nested;
            }
            cursor = index + rendered.length;
        }
        return -1;
    }
    let cursor = 0;
    for (const root of editor.childNodes) {
        const rendered = normalize(convertNodeToLatex(root));
        const index = body.indexOf(rendered, cursor);
        if (index < 0) continue;
        if (root === target || (root.contains && root.contains(target))) {
            const nested = inside(root, rendered);
            return nested < 0 ? prefix + index : prefix + index + nested;
        }
        cursor = index + rendered.length;
    }
    return -1;
}

class WorkspaceController {
    constructor({model, ui, core, storage, notify = () => {}}) {
        this.model = model;
        this.ui = ui;
        this.core = core;
        this.storage = storage;
        this.notify = notify;
        this.mode = null;
        this.modePreferences = new Map();
        this.loading = false;
        this.recoveryBlocked = false;
        this.onChange = () => {};
    }
    sourceValue(value, original) {
        const normalize = text => text.replace(/\r\n?/g, '\n');
        if (normalize(value) === normalize(original)) return original;
        return original.includes('\r\n') && !/(^|[^\r])\n/.test(original) ? value.replace(/\r?\n/g, '\r\n') : value;
    }
    sync(group = false) {
        if (this.loading || !this.mode) return;
        const file = this.model.get();
        if (!file || file.kind !== 'text') return;
        const text = this.mode === 'visual' ? this.core.exportVisual() : this.sourceValue(this.ui.sourceArea.value, file.text);
        if (text !== file.text) this.model.update(text, {group});
    }
    show() {
        const file = this.model.get();
        this.visualError = null;
        this.loading = true;
        try {
            this.ui.sourceArea.value = file && file.kind === 'text' ? file.text : '';
            this.mode ||= this.preferredMode();
            if (this.mode === 'visual') {
                if (this.supportsVisual(file)) this.core.loadVisual(file.text, file.path);
                else this.mode = 'source';
            }
        } catch (error) {
            // The canonical file remains intact if its visual conversion fails.
            this.mode = 'source';
            this.visualError = '可视化加载失败，已保留完整源码：' + error.message;
            this.notify(this.visualError);
        } finally { this.loading = false; }
        this.onChange();
    }
    supportsVisual(file = this.model.get()) {
        return Boolean(file && file.kind === 'text' && /\.(tex|latex|ltx)$/i.test(file.path) && this.core.canVisual(file.text));
    }
    preferredMode() {
        const file = this.model.get();
        return this.supportsVisual(file) && this.modePreferences.get(file.path) !== 'source' ? 'visual' : 'source';
    }
    openCurrent() {
        // Load the newly selected file before any sync/export can read the old
        // visual DOM into it. This also handles the first file of an empty project.
        this.mode = null;
        this.show();
        const file = this.model.get();
        if (file?.kind === 'text' && /\.(tex|latex|ltx)$/i.test(file.path) && !this.supportsVisual(file)) {
            this.notify('当前 LaTeX 文件缺少完整的 document 环境，已使用源码编辑；内容保持原样。');
        }
    }
    switchFile(path) {
        this.sync();
        if (!this.model.get(path)) throw new Error('文件不存在');
        this.model.activePath = path;
        this.openCurrent();
        this.persist();
    }
    setMode(mode, {remember = true} = {}) {
        if (mode === this.mode) {
            if (remember && this.model.get()) this.modePreferences.set(this.model.activePath, mode);
            return true;
        }
        this.sync();
        const file = this.model.get();
        if (mode === 'visual') {
            if (!this.supportsVisual(file)) {
                this.notify('此文件请使用源码编辑。可视化模式需要完整的 LaTeX document 环境。');
                return false;
            }
        }
        this.mode = mode;
        if (remember && file) this.modePreferences.set(file.path, mode);
        this.show();
        return this.mode === mode;
    }
    changed(group = true) {
        if (this.loading) return;
        this.sync(group);
        this.onChange();
    }
    history(direction) {
        this.sync();
        const changed = this.model[direction]();
        if (!changed) return;
        this.show();
        this.persist();
    }
    persist() {
        if (this.loading) return true;
        if (this.recoveryBlocked) { this.notify('旧项目恢复失败，已暂停覆盖。请先导出当前项目，或新建/导入项目。'); return false; }
        try {
            this.sync();
            this.storage.setItem(WORKSPACE_KEY, this.model.serialize());
            if (this.ui.saveState) this.ui.saveState.textContent = '已保存到本机';
            return true;
        } catch (error) {
            if (this.ui.saveState) this.ui.saveState.textContent = '保存失败，请导出备份';
            this.notify('保存失败：' + error.message);
            return false;
        }
    }
    replaceProject(model) {
        this.model = model;
        this.modePreferences.clear();
        this.recoveryBlocked = false;
        this.openCurrent();
        this.persist();
    }
    exportEntries() {
        this.sync();
        return this.model.list().map(file => ({path: file.path, bytes: workspaceBytes(file)}));
    }
    exportComment() {
        // ZIP comments keep project settings out of the user's file namespace.
        return JSON.stringify({format: 'visual-workspace', version: 1, name: this.model.name,
            mainPath: this.model.mainPath, activePath: this.model.activePath});
    }
}

function initWorkspace() {
    const $ = id => document.getElementById(id);
    const ui = {sourceArea: $('sourceArea'), saveState: $('saveState')};
    const core = {exportVisual: domToLatex, loadVisual: applyImportedTex, canVisual: text => Boolean(splitTexDocument(text))};
    const notify = message => { $('statusText').textContent = message; };
    let model;
    let storage;
    let blocked = false;
    try {
        storage = globalThis.localStorage;
        const saved = storage.getItem(WORKSPACE_KEY);
        if (saved !== null) model = ProjectModel.deserialize(saved);
        else if (localStorage.getItem('visuellatex_document') !== null || localStorage.getItem('visuellatex_draft') !== null) {
            loadDraft();
            if (draftRecoveryFailed) throw new Error('单文档草稿无法恢复');
            const path = importedFileName || 'main.tex';
            model = new ProjectModel({name: '恢复的项目', activePath: path, mainPath: path, files: [{path, kind: 'text', text: core.exportVisual(), encoding: 'utf-8'}]});
        } else model = defaultWorkspace();
    } catch (error) { model = defaultWorkspace(); blocked = true; notify('项目恢复失败，原数据已保留：' + error.message); }
    // Storage can be unavailable in a restricted browser context. Keep editing
    // and ZIP downloads usable even when reading the storage accessor throws.
    storage ||= {setItem() { throw new Error('当前浏览器不允许本机存储，请导出项目备份'); }};
    const app = new WorkspaceController({model, ui, core, storage, notify});
    globalThis.visualWorkspace = app;
    app.recoveryBlocked = blocked;
    let saveTimer;
    let panelTimer;
    let renderedProject = app.model;
    const safely = action => async event => {
        try { await action(event); }
        catch (error) { notify(error.message); }
    };
    const bind = (id, action) => { if ($(id)) $(id).addEventListener('click', safely(action)); };
    const scheduleSave = () => {
        if (ui.saveState) ui.saveState.textContent = '待保存';
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => app.persist(), 350);
    };
    // Existing visual tools call these hooks after DOM mutations.
    updatePreview = function() { if (!app.loading) { app.changed(false); scheduleSave(); } };
    saveDraft = function() { return !app.loading && app.persist(); };
    initFormulaModal();
    editorArea.addEventListener('mouseup', saveEditorSelection);
    editorArea.addEventListener('keyup', saveEditorSelection);
    editorArea.addEventListener('input', safely(() => { app.changed(true); scheduleSave(); }));
    ui.sourceArea.addEventListener('input', safely(() => { app.changed(true); scheduleSave(); }));
    ui.sourceArea.addEventListener('scroll', () => { $('lineNumbers').scrollTop = ui.sourceArea.scrollTop; });

    function position() {
        const before = ui.sourceArea.value.slice(0, ui.sourceArea.selectionStart);
        const line = before.split('\n').length;
        const column = before.length - before.lastIndexOf('\n');
        $('positionInfo').textContent = '行 ' + line + '，列 ' + column;
    }
    ui.sourceArea.addEventListener('click', position);
    ui.sourceArea.addEventListener('keyup', position);

    function button(text, action, className = '') {
        const node = document.createElement('button');
        node.type = 'button'; node.textContent = text; node.className = className;
        node.addEventListener('click', safely(action));
        return node;
    }
    function jump(path, offset = null, length = 0) {
        app.switchFile(path);
        savedSelection = null;
        if (offset !== null) app.setMode('source', {remember: false});
        app.revealEditor?.();
        if (app.mode === 'visual') editorArea.focus();
        else if (app.model.get()?.kind === 'text') {
            const text = app.model.get().text;
            const start = text.slice(0, offset || 0).replace(/\r\n?/g, '\n').length;
            ui.sourceArea.focus(); ui.sourceArea.setSelectionRange(start, start + length);
            const line = ui.sourceArea.value.slice(0, start).split('\n').length;
            ui.sourceArea.scrollTop = Math.max(0, (line - 4) * 23);
            position();
        }
        document.body.classList.remove('files-open', 'outline-open');
        $('btnFiles').setAttribute('aria-expanded', 'false');
        $('btnOutline').setAttribute('aria-expanded', 'false');
    }
    function panels() {
        $('fileTree').replaceChildren();
        for (const file of app.model.list()) {
            const prefix = file.path === app.model.mainPath ? '★ ' : '';
            const item = button(prefix + file.path, () => jump(file.path), 'file-item' + (file.path === app.model.activePath ? ' active' : ''));
            item.title = file.kind === 'binary' ? '二进制资源，导出时保留原始字节' : ProjectModel.language(file.path);
            $('fileTree').appendChild(item);
        }
        $('outlineList').replaceChildren();
        const file = app.model.get();
        if (file && file.kind === 'text') {
            const pattern = ProjectModel.language(file.path) === 'postscript' ? /^(?:%%(?:Page|Title):\s*(.+)|\/([\w.-]+)\s*\{)/gm : /\\(?:section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\{([^}\n]+)\}/g;
            for (const match of file.text.matchAll(pattern)) $('outlineList').appendChild(button(match[1] || match[2], () => jump(file.path, match.index), 'outline-item'));
        }
        if (!$('outlineList').childNodes.length) $('outlineList').textContent = '当前文件没有章节或 PostScript 页面标记。';
        $('referenceList').replaceChildren();
        const refs = app.model.references();
        for (const item of [...refs.labels, ...refs.bibliography, ...refs.citations, ...(refs.references || [])]) {
            $('referenceList').appendChild(button(item.key + ' · ' + item.path, () => jump(item.path, item.offset), 'reference-item'));
        }
        if (!$('referenceList').childNodes.length) $('referenceList').textContent = '添加 \\label 或 BibTeX 条目后，可在这里定位。';
    }
    function render() {
        const file = app.model.get();
        const text = file && file.kind === 'text';
        const language = file ? ProjectModel.language(file.path) : 'text';
        $('currentPath').textContent = file ? file.path : '选择或新建文件';
        $('languageBadge').textContent = file && file.kind === 'binary' ? '资源' : {latex: 'LaTeX', bibtex: 'BibTeX', postscript: 'PostScript', text: '文本'}[language];
        // An editor render can happen before a name input loses focus and emits
        // change. Preserve its in-progress text and selection until that commit.
        if (document.activeElement !== $('projectName') || renderedProject !== app.model) $('projectName').value = app.model.name;
        renderedProject = app.model;
        $('sourcePanel').hidden = !text || app.mode !== 'source';
        $('visualPanel').hidden = !text || app.mode !== 'visual';
        $('assetPanel').hidden = Boolean(text);
        $('assetMessage').textContent = file ? '二进制或非文本资源。项目导出会保留原始字节，可下载当前文件。' : '从左侧导入文件，或新建 .tex、.bib、.ps、.eps 文件。';
        $('modeSource').classList.toggle('active', app.mode === 'source');
        $('modeVisual').classList.toggle('active', app.mode === 'visual');
        $('modeSource').setAttribute('aria-pressed', String(app.mode === 'source'));
        $('modeVisual').setAttribute('aria-pressed', String(app.mode === 'visual'));
        $('modeVisual').disabled = !text || !/\.(tex|latex|ltx)$/i.test(file.path);
        $('modeVisual').title = app.supportsVisual(file) ? '直接修改文档文字、标题和公式'
            : text && /\.(tex|latex|ltx)$/i.test(file.path)
                ? '当前文件缺少完整的 document 环境，请使用源码编辑'
                : '此文件使用源码编辑；完整 LaTeX 文档支持可视化';
        $('btnUndo').disabled = !text || !app.model.canUndo();
        $('btnRedo').disabled = !text || !app.model.canRedo();
        for (const id of ['btnH1','btnH2','btnH3','btnBold','btnItalic','btnCenter','btnUl','btnOl','btnInlineFormula','btnBlockFormula','btnImage','btnInsertCitation','btnInsertReference','btnInsertLabel']) $(id).disabled = !text || language !== 'latex';
        for (const id of ['btnCopy','btnFind']) $(id).disabled = !text;
        for (const id of ['renameFile','deleteFile','btnDownload']) $(id).disabled = !file;
        $('setMainFile').disabled = !text;
        if ($('btnEncoding')) {
            $('btnEncoding').disabled = !text;
            $('btnEncoding').textContent = text ? file.encoding.toUpperCase() : '二进制';
        }
        const count = (ui.sourceArea.value.match(/\n/g) || []).length + 1;
        $('lineNumbers').textContent = Array.from({length: count}, (_, i) => i + 1).join('\n');
        position();
        clearTimeout(panelTimer); panelTimer = setTimeout(panels, 180);
    }
    app.onChange = render;
    function sourceEdit(replacement, start = ui.sourceArea.selectionStart, end = ui.sourceArea.selectionEnd) {
        if (!app.setMode('source', {remember: false})) return;
        const file = app.model.get();
        if (!file || file.kind !== 'text') throw new Error('请先选择文本文件');
        const value = ui.sourceArea.value;
        ui.sourceArea.value = value.slice(0, start) + replacement + value.slice(end);
        ui.sourceArea.setSelectionRange(start + replacement.length, start + replacement.length);
        app.changed(false); app.persist(); ui.sourceArea.focus(); position();
    }
    function wrap(before, after) {
        app.setMode('source', {remember: false});
        const start = ui.sourceArea.selectionStart;
        const selected = ui.sourceArea.value.slice(start, ui.sourceArea.selectionEnd);
        sourceEdit(before + selected + after);
        if (!selected) ui.sourceArea.setSelectionRange(start + before.length, start + before.length);
    }
    bind('modeSource', () => app.setMode('source'));
    bind('modeVisual', () => app.setMode('visual'));
    bind('btnUndo', () => app.history('undo'));
    bind('btnRedo', () => app.history('redo'));
    bind('btnFiles', () => $('btnFiles').setAttribute('aria-expanded', String(document.body.classList.toggle('files-open'))));
    bind('btnOutline', () => $('btnOutline').setAttribute('aria-expanded', String(document.body.classList.toggle('outline-open'))));
    bind('btnEncoding', async () => {
        const file = app.model.get(); if (!file || file.kind !== 'text') return;
        const encoding = await workspacePrompt('文件编码：utf-8 或 latin1（转换会影响导出的字节编码）', file.encoding);
        if (!encoding || encoding === file.encoding) return;
        if (file.encoding !== 'latin1') app.sync();
        app.model.setEncoding(file.path, encoding.trim().toLowerCase());
        app.changed(false); app.persist();
    });
    function updateProjectName() { app.model.name = $('projectName').value.trim() || '未命名项目'; }
    $('projectName').addEventListener('input', safely(() => { updateProjectName(); scheduleSave(); }));
    $('projectName').addEventListener('change', safely(() => {
        updateProjectName(); $('projectName').value = app.model.name; app.persist();
    }));

    for (const [id, visual, before, after] of [
        ['btnH1', () => insertHeading(1), '\\section{', '}'], ['btnH2', () => insertHeading(2), '\\subsection{', '}'],
        ['btnH3', () => insertHeading(3), '\\subsubsection{', '}'], ['btnBold', toggleBold, '\\textbf{', '}'],
        ['btnItalic', toggleItalic, '\\textit{', '}'], ['btnCenter', toggleCenter, '\\begin{center}\n', '\n\\end{center}'],
        ['btnUl', insertUnorderedList, '\\begin{itemize}\n  \\item ', '\n\\end{itemize}'],
        ['btnOl', insertOrderedList, '\\begin{enumerate}\n  \\item ', '\n\\end{enumerate}'],
        ['btnInlineFormula', insertInlineFormula, '$', '$'], ['btnBlockFormula', insertBlockFormula, '\\[\n', '\n\\]']
    ]) bind(id, () => { if (app.mode === 'visual') visual(); else wrap(before, after); });
    bind('btnImage', async () => {
        if (app.mode === 'visual') {
            saveEditorSelection();
            const imagePath = await workspacePrompt('请输入图片路径（LaTeX 中使用的路径）：', 'example-image.png');
            if (!imagePath) return;
            const caption = await workspacePrompt('请输入图片标题：', '图片标题');
            if (caption === null) return;
            const label = await workspacePrompt('请输入图片标签（用于引用）：', 'fig:example');
            if (label !== null) insertImage({imagePath, caption, label});
            return;
        }
        const path = await workspacePrompt('图片路径（相对于主文件）', 'figures/example.eps');
        if (path) sourceEdit('\\includegraphics[width=0.6\\textwidth]{' + path + '}');
    });
    editorArea.addEventListener('dblclick', safely(event => {
        const token = event.target.closest && event.target.closest('.tex-cmd');
        if (!token) return;
        app.sync();
        const source = convertNodeToLatex(token).replace(/\r\n?/g, '\n');
        const offset = locateWorkspaceToken(editorArea, token, app.model.get().text);
        app.setMode('source', {remember: false});
        ui.sourceArea.focus();
        if (offset >= 0) ui.sourceArea.setSelectionRange(offset, offset + source.length);
        position();
        notify(offset >= 0 ? '已定位到完整源码，可直接修改该命令。' : '已打开完整源码，可使用查找定位该命令。');
    }));

    async function insertReference(kind) {
        app.setMode('source', {remember: false});
        const refs = app.model.references();
        const first = kind === 'cite' ? refs.bibliography[0] : refs.labels[0];
        const key = await workspacePrompt(kind === 'cite' ? '文献键，可用逗号分隔多个键' : '标签名称', first ? first.key : kind === 'label' ? 'sec:new' : '');
        if (key) sourceEdit('\\' + kind + '{' + key + '}');
    }
    bind('btnInsertCitation', () => insertReference('cite'));
    bind('btnInsertReference', () => insertReference('ref'));
    bind('btnInsertLabel', () => insertReference('label'));
    bind('btnAddBibEntry', async () => {
        app.sync();
        const key = await workspacePrompt('新文献的 BibTeX 键', 'reference2026');
        if (!key) return;
        if (!/^[^\s{},=]+$/.test(key)) throw new Error('文献键不能包含空白、花括号、逗号或等号');
        if (app.model.references().bibliography.some(item => item.key === key)) throw new Error('该文献键已存在');
        let file = app.model.get();
        if (!file || !/\.bib$/i.test(file.path)) file = app.model.list().find(item => /\.bib$/i.test(item.path));
        if (!file) file = app.model.add({path: 'references.bib', kind: 'text', text: '', encoding: 'utf-8'});
        app.switchFile(file.path);
        const end = ui.sourceArea.value.length;
        sourceEdit('\n@article{' + key + ',\n  author = {},\n  title = {},\n  journal = {},\n  year = {}\n}\n', end, end);
    });

    bind('newFile', async () => {
        app.sync();
        const path = await workspacePrompt('文件路径，例如 sections/method.tex、references.bib 或 drawing.ps', 'untitled.tex');
        if (!path) return;
        const file = app.model.add({path, kind: 'text', text: workspaceTemplate(path), encoding: 'utf-8'});
        // add() selects the first file in an empty project. Do not sync the old
        // empty editor into that newly created template.
        app.model.activePath = file.path; app.openCurrent(); app.persist();
    });
    bind('renameFile', async () => {
        app.sync();
        const file = app.model.get(); if (!file) return;
        const path = await workspacePrompt('新的文件路径（已有源码中的路径引用不会自动更名）', file.path);
        if (path && path !== file.path) {
            const preference = app.modePreferences.get(file.path);
            const renamed = app.model.rename(file.path, path);
            app.modePreferences.delete(file.path);
            if (preference) app.modePreferences.set(renamed.path, preference);
            app.openCurrent(); app.persist();
        }
    });
    bind('deleteFile', async () => {
        const file = app.model.get(); if (!file || !await workspaceConfirm('删除项目文件 ' + file.path + '？请先导出需要保留的内容。')) return;
        app.model.remove(file.path); app.modePreferences.delete(file.path); app.openCurrent(); app.persist();
    });
    bind('setMainFile', () => { app.sync(); app.model.mainPath = app.model.activePath; app.persist(); panels(); notify('已设为项目主文件'); });
    bind('btnNewProject', async () => { if (await workspaceConfirm('新建项目会替换本机当前草稿，请先导出备份。继续？')) app.replaceProject(defaultWorkspace()); });

    function download(bytes, name, type = 'application/octet-stream') {
        const url = URL.createObjectURL(new Blob([bytes], {type}));
        const a = document.createElement('a'); a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    bind('btnDownload', () => { app.sync(); const file = app.model.get(); if (file) download(workspaceBytes(file), file.path.split('/').pop()); });
    bind('btnExportProject', () => {
        const bytes = ProjectArchive.writeZip(app.exportEntries(), {comment: app.exportComment()});
        download(bytes, (app.model.name || 'project').replace(/[\\/:*?"<>|]/g, '_') + '.zip', 'application/zip');
        notify('项目 ZIP 已导出，包含所有源码和资源文件');
    });
    bind('btnCopy', async () => {
        app.sync(); const file = app.model.get(); if (!file || file.kind !== 'text') return;
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(file.text);
        else {
            app.setMode('source', {remember: false}); ui.sourceArea.select();
            if (!document.execCommand('copy')) throw new Error('浏览器禁止自动复制，请按 Ctrl+C');
        }
        notify('当前文件源码已复制');
    });

    function uniquePath(path, names) {
        let candidate = path; let count = 2;
        const dot = path.lastIndexOf('.'); const slash = path.lastIndexOf('/');
        const stem = dot > slash ? path.slice(0, dot) : path;
        const ext = dot > slash ? path.slice(dot) : '';
        while (names.has(candidate.normalize('NFC').toLowerCase())) candidate = stem + '_' + count++ + ext;
        names.add(candidate.normalize('NFC').toLowerCase());
        return candidate;
    }
    bind('btnImportFiles', () => { $('importFiles').value = ''; $('importFiles').click(); });
    bind('btnImportFolder', () => { $('importFolder').value = ''; $('importFolder').click(); });
    bind('btnImportProject', () => { $('importProject').value = ''; $('importProject').click(); });
    async function readFiles(files, folder) {
        if (files.length > ProjectModel.MAX_FILES || files.reduce((sum, file) => sum + file.size, 0) > ProjectModel.MAX_TOTAL_BYTES) throw new Error('项目最多 500 个文件、50 MB');
        const entries = [];
        for (const file of files) {
            const path = folder ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
            entries.push(workspaceFile(path, new Uint8Array(await file.arrayBuffer())));
        }
        return entries;
    }
    $('importFiles').addEventListener('change', safely(async event => {
        app.sync();
        const entries = await readFiles(Array.from(event.target.files), false);
        // Reading files is asynchronous: retain any edits made while waiting.
        // addMany validates the full batch atomically and preserves undo history.
        app.sync();
        const names = new Set(app.model.list().map(file => file.path.normalize('NFC').toLowerCase()));
        const added = app.model.addMany(entries.map(file => ({...file, path: uniquePath(file.path, names)})));
        if (added.length) {
            app.model.activePath = added.at(-1).path; app.openCurrent(); app.persist();
        }
        notify('已导入 ' + entries.length + ' 个文件；重名文件已自动另存');
    }));
    $('importFolder').addEventListener('change', safely(async event => {
        const files = Array.from(event.target.files); if (!files.length) return;
        const entries = await readFiles(files, true);
        const main = entries.find(file => file.kind === 'text' && file.path === 'main.tex') || entries.find(file => file.kind === 'text' && /\.(tex|ps|eps)$/i.test(file.path)) || entries.find(file => file.kind === 'text');
        const first = main || entries[0];
        const candidate = new ProjectModel({name: files[0].webkitRelativePath.split('/')[0], files: entries, activePath: first.path, mainPath: main ? main.path : null});
        if (await workspaceConfirm('用这个文件夹替换当前项目？请确认已导出需要保留的内容。')) app.replaceProject(candidate);
    }));
    $('importProject').addEventListener('change', safely(async event => {
        const file = event.target.files[0]; if (!file) return;
        if (file.size > ProjectArchive.MAX_ARCHIVE_BYTES) throw new Error('项目包超过 100 MB（展开后的文件总计最多 50 MB）');
        let candidate;
        if (/\.(json|vlproj)$/i.test(file.name)) candidate = ProjectModel.deserialize(await file.text());
        else {
            const archive = await ProjectArchive.readZip(new Uint8Array(await file.arrayBuffer()), {includeComment: true});
            let metadata = null;
            try {
                const value = JSON.parse(archive.comment);
                if (value && value.format === 'visual-workspace' && value.version === 1 &&
                    typeof value.name === 'string' && value.name.trim() && value.name.length <= 200) metadata = value;
            } catch (_) { /* ZIP comments from other tools are not project metadata. */ }
            const files = archive.files.map(entry => workspaceFile(entry.path, entry.bytes));
            const main = files.find(item => item.kind === 'text' && item.path === 'main.tex') || files.find(item => item.kind === 'text' && /\.(tex|ps|eps)$/i.test(item.path)) || files.find(item => item.kind === 'text');
            const first = main || files[0];
            candidate = new ProjectModel({name: metadata ? metadata.name : file.name.replace(/\.zip$/i, ''), files,
                activePath: metadata && files.some(item => item.path === metadata.activePath) ? metadata.activePath : first && first.path,
                mainPath: metadata && files.some(item => item.kind === 'text' && item.path === metadata.mainPath) ? metadata.mainPath : main ? main.path : null});
        }
        if (await workspaceConfirm('用导入的项目替换当前项目？请确认已导出需要保留的内容。')) app.replaceProject(candidate);
    }));

    function literalFindPattern(query) {
        return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $('findCase').checked ? 'g' : 'gi');
    }
    function findNext() {
        app.setMode('source', {remember: false});
        const needle = $('findText').value; if (!needle) return -1;
        const value = ui.sourceArea.value;
        const pattern = literalFindPattern(needle);
        pattern.lastIndex = ui.sourceArea.selectionEnd;
        let match = pattern.exec(value);
        if (!match) { pattern.lastIndex = 0; match = pattern.exec(value); }
        const index = match ? match.index : -1;
        $('findStatus').textContent = index < 0 ? '未找到' : '已找到匹配';
        if (match) { ui.sourceArea.focus(); ui.sourceArea.setSelectionRange(index, index + match[0].length); position(); }
        return index;
    }
    bind('btnFind', () => { app.setMode('source', {remember: false}); $('findPanel').hidden = false; $('findText').focus(); });
    bind('btnCloseFind', () => { $('findPanel').hidden = true; ui.sourceArea.focus(); });
    bind('btnFindNext', findNext);
    bind('btnReplace', () => {
        app.setMode('source', {remember: false});
        const query = $('findText').value; if (!query) return;
        const selected = ui.sourceArea.value.slice(ui.sourceArea.selectionStart, ui.sourceArea.selectionEnd);
        const match = literalFindPattern(query).exec(selected);
        const matches = match && match.index === 0 && match[0].length === selected.length;
        if (matches || findNext() >= 0) sourceEdit($('replaceText').value);
    });
    bind('btnReplaceAll', () => {
        app.setMode('source', {remember: false});
        const query = $('findText').value; if (!query) return;
        const value = ui.sourceArea.value;
        const replacement = $('replaceText').value;
        let count = 0;
        // Match the original source so Unicode case folding cannot shift offsets.
        // A callback keeps replacement tokens such as $& literal.
        const result = value.replace(literalFindPattern(query), () => { count++; return replacement; });
        if (count) sourceEdit(result, 0, value.length);
        $('findStatus').textContent = '已替换 ' + count + ' 处';
    });
    document.addEventListener('keydown', safely(event => {
        if (!(event.ctrlKey || event.metaKey)) return;
        if (event.key.toLowerCase() === 's') { event.preventDefault(); app.persist(); return; }
        const editing = event.target === ui.sourceArea || editorArea.contains(event.target);
        if (!editing) return;
        if (event.key.toLowerCase() === 'f') { event.preventDefault(); $('btnFind').click(); }
        if (event.key.toLowerCase() === 'z') { event.preventDefault(); app.history(event.shiftKey ? 'redo' : 'undo'); }
        if (event.key.toLowerCase() === 'y') { event.preventDefault(); app.history('redo'); }
        if (event.key.toLowerCase() === 'a' && app.mode === 'source') { /* native selection */ }
    }));
    ui.sourceArea.addEventListener('keydown', safely(event => {
        if (event.key === 'Tab') { event.preventDefault(); sourceEdit('  '); }
    }));
    window.addEventListener('pagehide', () => { clearTimeout(saveTimer); app.persist(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') app.persist(); });
    app.show(); panels();
    if (!blocked && !app.visualError) notify(app.mode === 'visual'
        ? '直接在文档中修改文字、标题和公式；需要时可切换完整源码。'
        : /\.(tex|latex|ltx)$/i.test(app.model.activePath || '')
            ? '当前 LaTeX 文件缺少完整的 document 环境，已使用源码编辑；内容保持原样。'
            : '当前文件使用源码编辑；完整 LaTeX 文档默认以可视化方式打开。');
    if (typeof initCompilation === 'function') initCompilation(app);
}
