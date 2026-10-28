/**
 * VisualLaTeX 主逻辑
 * 编辑器核心 + .tex 导入 + DOM 转 LaTeX 转换
 * 定位：导入 .tex 文件 -> 可视化轻量修改 -> 导出，全程离线
 */

// 全局变量
let editorArea = null;
let previewArea = null;
let statusText = null;
let debounceTimer = null;
let texPreamble = null;      // 导入文件的导言区（原样保留，导出时复用）
let texTail = '';            // \end{document} 之后的尾部内容（原样保留）
let texDocumentOpen = '\\begin{document}';
let texDocumentClose = '\\end{document}';
let importedFileName = null; // 导入的文件名（用于导出命名）
let savedSelection = null;   // 保存编辑器选区（用于公式弹窗等场景）
let draftRecoveryFailed = false;
let suppressDraftSave = false;

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    editorArea = document.getElementById('editorArea');
    previewArea = document.getElementById('previewArea');
    statusText = document.getElementById('statusText');

    // 完整工作区使用独立的多文件状态；单文件核心仍可单独加载和测试。
    if (typeof initWorkspace === 'function') {
        initWorkspace();
        return;
    }

    // 绑定工具栏按钮事件
    initToolbar();

    // 窄屏下的编辑区/代码预览切换
    initPanelTabs();

    // 初始化公式输入弹窗
    initFormulaModal();

    // 从 localStorage 恢复草稿（含导言区/尾部/文件名）
    loadDraft();

    // 监听编辑器变化，实时更新 LaTeX 并保存草稿
    editorArea.addEventListener('input', function() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function() {
            updatePreview();
            saveDraft();
        }, 300);
    });

    // 在刷新/切换页面前补存尚未经过防抖计时器的输入。
    window.addEventListener('pagehide', flushDraft);
    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'hidden') flushDraft();
    });

    // 初始更新预览
    updatePreview();

    // 保存编辑器选区
    editorArea.addEventListener('mouseup', saveEditorSelection);
    editorArea.addEventListener('keyup', saveEditorSelection);
});

// 保存编辑器选区
function saveEditorSelection() {
    const sel = window.getSelection();
    if (sel.rangeCount > 0 && editorArea.contains(sel.anchorNode)) {
        savedSelection = sel.getRangeAt(0).cloneRange();
    }
}

// 初始化工具栏
function initToolbar() {
    // 标题按钮
    document.getElementById('btnH1').addEventListener('click', () => insertHeading(1));
    document.getElementById('btnH2').addEventListener('click', () => insertHeading(2));
    document.getElementById('btnH3').addEventListener('click', () => insertHeading(3));

    // 格式按钮
    document.getElementById('btnBold').addEventListener('click', toggleBold);
    document.getElementById('btnItalic').addEventListener('click', toggleItalic);
    document.getElementById('btnCenter').addEventListener('click', toggleCenter);

    // 列表按钮
    document.getElementById('btnUl').addEventListener('click', insertUnorderedList);
    document.getElementById('btnOl').addEventListener('click', insertOrderedList);

    // 公式按钮
    document.getElementById('btnInlineFormula').addEventListener('click', insertInlineFormula);
    document.getElementById('btnBlockFormula').addEventListener('click', insertBlockFormula);

    // 图片按钮
    document.getElementById('btnImage').addEventListener('click', insertImage);

    // 导入 .tex 文件
    document.getElementById('btnImport').addEventListener('click', function() {
        const input = document.getElementById('texFileInput');
        input.value = '';
        input.click();
    });
    document.getElementById('texFileInput').addEventListener('change', function() {
        const file = this.files && this.files[0];
        if (!file) return;
        if (!confirm('导入将覆盖当前编辑内容，是否继续？')) {
            this.value = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = function(e) {
            let text;
            try {
                text = decodeTexFile(e.target.result);
            } catch (error) {
                alert('导入失败：请使用 UTF-8 编码且不含空字节的文本文件；当前内容未被替换。');
                return;
            }
            applyImportedTex(text, file.name);
        };
        reader.onerror = function() {
            alert('读取文件失败，请重试');
        };
        reader.readAsArrayBuffer(file);
    });

    // 开始和重新加载按钮
    document.getElementById('btnStart').addEventListener('click', startNewDocument);
    document.getElementById('btnReload').addEventListener('click', reloadAndClearDraft);

    // 导出按钮
    document.getElementById('btnCopy').addEventListener('click', copyLatex);
    document.getElementById('btnDownload').addEventListener('click', downloadTexFile);
}

// 窄屏面板切换：手机一屏只放一个面板，靠底部 tab 在编辑区与代码预览之间切换
function initPanelTabs() {
    const tabs = document.getElementById('panelTabs');
    const btnEditor = document.getElementById('tabEditor');
    const btnPreview = document.getElementById('tabPreview');
    const mainContent = document.querySelector('.main-content');
    if (!tabs || !btnEditor || !btnPreview || !mainContent) {
        return;
    }

    function setPanel(showPreview) {
        mainContent.classList.toggle('show-preview', showPreview);
        btnPreview.classList.toggle('active', showPreview);
        btnEditor.classList.toggle('active', !showPreview);
        btnPreview.setAttribute('aria-selected', showPreview ? 'true' : 'false');
        btnEditor.setAttribute('aria-selected', showPreview ? 'false' : 'true');
        if (showPreview) {
            updatePreview();
        }
    }

    btnEditor.addEventListener('click', function() {
        setPanel(false);
    });
    btnPreview.addEventListener('click', function() {
        setPanel(true);
    });

    // 代码视图下编辑区是隐藏的，execCommand 打不到它：工具栏一动就先切回编辑区
    // 复制与下载只读代码，不需要切回去
    const keepPreview = { btnCopy: true, btnDownload: true };
    document.querySelector('.toolbar').addEventListener('click', function(e) {
        const btn = e.target && e.target.closest ? e.target.closest('button') : null;
        if (!btn || keepPreview[btn.id]) {
            return;
        }
        if (mainContent.classList.contains('show-preview')) {
            setPanel(false);
        }
    }, true);
}

// 插入标题
function insertHeading(level) {
    const tag = 'h' + level;
    document.execCommand('formatBlock', false, tag);
    editorArea.focus();
}

// 切换粗体
function toggleBold() {
    document.execCommand('bold', false, null);
    editorArea.focus();
}

// 切换斜体
function toggleItalic() {
    document.execCommand('italic', false, null);
    editorArea.focus();
}

// 切换居中
function toggleCenter() {
    const isCentered = document.queryCommandState('justifyCenter');
    if (isCentered) {
        document.execCommand('justifyLeft', false, null);
    } else {
        document.execCommand('justifyCenter', false, null);
    }
    editorArea.focus();
}

// 插入无序列表
function insertUnorderedList() {
    document.execCommand('insertUnorderedList', false, null);
    editorArea.focus();
}

// 插入有序列表
function insertOrderedList() {
    document.execCommand('insertOrderedList', false, null);
    editorArea.focus();
}

// 插入行内公式（打开公式弹窗）
function insertInlineFormula() {
    openFormulaModal('inline');
}

// 插入行间公式（打开公式弹窗）
function insertBlockFormula() {
    openFormulaModal('block');
}

// 插入图片
function insertImage(options) {
    const supplied = options && typeof options.imagePath === 'string';
    if (!supplied) saveEditorSelection();
    const imagePath = supplied ? options.imagePath : prompt('请输入图片路径（LaTeX 中使用的路径）：', 'example-image.png');
    if (!imagePath) return;
    const caption = supplied ? options.caption : prompt('请输入图片标题：', '图片标题');
    if (caption === null) return;
    const label = supplied ? options.label : prompt('请输入图片标签（用于引用）：', 'fig:example');
    if (label === null) return;

    const img = document.createElement('img');
    img.src = imagePath;
    img.alt = caption;
    img.setAttribute('data-caption', caption);
    img.setAttribute('data-label', label);
    img.setAttribute('data-width', '0.6');

    if (insertNodeAtCursor(img)) {
        updatePreview();
        saveDraft();
    }
}

// 在光标处插入节点
function insertNodeAtCursor(node) {
    const sel = window.getSelection();
    if (!sel.rangeCount || !editorArea.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        restoreEditorSelection();
    }
    if (!sel.rangeCount) return false;

    const range = sel.getRangeAt(0);
    if (!editorArea.contains(range.commonAncestorContainer)) return false;
    // 富文本节点应放在原文块外，避免插入的图片/公式被当作源码文本导出。
    const container = range.commonAncestorContainer;
    const element = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    const rawBlock = element && element.closest ? element.closest('.raw-tex') : null;
    if (rawBlock && editorArea.contains(rawBlock)) {
        range.setStartAfter(rawBlock);
        range.collapse(true);
    }
    range.deleteContents();
    range.insertNode(node);

    const space = document.createTextNode(' ');
    range.setStartAfter(node);
    range.setEndAfter(node);
    range.insertNode(space);

    range.setStartAfter(space);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    savedSelection = range.cloneRange();
    return true;
}

// ========== .tex 导入 ==========

function decodeTexFile(bytes) {
    // 保留 UTF-8 BOM；遇到无效编码时拒绝导入，而不是用替换字符覆盖原文。
    const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
    if (text.includes('\0')) throw new Error('文件包含空字节');
    return text;
}

// 应用导入的 .tex 内容
function applyImportedTex(tex, fileName) {
    const parts = splitTexDocument(tex);
    if (!parts) {
        alert('导入失败：未找到 \\begin{document}...\\end{document} 结构');
        return;
    }

    texPreamble = parts.preamble;
    texTail = parts.tail;
    texDocumentOpen = parts.open;
    texDocumentClose = parts.close;
    importedFileName = fileName || null;
    draftRecoveryFailed = false;
    suppressDraftSave = false;

    editorArea.innerHTML = parseTexToHtml(parts.body);
    // 从内向外记录浏览器规范化后的节点，包含格式/公式属性变化。
    const importedNodes = Array.from(editorArea.querySelectorAll('[data-tex-source]'));
    importedNodes.reverse().forEach(function(node) {
        node.setAttribute('data-tex-snapshot', getTexNodeSnapshot(node));
    });
    updatePreview();
    if (saveDraft()) updateStatus('已导入 ' + (fileName || '.tex 文件'));
}

// 查找真正的文档边界，跳过注释、宏参数和逐字环境中的同名字符串。
function splitTexDocument(tex) {
    let depth = 0;
    let start = null;
    for (let i = 0; i < tex.length;) {
        if (tex[i] === '%') {
            const end = tex.indexOf('\n', i);
            i = end < 0 ? tex.length : end + 1;
            continue;
        }
        if (tex[i] === '\\') {
            const verb = tex.slice(i).match(/^\\verb\*?([^A-Za-z\s])/);
            if (verb) {
                const end = tex.indexOf(verb[1], i + verb[0].length);
                i = end < 0 ? tex.length : end + 1;
                continue;
            }
            const env = tex.slice(i).match(/^\\(begin|end)\s*\{([^{}]+)\}/);
            if (env) {
                if (env[1] === 'begin' && /^(?:verbatim\*?|Verbatim|lstlisting|minted|comment)$/.test(env[2])) {
                    const close = '\\end{' + env[2] + '}';
                    const end = tex.indexOf(close, i + env[0].length);
                    i = end < 0 ? tex.length : end + close.length;
                    continue;
                }
                if (depth === 0 && env[2] === 'document') {
                    if (env[1] === 'begin' && !start) {
                        start = {index: i, end: i + env[0].length, token: env[0]};
                    } else if (env[1] === 'end' && start) {
                        return {preamble: tex.slice(0, start.index), open: start.token,
                            body: tex.slice(start.end, i), close: env[0], tail: tex.slice(i + env[0].length)};
                    }
                }
                i += env[0].length;
                continue;
            }
            const command = readTexCommand(tex, i);
            i = command ? command.end : i + 1;
            continue;
        }
        if (tex[i] === '{') depth++;
        else if (tex[i] === '}') depth = Math.max(0, depth - 1);
        i++;
    }
    return null;
}

// 开始新文档（清空编辑器）
function startNewDocument() {
    if (!confirm('确定要清空编辑器开始新文档吗？当前内容将丢失。')) return;

    editorArea.innerHTML = '<h1>新文档</h1><p>在此输入内容...</p>';
    texPreamble = null;
    texTail = '';
    texDocumentOpen = '\\begin{document}';
    texDocumentClose = '\\end{document}';
    importedFileName = null;
    draftRecoveryFailed = false;
    suppressDraftSave = false;
    updatePreview();
    if (saveDraft()) updateStatus('已开始新文档');
}

// 重新加载并删除草稿
function reloadAndClearDraft() {
    if (!confirm('确定要删除草稿并重新加载吗？所有未保存的内容将丢失。')) return;

    // pagehide 的补存不能在清除草稿后把旧内容重新写回。
    suppressDraftSave = true;
    try {
        localStorage.removeItem('visuellatex_document');
        localStorage.removeItem('visuellatex_draft');
        localStorage.removeItem('visuellatex_draft_time');
        localStorage.removeItem('visuellatex_preamble');
        localStorage.removeItem('visuellatex_tail');
        localStorage.removeItem('visuellatex_filename');
        // 清理旧版本遗留的草稿 key
        localStorage.removeItem('modelpaper_draft');
        localStorage.removeItem('modelpaper_draft_time');
    } catch (e) {
        console.error('清除草稿失败：', e);
        suppressDraftSave = false;
        updateStatus('清除草稿失败，请重试');
        return;
    }

    location.reload();
}

// ========== LaTeX -> HTML 解析（导入用，往返保真） ==========

// HTML 文本转义
function escapeForHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// HTML 属性值转义
function escapeAttr(text) {
    return escapeForHtml(text).replace(/"/g, '&quot;');
}

function readTexVerbatim(text, start) {
    const match = /^\\(verb\*?|lstinline\*?)(?![A-Za-z@])/.exec(text.slice(start));
    if (!match) return null;
    let delimiterAt = start + match[0].length;
    if (match[1].startsWith('lstinline') && text[delimiterAt] === '[') {
        const options = readTexGroup(text, delimiterAt, '[', ']');
        if (!options) return null;
        delimiterAt = options.end;
    }
    const delimiter = text[delimiterAt];
    if (!delimiter || delimiter === '\r' || delimiter === '\n' || delimiter === '{') return null;
    const newline = text.slice(delimiterAt + 1).search(/[\r\n]/);
    const lineEnd = newline < 0 ? text.length : delimiterAt + 1 + newline;
    const closing = text.indexOf(delimiter, delimiterAt + 1);
    const end = closing >= 0 && closing < lineEnd ? closing + 1 : lineEnd;
    return {name: match[1], start, end, args: [], source: text.slice(start, end)};
}

// Read balanced TeX arguments instead of stopping at the first closing brace.
function readTexGroup(text, start, open = '{', close = '}') {
    if (text[start] !== open) return null;
    let depth = 1;
    let braces = 0;
    for (let i = start + 1; i < text.length; i++) {
        if (text[i] === '\\') {
            const literal = readTexVerbatim(text, i);
            i = literal ? literal.end - 1 : i + 1;
            continue;
        }
        if (text[i] === '%') {
            const newline = text.indexOf('\n', i);
            if (newline === -1) return null;
            i = newline;
            continue;
        }
        if (open === '[') {
            if (text[i] === '{') braces++;
            if (text[i] === '}') braces--;
            if (braces > 0) continue;
        }
        if (text[i] === open) depth++;
        if (text[i] === close && --depth === 0) {
            return { content: text.slice(start + 1, i), start, end: i + 1 };
        }
    }
    return null;
}

function readTexCommand(text, start) {
    const literal = readTexVerbatim(text, start);
    if (literal) return literal;
    const match = /^\\([A-Za-z@]+\*?|[^\r\n])/.exec(text.slice(start));
    if (!match) return null;
    let end = start + match[0].length;
    const args = [];
    if (match[1] === '\\') {
        if (text[end] === '*') end++;
        const optionStart = end + /^[ \t]*/.exec(text.slice(end))[0].length;
        if (text[optionStart] === '[') {
            const option = readTexGroup(text, optionStart, '[', ']');
            if (option) end = option.end;
        }
    } else if (/^[A-Za-z@]/.test(match[1])) {
        while (end < text.length) {
            const spaces = /^[ \t\r\n]*/.exec(text.slice(end))[0].length;
            const argStart = end + spaces;
            const open = text[argStart];
            if (open !== '{' && open !== '[') break;
            const group = readTexGroup(text, argStart, open, open === '{' ? '}' : ']');
            if (!group) break;
            args.push({ ...group, open });
            end = group.end;
        }
    }
    return { name: match[1], start, end, args, source: text.slice(start, end) };
}

// Literal environments must be isolated before looking for comments or nested commands.
function readTexEnvironment(text, start) {
    const begin = /^\\begin[ \t\r\n]*\{([^{}]+)\}/.exec(text.slice(start));
    if (!begin) return null;
    const name = begin[1];
    const innerStart = start + begin[0].length;
    const literal = new Set(['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment']);
    function literalEnd(env, from) {
        const pattern = new RegExp('\\\\end[ \\t\\r\\n]*\\{' + env.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\}', 'g');
        pattern.lastIndex = from;
        const match = pattern.exec(text);
        return match ? { innerEnd: match.index, end: pattern.lastIndex } : null;
    }
    if (literal.has(name)) {
        const end = literalEnd(name, innerStart);
        return { name, start, innerStart, ...(end || {innerEnd: text.length, end: text.length}), complete: Boolean(end) };
    }
    const stack = [name];
    for (let i = innerStart; i < text.length;) {
        if (text[i] === '%') {
            const newline = text.indexOf('\n', i);
            i = newline === -1 ? text.length : newline + 1;
            continue;
        }
        if (text[i] !== '\\') { i++; continue; }
        const boundary = /^\\(begin|end)[ \t\r\n]*\{([^{}]+)\}/.exec(text.slice(i));
        if (boundary) {
            const env = boundary[2];
            if (boundary[1] === 'begin') {
                if (literal.has(env)) {
                    const end = literalEnd(env, i + boundary[0].length);
                    if (!end) break;
                    i = end.end;
                    continue;
                }
                stack.push(env);
            } else if (stack[stack.length - 1] === env) {
                stack.pop();
                if (stack.length === 0) return {name, start, innerStart, innerEnd: i, end: i + boundary[0].length, complete: true};
            } else {
                // An unmatched structure is never partially converted.
                break;
            }
            i += boundary[0].length;
            continue;
        }
        const command = readTexCommand(text, i);
        i = command ? command.end : i + 1;
    }
    return {name, start, innerStart, innerEnd: text.length, end: text.length, complete: false};
}

function readTexMath(text, start) {
    let delimiter;
    let close;
    if (text.startsWith('$$', start)) { delimiter = '$$'; close = '$$'; }
    else if (text[start] === '$') { delimiter = '$'; close = '$'; }
    else if (text.startsWith('\\(', start)) { delimiter = '\\('; close = '\\)'; }
    else if (text.startsWith('\\[', start)) { delimiter = '\\['; close = '\\]'; }
    else return null;
    for (let i = start + delimiter.length; i < text.length;) {
        if (text.startsWith(close, i)) {
            return {delimiter, content: text.slice(start + delimiter.length, i), end: i + close.length};
        }
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '%') {
            const newline = text.indexOf('\n', i);
            i = newline === -1 ? text.length : newline + 1;
        } else i++;
    }
    return null;
}

// Character references prevent the HTML parser from normalizing CRLF in source attributes.
function texSourceAttribute(source) {
    return escapeAttr(source).replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
}

function texSourceElement(tag, source, content, attrs = '') {
    const opening = '<' + tag + ' data-tex-source="' + texSourceAttribute(source) + '"' + attrs + '>';
    return tag === 'img' || tag === 'br' ? opening : opening + content + '</' + tag + '>';
}

function parseTexInline(text) {
    let html = '';
    let plain = '';
    const flush = () => { html += escapeForHtml(plain); plain = ''; };
    function commandSpan(source, hidden = false) {
        return texSourceElement('span', source, escapeForHtml(source), ' class="tex-cmd" contenteditable="false"' + (hidden ? ' hidden' : ''));
    }
    for (let i = 0; i < text.length;) {
        const math = readTexMath(text, i);
        if (math) {
            flush();
            const block = math.delimiter === '$$' || math.delimiter === '\\[';
            html += texSourceElement('span', text.slice(i, math.end), escapeForHtml(text.slice(i, math.end)),
                ' class="' + (block ? 'formula-block' : 'formula-inline') + '" data-formula="' + texSourceAttribute(math.content) +
                '" data-delimiter="' + escapeAttr(math.delimiter) + '" contenteditable="false"');
            i = math.end;
            continue;
        }
        if (text[i] === '%') {
            flush();
            const newline = text.indexOf('\n', i);
            const end = newline === -1 ? text.length : newline + 1;
            html += commandSpan(text.slice(i, end), true);
            i = end;
            continue;
        }
        if (text[i] === '\\') {
            flush();
            const command = readTexCommand(text, i);
            if (!command) { html += commandSpan(text[i++]); continue; }
            const formats = {textbf: 'b', textit: 'i', emph: 'em'};
            const tag = formats[command.name];
            if (tag && command.args.length === 1 && command.args[0].open === '{') {
                html += texSourceElement(tag, command.source, parseTexInline(command.args[0].content),
                    ' data-tex-command="' + command.name + '"');
            } else if (command.name === '\\') {
                html += texSourceElement('br', command.source, '');
            } else {
                html += commandSpan(command.source);
            }
            i = command.end;
            continue;
        }
        // These characters are TeX syntax in imported text, not newly typed plain text.
        if ('$&#_{}~^'.includes(text[i])) {
            flush();
            html += commandSpan(text[i++]);
            continue;
        }
        plain += text[i++];
    }
    flush();
    return html;
}

function parseSimpleTexList(text, env) {
    const body = text.slice(env.innerStart, env.innerEnd);
    if (/\\begin\s*\{|\n[ \t\r]*\n/.test(body)) return null;
    const items = [];
    let current = null;
    for (let i = 0; i < body.length;) {
        const math = readTexMath(body, i);
        if (math) { i = math.end; continue; }
        if (body[i] === '%') {
            const newline = body.indexOf('\n', i);
            i = newline === -1 ? body.length : newline + 1;
            continue;
        }
        if (body[i] === '\\') {
            const command = readTexCommand(body, i);
            if (command && command.name === 'item') {
                // Optional labels and grouped items remain fully editable raw source.
                if (command.args.length) return null;
                if (current === null && body.slice(0, i).trim()) return null;
                if (current !== null) items.push(body.slice(current, i));
                current = command.end;
            }
            i = command ? command.end : i + 1;
        } else i++;
    }
    if (current === null) return null;
    items.push(body.slice(current));
    const tag = env.name === 'itemize' ? 'ul' : 'ol';
    return texSourceElement(tag, text.slice(env.start, env.end), items.map(item => '<li>' + parseTexInline(item) + '</li>').join(''));
}

function parseSimpleTexFigure(text, env) {
    const body = text.slice(env.innerStart, env.innerEnd);
    let i = 0;
    let placement = '';
    let image = null;
    let caption = '';
    let label = '';
    const seen = new Set();
    const skipSpaces = () => { i += /^[ \t\r\n]*/.exec(body.slice(i))[0].length; };
    skipSpaces();
    if (body[i] === '[') {
        const option = readTexGroup(body, i, '[', ']');
        if (!option || !/^[!htbpH]*$/.test(option.content)) return null;
        placement = option.content;
        i = option.end;
    }
    while (i < body.length) {
        skipSpaces();
        if (i === body.length) break;
        const command = readTexCommand(body, i);
        if (!command || seen.has(command.name)) return null;
        seen.add(command.name);
        if (command.name === 'centering' && command.args.length === 0) {
            // No source is discarded: the complete figure is retained on the image node.
        } else if (command.name === 'includegraphics') {
            const args = command.args;
            const pathArg = args[args.length - 1];
            if (!pathArg || pathArg.open !== '{' || args.length > 2) return null;
            const width = args.length === 2 && args[0].open === '[' ? /^width\s*=\s*((?:\d*\.)?\d+)\\textwidth$/.exec(args[0].content.trim()) : null;
            if (args.length === 2 && !width) return null;
            const path = pathArg.content;
            if (!path || /[\\{}]|^[a-z][a-z\d+.-]*:|^\/\//i.test(path)) return null;
            image = {path, width: width ? width[1] : ''};
        } else if ((command.name === 'caption' || command.name === 'label') && command.args.length === 1 && command.args[0].open === '{') {
            if (command.name === 'caption') caption = command.args[0].content;
            else label = command.args[0].content;
        } else return null;
        i = command.end;
    }
    if (!image) return null;
    return texSourceElement('img', text.slice(env.start, env.end), '',
        ' src="' + escapeAttr(image.path) + '" alt="' + escapeAttr(caption) + '" data-caption="' + texSourceAttribute(caption) +
        '" data-label="' + texSourceAttribute(label) + '" data-caption-tex="true" data-label-tex="true" data-width="' + escapeAttr(image.width) +
        '" data-placement="' + escapeAttr(placement) + '" data-centering="' + seen.has('centering') +
        '" data-has-caption="' + seen.has('caption') + '"');
}

// Build visual nodes from source tokens only. Unknown structures keep their complete source.
function parseTexToHtml(tex) {
    tex = String(tex);
    let html = '';
    function gap(source) {
        if (source) html += texSourceElement('span', source, '', ' class="tex-whitespace" contenteditable="false" hidden');
    }
    function paragraph(source) {
        const leading = /^[ \t\r\n\f]*/.exec(source)[0];
        gap(leading);
        const rest = source.slice(leading.length);
        const trailing = /[ \t\r\n\f]*$/.exec(rest)[0];
        const content = rest.slice(0, rest.length - trailing.length);
        if (content) html += texSourceElement('p', content, parseTexInline(content));
        gap(trailing);
    }
    function headingAt(start) {
        if (!/^\\(?:section|subsection|subsubsection)(?![A-Za-z@])/.test(tex.slice(start))) return null;
        const command = readTexCommand(tex, start);
        return command && command.args.length ? command : null;
    }
    let i = 0;
    while (i < tex.length) {
        const whitespace = /^[ \t\r\n\f]+/.exec(tex.slice(i));
        if (whitespace) { gap(whitespace[0]); i += whitespace[0].length; continue; }
        const env = readTexEnvironment(tex, i);
        if (env) {
            let visual = null;
            if (env.complete && (env.name === 'itemize' || env.name === 'enumerate')) visual = parseSimpleTexList(tex, env);
            if (env.complete && env.name === 'figure') visual = parseSimpleTexFigure(tex, env);
            const source = tex.slice(i, env.end);
            html += visual || texSourceElement('div', source, escapeForHtml(source), ' class="raw-tex"');
            i = env.end;
            continue;
        }
        const heading = headingAt(i);
        if (heading) {
            const levels = {section: 'h1', subsection: 'h2', subsubsection: 'h3'};
            if (levels[heading.name] && heading.args.length === 1 && heading.args[0].open === '{') {
                html += texSourceElement(levels[heading.name], heading.source, parseTexInline(heading.args[0].content));
            } else html += texSourceElement('div', heading.source, escapeForHtml(heading.source), ' class="raw-tex"');
            i = heading.end;
            continue;
        }
        const start = i;
        while (i < tex.length) {
            if (/^[ \t\r]*\n[ \t\r]*\n/.test(tex.slice(i))) break;
            const math = readTexMath(tex, i);
            if (math) { i = math.end; continue; }
            if (tex[i] === '%') {
                const newline = tex.indexOf('\n', i);
                i = newline === -1 ? tex.length : newline + 1;
                continue;
            }
            if (tex[i] === '\\') {
                if (i > start && (readTexEnvironment(tex, i) || headingAt(i))) break;
                const command = readTexCommand(tex, i);
                i = command ? command.end : i + 1;
            } else i++;
        }
        paragraph(tex.slice(start, i));
    }
    return html;
}

// ========== DOM 转 LaTeX（导出用） ==========

function domToLatex() {
    let latex = '';

    if (texPreamble !== null) {
        let preamble = texPreamble;
        const changedImages = Array.from(editorArea.querySelectorAll('img')).some(function(node) {
            return node.getAttribute('data-tex-source') === null ||
                node.getAttribute('data-tex-snapshot') !== getTexNodeSnapshot(node);
        });
        // 仅为新插入/修改的图片补依赖，未修改的导入文档不改动导言区。
        if (changedImages && !hasTexPackage(preamble, 'graphicx')) {
            const newline = preamble.includes('\r\n') ? '\r\n' : '\n';
            preamble += (preamble.endsWith('\n') ? '' : newline) + '\\usepackage{graphicx}' + newline;
        }
        const body = convertEditorNodesToLatex(editorArea.childNodes);
        return preamble + texDocumentOpen + body + texDocumentClose + texTail;
    }

    // 新建文档使用默认配置；导入文档已在上方按原始边界返回。
    latex += '\\documentclass[12pt,a4paper]{article}\n\n';
    latex += '% 中文支持\n';
    latex += '\\usepackage{ctex}\n\n';
    latex += '% 数学公式\n';
    latex += '\\usepackage{amsmath}\n';
    latex += '\\usepackage{amssymb}\n\n';
    latex += '% 图表\n';
    latex += '\\usepackage{graphicx}\n';
    latex += '\\usepackage{float}\n\n';
    latex += '% 页面布局\n';
    latex += '\\usepackage{geometry}\n';
    latex += '\\geometry{left=2.5cm,right=2.5cm,top=2.5cm,bottom=2.5cm}\n\n';

    latex += '\\begin{document}\n\n';

    latex += convertEditorNodesToLatex(editorArea.childNodes);

    latex += '\n\\end{document}\n';
    if (texTail) {
        latex += texTail + '\n';
    }

    return latex;
}

function hasTexPackage(preamble, packageName) {
    const withoutComments = preamble.replace(/(^|[^\\])%.*/g, '$1');
    const packages = withoutComments.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g);
    return Array.from(packages).some(function(match) {
        return match[1].split(',').some(name => name.trim() === packageName);
    });
}

// 同时检查内容和根节点属性：居中、标题级别或公式属性变化也必须使原文缓存失效。
function getTexNodeSnapshot(node) {
    function describe(current) {
        if (current.nodeType !== Node.ELEMENT_NODE) return [current.nodeType, current.textContent];
        const attributes = Array.from(current.attributes || [])
            .filter(function(attr) { return !attr.name.startsWith('data-tex-'); })
            .map(function(attr) { return [attr.name, attr.value]; })
            .sort(function(a, b) { return a[0].localeCompare(b[0]); });
        return [current.tagName.toLowerCase(), attributes, Array.from(current.childNodes).map(describe)];
    }
    // 不把子节点的原文和快照再次嵌进父快照，防止嵌套格式造成元数据膨胀。
    return JSON.stringify(describe(node));
}

// 浏览器按 Enter 拆分段落时，不一定为新兄弟节点插入源文件的空白占位符。
function convertEditorNodesToLatex(nodes) {
    function ordinaryParagraph(node) {
        return node && node.nodeType === Node.ELEMENT_NODE && /^(p|div)$/i.test(node.tagName) &&
            !node.classList.contains('raw-tex') && !node.classList.contains('formula-block');
    }
    function unchanged(node) {
        return node.getAttribute('data-tex-source') !== null &&
            node.getAttribute('data-tex-snapshot') === getTexNodeSnapshot(node);
    }
    let latex = '';
    let previous = null;
    Array.from(nodes).forEach(function(node) {
        const part = convertNodeToLatex(node);
        if (ordinaryParagraph(previous) && ordinaryParagraph(node) && !(unchanged(previous) && unchanged(node))) {
            const boundaryWhitespace = (latex.match(/\s*$/)[0] || '') + (part.match(/^\s*/)[0] || '');
            const newlineCount = (boundaryWhitespace.match(/\n/g) || []).length;
            if (newlineCount < 2) latex += '\n'.repeat(2 - newlineCount);
        }
        latex += part;
        previous = node;
    });
    return latex;
}

// contenteditable 的 Enter 会产生 div/br；textContent 会吞掉这些换行。
function getRawTexContent(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.tagName.toLowerCase() === 'br') return '\n';
    let text = '';
    const children = Array.from(node.childNodes);
    children.forEach(function(child, index) {
        const isBlock = child.nodeType === Node.ELEMENT_NODE && /^(div|p|pre|li)$/.test(child.tagName.toLowerCase());
        if (isBlock && text && !text.endsWith('\n')) text += '\n';
        text += getRawTexContent(child);
        if (isBlock && index < children.length - 1 && !text.endsWith('\n')) text += '\n';
    });
    return text;
}

// 所有层级共用转换规则，避免段落内图片/换行及根节点公式走不同路径。
function convertNodeToLatex(node) {
    if (node.nodeType === Node.TEXT_NODE) return escapeLatex(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const source = node.getAttribute('data-tex-source');
    const snapshot = node.getAttribute('data-tex-snapshot');
    if (source !== null && snapshot !== null && getTexNodeSnapshot(node) === snapshot) {
        return source;
    }
    // 导入节点的分隔空白由独立的 tex-whitespace 节点保管，编辑时不额外插入空行。
    const separator = source !== null ? '' : '\n\n';
    if (node.classList.contains('tex-whitespace')) return source || '';
    if (node.classList.contains('raw-tex')) return getRawTexContent(node);
    if (node.classList.contains('tex-cmd')) return node.textContent;

    if (node.classList.contains('formula-inline') || node.classList.contains('formula-block')) {
        const formula = node.getAttribute('data-formula') || '';
        const delimiter = node.getAttribute('data-delimiter');
        if (delimiter === '$$') return '$$' + formula + '$$';
        if (delimiter === '\\[') return '\\[' + formula + '\\]';
        if (delimiter === '\\(') return '\\(' + formula + '\\)';
        if (delimiter === '$' || node.classList.contains('formula-inline')) return '$' + formula + '$';
        return '\\begin{equation}\n' + formula + '\n\\end{equation}' + separator;
    }

    const tagName = node.tagName.toLowerCase();
    let latex;
    switch (tagName) {
        case 'h1':
        case 'h2':
        case 'h3': {
            const command = {h1: 'section', h2: 'subsection', h3: 'subsubsection'}[tagName];
            latex = '\\' + command + '{' + convertInlineNodes(node) + '}' + separator;
            break;
        }
        case 'p':
        case 'div':
            latex = convertInlineNodes(node) + separator;
            break;
        case 'b':
        case 'strong':
            latex = '\\textbf{' + convertInlineNodes(node) + '}';
            break;
        case 'i':
        case 'em':
            latex = '\\' + (node.getAttribute('data-tex-command') === 'emph' ? 'emph' : 'textit') + '{' + convertInlineNodes(node) + '}';
            break;
        case 'ul':
        case 'ol': {
            const environment = tagName === 'ul' ? 'itemize' : 'enumerate';
            latex = '\\begin{' + environment + '}\n';
            Array.from(node.childNodes).forEach(function(child) {
                if (child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() === 'li') {
                    const label = child.getAttribute('data-item-label');
                    latex += '    \\item' + (label === null ? '' : '[' + label + ']') + ' ' + convertInlineNodes(child) + '\n';
                } else if (child.nodeType !== Node.TEXT_NODE || child.textContent.trim()) {
                    latex += convertNodeToLatex(child);
                }
            });
            latex += '\\end{' + environment + '}' + separator;
            break;
        }
        case 'img': {
            const imgPath = node.getAttribute('src') || '';
            const caption = node.getAttribute('data-caption');
            const label = node.getAttribute('data-label');
            const width = node.getAttribute('data-width');
            const placement = node.getAttribute('data-placement');
            latex = '\\begin{figure}' + (placement === '' ? '' : '[' + (placement || 'htbp') + ']') + '\n';
            if (node.getAttribute('data-centering') !== 'false') latex += '    \\centering\n';
            const imageOptions = width === '' ? '' : '[width=' + (width || '0.6') + '\\textwidth]';
            latex += '    \\includegraphics' + imageOptions + '{' + imgPath + '}\n';
            if (caption || node.getAttribute('data-has-caption') === 'true') {
                latex += '    \\caption{' + (node.getAttribute('data-caption-tex') === 'true' ? caption || '' : escapeLatex(caption || '')) + '}\n';
            }
            if (label) latex += '    \\label{' + (node.getAttribute('data-label-tex') === 'true' ? label : escapeLatex(label)) + '}\n';
            latex += '\\end{figure}' + separator;
            break;
        }
        case 'br':
            return '\\\\\n';
        default:
            latex = convertInlineNodes(node);
    }

    const alignment = (node.style && node.style.textAlign) || node.getAttribute('align');
    if (alignment === 'center' && /^(p|div|h[1-3])$/.test(tagName)) {
        // 局部作用域避免居中设置泄漏到后续段落。
        return '\\begin{center}\n' + latex + '\n\\end{center}' + separator;
    }
    return latex;
}

function convertInlineNodes(node) {
    let latex = '';
    let pendingComment = false;
    Array.from(node.childNodes).forEach(function(child) {
        const part = convertNodeToLatex(child);
        if (!part) return;
        // 段尾注释的换行可能保存在外部空白节点中；追加文字时必须先结束注释。
        if (pendingComment && !/^[ \t]*[\r\n]/.test(part)) latex += '\n';
        latex += part;
        pendingComment = child.nodeType === Node.ELEMENT_NODE && child.classList.contains('tex-cmd') &&
            child.getAttribute('hidden') !== null && part.startsWith('%') && !/[\r\n]/.test(part);
    });
    // 新增格式包裹段尾注释时，也不能让注释吞掉生成的右花括号。
    if (pendingComment && /^(b|strong|i|em|h[1-3])$/i.test(node.tagName)) latex += '\n';
    return latex;
}

// 保留兼容入口；内部节点也使用统一转换，不能把格式和公式降为纯文本。
function getNodeTextContent(node) {
    return convertInlineNodes(node);
}

// 此函数只处理普通文字；导入命令和转义符由 tex-cmd 节点保留原文。
function escapeLatex(text) {
    const specialChars = {
        '\\': '\\textbackslash{}',
        '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#', '_': '\\_',
        '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}'
    };
    return String(text).replace(/[\\&%$#_{}~^]/g, function(match) {
        return specialChars[match];
    });
}

// 更新预览
function updatePreview() {
    const latex = domToLatex();
    previewArea.textContent = latex;
    if (!draftRecoveryFailed) updateStatus('已更新');
}

// 复制 LaTeX 代码
function copyLatex() {
    const latex = domToLatex();
    navigator.clipboard.writeText(latex).then(function() {
        updateStatus('已复制到剪贴板');
        alert('LaTeX 代码已复制到剪贴板！');
    }).catch(function(err) {
        alert('复制失败：' + err);
    });
}

// 下载 .tex 文件（优先沿用导入时的文件名）
function downloadTexFile() {
    const latex = domToLatex();
    const baseName = importedFileName ? importedFileName.replace(/\.[^.]+$/, '') : 'document';
    const blob = new Blob([latex], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = baseName + '.tex';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    updateStatus('文件已下载');
}

// 保存草稿到 localStorage（含导言区/尾部/文件名）
function saveDraft() {
    if (suppressDraftSave) return false;
    if (draftRecoveryFailed) {
        updateStatus('原草稿恢复失败，已暂停自动覆盖；请下载当前内容或重新导入');
        return false;
    }
    try {
        // 单次写入，避免配额不足时正文和导言区处于不同版本。
        localStorage.setItem('visuellatex_document', JSON.stringify({
            version: 1, html: editorArea.innerHTML.replace(/\r/g, '&#13;'), preamble: texPreamble,
            tail: texTail, open: texDocumentOpen, close: texDocumentClose,
            filename: importedFileName, savedAt: new Date().toISOString()
        }));
        updateStatus('草稿已保存');
        return true;
    } catch (e) {
        console.error('保存草稿失败：', e);
        updateStatus('草稿保存失败，请下载文件保存当前内容');
        return false;
    }
}

function flushDraft() {
    clearTimeout(debounceTimer);
    if (editorArea) saveDraft();
}

// 旧版草稿可能含导入产生的活动 HTML；在惰性的 template 内清理后再恢复。
function sanitizeDraftHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const allowedTags = new Set(['P', 'DIV', 'SPAN', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'B', 'STRONG', 'I', 'EM', 'BR', 'IMG']);
    const allowedAttributes = new Set(['class', 'contenteditable', 'hidden', 'src', 'alt', 'align', 'title',
        'data-caption', 'data-label', 'data-width', 'data-formula', 'data-delimiter',
        'data-placement', 'data-centering', 'data-has-caption', 'data-caption-tex', 'data-label-tex', 'data-item-label',
        'data-tex-command', 'data-tex-source', 'data-tex-snapshot']);
    for (const node of Array.from(template.content.querySelectorAll('*'))) {
        if (!allowedTags.has(node.tagName)) {
            if (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|SVG|MATH|TEMPLATE)$/.test(node.tagName)) node.remove();
            else node.replaceWith(...Array.from(node.childNodes));
            continue;
        }
        for (const attr of Array.from(node.attributes)) {
            if (attr.name === 'style') {
                const align = node.style.textAlign;
                node.removeAttribute('style');
                if (/^(center|left|right|justify)$/.test(align)) node.style.textAlign = align;
            } else if (!allowedAttributes.has(attr.name)) {
                node.removeAttribute(attr.name);
            }
        }
        const src = node.getAttribute('src');
        const normalizedSrc = src && src.replace(/[\u0000-\u0020\u007f]/g, '');
        if (normalizedSrc && /^(?:javascript|vbscript|data):/i.test(normalizedSrc) && !/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(normalizedSrc)) {
            node.removeAttribute('src');
        }
    }
    return template.innerHTML.replace(/\r/g, '&#13;');
}

// 从 localStorage 加载草稿
function loadDraft() {
    try {
        const serialized = localStorage.getItem('visuellatex_document');
        if (serialized !== null) {
            const draft = JSON.parse(serialized);
            if (draft.version !== 1 || typeof draft.html !== 'string') throw new Error('草稿格式无效');
            editorArea.innerHTML = sanitizeDraftHtml(draft.html);
            texPreamble = typeof draft.preamble === 'string' ? draft.preamble : null;
            texTail = typeof draft.tail === 'string' ? draft.tail : '';
            texDocumentOpen = typeof draft.open === 'string' ? draft.open : '\\begin{document}';
            texDocumentClose = typeof draft.close === 'string' ? draft.close : '\\end{document}';
            importedFileName = typeof draft.filename === 'string' ? draft.filename : null;
            updateStatus('已恢复草稿');
            return;
        }
        const content = localStorage.getItem('visuellatex_draft');
        const time = localStorage.getItem('visuellatex_draft_time');

        if (content !== null) {
            editorArea.innerHTML = sanitizeDraftHtml(content);
            texPreamble = localStorage.getItem('visuellatex_preamble') || null;
            texTail = localStorage.getItem('visuellatex_tail') || '';
            importedFileName = localStorage.getItem('visuellatex_filename') || null;
            if (texPreamble !== null) {
                // 旧草稿的导言区/尾部经过 trim，需恢复旧导出的边界换行，
                // 否则末尾注释会吞掉紧接的 begin/end{document}。
                texPreamble += '\n\n';
                texDocumentOpen = '\\begin{document}\n\n';
                texDocumentClose = '\n\\end{document}\n';
                if (texTail) texTail += '\n';
            }
            if (time) {
                updateStatus('已恢复草稿（' + new Date(time).toLocaleString('zh-CN') + '）');
            }
        }
    } catch (e) {
        console.error('加载草稿失败：', e);
        draftRecoveryFailed = true;
        updateStatus('草稿恢复失败，请勿覆盖现有草稿');
    }
}

// 更新状态栏
function updateStatus(message) {
    if (statusText) {
        statusText.textContent = message;
    }
}

// ========== 公式输入弹窗 ==========

// 常用 LaTeX 符号面板
const SYMBOL_PALETTE = [
    { label: '分数', latex: '\\frac{}{}' },
    { label: '根式', latex: '\\sqrt{}' },
    { label: 'n次根', latex: '\\sqrt[n]{}' },
    { label: '上标', latex: '^{}' },
    { label: '下标', latex: '_{}' },
    { label: '求和', latex: '\\sum_{i=1}^{n}' },
    { label: '求积', latex: '\\prod_{i=1}^{n}' },
    { label: '积分', latex: '\\int_{a}^{b}' },
    { label: '二重积分', latex: '\\iint_{D}' },
    { label: '极限', latex: '\\lim_{x \\to 0}' },
    { label: '∞', latex: '\\infty' },
    { label: '≈', latex: '\\approx' },
    { label: '≥', latex: '\\geq' },
    { label: '≤', latex: '\\leq' },
    { label: '≠', latex: '\\neq' },
    { label: '±', latex: '\\pm' },
    { label: '∈', latex: '\\in' },
    { label: '⊂', latex: '\\subset' },
    { label: '∪', latex: '\\cup' },
    { label: '∩', latex: '\\cap' },
    { label: '向量', latex: '\\vec{}' },
    { label: '偏导', latex: '\\frac{\\partial}{\\partial x}' },
    { label: '点乘', latex: '\\cdot' },
    { label: 'α', latex: '\\alpha' },
    { label: 'β', latex: '\\beta' },
    { label: 'γ', latex: '\\gamma' },
    { label: 'θ', latex: '\\theta' },
    { label: 'λ', latex: '\\lambda' },
    { label: 'μ', latex: '\\mu' },
    { label: 'σ', latex: '\\sigma' },
    { label: 'ω', latex: '\\omega' },
    { label: 'π', latex: '\\pi' },
    { label: 'Δ', latex: '\\Delta' },
    { label: 'Σ', latex: '\\Sigma' }
];

let editingFormulaNode = null;

// 打开公式弹窗；传入已有节点时编辑该公式。
function openFormulaModal(mode, formulaNode = null) {
    const modal = document.getElementById('formulaModal');

    // 保存编辑器选区（弹窗聚焦会劫持 DOM 选区）
    saveEditorSelection();
    editingFormulaNode = formulaNode && editorArea.contains(formulaNode) ? formulaNode : null;
    document.getElementById('formulaInput').value = editingFormulaNode
        ? editingFormulaNode.getAttribute('data-formula') || '' : '';
    document.getElementById('btnInsertFormula').textContent = editingFormulaNode ? '更新公式' : '插入公式';

    const radio = document.querySelector('input[name="formulaMode"][value="' + (mode || 'inline') + '"]');
    if (radio) radio.checked = true;

    modal.classList.add('show');
    document.getElementById('formulaInput').focus();
}

// 关闭公式弹窗
function closeFormulaModal() {
    document.getElementById('formulaModal').classList.remove('show');
    editingFormulaNode = null;
    document.getElementById('btnInsertFormula').textContent = '插入公式';
    if (editorArea) editorArea.focus();
}

// 渲染符号面板
function renderSymbolPalette() {
    const palette = document.getElementById('symbolPalette');
    palette.innerHTML = '';
    SYMBOL_PALETTE.forEach(function(sym) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = sym.label;
        btn.textContent = sym.label;
        btn.addEventListener('click', function() {
            insertSymbolIntoTextarea(sym.latex);
        });
        palette.appendChild(btn);
    });
}

// 向公式输入框光标处插入符号
function insertSymbolIntoTextarea(symbol) {
    const ta = document.getElementById('formulaInput');
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + symbol + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + symbol.length;
    ta.focus();
}

// 从手动输入插入公式
function insertFormulaFromInput() {
    const latex = document.getElementById('formulaInput').value;
    if (!latex.trim()) {
        updateStatus('请输入公式内容');
        return;
    }
    const mode = document.querySelector('input[name="formulaMode"]:checked').value;
    if (editingFormulaNode && editorArea.contains(editingFormulaNode)) {
        const old = editingFormulaNode;
        const oldMode = old.classList.contains('formula-block') ? 'block' : 'inline';
        if (mode === oldMode && old.getAttribute('data-formula') === latex) {
            closeFormulaModal();
            return;
        }
        // 保留原标签，避免把段落内的显示公式变成非法的 div 嵌套。
        const replacement = document.createElement(mode === 'inline' ? 'span' : old.tagName.toLowerCase());
        configureFormulaNode(replacement, latex, mode);
        const delimiter = old.getAttribute('data-delimiter');
        if (mode === oldMode && delimiter) {
            replacement.setAttribute('data-delimiter', delimiter);
            const close = delimiter === '\\(' ? '\\)' : delimiter === '\\[' ? '\\]' : delimiter;
            replacement.textContent = delimiter + latex + close;
        } else if (mode === oldMode && mode === 'block') {
            // 兼容旧草稿中没有定界符属性的编号 equation 节点。
            replacement.setAttribute('data-delimiter', 'equation');
        }
        // 新节点不携带旧源码快照，祖先的快照比较也会检测到此次修改。
        old.parentNode.replaceChild(replacement, old);
        updatePreview();
        if (saveDraft()) updateStatus('公式已更新');
    } else {
        insertFormulaNode(latex, mode);
    }
    document.getElementById('formulaInput').value = '';
    closeFormulaModal();
}

function configureFormulaNode(node, latex, type) {
    const delimiter = type === 'block' ? '$$' : '$';
    node.className = type === 'block' ? 'formula-block' : 'formula-inline';
    node.setAttribute('data-formula', latex);
    node.setAttribute('data-delimiter', delimiter);
    node.setAttribute('contenteditable', 'false');
    node.title = '双击编辑公式';
    node.textContent = delimiter + latex + delimiter;
}

// 在编辑器光标处插入公式节点（只读，双击通过弹窗修改）
function insertFormulaNode(latex, type) {
    restoreEditorSelection();
    // span 可安全放入段落，显示公式由 CSS display:block 呈现。
    const node = document.createElement('span');
    configureFormulaNode(node, latex, type);
    if (!insertNodeAtCursor(node)) return;
    updatePreview();
    if (saveDraft()) updateStatus('公式已插入');
}

// 恢复编辑器选区（无有效选区时定位到编辑器末尾）
function restoreEditorSelection() {
    const sel = window.getSelection();
    let range = null;

    if (savedSelection && savedSelection.commonAncestorContainer) {
        if (editorArea.contains(savedSelection.commonAncestorContainer)) {
            range = savedSelection.cloneRange();
        }
    }

    if (!range) {
        range = document.createRange();
        range.selectNodeContents(editorArea);
        range.collapse(false);
    }

    sel.removeAllRanges();
    sel.addRange(range);
    editorArea.focus();
}

// 初始化公式弹窗
function initFormulaModal() {
    renderSymbolPalette();

    editorArea.addEventListener('dblclick', function(e) {
        const target = e.target.nodeType === Node.ELEMENT_NODE ? e.target : e.target.parentElement;
        const formula = target && target.closest ? target.closest('.formula-inline, .formula-block') : null;
        if (!formula || !editorArea.contains(formula)) return;
        e.preventDefault();
        openFormulaModal(formula.classList.contains('formula-block') ? 'block' : 'inline', formula);
    });

    // 关闭按钮
    document.getElementById('formulaModalClose').addEventListener('click', closeFormulaModal);

    // 点击遮罩关闭
    document.getElementById('formulaModal').addEventListener('click', function(e) {
        if (e.target === this) closeFormulaModal();
    });

    // 插入按钮
    document.getElementById('btnInsertFormula').addEventListener('click', insertFormulaFromInput);

    // 文本框 Ctrl+Enter 插入
    document.getElementById('formulaInput').addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            insertFormulaFromInput();
        }
    });

    // Esc 关闭
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && document.getElementById('formulaModal').classList.contains('show')) {
            closeFormulaModal();
        }
    });
}
