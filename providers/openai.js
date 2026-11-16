/* ============================================================================
 *  providers/openai.js — the OpenAI provider (gpt-image-*).
 *
 *  Removed relative to the old openAiSdk.js:
 *    • generateImageWithContext + the whole /v1/responses path — it was imported
 *      but called NOWHERE (rg found one hit: the import itself). It came back
 *      on 2026-09-09 as `refine` — now with a call, and with the only reason to
 *      exist: memory of the previous frame, which images/edits fundamentally lacks.
 *    • refinePrompt, generateChat — dead features the user does not use
 *    • OPENAI_IMAGE2_SIZES / OPENAI_IMAGE1_SIZES — declarations that validated
 *      nothing; limits now live in caps and are consumed by geometry.js
 *
 *  The key point: gpt-image-2 accepts an ARBITRARY size (multiple of 16, edge ≤3840,
 *  ratio ≤3:1, pixel count 655,360…8,294,400). So we ask for exactly the selection
 *  size — and the resample on insert becomes cosmetic instead of scaling the whole
 *  frame. The old code refused to do this: the "≥1 MP" threshold was wrong, and
 *  at quality=high preferLarge deliberately took the largest candidate.
 * ========================================================================== */

const { buildMultipart, request, requestStream, withRetry, HttpError } = require('./http.js');
const openAiI18n = require('../i18n.js');
const { mimeOfB64 } = require('../png.js');

const BASE = 'https://api.openai.com/v1/';
const PARTIAL_IMAGES = 3;

/**
 * Response format. NOT a setting — a load-bearing structure.
 *
 * Exact placement depends on place.js writing a pHYs chunk into the received
 * file (png.setPngResolution) with the document resolution: without it placeEvent
 * treats the raster as 72 ppi and the Smart Object arrives at a different size.
 *   • WebP has NO resolution field AT ALL — that support does not exist there;
 *   • JPEG has JFIF density, but that is a separate writer plus an SOF parser
 *     instead of readPngSize, a second format all the way through: place.js, cache, preview.
 * So webp/jpeg here is not "one more value in a list", it is separate work. Until
 * that exists there is one format, and the gate in test/platform.test.js guards the link.
 */
const OUTPUT_FORMAT = 'png';

/* ── Model capabilities ────────────────────────────────────────────────────── *
 * caps is the ONLY declaration of what a model can do. geometry.js reads it
 * (request size), main.js (which quality buttons to draw), and editImage below
 * (which fields to put in the multipart). Part of this knowledge used to live
 * as string exceptions like `if (model !== 'gpt-image-2')`, and every new model
 * needed edits in four files. A new model is now one MODELS row.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Geometric capabilities — geometry.js reads them; it does not hardcode them.
 *
 * `stablePx` is the limit above which OpenAI's docs call the result experimental
 * (beyond 2560×1440). The request still goes through, but that is where it is
 * both most expensive and least predictable, so the plan card warns about it.
 */
const ARBITRARY = {
    arbitrary: true, step: 16, maxEdge: 3840,
    minPx: 655360, maxPx: 8294400, maxRatio: 3,
    stablePx: 2560 * 1440,
};
const FIXED = {
    arbitrary: false,
    sizes: ['1024x1024', '1536x1024', '1024x1536'],
};

/**
 * Quality levels. Order = increasing cost; the UI draws them in that order.
 * Only gpt-image-2.5 accepts xhigh and max. Sending them to an older model is
 * HTTP 400, so the list must travel with the model, not globally.
 */
const Q_CLASSIC  = ['low', 'medium', 'high', 'auto'];
const Q_EXTENDED = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

const caps = (geometry, extra) => ({ ...geometry, ...extra });

/**
 * `inputFidelity` — whether to put `input_fidelity: high` in the request.
 * gpt-image-2 and 2.5 process input at high fidelity themselves, and the
 * parameter is unknown to them and fails the request. Older models hold the
 * input pixels worse without it, so they need it.
 */
/*
 * `hintKey` — the i18n key main.js puts in the picker title. The names
 * "Sunburst" and "Flare" say nothing about the difference, and they must not
 * be translated: they are official identifiers the user sees in the OpenAI dashboard.
 */
const MODELS = [
    { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst', hintKey: 'model.sunburst',
      caps: caps(ARBITRARY, { qualities: Q_EXTENDED, inputFidelity: false }) },
    { id: 'gpt-image-2.5-flare',    label: 'GPT Image 2.5 Flare',    hintKey: 'model.flare',
      caps: caps(ARBITRARY, { qualities: Q_EXTENDED, inputFidelity: false }) },
    { id: 'gpt-image-2',            label: 'GPT Image 2',
      caps: caps(ARBITRARY, { qualities: Q_CLASSIC,  inputFidelity: false }) },
    { id: 'gpt-image-1.5',          label: 'GPT Image 1.5',
      caps: caps(FIXED,     { qualities: Q_CLASSIC,  inputFidelity: true }) },
    { id: 'gpt-image-1',            label: 'GPT Image 1',
      caps: caps(FIXED,     { qualities: Q_CLASSIC,  inputFidelity: true }) },
    { id: 'gpt-image-1-mini',       label: 'GPT Image 1 mini',
      caps: caps(FIXED,     { qualities: Q_CLASSIC,  inputFidelity: true }) },
];

/** An unknown model: the most cautious assumptions, not the most convenient. */
const UNKNOWN_CAPS = caps(FIXED, { qualities: Q_CLASSIC, inputFidelity: false });

/**
 * Models OpenAI is shutting down. Checked 2026-10-12 against
 * developers.openai.com/api/docs/deprecations (the replacement there is "sunburst or flare").
 *
 * The filter is BY DATE, not a simple strike from MODELS, and that is on purpose.
 * A release stays on users' machines for months: striking 1-mini now would hide it
 * seven weeks before it stops working, and leaving 1.5 in after 1 December would
 * error until the next release. The date hides the model exactly when OpenAI
 * shuts it down — without a new release.
 *
 * `replacement` is where the saved choice moves. Not list[0]: mini is the cheapest
 * line, and its user should land on the small Flare, not the base model.
 * chatgpt-image-latest is deliberately absent from MODELS (fixed sizes only, a moving
 * target); it is here so it is not added back before shutdown.
 */
const RETIRED = new Map([
    ['gpt-image-1',          { shutdown: '2026-10-23', replacement: 'gpt-image-2.5-sunburst' }],
    ['gpt-image-1.5',        { shutdown: '2026-12-01', replacement: 'gpt-image-2.5-sunburst' }],
    ['gpt-image-1-mini',     { shutdown: '2026-12-01', replacement: 'gpt-image-2.5-flare' }],
    ['chatgpt-image-latest', { shutdown: '2026-12-01', replacement: 'gpt-image-2.5-sunburst' }],
]);

/** Shutdown date and replacement, or null for a model with no announced shutdown. */
function retirement(modelId) {
    return RETIRED.get(modelId) || null;
}

/**
 * Is the model already shut down? The boundary is the start of the shutdown day
 * in UTC: the hour is not announced, and it is better to hide the model a few
 * hours early than to return an error instead of an image.
 */
function isRetired(modelId, now = Date.now()) {
    const r = RETIRED.get(modelId);
    return Boolean(r) && now >= Date.parse(`${r.shutdown}T00:00:00Z`);
}

function authHeader(apiKey) {
    // the key is never logged — not even in part
    return { Authorization: `Bearer ${apiKey}` };
}

/**
 * Model list.
 *
 * CAPS ARE STATIC AND STAY THAT WAY: /v1/models returns hundreds of records with
 * neither sizes nor quality levels, and guessing them from the name is guesswork.
 * A new model still has to be written into MODELS together with its caps.
 *
 * AND WE DO NOT ASK THE /v1/models CATALOG HERE — THAT IS A CONCLUSION FROM
 * MEASUREMENT (2026-09-09). That day two versions of an availability check lived
 * here: first a filter (if it is not in the catalog, remove it from the picker),
 * then a softened `listed` mark. Both were removed, because probing the generation
 * endpoint itself showed that gpt-image-2.5-sunburst and -flare WORK on a key that
 * is not in the catalog. The filter would have hidden two working models; the mark
 * would have warned about an invented problem. /v1/models answers "what OpenAI
 * lists", not "what this key is allowed" — those are different questions, and the
 * second has exactly one authoritative address: the endpoint you actually use.
 *
 * What remains instead of a check: explainModelError() below makes a real
 * refusal understandable. Access diagnostics are verify/check-models.sh, step 2
 * (a free probe with controls).
 *
 * @param {string|null} _apiKey — unused; the parameter exists for a shared
 *        interface with google.js, where ListModels really does depend on the
 *        key and is the source of truth there.
 */
async function models(_apiKey) {
    return availableModels(Date.now());
}

/**
 * The list at `now`: retired models are dropped, and those that still work but
 * have a shutdown date get a hint in the picker — otherwise the user would learn
 * about the shutdown only from the model changing by itself.
 */
function availableModels(now) {
    return MODELS.filter(m => !isRetired(m.id, now)).map(m => {
        const r = retirement(m.id);
        if (!r) return { ...m };
        const next = MODELS.find(x => x.id === r.replacement);
        return {
            ...m,
            hintKey: 'model.retiring',
            hintParams: { date: r.shutdown, replacement: next ? next.label : r.replacement },
        };
    });
}

/**
 * Turns "404 model_not_found" into an English explanation.
 *
 * The second half of the decision "do not hide, explain" (2026-09-09). Removing
 * a model from the picker is easy — but then the reason disappears with the item,
 * and the user has NO way to learn what happened. So the item stays, and we are
 * obliged to make the refusal understandable: the ID is correct, the model exists,
 * this key simply lacks access.
 *
 * Unrelated errors are returned as the same object — a test checks that: a wrapper
 * that rewrites everything "just in case" hides the real cause as reliably as a
 * removed picker item.
 */
function explainModelError(e, model, now = Date.now()) {
    if (!e || e.status !== 404) return e;
    const looksLikeModel = e.code === 'model_not_found'
        || /does not exist or you do not have access/i.test(e.message || '');
    if (!looksLikeModel) return e;
    // A panel opened BEFORE the shutdown day keeps the old model until restart:
    // the list is reread only at start. Then "no access" would be untrue.
    const r = isRetired(model, now) ? retirement(model) : null;
    const replacement = r && (MODELS.find(x => x.id === r.replacement) || {}).label;
    const out = new HttpError(404, r
        ? openAiI18n.t('error.modelRetired', { model, date: r.shutdown, replacement: replacement || r.replacement })
        : openAiI18n.t('error.modelNotOpen', { model }));
    out.code = 'model_not_found';
    return out;
}

function capsFor(modelId) {
    const m = MODELS.find(x => x.id === modelId);
    return m ? m.caps : UNKNOWN_CAPS;
}

/** Extracts a base64 PNG from the response, or throws a readable error. */
function extractImages(json, n) {
    if (!json || !Array.isArray(json.data)) {
        throw new HttpError(0, openAiI18n.t('provider.openaiNoData'));
    }
    const out = [];
    for (const item of json.data) {
        if (item && typeof item.b64_json === 'string') out.push(item.b64_json);
        else if (item && item.url) {
            throw new HttpError(0, openAiI18n.t('provider.openaiUrl'));
        }
    }
    if (!out.length) {
        const refusal = json.data[0]?.revised_prompt ? openAiI18n.t('provider.openaiRewritten') : '';
        throw new HttpError(0, openAiI18n.t('provider.openaiNoImages', { refusal }));
    }
    return out.slice(0, n);
}

const blobName = (blob, i) => {
    const t = (blob && blob.type) || 'image/png';
    const ext = t.includes('jpeg') ? 'jpg' : t.includes('webp') ? 'webp' : 'png';
    return { filename: `img${i}.${ext}`, contentType: t };
};

/**
 * Shared SSE reader for /images/edits and /images/generations.
 * OpenAI sends up to three partial events, then one completed event.
 */
async function readImageStream({ url, headers, body, signal, onPartial,
                                 partialType, completedType }) {
    let done = null;
    const last = await requestStream(url, { method: 'POST', headers, body, signal }, ev => {
        if (!ev || !ev.type) return;
        if (ev.type === partialType && ev.b64_json) {
            onPartial(ev.b64_json, ev.partial_image_index);
        } else if (ev.type === completedType) {
            done = ev;
        } else if (ev.type === 'error' || ev.error) {
            throw new HttpError(0, ev.error?.message || openAiI18n.t('provider.openaiStreamError'));
        }
    });
    const fin = done || last;
    if (!fin || fin.type !== completedType || !fin.b64_json) {
        throw new HttpError(0, openAiI18n.t('provider.openaiStreamIncomplete'));
    }
    return { images: [fin.b64_json], usage: fin.usage || null };
}

/**
 * Editing existing pixels — the plugin's main path.
 *
 * imageBlob is the captured area (lossless PNG or JPEG, see capture.js).
 * references are extra reference images; the API accepts an `image[]` array
 * (the documented example is a gift basket from four files). The mask applies
 * to the FIRST image, so our area goes first.
 * onPartial — if set, we request stream:true and emit intermediate frames
 * (`image_edit.partial_image` events).
 */
async function editImage({ apiKey, model, prompt, imageBlob, maskBlob, references,
                          plan, background, signal, onPartial }) {
    const modelCaps = capsFor(model);
    const fields = [
        { name: 'model',  data: model },
        { name: 'prompt', data: prompt },
        { name: 'output_format', data: OUTPUT_FORMAT },
    ];

    const imgs = [imageBlob].concat(references || []).filter(Boolean);
    if (imgs.length === 1) {
        const meta = blobName(imgs[0], 0);
        fields.push({ name: 'image', data: imgs[0], ...meta });
    } else {
        // keep the array only when it is actually needed: a single `image`
        // has worked for a long time and is verified, while `image[]` is the newer form
        imgs.forEach((b, i) => fields.push({ name: 'image[]', data: b, ...blobName(b, i) }));
    }

    if (plan.size)  fields.push({ name: 'size', data: plan.size });
    if (plan.quality && plan.quality !== 'auto') {
        fields.push({ name: 'quality', data: plan.quality });
    }
    if (maskBlob) {
        fields.push({ name: 'mask', data: maskBlob, filename: 'mask.png', contentType: 'image/png' });
    }
    if (background) fields.push({ name: 'background', data: background });
    // Only generation-1.x models know input_fidelity. gpt-image-2 and 2.5 already
    // hold the input at high fidelity, and the parameter is unknown to them and
    // fails the request — so the decision lives in the model's caps, not in a check of its name.
    if (modelCaps.inputFidelity) {
        fields.push({ name: 'input_fidelity', data: 'high' });
    }
    if (onPartial) {
        fields.push({ name: 'stream', data: 'true' });
        // The default partial_images=0: the server then sends only completed.
        fields.push({ name: 'partial_images', data: String(PARTIAL_IMAGES) });
    }

    const { body, contentType } = await buildMultipart(fields);
    const headers = { ...authHeader(apiKey), 'Content-Type': contentType };
    const url = `${BASE}images/edits`;

    if (onPartial) {
        return readImageStream({
            url, headers, body, signal, onPartial,
            partialType: 'image_edit.partial_image',
            completedType: 'image_edit.completed',
        });
    }

    const json = await request(url, { method: 'POST', headers, body, signal });
    return { images: extractImages(json, 1), usage: json.usage || null };
}

/* ── Refine: /v1/responses with the image_generation tool ──────────────────── *
 * NOT a replacement for images/edits, an addition. The main path stays the main
 * path: it knows our models by name, the extended quality levels (xhigh/max),
 * and returns usage from which the exact price is computed. Responses adds
 * exactly one thing images/edits fundamentally cannot do — MEMORY OF THE PREVIOUS
 * FRAME: "and now a softer shadow" is interpreted against the model's own past
 * intent, not from bare pixels.
 *
 * The chain starts lazily, on purpose: ordinary generation does not change the
 * route or the price. The first Refine opens a conversation with the finished
 * result as input_image — a data URI, bypassing the Files API. No mask is needed
 * here: we refine the whole generated tile, and it returns to the document through
 * the same layer mask as always. From the second turn we send only the call id.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Host model: image_generation is a tool, not a model, and /v1/responses
 * requires a chat model in the `model` field. This is a protocol constant, like BASE.
 */
const RESPONSES_HOST = 'gpt-5.6';

/**
 * Tool fields. `model` was not documented, so it is optional here:
 * see rejectsToolModel — we check it on the live API, not by guessing.
 */
function refineTool({ plan, model, withModel, partials }) {
    // Ask for the format explicitly: in Responses the default is not png, and
    // insertion without pHYs falls apart — see OUTPUT_FORMAT.
    const tool = { type: 'image_generation', output_format: OUTPUT_FORMAT };
    if (withModel) tool.model = model;
    if (plan && plan.size) tool.size = plan.size;
    if (plan && plan.quality && plan.quality !== 'auto') tool.quality = plan.quality;
    if (partials) tool.partial_images = PARTIAL_IMAGES;
    return tool;
}

/**
 * TURN ≥2 GOES BY previous_response_id, NOT BY AN INPUT ASSEMBLED BY HAND — AND
 * THIS IS A MEASUREMENT, NOT A PREFERENCE. The documentation example sends the
 * `image_generation_call` back by id. With a reasoning host model that is a 400
 * (measured 2026-09-09):
 *   Item 'ig_…' of type 'image_generation_call' was provided without its
 *   required 'reasoning' item: 'rs_…'
 * Output items form a graph (reasoning → image_generation_call), and a node
 * cannot be inserted back without its parent. previous_response_id exists for
 * that: the server carries the chain, and the client does not model someone else's structure.
 */
function refineInput({ prompt, previousResponseId, previousImage }) {
    const content = [{ type: 'input_text', text: prompt }];
    if (!previousResponseId) {
        // First turn: there is nothing to refer to, so we give the pixels of the
        // previous result — those pixels are what is being refined.
        content.push({
            type: 'input_image',
            // a cached frame may have come from Gemini — and that returns JPEG only
            image_url: `data:${mimeOfB64(previousImage)};base64,${previousImage}`,
            detail: 'auto',
        });
    }
    return [{ role: 'user', content }];
}

/**
 * Extracts the image and the response id. responseId is critical: without it the
 * next Refine would start the chain over and the conversation would lose its memory.
 * callId stays for the log — it shows that the tool actually drew.
 */
function extractResponseImage(json) {
    const output = json && Array.isArray(json.output) ? json.output : [];
    const call = output.find(o => o && o.type === 'image_generation_call'
                                && typeof o.result === 'string' && o.result);
    if (!call) {
        // The model may have answered with text instead of an image — show that
        // text, because it is what explains the refusal.
        const said = output
            .filter(o => o && o.type === 'message')
            .flatMap(o => (o.content || []).map(c => c && c.text).filter(Boolean))
            .join(' ').slice(0, 300);
        throw new HttpError(0, openAiI18n.t('provider.openaiNoImages', { refusal: said }));
    }
    return {
        images: [call.result],
        responseId: json.id || null,
        callId: call.id || null,
        usage: json.usage || null,
    };
}

/** Responses SSE has its own event names — the b64 shape differs from images/*. */
async function readResponsesStream({ url, headers, body, signal, onPartial }) {
    let done = null;
    const last = await requestStream(url, { method: 'POST', headers, body, signal }, ev => {
        if (!ev || !ev.type) return;
        if (ev.type === 'response.image_generation_call.partial_image' && ev.partial_image_b64) {
            onPartial(ev.partial_image_b64, ev.partial_image_index);
        } else if (ev.type === 'response.completed' && ev.response) {
            done = ev.response;
        } else if (ev.type === 'error' || ev.error) {
            throw new HttpError(0, ev.error?.message || openAiI18n.t('provider.openaiStreamError'));
        }
    });
    const fin = done || (last && last.response);
    if (!fin) throw new HttpError(0, openAiI18n.t('provider.openaiStreamIncomplete'));
    return extractResponseImage(fin);
}

/**
 * A refusal specifically about the `model` field on the tool — the only case
 * where there is something to do next. The wording is deliberately narrow: "model
 * not found" for the host model must NOT land here, or we would silently replace
 * a clear error with a second identical request.
 */
function rejectsToolModel(e) {
    if (!e || e.status !== 400) return false;
    const msg = String(e.message || '');
    return /tools\[\d+\]\.model/.test(msg)
        || (/unknown|unsupported|unrecognized|not permitted/i.test(msg) && /\bmodel\b/i.test(msg));
}

/**
 * Refine the previous result.
 * @returns {{images:string[], callId:string|null, usage:object|null}}
 */
async function refine({ apiKey, model, prompt, previousResponseId, previousImage,
                        plan, signal, onPartial, onProgress }) {
    if (!apiKey) throw new Error(openAiI18n.t('provider.noKey', { provider: 'OpenAI' }));
    if (!prompt || !prompt.trim()) throw new Error(openAiI18n.t('provider.emptyPrompt'));
    if (!previousResponseId && !previousImage) throw new Error(openAiI18n.t('provider.refineNoSource'));

    const url = `${BASE}responses`;
    const headers = { ...authHeader(apiKey), 'Content-Type': 'application/json' };
    const input = refineInput({ prompt, previousResponseId, previousImage });

    const send = withModel => {
        const payload = {
            model: RESPONSES_HOST,
            input,
            tools: [refineTool({ plan, model, withModel, partials: !!onPartial })],
        };
        if (previousResponseId) payload.previous_response_id = previousResponseId;
        if (onPartial) payload.stream = true;
        const body = JSON.stringify(payload);
        return onPartial
            ? readResponsesStream({ url, headers, body, signal, onPartial })
            : request(url, { method: 'POST', headers, body, signal }).then(extractResponseImage);
    };

    if (onProgress) onProgress(openAiI18n.t('provider.refining'));
    // Without this line the first turn cannot be told from a continuation.
    console.log(`[openai] responses/${RESPONSES_HOST} + image_generation, ` +
                (previousResponseId ? `continuation (${previousResponseId})` : 'first turn (with pixels)'));

    let res;
    try {
        res = await withRetry(() => send(true), { signal });
    } catch (e) {
        if (!rejectsToolModel(e)) throw explainModelError(e, model);
        console.warn('[openai] the tool does not accept model — refining with the API default model');
        res = await withRetry(() => send(false), { signal });
    }
    if (onProgress) onProgress(openAiI18n.t('provider.done'));
    return res;
}

/** Generate from scratch — when pixels are deliberately ignored. */
async function generateFresh({ apiKey, model, prompt, plan, background, signal, onPartial }) {
    const payload = { model, prompt, n: 1, output_format: OUTPUT_FORMAT };
    if (plan.size) payload.size = plan.size;
    if (plan.quality && plan.quality !== 'auto') payload.quality = plan.quality;
    if (background) payload.background = background;

    if (onPartial) {
        payload.stream = true;
        payload.partial_images = PARTIAL_IMAGES;
    }

    const url = `${BASE}images/generations`;
    const headers = { ...authHeader(apiKey), 'Content-Type': 'application/json' };
    const body = JSON.stringify(payload);

    if (onPartial) {
        return readImageStream({
            url, headers, body, signal, onPartial,
            partialType: 'image_generation.partial_image',
            completedType: 'image_generation.completed',
        });
    }

    const json = await request(url, {
        method: 'POST',
        headers,
        body,
        signal,
    });
    return { images: extractImages(json, 1), usage: json.usage || null };
}

/**
 * The single contract output: { images: [base64 PNG], usage }.
 * usage comes from the API itself (input_tokens / output_tokens / image_tokens),
 * and usage.js estimates USD from a versioned table of official rates.
 */
async function generate({ apiKey, model, prompt, imageBlob, maskBlob, references,
                          plan, background, ignorePixels, signal, onPartial, onProgress }) {
    if (!apiKey) throw new Error(openAiI18n.t('provider.noKey', { provider: 'OpenAI' }));
    if (!prompt || !prompt.trim()) throw new Error(openAiI18n.t('provider.emptyPrompt'));

    // A guard, not the main mechanism: quality is already reconciled with the model
    // in the UI. But between the choice and the request the user may have switched
    // models, and only 2.5 knows `xhigh`/`max` — the server would answer 400 instead of an image.
    const allowed = capsFor(model).qualities;
    if (plan && plan.quality && allowed && !allowed.includes(plan.quality)) {
        console.warn(`[openai] ${model} does not accept quality=${plan.quality} — requesting without it`);
        plan = { ...plan, quality: 'auto' };
    }

    if (onProgress) onProgress(openAiI18n.t('provider.generating'));
    const useEdit = imageBlob && !ignorePixels;
    // "the model does not see the selected area" is diagnosed only by this line:
    // without it an edit cannot be told from generation from scratch
    console.log(`[openai] ${useEdit ? 'images/edits' : 'images/generations (WITHOUT area pixels)'}` +
                `${imageBlob ? `, input ${(imageBlob.size / 1024).toFixed(0)} KB` : ', no input'}` +
                `${useEdit && maskBlob ? ', mask present' : ''}${ignorePixels ? ', "ignore pixels" is on' : ''}`);
    let res;
    try {
        res = await withRetry(() => (useEdit
            ? editImage({ apiKey, model, prompt, imageBlob, maskBlob, references,
                          plan, background, signal, onPartial })
            : generateFresh({ apiKey, model, prompt, plan, background, signal, onPartial })), { signal });
    } catch (e) {
        // The only place that knows both the model and the error — so the explanation is here.
        throw explainModelError(e, model);
    }
    if (onProgress) onProgress(openAiI18n.t('provider.done'));
    return res;
}

module.exports = {
    id: 'openai',
    label: 'OpenAI',
    keyName: 'openAiApiKey',
    supportsMask: true,
    supportsReferences: true,
    supportsTransparent: true,
    supportsStream: true,
    // A conversation about the previous frame exists only on /v1/responses, and only here.
    supportsRefine: true,
    keyPage: 'https://platform.openai.com/api-keys',
    models,
    availableModels,
    retirement,
    isRetired,
    RETIRED,
    explainModelError,
    capsFor,
    generate,
    refine,
    RESPONSES_HOST,
    OUTPUT_FORMAT,
    /* Pure pieces of the refine route, exposed exactly for tests: the request
       body can be assembled and the response parsed without the network, and it
       is in the body shape that the errors hide which a live run would show in the most expensive way. */
    _refineParts: { refineTool, refineInput, extractResponseImage, rejectsToolModel },
};
