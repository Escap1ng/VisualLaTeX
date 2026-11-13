import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createWorkspaceServer} from '../server/server.mjs';

test('real HTTP preview survives active reading and recovers an idle eviction on explicit retry', async t => {
    let clock = 1000, compilations = 0, downloads = 0, urlId = 0;
    const request = {kind: 'latex', mainPath: 'main.tex', project: {files: [{path: 'main.tex', kind: 'text', text: 'Source'}]}};
    const engines = {latex: {available: true, engine: 'fixture'}, postscript: {available: true}};
    const server = createWorkspaceServer({now: () => clock, enginesProvider: async () => engines,
        compiler: async () => { compilations++; return {pdf: Buffer.from('%PDF-1.7\nfixture\n%%EOF'), engine: 'fixture'}; },
        previewInfo: async () => ({available: true, pageCount: 3, maxPages: 100}),
        previewRenderer: async (_, page) => Buffer.from('PNG page ' + page)});
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const base = 'http://127.0.0.1:' + server.address().port;
    const fetcher = (url, init) => fetch(base + url, init);
    const urls = {createObjectURL: () => 'blob:fixture/' + ++urlId, revokeObjectURL() {}};
    const context = vm.createContext({Blob, AbortController, setTimeout, clearTimeout, URL: urls, fetch: fetcher});
    vm.runInContext(await readFile(new URL('../src/js/preview.js', import.meta.url), 'utf8'), context);
    const controller = new context.CompilationController({getRequest: () => structuredClone(request),
        fetch: fetcher, urls, protocol: 'http:', pollInterval: 1, download: () => { downloads++; }});
    t.after(() => controller.destroy());
    assert.equal(await controller.connect(), true);
    assert.equal(await controller.compile(), true);
    assert.equal(await controller.previewTask, true);
    const previousJob = controller.result.jobId;
    for (let minute = 2; minute <= 12; minute += 2) {
        clock = 1000 + minute * 60_000;
        assert.equal(await controller.loadPage(1 + (minute / 2) % 3), true);
    }
    clock += 10 * 60_000;
    assert.equal(await controller.loadPage(2), false);
    assert.equal(controller.preview.errorCode, 'JOB_NOT_FOUND');
    assert.equal(await controller.exportPdf(), true);
    assert.equal(downloads, 1);
    assert.equal(compilations, 1, 'expiry and cached export never start a compiler');
    assert.equal(await controller.retryPreview(), true);
    assert.notEqual(controller.result.jobId, previousJob);
    assert.equal(controller.preview.state, 'ready');
    assert.equal(compilations, 2);
});
