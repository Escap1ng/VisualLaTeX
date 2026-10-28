import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const controller = fs.readFileSync(new URL('../workspace.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../workspace.css', import.meta.url), 'utf8');
const tags = [...html.matchAll(/<([a-z][a-z\d-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)];
const ids = new Map(tags.map(match => [match[3], {tag: match[1].toLowerCase(), attributes: match[2]}]));

test('all direct workspace lookups and event bindings resolve to unique DOM IDs', () => {
    assert.equal(ids.size, tags.length, 'each id must occur exactly once');
    const lookups = [...controller.matchAll(/\$\(\s*(['"])([^'"]+)\1\s*\)/g)].map(match => match[2]);
    const bindings = [...controller.matchAll(/\bbind\(\s*(['"])([^'"]+)\1\s*,/g)].map(match => match[2]);
    assert.ok(lookups.length > 20, 'inspect actual controller references');
    assert.ok(bindings.length > 20, 'inspect actual controller event bindings');
    for (const id of new Set([...lookups, ...bindings])) assert.ok(ids.has(id), `missing workspace control #${id}`);
});

test('dynamic toolbar arrays and project/editor controls have real markup', () => {
    const knownDynamic = [
        'btnH1', 'btnH2', 'btnH3', 'btnBold', 'btnItalic', 'btnCenter', 'btnUl', 'btnOl',
        'btnInlineFormula', 'btnBlockFormula', 'btnImage', 'btnInsertCitation', 'btnInsertReference',
        'btnInsertLabel', 'btnCopy', 'btnFind', 'renameFile', 'deleteFile', 'setMainFile', 'btnDownload',
        'btnEncoding', 'btnFiles', 'btnOutline', 'newFile', 'btnAddBibEntry', 'projectName', 'fileTree',
        'sourceArea', 'lineNumbers', 'sourcePanel', 'visualPanel', 'assetPanel', 'editorArea',
        'importFiles', 'importFolder', 'importProject', 'outlineList', 'referenceList', 'saveState',
    ];
    const discoveredDynamic = [];
    for (const array of controller.matchAll(/for\s*\(const\s+id\s+of\s*\[([^\]]+)\]/g)) {
        for (const literal of array[1].matchAll(/['"]([^'"]+)['"]/g)) discoveredDynamic.push(literal[1]);
    }
    for (const id of new Set([...knownDynamic, ...discoveredDynamic])) assert.ok(ids.has(id), `missing dynamic control #${id}`);
    assert.equal(ids.get('btnEncoding').tag, 'button');
    assert.match(html, /id="btnEncoding"[^>]*>UTF-8<\/button>/);
});

test('offline scripts and stylesheet overrides load in dependency order', () => {
    const scripts = [...html.matchAll(/<script\s+src="([^"]+)"[^>]*>/g)].map(match => match[1]);
    assert.deepEqual(scripts, ['main.js', 'project-model.js', 'project-archive.js', 'workspace.js', 'preview.js']);
    const styles = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"[^>]*>/g)].map(match => match[1]);
    assert.deepEqual(styles, ['style.css', 'workspace.css', 'preview.css']);
    for (const resource of [...scripts, ...styles]) {
        assert.doesNotMatch(resource, /^(?:https?:)?\/\//);
        assert.ok(fs.existsSync(new URL('../' + resource, import.meta.url)), `missing local resource ${resource}`);
    }
});

test('source starts editable while alternate panes honor hidden independently of legacy CSS', () => {
    assert.equal(ids.get('sourceArea').tag, 'textarea');
    assert.match(ids.get('sourceArea').attributes, /\bwrap="off"/);
    assert.match(ids.get('sourceArea').attributes, /\bspellcheck="false"/);
    assert.doesNotMatch(ids.get('sourceArea').attributes, /\b(?:readonly|disabled)\b/);
    assert.doesNotMatch(ids.get('sourcePanel').attributes, /\bhidden\b/);
    for (const id of ['visualPanel', 'assetPanel', 'findPanel']) assert.match(ids.get(id).attributes, /\bhidden\b/);
    assert.match(css, /\.workspace-app\s+\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;\s*\}/);
    assert.match(css, /\.workbench\.main-content\s*\{[^}]*display:\s*grid\s*;/);
    assert.match(css, /\.source-panel\s*\{[^}]*display:\s*flex\s*;/);
    assert.doesNotMatch(html, /class="(?:editor-panel|preview-panel)"/, 'legacy mobile selectors must not control workspace panes');
});

test('source, modes, project name and file panels expose accessible control labels', () => {
    assert.match(ids.get('sourceArea').attributes, /\baria-label="[^"]+"/);
    assert.match(ids.get('projectName').attributes, /\baria-label="[^"]+"/);
    assert.match(ids.get('modeSource').attributes, /\baria-pressed="true"/);
    assert.match(ids.get('modeVisual').attributes, /\baria-pressed="false"/);
    for (const id of ['btnFiles', 'btnOutline']) {
        const controlledId = /aria-controls="([^"]+)"/.exec(ids.get(id).attributes)?.[1];
        assert.ok(ids.has(controlledId), `${id} must identify its controlled panel`);
        assert.match(ids.get(id).attributes, /aria-expanded="false"/);
    }
    assert.match(css, /:focus-visible/);
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
    assert.match(css, /@media\s*\(max-width:\s*700px\)/);
});
