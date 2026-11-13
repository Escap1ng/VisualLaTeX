import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createWorkspaceServer} from '../server/server.mjs';

const code = readFileSync(new URL('../src/js/preview.js', import.meta.url), 'utf8');
const PDF = Buffer.from('%PDF-1.4\nfixture\n%%EOF');
const engines = {latex: {available: true, engine: 'tectonic', label: 'Tectonic'}, postscript: {available: false}};
const request = {kind: 'latex', mainPath: 'main.tex', project: {format: 'visual-workspace', version: 1,
    name: 'Example', mainPath: 'main.tex', activePath: 'main.tex', files: [{path: 'main.tex', kind: 'text', text: 'source'}]}};

test('cancelling before the POST response arrives stops the real server job and permits a new compile', {timeout: 5000}, async t => {
    let controller, firstSignal, cancellation, releaseEngine;
    let compilerCalls = 0;
    let reportAbort;
    const engineAborted = new Promise(resolve => { reportAbort = resolve; });
    const calls = [];
    const server = createWorkspaceServer({enginesProvider: async () => engines, compiler: async (_, {signal}) => {
        if (++compilerCalls > 1) return {pdf: PDF, log: 'done', engine: 'Tectonic'};
        firstSignal = signal;
        const running = new Promise(resolve => {
            releaseEngine = () => resolve({pdf: PDF, log: 'cleanup', engine: 'Tectonic'});
            signal.addEventListener('abort', reportAbort, {once: true});
        });
        // The server has sent its 202, but real fetch has not delivered the job id yet.
        assert.equal(controller.jobId, null);
        cancellation = controller.cancel();
        return running;
    }});
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(async () => {
        releaseEngine?.();
        controller?.destroy();
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    });
    const base = 'http://127.0.0.1:' + server.address().port;
    const fetcher = (url, init = {}) => { calls.push({url, init}); return fetch(base + url, init); };
    const context = vm.createContext({Blob, AbortController, setTimeout, clearTimeout, fetch: fetcher,
        URL: {createObjectURL: () => 'blob:fixture', revokeObjectURL() {}}, location: {protocol: 'http:'}});
    vm.runInContext(code, context);
    controller = new context.CompilationController({getRequest: () => structuredClone(request), fetch: fetcher, pollInterval: 1});
    assert.equal(await controller.connect(), true);
    const compiling = controller.compile();
    await engineAborted;
    assert.equal(controller.busy, true, 'keep compilation disabled during engine shutdown');
    assert.equal(await controller.compile(), false, 'do not submit a new job before cancellation completes');
    releaseEngine();
    assert.equal(await compiling, false);
    await cancellation;
    assert.equal(controller.phase, 'cancelled');
    assert.equal(firstSignal.aborted, true, 'cancellation reaches the engine even without an initial job id');
    assert.equal(calls.filter(call => call.init.method === 'DELETE').length, 1);
    assert.equal(controller.result, null);
    assert.equal(await controller.compile(), true, 'the cancelled job no longer blocks the compiler');
    await controller.previewTask;
    assert.equal(compilerCalls, 2);
    assert.equal(controller.phase, 'succeeded');
});
