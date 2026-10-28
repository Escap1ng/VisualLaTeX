import test from 'node:test';
import assert from 'node:assert/strict';
import {access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {compileProject, discoverEngines, runProcess} from '../compiler.mjs';

const pdf = Buffer.from('%PDF-1.7\nfixture\n%%EOF');
const text = (path, text, encoding = 'utf-8') => ({path, kind: 'text', text, encoding});
const project = (files, mainPath = files[0]?.path) => ({format: 'visual-workspace', version: 1, name: 'Test project', files, mainPath, activePath: mainPath});
const engines = {
    latex: {available: true, engine: 'tectonic', label: 'Tectonic', executable: '/configured/tectonic'},
    postscript: {available: true, engine: 'ghostscript', label: 'Ghostscript', executable: '/configured/ghostscript'}
};
async function root(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'visual-compiler-tests-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    return directory;
}
function emitPdf(args, options) {
    const gs = args.find(arg => arg.startsWith('-sOutputFile='));
    const target = gs ? gs.slice('-sOutputFile='.length) : args.some(arg => arg.startsWith('-jobname='))
        ? path.join(options.outputDirectory, 'visual-workspace.pdf')
        : path.join(options.outputDirectory, path.parse(args.at(-1)).name + '.pdf');
    return writeFile(target, pdf);
}

test('engine discovery uses explicit executable paths and reports missing engines', async t => {
    const directory = await root(t);
    const binary = path.join(directory, 'engine with spaces' + (process.platform === 'win32' ? '.exe' : ''));
    await writeFile(binary, 'fixture');
    await chmod(binary, 0o755);
    const found = await discoverEngines({toolsDirectory: directory, env: {PATH: '', VISUALLATEX_TECTONIC: binary, VISUALLATEX_GHOSTSCRIPT: binary}});
    assert.equal(found.latex.engine, 'tectonic');
    assert.equal(found.latex.executable, binary);
    assert.equal(found.postscript.available, true);
    const missing = await discoverEngines({toolsDirectory: directory, env: {PATH: '', VISUALLATEX_TECTONIC: path.join(directory, 'missing')}});
    assert.equal(missing.latex.available, false);
    assert.equal(missing.postscript.available, false);
});

test('portable engines are found automatically while an explicit XeLaTeX choice wins', async t => {
    const directory = await root(t);
    const extension = process.platform === 'win32' ? '.exe' : '';
    const tectonic = path.join(directory, 'tectonic', 'tectonic' + extension);
    const gs = path.join(directory, 'ghostscript', 'bin', process.platform === 'win32' ? 'gswin64c.exe' : 'gs');
    const xelatex = path.join(directory, 'xelatex' + extension);
    for (const binary of [tectonic, gs, xelatex]) {
        await mkdir(path.dirname(binary), {recursive: true});
        await writeFile(binary, 'fixture'); await chmod(binary, 0o755);
    }
    const portable = await discoverEngines({toolsDirectory: directory, env: {PATH: ''}});
    assert.equal(portable.latex.executable, tectonic);
    assert.equal(portable.postscript.executable, gs);
    const selected = await discoverEngines({toolsDirectory: directory, env: {PATH: '', VISUALLATEX_XELATEX: xelatex}});
    assert.equal(selected.latex.engine, 'xelatex');
    assert.equal(selected.latex.executable, xelatex);
});

test('LaTeX compilation stages all files unchanged, passes untrusted flags and removes its temporary tree', async t => {
    const temporaryParent = await root(t);
    const binary = Buffer.from([0, 255, 128, 1, 2]);
    const files = [text('docs/main.tex', '\\input{chapter}\r\n'), text('docs/chapter.tex', 'A citation \\cite{key}.'),
        text('refs.bib', '@book{key,title={Book}}'), text('figures/latin.ps', '%!PS\né', 'latin1'),
        {path: 'figures/picture.bin', kind: 'binary', base64: binary.toString('base64')}];
    let jobDirectory;
    const result = await compileProject(project(files), {kind: 'latex', engines, temporaryParent,
        runner: async (command, args, options) => {
            assert.equal(command, engines.latex.executable);
            assert.ok(args.includes('--untrusted'));
            assert.equal(options.env.TECTONIC_UNTRUSTED_MODE, '1');
            assert.equal(options.env.shell_escape, '0');
            assert.equal(options.cwd, path.join(options.sourceDirectory, 'docs'));
            assert.equal(await readFile(path.join(options.sourceDirectory, 'docs/main.tex'), 'utf8'), files[0].text);
            assert.equal(await readFile(path.join(options.sourceDirectory, 'refs.bib'), 'utf8'), files[2].text);
            assert.deepEqual(await readFile(path.join(options.sourceDirectory, 'figures/picture.bin')), binary);
            assert.deepEqual(await readFile(path.join(options.sourceDirectory, 'figures/latin.ps')), Buffer.from(files[3].text, 'latin1'));
            jobDirectory = path.dirname(options.sourceDirectory);
            await emitPdf(args, options);
            await writeFile(path.join(options.outputDirectory, 'main.log'), 'A useful warning');
            return {code: 0, log: 'Compiled'};
        }});
    assert.deepEqual(result.pdf, pdf);
    assert.equal(result.mainPath, 'docs/main.tex');
    assert.match(result.log, /useful warning/);
    await assert.rejects(access(jobDirectory));
    assert.deepEqual(await readdir(temporaryParent), []);
});

test('PS and binary EPS render through Ghostscript pdfwrite with SAFER and appropriate cropping', async t => {
    const temporaryParent = await root(t);
    for (const extension of ['ps', 'eps']) {
        const contents = Buffer.from(extension === 'eps' ? [0xc5, 0xd0, 0xd3, 0xc6, 0, 255] : '%!PS\nshowpage');
        const source = {path: 'drawing.' + extension, kind: 'binary', base64: contents.toString('base64')};
        const result = await compileProject({...project([source]), mainPath: null}, {kind: 'postscript', mainPath: source.path, engines, temporaryParent,
            runner: async (command, args, options) => {
                assert.equal(command, engines.postscript.executable);
                for (const flag of ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite', '-f']) assert.ok(args.includes(flag));
                assert.equal(args.includes('-dEPSCrop'), extension === 'eps');
                assert.ok(args.some(arg => arg.startsWith('--permit-file-read=')));
                assert.ok(args.some(arg => arg.startsWith('--permit-file-write=')));
                assert.equal(options.env.GS_OPTIONS, undefined);
                assert.deepEqual(await readFile(args.at(-1)), contents);
                await emitPdf(args, options);
                return {code: 0, log: 'Rendered'};
            }});
        assert.deepEqual(result.pdf, pdf);
    }
    assert.deepEqual(await readdir(temporaryParent), []);
});

test('PostScript permits staged resources by relative filename without granting arbitrary reads', async t => {
    const temporaryParent = await root(t);
    await compileProject(project([text('drawing.ps', '(parts/shared.ps) run'), text('parts/shared.ps', 'showpage')]), {
        kind: 'postscript', engines, temporaryParent, runner: async (_, args, options) => {
            assert.ok(args.includes('--permit-file-read=parts/shared.ps'));
            assert.ok(args.includes('--permit-file-read=./parts/shared.ps'));
            assert.ok(!args.includes('--permit-file-read=*'));
            assert.ok(!args.includes('-dNOSAFER'));
            await emitPdf(args, options); return {code: 0};
        }});
    assert.deepEqual(await readdir(temporaryParent), []);
    let invoked = false;
    await assert.rejects(compileProject(project([text('drawing.ps', 'showpage'), text('name' + path.delimiter + '/outside', 'resource')]), {
        kind: 'postscript', engines, temporaryParent, runner: async () => { invoked = true; }
    }));
    assert.equal(invoked, false, 'a filename cannot add an extra Ghostscript permission');
});

test('Tectonic Biber projects never return a PDF with incomplete bibliography as success', async t => {
    const temporaryParent = await root(t);
    await assert.rejects(compileProject(project([text('main.tex', 'biblatex with Biber')]), {
        kind: 'latex', engines, temporaryParent, runner: async (_, args, options) => {
            assert.ok(args.includes('--keep-intermediates'));
            await emitPdf(args, options);
            await writeFile(path.join(options.outputDirectory, 'main.bcf'), '<bcf:controlfile/>');
            return {code: 0};
        }}), {code: 'BIBLIOGRAPHY_ENGINE_MISSING'});
    assert.deepEqual(await readdir(temporaryParent), []);
    await assert.rejects(compileProject(project([text('main.tex', 'biblatex with Biber')]), {
        kind: 'latex', engines, temporaryParent,
        runner: async () => ({code: 1, log:'note: Running external tool biber ...\nerror: program not found'})
    }), {code: 'BIBLIOGRAPHY_ENGINE_MISSING'});
});

test('filesystem-unsafe paths, directory collisions and wrong main kinds are rejected before running an engine', async t => {
    const temporaryParent = await root(t);
    let calls = 0;
    const options = {kind: 'latex', engines, temporaryParent, runner: async () => { calls++; }};
    for (const file of ['../escape.tex', 'C:/escape.tex', 'NUL.tex', 'trailing. /main.tex', 'dir*/main.tex']) {
        await assert.rejects(compileProject(project([text(file, 'text')]), options));
    }
    await assert.rejects(compileProject(project([text('main.tex', 'x'), text('dir', 'file'), text('dir/child.tex', 'child')]), options), {code: 'INVALID_PATH'});
    await assert.rejects(compileProject(project([text('notes.txt', 'x')]), options), {code: 'INVALID_MAIN'});
    await assert.rejects(compileProject(project([text('main.tex', 'x')]), {...options, kind: 'postscript'}), {code: 'INVALID_MAIN'});
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(temporaryParent), []);
});

test('missing engine and pre-cancelled request leave no temporary files', async t => {
    const temporaryParent = await root(t);
    const source = project([text('main.tex', 'x')]);
    await assert.rejects(compileProject(source, {kind: 'latex', temporaryParent, engines: {latex: {available: false}}}), {code: 'ENGINE_MISSING'});
    const controller = new AbortController(); controller.abort();
    await assert.rejects(compileProject(source, {kind: 'latex', temporaryParent, engines, signal: controller.signal}), {code: 'CANCELLED'});
    assert.deepEqual(await readdir(temporaryParent), []);
});

test('compiler failures retain bounded logs and clean every staged file', async t => {
    const temporaryParent = await root(t);
    await assert.rejects(compileProject(project([text('main.tex', 'bad')]), {kind: 'latex', engines, temporaryParent,
        runner: async (_, __, options) => {
            await writeFile(path.join(options.outputDirectory, 'main.log'), 'x'.repeat(700000) + '\nmain.tex:4: Undefined command');
            return {code: 1, log: 'TeX error'};
        }}), error => {
        assert.equal(error.code, 'COMPILE_FAILED');
        assert.match(error.log, /main.tex:4: Undefined command/);
        assert.ok(Buffer.byteLength(error.log) < 530000);
        return true;
    });
    assert.deepEqual(await readdir(temporaryParent), []);
});

test('missing or non-PDF engine output is never returned as a successful preview', async t => {
    const temporaryParent = await root(t);
    for (const invalid of [null, '<html>not a PDF</html>']) {
        await assert.rejects(compileProject(project([text('main.tex', 'x')]), {kind: 'latex', engines, temporaryParent,
            runner: async (_, args, options) => {
                if (invalid) await writeFile(path.join(options.outputDirectory, 'main.pdf'), invalid);
                return {code: 0, log: ''};
            }}), {code: invalid ? 'INVALID_OUTPUT' : 'PDF_MISSING'});
    }
    assert.deepEqual(await readdir(temporaryParent), []);
});

test('timeout and cancellation stop the runner and remove staged project data', async t => {
    const temporaryParent = await root(t);
    for (const action of ['timeout', 'cancel']) {
        const controller = new AbortController();
        const pending = compileProject(project([text('main.tex', 'x')]), {kind: 'latex', engines, temporaryParent,
            timeoutMs: action === 'timeout' ? 20 : 2000, signal: controller.signal,
            runner: (_, __, {signal}) => new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), {once: true});
                if (action === 'cancel') controller.abort();
            })});
        await assert.rejects(pending, {code: action === 'timeout' ? 'COMPILE_TIMEOUT' : 'CANCELLED'});
        assert.deepEqual(await readdir(temporaryParent), []);
    }
});

test('XeLaTeX runs bibliography and subsequent reference passes with shell escape disabled', async t => {
    const temporaryParent = await root(t);
    const calls = [];
    const configured = {latex: {available: true, engine: 'xelatex', executable: '/engine/xelatex', bibtex: '/engine/bibtex'}};
    const result = await compileProject(project([text('main.tex', 'source'), text('refs.bib', '@book{key,title={Book}}')]), {
        kind: 'latex', engines: configured, temporaryParent, runner: async (command, args, options) => {
            calls.push(command);
            if (command.endsWith('xelatex')) {
                assert.ok(args.includes('-no-shell-escape'));
                assert.ok(args.includes('-no-parse-first-line'));
                await writeFile(path.join(options.outputDirectory, 'visual-workspace.aux'), '\\bibdata{refs}\n');
                await emitPdf(args, options);
            } else {
                assert.deepEqual(args, ['visual-workspace']);
                assert.match(options.env.BIBINPUTS, /project/);
            }
            return {code: 0, log: 'ok'};
        }});
    assert.deepEqual(calls, ['/engine/xelatex', '/engine/bibtex', '/engine/xelatex', '/engine/xelatex']);
    assert.deepEqual(result.pdf, pdf);
});

test('XeLaTeX reports missing bibliography engines instead of claiming successful references', async t => {
    const temporaryParent = await root(t);
    await assert.rejects(compileProject(project([text('main.tex', 'source')]), {
        kind: 'latex', engines: {latex: {available: true, engine: 'xelatex', executable: '/engine/xelatex'}}, temporaryParent,
        runner: async (_, __, options) => {
            await writeFile(path.join(options.outputDirectory, 'visual-workspace.aux'), '\\bibdata{refs}\n');
            return {code: 0};
        }}), {code: 'BIBLIOGRAPHY_ENGINE_MISSING'});
    assert.deepEqual(await readdir(temporaryParent), []);
});

test('actual process runner treats arguments literally and captures nonzero exits', async () => {
    const literal = 'spaces & | $(not-a-shell) %test%';
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1]); process.exitCode=7', literal]);
    assert.equal(result.code, 7);
    assert.equal(result.log, literal);
});

test('actual process runner terminates a running process on abort', async () => {
    const controller = new AbortController();
    const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {signal: controller.signal});
    const timer = setTimeout(() => controller.abort(), 100);
    try { await assert.rejects(pending, /取消|abort/i); }
    finally { clearTimeout(timer); }
});
