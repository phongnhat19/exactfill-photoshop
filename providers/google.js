/* ============================================================================
 *  providers/google.js — the Google provider (Gemini image).
 *
 *  Removed relative to the old googleAiSdk.js:
 *    • all of Imagen (imagen-3.0-generate-001 / -fast-) — shut down 2026-08-17
 *    • gemini-1.5-pro/flash-latest, gemini-2.0-flash-exp — dead
 *    • the key in the URL query string (`?key=…`) — that leaks into proxy logs
 *      and diagnostics; now the x-goog-api-key header
 *
 *  Restored: generationConfig.imageConfig.{aspectRatio,imageSize}. The comment
 *  in the old code, "undocumented Gemini API field, removed", is wrong: the field
 *  is live, and imageSize uses a CAPITAL "K" ('1K'|'2K'|'4K'). A past 400 came
 *  from either a lowercase "k" or a model that only supports 1K.
 *
 *  Because the config shape in the Gemini API moves (imageConfig → responseFormat),
 *  we do NOT guess: try with the config, and on a 400 about it retry without it.
 *  Better to lose size control than the whole generation.
 * ========================================================================== */

const { blobToBase64, request, withRetry, HttpError } = require('./http.js');
const googleI18n = require('../i18n.js');

const BASE = 'https://generativelanguage.googleapis.com/v1beta/';

/** Gemini does not accept pixels — only an aspect ratio and a size level. */
const ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

/**
 * `qualities` does not go into the request here — Gemini does not accept a quality
 * level at all. But the same switch in the panel chooses imageSize (see
 * geometry.planRequest), so the list must be declared: main.js draws buttons from
 * caps, not from a global constant. `xhigh`/`max` are OpenAI 2.5 only; they are not here.
 */
const Q_CLASSIC = ['low', 'medium', 'high', 'auto'];

/**
 * The 2.1 model page names panoramic formats outright (tiling artifacts at 2K/4K
 * are fixed there). We do not add them to older models: if the API rejects the
 * format, callWithFallback retries the request WITHOUT size control.
 */
const ASPECTS_WIDE = ASPECTS.concat(['1:4', '4:1', '1:8', '8:1']);

const CAPS_PRO   = { arbitrary: false, aspects: ASPECTS, imageSizes: ['1K', '2K', '4K'], qualities: Q_CLASSIC };
const CAPS_FLASH = { arbitrary: false, aspects: ASPECTS, imageSizes: ['1K', '2K'], qualities: Q_CLASSIC };
const CAPS_NB21  = { arbitrary: false, aspects: ASPECTS_WIDE, imageSizes: ['1K', '2K', '4K'], qualities: Q_CLASSIC };
// "only supports 1K resolution" — image-generation docs, 2026-10
const CAPS_LITE  = { arbitrary: false, aspects: ASPECTS, imageSizes: ['1K'], qualities: Q_CLASSIC };

/**
 * Order is the default choice: main.js takes list[0] when the saved model is not
 * in the list. So the newest recommended model is first. Labels match displayName
 * in ListModels, so an item is not renamed when the list comes from the network
 * instead of the built-in one.
 *
 * gemini-3.1-flash-image (Nano Banana 2): there is NO shutdown date — the
 * deprecations page on 2026-10-12 says "No shutdown date announced" and only
 * recommends 2.1 as a replacement. (Before 1.7.1 this said "2026-10-29" — with no
 * source.) When the model someday disappears from ListModels, the saved choice
 * jumps to list[0] on its own, that is 2.1.
 */
const FALLBACK_MODELS = [
    { id: 'models/gemini-nano-banana-2.1',      label: 'Nano Banana 2.1',     caps: CAPS_NB21 },
    { id: 'models/gemini-3-pro-image',          label: 'Nano Banana Pro',     caps: CAPS_PRO },
    { id: 'models/gemini-3.1-flash-image',      label: 'Nano Banana 2',       caps: CAPS_FLASH },
    { id: 'models/gemini-3.1-flash-lite-image', label: 'Nano Banana 2 Lite',  caps: CAPS_LITE },
];

/**
 * Shut down by Google, but ListModels still lists them (measured 2026-10-08).
 * gemini-2.5-flash-image — shutdown 2026-10-02 on the pricing page; it was first
 * in the catalog, so it became the default model for a new key.
 * The deprecations page (2026-10-12) says 2027-03-15 for it — Google's pages
 * disagree. We keep the earlier date: it is the older model, and the replacement is already in the picker.
 */
const RETIRED = new Set(['models/gemini-2.5-flash-image']);

const authHeaders = apiKey => ({
    'x-goog-api-key': apiKey,          // NOT in the query string — so it does not leak into logs
    'Content-Type': 'application/json',
});

/**
 * A dynamic list — a useful idea from the old plugin: Google's models change
 * fast, and a static list goes stale. On failure we quietly fall back to
 * FALLBACK_MODELS, because without a list the UI is simply empty.
 */
async function models(apiKey) {
    if (!apiKey) return FALLBACK_MODELS.map(m => ({ ...m }));
    try {
        const json = await request(`${BASE}models`, { headers: authHeaders(apiKey), timeoutMs: 20000 });
        const found = pickImageModels((json && json.models) || []);
        if (found.length) return found;
    } catch (e) {
        console.warn('[google] model list was not received, using the built-in one:', e.message);
    }
    return FALLBACK_MODELS.map(m => ({ ...m }));
}

/**
 * ListModels response → picker items. A pure function so a test can feed it a
 * real catalog snapshot without stubbing the network.
 *
 * The "-image" marker in the ID is no longer enough: Nano Banana 2.1 has the ID
 * `gemini-nano-banana-2.1` without that suffix, and the old filter hid it silently.
 */
function pickImageModels(list) {
    const found = [];
    for (const m of list) {
        const name = String(m.name || '');
        const low = name.toLowerCase();
        // image generators only; Imagen is deliberately excluded — it is shut down
        if (!low.includes('-image') && !low.includes('nano-banana')) continue;
        if (low.includes('imagen')) continue;
        if (RETIRED.has(name)) continue;
        const methods = m.supportedGenerationMethods || m.supported_generation_methods;
        if (Array.isArray(methods) && !methods.includes('generateContent')) continue;
        found.push({
            id: name,
            label: (m.displayName || name.replace(/^models\//, '')),
            caps: capsFor(name),
        });
    }
    // The catalog duplicates GA models with preview aliases of the SAME name
    // (three "Nano Banana Pro" items). They cannot be told apart in the picker — keep GA.
    const gaLabels = new Set(found.filter(m => !isPreview(m.id)).map(m => m.label));
    const unique = found.filter(m => !(isPreview(m.id) && gaLabels.has(m.label)));
    // Known models follow FALLBACK_MODELS order (first = default); unknown ones follow.
    const rank = id => {
        const i = FALLBACK_MODELS.findIndex(x => x.id === id);
        return i < 0 ? FALLBACK_MODELS.length : i;
    };
    return unique
        .map((m, i) => ({ m, i }))
        .sort((a, b) => (rank(a.m.id) - rank(b.m.id)) || (a.i - b.i))
        .map(x => x.m);
}

const isPreview = id => /-preview$/i.test(id);

function capsFor(modelId) {
    const id = String(modelId);
    const m = FALLBACK_MODELS.find(x => x.id === id || x.id === `models/${id}`);
    if (m) return m.caps;
    // Unknown model — the most cautious assumptions; 4K only for the Pro line.
    return id.toLowerCase().includes('-pro-') ? CAPS_PRO : CAPS_FLASH;
}

/** Explains why the model returned nothing. */
function describeRefusal(json) {
    const fb = json && json.promptFeedback;
    if (fb && fb.blockReason) {
        return googleI18n.t('provider.googleBlocked', {
            reason: `${fb.blockReason}${fb.blockReasonMessage ? ` — ${fb.blockReasonMessage}` : ''}`,
        });
    }
    const cand = json && json.candidates && json.candidates[0];
    if (cand && cand.finishReason && cand.finishReason !== 'STOP') {
        return googleI18n.t('provider.googleFinish', {
            reason: cand.finishReason,
            detail: '',
        });
    }
    // sometimes the model answers with text instead of an image — show that text
    const parts = (cand && cand.content && cand.content.parts) || [];
    const text = parts.map(p => p.text).filter(Boolean).join(' ').trim();
    if (text) return googleI18n.t('provider.googleText', { text: text.slice(0, 300) });
    return googleI18n.t('provider.googleNoImage');
}

function extractImage(json) {
    const parts = json?.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
        const inline = p.inline_data || p.inlineData;
        if (inline && inline.data) return inline.data;
    }
    throw new HttpError(0, describeRefusal(json));
}

/** Gemini names usage differently from OpenAI — fold it into one shape. */
function normalizeUsage(json) {
    const u = json && (json.usageMetadata || json.usage_metadata);
    if (!u) return null;
    return {
        input_tokens: u.promptTokenCount ?? u.prompt_token_count ?? null,
        output_tokens: u.candidatesTokenCount ?? u.candidates_token_count ?? null,
        total_tokens: u.totalTokenCount ?? u.total_token_count ?? null,
        thought_tokens: u.thoughtsTokenCount ?? u.thoughts_token_count ?? null,
        // For cost it matters to tell TEXT from IMAGE: Gemini prices them
        // differently, and candidatesTokenCount contains both modalities.
        input_tokens_details: u.promptTokensDetails ?? u.prompt_tokens_details ?? null,
        output_tokens_details: u.candidatesTokensDetails ?? u.candidates_tokens_details ?? null,
    };
}

async function callOnce({ apiKey, model, prompt, imageBlob, references, plan,
                          withImageConfig, signal }) {
    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            candidateCount: 1,
            responseModalities: ['TEXT', 'IMAGE'],   // without this there is no image
        },
    };
    if (withImageConfig && (plan.aspectRatio || plan.imageSize)) {
        payload.generationConfig.imageConfig = {};
        if (plan.aspectRatio) payload.generationConfig.imageConfig.aspectRatio = plan.aspectRatio;
        if (plan.imageSize)   payload.generationConfig.imageConfig.imageSize   = plan.imageSize;
    }
    // Order matters: the area being edited first, then references —
    // the model treats the first image as the main one.
    for (const blob of [imageBlob].concat(references || []).filter(Boolean)) {
        payload.contents[0].parts.push({
            inline_data: {
                mime_type: blob.type || 'image/png',
                data: await blobToBase64(blob),
            },
        });
    }

    let path = String(model).replace(/^\/+/, '');
    if (!path.startsWith('models/')) path = 'models/' + path;
    const json = await request(`${BASE}${path}:generateContent`, {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify(payload),
        signal,
    });
    return { images: [extractImage(json)], usage: normalizeUsage(json) };
}

/**
 * One attempt with imageConfig; if the API rejects it, retry without it.
 * The shape of this config in Gemini has moved (imageConfig → responseFormat.image),
 * so we do not guess, we degrade: better to generate without size control
 * than to generate nothing.
 */
async function callWithFallback(args) {
    try {
        return await callOnce({ ...args, withImageConfig: true });
    } catch (e) {
        const msg = String(e && e.message).toLowerCase();
        const isConfigReject = e && e.status === 400 &&
            (msg.includes('imageconfig') || msg.includes('image_config') ||
             msg.includes('imagesize') || msg.includes('image_size') ||
             msg.includes('aspectratio') || msg.includes('aspect_ratio') ||
             msg.includes('unknown name'));
        if (!isConfigReject) throw e;
        console.warn('[google] imageConfig was rejected — retrying without size control');
        return callOnce({ ...args, withImageConfig: false });
    }
}

async function generate({ apiKey, model, prompt, imageBlob, references, plan,
                          ignorePixels, signal, onProgress }) {
    if (!apiKey) throw new Error(googleI18n.t('provider.noKey', { provider: 'Google' }));
    if (!prompt || !prompt.trim()) throw new Error(googleI18n.t('provider.emptyPrompt'));

    if (onProgress) onProgress(googleI18n.t('provider.generating'));
    // same as openai.js: otherwise "something completely wrong" cannot be diagnosed from a distance
    console.log(`[google] ${imageBlob && !ignorePixels
        ? `area goes in the request, input ${(imageBlob.size / 1024).toFixed(0)} KB`
        : 'WITHOUT area pixels'}${ignorePixels ? ', "ignore pixels" is on' : ''}`);
    const res = await withRetry(() => callWithFallback({
        apiKey, model, prompt,
        imageBlob: ignorePixels ? null : imageBlob,
        references, plan, signal,
    }), { signal });
    if (onProgress) onProgress(googleI18n.t('provider.done'));
    return res;
}

module.exports = {
    id: 'google',
    label: 'Google Gemini',
    keyName: 'googleApiKey',
    // Gemini has no mask parameter. The model sees the edit area from the fact
    // that we send the selected area itself (plus surrounding context) — so a
    // rectangular mask simply does not exist here, and main.js does not build one.
    // The seam is still softened: layer-mask blur is done on the Photoshop side.
    supportsMask: false,
    supportsReferences: true,
    // There is no transparent-background parameter — ask for it in the prompt.
    supportsTransparent: false,
    // Intermediate frames exist only in the new Interactions API (/v1beta/interactions);
    // this file calls generateContent, so there is no stream here yet.
    supportsStream: false,
    keyPage: 'https://aistudio.google.com/apikey',
    models,
    pickImageModels,
    capsFor,
    generate,
};
