/**
 * VisualLaTeX 零依赖冒烟检查
 * 1) 校验 index.html 引用的本地资源文件存在
 * 2) 校验 HTML 成对标签闭合配对
 * 3) 校验 main.js 中 getElementById 引用的 id 均存在于 index.html（防止改 id 导致功能失效）
 * 运行方式：node tests/smoke.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

let failed = false;
const fail = (msg) => {
    console.error('[FAIL] ' + msg);
    failed = true;
};

// 1) 引用的本地资源存在
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((p) => p && !p.startsWith('http') && !p.startsWith('#'));
for (const ref of refs) {
    if (!fs.existsSync(path.join(root, ref))) {
        fail('index.html 引用的资源不存在: ' + ref);
    }
}

// 2) 成对标签闭合配对
for (const tag of ['div', 'span', 'p', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'table', 'section', 'label', 'button', 'textarea']) {
    const open = (html.match(new RegExp('<' + tag + '[\\s>]', 'g')) || []).length;
    const close = (html.match(new RegExp('</' + tag + '>', 'g')) || []).length;
    if (open !== close) {
        fail(`index.html 标签不配对: <${tag}> 开=${open} 闭=${close}`);
    }
}

// 3) main.js 引用的 id 均存在
const js = fs.readFileSync(path.join(root, 'src/js/main.js'), 'utf8');
const ids = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
for (const id of new Set(ids)) {
    if (!new RegExp('id="' + id + '"').test(html)) {
        fail('main.js 引用的 id 在 index.html 中不存在: #' + id);
    }
}

if (failed) {
    process.exit(1);
}
console.log('冒烟检查通过：资源完整、标签配对、DOM id 一致');
