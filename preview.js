/* Local compiler client. Source stays in ProjectModel; PDF results are disposable. */
(function (root) {
    'use strict';

    function kindForFile(file) {
        if (!file) return null;
        if (/\.(ps|eps)$/i.test(file.path)) return 'postscript';
        if (file.kind === 'text' && /\.(tex|latex|ltx)$/i.test(file.path)) return 'latex';
        return null;
    }
    function requestKey(request) {
        return JSON.stringify({kind: request.kind, mainPath: request.mainPath, files: request.project.files});
    }
    function delay(milliseconds, signal) {
        return new Promise((resolve, reject) => {
            if (signal.aborted) { reject(new Error('已取消')); return; }
            const abort = () => { clearTimeout(timer); reject(new Error('已取消')); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
            signal.addEventListener('abort', abort, {once: true});
        });
    }

    class CompilationController {
        constructor({getRequest, fetch: fetcher = root.fetch.bind(root), urls = root.URL,
            sleep = delay, onChange = () => {}, download = () => {}, protocol = root.location?.protocol,
            pollInterval = 600, maxWait = 10 * 60 * 1000}) {
            this.getRequest = getRequest;
            this.fetch = fetcher;
            this.urls = urls;
            this.sleep = sleep;
            this.onChange = onChange;
            this.download = download;
            this.protocol = protocol;
            this.pollInterval = pollInterval;
            this.maxWait = maxWait;
            this.token = null;
            this.engines = {};
            this.phase = 'idle';
            this.message = '正在检测本机编译服务…';
            this.log = '';
            this.result = null;
            this.stale = false;
            this.generation = 0;
            this.jobId = null;
            this.abort = null;
            this.disposed = false;
            this.preview = {state: 'empty', message: '', url: null, key: null, targetKey: null, page: 0, pageCount: 0, maxPages: 100};
            this.previewGeneration = 0;
            this.previewAbort = null;
            this.previewTask = Promise.resolve(false);
        }
        get busy() { return this.phase === 'running'; }
        emit() { if (!this.disposed) this.onChange(this); }
        async responseJson(response) {
            let body;
            try { body = await response.json(); } catch (_) { throw new Error('编译服务返回了无法读取的响应，请检查服务终端。'); }
            if (!response.ok) throw new Error(body.error || '编译服务请求失败（' + response.status + '）');
            return body;
        }
        headers() { return {'X-VisualLaTeX-Token': this.token}; }
        async connect() {
            if (this.busy || this.disposed) return false;
            if (this.protocol !== 'http:' && this.protocol !== 'https:') {
                this.phase = 'unavailable';
                this.message = '编译预览需要本机服务：在项目目录运行 node server.mjs，再打开终端显示的网址。';
                this.emit(); return false;
            }
            try {
                const body = await this.responseJson(await this.fetch('/api/status', {credentials: 'same-origin', cache: 'no-store'}));
                if (!body.token || !body.engines) throw new Error('当前页面没有连接到 VisualLaTeX 编译服务。');
                this.token = body.token;
                this.engines = body.engines;
                this.phase = 'idle';
                this.message = '选择主文件后编译；项目文件仅发送到本机服务。';
                this.emit(); return true;
            } catch (error) {
                this.token = null;
                this.phase = 'unavailable';
                this.message = '无法连接编译服务。请运行 node server.mjs 并打开终端网址。' + error.message;
                this.emit(); return false;
            }
        }
        markChanged() {
            if (this.result) {
                try { this.stale = !this.fresh(this.getRequest()); }
                catch (_) { this.stale = true; }
            }
            this.emit();
        }
        fresh(request) { return Boolean(this.result && this.result.key === requestKey(request)); }
        async deleteJob(id) {
            if (!id || !this.token) return;
            try { await this.fetch('/api/jobs/' + encodeURIComponent(id), {method: 'DELETE', headers: this.headers(), credentials: 'same-origin', keepalive: true}); }
            catch (_) { /* Server timeout/cleanup still bounds an unreachable job. */ }
        }
        async cancel() {
            const id = this.jobId;
            this.generation++;
            this.abort?.abort();
            this.abort = null;
            this.jobId = null;
            this.stopPreview();
            if (this.busy) { this.phase = 'cancelled'; this.message = '已取消本次编译。'; }
            this.emit();
            await this.deleteJob(id);
        }
        clear() {
            this.cancel();
            if (this.result) this.urls.revokeObjectURL(this.result.url);
            this.result = null;
            this.releasePreview();
            this.stale = false;
            this.log = '';
            this.emit();
        }
        stopPreview() {
            this.previewGeneration++;
            this.previewAbort?.abort();
            this.previewAbort = null;
            if (this.preview.state === 'loading') {
                this.preview.state = this.preview.url ? 'ready' : 'empty';
                this.preview.message = this.preview.url ? '' : '页面预览已暂停，可重新编译或导出 PDF。';
            }
        }
        releasePreview() {
            this.stopPreview();
            if (this.preview.url) this.urls.revokeObjectURL(this.preview.url);
            this.preview = {state: 'empty', message: '', url: null, key: null, targetKey: null, page: 0, pageCount: 0, maxPages: 100};
        }
        previewSession(result) {
            this.stopPreview();
            const generation = this.previewGeneration;
            const abort = new AbortController();
            this.previewAbort = abort;
            return {abort, current: () => !this.disposed && this.result === result && generation === this.previewGeneration};
        }
        async previewResponse(url, signal) {
            for (let attempt = 0; ; attempt++) {
                const response = await this.fetch(url, {headers: this.headers(), credentials: 'same-origin', cache: 'no-store', signal});
                if (response.ok) return response;
                let body;
                try { body = await response.json(); } catch (_) { body = {}; }
                if (response.status === 409 && body.code === 'PREVIEW_BUSY' && attempt < 2) {
                    await this.sleep(400, signal); continue;
                }
                throw new Error(body.error || '页面预览暂时不可用；仍可导出 PDF。');
            }
        }
        async loadPreview(result = this.result) {
            if (!result?.jobId || this.disposed) return false;
            const session = this.previewSession(result);
            Object.assign(this.preview, {state: 'loading', message: 'PDF 已生成，正在准备页面预览…', targetKey: result.key, pageCount: 0});
            this.emit();
            try {
                const response = await this.previewResponse('/api/jobs/' + encodeURIComponent(result.jobId) + '/preview', session.abort.signal);
                const metadata = await response.json();
                if (!session.current()) return false;
                if (!metadata.available) {
                    this.preview.state = 'unavailable';
                    this.preview.message = (metadata.reason || '未安装 Ghostscript，无法生成页面图片。') + ' 可使用浏览器原生预览或导出 PDF。';
                    this.emit(); return false;
                }
                if (!Number.isSafeInteger(metadata.pageCount) || metadata.pageCount < 1) throw new Error('无法读取 PDF 页数；仍可导出 PDF。');
                this.preview.pageCount = metadata.pageCount;
                this.preview.maxPages = Math.min(100, Number.isSafeInteger(metadata.maxPages) && metadata.maxPages > 0 ? metadata.maxPages : 100);
                return await this.loadPage(1);
            } catch (error) {
                if (!session.current()) return false;
                this.preview.state = 'failed';
                this.preview.message = '页面预览失败：' + error.message + ' PDF 仍可导出。';
                this.emit(); return false;
            } finally { if (session.current()) this.previewAbort = null; }
        }
        async loadPage(page) {
            const result = this.result;
            if (!result || this.preview.targetKey !== result.key || !Number.isSafeInteger(page) || page < 1 ||
                page > Math.min(this.preview.pageCount, this.preview.maxPages) || this.disposed) return false;
            const session = this.previewSession(result);
            this.preview.state = 'loading';
            this.preview.message = '正在加载第 ' + page + ' 页…';
            this.emit();
            try {
                const response = await this.previewResponse('/api/jobs/' + encodeURIComponent(result.jobId) + '/preview/' + page, session.abort.signal);
                const blob = await response.blob();
                if (!session.current()) return false;
                if (!blob.size || (blob.type && !/^image\/png(?:;|$)/i.test(blob.type))) throw new Error('服务未返回有效页面图片。');
                const url = this.urls.createObjectURL(new Blob([blob], {type: 'image/png'}));
                if (this.preview.url) this.urls.revokeObjectURL(this.preview.url);
                Object.assign(this.preview, {state: 'ready', message: '', url, key: result.key, page});
                this.emit(); return true;
            } catch (error) {
                if (!session.current()) return false;
                this.preview.state = 'failed';
                this.preview.message = '页面加载失败：' + error.message + ' 可重试或导出 PDF。';
                this.emit(); return false;
            } finally { if (session.current()) this.previewAbort = null; }
        }
        async compile() {
            if (this.busy || this.disposed) return false;
            let request;
            try {
                request = this.getRequest();
                if (!request.kind || !request.mainPath) throw new Error('请选择一个 LaTeX、PS 或 EPS 主文件。');
                if (!this.token) throw new Error(this.message);
                if (!this.engines[request.kind]?.available) throw new Error(request.kind === 'latex'
                    ? '未找到 LaTeX 引擎。安装 Tectonic 或 XeLaTeX 后重启本机服务。'
                    : '未找到 Ghostscript。安装后重启本机服务以渲染 PS/EPS。');
            } catch (error) { this.phase = 'failed'; this.message = error.message; this.emit(); return false; }
            const generation = ++this.generation;
            this.stopPreview();
            const snapshot = requestKey(request);
            const abort = new AbortController();
            this.abort = abort;
            this.phase = 'running';
            this.message = request.kind === 'postscript' ? '正在渲染 PostScript…' : '正在编译 LaTeX…';
            this.log = '';
            this.emit();
            let job;
            try {
                job = await this.responseJson(await this.fetch('/api/compile', {
                    method: 'POST', headers: {...this.headers(), 'Content-Type': 'application/json'},
                    credentials: 'same-origin', body: JSON.stringify(request), signal: abort.signal
                }));
                if (typeof job.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(job.id)) throw new Error('编译服务返回的任务编号无效。');
                if (generation !== this.generation) { await this.deleteJob(job.id); return false; }
                this.jobId = job.id;
                const started = Date.now();
                for (;;) {
                    const progress = await this.responseJson(await this.fetch('/api/jobs/' + encodeURIComponent(job.id), {
                        headers: this.headers(), credentials: 'same-origin', cache: 'no-store', signal: abort.signal
                    }));
                    if (generation !== this.generation) return false;
                    this.log = typeof progress.log === 'string' ? progress.log : '';
                    this.emit();
                    if (progress.state === 'failed') throw new Error(progress.error || '编译失败，请查看日志。');
                    if (progress.state === 'cancelled') throw new Error('本次编译已取消。');
                    if (progress.state === 'succeeded') {
                        const pdfUrl = '/api/jobs/' + encodeURIComponent(job.id) + '/pdf';
                        if (progress.pdfUrl && progress.pdfUrl !== pdfUrl) throw new Error('编译服务返回的 PDF 路径无效。');
                        const response = await this.fetch(pdfUrl, {headers: this.headers(), credentials: 'same-origin', signal: abort.signal});
                        if (!response.ok) { await this.responseJson(response); throw new Error('无法下载编译结果。'); }
                        const blob = await response.blob();
                        if (generation !== this.generation) return false;
                        // A late result must not replace the preview of a different
                        // project or source revision, even if its fetch ignored abort.
                        if (snapshot !== requestKey(this.getRequest())) {
                            this.phase = 'stale';
                            this.message = '源码或编译目标已改变，本次结果未替换预览。请重新编译。';
                            this.stale = Boolean(this.result);
                            this.emit(); return false;
                        }
                        if (blob.size === 0) throw new Error('编译器没有生成 PDF 内容。');
                        const url = this.urls.createObjectURL(new Blob([blob], {type: 'application/pdf'}));
                        if (this.result) this.urls.revokeObjectURL(this.result.url);
                        this.result = {url, key: snapshot, jobId: job.id, mainPath: request.mainPath, engine: progress.engine || '', size: blob.size};
                        this.stale = false;
                        this.phase = 'succeeded';
                        this.message = request.mainPath + ' · PDF 已更新';
                        this.emit();
                        this.previewTask = this.loadPreview(this.result);
                        return true;
                    }
                    if (progress.state !== 'running') throw new Error('无法识别编译任务状态。');
                    if (Date.now() - started > this.maxWait) throw new Error('编译等待超时，请检查日志或重试。');
                    await this.sleep(this.pollInterval, abort.signal);
                }
            } catch (error) {
                if (generation !== this.generation) return false;
                this.phase = 'failed';
                this.message = error.message || '编译失败，请查看日志。';
                this.stale = Boolean(this.result);
                this.emit();
                // A failed polling/download request does not stop the engine.
                // Release the known job before discarding its id, while keeping
                // the original error visible if cleanup itself cannot connect.
                await this.deleteJob(job?.id);
                return false;
            } finally {
                if (generation === this.generation) { this.abort = null; this.jobId = null; }
            }
        }
        async exportPdf() {
            if (this.busy) return false;
            try {
                const request = this.getRequest();
                if (!this.fresh(request) && !await this.compile()) return false;
                if (!this.fresh(this.getRequest())) return false;
                this.stale = false;
                this.download(this.result.url, this.result.mainPath.split('/').pop().replace(/\.[^.]+$/, '') + '.pdf');
                this.emit(); return true;
            } catch (error) { this.message = error.message; this.emit(); return false; }
        }
        destroy() {
            this.disposed = true;
            this.cancel();
            if (this.result) this.urls.revokeObjectURL(this.result.url);
            this.result = null;
            this.releasePreview();
        }
    }

    function initCompilation(app) {
        const $ = id => document.getElementById(id);
        let lastModel = app.model;
        let lastMainPath = app.model.mainPath;
        let targetList = '';
        let shownUrl = null;
        let shownPageUrl = null;
        const preview = $('pdfPreviewPane');
        function showPreview(show = true) {
            preview.hidden = !show;
            document.body.classList.toggle('compilation-visible', show);
            $('btnTogglePreview').setAttribute('aria-expanded', String(show));
        }
        function targets() {
            const files = app.model.list().filter(kindForFile);
            const signature = JSON.stringify(files.map(file => file.path));
            const mainChanged = app.model.mainPath !== lastMainPath;
            if (signature !== targetList || app.model !== lastModel || mainChanged) {
                const old = app.model === lastModel ? $('compileTarget').value : null;
                $('compileTarget').replaceChildren();
                for (const file of files) {
                    const option = document.createElement('option');
                    option.value = file.path; option.textContent = file.path;
                    $('compileTarget').appendChild(option);
                }
                $('compileTarget').value = mainChanged && files.some(file => file.path === app.model.mainPath) ? app.model.mainPath
                    : files.some(file => file.path === old) ? old
                    : files.some(file => file.path === app.model.mainPath) ? app.model.mainPath : files[0]?.path || '';
                targetList = signature;
                lastMainPath = app.model.mainPath;
            }
        }
        const controller = new CompilationController({
            getRequest() {
                app.sync();
                targets();
                const mainPath = $('compileTarget').value;
                const file = app.model.get(mainPath);
                return {project: JSON.parse(app.model.serialize()), kind: kindForFile(file), mainPath};
            },
            onChange: render,
            download(url, name) {
                const link = document.createElement('a'); link.href = url; link.download = name;
                document.body.appendChild(link); link.click(); link.remove();
            }
        });
        function render() {
            const kind = kindForFile(app.model.get($('compileTarget').value));
            const engine = controller.engines[kind];
            $('btnCompile').disabled = controller.busy || !controller.token || !kind;
            $('btnCompile').textContent = kind === 'postscript' ? '渲染预览' : '编译预览';
            $('btnCancelCompile').hidden = !controller.busy;
            $('btnExportPdf').disabled = controller.busy || !controller.token || !kind;
            $('compileTarget').disabled = controller.busy;
            $('btnCompilerRetry').disabled = controller.busy;
            $('compilerStatus').textContent = engine?.available ? engine.label : controller.token ? (kind === 'postscript' ? '需要 Ghostscript' : '需要 LaTeX 引擎') : '本机编译';
            $('compileStatus').textContent = controller.message;
            $('compileStatus').dataset.state = controller.phase;
            $('compileLog').textContent = controller.log || '编译后将在这里显示引擎日志。';
            $('previewStale').hidden = !controller.stale;
            $('previewStale').textContent = '当前显示上一次结果；请重新编译以反映最新源码。';
            $('pdfEmpty').hidden = Boolean(controller.result);
            const page = controller.preview;
            const showingImage = Boolean(page.url && controller.result && (page.key === controller.result.key || page.state === 'loading'));
            $('pdfPageView').hidden = !showingImage;
            $('pdfFrame').hidden = !controller.result || showingImage || page.state === 'loading';
            $('pagePreviewStatus').hidden = !controller.result || !page.message;
            $('pagePreviewStatus').textContent = page.message;
            const knownPages = Boolean(controller.result && page.targetKey === controller.result.key && page.pageCount);
            $('previewPageControls').hidden = !knownPages;
            const currentPage = page.key === controller.result?.key ? page.page : 0;
            const limit = Math.min(page.pageCount, page.maxPages);
            $('previewPageNumber').textContent = (currentPage || '—') + ' / ' + page.pageCount + (page.pageCount > page.maxPages ? '（预览前 ' + page.maxPages + ' 页）' : '');
            $('btnPreviousPage').disabled = page.state === 'loading' || currentPage <= 1;
            $('btnNextPage').disabled = page.state === 'loading' || !currentPage || currentPage >= limit;
            $('btnRetryPage').hidden = !controller.result || !['failed', 'unavailable', 'empty'].includes(page.state);
            $('previewStale').hidden = !controller.stale && !(showingImage && page.key !== controller.result.key);
            $('previewStale').textContent = showingImage && page.key !== controller.result.key
                ? '当前仍显示上一次编译的页面，正在加载新结果。' : '当前显示上一次结果；请重新编译以反映最新源码。';
            $('pdfOpen').hidden = !controller.result;
            if (page.url !== shownPageUrl) {
                shownPageUrl = page.url;
                if (shownPageUrl) $('pdfPageImage').src = shownPageUrl;
                else $('pdfPageImage').removeAttribute('src');
            }
            $('pdfPageImage').alt = 'PDF 第 ' + (page.page || 1) + ' 页';
            if (controller.result?.url !== shownUrl) {
                shownUrl = controller.result?.url || null;
                if (shownUrl) { $('pdfFrame').src = shownUrl; $('pdfOpen').href = shownUrl; }
                else { $('pdfFrame').removeAttribute('src'); $('pdfOpen').removeAttribute('href'); }
            }
            $('previewDocument').textContent = controller.result ? controller.result.mainPath : '尚未生成 PDF';
            if (controller.phase === 'failed') $('compileLogs').open = true;
        }
        targets();
        const previousChange = app.onChange;
        app.onChange = () => {
            previousChange();
            targets();
            if (app.model !== lastModel) { lastModel = app.model; controller.clear(); }
            else controller.markChanged();
            render();
        };
        $('compileTarget').addEventListener('change', () => { controller.markChanged(); render(); });
        $('setMainFile').addEventListener('click', () => {
            targets();
            // An explicit "set main file" action also wins when this file was
            // already main but the preview dropdown was manually set elsewhere.
            if (kindForFile(app.model.get(app.model.mainPath))) $('compileTarget').value = app.model.mainPath;
            controller.markChanged(); render();
        });
        $('btnTogglePreview').addEventListener('click', () => showPreview(preview.hidden));
        $('btnClosePreview').addEventListener('click', () => showPreview(false));
        $('btnCompile').addEventListener('click', () => { showPreview(); controller.compile(); });
        $('btnCancelCompile').addEventListener('click', () => controller.cancel());
        $('btnExportPdf').addEventListener('click', () => { showPreview(); controller.exportPdf(); });
        $('btnCompilerRetry').addEventListener('click', () => controller.connect());
        $('btnPreviousPage').addEventListener('click', () => { controller.previewTask = controller.loadPage(controller.preview.page - 1); });
        $('btnNextPage').addEventListener('click', () => { controller.previewTask = controller.loadPage(controller.preview.page + 1); });
        $('btnRetryPage').addEventListener('click', () => { controller.previewTask = controller.loadPreview(); });
        document.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault(); showPreview(); controller.compile();
            }
        });
        window.addEventListener('pagehide', event => {
            if (event.persisted) controller.cancel();
            else controller.destroy();
        });
        window.addEventListener('pageshow', event => {
            if (!event.persisted) return;
            targets(); controller.markChanged();
            controller.connect().then(connected => {
                if (connected && controller.result && (!controller.preview.url || controller.preview.key !== controller.result.key)) {
                    controller.previewTask = controller.loadPreview();
                }
            });
        });
        app.compilation = controller;
        render();
        controller.connect();
        return controller;
    }
    root.CompilationController = CompilationController;
    root.compilationKindForFile = kindForFile;
    root.initCompilation = initCompilation;
})(globalThis);
