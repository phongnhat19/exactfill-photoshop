/* ============================================================================
 *  providers/http.js — shared transport for every provider.
 *
 *  Fixes three defects of the old SDKs:
 *   1. A timeout via Promise.race did NOT CANCEL the request — fetch kept
 *      hanging, and the panel could stay silent for up to 15 minutes. AbortController here.
 *   2. retryWithBackoff rejected every 4xx, so it did NOT retry 429 (rate limit),
 *      even though that is the one that needs a retry. Here 429/408/5xx are retried
 *      with respect for Retry-After, and 400/401/403/404 are not.
 *   3. Provider errors fell out as a TypeError while parsing the response. Here the
 *      text is always readable English.
 * ========================================================================== */

const httpI18n = require('../i18n.js');
const transport = require('./curl-transport.js');

/**
 * The single exit to the network.
 *
 * WHY NOT PLAIN fetch: the UXP permission `network.domains` does not bypass a
 * system firewall — the request leaves the Photoshop process, and a "Block Photoshop"
 * rule cuts it (measured: a socket from the PS process fails, while a child curl
 * gets 401/403 in the same seconds). So in 'auto' mode the first network failure
 * switches later requests to the curl transport, and 'curl'/'direct' pin the path.
 */
async function netFetch(url, init, streaming) {
    const viaCurl = () => (streaming ? transport.fetchLikeStream(url, init)
                                     : transport.fetchLike(url, init));
    // The first request of a session in 'auto' is decided by a preflight, NOT by
    // the request's own timeout: a blocked stream hangs, and with timeoutMs of 300 s
    // the user would stare at "Generating…" for five minutes before the transport
    // even tried curl.
    if (transport.getMode() === 'auto' && !transport.isRouteDecided()) {
        try { await transport.decideRoute(new URL(url).origin); } catch (e) {}
    }
    if (transport.active()) return viaCurl();
    try {
        return await fetch(url, init);
    } catch (e) {
        const aborted = e && (e.name === 'AbortError' || String(e.message).includes('abort'));
        if (aborted || transport.getMode() !== 'auto') throw e;
        transport.noteDirectFailure();
        const cap = await transport.probe();
        if (!cap.ok) {
            // no route — do not leave 'auto' in the "switched to curl" state,
            // or every later request would go to a transport that does not work
            transport.resetDirectFailure();
            console.log(`[http] curl transport unavailable: ${cap.reason}`);
            throw e;
        }
        console.log('[http] direct fetch did not get through — switching to the curl transport');
        return viaCurl();
    }
}

/** UTF-8 without TextEncoder — UXP does not have it. */
function strToBytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code < 0x80) {
            bytes.push(code);
        } else if (code < 0x800) {
            bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
        } else if (code >= 0xD800 && code <= 0xDBFF) {
            const lo = str.charCodeAt(++i);
            const cp = 0x10000 + ((code - 0xD800) << 10) + (lo - 0xDC00);
            bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
                       0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
        } else {
            bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
        }
    }
    return new Uint8Array(bytes);
}

/** Blob → base64 without FileReader (it is incomplete in UXP). */
async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return btoa(binary);
}

/**
 * multipart/form-data by hand: FormData + Blob hangs in UXP, so we assemble
 * the body as bytes ourselves. This is not a quirk of the old code; it is necessary.
 */
async function buildMultipart(fields) {
    const boundary = 'AiImageBoundary' + Date.now().toString(36) +
                     Math.floor(Math.random() * 1e6).toString(36);
    const chunks = [];
    for (const f of fields) {
        let disposition = `Content-Disposition: form-data; name="${f.name}"`;
        if (f.filename) disposition += `; filename="${f.filename}"`;
        chunks.push(strToBytes(`--${boundary}\r\n${disposition}\r\n`));
        if (f.contentType) chunks.push(strToBytes(`Content-Type: ${f.contentType}\r\n`));
        chunks.push(strToBytes('\r\n'));
        if (f.data instanceof Blob) {
            chunks.push(new Uint8Array(await f.data.arrayBuffer()));
        } else if (f.data instanceof Uint8Array) {
            chunks.push(f.data);
        } else {
            chunks.push(strToBytes(String(f.data)));
        }
        chunks.push(strToBytes('\r\n'));
    }
    chunks.push(strToBytes(`--${boundary}--\r\n`));

    let total = 0;
    for (const c of chunks) total += c.length;
    const body = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { body.set(c, off); off += c.length; }
    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

class HttpError extends Error {
    constructor(status, message, retryAfter) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

/** Statuses worth retrying. 429 is REQUIRED (that is the one that used to be skipped). */
const RETRYABLE = s => s === 429 || s === 408 || s === 409 || (s >= 500 && s < 600);

/** User cancellation — its own type, so withRetry does NOT retry it. */
class Cancelled extends Error {
    constructor() { super(httpI18n.t('provider.cancelled')); this.name = 'Cancelled'; this.cancelled = true; }
}

/**
 * Folds an external cancel signal and the internal timeout into one controller.
 * Returns { signal, done() } — done() must be called in finally, or the listener
 * on the external signal leaks between generations.
 */
function linkAbort(external, timeoutMs) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (!ctrl) return { signal: undefined, done() {}, wasCancelled: () => false };
    let cancelled = false;
    const onExternal = () => { cancelled = true; ctrl.abort(); };
    if (external) {
        if (external.aborted) onExternal();
        else external.addEventListener('abort', onExternal);
    }
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    return {
        signal: ctrl.signal,
        wasCancelled: () => cancelled,
        done() {
            clearTimeout(timer);
            if (external) { try { external.removeEventListener('abort', onExternal); } catch (e) {} }
        },
    };
}

/**
 * fetch with a real cancellation and readable errors.
 * timeoutMs is deliberately large: image generation at high can take minutes.
 * signal is the external AbortSignal of the Cancel button.
 */
async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 300000, signal } = {}) {
    const link = linkAbort(signal, timeoutMs);
    try {
        let res;
        try {
            res = await netFetch(url, { method, headers, body, signal: link.signal, timeoutMs }, false);
        } catch (e) {
            if (e && (e.name === 'AbortError' || String(e.message).includes('abort'))) {
                if (link.wasCancelled()) throw new Cancelled();
                throw new HttpError(0, httpI18n.t('provider.timeout', {
                    seconds: Math.round(timeoutMs / 1000),
                }));
            }
            throw new HttpError(0, httpI18n.t('provider.noConnection', {
                host: new URL(url).host, error: e.message,
            }));
        }

        const text = await res.text();
        if (!res.ok) throw errorFromBody(res, text);

        try {
            return JSON.parse(text);
        } catch (e) {
            throw new HttpError(res.status, httpI18n.t('provider.invalidJson'));
        }
    } finally {
        link.done();
    }
}

function errorFromBody(res, text) {
    let msg = `HTTP ${res.status}`;
    let code = null;
    try {
        const j = JSON.parse(text);
        msg = j?.error?.message || j?.error?.status || j?.message || msg;
        // The error code itself, not only the text: status 404 covers both
        // "no such model" and "no such endpoint", and telling them apart from
        // an English sentence is fragile. Providers react to the code.
        code = j?.error?.code || j?.error?.type || null;
    } catch (e) {
        if (text) msg += `: ${text.slice(0, 300)}`;
    }
    const ra = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
    const err = new HttpError(res.status, msg, parseRetryAfter(ra));
    err.code = code;
    return err;
}

/** Retry-After may be seconds or an HTTP date; both forms are standard. */
function parseRetryAfter(value, now = Date.now()) {
    if (value === null || value === undefined || value === '') return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds);
    const at = Date.parse(String(value));
    return Number.isFinite(at) ? Math.max(0, (at - now) / 1000) : null;
}

/**
 * SSE request for providers that can return intermediate frames.
 *
 * HONESTLY ABOUT THE LIMIT: whether fetch in UXP supports streaming READS of
 * the body (`res.body.getReader`) is undocumented, and it cannot be checked
 * from ExtendScript (there is no fetch there). So we probe the capability at
 * runtime: if a reader exists, we read event by event; if not, we read the
 * whole text and emit the same events in one batch. The preview is then not
 * intermediate, but generation does not break. Which path ran is visible in the console.
 *
 * @param {(ev:object)=>void} onEvent — called for every parsed SSE event
 * @returns {Promise<object|null>} the last event (…completed), if there was one
 */
async function requestStream(url, { method = 'POST', headers = {}, body, timeoutMs = 300000, signal } = {}, onEvent) {
    const link = linkAbort(signal, timeoutMs);
    try {
        let res;
        try {
            res = await netFetch(url, { method, headers, body, signal: link.signal, timeoutMs }, true);
        } catch (e) {
            if (e && (e.name === 'AbortError' || String(e.message).includes('abort'))) {
                if (link.wasCancelled()) throw new Cancelled();
                throw new HttpError(0, httpI18n.t('provider.streamTimeout', {
                    seconds: Math.round(timeoutMs / 1000),
                }));
            }
            throw new HttpError(0, httpI18n.t('provider.noConnection', {
                host: new URL(url).host, error: e.message,
            }));
        }
        if (!res.ok) throw errorFromBody(res, await res.text());

        let last = null;
        const feed = chunk => { for (const ev of parseSse(chunk)) { last = ev; if (onEvent) onEvent(ev); } };

        const canStream = res.body && typeof res.body.getReader === 'function';
        if (canStream) {
            const reader = res.body.getReader();
            let buf = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                // SSE allows both LF and CRLF. Normalize immediately, otherwise
                // `\r\n\r\n` is not found as `\n\n`, frames pile up until the
                // request ends, and they stop being a live preview.
                buf += bytesToStr(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                // an event ends with a blank line; keep the tail in the buffer
                const cut = buf.lastIndexOf('\n\n');
                if (cut >= 0) { feed(buf.slice(0, cut + 2)); buf = buf.slice(cut + 2); }
            }
            if (buf.trim()) feed(buf);
        } else {
            console.log('[http] streaming read unavailable — parsing SSE as one batch');
            feed(await res.text());
        }
        return last;
    } finally {
        link.done();
    }
}

/** UTF-8 from bytes without TextDecoder (UXP may not have it either). */
function bytesToStr(bytes) {
    if (!bytes) return '';
    if (typeof bytes === 'string') return bytes;
    let s = '';
    const CHUNK = 8192;
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i += CHUNK) {
        s += String.fromCharCode.apply(null, arr.subarray(i, Math.min(i + CHUNK, arr.length)));
    }
    // base64 in SSE is ASCII, so UTF-8 decoding is not needed here
    return s;
}

/** Parses an SSE block into an array of objects from `data:` lines. */
function parseSse(chunk) {
    const out = [];
    const normalized = String(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (const block of normalized.split(/\n\n/)) {
        const dataLines = [];
        for (const line of block.split(/\n/)) {
            if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        const payload = dataLines.join('');
        if (payload === '[DONE]') continue;
        try { out.push(JSON.parse(payload)); } catch (e) { /* incomplete frame — skip */ }
    }
    return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A retry wait that the Cancel button interrupts immediately. */
function sleepWithSignal(ms, signal) {
    if (!signal) return sleep(ms);
    if (signal.aborted) return Promise.reject(new Cancelled());
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            try { signal.removeEventListener('abort', onAbort); } catch (e) {}
            reject(new Cancelled());
        };
        const timer = setTimeout(() => {
            try { signal.removeEventListener('abort', onAbort); } catch (e) {}
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort);
    });
}

/** Retry only what is worth retrying, respecting Retry-After. */
async function withRetry(fn, { tries = 4, baseDelay = 1200, signal } = {}) {
    let last;
    for (let attempt = 0; attempt < tries; attempt++) {
        try {
            return await fn();
        } catch (e) {
            last = e;
            // User cancellation is not a network error and must NOT be retried:
            // otherwise the Cancel button would only stretch the wait fourfold.
            if (e && e.cancelled) throw e;
            const status = e && e.status;
            if (!RETRYABLE(status) || attempt === tries - 1) throw e;
            const wait = (Number.isFinite(e.retryAfter) ? e.retryAfter * 1000 : baseDelay * Math.pow(2, attempt))
                       + Math.floor(Math.random() * 300);
            console.log(`[http] ${status} — retry ${attempt + 1}/${tries - 1} in ${wait} ms`);
            await sleepWithSignal(wait, signal);
        }
    }
    throw last;
}

module.exports = {
    strToBytes, blobToBase64, buildMultipart,
    request, requestStream, withRetry, HttpError, Cancelled, RETRYABLE, sleep,
    sleepWithSignal, parseRetryAfter, parseSse,
    transport,
};
