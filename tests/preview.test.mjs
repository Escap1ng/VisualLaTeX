import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../preview.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const engines = {latex: {available: true, engine: 'tectonic', label: 'Tectonic'},
    postscript: {available: true, engine: 'ghostscript', label: 'Ghostscript'}};
const json = (body, status = 200) => ({ok: status < 400, status, json: async () => body});
const pdf = () => ({ok: true, blob: async () => new Blob(['%PDF-1.4\nfixture\n%%EOF'], {type: 'application/pdf'})});
const makeRequest = () => ({kind: 'latex', mainPath: 'main.tex', project: {name: 'Project', mainPath: 'main.tex', activePath: 'main.tex',
    files: [{path: 'main.tex', kind: 'text', text: '\\documentclass{article}\n\\begin{document}Original\\end{document}'},
        {path: 'figure.eps', kind: 'binary', base64: 'xdDTxgABAv8='}]}});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

function fixture(options = {}) {
    const calls = [], created = [], revoked = [], downloads = [];
    let request = makeRequest();
    let job = 0;
    const controls = {status: 'succeeded', log: 'engine log', error: 'Undefined command'};
    const urls = {createObjectURL(blob) { const url = 'blob:fixture/' + (created.length + 1); created.push({url, blob}); return url; },
        revokeObjectURL: url => revoked.push(url)};
    const fetcher = async (url, init = {}) => {
        calls.push({url, init});
        const custom = await options.route?.(url, init, {calls, controls});
        if (custom !== undefined) return custom;
        if (url === '/api/status') return json({token: 'test-token', engines});
        if (url === '/api/compile') return json({id: 'job-' + ++job}, 202);
        if (init.method === 'DELETE') return json({state: 'cancelled'});
        if (url.endsWith('/pdf')) return pdf();
        if (url.endsWith('/preview')) return json({available: false, reason: 'Ghostscript not configured'});
        if (url.startsWith('/api/jobs/')) return json({state: controls.status, log: controls.log, error: controls.error, engine: 'Tectonic', pdfUrl: url + '/pdf'});
        throw new Error('Unexpected request ' + url);
    };
    const context = vm.createContext({Blob, AbortController, setTimeout, clearTimeout, URL: urls, fetch: fetcher, location: {protocol: 'http:'}, ...options.context});
    vm.runInContext(code, context);
    const controller = new context.CompilationController({getRequest: () => structuredClone(request), fetch: fetcher, urls,
        sleep: options.sleep || (async () => {}), protocol: options.protocol || 'http:', maxWait: options.maxWait,
        download: (url, name) => downloads.push({url, name})});
    return {controller, context, controls, calls, created, revoked, downloads,
        get request() { return request; }, set request(next) { request = next; }};
}

test('compile targets include binary EPS but not unrelated resources', () => {
    const f = fixture();
    assert.equal(f.context.compilationKindForFile({path: 'main.tex', kind: 'text'}), 'latex');
    assert.equal(f.context.compilationKindForFile({path: 'custom.ltx', kind: 'text'}), 'latex');
    assert.equal(f.context.compilationKindForFile({path: 'figure.EPS', kind: 'binary'}), 'postscript');
    assert.equal(f.context.compilationKindForFile({path: 'image.pdf', kind: 'binary'}), null);
});

test('file mode makes no requests and explains how to enable local compilation', async () => {
    const f = fixture({protocol: 'file:'});
    assert.equal(await f.controller.connect(), false);
    assert.equal(f.controller.phase, 'unavailable');
    assert.match(f.controller.message, /node server\.mjs/);
    assert.equal(await f.controller.compile(), false);
    assert.equal(f.calls.length, 0);
});

test('successful compilation sends an immutable project snapshot and exports the current PDF', async () => {
    const f = fixture();
    const original = structuredClone(f.request);
    assert.equal(await f.controller.connect(), true);
    assert.equal(await f.controller.compile(), true);
    assert.equal(f.controller.phase, 'succeeded');
    const submitted = f.calls.find(call => call.url === '/api/compile');
    assert.deepEqual(JSON.parse(submitted.init.body), original);
    assert.equal(submitted.init.headers['Content-Type'], 'application/json');
    for (const call of f.calls.filter(call => call.url !== '/api/status')) assert.equal(call.init.headers['X-VisualLaTeX-Token'], 'test-token');
    assert.deepEqual(f.request, original);
    assert.equal(f.controller.log, 'engine log');
    assert.equal(await f.controller.exportPdf(), true);
    assert.deepEqual(f.downloads, [{url: 'blob:fixture/1', name: 'main.pdf'}]);
    assert.equal(f.calls.filter(call => call.url === '/api/compile').length, 1);
});

test('editing a dependency makes PDF stale and export recompiles before downloading', async () => {
    const f = fixture();
    await f.controller.connect(); await f.controller.compile();
    f.request.project.files[1].base64 = 'bmV3';
    f.controller.markChanged();
    assert.equal(f.controller.stale, true);
    assert.equal(await f.controller.exportPdf(), true);
    assert.equal(f.calls.filter(call => call.url === '/api/compile').length, 2);
    assert.deepEqual(f.downloads, [{url: 'blob:fixture/2', name: 'main.pdf'}]);
    assert.deepEqual(f.revoked, ['blob:fixture/1']);
    assert.equal(f.controller.stale, false);
});

test('changing only project name or active editor does not invalidate identical compilation input', async () => {
    const f = fixture();
    await f.controller.connect(); await f.controller.compile();
    f.request.project.name = 'Renamed'; f.request.project.activePath = 'figure.eps';
    f.controller.markChanged();
    assert.equal(f.controller.stale, false);
});

test('compile failure keeps prior preview and diagnostic log but never exports stale source', async () => {
    const f = fixture();
    await f.controller.connect(); await f.controller.compile();
    f.request.project.files[0].text += '\\invalidcommand';
    f.controls.status = 'failed'; f.controls.log = 'main.tex:4: Undefined command';
    assert.equal(await f.controller.exportPdf(), false);
    assert.equal(f.controller.result.url, 'blob:fixture/1');
    assert.equal(f.controller.phase, 'failed');
    assert.equal(f.controller.stale, true);
    assert.match(f.controller.log, /main\.tex:4/);
    assert.equal(f.downloads.length, 0);
    assert.equal(f.revoked.length, 0);
});

test('source changes while PDF bytes arrive prevent that result from replacing the preview', async () => {
    let f;
    f = fixture({route: async url => {
        if (url.endsWith('/pdf')) return {ok: true, blob: async () => {
            f.request.project.files[0].text = 'newer edit';
            return new Blob(['%PDF-1.4']);
        }};
    }});
    await f.controller.connect();
    assert.equal(await f.controller.compile(), false);
    assert.equal(f.controller.phase, 'stale');
    assert.equal(f.controller.result, null);
    assert.equal(f.created.length, 0);
});

test('cancellation aborts the client, deletes a known job and ignores late polling success', async () => {
    const progress = deferred();
    const ready = deferred();
    const f = fixture({route: async (url, init) => {
        if (url === '/api/jobs/job-1' && init.method !== 'DELETE') { ready.resolve(); return progress.promise; }
    }});
    await f.controller.connect();
    const running = f.controller.compile();
    await ready.promise;
    const abort = f.controller.abort;
    assert.equal(await f.controller.connect(), false, 'connection retry cannot reset a running job');
    await f.controller.cancel();
    assert.equal(abort.signal.aborted, true);
    progress.resolve(json({state: 'succeeded'}));
    assert.equal(await running, false);
    assert.equal(f.controller.phase, 'cancelled');
    assert.ok(f.calls.some(call => call.url === '/api/jobs/job-1' && call.init.method === 'DELETE'));
    assert.equal(f.created.length, 0);
});

test('cancellation before POST resolves deletes a late job id without starting another preview', async () => {
    const response = deferred(), ready = deferred();
    const f = fixture({route: async url => { if (url === '/api/compile') { ready.resolve(); return response.promise; } }});
    await f.controller.connect();
    const running = f.controller.compile();
    await ready.promise;
    await f.controller.cancel();
    response.resolve(json({id: 'late-job'}, 202));
    assert.equal(await running, false);
    assert.ok(f.calls.some(call => call.url === '/api/jobs/late-job' && call.init.method === 'DELETE'));
    assert.equal(f.created.length, 0);
});

test('untrusted PDF URLs are rejected rather than fetched with the session token', async () => {
    const f = fixture({route: async url => {
        if (url === '/api/jobs/job-1') return json({state: 'succeeded', pdfUrl: 'https://external.example/pdf'});
    }});
    await f.controller.connect();
    assert.equal(await f.controller.compile(), false);
    assert.match(f.controller.message, /PDF 路径无效/);
    assert.equal(f.calls.some(call => call.url.startsWith('https:')), false);
});

test('bounded polling cancels the server job when the wait expires', async () => {
    const f = fixture({maxWait: -1});
    f.controls.status = 'running';
    await f.controller.connect();
    assert.equal(await f.controller.compile(), false);
    assert.match(f.controller.message, /超时/);
    assert.ok(f.calls.some(call => call.init.method === 'DELETE'));
});

test('a polling network failure cancels its known server job and allows a fresh compilation', async () => {
    let failPolling = true;
    const f = fixture({route: async (url, init) => {
        if (url === '/api/jobs/job-1' && init.method !== 'DELETE' && failPolling) {
            failPolling = false;
            throw new TypeError('Failed to fetch progress');
        }
    }});
    await f.controller.connect();
    assert.equal(await f.controller.compile(), false);
    assert.equal(f.controller.phase, 'failed');
    assert.equal(f.controller.message, 'Failed to fetch progress');
    assert.equal(f.controller.jobId, null);
    assert.ok(f.calls.some(call => call.url === '/api/jobs/job-1' && call.init.method === 'DELETE'));
    assert.equal(await f.controller.compile(), true);
    assert.equal(f.controller.phase, 'succeeded');
    assert.equal(f.calls.filter(call => call.url === '/api/compile').length, 2);
    assert.equal(f.created.length, 1);
});

test('late failure cleanup cannot clear the id or abort controller of a newer compilation', async () => {
    const cleanup = deferred(), cleanupStarted = deferred(), progress = deferred(), progressStarted = deferred();
    const f = fixture({route: async (url, init) => {
        if (url === '/api/jobs/job-1' && init.method !== 'DELETE') throw new Error('Polling disconnected');
        if (url === '/api/jobs/job-1' && init.method === 'DELETE') { cleanupStarted.resolve(); return cleanup.promise; }
        if (url === '/api/jobs/job-2' && init.method !== 'DELETE') { progressStarted.resolve(); return progress.promise; }
    }});
    await f.controller.connect();
    const first = f.controller.compile();
    await cleanupStarted.promise;
    assert.equal(f.controller.message, 'Polling disconnected');
    const second = f.controller.compile();
    await progressStarted.promise;
    const abort = f.controller.abort;
    cleanup.resolve(json({state: 'cancelled'}));
    assert.equal(await first, false);
    assert.equal(f.controller.jobId, 'job-2');
    assert.equal(f.controller.abort, abort);
    assert.equal(f.controller.phase, 'running');
    progress.resolve(json({state: 'succeeded', pdfUrl: '/api/jobs/job-2/pdf'}));
    assert.equal(await second, true);
});

test('replacing a project or destroying its view releases object URLs and pending work', async () => {
    const f = fixture();
    await f.controller.connect(); await f.controller.compile();
    f.controller.clear();
    assert.equal(f.controller.result, null);
    assert.deepEqual(f.revoked, ['blob:fixture/1']);
    await f.controller.compile();
    f.controller.destroy();
    assert.deepEqual(f.revoked, ['blob:fixture/1', 'blob:fixture/2']);
    assert.equal(await f.controller.compile(), false);
});

test('missing engines and HTTP errors give actionable errors without mutating the project', async () => {
    const f = fixture({route: async url => url === '/api/status' ? json({token: 'token', engines: {latex: {available: false}}}) : undefined});
    const original = structuredClone(f.request);
    await f.controller.connect();
    assert.equal(await f.controller.compile(), false);
    assert.match(f.controller.message, /Tectonic|XeLaTeX/);
    assert.deepEqual(f.request, original);
    assert.equal(f.calls.length, 1);
    const disconnected = fixture({route: async () => json({error: 'Service unavailable'}, 503)});
    assert.equal(await disconnected.controller.connect(), false);
    assert.equal(disconnected.controller.phase, 'unavailable');
});

test('preview markup has every production control, accessible labels and initially hidden PDF', () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
    for (const match of code.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.has(match[1]), match[1]);
    assert.match(html, /<select id="compileTarget"[^>]+aria-label=/);
    assert.match(html, /<iframe id="pdfFrame"[^>]+title="[^"]+" hidden>/);
    assert.match(html, /id="btnTogglePreview"[^>]+aria-controls="pdfPreviewPane"[^>]+aria-expanded="false"/);
    assert.match(html, /id="compileStatus"[^>]+aria-live="polite"/);
    assert.doesNotMatch(code, /\.innerHTML\s*=/, 'compiler logs and source names must stay inert text');
});

async function workspaceFixture(options = {}) {
    const ids = new Map();
    function element(id = '') {
        const events = new Map(), attributes = new Map();
        return {id, value: '', hidden: false, disabled: false, dataset: {}, children: [],
            addEventListener(type, handler) { events.set(type, handler); },
            emit(type, event = {}) { return events.get(type)?.(event); },
            setAttribute(name, value) { attributes.set(name, value); },
            getAttribute(name) { return attributes.get(name); },
            removeAttribute(name) { attributes.delete(name); },
            replaceChildren() { this.children = []; },
            appendChild(child) { this.children.push(child); },
            click() {}, remove() {}, classList: {toggle() {}}
        };
    }
    for (const match of html.matchAll(/\bid="([^"]+)"/g)) ids.set(match[1], element(match[1]));
    ids.get('pdfPreviewPane').hidden = true;
    const document = element();
    document.getElementById = id => ids.get(id);
    document.createElement = () => element();
    document.body = element();
    const window = element();
    const f = fixture({...options, context: {document, window}});
    const project = structuredClone(f.request.project);
    const model = {
        mainPath: project.mainPath,
        list: () => project.files,
        get: path => project.files.find(file => file.path === path),
        serialize: () => JSON.stringify(project)
    };
    let syncs = 0, renders = 0;
    const app = {model, sync() { syncs++; }, onChange() { renders++; }};
    const controller = f.context.initCompilation(app);
    while (!controller.token) await new Promise(resolve => setImmediate(resolve));
    return {...f, ids, window, project, model, app, controller, syncCount: () => syncs, renderCount: () => renders};
}

test('workspace integration binds target selection, compilation, PDF display and project replacement', async () => {
    const f = await workspaceFixture();
    const {ids, window, project, model, app, controller} = f;
    assert.equal(ids.get('compileTarget').value, 'main.tex');
    assert.equal(ids.get('compileTarget').children.length, 2);
    assert.equal(ids.get('btnCompile').disabled, false);
    ids.get('compileTarget').value = 'figure.eps';
    ids.get('compileTarget').emit('change');
    assert.equal(ids.get('btnCompile').textContent, '渲染预览');
    assert.equal(ids.get('compilerStatus').textContent, 'Ghostscript');
    ids.get('btnCompile').emit('click');
    while (controller.busy) await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.syncCount() > 0);
    assert.equal(controller.phase, 'succeeded');
    assert.equal(ids.get('pdfPreviewPane').hidden, false);
    assert.equal(ids.get('pdfFrame').src, 'blob:fixture/1');
    assert.equal(ids.get('pdfFrame').hidden, false);
    assert.equal(ids.get('pdfOpen').href, 'blob:fixture/1');
    const submitted = JSON.parse(f.calls.find(call => call.url === '/api/compile').init.body);
    assert.equal(submitted.kind, 'postscript');
    assert.equal(submitted.mainPath, 'figure.eps');
    app.onChange();
    assert.equal(ids.get('compileTarget').value, 'figure.eps', 'ordinary edits preserve the selected compile target');
    ids.get('setMainFile').emit('click');
    assert.equal(ids.get('compileTarget').value, 'main.tex', 'explicitly setting the existing main file wins over a manual preview target');
    model.mainPath = 'figure.eps';
    ids.get('setMainFile').emit('click');
    model.mainPath = 'main.tex';
    ids.get('setMainFile').emit('click');
    assert.equal(ids.get('compileTarget').value, 'main.tex', 'setting a different main file updates the compile target immediately');
    ids.get('compileTarget').value = 'figure.eps';
    window.emit('pagehide', {persisted: true});
    assert.equal(controller.disposed, false);
    assert.equal(controller.result.url, 'blob:fixture/1');
    window.emit('pageshow', {persisted: true});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.disposed, false);
    assert.equal(ids.get('btnCompile').disabled, false);
    project.files[1].base64 = 'changed';
    app.onChange();
    assert.equal(f.renderCount(), 2);
    assert.equal(ids.get('previewStale').hidden, false);
    app.model = {...model};
    app.onChange();
    assert.equal(controller.result, null);
    assert.equal(ids.get('pdfFrame').hidden, true);
    assert.deepEqual(f.revoked, ['blob:fixture/1']);
    assert.equal(await controller.compile(), true, 'BFCache restoration keeps the controller able to compile');
    window.emit('pagehide', {persisted: false});
    assert.equal(controller.disposed, true);
});

test('BFCache resumes the new PDF page when a previous image remains during an interrupted render', async () => {
    const pending = deferred(), started = deferred(), resumed = deferred();
    let secondPageRequests = 0;
    const f = await workspaceFixture({route: async url => {
        if (url.endsWith('/preview')) return json({available: true, pageCount: 1, maxPages: 100});
        if (url === '/api/jobs/job-1/preview/1') return {ok: true, blob: async () => new Blob(['first'], {type: 'image/png'})};
        if (url === '/api/jobs/job-2/preview/1') {
            if (++secondPageRequests === 1) { started.resolve(); return pending.promise; }
            resumed.resolve();
            return {ok: true, blob: async () => new Blob(['second'], {type: 'image/png'})};
        }
    }});
    await f.controller.compile(); await f.controller.previewTask;
    const previousImage = f.controller.preview.url;
    f.project.files[0].text += '\nUpdated source'; f.app.onChange();
    await f.controller.compile();
    await started.promise;
    const interrupted = f.controller.previewTask;
    assert.equal(f.controller.preview.url, previousImage);
    assert.notEqual(f.controller.preview.key, f.controller.result.key);
    f.window.emit('pagehide', {persisted: true});
    f.window.emit('pageshow', {persisted: true});
    await resumed.promise;
    assert.equal(await f.controller.previewTask, true);
    assert.equal(f.controller.preview.key, f.controller.result.key);
    assert.notEqual(f.controller.preview.url, previousImage);
    assert.equal(f.ids.get('pdfPageView').hidden, false);
    assert.equal(f.ids.get('pdfFrame').hidden, true);
    assert.ok(f.revoked.includes(previousImage));
    const currentImage = f.controller.preview.url;
    pending.resolve({ok: true, blob: async () => new Blob(['late'], {type: 'image/png'})});
    assert.equal(await interrupted, false);
    assert.equal(f.controller.preview.url, currentImage);
});

test('page images load independently of PDF export and pagination replaces only the image URL', async () => {
    const imageResponse = deferred(), imageStarted = deferred();
    const f = fixture({route: async url => {
        if (url.endsWith('/preview')) return json({available: true, pageCount: 3, maxPages: 100});
        if (url.endsWith('/preview/1')) { imageStarted.resolve(); return imageResponse.promise; }
        if (url.endsWith('/preview/2')) return {ok: true, blob: async () => new Blob(['png2'], {type: 'image/png'})};
    }});
    await f.controller.connect();
    assert.equal(await f.controller.compile(), true);
    await imageStarted.promise;
    assert.equal(f.controller.preview.state, 'loading');
    assert.equal(await f.controller.exportPdf(), true, 'PDF download does not wait for image rendering');
    assert.deepEqual(f.downloads, [{url: 'blob:fixture/1', name: 'main.pdf'}]);
    imageResponse.resolve({ok: true, blob: async () => new Blob(['png1'], {type: 'image/png'})});
    assert.equal(await f.controller.previewTask, true);
    assert.equal(f.controller.preview.url, 'blob:fixture/2');
    assert.equal(f.controller.preview.page, 1);
    assert.equal(f.controller.preview.pageCount, 3);
    assert.equal(await f.controller.loadPage(2), true);
    assert.equal(f.controller.preview.page, 2);
    assert.equal(f.controller.preview.url, 'blob:fixture/3');
    assert.deepEqual(f.revoked, ['blob:fixture/2']);
    assert.equal(f.controller.result.url, 'blob:fixture/1');
    for (const call of f.calls.filter(call => call.url.includes('/preview'))) assert.equal(call.init.headers['X-VisualLaTeX-Token'], 'test-token');
    f.controller.destroy();
    assert.deepEqual(f.revoked, ['blob:fixture/2', 'blob:fixture/1', 'blob:fixture/3']);
});

test('missing Ghostscript falls back without invalidating a successful downloadable PDF', async () => {
    const f = fixture();
    await f.controller.connect(); await f.controller.compile();
    assert.equal(await f.controller.previewTask, false);
    assert.equal(f.controller.phase, 'succeeded');
    assert.equal(f.controller.preview.state, 'unavailable');
    assert.match(f.controller.preview.message, /原生预览|导出 PDF/);
    assert.equal(await f.controller.exportPdf(), true);
});

test('a delayed page from a previous project cannot create an image after the project is cleared', async () => {
    const page = deferred(), started = deferred();
    const f = fixture({route: async url => {
        if (url.endsWith('/preview')) return json({available: true, pageCount: 1, maxPages: 100});
        if (url.endsWith('/preview/1')) { started.resolve(); return page.promise; }
    }});
    await f.controller.connect(); await f.controller.compile();
    await started.promise;
    const rendering = f.controller.previewTask;
    f.controller.clear();
    page.resolve({ok: true, blob: async () => new Blob(['late'], {type: 'image/png'})});
    assert.equal(await rendering, false);
    assert.equal(f.controller.preview.url, null);
    assert.equal(f.created.length, 1, 'only the old PDF URL was created');
    assert.deepEqual(f.revoked, ['blob:fixture/1']);
});

test('failed recompilation preserves the last page image with stale source status', async () => {
    const f = fixture({route: async url => {
        if (url.endsWith('/preview')) return json({available: true, pageCount: 1});
        if (url.endsWith('/preview/1')) return {ok: true, blob: async () => new Blob(['png'], {type: 'image/png'})};
    }});
    await f.controller.connect(); await f.controller.compile(); await f.controller.previewTask;
    f.request.project.files[0].text += '\\invalid';
    f.controller.markChanged();
    f.controls.status = 'failed';
    assert.equal(await f.controller.compile(), false);
    assert.equal(f.controller.preview.url, 'blob:fixture/2');
    assert.equal(f.controller.stale, true);
    assert.equal(f.controller.result.url, 'blob:fixture/1');
});

test('busy page rendering retries within a bounded budget and pages above the preview cap are not fetched', async () => {
    let attempts = 0;
    const f = fixture({route: async url => {
        if (url.endsWith('/preview')) return json({available: true, pageCount: 180, maxPages: 100});
        if (url.endsWith('/preview/1')) {
            if (++attempts < 3) return json({code: 'PREVIEW_BUSY', error: 'Please retry'}, 409);
            return {ok: true, blob: async () => new Blob(['png'], {type: 'image/png'})};
        }
    }});
    await f.controller.connect(); await f.controller.compile();
    assert.equal(await f.controller.previewTask, true);
    assert.equal(attempts, 3);
    assert.equal(await f.controller.loadPage(101), false);
    assert.equal(f.calls.some(call => call.url.endsWith('/preview/101')), false);
    assert.equal(await f.controller.exportPdf(), true);
});
