import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/workspace-fixture.mjs';

async function visual(body) {
    const f = await fixture();
    const source = '\\documentclass{article}\n\\begin{document}\n' + body + '\n\\end{document}\n';
    await f.input('sourceArea', source);
    await f.click('modeVisual'); f.refresh();
    assert.equal(f.app.model.get().text, source, 'opening visual mode must preserve the original source');
    return {f, source};
}

test('deleting the space after an imported control word cannot merge the following text into its name', async () => {
    for (const body of [String.raw`\LaTeX book`, String.raw`\section{\LaTeX book}`,
        String.raw`\textbf{\LaTeX book}`, String.raw`\begin{itemize}\item \LaTeX book\end{itemize}`]) {
        const {f} = await visual(body);
        const command = f.node('editorArea').querySelectorAll('.tex-cmd')
            .find(node => node.getAttribute('data-tex-source') === String.raw`\LaTeX`);
        const siblings = command.parentNode.childNodes;
        const following = siblings[siblings.indexOf(command) + 1];
        assert.equal(following.textContent, ' book');
        following.textContent = 'book';
        await f.emit(f.node('editorArea'), 'input');
        await f.click('modeSource');
        assert.ok(f.app.model.get().text.includes(String.raw`\LaTeX{}book`));
        assert.doesNotMatch(f.app.model.get().text, /\\LaTeXbook/);
        await f.click('modeVisual'); f.refresh();
        assert.ok(f.node('editorArea').querySelectorAll('.tex-cmd')
            .some(node => node.getAttribute('data-tex-source') === String.raw`\LaTeX{}`));
    }
});

test('empty paragraph placeholders disappear from exported source without creating a line-break command', async () => {
    for (const tag of ['p', 'div']) {
        const {f, source} = await visual('Alpha\n\nBeta');
        const paragraph = f.node('editorArea').querySelector('p');
        if (tag === 'div') paragraph.tagName = 'DIV';
        // Chromium leaves this placeholder after the user deletes all paragraph text.
        paragraph.innerHTML = '<br>';
        paragraph.appendChild(f.document.createTextNode(''));
        await f.emit(f.node('editorArea'), 'input');
        await f.click('modeSource');
        assert.equal(f.app.model.get().text, source.replace('Alpha', ''));
        assert.doesNotMatch(f.app.model.get().text, /\\\\/);
    }
});

test('actual imported and newly inserted line breaks survive the placeholder check', async () => {
    const {f, source} = await visual(String.raw`Alpha\\[2pt]Beta`);
    const paragraph = f.node('editorArea').querySelector('p');
    paragraph.childNodes[0].textContent = 'Changed';
    await f.emit(f.node('editorArea'), 'input');
    await f.click('modeSource');
    assert.equal(f.app.model.get().text, source.replace('Alpha', 'Changed'));
    await f.click('modeVisual'); f.refresh();
    f.node('editorArea').querySelector('p').innerHTML = 'First<br>Last<br>';
    await f.emit(f.node('editorArea'), 'input');
    await f.click('modeSource');
    assert.ok(f.app.model.get().text.includes('First\\\\\nLast\\\\\n'));

    const untouched = await visual(String.raw`\\*[1ex]`);
    await untouched.f.click('modeSource');
    assert.equal(untouched.f.app.model.get().text, untouched.source, 'an imported lone break owns real TeX source');
});

test('unchanged source and existing command separators remain exact after neighboring edits', async () => {
    const body = String.raw`Before \LaTeX book, \LaTeX-book, \LaTeX{}book and \\LaTeX.`;
    const {f, source} = await visual(body);
    await f.click('modeSource');
    assert.equal(f.app.model.get().text, source);
    await f.click('modeVisual'); f.refresh();
    f.node('editorArea').querySelector('p').childNodes[0].textContent = 'After ';
    await f.emit(f.node('editorArea'), 'input');
    await f.click('modeSource');
    assert.equal(f.app.model.get().text, source.replace('Before ', 'After '));
});
