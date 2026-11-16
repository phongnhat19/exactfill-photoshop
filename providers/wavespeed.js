/* ============================================================================
 *  providers/wavespeed.js — WaveSpeedAI edit models.
 *
 *  Direct fetch only. The shared http.js transport may fall over to system
 *  curl, and that path writes the Authorization header into a file. A paid
 *  edit must not take that route.
 *
 *  Order is fixed: validate, upload the captured image, upload references,
 *  submit once, poll. A submit is never repeated. An unclear failure can
 *  still have created a billed task.
 * ========================================================================== */

const wsI18n = require('../i18n.js');
const { isJpeg, readJpegSize, readPngSize } = require('../png.js');

const ORIGIN = 'https://api.wavespeed.ai';
const API = `${ORIGIN}/api/v3/`;
const UPLOAD_URL = `${API}media/upload/binary`;
const REQUEST_TIMEOUT_MS = 60_000;
const DEADLINE_MS = 10 * 60 * 1000;
const POLL_GAP_MS = 2000;
const MAX_BACKOFF_MS = 30_000;
/* The product bound is 100MB per request. The upload guide also mentions a
   larger single-file ceiling; this client stays at the tighter bound. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const Q = ['low', 'medium', 'high', 'auto'];
const BANANA_WIDE = ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1'];
const BANANA_PRO = ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const SEEDREAM_ASPECTS = ['1:1', '1:2', '2:1', '1:3', '3:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '9:21', '21:9'];

const FAIL_STATUS = new Set(['failed', 'cancelled', 'timeout', 'deleted']);

const ratioCaps = (aspects, imageSizes, extra) => ({
    arbitrary: false,
    aspects,
    imageSizes,
    resolutions: imageSizes.map(s => s.toLowerCase()),
    qualities: Q,
    geometry: 'ratio',
    transparent: false,
    stream: false,
    mask: false,
    ignorePixels: false,
    references: true,
    ...extra,
});

const MODELS = [
    {
        id: 'google/nano-banana-2/edit',
        label: 'Nano Banana 2 Edit',
        caps: ratioCaps(BANANA_WIDE, ['1K', '2K', '4K'], { maxImages: 14 }),
    },
    {
        id: 'google/nano-banana-pro/edit',
        label: 'Nano Banana Pro Edit',
        caps: ratioCaps(BANANA_PRO, ['1K', '2K', '4K'], { maxImages: 14 }),
    },
    {
        id: 'bytedance/seedream-v5.5/edit',
        label: 'Seedream 5.5 Edit',
        caps: ratioCaps(SEEDREAM_ASPECTS, ['1K', '2K'], { maxImages: 10, transparent: true, background: true }),
    },
    {
        id: 'wavespeed-ai/qwen-image-2.0/edit',
        label: 'Qwen Image 2.0 Edit',
        caps: {
            arbitrary: true,
            step: 16,
            maxEdge: 3072,
            minPx: 384 * 384,
            maxPx: 3072 * 3072,
            maxRatio: 3072 / 384,
            qualities: Q,
            geometry: 'size',
            maxImages: 3,
            maxPrompt: 800,
            inputMinEdge: 384,
            inputMaxEdge: 3072,
            outputMinEdge: 256,
            outputMaxEdge: 4096,
            transparent: false,
            stream: false,
            mask: false,
            ignorePixels: false,
            references: true,
        },
    },
];

function capsFor(modelId) {
    const found = MODELS.find(m => m.id === modelId);
    return found ? found.caps : null;
}

async function models() {
    return MODELS.map(m => ({ id: m.id, label: m.label, caps: m.caps }));
}

function findModel(modelId) {
    return MODELS.find(m => m.id === modelId) || null;
}

/** Trimmed key, or a reason it must not be stored or sent. */
function inspectKey(value) {
    const key = String(value == null ? '' : value).trim();
    if (!key) return { ok: false, reason: 'empty' };
    if (/[\u0000-\u001F\u007F]/.test(key)) return { ok: false, reason: 'control' };
    return { ok: true, key };
}

function redact(text, apiKey) {
    let out = String(text == null ? '' : text);
    if (apiKey) out = out.split(apiKey).join('[redacted]');
    out = out.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
    out = out.replace(/https?:\/\/\S+/gi, '[url]');
    return out.slice(0, 240);
}

function fail(key, vars) {
    const err = new Error(wsI18n.t(key, vars));
    return err;
}

function cancelled() {
    const err = new Error(wsI18n.t('provider.cancelled'));
    err.cancelled = true;
    return err;
}

function ambiguous(key, vars) {
    const err = fail(key, vars);
    err.ambiguous = true;
    return err;
}

function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
            reject(cancelled());
            return;
        }
        const timer = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            reject(cancelled());
        };
        if (signal) signal.addEventListener('abort', onAbort);
    });
}

function pngSignature(bytes) {
    return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 &&
        bytes[2] === 0x4E && bytes[3] === 0x47 && bytes[4] === 0x0D &&
        bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A;
}

function decodeBase64(value) {
    const clean = String(value).replace(/\s+/g, '');
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function imageKind(bytes) {
    if (pngSignature(bytes)) return 'png';
    if (isJpeg(bytes)) return 'jpeg';
    return '';
}

async function blobBytes(blob) {
    return new Uint8Array(await blob.arrayBuffer());
}

async function inputSize(blob) {
    const bytes = await blobBytes(blob);
    if (pngSignature(bytes)) {
        try { return readPngSize(bytes); } catch (e) { return null; }
    }
    if (isJpeg(bytes)) {
        try { return readJpegSize(bytes); } catch (e) { return null; }
    }
    return null;
}

function contentTypeOf(blob, bytes) {
    const declared = String(blob.type || '').toLowerCase();
    if (declared === 'image/png' || declared === 'image/jpeg') return declared;
    const kind = imageKind(bytes);
    if (kind === 'jpeg') return 'image/jpeg';
    return 'image/png';
}

function genericFilename(contentType) {
    return contentType === 'image/jpeg' ? 'image.jpg' : 'image.png';
}

/**
 * Fields the selected model documents. Ratio models get aspect_ratio and
 * resolution. Qwen gets width*height only.
 */
function buildSubmitBody({ model, prompt, images, plan, background }) {
    const caps = model.caps;
    const body = {
        prompt,
        images,
        output_format: 'png',
        enable_base64_output: true,
        enable_sync_mode: false,
    };
    if (caps.geometry === 'size') {
        const raw = plan && plan.size ? String(plan.size) : '';
        const match = raw.match(/^(\d+)[x*](\d+)$/i);
        if (!match) throw fail('provider.wsGeometry');
        const width = Number(match[1]);
        const height = Number(match[2]);
        const lo = caps.outputMinEdge;
        const hi = caps.outputMaxEdge;
        if (width < lo || height < lo || width > hi || height > hi) {
            throw fail('provider.wsGeometry');
        }
        body.size = `${width}*${height}`;
        return body;
    }
    const aspect = plan && plan.aspectRatio;
    const resolution = plan && plan.imageSize ? String(plan.imageSize).toLowerCase() : '';
    if (!aspect || !caps.aspects.includes(aspect)) throw fail('provider.wsGeometry');
    if (!resolution || !caps.resolutions.includes(resolution)) throw fail('provider.wsGeometry');
    body.aspect_ratio = aspect;
    body.resolution = resolution;
    if (caps.background && background === 'transparent') body.background = 'transparent';
    else if (background === 'transparent') throw fail('provider.wsBackground');
    return body;
}

function assertInputs({ apiKey, model, prompt, imageBlob, references, ignorePixels, plan, background }) {
    const key = inspectKey(apiKey);
    if (!key.ok) throw fail('provider.wsBadKey');
    const text = String(prompt || '').trim();
    if (!text) throw fail('provider.emptyPrompt');
    const found = findModel(model);
    if (!found) throw fail('provider.wsUnknownModel');
    if (ignorePixels) throw fail('provider.wsIgnore');
    if (!imageBlob) throw fail('provider.wsNoImage');
    const refs = Array.isArray(references) ? references : [];
    const count = 1 + refs.length;
    if (count > found.caps.maxImages) {
        throw fail('provider.wsTooMany', { max: found.caps.maxImages });
    }
    if (found.caps.maxPrompt && text.length > found.caps.maxPrompt) {
        throw fail('provider.wsPromptLong', { max: found.caps.maxPrompt });
    }
    if (background === 'transparent' && !found.caps.background) throw fail('provider.wsBackground');
    buildSubmitBody({ model: found, prompt: text, images: ['pending'], plan, background });
    const files = [imageBlob, ...refs];
    for (const file of files) {
        if (file && file.size > MAX_UPLOAD_BYTES) throw fail('provider.wsFileBig', { mb: 100 });
    }
    return { key: key.key, prompt: text, model: found, plan, background, files };
}

async function assertDimensions(model, files) {
    if (!model.caps.inputMinEdge) return;
    const min = model.caps.inputMinEdge;
    const max = model.caps.inputMaxEdge;
    for (const file of files) {
        const size = await inputSize(file);
        if (!size) throw fail('provider.wsDimUnknown');
        if (size.w < min || size.h < min || size.w > max || size.h > max) {
            throw fail('provider.wsDim', { width: size.w, height: size.h, min, max });
        }
    }
}

function sameOrigin(url) {
    return String(url).startsWith(`${ORIGIN}/`);
}

async function callFetch(fetchImpl, url, init, { signal, apiKey, now, started }) {
    const remaining = DEADLINE_MS - (now() - started);
    if (remaining <= 0) throw fail('provider.wsDeadline', { minutes: 10 });
    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remaining);
    if (!sameOrigin(url)) throw fail('provider.wsOrigin');
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer = null;
    let userAbort = false;
    let rejectAbort;
    const interrupted = new Promise((resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => {
        userAbort = true;
        if (ctrl) ctrl.abort();
        rejectAbort(cancelled());
    };
    if (signal) {
        if (signal.aborted) throw cancelled();
        signal.addEventListener('abort', onAbort);
    }
    timer = setTimeout(() => {
        if (ctrl) ctrl.abort();
        const err = new Error('abort');
        err.name = 'AbortError';
        rejectAbort(err);
    }, timeoutMs);
    try {
        return await Promise.race([interrupted, (async () => {
            const res = await fetchImpl(url, { ...init, redirect: 'error', signal: ctrl ? ctrl.signal : signal });
            const body = await res.text();
            return { ok: res.ok, status: res.status, headers: res.headers, text: async () => body };
        })()]);
    } catch (e) {
        if (userAbort || (signal && signal.aborted)) throw cancelled();
        const aborted = e && (e.name === 'AbortError' || String(e.message).includes('abort'));
        if (aborted) {
            const err = new Error(wsI18n.t('provider.timeout', { seconds: Math.round(timeoutMs / 1000) }));
            err.timeout = true;
            return Promise.reject(err);
        }
        const err = new Error(wsI18n.t('provider.noConnection', {
            host: ORIGIN.replace('https://', ''),
            error: redact(e && e.message, apiKey),
        }));
        err.transport = true;
        return Promise.reject(err);
    } finally {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

async function readJson(res, apiKey) {
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch (e) {
        const err = fail('provider.invalidJson');
        err.httpStatus = res.status;
        throw err;
    }
}

function unwrap(json) {
    if (json && json.data && typeof json.data === 'object') return json.data;
    return json || {};
}

async function uploadOne(file, ctx) {
    const bytes = await blobBytes(file);
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw fail('provider.wsFileBig', { mb: 100 });
    const contentType = contentTypeOf(file, bytes);
    let res;
    try {
        res = await callFetch(ctx.fetchImpl, UPLOAD_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${ctx.apiKey}`,
                'Content-Type': contentType,
                file: genericFilename(contentType),
            },
            body: bytes,
        }, ctx);
    } catch (e) {
        if (e && e.cancelled) throw e;
        throw fail('provider.wsUpload');
    }
    const json = await readJson(res, ctx.apiKey).catch(err => {
        throw fail('provider.wsUpload');
    });
    if (!res.ok) throw fail('provider.wsUpload');
    const url = unwrap(json).download_url;
    if (!url || typeof url !== 'string') throw fail('provider.wsUpload');
    return url;
}

function retryAfterMs(res, fallback, now) {
    const raw = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
    if (raw == null || raw === '') return fallback;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(POLL_GAP_MS, seconds * 1000);
    const at = Date.parse(String(raw));
    if (Number.isFinite(at)) return Math.max(POLL_GAP_MS, at - now());
    return fallback;
}

async function submitOnce(body, ctx) {
    const url = `${API}${ctx.model.id}`;
    let res;
    try {
        res = await callFetch(ctx.fetchImpl, url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${ctx.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        }, ctx);
    } catch (e) {
        if (e && e.cancelled) throw e;
        throw ambiguous('provider.wsSubmitAmbiguous');
    }
    let json;
    try {
        json = await readJson(res, ctx.apiKey);
    } catch (e) {
        throw ambiguous('provider.wsNoId');
    }
    const data = unwrap(json);
    if (!res.ok || !data.id) {
        if (!res.ok && res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
            throw fail('provider.wsHttp', { detail: String(res.status) });
        }
        throw ambiguous('provider.wsSubmitAmbiguous');
    }
    return String(data.id);
}

async function poll(id, ctx) {
    const url = `${API}predictions/${encodeURIComponent(id)}/result`;
    let backoff = POLL_GAP_MS;
    while (true) {
        if (ctx.now() - ctx.started >= DEADLINE_MS) throw fail('provider.wsDeadline', { minutes: 10 });
        let res;
        try {
            res = await callFetch(ctx.fetchImpl, url, {
                method: 'GET',
                headers: { Authorization: `Bearer ${ctx.apiKey}` },
            }, ctx);
        } catch (e) {
            if (e && e.cancelled) throw e;
            await ctx.sleep(backoff, ctx.signal);
            backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
            continue;
        }
        if (res.status === 429 || res.status === 408 || res.status >= 500) {
            const pause = Math.min(MAX_BACKOFF_MS, retryAfterMs(res, backoff, ctx.now));
            await ctx.sleep(pause, ctx.signal);
            backoff = Math.min(MAX_BACKOFF_MS, Math.max(backoff * 2, pause));
            continue;
        }
        const json = await readJson(res, ctx.apiKey);
        if (!res.ok) throw fail('provider.wsHttp', { detail: redact(res.status, ctx.apiKey) });
        const data = unwrap(json);
        const status = String(data.status || '');
        if (status === 'completed') return data.outputs;
        if (FAIL_STATUS.has(status)) {
            throw fail('provider.wsStatus', {
                status,
                detail: '',
            });
        }
        await ctx.sleep(POLL_GAP_MS, ctx.signal);
        backoff = POLL_GAP_MS;
    }
}

function acceptOutput(item) {
    if (typeof item !== 'string' || !item.trim()) throw fail('provider.wsEmpty');
    const trimmed = item.trim();
    if (/^https?:\/\//i.test(trimmed)) throw fail('provider.wsUrl');
    const naked = trimmed.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
    let bytes;
    try { bytes = decodeBase64(naked); }
    catch (e) { throw fail('provider.wsBadImage'); }
    if (!imageKind(bytes)) throw fail('provider.wsBadImage');
    return naked;
}

async function generate({ apiKey, model, prompt, imageBlob, references, plan, background,
                          ignorePixels, signal, onProgress, fetchImpl, sleep, now }) {
    const checked = assertInputs({
        apiKey, model, prompt, imageBlob, references, ignorePixels, plan, background,
    });
    await assertDimensions(checked.model, checked.files);
    const started = (now || Date.now)();
    const clock = now || Date.now;
    const pause = sleep || wait;
    const ctx = {
        apiKey: checked.key,
        model: checked.model,
        signal,
        fetchImpl: fetchImpl || fetch,
        sleep: async (ms, signal) => {
            const remaining = DEADLINE_MS - (clock() - started);
            if (remaining <= 0) throw fail('provider.wsDeadline', { minutes: 10 });
            await pause(Math.min(ms, remaining), signal);
        },
        now: clock,
        started,
    };
    if (onProgress) onProgress(wsI18n.t('provider.generating'));
    const images = [];
    for (const file of checked.files) images.push(await uploadOne(file, ctx));
    const body = buildSubmitBody({
        model: checked.model,
        prompt: checked.prompt,
        images,
        plan: checked.plan,
        background: checked.background,
    });
    const id = await submitOnce(body, ctx);
    const outputs = await poll(id, ctx);
    if (!Array.isArray(outputs) || !outputs.length) throw fail('provider.wsEmpty');
    const accepted = outputs.map(acceptOutput);
    if (onProgress) onProgress(wsI18n.t('provider.done'));
    return { images: accepted, usage: null };
}

module.exports = {
    id: 'wavespeed',
    label: 'WaveSpeedAI',
    keyName: 'wavespeedApiKey',
    keyPage: 'https://wavespeed.ai/accesskey',
    supportsMask: false,
    supportsReferences: true,
    supportsTransparent: false,
    supportsStream: false,
    supportsRefine: false,
    supportsIgnorePixels: false,
    models,
    capsFor,
    generate,
    inspectKey,
    buildSubmitBody,
    redact,
    ORIGIN,
    MAX_UPLOAD_BYTES,
    _wait: wait,
};
