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
let importedFileName = null; // 导入的文件名（用于导出命名）
let savedSelection = null;   // 保存编辑器选区（用于公式弹窗等场景）

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    editorArea = document.getElementById('editorArea');
    previewArea = document.getElementById('previewArea');
    statusText = document.getElementById('statusText');

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
            applyImportedTex(e.target.result, file.name);
        };
        reader.onerror = function() {
            alert('读取文件失败，请重试');
        };
        reader.readAsText(file, 'UTF-8');
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
function insertImage() {
    const imagePath = prompt('请输入图片路径（LaTeX 中使用的路径）：', 'example-image.png');
    const caption = prompt('请输入图片标题：', '图片标题');
    const label = prompt('请输入图片标签（用于引用）：', 'fig:example');

    if (imagePath) {
        const img = document.createElement('img');
        img.src = imagePath;
        img.alt = caption;
        img.setAttribute('data-caption', caption || '');
        img.setAttribute('data-label', label || '');
        img.setAttribute('data-width', '0.6');

        insertNodeAtCursor(img);
        updatePreview();
        saveDraft();
    }
}

// 在光标处插入节点
function insertNodeAtCursor(node) {
    const sel = window.getSelection();
    if (sel.getRangeAt && sel.rangeCount) {
        const range = sel.getRangeAt(0);
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
    }
}

// ========== .tex 导入 ==========

// 应用导入的 .tex 内容
function applyImportedTex(tex, fileName) {
    const docMatch = tex.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}([\s\S]*)$/);
    if (!docMatch) {
        alert('导入失败：未找到 \\begin{document}...\\end{document} 结构');
        return;
    }

    const preambleMatch = tex.match(/^([\s\S]*?)\\begin\{document\}/);
    texPreamble = preambleMatch ? preambleMatch[1].trim() : '';
    texTail = docMatch[2].trim();
    importedFileName = fileName || null;

    editorArea.innerHTML = parseTexToHtml(docMatch[1]);
    updatePreview();
    saveDraft();
    updateStatus('已导入 ' + (fileName || '.tex 文件'));
}

// 开始新文档（清空编辑器）
function startNewDocument() {
    if (!confirm('确定要清空编辑器开始新文档吗？当前内容将丢失。')) return;

    editorArea.innerHTML = '<h1>新文档</h1><p>在此输入内容...</p>';
    texPreamble = null;
    texTail = '';
    importedFileName = null;
    updatePreview();
    saveDraft();
    updateStatus('已开始新文档');
}

// 重新加载并删除草稿
function reloadAndClearDraft() {
    if (!confirm('确定要删除草稿并重新加载吗？所有未保存的内容将丢失。')) return;

    try {
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

// 解析 LaTeX 正文为 HTML
function parseTexToHtml(tex) {
    let html = '';

    // 辅助：清理 LaTeX 文本为 HTML（保留行内公式与行内命令）
    function cleanLatexText(text) {
        // 1) 先提取行内公式，避免被其他替换影响
        const formulas = [];
        text = text.replace(/\$([^$]+)\$/g, function(match, formula) {
            const f = formula.trim();
            formulas.push(f);
            return '\x00F' + (formulas.length - 1) + '\x00';
        });
        // 2) 转义普通文本中的 HTML 特殊字符（公式已提取，不受影响）
        text = escapeForHtml(text);
        // 3) 处理文本格式命令
        text = text
            .replace(/\\textbf\{([^}]*)\}/g, '<b>$1</b>')
            .replace(/\\textit\{([^}]*)\}/g, '<i>$1</i>')
            .replace(/\\emph\{([^}]*)\}/g, '<i>$1</i>')
            .replace(/\\\\/g, '<br>');
        // 4) 其余行内命令（\cite、\ref、\eqref、\footnote 等）原样保留为只读 span
        //    （文本已转义，此处无需再次转义，避免 &amp; 变成 &amp;amp;）
        text = text.replace(/\\[a-zA-Z]+(?:\s*\[[^\]\n]*\])?(?:\s*\{[^{}\n]*\})*/g, function(cmd) {
            return '<span class="tex-cmd" contenteditable="false">' + cmd + '</span>';
        });
        // 5) 还原行内公式为只读 span
        text = text.replace(/\x00F(\d+)\x00/g, function(match, idx) {
            const f = formulas[parseInt(idx, 10)];
            return '<span class="formula-inline" data-formula="' + escapeAttr(f) + '" contenteditable="false">$' + escapeForHtml(f) + '$</span>';
        });
        return text.trim();
    }

    // 去除注释（不处理 \% 转义）
    tex = tex.replace(/(^|[^\\])%.*/g, '$1');

    let body = tex;

    // equation 环境 -> 公式块
    body = body.replace(/\\begin\{equation\}([\s\S]*?)\\end\{equation\}/g, function(match, content) {
        const formula = content.trim();
        return '\n<div class="formula-block" data-formula="' + escapeAttr(formula) + '" contenteditable="false">$$' + escapeForHtml(formula) + '$$</div>\n';
    });

    // figure 环境 -> 图片节点
    body = body.replace(/\\begin\{figure\}[\s\S]*?\\end\{figure\}/g, function(match) {
        const imgMatch = match.match(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/);
        const capMatch = match.match(/\\caption\{([^}]+)\}/);
        const labelMatch = match.match(/\\label\{([^}]+)\}/);
        const path = imgMatch ? imgMatch[1] : '';
        const caption = capMatch ? capMatch[1] : '';
        const label = labelMatch ? labelMatch[1] : '';
        return '\n<img src="' + escapeAttr(path) + '" alt="' + escapeAttr(caption) + '" data-caption="' + escapeAttr(caption) + '" data-label="' + escapeAttr(label) + '" data-width="0.6">\n';
    });

    // itemize 环境
    body = body.replace(/\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/g, function(match, content) {
        const items = content.match(/\\item\s+[\s\S]*?(?=\\item|$)/g);
        if (!items) return '';
        const listHtml = items.map(function(item) {
            return '    <li>' + cleanLatexText(item.replace(/\\item\s+/, '')) + '</li>';
        }).join('\n');
        return '\n<ul>\n' + listHtml + '\n</ul>\n';
    });

    // enumerate 环境
    body = body.replace(/\\begin\{enumerate\}([\s\S]*?)\\end\{enumerate\}/g, function(match, content) {
        const items = content.match(/\\item\s+[\s\S]*?(?=\\item|$)/g);
        if (!items) return '';
        const listHtml = items.map(function(item) {
            return '    <li>' + cleanLatexText(item.replace(/\\item\s+/, '')) + '</li>';
        }).join('\n');
        return '\n<ol>\n' + listHtml + '\n</ol>\n';
    });

    // 其余一切块级环境（table、abstract、thebibliography、lstlisting、algorithm、未知环境）
    // -> 原样保留块，用户可直接编辑文本，导出时原样输出
    // 先以占位符暂存，避免多行内容在逐行处理阶段被拆散、二次转义
    const rawBlocks = [];
    body = body.replace(/\\begin\{([A-Za-z]+\*?)\}[\s\S]*?\\end\{\1\}/g, function(match) {
        rawBlocks.push('<div class="raw-tex">' + escapeForHtml(match) + '</div>');
        return '\n\x00R' + (rawBlocks.length - 1) + '\x00\n';
    });

    // 逐行处理章节、独立命令与普通文本
    const lines = body.split('\n');
    let pendingText = '';

    function flushText() {
        const trimmed = pendingText.trim();
        if (trimmed) {
            html += '<p>' + cleanLatexText(trimmed) + '</p>\n';
        }
        pendingText = '';
    }

    for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed) {
            flushText();
            continue;
        }

        // 原样保留块占位符 -> 输出完整块
        if (/^\x00R\d+\x00$/.test(trimmed)) {
            flushText();
            html += rawBlocks[parseInt(trimmed.replace(/\x00R|\x00/g, ''), 10)] + '\n';
            continue;
        }

        // 已处理的 HTML 标签直接输出
        if (/^</.test(trimmed)) {
            flushText();
            html += trimmed + '\n';
            continue;
        }

        let m;
        if ((m = trimmed.match(/^\\section\{([^}]+)\}/))) {
            flushText();
            html += '<h1>' + cleanLatexText(m[1]) + '</h1>\n';
        } else if ((m = trimmed.match(/^\\subsection\{([^}]+)\}/))) {
            flushText();
            html += '<h2>' + cleanLatexText(m[1]) + '</h2>\n';
        } else if ((m = trimmed.match(/^\\subsubsection\{([^}]+)\}/))) {
            flushText();
            html += '<h3>' + cleanLatexText(m[1]) + '</h3>\n';
        } else if (/^\\[a-zA-Z]+/.test(trimmed)) {
            // 其余独立命令行（\maketitle、\newpage、\tableofcontents 等）原样保留
            flushText();
            html += '<div class="raw-tex">' + escapeForHtml(trimmed) + '</div>\n';
        } else {
            pendingText += (pendingText ? ' ' : '') + trimmed;
        }
    }
    flushText();

    return html;
}

// ========== DOM 转 LaTeX（导出用） ==========

function domToLatex() {
    let latex = '';

    // 有导入文件的导言区则原样使用，否则使用默认配置
    if (texPreamble) {
        latex += texPreamble + '\n\n';
    } else {
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
    }

    latex += '\\begin{document}\n\n';

    const nodes = editorArea.childNodes;
    for (let i = 0; i < nodes.length; i++) {
        latex += convertNodeToLatex(nodes[i]);
    }

    latex += '\n\\end{document}\n';
    if (texTail) {
        latex += texTail + '\n';
    }

    return latex;
}

// 转换单个节点为 LaTeX
function convertNodeToLatex(node) {
    let latex = '';

    if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        if (text) {
            return escapeLatex(text) + '\n';
        }
        return '';
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
        return '';
    }

    // 原样保留块：直接输出其文本内容
    if (node.classList.contains('raw-tex')) {
        const raw = node.textContent.replace(/\s+$/, '');
        if (raw) {
            return raw + '\n\n';
        }
        return '';
    }

    const tagName = node.tagName.toLowerCase();

    switch (tagName) {
        case 'h1':
            latex += '\\section{' + getNodeTextContent(node) + '}\n\n';
            break;

        case 'h2':
            latex += '\\subsection{' + getNodeTextContent(node) + '}\n\n';
            break;

        case 'h3':
            latex += '\\subsubsection{' + getNodeTextContent(node) + '}\n\n';
            break;

        case 'p':
        case 'div':
            if (node.classList.contains('formula-block')) {
                const formula = node.getAttribute('data-formula');
                latex += '\\begin{equation}\n';
                latex += '    ' + formula + '\n';
                latex += '\\end{equation}\n\n';
            } else {
                latex += convertInlineNodes(node) + '\n\n';
            }
            break;

        case 'ul': {
            latex += '\\begin{itemize}\n';
            const ulItems = node.querySelectorAll(':scope > li');
            ulItems.forEach(function(item) {
                latex += '    \\item ' + getNodeTextContent(item) + '\n';
            });
            latex += '\\end{itemize}\n\n';
            break;
        }

        case 'ol': {
            latex += '\\begin{enumerate}\n';
            const olItems = node.querySelectorAll(':scope > li');
            olItems.forEach(function(item) {
                latex += '    \\item ' + getNodeTextContent(item) + '\n';
            });
            latex += '\\end{enumerate}\n\n';
            break;
        }

        case 'img': {
            const imgPath = node.getAttribute('src') || '';
            const imgCaption = node.getAttribute('data-caption') || '图片';
            const imgLabel = node.getAttribute('data-label') || 'fig:image';
            const imgWidth = node.getAttribute('data-width') || '0.6';

            latex += '\\begin{figure}[H]\n';
            latex += '    \\centering\n';
            latex += '    \\includegraphics[width=' + imgWidth + '\\textwidth]{' + imgPath + '}\n';
            latex += '    \\caption{' + imgCaption + '}\n';
            latex += '    \\label{' + imgLabel + '}\n';
            latex += '\\end{figure}\n\n';
            break;
        }

        case 'br':
            // LaTeX 换行符 \\ + 换行（92 为反斜杠字符码）
            latex += String.fromCharCode(92, 92) + '\n';
            break;

        default:
            for (let i = 0; i < node.childNodes.length; i++) {
                latex += convertNodeToLatex(node.childNodes[i]);
            }
    }

    return latex;
}

// 转换行内节点（处理粗体、斜体、公式、原样命令等）
function convertInlineNodes(node) {
    let latex = '';

    for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];

        if (child.nodeType === Node.TEXT_NODE) {
            latex += escapeLatex(child.textContent);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
            const tag = child.tagName.toLowerCase();

            if (child.classList.contains('formula-inline')) {
                latex += '$' + child.getAttribute('data-formula') + '$';
            } else if (child.classList.contains('tex-cmd')) {
                latex += child.textContent;
            } else if (tag === 'b' || tag === 'strong') {
                latex += '\\textbf{' + getNodeTextContent(child) + '}';
            } else if (tag === 'i' || tag === 'em') {
                latex += '\\textit{' + getNodeTextContent(child) + '}';
            } else {
                latex += getNodeTextContent(child);
            }
        }
    }

    return latex;
}

// 获取节点的纯文本内容（行内公式还原为 $...$）
function getNodeTextContent(node) {
    let text = '';
    for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child.nodeType === Node.TEXT_NODE) {
            text += child.textContent;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
            if (child.classList.contains('formula-inline')) {
                text += '$' + child.getAttribute('data-formula') + '$';
            } else {
                text += getNodeTextContent(child);
            }
        }
    }
    return text;
}

// 转义 LaTeX 特殊字符
function escapeLatex(text) {
    const specialChars = {
        '&': '\\&',
        '%': '\\%',
        '$': '\\$',
        '#': '\\#',
        '_': '\\_',
        '{': '\\{',
        '}': '\\}',
        '~': '\\textasciitilde{}',
        '^': '\\textasciicircum{}'
    };

    return text.replace(/[&%$#_{}~^]/g, function(match) {
        return specialChars[match];
    });
}

// 更新预览
function updatePreview() {
    const latex = domToLatex();
    previewArea.textContent = latex;
    updateStatus('已更新');
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
    try {
        localStorage.setItem('visuellatex_draft', editorArea.innerHTML);
        localStorage.setItem('visuellatex_preamble', texPreamble || '');
        localStorage.setItem('visuellatex_tail', texTail || '');
        localStorage.setItem('visuellatex_filename', importedFileName || '');
        localStorage.setItem('visuellatex_draft_time', new Date().toISOString());
    } catch (e) {
        console.error('保存草稿失败：', e);
    }
}

// 从 localStorage 加载草稿
function loadDraft() {
    try {
        const content = localStorage.getItem('visuellatex_draft');
        const time = localStorage.getItem('visuellatex_draft_time');

        if (content) {
            editorArea.innerHTML = content;
            texPreamble = localStorage.getItem('visuellatex_preamble') || null;
            texTail = localStorage.getItem('visuellatex_tail') || '';
            importedFileName = localStorage.getItem('visuellatex_filename') || null;
            if (time) {
                updateStatus('已恢复草稿（' + new Date(time).toLocaleString('zh-CN') + '）');
            }
        }
    } catch (e) {
        console.error('加载草稿失败：', e);
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

// 打开公式弹窗
function openFormulaModal(mode) {
    const modal = document.getElementById('formulaModal');

    // 保存编辑器选区（弹窗聚焦会劫持 DOM 选区）
    saveEditorSelection();

    const radio = document.querySelector('input[name="formulaMode"][value="' + (mode || 'inline') + '"]');
    if (radio) radio.checked = true;

    modal.classList.add('show');
    document.getElementById('formulaInput').focus();
}

// 关闭公式弹窗
function closeFormulaModal() {
    document.getElementById('formulaModal').classList.remove('show');
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
    const latex = document.getElementById('formulaInput').value.trim();
    if (!latex) {
        updateStatus('请输入公式内容');
        return;
    }
    const mode = document.querySelector('input[name="formulaMode"]:checked').value;
    insertFormulaNode(latex, mode);
    document.getElementById('formulaInput').value = '';
    closeFormulaModal();
}

// 在编辑器光标处插入公式节点（只读，防止误改导致数据不同步）
function insertFormulaNode(latex, type) {
    // 恢复编辑器中的选区
    restoreEditorSelection();

    if (type === 'block') {
        const div = document.createElement('div');
        div.className = 'formula-block';
        div.setAttribute('data-formula', latex);
        div.setAttribute('contenteditable', 'false');
        div.textContent = '$$' + latex + '$$';
        insertNodeAtCursor(div);
    } else {
        const span = document.createElement('span');
        span.className = 'formula-inline';
        span.setAttribute('data-formula', latex);
        span.setAttribute('contenteditable', 'false');
        span.textContent = '$' + latex + '$';
        insertNodeAtCursor(span);
    }
    updatePreview();
    saveDraft();
    updateStatus('公式已插入');
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
