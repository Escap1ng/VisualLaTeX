/* Visual reference atoms keep their TeX source separate from their presentation. */
(function(root) {
    'use strict';
    const names = {citation: '文献引用', reference: '交叉引用', label: '标签', include: '子文件', bibliography: '参考文献文件', style: '参考文献样式'};
    const symbols = {citation: '文献', reference: '引用', label: '标签', include: '文件', bibliography: '文献表', style: '样式'};

    function decorate(node, app) {
        const source = node.getAttribute('data-tex-source') || node.textContent;
        const description = root.VisualReferences.describe(source, app.model);
        if (!description) return null;
        node.setAttribute('data-tex-source', source);
        node.setAttribute('data-visual-reference', description.kind);
        node.setAttribute('contenteditable', 'false');
        node.setAttribute('role', description.editable === false ? 'note' : 'button');
        if (description.editable === false) node.removeAttribute('tabindex');
        else node.setAttribute('tabindex', '0');
        const label = description.label || description.key || names[description.kind];
        const detail = description.detail || label;
        node.setAttribute('aria-label', names[description.kind] + '：' + detail + (description.editable === false ? '' : '，点击编辑'));
        node.setAttribute('title', detail + (description.editable === false ? '' : ' · 点击或按 Enter 编辑'));
        // Replacing child text on every keystroke would disturb a selection next
        // to the atom. Only refresh when the derived presentation changes.
        const presentation = description.kind === 'label' ? label.replace(/^标签[：:]\s*/, '# ')
            : ['include', 'bibliography', 'style'].includes(description.kind) ? label
            : symbols[description.kind] + ' ' + label;
        if (node.textContent !== presentation) node.textContent = presentation;
        return description;
    }

    root.renderVisualReferences = function(editor, app) {
        if (!root.VisualReferences) return;
        for (const node of editor.querySelectorAll('.tex-cmd')) decorate(node, app);
    };

    root.initVisualReferences = function(app, editor, {insertSource} = {}) {
        const $ = id => document.getElementById(id);
        const overlay = $('referenceModal');
        if (!overlay || !root.VisualReferences) return null;
        const input = $('referenceKeys');
        const choice = $('referenceChoice');
        const accept = $('referenceAccept');
        const cancel = $('referenceCancel');
        const error = $('referenceError');
        let pending = null;

        function finish() {
            if (!pending) return;
            const current = pending;
            pending = null;
            overlay.hidden = true;
            current.background.forEach((node, index) => { if (!current.wasInert[index]) node.removeAttribute('inert'); });
            current.previousFocus?.focus();
        }
        function open({node = null, command = null} = {}) {
            if (pending) return false;
            app.sync();
            const source = node ? node.getAttribute('data-tex-source') || node.textContent : '\\' + command + '{new}';
            const description = root.VisualReferences.describe(source, app.model);
            if (!description || description.editable === false) return false;
            if (node && (app.mode !== 'visual' || !editor.contains(node))) return false;
            const choices = root.VisualReferences.getChoices(description.kind, app.model);
            const visual = app.mode === 'visual';
            if (visual) saveEditorSelection();
            const background = Array.from(document.body.childNodes).filter(item => item.nodeType === 1 && item !== overlay);
            pending = {node, source, description, model: app.model, path: app.model.activePath, visual,
                selection: visual && savedSelection ? savedSelection.cloneRange() : null,
                start: app.ui.sourceArea.selectionStart, end: app.ui.sourceArea.selectionEnd,
                previousFocus: document.activeElement, background, wasInert: background.map(item => item.getAttribute('inert') !== null)};
            $('referenceTitle').textContent = (node ? '编辑' : '插入') + names[description.kind];
            $('referenceKeysLabel').textContent = description.kind === 'citation' ? '文献键（多个键用逗号分隔）'
                : description.kind === 'include' || description.kind === 'bibliography' ? '文件路径'
                : description.kind === 'style' ? '样式名称' : '标签名称';
            $('referenceHint').textContent = description.kind === 'citation' ? '选择已有文献，或直接输入文献键。已有的前注和后注会保留。'
                : description.kind === 'label' ? '为当前位置设置标签，其他位置可通过交叉引用选择它。'
                : description.kind === 'reference' ? '选择项目中的标签，或输入标签名称。引用编号由编译结果确定。'
                : '从项目中选择，或直接输入名称；保存后会同步更新文档。';
            input.value = node ? description.key : description.kind === 'label' ? 'sec:new' : choices[0]?.value || '';
            const placeholder = document.createElement('option');
            placeholder.value = ''; placeholder.textContent = choices.length ? '选择已有项目…' : '项目中暂无可选项，请直接输入';
            choice.replaceChildren(placeholder);
            for (const item of choices) {
                const option = document.createElement('option');
                option.value = item.value; option.textContent = item.label + (item.label.includes(item.value) ? '' : ' · ' + item.value);
                if (item.detail) option.title = item.detail;
                choice.appendChild(option);
            }
            choice.value = ''; choice.disabled = choices.length === 0;
            error.textContent = ''; input.removeAttribute('aria-invalid');
            background.forEach(item => item.setAttribute('inert', ''));
            overlay.hidden = false;
            input.focus(); input.select();
            return true;
        }
        function save() {
            if (!pending) return;
            try {
                const current = pending;
                if (app.model !== current.model || app.model.activePath !== current.path || (app.mode === 'visual') !== current.visual
                    || (current.node && !editor.contains(current.node))) throw new Error('文档已改变，请关闭弹窗后重新选择要编辑的位置。');
                const source = root.VisualReferences.rewrite(current.source, {key: input.value.trim()});
                if (current.node) {
                    if (source !== current.source) {
                        current.node.setAttribute('data-tex-source', source);
                        decorate(current.node, app);
                        app.changed(false); app.persist();
                    }
                    finish();
                    current.node.focus();
                } else if (current.visual) {
                    // Restore the pre-dialog range, not the dialog input's selection.
                    savedSelection = current.selection;
                    restoreEditorSelection();
                    const node = document.createElement('span');
                    node.className = 'tex-cmd'; node.setAttribute('data-tex-source', source);
                    decorate(node, app);
                    if (!insertNodeAtCursor(node)) throw new Error('无法定位插入位置，请在文档中选择位置后重试。');
                    app.changed(false); app.persist(); finish(); editor.focus();
                } else {
                    insertSource(source, current.start, current.end); finish(); app.ui.sourceArea.focus();
                }
            } catch (cause) {
                error.textContent = cause.message;
                input.setAttribute('aria-invalid', 'true'); input.focus();
            }
        }
        choice.addEventListener('change', () => {
            if (!pending || !choice.value) return;
            if (pending.description.kind === 'citation') {
                const keys = input.value.split(',').map(key => key.trim()).filter(Boolean);
                if (!keys.includes(choice.value)) keys.push(choice.value);
                input.value = keys.join(',');
            } else input.value = pending.description.command.replace(/\*$/, '').toLowerCase() === 'bibliography'
                ? choice.value.replace(/\.bib$/i, '') : choice.value;
            choice.value = ''; input.focus();
        });
        accept.addEventListener('click', save);
        cancel.addEventListener('click', finish);
        overlay.addEventListener('keydown', event => {
            event.stopPropagation();
            if (event.key === 'Escape') { event.preventDefault(); finish(); }
            else if (event.key === 'Enter' && event.target === input && !event.isComposing) { event.preventDefault(); save(); }
            else if (event.key === 'Tab') {
                const controls = [...(choice.disabled ? [] : [choice]), input, cancel, accept];
                const index = controls.indexOf(document.activeElement);
                event.preventDefault(); controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
            }
        });
        function activate(event) {
            const token = event.target.closest?.('.tex-cmd');
            if (token && editor.contains(token) && open({node: token})) {
                event.preventDefault(); event.stopPropagation();
            }
        }
        editor.addEventListener('click', activate);
        editor.addEventListener('keydown', event => {
            if ((event.key === 'Enter' || event.key === ' ') && !event.isComposing) activate(event);
        });
        return {open: node => open({node}), insert: command => open({command})};
    };
})(globalThis);
