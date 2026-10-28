import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createWorkspaceServer} from '../server.mjs';

const PDF = Buffer.from('%PDF-1.4\nfixture bytes\n%%EOF');
const ENGINES = {latex: {available: true, engine: 'tectonic', label: 'Tectonic', executable: '/private/tectonic'},
    postscript: {available: true, engine: 'ghostscript', label: 'Ghostscript'}};
const payload = {kind: 'latex', mainPath: 'main.tex', project: {format: 'visual-workspace', version: 1,
    name: 'Example', mainPath: 'main.tex', activePath: 'main.tex', files: [{path: 'main.tex', kind: 'text', text: 'source'}]}};

async function fixture(t, options = {}) {
    const seen = [];
    const server = createWorkspaceServer({enginesProvider: async () => ENGINES,
        compiler: async (project, settings) => { seen.push({project, settings}); return {pdf: PDF, log: 'Complete', engine: 'tectonic'}; }, ...options});
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const url = 'http://127.0.0.1:' + server.address().port;
    const status = await (await fetch(url + '/api/status')).json();
    const headers = {'X-VisualLaTeX-Token': status.token};
    const call = (path, options = {}) => fetch(url + path, {...options, headers: {...headers, ...options.headers}});
    const compile = (body = payload) => call('/api/compile', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    async function completed(id) {
        for (let i = 0; i < 200; i++) {
            const job = await (await call('/api/jobs/' + id)).json();
            if (job.state !== 'running') return job;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error('Job did not settle');
    }
    return {url, server, seen, status, headers, call, compile, completed};
}

test('loopback service serves only the UI assets and keeps compiler paths private', async t => {
    const f = await fixture(t);
    assert.equal(f.status.engines.latex.available, true);
    assert.equal(f.status.engines.latex.executable, undefined);
    assert.ok(f.status.token.length >= 32);
    const page = await fetch(f.url + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-src blob:/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await page.text(), /VisualLaTeX/);
    for (const path of ['/server.mjs', '/compiler.mjs', '/.git/config', '/README.md', '/..%2fserver.mjs']) {
        assert.equal((await fetch(f.url + path)).status, 404, path);
    }
});

test('cross-origin requests, DNS-rebinding hosts and missing tokens cannot invoke compilers', async t => {
    const f = await fixture(t);
    assert.equal((await fetch(f.url + '/api/status', {headers: {Origin: 'https://evil.example'}})).status, 403);
    assert.equal((await fetch(f.url + '/api/status', {headers: {'Sec-Fetch-Site': 'cross-site'}})).status, 403);
    assert.equal((await fetch(f.url + '/api/compile', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)})).status, 403);
    assert.equal((await f.call('/api/compile', {method: 'POST', headers: {Origin: 'null'}})).status, 403);
    const badHost = await new Promise((resolve, reject) => {
        const req = http.get(f.url + '/api/status', {headers: {Host: 'evil.example'}}, res => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
    });
    assert.equal(badHost, 403);
    assert.equal(f.seen.length, 0);
});

test('project snapshots reach the engine and authenticated PDF download retains all bytes', async t => {
    const f = await fixture(t);
    const response = await f.compile();
    assert.equal(response.status, 202);
    const {id} = await response.json();
    const job = await f.completed(id);
    assert.equal(job.state, 'succeeded');
    assert.equal(job.log, 'Complete');
    assert.equal(f.seen.length, 1);
    assert.deepEqual(f.seen[0].project, payload.project);
    assert.equal(f.seen[0].settings.kind, 'latex');
    assert.equal(f.seen[0].settings.mainPath, 'main.tex');
    assert.equal((await fetch(f.url + job.pdfUrl)).status, 403);
    const pdf = await f.call(job.pdfUrl);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), PDF);
});

test('engine errors retain diagnostic logs without producing a downloadable PDF', async t => {
    const f = await fixture(t, {compiler: async () => { throw Object.assign(new Error('Undefined command'), {code: 'TEX_ERROR', log: 'main.tex:12: Undefined command'}); }});
    const {id} = await (await f.compile()).json();
    const job = await f.completed(id);
    assert.equal(job.state, 'failed');
    assert.equal(job.code, 'TEX_ERROR');
    assert.match(job.log, /main.tex:12/);
    assert.equal(job.pdfUrl, undefined);
    assert.equal((await f.call('/api/jobs/' + id + '/pdf')).status, 409);
});

test('only one job runs at once and cancellation cannot be overwritten by a late success', async t => {
    let finish;
    let signal;
    const f = await fixture(t, {compiler: (_project, settings) => { signal = settings.signal; return new Promise(resolve => { finish = resolve; }); }});
    const {id} = await (await f.compile()).json();
    assert.equal((await f.compile()).status, 409);
    assert.equal((await f.call('/api/jobs/' + id, {method: 'DELETE'})).status, 200);
    assert.equal(signal.aborted, true);
    finish({pdf: PDF, log: 'late', engine: 'tectonic'});
    assert.equal((await f.completed(id)).state, 'cancelled');
    assert.equal((await f.call('/api/jobs/' + id + '/pdf')).status, 409);
});

test('invalid JSON, content types and oversized project requests fail before engine execution', async t => {
    const f = await fixture(t, {maxBodyBytes: 400});
    assert.equal((await f.call('/api/compile', {method: 'POST', body: 'anything'})).status, 415);
    assert.equal((await f.call('/api/compile', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{invalid'})).status, 400);
    assert.equal((await f.compile({...payload, mainPath: 12})).status, 400);
    assert.equal((await f.compile({...payload, padding: 'x'.repeat(500)})).status, 413);
    assert.equal(f.seen.length, 0);
});

test('expired results are removed and invalid engine output is rejected', async t => {
    let clock = 1;
    const f = await fixture(t, {now: () => clock, jobTTL: 10});
    const {id} = await (await f.compile()).json();
    assert.equal((await f.completed(id)).state, 'succeeded');
    clock = 20;
    assert.equal((await f.call('/api/jobs/' + id)).status, 404);
    const invalid = await fixture(t, {compiler: async () => ({pdf: Buffer.from('<html>not a PDF</html>')})});
    const bad = await (await invalid.compile()).json();
    assert.equal((await invalid.completed(bad.id)).code, 'INVALID_PDF');
});

test('authenticated preview metadata and PNG pages are cached without delaying PDF downloads', async t => {
    let metadataCalls = 0;
    const pages = [];
    const f = await fixture(t, {
        previewInfo: async () => { metadataCalls++; return {available: true, pageCount: 103, maxPages: 100, width: 1200, height: 1600}; },
        previewRenderer: async (_, page) => { pages.push(page); return Buffer.from('PNG page ' + page); }
    });
    const {id} = await (await f.compile()).json(); await f.completed(id);
    const route = '/api/jobs/' + id + '/preview';
    assert.equal((await fetch(f.url + route)).status, 403);
    const info = await (await f.call(route)).json();
    assert.equal(info.pageCount, 103);
    for (const page of [1, 1, 2, 1]) {
        const response = await f.call(route + '/' + page);
        assert.equal(response.headers.get('content-type'), 'image/png');
        assert.equal(response.headers.get('x-preview-page-count'), '103');
        assert.equal(await response.text(), 'PNG page ' + page);
    }
    assert.equal(metadataCalls, 1);
    assert.deepEqual(pages, [1, 2, 1], 'only the current page is cached');
    assert.equal((await f.call(route + '/101')).status, 400);
    assert.equal((await f.call(route + '/0')).status, 400);
    assert.equal((await f.call('/api/jobs/' + id + '/pdf')).status, 200);
});

test('missing preview engine keeps the complete PDF downloadable', async t => {
    const f = await fixture(t, {previewInfo: async () => ({available: false, reason: 'Ghostscript unavailable'})});
    const {id} = await (await f.compile()).json(); await f.completed(id);
    const route = '/api/jobs/' + id;
    assert.equal((await (await f.call(route + '/preview')).json()).available, false);
    assert.equal((await f.call(route + '/preview/1')).status, 503);
    assert.deepEqual(Buffer.from(await (await f.call(route + '/pdf')).arrayBuffer()), PDF);
});

test('only one page renderer runs, while cancellation leaves the successful PDF intact', async t => {
    let started;
    const rendering = new Promise(resolve => { started = resolve; });
    const f = await fixture(t, {
        previewInfo: async () => ({available: true, pageCount: 2, maxPages: 100}),
        previewRenderer: (_, __, {signal}) => new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), {code: 'PREVIEW_CANCELLED'})), {once: true});
            started();
        })
    });
    const {id} = await (await f.compile()).json(); await f.completed(id);
    const route = '/api/jobs/' + id;
    await f.call(route + '/preview');
    const pending = f.call(route + '/preview/1'); await rendering;
    assert.equal((await f.call(route + '/preview/2')).status, 409);
    assert.equal((await f.call(route + '/pdf')).status, 200);
    await f.call(route, {method: 'DELETE'});
    assert.equal((await (await pending).json()).code, 'PREVIEW_CANCELLED');
    assert.equal((await f.completed(id)).state, 'succeeded');
});

test('expired jobs and server shutdown cancel active preview renderers', async t => {
    for (const mode of ['expire', 'close']) {
        let clock = 1;
        let started;
        let aborted = false;
        const rendering = new Promise(resolve => { started = resolve; });
        const f = await fixture(t, {now: () => clock, jobTTL: 10,
            previewInfo: async () => ({available: true, pageCount: 1, maxPages: 100}),
            previewRenderer: (_, __, {signal}) => new Promise((_, reject) => {
                signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); }, {once: true});
                started();
            })
        });
        const {id} = await (await f.compile()).json(); await f.completed(id);
        const route = '/api/jobs/' + id;
        const pending = f.call(route + '/preview/1'); await rendering;
        if (mode === 'expire') {
            clock = 20;
            assert.equal((await f.call(route)).status, 404);
        } else f.server.close();
        await pending;
        assert.equal(aborted, true, mode);
    }
});
