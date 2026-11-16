/* ============================================================================
 *  usage.js — a persistent request ledger and an estimate of their cost.
 *
 *  A pure module: no Photoshop/DOM/localStorage, so the pricing arithmetic and
 *  time slices can be checked with ordinary `node --test`.
 *
 *  Prices are the standard paid API, USD, verified 2026-09-09:
 *    OpenAI: https://developers.openai.com/api/docs/pricing
 *            https://developers.openai.com/api/docs/models/gpt-image-1.5
 *    Google: https://ai.google.dev/gemini-api/docs/pricing
 *  2026-10-12 OpenAI checked again: 2.5 rates unchanged ($5 / $8 / $30).
 *
 *  Rows for retired models are NOT deleted. The picker no longer offers them
 *  (providers/openai.js: RETIRED), but a request sent before shutdown must
 *  still be priced, not land in the ledger as an "unknown model".
 *
 *  The computed amount is written into the ledger. A future price-table update
 *  will not change old costs retroactively.
 * ========================================================================== */

const PRICE_VERSION = '2026-09-09';
const MAX_ENTRIES = 500;
const MAX_AGE_DAYS = 365;

const OPENAI = {
    // gpt-image-2.5 is priced the same way as gpt-image-2. It has no "per
    // image" table at all: xhigh/max differ exactly in the number of output
    // tokens, so a fixed price here would be invented. If the API does not
    // return output usage, the cost is recorded as unknown.
    'gpt-image-2.5-sunburst': {
        textIn: 5, imageIn: 8, imageOut: 30,
    },
    'gpt-image-2.5-flare': {
        textIn: 5, imageIn: 8, imageOut: 30,
    },
    'gpt-image-2': {
        textIn: 5, imageIn: 8, imageOut: 30,
    },
    // Shutting down: 1.5 and 1-mini — 2026-12-01, gpt-image-1 — 2026-10-23.
    'gpt-image-1.5': {
        textIn: 5, imageIn: 8, imageOut: 32,
        flat: {
            low:    { square: 0.009, wide: 0.013 },
            medium: { square: 0.034, wide: 0.050 },
            high:   { square: 0.133, wide: 0.200 },
        },
    },
    'gpt-image-1': {
        textIn: 5, imageIn: 10, imageOut: 40,
        flat: {
            low:    { square: 0.011, wide: 0.016 },
            medium: { square: 0.042, wide: 0.063 },
            high:   { square: 0.167, wide: 0.250 },
        },
    },
    'gpt-image-1-mini': {
        textIn: 2, imageIn: 2.5, imageOut: 8,
        flat: {
            low:    { square: 0.005, wide: 0.006 },
            medium: { square: 0.011, wide: 0.015 },
            high:   { square: 0.036, wide: 0.052 },
        },
    },
};

const GOOGLE = {
    // 4K = 3780 tokens → $0.113 (Google pricing page, 2026-10-08). Third-party
    // writeups say $0.0756 — that is 2520 tokens, as for Nano Banana 2; wrong.
    'gemini-nano-banana-2.1': {
        input: 1.5, textOut: 7.5, imageOut: 30,
        flat: { '1K': 0.0336, '2K': 0.0504, '4K': 0.113 },
    },
    'gemini-3.1-flash-image': {
        input: 0.5, textOut: 3, imageOut: 60,
        flat: { '0.5K': 0.045, '1K': 0.067, '2K': 0.101, '4K': 0.151 },
    },
    'gemini-3.1-flash-lite-image': {
        input: 0.25, textOut: 1.5, imageOut: 30,
        flat: { '1K': 0.0336, '2K': 0.0336 },
    },
    'gemini-3-pro-image': {
        input: 2, textOut: 12, imageOut: 120,
        flat: { '1K': 0.134, '2K': 0.134, '4K': 0.240 },
    },
    'gemini-2.5-flash-image': {
        input: 0.3, textOut: 2.5, imageOut: 30,
        flat: { '1K': 0.039, '2K': 0.039 },
    },
};

/**
 * Typical tokens for a (model, quality) pair — the seed of the price forecast.
 *
 * THIS IS A MEASUREMENT, NOT A TARIFF. Medians from 80 real ledger requests
 * (2026-08-11…2026-09-09). What the sample showed: output tokens are set by
 * the QUALITY LEVEL, not the request area. Correlation with megapixels inside
 * one level is only +0.28…+0.58 with a spread of ±40%, so a "tokens per
 * megapixel" coefficient would be invented precision.
 *
 * Input tokens are kept separate for each level ON PURPOSE: at `low` the
 * plugin sends a small frame (median 373), at `high` a large one (1556), and
 * a shared constant was wrong by 2× at `low`.
 *
 *   model                  level    in     out     real median price
 *   gpt-image-2            low      373    141     $0.0074  (n=15)
 *   gpt-image-2            medium   1512   1932    $0.0682  (n=34)
 *   gpt-image-2            high     1556   16399   $0.5023  (n=25)
 *   gpt-image-2.5-sunburst high     1522   3912    $0.1299  (n=3)
 *   gpt-image-2.5-sunburst max      685    7062    $0.2172  (n=2)
 *   gpt-image-2.5-flare    high     1522   3912    $0.1293  (n=1)
 *
 * The 2.5 rows rest on a few observations — the forecast for them is
 * deliberately presented as approximate, not as an exact sum.
 */
const SEED_TOKENS = {
    'gpt-image-2': {
        low:    { in: 373,  out: 141 },
        medium: { in: 1512, out: 1932 },
        high:   { in: 1556, out: 16399 },
    },
    'gpt-image-2.5-sunburst': {
        high: { in: 1522, out: 3912 },
        max:  { in: 685,  out: 7062 },
    },
    'gpt-image-2.5-flare': {
        high: { in: 1522, out: 3912 },
    },
};

/** Observed spread inside a level — show a range, not a single figure. */
const FORECAST_SPREAD = 0.4;

/** How many of the user's own requests are needed before their ledger beats the seed. */
const MIN_OWN_SAMPLES = 3;

const finite = value => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
};

const modelName = model => String(model || '').replace(/^models\//, '');
const perMillion = (tokens, rate) => finite(tokens) * finite(rate) / 1_000_000;

function modalityTokens(details, wanted) {
    if (!Array.isArray(details)) return 0;
    const key = String(wanted).toUpperCase();
    return details.reduce((sum, item) => {
        const modality = String(item?.modality || item?.type || '').toUpperCase();
        return sum + (modality === key
            ? finite(item?.tokenCount ?? item?.token_count ?? item?.tokens)
            : 0);
    }, 0);
}

function openAIInputCost(usage, price, hasImageInput) {
    const details = usage?.input_tokens_details || usage?.inputTokensDetails || {};
    const text = finite(details.text_tokens ?? details.textTokens);
    const image = finite(details.image_tokens ?? details.imageTokens);
    if (text || image) {
        return perMillion(text, price.textIn) + perMillion(image, price.imageIn);
    }
    // Older or partial responses give only a total count. For an image edit
    // most of the input is the image; for generation it is text.
    const total = finite(usage?.input_tokens ?? usage?.inputTokens);
    return perMillion(total, hasImageInput ? price.imageIn : price.textIn);
}

function fixedOpenAIOutput(price, quality, size, imageCount) {
    const q = quality === 'auto' ? null : quality;
    if (!q || !price.flat?.[q]) return null;
    const [w, h] = String(size || '').split('x').map(Number);
    const shape = w && h && w === h ? 'square' : 'wide';
    return finite(price.flat[q][shape]) * Math.max(1, finite(imageCount));
}

/** Request route in the ledger. Older entries do not have it — they are edits. */
const DEFAULT_ROUTE = 'edits';

function median(values) {
    const list = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!list.length) return null;
    const mid = list.length >> 1;
    return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/**
 * How many tokens the user THEMSELVES produced for this model+quality pair.
 * @param {number} need — how many observations are enough. Two thresholds on purpose:
 *        beating the measured seed takes MIN_OWN_SAMPLES; where there is no seed
 *        at all (rare 2.5 levels), one observation is already better than an empty
 *        card — otherwise the forecast would never appear.
 */
function ownTokens(history, model, quality, need, route = DEFAULT_ROUTE) {
    if (!Array.isArray(history)) return null;
    const name = modelName(model);
    /* The route is part of the key, not a detail. Refine via /v1/responses
       carries the conversation with it: different input tokens and a different
       host model. Mixed into one median with images/edits, they spoil both
       estimates. Entries without a route field — from versions before 2026-09-09 —
       are exactly edits, so that is the default. */
    const mine = history.filter(e => e && modelName(e.model) === name && e.quality === quality
                                  && (e.route || DEFAULT_ROUTE) === route
                                  && Number(e.outputTokens) > 0);
    if (mine.length < need) return null;
    return {
        in: median(mine.map(e => Number(e.inputTokens))) || 0,
        out: median(mine.map(e => Number(e.outputTokens))),
        samples: mine.length,
        source: 'own',
    };
}

/**
 * What this request will PROBABLY cost — before the button is pressed.
 *
 * Why this is separate from estimateCost: that one computes the FACT and needs
 * `usage` from the response. gpt-image-2/2.5 has no "per image" table, so before
 * the request there is nowhere for a fact to come from — and that is exactly
 * where the price decides whether to press the button.
 *
 * The user's own ledger outranks the built-in seed: their subjects and selection
 * sizes differ, and after MIN_OWN_SAMPLES requests their median is more accurate
 * than ours. The panel calibrates itself this way, without going to the network.
 *
 * @param {object[]} [history] — ledger entries (ledger.load())
 * @returns {{usd:number|null, low:number, high:number, method:string, samples:number}}
 */
function forecastOpenAI({ model, quality, plan, history }) {
    const none = m => ({ usd: null, low: 0, high: 0, method: m, samples: 0 });
    const price = OPENAI[modelName(model)];
    if (!price) return none('unknown-model');

    // Models with a per-image tariff know their price exactly — no range is needed.
    const flat = fixedOpenAIOutput(price, quality, plan?.size, 1);
    if (flat !== null) {
        const usd = perMillion(SEED_TOKENS[modelName(model)]?.[quality]?.in ?? 1500, price.imageIn) + flat;
        return { usd, low: usd, high: usd, method: 'flat', samples: Infinity };
    }

    const seed = SEED_TOKENS[modelName(model)]?.[quality];
    const picked = ownTokens(history, model, quality, seed ? MIN_OWN_SAMPLES : 1, DEFAULT_ROUTE)
        || (seed ? { ...seed, samples: 0, source: 'seed' } : null);
    if (!picked) return none('no-observations');

    const input = perMillion(picked.in, price.imageIn);
    const out = tokens => input + perMillion(tokens, price.imageOut);
    return {
        usd: out(picked.out),
        low: out(picked.out * (1 - FORECAST_SPREAD)),
        high: out(picked.out * (1 + FORECAST_SPREAD)),
        method: picked.source === 'own' ? 'own-history' : 'seed-median',
        samples: picked.samples,
    };
}

/** Forecast for any provider. Google has a fixed price per image. */
function forecastCost({ provider, model, quality, plan, history }) {
    if (provider === 'openai') return forecastOpenAI({ model, quality, plan, history });
    if (provider === 'google') {
        const usd = estimateGoogle({ model, plan, usage: null, imageCount: 1 }).usd;
        return usd === null
            ? { usd: null, low: 0, high: 0, method: 'no-observations', samples: 0 }
            : { usd, low: usd, high: usd, method: 'flat', samples: Infinity };
    }
    return { usd: null, low: 0, high: 0, method: 'unknown-provider', samples: 0 };
}

function estimateOpenAI({ model, quality, plan, usage, imageCount, hasImageInput }) {
    const price = OPENAI[modelName(model)];
    if (!price) return { usd: null, method: 'unknown-model' };

    const input = openAIInputCost(usage, price, hasImageInput);
    const outputTokens = finite(usage?.output_tokens ?? usage?.outputTokens);
    if (outputTokens) {
        return {
            usd: input + perMillion(outputTokens, price.imageOut),
            method: 'tokens',
        };
    }

    const flat = fixedOpenAIOutput(price, quality, plan?.size, imageCount);
    if (flat !== null) {
        return { usd: input + flat, method: input ? 'tokens+flat' : 'flat' };
    }
    return { usd: null, method: 'missing-output-usage' };
}

function googleFlatOutput(price, imageSize, imageCount) {
    const amount = price.flat?.[imageSize] ?? price.flat?.['1K'];
    return amount === undefined ? null : finite(amount) * Math.max(1, finite(imageCount));
}

function estimateGoogle({ model, plan, usage, imageCount }) {
    const price = GOOGLE[modelName(model)];
    if (!price) return { usd: null, method: 'unknown-model' };

    const input = perMillion(usage?.input_tokens ?? usage?.inputTokens, price.input);
    const outDetails = usage?.output_tokens_details || usage?.outputTokensDetails;
    const imageTokens = modalityTokens(outDetails, 'IMAGE');
    const textTokens = modalityTokens(outDetails, 'TEXT') +
        finite(usage?.thought_tokens ?? usage?.thoughtTokens);
    const text = perMillion(textTokens, price.textOut);

    if (imageTokens) {
        return {
            usd: input + text + perMillion(imageTokens, price.imageOut),
            method: 'modality-tokens',
        };
    }

    // candidatesTokenCount contains both the image and the text, so we do not
    // multiply it by textOut: that would double-charge the image. Without a
    // breakdown we take the official image price for the requested size.
    const flat = googleFlatOutput(price, plan?.imageSize, imageCount);
    if (flat === null) return { usd: null, method: 'missing-output-usage' };
    return { usd: input + text + flat, method: input || text ? 'tokens+flat' : 'flat' };
}

function estimateCost(meta, usage) {
    const args = { ...meta, usage: usage || null };
    if (meta?.provider === 'openai') return estimateOpenAI(args);
    if (meta?.provider === 'google') return estimateGoogle(args);
    return { usd: null, method: 'unknown-provider' };
}

function compactUsage(usage) {
    if (!usage) return null;
    return {
        input_tokens: finite(usage.input_tokens ?? usage.inputTokens),
        output_tokens: finite(usage.output_tokens ?? usage.outputTokens),
        total_tokens: finite(usage.total_tokens ?? usage.totalTokens),
        thought_tokens: finite(usage.thought_tokens ?? usage.thoughtTokens),
        input_tokens_details: usage.input_tokens_details || usage.inputTokensDetails || null,
        output_tokens_details: usage.output_tokens_details || usage.outputTokensDetails || null,
    };
}

function createEntry(meta, usage, now = Date.now()) {
    const estimate = estimateCost(meta, usage);
    return {
        id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
        at: new Date(now).toISOString(),
        provider: meta?.provider || '',
        providerLabel: meta?.providerLabel || meta?.provider || '',
        model: modelName(meta?.model),
        quality: meta?.quality || meta?.plan?.quality || '',
        route: meta?.route || DEFAULT_ROUTE,
        size: meta?.plan?.size || meta?.plan?.imageSize || '',
        aspectRatio: meta?.plan?.aspectRatio || '',
        imageCount: Math.max(1, finite(meta?.imageCount)),
        inputTokens: finite(usage?.input_tokens ?? usage?.inputTokens),
        outputTokens: finite(usage?.output_tokens ?? usage?.outputTokens),
        costUsd: estimate.usd === null ? null : Number(estimate.usd.toFixed(8)),
        costMethod: estimate.method,
        priceVersion: PRICE_VERSION,
        usage: compactUsage(usage),
    };
}

function prune(entries, now = Date.now()) {
    const cutoff = now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    return (Array.isArray(entries) ? entries : [])
        .filter(entry => entry && Number.isFinite(Date.parse(entry.at)) && Date.parse(entry.at) >= cutoff)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, MAX_ENTRIES);
}

function total(entries) {
    const list = Array.isArray(entries) ? entries : [];
    return list.reduce((out, entry) => {
        out.requests += 1;
        out.inputTokens += finite(entry.inputTokens);
        out.outputTokens += finite(entry.outputTokens);
        if (Number.isFinite(entry.costUsd)) out.usd += entry.costUsd;
        else out.unknownCost += 1;
        return out;
    }, { requests: 0, inputTokens: 0, outputTokens: 0, usd: 0, unknownCost: 0 });
}

function summarize(entries, now = Date.now()) {
    const list = prune(entries, now);
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const sevenStart = new Date(dayStart);
    sevenStart.setDate(sevenStart.getDate() - 6);
    const today = list.filter(e => Date.parse(e.at) >= dayStart.getTime());
    const seven = list.filter(e => Date.parse(e.at) >= sevenStart.getTime());
    return {
        last: list[0] || null,
        today: total(today),
        sevenDays: total(seven),
        all: total(list),
        recent: list.slice(0, 7),
    };
}

function formatUsd(value) {
    if (!Number.isFinite(value)) return '—';
    if (value === 0) return '$0.00';
    if (value < 0.01) return `$${value.toFixed(4)}`;
    if (value < 1) return `$${value.toFixed(3)}`;
    return `$${value.toFixed(2)}`;
}

function formatTokens(value) {
    const n = finite(value);
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

module.exports = {
    PRICE_VERSION,
    MAX_ENTRIES,
    SEED_TOKENS,
    DEFAULT_ROUTE,
    MIN_OWN_SAMPLES,
    estimateCost,
    forecastCost,
    createEntry,
    prune,
    summarize,
    formatUsd,
    formatTokens,
};
