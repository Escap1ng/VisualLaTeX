import http from 'node:http';
import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileProject, discoverEngines} from './compiler.mjs';
import {getPdfPreviewInfo, renderPdfPreviewPage} from './pdf-preview.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 80 * 1024 * 1024;
const MAX_PDF_BYTES = 80 * 1024 * 1024;
// The checked-in manifest is the only source of public vendor paths. Do not
// expose a vendor directory or derive a filesystem path from the request URL.
const mathliveManifest = JSON.parse(await readFile(new URL('./vendor/mathlive/manifest.json', import.meta.url), 'utf8'));
const mathliveTypes = new Map([
    ['mathlive.min.js', 'text/javascript; charset=utf-8'],
    ['mathlive-static.css', 'text/css; charset=utf-8'],
    ['mathlive-fonts.css', 'text/css; charset=utf-8']
]);
const mathliveAssets = mathliveManifest.files.flatMap(({path}) => {
    const type = mathliveTypes.get(path) || (/^fonts\/[A-Za-z0-9_-]+\.woff2$/.test(path) ? 'font/woff2' : null);
    return type ? [['/vendor/mathlive/' + path, ['vendor/mathlive/' + path, type]]] : [];
});
const ASSETS = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/index.html', ['index.html', 'text/html; charset=utf-8']],
    ...['main.js', 'workspace.js', 'project-model.js', 'project-archive.js', 'preview.js',
        'visual-math.js', 'visual-references.js', 'visual-references-ui.js']
        .map(name => ['/' + name, [name, 'text/javascript; charset=utf-8']]),
    ...['style.css', 'workspace.css', 'preview.css', 'visual-math.css', 'visual-references-ui.css']
        .map(name => ['/' + name, [name, 'text/css; charset=utf-8']]),
    ...mathliveAssets
]);

function error(message, status = 400, code = 'INVALID_REQUEST') {
    return Object.assign(new Error(message), {status, code});
}

function readJson(req, limit) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
        throw error('请求必须使用 JSON。', 415);
    }
    if (Number(req.headers['content-length']) > limit) throw error('项目请求超过 80 MB。', 413, 'REQUEST_TOO_LARGE');
    return new Promise((resolveBody, reject) => {
        const chunks = [];
        let length = 0;
        let settled = false;
        const fail = problem => { if (!settled) { settled = true; chunks.length = 0; reject(problem); } };
        req.on('data', chunk => {
            if (settled) return;
            length += chunk.length;
            if (length > limit) { fail(error('项目请求超过 80 MB。', 413, 'REQUEST_TOO_LARGE')); return; }
            chunks.push(chunk);
        });
        req.on('aborted', () => fail(error('请求已中断。')));
        req.on('error', fail);
        req.on('end', () => {
            if (settled) return;
            settled = true;
            try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { reject(error('项目 JSON 无效。')); }
        });
    });
}

/** Loopback-only application server; compilers run as this local OS user. */
export function createWorkspaceServer({
    compiler = compileProject, enginesProvider = discoverEngines, root = ROOT,
    token = randomBytes(32).toString('hex'), maxBodyBytes = MAX_BODY_BYTES,
    jobTTL = 10 * 60_000, maxJobs = 8, now = Date.now,
    previewInfo = getPdfPreviewInfo, previewRenderer = renderPdfPreviewPage
} = {}) {
    const jobs = new Map();
    const tokenBytes = Buffer.from(token);
    let enginePromise;
    let enginesAt = 0;
    let previewActive = null;
    const getEngines = () => {
        if (!enginePromise || now() - enginesAt > 30_000) {
            enginesAt = now();
            enginePromise = Promise.resolve().then(() => enginesProvider()).catch(problem => { enginePromise = null; throw problem; });
        }
        return enginePromise;
    };
    function discard(job) {
        if (previewActive?.job === job) previewActive.controller.abort();
        jobs.delete(job.id);
    }
    function sweep() {
        for (const job of jobs.values()) if (!job.active && now() - job.finishedAt >= jobTTL) discard(job);
    }
    async function previewOperation(job, res, operation) {
        if (previewActive) throw error('已有页面预览正在生成，请稍后重试。', 409, 'PREVIEW_BUSY');
        const active = {job, controller: new AbortController()};
        previewActive = active;
        const disconnected = () => { if (!res.writableEnded) active.controller.abort(); };
        res.once('close', disconnected);
        try {
            const engines = await getEngines();
            if (active.controller.signal.aborted) throw error('预览已取消。', 409, 'PREVIEW_CANCELLED');
            const value = await operation({engine: engines.postscript, signal: active.controller.signal});
            if (active.controller.signal.aborted || jobs.get(job.id) !== job) throw error('编译结果已过期，请重新编译。', 404, 'JOB_NOT_FOUND');
            return value;
        } finally {
            res.removeListener('close', disconnected);
            if (previewActive === active) previewActive = null;
        }
    }
    function authorised(req) {
        const supplied = Buffer.from(String(req.headers['x-visuallatex-token'] || ''));
        return supplied.length === tokenBytes.length && timingSafeEqual(supplied, tokenBytes);
    }
    const server = http.createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        const json = (status, value) => {
            if (res.destroyed || res.writableEnded) return;
            res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
            res.end(JSON.stringify(value));
        };
        try {
            const port = server.address()?.port;
            const host = req.headers.host;
            if (![ '127.0.0.1:' + port, 'localhost:' + port ].includes(host)) throw error('不允许的本机服务地址。', 403, 'FORBIDDEN_HOST');
            if ((req.headers.origin && req.headers.origin !== 'http://' + host) || req.headers['sec-fetch-site'] === 'cross-site') {
                throw error('只允许工作台本身访问编译服务。', 403, 'FORBIDDEN_ORIGIN');
            }
            const url = new URL(req.url, 'http://' + host);
            const path = url.pathname;
            sweep();
            if (path === '/api/status' && req.method === 'GET') {
                const engines = await getEngines();
                const publicEngine = value => ({available: Boolean(value?.available), engine: value?.engine || '', label: value?.label || ''});
                json(200, {token, engines: {latex: publicEngine(engines.latex), postscript: publicEngine(engines.postscript)}});
                return;
            }
            if (path.startsWith('/api/')) {
                if (!authorised(req)) throw error('编译会话已失效，请刷新工作台。', 403, 'INVALID_TOKEN');
                if (path === '/api/compile' && req.method === 'POST') {
                    if ([...jobs.values()].some(job => job.active)) throw error('已有编译任务正在运行，请等待或取消。', 409, 'COMPILER_BUSY');
                    const payload = await readJson(req, maxBodyBytes);
                    if (!payload || !['latex', 'postscript'].includes(payload.kind) || typeof payload.mainPath !== 'string' || !payload.project || typeof payload.project !== 'object') {
                        throw error('请选择 LaTeX 或 PostScript 主文件。');
                    }
                    // Recheck after the asynchronous upload to prevent two jobs
                    // from passing the concurrency check at the same time.
                    if ([...jobs.values()].some(job => job.active)) throw error('已有编译任务正在运行。', 409, 'COMPILER_BUSY');
                    while (jobs.size >= maxJobs) {
                        const oldest = [...jobs.values()].find(job => !job.active);
                        if (!oldest) throw error('编译服务繁忙。', 409, 'COMPILER_BUSY');
                        discard(oldest);
                    }
                    const job = {id: randomUUID(), state: 'running', active: true, log: '', mainPath: payload.mainPath,
                        controller: new AbortController(), startedAt: now(), finishedAt: null};
                    jobs.set(job.id, job);
                    let delivered = false;
                    res.once('finish', () => { delivered = true; });
                    res.once('close', () => {
                        if (!delivered && job.active) { job.state = 'cancelled'; job.controller.abort(); }
                    });
                    json(202, {id: job.id});
                    Promise.resolve().then(async () => {
                        const engines = await getEngines();
                        if (job.controller.signal.aborted) return;
                        const result = await compiler(payload.project, {kind: payload.kind, mainPath: payload.mainPath, signal: job.controller.signal, engines});
                        if (job.controller.signal.aborted) return;
                        if (!Buffer.isBuffer(result.pdf) || result.pdf.length > MAX_PDF_BYTES || result.pdf.subarray(0, 5).toString() !== '%PDF-') {
                            throw error('引擎没有生成有效 PDF，或结果超过 80 MB。', 500, 'INVALID_PDF');
                        }
                        Object.assign(job, {state: 'succeeded', pdf: result.pdf, log: String(result.log || '').slice(-200_000), engine: result.engine});
                    }).catch(problem => {
                        if (job.controller.signal.aborted) return;
                        Object.assign(job, {state: 'failed', error: problem.message || '编译失败', code: problem.code || 'COMPILE_FAILED',
                            log: String(problem.log || '').slice(-200_000)});
                    }).finally(() => { job.active = false; job.finishedAt = now(); });
                    return;
                }
                const match = /^\/api\/jobs\/([0-9a-f-]+)(\/pdf|\/preview(?:\/([0-9]+))?)?$/.exec(path);
                const job = match && jobs.get(match[1]);
                if (!job) throw error('编译结果不存在或已过期，请重新编译。', 404, 'JOB_NOT_FOUND');
                if (req.method === 'DELETE' && !match[2]) {
                    if (previewActive?.job === job) previewActive.controller.abort();
                    if (job.active) {
                        job.state = 'cancelled'; job.controller.abort();
                    }
                    json(200, {id: job.id, state: job.state});
                    return;
                }
                if (req.method !== 'GET') throw error('不支持的操作。', 405);
                if (match[2] === '/pdf') {
                    if (job.state !== 'succeeded') throw error('PDF 尚未生成。', 409, 'PDF_NOT_READY');
                    res.writeHead(200, {'Content-Type': 'application/pdf', 'Content-Length': job.pdf.length,
                        'Content-Disposition': 'inline; filename="preview.pdf"'});
                    res.end(job.pdf);
                } else if (match[2]?.startsWith('/preview')) {
                    if (job.state !== 'succeeded') throw error('PDF 尚未生成。', 409, 'PDF_NOT_READY');
                    const info = job.previewInfo || await previewOperation(job, res, options => previewInfo(job.pdf, options));
                    if (info.available) job.previewInfo = info;
                    if (!match[3]) { json(200, info); return; }
                    if (!info.available) throw error(info.reason || '没有可用的预览引擎，仍可下载 PDF。', 503, 'PREVIEW_ENGINE_MISSING');
                    const page = Number(match[3]);
                    if (!Number.isSafeInteger(page) || page < 1 || page > Math.min(info.pageCount, info.maxPages)) {
                        throw error('预览页码超出范围（最多预览前 100 页）。', 400, 'PREVIEW_PAGE_RANGE');
                    }
                    const png = job.previewCache?.page === page ? job.previewCache.png
                        : await previewOperation(job, res, options => previewRenderer(job.pdf, page, {...options, pageCount: info.pageCount}));
                    job.previewCache = {page, png};
                    if (res.destroyed || res.writableEnded) return;
                    res.writeHead(200, {'Content-Type': 'image/png', 'Content-Length': png.length,
                        'X-Preview-Page': String(page), 'X-Preview-Page-Count': String(info.pageCount)});
                    res.end(png);
                } else json(200, {id: job.id, state: job.state, log: job.log, error: job.error, code: job.code,
                    engine: job.engine, mainPath: job.mainPath,
                    ...(job.state === 'succeeded' ? {pdfUrl: '/api/jobs/' + job.id + '/pdf'} : {})});
                return;
            }
            if (!['GET', 'HEAD'].includes(req.method)) throw error('不支持的操作。', 405);
            const asset = ASSETS.get(path);
            if (!asset) throw error('文件不存在。', 404);
            const bytes = await readFile(join(root, asset[0]));
            res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
            res.writeHead(200, {'Content-Type': asset[1], 'Content-Length': bytes.length});
            res.end(req.method === 'HEAD' ? undefined : bytes);
        } catch (problem) {
            json(problem.status || 500, {error: problem.status ? problem.message : '本地服务暂时不可用：' + problem.message, code: problem.code || 'SERVER_ERROR'});
        }
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    const timer = setInterval(sweep, 30_000);
    timer.unref();
    const close = server.close.bind(server);
    server.close = callback => {
        previewActive?.controller.abort();
        for (const job of jobs.values()) if (job.active) { job.state = 'cancelled'; job.controller.abort(); }
        return close(callback);
    };
    server.on('close', () => {
        clearInterval(timer);
        for (const job of jobs.values()) if (job.active) { job.state = 'cancelled'; job.controller.abort(); }
        jobs.clear();
    });
    return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const argument = process.argv.indexOf('--port');
    const port = Number(argument >= 0 ? process.argv[argument + 1] : process.env.VISUALLATEX_PORT || 4173);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须在 0–65535 之间。');
    const server = createWorkspaceServer();
    server.on('error', problem => { console.error('无法启动工作台：' + problem.message); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => {
        console.log('VisualLaTeX Studio: http://127.0.0.1:' + server.address().port);
        console.log('浏览器打开上方地址。编译在本机进行；按 Ctrl+C 退出。');
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
