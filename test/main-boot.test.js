/* ============================================================================
 *  test/main-boot.test.js — PANEL INITIALIZATION, ACTUALLY RUN.
 *
 *  Until now no test loaded main.js (1271 lines) — it was read as text. A bug
 *  on the startup path could be shown only by Photoshop, opened by hand. This
 *  file walks the whole initUI on stubs and looks at what ended up in the DOM.
 * ========================================================================== */

const assert = require('node:assert/strict');
const test = require('node:test');
const stub = require('./stubs/dom.js');

const env = stub.install();
const { doc, store } = env;

const errors = [];
const realError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); realError(...a); };

require('../main.js');

// DOMContentLoaded starts initUI; it is async, so let the event loop catch up
const booted = (async () => {
    doc.fire('DOMContentLoaded');
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 5));
})();

test('initialization passes with no exception, even when there is no API key yet', async () => {
    await booted;
    // initUI catches each block separately and writes to console.error — so a
    // silent console.error here is "initialization passed"
    assert.deepEqual(errors, [], 'no initUI block should fail on a clean start');
});

test('the provider and model lists really reach the DOM', async () => {
    await booted;
    const provider = doc.getElementById('provider-select');
    assert.ok(provider, 'the provider picker must exist after the substitution');
    assert.ok(provider.querySelectorAll('sp-menu-item').length > 0,
        'the provider picker must not stay empty');

    const names = provider.querySelectorAll('sp-menu-item').map(c => c.getAttribute('value'));
    assert.deepEqual(names, ['wavespeed', 'openai', 'google']);

    const model = doc.getElementById('model-select');
    const ids = model.querySelectorAll('sp-menu-item').map(c => c.getAttribute('value'));
    // This is why the two awaits in refreshModels are separate: without an API
    // key the list must arrive from the built-in one, not leave the picker empty.
    assert.deepEqual(ids, [
        'google/nano-banana-2/edit',
        'google/nano-banana-pro/edit',
        'bytedance/seedream-v5.5/edit',
        'wavespeed-ai/qwen-image-2.0/edit',
    ]);
    assert.equal(store.get('ai_provider'), 'wavespeed');
    assert.ok(ids.includes(store.get('ai_model')), 'the saved model must be among the items');
});

test('a fresh WaveSpeed selection shows no invented price and no request mask', async () => {
    await booted;
    assert.equal(doc.getElementById('transparent-bg').disabled, true);
    assert.equal(doc.getElementById('live-preview').disabled, true);
    assert.equal(doc.getElementById('ignore-pixels').disabled, true);
    await withSelection(15);
    assert.match(planLine(), /cost unavailable/);
    assert.doesNotMatch(planLine(), /\$/);
    assert.doesNotMatch(planLine(), /with mask/);

    const model = doc.getElementById('model-select');
    model.value = 'bytedance/seedream-v5.5/edit';
    model.fire('change', { target: { value: 'bytedance/seedream-v5.5/edit' } });
    assert.equal(doc.getElementById('transparent-bg').disabled, false,
        'Seedream is the only WaveSpeed model with a transparent background');
    assert.equal(doc.getElementById('live-preview').disabled, true);
});

test('quality levels follow the model capabilities, not the name', async () => {
    await booted;
    const seg = doc.getElementById('quality-toggle');
    const levels = () => seg.querySelectorAll('.seg-btn').map(b => b.dataset.value);

    assert.deepEqual(levels(), ['low', 'medium', 'high', 'auto'],
        'WaveSpeed edit models use the classic quality ladder');

    const provider = doc.getElementById('provider-select');
    provider.value = 'openai';
    provider.fire('change', { target: { value: 'openai' } });
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 5));
        if (store.get('ai_model') === 'gpt-image-2.5-sunburst') break;
    }

    // gpt-image-2.5 is the OpenAI default: it has the extended levels
    assert.deepEqual(levels(), ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
        '2.5 must have xhigh and max');
    assert.ok(seg.classList.contains('seg-wrap'),
        'six buttons in one row do not fit a 230-pixel panel — there must be two rows');

    // THE POINT: switching to an older model must REMOVE levels it does not
    // know. Otherwise a request with quality=max would go to gpt-image-2 and return 400.
    // (The model is one that does not shut down: the test must not age with the catalog.)
    const model = doc.getElementById('model-select');
    seg.querySelectorAll('.seg-btn').find(b => b.dataset.value === 'max').fire('click');
    assert.equal(store.get('ai_quality'), 'max');

    model.value = 'gpt-image-2';
    model.fire('change', { target: { value: 'gpt-image-2' } });
    assert.deepEqual(levels(), ['low', 'medium', 'high', 'auto'],
        'gpt-image-2 has no extended levels — the buttons must disappear');
    const active = seg.querySelectorAll('.seg-btn').filter(b => b.classList.contains('active'));
    assert.equal(active.length, 1, 'exactly one level is active');
    assert.equal(active[0].dataset.value, 'high',
        'a saved max must drop to high — and NEVER rise, because that is someone else\'s money');
});

test('the built-in preset appears on the very first start', async () => {
    await booted;
    const list = doc.getElementById('preset-list');
    assert.ok(list, 'the presets section must exist');
    assert.ok(list.children.length > 0,
        'without presetManager.load() this was empty — that is the bug this test guards');
});

test('the prompt character counter appears only when the text is actually long', async () => {
    await booted;
    const input = doc.getElementById('prompt-input');
    const counter = doc.getElementById('prompt-count');
    assert.ok(input && counter);
    const limit = Number(input.getAttribute('maxlength'));
    assert.ok(limit >= 1000, 'the field must declare a large maxlength — otherwise UXP silences it at ~256');

    input.value = 'short';
    input.fire('input');
    assert.ok(counter.classList.contains('hidden'), 'on short text the counter is not needed');

    input.value = 'a'.repeat(Math.round(limit * 0.95));
    input.fire('input');
    assert.ok(!counter.classList.contains('hidden'), 'on long text the counter must show');
    assert.ok(counter.classList.contains('near'), 'near the limit — a different color');
    assert.match(counter.textContent, new RegExp(`/ ${limit}$`));
});

test('a key change re-requests the model list', async () => {
    await booted;
    /* Model availability depends on the key (openai.models asks /v1/models).
       Without this wiring a freshly entered key started filtering the picker
       only after the panel was reopened: the user saw models they do not have
       and got a 404 instead of an explanation. The gate is static, because
       auth.js dispatches the event and main.js listens — that is the joint that was lost. */
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..');
    assert.match(fs.readFileSync(path.join(root, 'auth.js'), 'utf8'),
        /dispatchEvent\(new Event\('exactfill:keychange'\)\)/,
        'auth.js must report a new key');
    assert.match(fs.readFileSync(path.join(root, 'main.js'), 'utf8'),
        /addEventListener\('exactfill:keychange'[\s\S]{0,400}refreshModels\(\)/,
        'main.js must re-request models on this event');
    /* For OpenAI the list does NOT depend on the key (see models.test.js — the
       catalog is not the source of truth about access). The wiring stays for
       Google, where ListModels really returns what this key is allowed. */
});

/* ── Plan card: the promise must match the request ────────────────────────── */

/** Lets the event loop catch up: `change` handlers do not wait for refreshPlanLine. */
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 2)); };

/** A 1011×423 selection on a 1920×1280 canvas — the same area as in the live run. */
function withSelection(pad, extra = {}) {
    env.photoshop.app.activeDocument = {
        width: 1920, height: 1280,
        selection: { bounds: { left: 169, top: 36, right: 1180, bottom: 459 }, solid: true },
        ...extra,
    };
    const el = doc.getElementById('context-pad');
    el.value = String(pad);
    el.fire('change');
    return settle();
}

const planLine = () => doc.getElementById('plan-line').textContent;

test('the plan card names THE SAME input format that will actually be sent', async () => {
    await booted;
    /* THIS WAS A LIVE BUG, caught in Photoshop 2026-09-09. The format decision
       lived twice: capturePayload forced PNG for the mask, and the card looked
       only at the "lossless input" checkbox. The user read "input JPEG · 58 KB",
       and 1227 KB of PNG was sent — a twenty-fold difference exactly where it is expensive. */
    doc.getElementById('lossless-input').checked = false;

    await withSelection(0);
    assert.match(planLine(), /input JPEG/, 'with no context there is no mask — JPEG');
    assert.doesNotMatch(planLine(), /with mask/);

    await withSelection(15);
    assert.match(planLine(), /input PNG/,
        'context > 0 turns the mask on, and a mask requires PNG — the card must say so');
    assert.match(planLine(), /with mask/,
        'a mask changes the model from "edit" to "repaint" — that is not a detail for the card');
});

test('the plan card does not promise an input image when pixels are ignored', async () => {
    await booted;
    doc.getElementById('lossless-input').checked = false;
    doc.getElementById('ignore-pixels').checked = true;
    await withSelection(15);
    assert.match(planLine(), /no input image/);
    assert.doesNotMatch(planLine(), /with mask/, 'without pixels there is nothing for a mask to attach to');
    doc.getElementById('ignore-pixels').checked = false;
});

test('Regenerate takes the current context pad, not the saved one', () => {
    /* The gate is static: the reuse branch runs only after a real request,
       which the stand does not make. But the bug itself is textual — resolveRegion
       accepted padPercent and did not read it in this branch, returning lastRun.ctx.
       Moving the slider before Regenerate silently did nothing: the same frame and
       the same price with no hint in the interface. */
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const branch = src.slice(src.indexOf('async function resolveRegion'),
                             src.indexOf('/** Capture pixels'));
    assert.match(branch, /return \{ target: lastRun\.target, ctx: expandForContext\(lastRun\.target, doc, padPercent\) \}/,
        'reuse must recompute the context from the current padPercent');
    assert.doesNotMatch(branch, /ctx: lastRun\.ctx/,
        'a saved ctx in the reuse branch is that same bug');
});

test('the context pad is computed on each axis separately', async () => {
    await booted;
    /* The pad used to be taken from the LONGER side and added to all four
       sides. On a 1011×423 selection "15%" gave 152 px everywhere: +30% of the
       width, but +72% of the height, and asymmetric after clamping to the top of
       the canvas — measured on the host 2026-09-09 as ctx 1315×611. Correct: 1315×522. */
    doc.getElementById('lossless-input').checked = false;
    await withSelection(15);
    assert.match(planLine(), /context 1315×522/,
        `expected padX=152, padY=63; got: ${planLine()}`);
});

test('the plan card names the price before the button is pressed', async () => {
    await booted;
    /* Model and level are set explicitly: earlier tests in this file switch
       the picker, and the forecast depends on the pair (model, quality). */
    global.localStorage.setItem('ai_model', 'gpt-image-2.5-sunburst');
    global.localStorage.setItem('ai_quality', 'high');
    doc.getElementById('lossless-input').checked = false;
    await withSelection(0);
    /* The forecast for sunburst/high is the median of 3912 output tokens from
       the log, that is ≈$0.13. The exact number is checked by usage.test.js;
       what matters here is that it reaches the card AT ALL: before this fix the
       price was known only afterwards, when it is already too late to pay. */
    assert.match(planLine(), /≈\$0\.1\d/, `there is no price on the card: ${planLine()}`);
    assert.match(planLine(), /\(\$0\.\d+–\$0\.\d+\)/, 'the range must be visible — this is an estimate, not a tariff');
});

test('the card warns about a hard edge when a mask goes with edge 0', async () => {
    await booted;
    const feather = doc.getElementById('edge-feather');
    feather.value = '0';
    await withSelection(15);
    assert.match(planLine(), /with mask/);
    assert.match(planLine(), /hard edge/, `there is no warning: ${planLine()}`);

    feather.value = '16';
    await withSelection(15);
    assert.doesNotMatch(planLine(), /hard edge/, 'with a non-zero edge the warning is unnecessary');
});

test('the Refine button exists and is grey on a clean start', async () => {
    await booted;
    const refine = doc.getElementById('refine-btn');
    assert.ok(refine, 'the button must be in the markup, not appear after the first run');
    /* Three conditions enable it, and each can refuse on its own: there was a
       run, something remains from it, the provider can do the route. On a clean
       start the first is not met — and that is what the user must see, because a
       pressed button without lastRun would go to the network with an empty reference. */
    assert.equal(refine.disabled, true);
    assert.equal(refine.getAttribute('data-i18n'), 'action.refine');
});

test('Regenerate stays next to Refine — they are different actions', async () => {
    await booted;
    // One button is easy to confuse with the other while only one of them is visible.
    // Regenerate is the same prompt against the original pixels; Refine is new
    // text against the frame already painted. Both must be in sight.
    const regen = doc.getElementById('regen-btn');
    assert.ok(regen && regen.disabled === true);
    assert.notEqual(doc.getElementById('refine-btn'), regen);
});
