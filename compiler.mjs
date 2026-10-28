// Local compiler bridge. Engine safety switches are not an operating-system sandbox.
import {spawn} from 'node:child_process';
import {access, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import './project-model.js';

const ProjectModel = globalThis.ProjectModel;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180000;
const TOOL_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tools');

export class CompilationError extends Error {
    constructor(message, code = 'COMPILE_FAILED', log = '') {
        super(message);
        this.name = 'CompilationError';
        this.code = code;
        this.log = log;
    }
}

function boundedLog(text) {
    const bytes = Buffer.from(text);
    if (bytes.length <= MAX_LOG_BYTES) return text;
    return '[较早日志已省略]\n' + bytes.subarray(-MAX_LOG_BYTES).toString('utf8');
}

async function executable(candidate) {
    if (!candidate) return null;
    try {
        const resolved = path.resolve(candidate);
        if (!(await stat(resolved)).isFile()) return null;
        await access(resolved, constants.X_OK);
        return resolved;
    } catch { return null; }
}

async function findExecutable(names, configured, env, beside, portableDirectory) {
    if (configured) return executable(configured);
    const directories = [...(beside ? [beside] : []), ...(portableDirectory ? [portableDirectory] : []), ...(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)];
    for (const directory of directories) {
        for (const name of names) {
            const found = await executable(path.join(directory.replace(/^"|"$/g, ''), name));
            if (found) return found;
        }
    }
    return null;
}

export async function discoverEngines({env = process.env, toolsDirectory = TOOL_ROOT} = {}) {
    const extension = process.platform === 'win32' ? '.exe' : '';
    // An explicit XeLaTeX choice takes priority over automatically found Tectonic.
    const tectonic = env.VISUALLATEX_XELATEX && !env.VISUALLATEX_TECTONIC ? null
        : await findExecutable(['tectonic' + extension], env.VISUALLATEX_TECTONIC, env, null, path.join(toolsDirectory, 'tectonic'));
    const xelatex = tectonic ? null : await findExecutable(['xelatex' + extension], env.VISUALLATEX_XELATEX, env);
    const gs = await findExecutable(process.platform === 'win32' ? ['gswin64c.exe', 'gswin32c.exe', 'gs.exe'] : ['gs'], env.VISUALLATEX_GHOSTSCRIPT, env, null, path.join(toolsDirectory, 'ghostscript', 'bin'));
    const bibtex = xelatex ? await findExecutable(['bibtex' + extension], env.VISUALLATEX_BIBTEX, env, path.dirname(xelatex)) : null;
    const biber = xelatex ? await findExecutable(['biber' + extension], env.VISUALLATEX_BIBER, env, path.dirname(xelatex)) : null;
    return {
        latex: {available: Boolean(tectonic || xelatex), engine: tectonic ? 'tectonic' : xelatex ? 'xelatex' : null,
            label: tectonic ? 'Tectonic' : xelatex ? 'XeLaTeX' : '未安装 LaTeX 引擎', executable: tectonic || xelatex, bibtex, biber},
        postscript: {available: Boolean(gs), engine: gs ? 'ghostscript' : null,
            label: gs ? 'Ghostscript' : '未安装 Ghostscript', executable: gs}
    };
}

async function killTree(child) {
    if (!child.pid) return;
    if (process.platform === 'win32') {
        await new Promise(resolve => {
            const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
                ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, shell: false, stdio: 'ignore'});
            killer.once('error', resolve);
            killer.once('close', resolve);
        });
        child.kill();
    } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { child.kill('SIGKILL'); }
    }
}

export function runProcess(command, args, {cwd, env, signal} = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason || new CompilationError('已取消编译', 'CANCELLED'));
    return new Promise((resolve, reject) => {
        let log = '';
        let aborted = false;
        const child = spawn(command, args, {cwd, env, windowsHide: true, shell: false,
            detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
        const append = data => { log = boundedLog(log + data.toString('utf8')); };
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        const abort = () => { aborted = true; void killTree(child); };
        signal?.addEventListener('abort', abort, {once: true});
        child.once('error', error => {
            signal?.removeEventListener('abort', abort);
            reject(new CompilationError('无法启动编译引擎：' + error.message, 'ENGINE_START_FAILED', log));
        });
        child.once('close', (code, processSignal) => {
            signal?.removeEventListener('abort', abort);
            if (aborted || signal?.aborted) {
                const reason = signal?.reason;
                reject(new CompilationError(reason?.message || '已取消编译', reason?.code || 'CANCELLED', log));
            } else resolve({code: code ?? -1, signal: processSignal, log});
        });
        // Cover an abort arriving between spawn and listener registration.
        if (signal?.aborted) abort();
    });
}

function prepareProject(project, selectedPath, kind) {
    let model;
    try { model = ProjectModel.deserialize(project); }
    catch (error) { throw new CompilationError('项目数据无效：' + error.message, 'INVALID_PROJECT'); }
    const mainPath = selectedPath || model.mainPath;
    const main = model.get(mainPath);
    if (!main) throw new CompilationError('请选择项目中的主文件', 'INVALID_MAIN');
    if (kind !== 'latex' && kind !== 'postscript') throw new CompilationError('未知编译类型', 'INVALID_KIND');
    if (kind === 'latex' && (main.kind !== 'text' || !/\.(tex|latex|ltx)$/i.test(main.path))) {
        throw new CompilationError('LaTeX 主文件必须是 .tex、.latex 或 .ltx 源码', 'INVALID_MAIN');
    }
    if (kind === 'postscript' && !/\.(ps|eps)$/i.test(main.path)) {
        throw new CompilationError('PostScript 主文件必须是 .ps 或 .eps', 'INVALID_MAIN');
    }
    const files = model.list();
    const paths = new Set(files.map(file => file.path.normalize('NFC').toLowerCase()));
    for (const file of files) {
        const parts = file.path.split('/');
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (/[<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
                throw new CompilationError('文件名不能安全写入本机：' + file.path, 'INVALID_PATH');
            }
            if (kind === 'postscript' && part.includes(path.delimiter)) {
                throw new CompilationError('PostScript 资源文件名不能包含权限列表分隔符：' + file.path, 'INVALID_PATH');
            }
            if (i < parts.length - 1 && paths.has(parts.slice(0, i + 1).join('/').normalize('NFC').toLowerCase())) {
                throw new CompilationError('文件与目录路径冲突：' + file.path, 'INVALID_PATH');
            }
        }
    }
    return {files, mainPath: main.path};
}

function fileBytes(file) {
    if (file.kind === 'binary') return Buffer.from(file.base64, 'base64');
    return Buffer.from(file.text, file.encoding === 'latin1' ? 'latin1' : 'utf8');
}

async function readBounded(file, maximum) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new CompilationError('引擎输出不是普通文件', 'INVALID_OUTPUT');
    if (info.size > maximum) throw new CompilationError('编译输出超过大小限制', 'OUTPUT_TOO_LARGE');
    return readFile(file);
}

async function savedLog(directory) {
    try {
        let result = '';
        for (const name of await readdir(directory)) {
            if (!/\.(log|blg)$/i.test(name)) continue;
            const target = path.join(directory, name);
            const info = await lstat(target);
            if (!info.isFile() || info.isSymbolicLink()) continue;
            const handle = await open(target, 'r');
            try {
                const bytes = Buffer.alloc(Math.min(info.size, MAX_LOG_BYTES));
                await handle.read(bytes, 0, bytes.length, Math.max(0, info.size - bytes.length));
                result = boundedLog(result + '\n--- ' + name + ' ---\n' + bytes.toString('utf8'));
            } finally { await handle.close(); }
        }
        return result;
    } catch { return ''; }
}

export async function compileProject(project, options = {}) {
    const {kind, signal, runner = runProcess, timeoutMs = DEFAULT_TIMEOUT_MS} = options;
    const validated = prepareProject(project, options.mainPath, kind);
    if (signal?.aborted) throw new CompilationError('已取消编译', 'CANCELLED');
    const engines = options.engines || await discoverEngines();
    const engine = engines[kind];
    if (!engine?.available || !engine.executable) throw new CompilationError(kind === 'latex' ? '未找到 LaTeX 引擎，请安装 Tectonic 或 XeLaTeX 并重启服务' : '未找到 Ghostscript，请安装后重启服务', 'ENGINE_MISSING');
    const temporaryParent = path.resolve(options.temporaryParent || os.tmpdir());
    const jobDirectory = await mkdtemp(path.join(temporaryParent, 'visuallatex-compile-'));
    const sourceDirectory = path.join(jobDirectory, 'project');
    const outputDirectory = path.join(jobDirectory, 'output');
    const mainFile = path.resolve(sourceDirectory, validated.mainPath);
    const cwd = path.dirname(mainFile);
    const abort = new AbortController();
    const forwardAbort = () => abort.abort(new CompilationError('已取消编译', 'CANCELLED'));
    signal?.addEventListener('abort', forwardAbort, {once: true});
    if (signal?.aborted) forwardAbort();
    const timeout = setTimeout(() => abort.abort(new CompilationError('编译超时，请检查无限循环或过大的项目', 'COMPILE_TIMEOUT')), Math.max(1, Math.min(timeoutMs, 600000)));
    const env = {...process.env, TECTONIC_UNTRUSTED_MODE: '1', shell_escape: '0', openout_any: 'p', openin_any: 'p',
        TEXMFOUTPUT: outputDirectory, TEXMF_OUTPUT_DIRECTORY: outputDirectory, TMPDIR: jobDirectory, TEMP: jobDirectory, TMP: jobDirectory};
    if (!env.TECTONIC_CACHE_DIR && await stat(path.join(TOOL_ROOT, 'cache')).then(info => info.isDirectory(), () => false)) {
        env.TECTONIC_CACHE_DIR = path.join(TOOL_ROOT, 'cache');
    }
    // Avoid inherited options that could silently change Ghostscript safety or output.
    delete env.GS_OPTIONS;
    let log = '';
    const run = async (command, args, workingDirectory = cwd, extraEnv = {}) => {
        if (abort.signal.aborted) throw abort.signal.reason;
        const result = await runner(command, args, {cwd: workingDirectory, env: {...env, ...extraEnv}, signal: abort.signal, outputDirectory, sourceDirectory});
        log = boundedLog(log + '\n[' + path.basename(command) + ']\n' + (result.log || ''));
        if (abort.signal.aborted) throw abort.signal.reason;
        if (result.code !== 0) throw new CompilationError('编译失败，请查看日志中的文件名、行号和错误信息', 'COMPILE_FAILED');
    };
    try {
        await mkdir(sourceDirectory);
        await mkdir(outputDirectory);
        for (const file of validated.files) {
            if (abort.signal.aborted) throw abort.signal.reason;
            const target = path.resolve(sourceDirectory, file.path);
            if (!target.startsWith(sourceDirectory + path.sep)) throw new CompilationError('文件路径越出项目', 'INVALID_PATH');
            await mkdir(path.dirname(target), {recursive: true});
            await writeFile(target, fileBytes(file), {flag: 'wx'});
        }
        let output;
        if (kind === 'postscript') {
            output = path.join(outputDirectory, 'document.pdf');
            const portable = value => value.replace(/\\/g, '/');
            const args = ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite', '-dAutoRotatePages=/None',
                '--permit-file-read=' + portable(sourceDirectory) + '/*', '--permit-file-write=' + portable(outputDirectory) + '/*',
                '-sOutputFile=' + portable(output)];
            // Ghostscript matches the requested filename form exactly: a grant
            // for an absolute directory does not permit `(parts/figure.ps) run`.
            // Grant only staged project files in the two usual relative forms.
            for (const file of validated.files) {
                const relative = portable(path.relative(cwd, path.resolve(sourceDirectory, file.path)));
                args.push('--permit-file-read=' + relative, '--permit-file-read=./' + relative);
            }
            if (/\.eps$/i.test(mainFile)) args.push('-dEPSCrop');
            args.push('-f', portable(mainFile));
            await run(engine.executable, args);
        } else if (engine.engine === 'tectonic') {
            output = path.join(outputDirectory, path.parse(mainFile).name + '.pdf');
            let tectonicError;
            try { await run(engine.executable, ['-X', 'compile', '--untrusted', '--keep-logs', '--keep-intermediates', '--outdir', outputDirectory, mainFile]); }
            catch (error) { tectonicError = error; }
            const bcf = await access(path.join(outputDirectory, path.parse(mainFile).name + '.bcf')).then(() => true, () => false);
            if (bcf || /note: Running external tool biber\b/.test(log)) {
                throw new CompilationError('项目需要 Biber；请配置 XeLaTeX 与 biber 后重新编译，当前 Tectonic 流程不支持此项目', 'BIBLIOGRAPHY_ENGINE_MISSING');
            }
            if (tectonicError) throw tectonicError;
        } else if (engine.engine === 'xelatex') {
            output = path.join(outputDirectory, 'visual-workspace.pdf');
            const args = ['-no-shell-escape', '-no-parse-first-line', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error',
                '-jobname=visual-workspace', '-output-directory=' + outputDirectory, mainFile];
            await run(engine.executable, args);
            const aux = await readFile(path.join(outputDirectory, 'visual-workspace.aux'), 'utf8').catch(() => '');
            const bcf = await access(path.join(outputDirectory, 'visual-workspace.bcf')).then(() => true, () => false);
            const searchPath = cwd + path.sep + path.delimiter + sourceDirectory + path.sep + path.delimiter;
            if (bcf) {
                if (!engine.biber) throw new CompilationError('项目使用 BibLaTeX/Biber，但未找到 biber 引擎', 'BIBLIOGRAPHY_ENGINE_MISSING');
                await run(engine.biber, ['--input-directory', outputDirectory, '--output-directory', outputDirectory, 'visual-workspace'], cwd,
                    {BIBINPUTS: searchPath});
            } else if (/\\bibdata\{/.test(aux)) {
                if (!engine.bibtex) throw new CompilationError('项目使用 BibTeX，但未找到 bibtex 引擎', 'BIBLIOGRAPHY_ENGINE_MISSING');
                await run(engine.bibtex, ['visual-workspace'], outputDirectory, {BIBINPUTS: searchPath, BSTINPUTS: searchPath});
            }
            await run(engine.executable, args);
            await run(engine.executable, args);
        } else throw new CompilationError('不支持此编译引擎', 'ENGINE_UNSUPPORTED');
        const pdf = await readBounded(output, MAX_PDF_BYTES).catch(error => {
            if (error.code === 'ENOENT') throw new CompilationError('引擎未生成 PDF，请检查日志', 'PDF_MISSING');
            throw error;
        });
        if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new CompilationError('引擎返回的文件不是有效 PDF', 'INVALID_OUTPUT');
        log = boundedLog(log + await savedLog(outputDirectory));
        return {pdf, log, engine: engine.label || engine.engine, mainPath: validated.mainPath};
    } catch (error) {
        log = boundedLog(log + (error.log || '') + await savedLog(outputDirectory));
        const reason = abort.signal.aborted ? abort.signal.reason : error;
        throw new CompilationError(reason.message, reason.code || 'COMPILE_FAILED', log);
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', forwardAbort);
        // This path is created by mkdtemp above, never provided by a project file.
        if (path.dirname(jobDirectory) === temporaryParent && path.basename(jobDirectory).startsWith('visuallatex-compile-')) {
            await rm(jobDirectory, {recursive: true, force: true, maxRetries: 3});
        }
    }
}
