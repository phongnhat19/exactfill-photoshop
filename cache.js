/* ============================================================================
 *  cache.js — cache of generated images for reinsertion WITHOUT a new request.
 *
 *  WHY THIS IS STRICTLY BOUNDED. The old plugin had saveDebugBlob, which wrote
 *  two files per generation and deleted nothing: it accumulated 2.97 GB across
 *  484 files, and Photoshop scanned that folder on every start. Here the
 *  opposite holds:
 *    • MAX entries, rotating the oldest on every save();
 *    • the index is in localStorage, the bytes themselves are in the plugin data folder;
 *    • bytes() returns the real size so it can be SHOWN in the panel;
 *    • clear() exists in the UI, not only in code.
 *
 *  The point is money, not debugging: reinserting the same result is zero
 *  requests to the provider.
 * ========================================================================== */

const uxpStorage = require('uxp').storage;

const MAX_ENTRIES = 8;
const INDEX_KEY = require('./storage-keys.js').LS.cache;
const SUBFOLDER = 'results';

/** base64 from bytes without FileReader — it is incomplete in UXP. */
function bytesToB64(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < arr.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, arr.subarray(i, Math.min(i + CHUNK, arr.length)));
    }
    return btoa(binary);
}
function b64ToBytes(b64) {
    const bin = atob(String(b64).replace(/^data:[^,]+,/, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function readIndex() {
    try {
        const raw = localStorage.getItem(INDEX_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.filter(e => e && typeof e.id === 'string' &&
            typeof e.name === 'string' && /^[A-Za-z0-9._-]+$/.test(e.name)) : [];
    } catch (e) {
        console.warn('[cache] index is corrupt, starting clean:', e.message);
        return [];
    }
}
function writeIndex(arr) {
    try { localStorage.setItem(INDEX_KEY, JSON.stringify(arr)); }
    catch (e) { console.error('[cache] index was not saved:', e.message); }
}

/** Plugin data folder. Not temp: the system cleans temp, and the cache would vanish at random. */
async function folder() {
    const data = await uxpStorage.localFileSystem.getDataFolder();
    try {
        return await data.getEntry(SUBFOLDER);
    } catch (e) {
        return await data.createFolder(SUBFOLDER);
    }
}

async function removeFile(name) {
    try {
        const f = await folder();
        const entry = await f.getEntry(name);
        await entry.delete();
        return true;
    } catch (e) { return false; }
}

/**
 * Puts a PNG in the cache and returns the id. Rotation happens here, in step
 * with the write — not in a separate "cleaner" that is easy to forget to call.
 * @param {string} b64
 * @param {object} meta — prompt, provider, model, ctx, target, quality, and so on
 */
async function save(b64, meta = {}) {
    const bytes = b64ToBytes(b64);
    const id = 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    const name = `${id}.png`;
    try {
        const f = await folder();
        const file = await f.createFile(name, { overwrite: true });
        await file.write(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
                         { format: uxpStorage.formats.binary });
    } catch (e) {
        console.error('[cache] write failed:', e.message);
        return null;
    }

    const index = readIndex();
    index.push({ id, name, size: bytes.length, at: Date.now(), meta });
    // rotation: keep the MAX_ENTRIES newest, delete the rest from disk
    while (index.length > MAX_ENTRIES) {
        const old = index.shift();
        await removeFile(old.name);
    }
    writeIndex(index);
    return id;
}

/** Newest first — the same order as history. */
function list() {
    return readIndex().slice().reverse();
}

function bytes() {
    return readIndex().reduce((s, e) => s + (e.size || 0), 0);
}

function human() {
    const b = bytes();
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
    return `${(b / 1048576).toFixed(1)} MB`;
}

async function get(id) {
    const entry = readIndex().find(e => e.id === id);
    if (!entry) return null;
    try {
        const f = await folder();
        const file = await f.getEntry(entry.name);
        const buf = await file.read({ format: uxpStorage.formats.binary });
        return bytesToB64(buf);
    } catch (e) {
        console.warn('[cache] file is gone, dropping the entry:', e.message);
        writeIndex(readIndex().filter(e2 => e2.id !== id));
        return null;
    }
}

async function remove(id) {
    const entry = readIndex().find(e => e.id === id);
    if (entry) await removeFile(entry.name);
    writeIndex(readIndex().filter(e => e.id !== id));
}

async function clear() {
    for (const e of readIndex()) await removeFile(e.name);
    writeIndex([]);
}

module.exports = { save, get, list, remove, clear, bytes, human, MAX_ENTRIES };
