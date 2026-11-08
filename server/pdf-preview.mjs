import {lstat, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CompilationError, runProcess} from './compiler.mjs';

export const PREVIEW_LIMITS = Object.freeze({maxPages: 100, width: 1200, height: 1600, maxImageBytes: 8 * 1024 * 1024});
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function validatePdf(pdf) {
    if (!Buffer.isBuffer(pdf) || pdf.length > 80 * 1024 * 1024 || pdf.subarray(0, 5).toString() !== '%PDF-') {
        throw new CompilationError('无法预览无效或过大的 PDF', 'PREVIEW_INVALID_PDF');
    }
}

async function withPdf(pdf, options, action) {
    validatePdf(pdf);
    const {engine, signal, runner = runProcess, timeoutMs = 20000} = options;
    if (!engine?.available || !engine.executable) throw new CompilationError('未安装 Ghostscript，仍可导出 PDF', 'PREVIEW_ENGINE_MISSING');
    if (signal?.aborted) throw new CompilationError('预览已取消', 'PREVIEW_CANCELLED');
    const temporaryParent = path.resolve(options.temporaryParent || os.tmpdir());
    const directory = await mkdtemp(path.join(temporaryParent, 'visuallatex-preview-'));
    const input = path.join(directory, 'document.pdf');
    const output = path.join(directory, 'page.png');
    const controller = new AbortController();
    const cancel = () => controller.abort(new CompilationError('预览已取消', 'PREVIEW_CANCELLED'));
    signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new CompilationError('预览生成超时；仍可导出 PDF', 'PREVIEW_TIMEOUT')),
        Math.max(1, Math.min(timeoutMs, 20000)));
    const portable = value => value.replace(/\\/g, '/');
    const env = {...process.env, TMPDIR: directory, TEMP: directory, TMP: directory};
    delete env.GS_OPTIONS;
    const run = async args => {
        if (controller.signal.aborted) throw controller.signal.reason;
        const result = await runner(engine.executable, ['-q', '-dSAFER', '-dBATCH', '-dNOPAUSE',
            '--permit-file-read=' + portable(input), '--permit-file-write=' + portable(output), ...args],
        {cwd: directory, env, signal: controller.signal, input, output});
        if (controller.signal.aborted) throw controller.signal.reason;
        if (result.code !== 0) throw new CompilationError('无法生成页面预览；仍可导出 PDF', 'PREVIEW_FAILED', result.log || '');
        return result;
    };
    try {
        await writeFile(input, pdf, {flag: 'wx'});
        return await action({input: portable(input), output: portable(output), run});
    } catch (problem) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw problem;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (path.dirname(directory) === temporaryParent && path.basename(directory).startsWith('visuallatex-preview-')) {
            await rm(directory, {recursive: true, force: true, maxRetries: 3});
        }
    }
}

export async function getPdfPreviewInfo(pdf, options = {}) {
    if (!options.engine?.available || !options.engine.executable) {
        return {available: false, reason: '未安装 Ghostscript，无法显示图片预览；仍可导出 PDF。'};
    }
    return withPdf(pdf, options, async ({input, run}) => {
        // Pass the filename as a Ghostscript string option, never interpolate it
        // into executable PostScript. Only the fixed counting program is run.
        const result = await run(['-dNODISPLAY', '-sPDFFile=' + input, '-c',
            'PDFFile (r) file runpdfbegin (VISUALLATEX_PAGE_COUNT:) print pdfpagecount = runpdfend quit']);
        const counts = [...String(result.log || '').matchAll(/^VISUALLATEX_PAGE_COUNT:(\d+)\s*$/gm)];
        const pageCount = Number(counts.at(-1)?.[1]);
        if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 1_000_000) {
            throw new CompilationError('无法读取 PDF 页数；仍可导出 PDF', 'PREVIEW_INVALID_PAGE_COUNT');
        }
        const {maxPages, width, height} = PREVIEW_LIMITS;
        return {available: true, pageCount, maxPages, width, height};
    });
}

export async function renderPdfPreviewPage(pdf, page, options = {}) {
    const {maxPages, width, height, maxImageBytes} = PREVIEW_LIMITS;
    if (!Number.isSafeInteger(page) || page < 1 || page > maxPages || !Number.isSafeInteger(options.pageCount) || page > options.pageCount) {
        throw new CompilationError('预览页码超出范围（最多预览前 100 页）', 'PREVIEW_PAGE_RANGE');
    }
    return withPdf(pdf, options, async ({input, output, run}) => {
        await run(['-sDEVICE=png16m', '-r120', '-g' + width + 'x' + height, '-dFIXEDMEDIA', '-dPDFFitPage',
            '-dNumRenderingThreads=1', '-dMaxBitmap=20000000', '-dBufferSpace=20000000',
            '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', '-dFirstPage=' + page, '-dLastPage=' + page,
            '-sOutputFile=' + output, '-f', input]);
        const info = await lstat(output);
        if (!info.isFile() || info.isSymbolicLink() || info.size > maxImageBytes) {
            throw new CompilationError('预览图超过大小限制', 'PREVIEW_OUTPUT_TOO_LARGE');
        }
        const png = await readFile(output);
        if (png.length < 24 || !png.subarray(0, 8).equals(PNG_HEADER) || png.subarray(12, 16).toString() !== 'IHDR' ||
            png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
            throw new CompilationError('引擎未生成有效尺寸的 PNG 预览', 'PREVIEW_INVALID_IMAGE');
        }
        return png;
    });
}
