import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../visual-math.js', import.meta.url), 'utf8'), context);
const {split, combine, unwrap, safe, mathValue} = context.VisualMath;
const plain = value => JSON.parse(JSON.stringify(value));

test('legal whitespace in nested environment boundaries keeps labels on their mathematical row', () => {
    const source = String.raw`x+\begin {matrix}a\\b\end {matrix}\label{eq:m}`;
    const parts = split(source);
    assert.equal(parts.rows.length, 1);
    assert.equal(parts.metadata[0].row, 0);
    const result = combine(parts, String.raw`x+1+\begin{matrix}a\\b\end{matrix}`, [], true);
    assert.equal(result, String.raw`x+1+\begin{matrix}a\\b\end{matrix}\label{eq:m}`);
    assert.equal(unwrap(String.raw`\begin {aligned}a&=b\\c&=d\end {aligned}`), String.raw`a&=b\\c&=d`);
});

test('split preserves row associations for labels, tags, comments and optional row spacing', () => {
    const source = 'a &= b \\label{eq:first}\\tag{A 1}% first\r\n\\\\[6pt]\r\nc &= d \\tag*{Second}\\label{eq:second}% second';
    const parts = split(source);
    assert.equal(parts.rows.length, 2);
    assert.deepEqual(plain(parts.metadata.map(({kind, value, row}) => ({kind, value, row}))), [
        {kind:'label', value:'eq:first', row:0}, {kind:'tag', value:'A 1', row:0}, {kind:'comment', row:0},
        {kind:'tag', value:'Second', row:1}, {kind:'label', value:'eq:second', row:1}, {kind:'comment', row:1}
    ]);
    assert.equal(parts.rawRows.join('\\\\'), source);
    assert.equal(parts.clean, 'a &= b \r\n\\\\[6pt]\r\nc &= d ');
    for (const entry of parts.metadata) assert.equal(source.slice(entry.start,entry.end), entry.raw);
});

test('escaped percentages, nested groups and matrix row separators stay mathematical content', () => {
    const source = String.raw`\text{50\% and a\\b} + \begin{matrix}a&b\\c&d\end{matrix} \label{one}\\x\label{two}`;
    const parts = split(source);
    assert.equal(parts.rows.length, 2);
    assert.deepEqual(plain(parts.metadata.map(entry => entry.row)), [0,1]);
    assert.match(parts.clean, /50\\%/);
    assert.match(parts.clean, /\\begin\{matrix\}a&b\\\\c&d\\end\{matrix\}/);
});

test('nested tags are extracted without corrupting their original LaTeX', () => {
    const source = String.raw`x=1\tag*{A {\mathrm{note}}}\label{eq:a}`;
    const parts = split(source);
    assert.equal(parts.clean, 'x=1');
    assert.equal(parts.metadata[0].value, String.raw`A {\mathrm{note}}`);
    assert.equal(combine(parts,'ignored',[],false), source);
    assert.equal(combine(parts,'ignored',['B 2'],false), String.raw`x=1\tag*{B 2}\label{eq:a}`);
});

test('no edits round trip every original byte regardless of editor normalization', () => {
    const source = ' \r\na= b\\label {same}% \\label{same}\r\n\\\\\r\nc=d\\label{same}\\tag{A 1} \r\n';
    const parts = split(source);
    assert.equal(combine(parts,'normalized elsewhere',[],false), source);
    assert.equal(combine(parts,parts.clean,[],true), source);
    assert.equal(combine(parts,mathValue(parts,'align'),[],true), source);
    assert.equal(combine(parts,'',parts.metadata.map(entry => entry.value),false), source);
});

test('editing repeated label commands uses exact source offsets and preserves comments', () => {
    const source = String.raw`a\label{same}% \label{same}
\\b\label{same}\tag*{A 1}`;
    const parts = split(source);
    const values = parts.metadata.map(entry => entry.value);
    values[0] = 'first';
    values[2] = 'second';
    values[3] = 'A 2';
    assert.equal(combine(parts,'',values,false), String.raw`a\label{first}% \label{same}
\\b\label{second}\tag*{A 2}`);
});

test('math edits preserve old metadata on its original align row', () => {
    const parts = split(String.raw`a=b\label{first}\tag{A}% first row
\\c=d\label{second}\tag*{B}% second row`);
    const result = combine(parts,String.raw`\begin{aligned}a&=b+1\\c&=d+2\end{aligned}`,[],true);
    const next = split(result);
    assert.equal(next.rows.length, 2);
    assert.deepEqual(plain(next.metadata.filter(entry => entry.kind !== 'comment').map(({kind,value,row}) => ({kind,value,row}))), [
        {kind:'label',value:'first',row:0}, {kind:'tag',value:'A',row:0},
        {kind:'label',value:'second',row:1}, {kind:'tag',value:'B',row:1}
    ]);
    assert.deepEqual(plain(next.metadata.filter(entry => entry.kind === 'comment').map(entry => entry.row)), [0,1]);
    assert.doesNotMatch(result,/\\begin\{aligned\}/);
});

test('new field labels, tags and comments survive saving alongside existing metadata', () => {
    const parts = split(String.raw`a\label{old}\tag{Old}`);
    const edited = String.raw`b\label{new}\tag{New number}% user note`;
    const result = combine(parts,edited,[],true);
    const metadata = split(result).metadata;
    assert.deepEqual(plain(metadata.filter(entry => entry.kind === 'label').map(entry => entry.value)), ['new','old']);
    assert.deepEqual(plain(metadata.filter(entry => entry.kind === 'tag').map(entry => entry.value)), ['New number']);
    assert.equal(metadata.filter(entry => entry.kind === 'comment')[0].raw, '% user note');
    assert.match(result, /% user note\n\\label\{old\}/);
    assert.throws(() => combine(parts,edited,['old','Another number'],true), /不同编号/);
});

test('pasting unchanged metadata does not duplicate labels, tags or comments', () => {
    const source = String.raw`a\label{key}\tag{A}% note`;
    const result = combine(split(source),source.replace('a','b'),[],true);
    const metadata = split(result).metadata;
    assert.equal(metadata.length, 3);
    assert.equal(metadata.filter(entry => entry.kind === 'label').length, 1);
});

test('deleting rows never silently drops labels, tags or comments', () => {
    const parts = split(String.raw`a\\b\label{second}\tag{B}`);
    assert.throws(() => combine(parts,'a',[],true), /被删除的公式行/);
    assert.equal(combine(parts,'a',['',''],true), 'a');
    assert.throws(() => combine(split('a\\\\b% note'),'a',[],true), /注释/);
});

test('invalid label input is rejected while display tags can contain spaces', () => {
    const parts = split(String.raw`x\label{old}\tag{A 1}`);
    for (const value of ['two words','a{b','a}b','a\\b','a%b','a[b','a]b','a,b','a#b','a$b','a&b','a^b','a~b','*','a\nb','a\0b']) {
        assert.throws(() => combine(parts,'',[value],false), /标签/);
        assert.throws(() => combine(split('x'),String.raw`y\label{`+value+'}',[],true), /标签/);
    }
    assert.equal(combine(parts,'',['eq:新编号','Theorem A 2'],false), String.raw`x\label{eq:新编号}\tag{Theorem A 2}`);
    assert.equal(combine(parts,'',['',''],false), 'x');
    assert.throws(() => combine(split('x'),String.raw`y\label{}`,[],true), /标签/);
});

test('unwrap removes only a complete matching wrapper and handles nested environments', () => {
    assert.equal(unwrap(String.raw` \begin{aligned}x\\y\end{aligned} `), String.raw`x\\y`);
    assert.equal(unwrap(String.raw`\begin{gathered}x\end{gathered}`), 'x');
    const nested = String.raw`\begin{aligned}a+\begin{aligned}b\\c\end{aligned}\end{aligned}`;
    assert.equal(unwrap(nested), String.raw`a+\begin{aligned}b\\c\end{aligned}`);
    for (const source of [String.raw`\begin{aligned}x\end{gathered}`, String.raw`\begin{aligned}a\end{aligned}+\begin{aligned}b\end{aligned}`, String.raw`\begin{matrix}a\end{matrix}`]) assert.equal(unwrap(source), source);
    assert.equal(unwrap('\\begin{aligned}x% \\end{aligned}\n+y\\end{aligned}'), 'x% \\end{aligned}\n+y');
});

test('source-owned wrappers survive edits and generated wrappers are removed once', () => {
    const source = String.raw`\begin{aligned}a\\b\end{aligned}`;
    const parts = split(source);
    assert.equal(combine(parts,source,[],true), source);
    const edited = source.replace('a\\\\b','a+1\\\\b');
    assert.equal(combine(parts,edited,[],true), edited);
    assert.equal(combine(parts,'\\begin{aligned}'+edited+'\\end{aligned}',[],true), edited);
});

test('mathValue uses appropriate visual wrappers without exposing editorial metadata', () => {
    const parts = split(String.raw`a=b\label{eq:a}`);
    assert.equal(mathValue(parts,'align*'), String.raw`\begin{aligned}a=b\end{aligned}`);
    assert.equal(mathValue(parts,'gather'), String.raw`\begin{gathered}a=b\end{gathered}`);
    assert.equal(mathValue(parts,'equation'), 'a=b');
    assert.equal(mathValue(parts), 'a=b');
});

test('safe blocks HTML and URL-bearing math directives before visual rendering', () => {
    for (const command of ['href','url','htmlData','htmlStyle','class','cssId','style','includegraphics','HREF']) assert.equal(safe('\\'+command+'{x}{y}'), false, command);
    for (const source of [String.raw`x^2+\frac{1}{2}`, String.raw`\text{href is text}`, String.raw`\label{eq:href}`]) assert.equal(safe(source), true);
    assert.equal(safe(null), false);
});
