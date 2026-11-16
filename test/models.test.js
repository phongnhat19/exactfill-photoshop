/* ============================================================================
 *  Model registry and quality levels.
 *
 *  These tests exist because of a concrete class of bugs: knowledge about a model
 *  used to live in string exceptions (`if (model !== 'gpt-image-2')`) and global
 *  lists, so a new model broke four files differently and PARTLY — that is, silently.
 *  Here we check that every model declares everything the others read from it.
 * ========================================================================== */

const assert = require('node:assert/strict');
const test = require('node:test');

const openai = require('../providers/openai.js');
const google = require('../providers/google.js');
const geometry = require('../geometry.js');
const usage = require('../usage.js');

const EXTENDED = ['xhigh', 'max'];

test('every model declares a complete set of capabilities', async () => {
    for (const provider of [openai, google]) {
        const list = await provider.models(null);
        assert.ok(list.length, `${provider.id}: the model list is empty`);
        for (const m of list) {
            const caps = provider.capsFor(m.id);
            assert.ok(caps, `${m.id}: no caps`);
            assert.ok(Array.isArray(caps.qualities) && caps.qualities.length,
                `${m.id}: without caps.qualities the panel does not know which buttons to draw`);
            // geometry reads exactly one of three shapes — otherwise planRequest
            // silently returns only { quality } and nobody sets a size
            assert.ok(caps.arbitrary || caps.sizes || caps.aspects,
                `${m.id}: caps describe no way to set a size`);
        }
    }
});

test('only gpt-image-2.5 declares xhigh and max', async () => {
    for (const m of await openai.models(null)) {
        const has = EXTENDED.some(q => openai.capsFor(m.id).qualities.includes(q));
        assert.equal(has, m.id.startsWith('gpt-image-2.5-'),
            `${m.id}: extended levels exist only on 2.5 — for the rest that is HTTP 400`);
    }
    for (const m of await google.models(null)) {
        for (const q of EXTENDED) {
            assert.ok(!google.capsFor(m.id).qualities.includes(q),
                `${m.id}: Gemini does not accept quality levels at all`);
        }
    }
});

test('an unknown model does not get extended capabilities', () => {
    const caps = openai.capsFor('gpt-image-9-does-not-exist');
    for (const q of EXTENDED) {
        assert.ok(!caps.qualities.includes(q), 'an unknown model gets the most cautious assumptions');
    }
    assert.equal(caps.inputFidelity, false);
});

test('input_fidelity is requested only from models that know it', async () => {
    for (const m of await openai.models(null)) {
        const expected = !/^gpt-image-2/.test(m.id);   // 2 and 2.5 do not accept it
        assert.equal(openai.capsFor(m.id).inputFidelity, expected, m.id);
    }
});

test('coercing the quality level never raises the cost', () => {
    const classic = ['low', 'medium', 'high', 'auto'];
    const extended = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

    // the main case: the user chose max on 2.5 and switched to an older model
    assert.equal(geometry.coerceQuality('max', classic), 'high');
    assert.equal(geometry.coerceQuality('xhigh', classic), 'high');
    // what is available stays as it is, in BOTH directions
    for (const q of extended) assert.equal(geometry.coerceQuality(q, extended), q);
    for (const q of classic) assert.equal(geometry.coerceQuality(q, classic), q);
    // going back to 2.5 does not get "stuck" on high — the wish is stored separately
    assert.equal(geometry.coerceQuality('max', extended), 'max');
    // garbage from localStorage must not raise the level to the most expensive
    assert.equal(geometry.coerceQuality('ultra', extended), 'auto');
    assert.equal(geometry.coerceQuality('', classic), 'auto');
});

test('extended levels do not ask for more pixels than the model allows', () => {
    const caps = openai.capsFor('gpt-image-2.5-sunburst');
    const target = { left: 0, top: 0, right: 1200, bottom: 900, w: 1200, h: 900 };
    const px = q => {
        const [w, h] = geometry.planRequest(caps, target, q).size.split('x').map(Number);
        return w * h;
    };
    for (const q of ['high', 'xhigh', 'max']) {
        assert.ok(px(q) <= caps.maxPx, `${q}: above the model's maxPx`);
    }
    // xhigh/max buy render effort, not area — the area is the same as high
    assert.equal(px('xhigh'), px('high'));
    assert.equal(px('max'), px('high'));
    assert.ok(px('low') < px('high'), 'the quality control must stay non-decorative');
});

test('every model in the list has a price — otherwise costs would be counted as unknown', async () => {
    for (const [provider, mod] of [['openai', openai], ['google', google]]) {
        for (const m of await mod.models(null)) {
            const est = usage.estimateCost(
                { provider, model: m.id, quality: 'medium',
                  plan: { size: '1024x1024', imageSize: '1K' }, imageCount: 1 },
                { input_tokens: 100, output_tokens: 1000 });
            assert.notEqual(est.method, 'unknown-model',
                `${m.id}: added to the list, but not to the price table in usage.js`);
            assert.ok(Number.isFinite(est.usd) && est.usd > 0, `${m.id}: the price was not computed`);
        }
    }
});

/* ── The /v1/models catalog decides nothing ───────────────────────────────── */

/* TWO MISTAKES IN ONE DAY, 2026-09-09 — both from one premise.
   First there was FILTERING by /v1/models: whatever was missing from the
   catalog disappeared from the picker. Then, softened, a `listed` MARK, and the
   panel warned "not in your key's catalog".

   Both are gone, because the premise is false, and that was MEASURED, not
   guessed. The probe (verify/check-models.sh, step 2) asked the generation
   endpoint itself:
     gpt-image-2                  → AVAILABLE  (control)
     zzz-model-that-cannot-exist  → NO         (control)
     gpt-image-2.5-sunburst       → AVAILABLE
     gpt-image-2.5-flare          → AVAILABLE
   The controls answered differently, so the probe can tell them apart. Conclusion:
   the models work, and /v1/models simply does not list them. A filter would have
   hidden two working models; a mark would have warned about a problem that does not exist.

   The rule that remains: /v1/models answers "what OpenAI lists", not "what this
   key is allowed". Ask about access ONLY the endpoint you actually use. So models()
   here does not go to the network at all. */

test('the model list is the same with a key and without one', async () => {
    const withKey = await openai.models('sk-whatever');
    const without = await openai.models(null);
    assert.deepEqual(withKey.map(m => m.id), without.map(m => m.id));
    assert.ok(withKey.length >= 6, `expected the full list, have ${withKey.length}`);
    assert.ok(withKey.some(m => m.id === 'gpt-image-2.5-sunburst'));
    assert.ok(withKey.some(m => m.id === 'gpt-image-2.5-flare'));
    for (const m of withKey) assert.ok(m.caps && m.caps.qualities, `${m.id} without caps`);
});

test('models() does not go to the network — a gate against bringing the catalog check back', () => {
    /* Static on purpose: a behavioral check of "there was no request" would
       require substituting http.js, and the way this breaks is someone writing
       a catalog call again. We catch the line itself. */
    const fs = require('node:fs');
    const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'providers', 'openai.js'), 'utf8');
    const body = src.slice(src.indexOf('async function models('), src.indexOf('function explainModelError'));
    assert.doesNotMatch(body, /fetchJson|\$\{BASE\}models|await /,
        'models() must stay off the network: the catalog is not the source of truth about access');
});

/* ── What the user sees when the model really is not available for their key ─ */

test('404 model_not_found is explained in words instead of staying "HTTP 404"', () => {
    /* This is the SECOND half of the decision "do not hide, explain". Removing
       a model from the picker is easy, but then the cause disappears with it. We
       keep the item — and we have to make the refusal understandable: the user
       must learn that the model exists, the ID is correct, and what is missing is access for this key. */
    const raw = Object.assign(new Error(
        'The model `gpt-image-2.5-sunburst` does not exist or you do not have access to it.'),
        { name: 'HttpError', status: 404, code: 'model_not_found' });
    const out = openai.explainModelError(raw, 'gpt-image-2.5-sunburst');
    assert.notEqual(out, raw, 'the error must be replaced with an explanation');
    assert.match(out.message, /gpt-image-2\.5-sunburst/, 'the text must name the model itself');
    assert.equal(out.status, 404);

    // the same when code did not arrive — OpenAI's response shape is not guaranteed
    const noCode = Object.assign(new Error(
        'The model `gpt-image-2.5-flare` does not exist or you do not have access to it.'),
        { name: 'HttpError', status: 404 });
    assert.notEqual(openai.explainModelError(noCode, 'gpt-image-2.5-flare'), noCode);
});

test('explainModelError leaves unrelated errors alone', () => {
    for (const e of [
        Object.assign(new Error('Rate limit reached'), { status: 429, code: 'rate_limit_exceeded' }),
        Object.assign(new Error('Invalid value: size'), { status: 400, code: 'invalid_value' }),
        Object.assign(new Error('Incorrect API key'), { status: 401, code: 'invalid_api_key' }),
        Object.assign(new Error('Not Found'), { status: 404, code: 'unknown_url' }),
    ]) {
        assert.equal(openai.explainModelError(e, 'gpt-image-2'), e, `${e.status}/${e.code} must not have changed`);
    }
});

/* ── OpenAI model shutdowns ────────────────────────────────────────────────── */

/* Checked 2026-10-12: developers.openai.com/api/docs/deprecations.
   The dates are not "remove someday", they are the moment a model disappears
   from the picker by itself, without a new release. So the tests walk the
   calendar, not Date.now(). */
const at = iso => Date.parse(`${iso}T00:00:00Z`);
const ids = list => list.map(m => m.id);

test('every shutdown has a date and a living replacement', () => {
    assert.ok(openai.RETIRED.size >= 4);
    for (const [id, r] of openai.RETIRED) {
        assert.match(r.shutdown, /^\d{4}-\d{2}-\d{2}$/, `${id}: shutdown date`);
        assert.ok(Number.isFinite(at(r.shutdown)), `${id}: the date does not parse`);
        assert.ok(!openai.RETIRED.has(r.replacement), `${id}: the replacement itself shuts down`);
        assert.ok(ids(openai.availableModels(at('2030-01-01'))).includes(r.replacement),
            `${id}: replacement ${r.replacement} is not in the list — a saved choice would fall through to list[0]`);
    }
    // mini is the cheapest line: its user should land on the small model
    assert.equal(openai.retirement('gpt-image-1-mini').replacement, 'gpt-image-2.5-flare');
    assert.equal(openai.retirement('gpt-image-2.5-sunburst'), null);
});

test('a retired model disappears from the picker exactly on the shutdown day', () => {
    const before = ids(openai.availableModels(at('2026-10-22')));
    assert.ok(before.includes('gpt-image-1'), 'before shutdown the model works — too early to hide it');

    const oct23 = ids(openai.availableModels(at('2026-10-23')));
    assert.ok(!oct23.includes('gpt-image-1'), 'gpt-image-1 shut down 2026-10-23');
    assert.ok(oct23.includes('gpt-image-1.5') && oct23.includes('gpt-image-1-mini'),
        '1.5 and mini work until 2026-12-01');

    const dec1 = ids(openai.availableModels(at('2026-12-01')));
    for (const id of openai.RETIRED.keys()) assert.ok(!dec1.includes(id), `${id} after 2026-12-01`);
    assert.deepEqual(dec1, ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2']);

    // the first model is the default choice; it cannot shut down
    for (const day of ['2026-10-12', '2026-10-23', '2026-12-01']) {
        assert.equal(openai.availableModels(at(day))[0].id, 'gpt-image-2.5-sunburst', day);
    }
});

test('a model that is still alive is labeled with its shutdown date', () => {
    const mini = openai.availableModels(at('2026-11-01')).find(m => m.id === 'gpt-image-1-mini');
    assert.equal(mini.hintKey, 'model.retiring');
    assert.deepEqual(mini.hintParams, { date: '2026-12-01', replacement: 'GPT Image 2.5 Flare' });
    const i18n = require('../i18n.js');
    for (const locale of ['en', 'uk']) {
        i18n.setLocale(locale);
        const text = i18n.t(mini.hintKey, mini.hintParams);
        assert.match(text, /2026-12-01/, locale);
        assert.match(text, /GPT Image 2\.5 Flare/, locale);
    }
});

test('a 404 on a retired model says "shut down", not "no access"', () => {
    const raw = () => Object.assign(new Error(
        'The model `gpt-image-1` does not exist or you do not have access to it.'),
        { name: 'HttpError', status: 404, code: 'model_not_found' });
    // the panel was opened before the 23rd and generation happens after — the list is still old
    const after = openai.explainModelError(raw(), 'gpt-image-1', at('2026-10-24'));
    assert.match(after.message, /2026-10-23/);
    assert.match(after.message, /GPT Image 2\.5 Sunburst/);
    assert.equal(after.code, 'model_not_found');
    // before the shutdown day a 404 means a real lack of access
    const early = openai.explainModelError(raw(), 'gpt-image-1', at('2026-10-20'));
    assert.doesNotMatch(early.message, /2026-10-23/);
});

/* ── Gemini: what from the ListModels catalog reaches the picker ──────────── */

/* A real ListModels snapshot (image models only), 2026-10-08, in API order.
   For Google the catalog is the source of truth: unlike OpenAI, here it
   answers the access question (checked with countTokens: 2.1 → 200,
   zzz-model-that-cannot-exist → 404). */
const GEMINI_CATALOG_2026_10_08 = [
    ['models/gemini-2.5-flash-image', 'Nano Banana'],
    ['models/gemini-3-pro-image-preview', 'Nano Banana Pro'],
    ['models/gemini-3-pro-image', 'Nano Banana Pro'],
    ['models/nano-banana-pro-preview', 'Nano Banana Pro'],
    ['models/gemini-3.1-flash-image-preview', 'Nano Banana 2'],
    ['models/gemini-3.1-flash-image', 'Nano Banana 2'],
    ['models/gemini-3.1-flash-lite-image', 'Nano Banana 2 Lite'],
    ['models/gemini-nano-banana-2.1', 'Nano Banana 2.1'],
    ['models/gemini-2.5-flash', 'Gemini 2.5 Flash'],   // text model — not in the picker
].map(([name, displayName]) => ({
    name, displayName, supportedGenerationMethods: ['generateContent', 'countTokens'],
}));

test('Nano Banana 2.1 reaches the picker and stands first — it is the default model', () => {
    /* The id `gemini-nano-banana-2.1` does not contain "-image": the old filter
       hid the newest model, and the retired gemini-2.5-flash-image became first
       (that is, the default) — simply because the API returns it first. */
    const list = google.pickImageModels(GEMINI_CATALOG_2026_10_08);
    assert.equal(list[0].id, 'models/gemini-nano-banana-2.1');
    assert.ok(!list.some(m => m.id === 'models/gemini-2.5-flash-image'), 'shut down 2026-10-02');
    assert.ok(!list.some(m => m.id === 'models/gemini-2.5-flash'), 'a text model in the picker');
});

test('preview aliases with the same name do not duplicate picker items', () => {
    const list = google.pickImageModels(GEMINI_CATALOG_2026_10_08);
    const labels = list.map(m => m.label);
    assert.equal(new Set(labels).size, labels.length, `duplicates: ${labels.join(', ')}`);
    assert.deepEqual(list.map(m => m.id), [
        'models/gemini-nano-banana-2.1',
        'models/gemini-3-pro-image',
        'models/gemini-3.1-flash-image',
        'models/gemini-3.1-flash-lite-image',
    ]);
});

test('Nano Banana 2.1 caps: 4K and panoramic formats; Lite is 1K only', () => {
    const nb21 = google.capsFor('models/gemini-nano-banana-2.1');
    assert.deepEqual(nb21.imageSizes, ['1K', '2K', '4K']);
    for (const a of ['1:4', '4:1', '1:8', '8:1']) assert.ok(nb21.aspects.includes(a), a);
    // the same id without the models/ prefix — that is how the ledger and old settings write it
    assert.equal(google.capsFor('gemini-nano-banana-2.1'), nb21);
    assert.deepEqual(google.capsFor('models/gemini-3.1-flash-lite-image').imageSizes, ['1K']);
    // panoramas only where they are documented: for older models that is a 400 and loss of size control
    assert.ok(!google.capsFor('models/gemini-3.1-flash-image').aspects.includes('8:1'));
});

test('a model from the live catalog has caps and a price, not only the built-in list', () => {
    for (const m of google.pickImageModels(GEMINI_CATALOG_2026_10_08)) {
        const est = usage.estimateCost(
            { provider: 'google', model: m.id, plan: { imageSize: '1K' }, imageCount: 1 },
            { input_tokens: 100 });
        assert.notEqual(est.method, 'unknown-model', `${m.id}: not in the price table in usage.js`);
    }
});
