/* ZIP project import/export. Classic script; no network or runtime dependencies. */
(function(root) {
    'use strict';
    const MAX_FILES = 500;
    const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
    const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
    const crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let value = n;
        for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        crcTable[n] = value >>> 0;
    }
    function fail(message) { throw new Error('ZIP：' + message); }
    function validatePath(path) {
        if (typeof path !== 'string' || !path || path.length > 1024) fail('文件路径为空或过长');
        const normalized = path.replace(/\\/g, '/');
        if (normalized.startsWith('/') || /[:\u0000-\u001f\u007f]/.test(normalized)) fail('不安全的文件路径：' + path);
        if (normalized.split('/').some(part => part === '' || part === '.' || part === '..')) fail('不安全的文件路径：' + path);
        return normalized;
    }
    const pathKey = path => path.normalize('NFC').toLowerCase();
    function crc32(bytes) {
        let crc = 0xffffffff;
        for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        return (crc ^ 0xffffffff) >>> 0;
    }
    function checkBytes(bytes) {
        if (!(bytes instanceof Uint8Array)) fail('文件内容必须是 Uint8Array');
        return bytes;
    }
    function writeZip(files, {comment = ''} = {}) {
        if (!Array.isArray(files) || files.length > MAX_FILES) fail('项目最多包含 ' + MAX_FILES + ' 个文件');
        if (typeof comment !== 'string') fail('压缩包备注必须是字符串');
        const commentBytes = encoder.encode(comment);
        if (commentBytes.length > 0xffff) fail('压缩包备注不能超过 65535 字节');
        const names = new Set();
        let total = 0;
        let length = 22 + commentBytes.length;
        const records = files.map(file => {
            const path = validatePath(file.path);
            const key = pathKey(path);
            if (names.has(key)) fail('重复文件路径：' + path);
            names.add(key);
            const bytes = checkBytes(file.bytes);
            total += bytes.length;
            if (total > MAX_TOTAL_BYTES) fail('项目解压后总大小不能超过 50 MB');
            const name = encoder.encode(path);
            length += 30 + name.length + bytes.length + 46 + name.length;
            return {path, name, bytes, crc: crc32(bytes)};
        });
        const out = new Uint8Array(length);
        const view = new DataView(out.buffer);
        let offset = 0;
        for (const record of records) {
            record.offset = offset;
            view.setUint32(offset, 0x04034b50, true);
            view.setUint16(offset + 4, 20, true);
            view.setUint16(offset + 6, 0x0800, true);
            view.setUint16(offset + 12, 0x0021, true); // 1980-01-01; deterministic archive.
            view.setUint32(offset + 14, record.crc, true);
            view.setUint32(offset + 18, record.bytes.length, true);
            view.setUint32(offset + 22, record.bytes.length, true);
            view.setUint16(offset + 26, record.name.length, true);
            out.set(record.name, offset + 30);
            out.set(record.bytes, offset + 30 + record.name.length);
            offset += 30 + record.name.length + record.bytes.length;
        }
        const centralOffset = offset;
        for (const record of records) {
            view.setUint32(offset, 0x02014b50, true);
            view.setUint16(offset + 4, 20, true);
            view.setUint16(offset + 6, 20, true);
            view.setUint16(offset + 8, 0x0800, true);
            view.setUint16(offset + 14, 0x0021, true);
            view.setUint32(offset + 16, record.crc, true);
            view.setUint32(offset + 20, record.bytes.length, true);
            view.setUint32(offset + 24, record.bytes.length, true);
            view.setUint16(offset + 28, record.name.length, true);
            view.setUint32(offset + 42, record.offset, true);
            out.set(record.name, offset + 46);
            offset += 46 + record.name.length;
        }
        view.setUint32(offset, 0x06054b50, true);
        view.setUint16(offset + 8, records.length, true);
        view.setUint16(offset + 10, records.length, true);
        view.setUint32(offset + 12, offset - centralOffset, true);
        view.setUint32(offset + 16, centralOffset, true);
        view.setUint16(offset + 20, commentBytes.length, true);
        out.set(commentBytes, offset + 22);
        return out;
    }
    async function inflate(bytes, expected) {
        if (typeof DecompressionStream !== 'function') fail('当前浏览器不支持解压 deflate；请解压 ZIP 后导入文件夹');
        let stream;
        try { stream = new DecompressionStream('deflate-raw'); }
        catch (_) { fail('当前浏览器不支持解压 deflate；请解压 ZIP 后导入文件夹'); }
        const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
        const chunks = [];
        let length = 0;
        try {
            for (;;) {
                const {value, done} = await reader.read();
                if (done) break;
                length += value.length;
                if (length > expected || length > MAX_TOTAL_BYTES) {
                    await reader.cancel();
                    fail('解压内容超过声明大小或 50 MB 限制');
                }
                chunks.push(value);
            }
        } catch (error) {
            if (error.message.startsWith('ZIP：')) throw error;
            fail('压缩数据损坏，无法解压');
        } finally {
            reader.releaseLock();
        }
        if (length !== expected) fail('解压后的文件大小不匹配');
        const result = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
        return result;
    }
    async function readZip(input, {includeComment = false} = {}) {
        const bytes = checkBytes(input);
        if (bytes.length > MAX_ARCHIVE_BYTES) fail('压缩包不能超过 100 MB');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        function requireBytes(offset, size, limit = bytes.length) {
            if (!Number.isSafeInteger(offset) || offset < 0 || size < 0 || offset + size > limit) fail('压缩包结构不完整');
        }
        function extras(offset, length) {
            const end = offset + length;
            while (offset < end) {
                requireBytes(offset, 4, end);
                const id = view.getUint16(offset, true);
                const size = view.getUint16(offset + 2, true);
                requireBytes(offset + 4, size, end);
                if (id === 1) fail('暂不支持 ZIP64');
                offset += 4 + size;
            }
        }
        function filename(offset, length) {
            try { return decoder.decode(bytes.subarray(offset, offset + length)); }
            catch (_) { fail('文件名必须使用 UTF-8 编码，请解压后导入文件夹'); }
        }
        let eocd = -1;
        for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
            if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { eocd = i; break; }
        }
        if (eocd < 0) fail('未找到有效的 ZIP 目录');
        const count = view.getUint16(eocd + 10, true);
        const centralSize = view.getUint32(eocd + 12, true);
        const centralOffset = view.getUint32(eocd + 16, true);
        if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('暂不支持 ZIP64');
        if (view.getUint16(eocd + 4, true) || view.getUint16(eocd + 6, true) || view.getUint16(eocd + 8, true) !== count) fail('不支持分卷压缩包');
        if (count > MAX_FILES * 2 + 1) fail('压缩包目录项目过多');
        requireBytes(centralOffset, centralSize, eocd);
        if (centralOffset + centralSize !== eocd) fail('ZIP 目录边界不匹配');
        const records = [];
        const names = new Set();
        let total = 0;
        let fileCount = 0;
        let cursor = centralOffset;
        for (let n = 0; n < count; n++) {
            requireBytes(cursor, 46, eocd);
            if (view.getUint32(cursor, true) !== 0x02014b50) fail('ZIP 目录条目损坏');
            const flags = view.getUint16(cursor + 8, true);
            const method = view.getUint16(cursor + 10, true);
            const crc = view.getUint32(cursor + 16, true);
            const compressedSize = view.getUint32(cursor + 20, true);
            const size = view.getUint32(cursor + 24, true);
            const nameLength = view.getUint16(cursor + 28, true);
            const extraLength = view.getUint16(cursor + 30, true);
            const commentLength = view.getUint16(cursor + 32, true);
            const localOffset = view.getUint32(cursor + 42, true);
            if (flags & 0x0041) fail('不支持加密 ZIP');
            if (flags & ~0x080e) fail('ZIP 使用了不支持的标志');
            if (method !== 0 && method !== 8) fail('仅支持 stored 或 deflate 压缩方式');
            if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) fail('暂不支持 ZIP64');
            if (view.getUint16(cursor + 34, true)) fail('不支持分卷压缩包');
            if ((view.getUint32(cursor + 38, true) >>> 16 & 0xf000) === 0xa000) fail('不支持符号链接文件');
            requireBytes(cursor + 46, nameLength + extraLength + commentLength, eocd);
            extras(cursor + 46 + nameLength, extraLength);
            const rawName = filename(cursor + 46, nameLength);
            const directory = /[\\/]$/.test(rawName);
            const path = validatePath(directory ? rawName.slice(0, -1) : rawName);
            const key = pathKey(path);
            if (names.has(key)) fail('重复文件路径：' + path);
            names.add(key);
            if (directory && size !== 0) fail('目录条目包含文件数据');
            if (!directory && ++fileCount > MAX_FILES) fail('项目最多包含 ' + MAX_FILES + ' 个文件');
            total += size;
            if (total > MAX_TOTAL_BYTES) fail('项目解压后总大小不能超过 50 MB');
            requireBytes(localOffset, 30, centralOffset);
            if (view.getUint32(localOffset, true) !== 0x04034b50) fail('文件本地头损坏');
            if (view.getUint16(localOffset + 6, true) !== flags || view.getUint16(localOffset + 8, true) !== method) fail('文件头与目录不一致');
            const localNameLength = view.getUint16(localOffset + 26, true);
            const localExtraLength = view.getUint16(localOffset + 28, true);
            const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
            requireBytes(localOffset + 30, localNameLength + localExtraLength, centralOffset);
            if (filename(localOffset + 30, localNameLength) !== rawName) fail('文件头名称与目录不一致');
            extras(localOffset + 30 + localNameLength, localExtraLength);
            requireBytes(dataOffset, compressedSize, centralOffset);
            const localCrc = view.getUint32(localOffset + 14, true);
            const localCompressed = view.getUint32(localOffset + 18, true);
            const localSize = view.getUint32(localOffset + 22, true);
            let recordEnd = dataOffset + compressedSize;
            if (flags & 8) {
                if ((localCrc !== 0 && localCrc !== crc) || (localCompressed !== 0 && localCompressed !== compressedSize) || (localSize !== 0 && localSize !== size)) fail('文件大小声明不一致');
                requireBytes(recordEnd, 12, centralOffset);
                const descriptor = view.getUint32(recordEnd, true) === 0x08074b50 ? recordEnd + 4 : recordEnd;
                requireBytes(descriptor, 12, centralOffset);
                if (view.getUint32(descriptor, true) !== crc || view.getUint32(descriptor + 4, true) !== compressedSize || view.getUint32(descriptor + 8, true) !== size) fail('文件数据描述符损坏');
                recordEnd = descriptor + 12;
            } else if (localCrc !== crc || localCompressed !== compressedSize || localSize !== size) fail('文件头大小或校验值与目录不一致');
            if (method === 0 && compressedSize !== size) fail('未压缩文件大小不匹配');
            records.push({path, directory, method, crc, size, localOffset, recordEnd, dataOffset, compressedSize});
            cursor += 46 + nameLength + extraLength + commentLength;
        }
        if (cursor !== eocd) fail('目录条目数与目录大小不匹配');
        const ranges = [...records].sort((a, b) => a.localOffset - b.localOffset);
        for (let i = 1; i < ranges.length; i++) if (ranges[i].localOffset < ranges[i - 1].recordEnd) fail('文件数据区域重叠');
        const result = [];
        for (const record of records) {
            const compressed = bytes.subarray(record.dataOffset, record.dataOffset + record.compressedSize);
            const content = record.method === 0 ? compressed.slice() : await inflate(compressed, record.size);
            if (crc32(content) !== record.crc) fail('文件校验失败：' + record.path);
            if (!record.directory) result.push({path: record.path, bytes: content});
        }
        // ZIP comments have no reliable charset flag. Decode external comments
        // permissively so metadata cannot prevent importing otherwise valid files.
        return includeComment
            ? {files: result, comment: new TextDecoder('utf-8', {ignoreBOM: true}).decode(bytes.subarray(eocd + 22))}
            : result;
    }
    root.ProjectArchive = Object.freeze({readZip, writeZip, crc32, validatePath, MAX_FILES, MAX_TOTAL_BYTES, MAX_ARCHIVE_BYTES});
})(globalThis);
