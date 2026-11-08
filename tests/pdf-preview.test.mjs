import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {getPdfPreviewInfo, renderPdfPreviewPage, PREVIEW_LIMITS} from '../pdf-preview.mjs';

const pdf = Buffer.from('%PDF-1.7\nfixture\n%%EOF');
const engine = {available: true, executable: '/configured/gs'};
const png = Buffer.alloc(24);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
png.write('IHDR', 12); png.writeUInt32BE(1200, 16); png.writeUInt32BE(1600, 20);
async function directory(t) {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'visual-preview-test-'));
    t.after(() => rm(folder, {recursive: true, force: true}));
    return folder;
}

test('preview metadata counts pages with a fixed program and cleans the staged PDF', async t => {
    const temporaryParent = await directory(t);
    const info = await getPdfPreviewInfo(pdf, {engine, temporaryParent, runner: async (_, args, options) => {
        assert.ok(args.includes('-dSAFER'));
        assert.ok(args.includes('-dNODISPLAY'));
        assert.ok(args.some(arg => arg.startsWith('-sPDFFile=')));
        assert.equal(args.at(-1), 'PDFFile (r) file runpdfbegin (VISUALLATEX_PAGE_COUNT:) print pdfpagecount = runpdfend quit');
        assert.equal(options.env.GS_OPTIONS, undefined);
        return {code: 0, log: 'VISUALLATEX_PAGE_COUNT:2\n'};
    }});
    assert.deepEqual(info, {available: true, pageCount: 2, maxPages: 100, width: 1200, height: 1600});
    assert.deepEqual(await readdir(temporaryParent), []);
});

test('one PDF page is rendered on a fixed pixel canvas without clipping the original page', async t => {
    const temporaryParent = await directory(t);
    const result = await renderPdfPreviewPage(pdf, 2, {engine, pageCount: 2, temporaryParent, runner: async (_, args, options) => {
        for (const flag of ['-dSAFER', '-sDEVICE=png16m', '-g1200x1600', '-dFIXEDMEDIA', '-dPDFFitPage', '-dFirstPage=2', '-dLastPage=2']) assert.ok(args.includes(flag));
        assert.ok(!args.includes('-dNOSAFER'));
        await writeFile(options.output, png); return {code: 0};
    }});
    assert.deepEqual(result, png);
    assert.deepEqual(await readdir(temporaryParent), []);
});

test('missing engines, invalid input and page limits do not run a preview process', async t => {
    const temporaryParent = await directory(t);
    let calls = 0;
    const options = {engine, temporaryParent, pageCount: 1000, runner: async () => { calls++; }};
    assert.equal((await getPdfPreviewInfo(pdf)).available, false);
    for (const page of [0, -1, 1.5, 101, NaN]) await assert.rejects(renderPdfPreviewPage(pdf, page, options), {code: 'PREVIEW_PAGE_RANGE'});
    await assert.rejects(renderPdfPreviewPage(Buffer.from('not pdf'), 1, options), {code: 'PREVIEW_INVALID_PDF'});
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(temporaryParent), []);
});

test('invalid page counts, engine errors and malformed or oversized images are rejected and cleaned', async t => {
    const temporaryParent = await directory(t);
    await assert.rejects(getPdfPreviewInfo(pdf, {engine, temporaryParent, runner: async () => ({code: 0, log: 'Not a count'})}), {code: 'PREVIEW_INVALID_PAGE_COUNT'});
    await assert.rejects(getPdfPreviewInfo(pdf, {engine, temporaryParent, runner: async () => ({code: 1, log: 'invalid PDF'})}), {code: 'PREVIEW_FAILED'});
    for (const bytes of [Buffer.from('not PNG'), Buffer.alloc(PREVIEW_LIMITS.maxImageBytes + 1)]) {
        await assert.rejects(renderPdfPreviewPage(pdf, 1, {engine, pageCount: 1, temporaryParent,
            runner: async (_, __, options) => { await writeFile(options.output, bytes); return {code: 0}; }}));
    }
    assert.deepEqual(await readdir(temporaryParent), []);
});

test('timeout and cancellation stop preview generation and remove all temporary files', async t => {
    const temporaryParent = await directory(t);
    for (const mode of ['timeout', 'cancel']) {
        const controller = new AbortController();
        const pending = getPdfPreviewInfo(pdf, {engine, temporaryParent, signal: controller.signal, timeoutMs: mode === 'timeout' ? 20 : 2000,
            runner: (_, __, {signal}) => new Promise((_, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), {once: true});
                if (mode === 'cancel') controller.abort();
            })});
        await assert.rejects(pending, {code: mode === 'timeout' ? 'PREVIEW_TIMEOUT' : 'PREVIEW_CANCELLED'});
        assert.deepEqual(await readdir(temporaryParent), []);
    }
});
