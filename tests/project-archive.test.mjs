import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { deflateRawSync } from 'node:zlib';

const context = vm.createContext({TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, Blob, DecompressionStream});
vm.runInContext(fs.readFileSync(new URL('../project-archive.js', import.meta.url), 'utf8'), context);
const zip = context.ProjectArchive;
const encode = text => new TextEncoder().encode(text);
const decode = bytes => new TextDecoder().decode(bytes);

// Build a single ZIP member with independent zlib compression and optional streaming descriptor.
function fixture(path, text, {method = 8, descriptor = false, directory = false} = {}) {
    const name = encode(directory ? path + '/' : path);
    const original = typeof text === 'string' ? encode(text) : text;
    const payload = method === 8 ? new Uint8Array(deflateRawSync(original)) : original;
    const flags = 0x0800 | (descriptor ? 8 : 0);
    const dataStart = 30 + name.length;
    const central = dataStart + payload.length + (descriptor ? 16 : 0);
    const end = central + 46 + name.length;
    const bytes = new Uint8Array(end + 22);
    const view = new DataView(bytes.buffer);
    const crc = zip.crc32(original);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, flags, true);
    view.setUint16(8, method, true);
    if (!descriptor) {
        view.setUint32(14, crc, true);
        view.setUint32(18, payload.length, true);
        view.setUint32(22, original.length, true);
    }
    view.setUint16(26, name.length, true);
    bytes.set(name, 30);
    bytes.set(payload, dataStart);
    if (descriptor) {
        const offset = dataStart + payload.length;
        view.setUint32(offset, 0x08074b50, true);
        view.setUint32(offset + 4, crc, true);
        view.setUint32(offset + 8, payload.length, true);
        view.setUint32(offset + 12, original.length, true);
    }
    view.setUint32(central, 0x02014b50, true);
    view.setUint16(central + 4, 20, true);
    view.setUint16(central + 6, 20, true);
    view.setUint16(central + 8, flags, true);
    view.setUint16(central + 10, method, true);
    view.setUint32(central + 16, crc, true);
    view.setUint32(central + 20, payload.length, true);
    view.setUint32(central + 24, original.length, true);
    view.setUint16(central + 28, name.length, true);
    bytes.set(name, central + 46);
    view.setUint32(end, 0x06054b50, true);
    view.setUint16(end + 8, 1, true);
    view.setUint16(end + 10, 1, true);
    view.setUint32(end + 12, 46 + name.length, true);
    view.setUint32(end + 16, central, true);
    return {bytes, view, central, end, dataStart};
}

test('ZIP project export and import preserve paths, UTF-8 text, CRLF, and binary resources', async () => {
    const files = [
        {path: 'main.tex', bytes: encode('\\documentclass{article}\r\n未完成 \\cite{')},
        {path: '文献/references.bib', bytes: encode('@book{key, title={A}}')},
        {path: 'figures/example.ps', bytes: encode('%!PS-Adobe-3.0\n100 100 moveto\nshowpage\n')},
        {path: 'assets/image.png', bytes: Uint8Array.from([0, 255, 137, 13, 10, 0, 128])},
    ];
    const result = await zip.readZip(zip.writeZip(files));
    assert.equal(result.length, files.length);
    result.forEach((file, index) => {
        assert.equal(file.path, files[index].path);
        assert.deepEqual(file.bytes, files[index].bytes);
    });
    assert.deepEqual(zip.writeZip(files), zip.writeZip(files), 'exports are deterministic');
});

test('empty ZIP and zero-byte files are valid', async () => {
    assert.equal((await zip.readZip(zip.writeZip([]))).length, 0);
    assert.equal((await zip.readZip(zip.writeZip([{path:'empty.tex',bytes:new Uint8Array()}])))[0].bytes.length, 0);
});

test('UTF-8 filename decoding does not drop a leading BOM character', async () => {
    const name = '\ufeffnamed.tex';
    const files = await zip.readZip(zip.writeZip([{path:name,bytes:encode('content')}]));
    assert.equal(files[0].path, name);
});

test('ZIP reads deflate compressed projects and streaming data descriptors', async () => {
    for (const descriptor of [false, true]) {
        const source = 'PostScript % keep\r\n'.repeat(500);
        const result = await zip.readZip(fixture('drawing.ps', source, {descriptor}).bytes);
        assert.equal(result[0].path, 'drawing.ps');
        assert.equal(decode(result[0].bytes), source);
    }
});

test('safe directory entries are ignored', async () => {
    assert.equal((await zip.readZip(fixture('figures', '', {directory:true, method:0}).bytes)).length, 0);
});

test('path traversal, absolute paths, control characters and normalization duplicates are rejected', async () => {
    for (const path of ['../x.tex', '/x.tex', 'C:/x.tex', 'a/../x.tex', 'a/./x.tex', 'a//x.tex', 'x\0.tex', 'a:b.tex']) {
        assert.throws(() => zip.writeZip([{path,bytes:encode('x')}]));
        await assert.rejects(zip.readZip(fixture(path, 'x').bytes));
    }
    assert.throws(() => zip.writeZip([{path:'A.tex',bytes:encode('a')},{path:'a.tex',bytes:encode('b')}]));
    assert.throws(() => zip.writeZip([{path:'a\\b.tex',bytes:encode('a')},{path:'a/b.tex',bytes:encode('b')}]));
    assert.equal(zip.validatePath('目录\\main.tex'), '目录/main.tex');
});

test('CRC corruption, mismatched local headers and truncated archives fail without partial output', async () => {
    const corrupted = fixture('a.tex', 'content', {method:0});
    corrupted.bytes[corrupted.dataStart] ^= 1;
    await assert.rejects(zip.readZip(corrupted.bytes), /校验/);
    const nameMismatch = fixture('a.tex', 'content');
    nameMismatch.bytes[30] = 98;
    await assert.rejects(zip.readZip(nameMismatch.bytes), /名称/);
    const sizes = fixture('a.tex', 'content');
    sizes.view.setUint32(22, 999, true);
    await assert.rejects(zip.readZip(sizes.bytes), /不一致/);
    await assert.rejects(zip.readZip(fixture('a.tex', 'content').bytes.slice(0, -1)), /目录/);
});

test('encrypted, multi-disk, ZIP64 and unsupported compression are rejected', async () => {
    const encrypted = fixture('a.tex', 'x');
    encrypted.view.setUint16(encrypted.central + 8, 0x0801, true);
    await assert.rejects(zip.readZip(encrypted.bytes), /加密/);
    const multidisk = fixture('a.tex', 'x');
    multidisk.view.setUint16(multidisk.end + 4, 1, true);
    await assert.rejects(zip.readZip(multidisk.bytes), /分卷/);
    const large = fixture('a.tex', 'x');
    large.view.setUint32(large.central + 24, 0xffffffff, true);
    await assert.rejects(zip.readZip(large.bytes), /ZIP64/);
    const method = fixture('a.tex', 'x');
    method.view.setUint16(method.central + 10, 12, true);
    await assert.rejects(zip.readZip(method.bytes), /压缩方式/);
});

test('project count and declared expanded size limits are enforced before decompression', async () => {
    assert.throws(() => zip.writeZip(Array.from({length:501}, (_,n)=>({path:n+'.tex',bytes:encode('')}))), /500/);
    const bomb = fixture('a.tex', 'x');
    bomb.view.setUint32(bomb.central + 24, zip.MAX_TOTAL_BYTES + 1, true);
    await assert.rejects(zip.readZip(bomb.bytes), /50 MB/);
});

test('decompression cannot exceed a falsely small declared size', async () => {
    const bomb = fixture('a.tex', 'x'.repeat(100000));
    bomb.view.setUint32(22, 1, true);
    bomb.view.setUint32(bomb.central + 24, 1, true);
    await assert.rejects(zip.readZip(bomb.bytes), /超过声明大小/);
});

test('CRC32 matches the standard reference vector', () => {
    assert.equal(zip.crc32(encode('123456789')), 0xcbf43926);
});

test('ZIP comments roundtrip Unicode metadata without changing the default array API', async () => {
    const comment = JSON.stringify({name:'排版项目 📄',mainPath:'图形/example.ps'});
    const source = '%!PS-Adobe-3.0\r\nshowpage\r\n';
    const bytes = zip.writeZip([{path:'图形/example.ps',bytes:encode(source)}], {comment});
    const defaultResult = await zip.readZip(bytes);
    assert.equal(Array.isArray(defaultResult), true);
    assert.equal(defaultResult.length, 1);
    assert.equal(decode(defaultResult[0].bytes), source);
    const detailed = await zip.readZip(bytes, {includeComment:true});
    assert.equal(detailed.comment, comment);
    assert.equal(detailed.files[0].path, '图形/example.ps');
    assert.equal(decode(detailed.files[0].bytes), source);
    const empty = await zip.readZip(zip.writeZip([]), {includeComment:true});
    assert.equal(empty.files.length, 0);
    assert.equal(empty.comment, '');
});

test('ZIP comments enforce the 65535-byte UTF-8 boundary rather than character count', async () => {
    const accepted = '中'.repeat(21845);
    assert.equal(encode(accepted).length, 65535);
    const detailed = await zip.readZip(zip.writeZip([], {comment:accepted}), {includeComment:true});
    assert.equal(detailed.comment, accepted);
    assert.throws(() => zip.writeZip([], {comment:accepted + '中'}));
    assert.throws(() => zip.writeZip([], {comment:'a'.repeat(65536)}));
});

test('non-UTF-8 external comments use replacement decoding without losing project files', async () => {
    const external = fixture('main.tex', 'Unchanged \\cite{key}', {method:0});
    const comment = Uint8Array.from([0x43, 0x61, 0x66, 0xe9]);
    const bytes = new Uint8Array(external.bytes.length + comment.length);
    bytes.set(external.bytes);
    bytes.set(comment, external.bytes.length);
    new DataView(bytes.buffer).setUint16(external.end + 20, comment.length, true);
    const detailed = await zip.readZip(bytes, {includeComment:true});
    assert.equal(detailed.comment, 'Caf\ufffd');
    assert.equal(detailed.files.length, 1);
    assert.equal(detailed.files[0].path, 'main.tex');
    assert.equal(decode(detailed.files[0].bytes), 'Unchanged \\cite{key}');
    const defaultResult = await zip.readZip(bytes);
    assert.equal(defaultResult.length, 1);
});
