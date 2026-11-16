const assert = require('node:assert/strict');
const test = require('node:test');

const { insetBlendRadius } = require('../geometry.js');

// capture.js requires('photoshop') at the top level, so stubs are needed
require('./stubs/dom.js').install();
const capture = require('../capture.js');

test('the transition width is split between contract and feather', () => {
    const bounds = { left: 100, top: 100, right: 1124, bottom: 1124 };
    assert.equal(insetBlendRadius(bounds, 16), 8);
    assert.equal(insetBlendRadius(bounds, 256), 128);
});

test('a small selection keeps a fully opaque core', () => {
    const bounds = { left: 0, top: 0, right: 100, bottom: 40 };
    assert.equal(insetBlendRadius(bounds, 256), 9);
});

test('a zero or invalid value does not change the selection', () => {
    const bounds = { left: 0, top: 0, right: 100, bottom: 100 };
    assert.equal(insetBlendRadius(bounds, 0), 0);
    assert.equal(insetBlendRadius(bounds, 'not a number'), 0);
});


/* ── Invariant: a mask only with a PNG input ───────────────────────────────── */

const CTX = { left: 0, top: 0, w: 512, h: 512 };
const TARGET = { left: 128, top: 128, right: 384, bottom: 384 };

test('a mask does not travel with a JPEG input', () => {
    /* OpenAI: "the source image and the mask must share the same format and
       dimensions". A mismatch is NOT rejected by the server — it silently ignores
       the mask, and the model repaints the whole frame. The user's symptom:
       "the model does not see the selection", while the request looks successful
       and the money has been charged.

       This invariant used to live as lines inside onGenerate, and the gate was a
       regex over the text of main.js. Now it is a function, and the behavior is checked. */
    const out = capture.maskForRequest({
        ctx: CTX, target: TARGET, feather: 16,
        input: new Blob([new Uint8Array(10)], { type: 'image/jpeg' }),
    });
    assert.equal(out.blob, null, 'there must be no mask');
    assert.match(out.reason, /PNG/, 'the reason must be named, otherwise the logs are empty');
});

test('a mask is built for a PNG input and has the context size', () => {
    const out = capture.maskForRequest({
        ctx: CTX, target: TARGET, feather: 16,
        input: new Blob([new Uint8Array(10)], { type: 'image/png' }),
    });
    assert.ok(out.blob, `there must be a mask, and the reason is: ${out.reason}`);
    assert.equal(out.reason, '', 'the success path does not explain itself');
    assert.ok(out.bytes > 0 && out.bytes < 4 * 1024 * 1024, `size ${out.bytes} B is outside the OpenAI limit`);
});

test('a missing input and broken geometry do not throw, they explain', () => {
    // ignorePixels: there is no input at all
    const noInput = capture.maskForRequest({ ctx: CTX, target: TARGET, input: null });
    assert.equal(noInput.blob, null);
    assert.match(noInput.reason, /\S/);

    // a target outside the context — buildRectMaskPng will throw, and that must not crash the run
    const broken = capture.maskForRequest({
        ctx: CTX, target: { left: 900, top: 900, right: 800, bottom: 800 },
        input: new Blob([new Uint8Array(10)], { type: 'image/png' }),
    });
    assert.equal(broken.blob, null);
    assert.match(broken.reason, /\S/, 'we must see the reason in the log, not lose it');
});


/* ── The request mask follows the selection shape, not its frame ───────────── */

const { buildShapeMaskPng, buildRectMaskPng } = require('../png.js');

/** A circle of radius r in a w×h frame: 255 = "change here". */
function circle(w, h, r) {
    const sel = new Uint8Array(w * h);
    const cx = w / 2, cy = h / 2;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const dx = x - cx, dy = y - cy;
            if (dx * dx + dy * dy < r * r) sel[y * w + x] = 255;
        }
    }
    return sel;
}

test('a shape mask is smaller than a rectangular one — that is the whole point', () => {
    /* This is not about bytes, it is about the area of permission. Until
       2026-09-09 the API was sent the bounding box: everything that shared it
       with the target, the model was allowed to erase — on the host that is how
       a person's head that fell into a corner of the frame disappeared. A circle
       inscribed in the same square takes π/4 ≈ 79% of its area; the other 21%
       must stay with the model as CONTEXT. */
    const w = 200, h = 200, r = 100;
    const shaped = buildShapeMaskPng(w, h, circle(w, h, r), 0);
    const rect = buildRectMaskPng(w, h, { left: 0, top: 0, right: w, bottom: h }, 0);
    assert.ok(shaped.length > rect.length,
        'a solid rectangle compresses better than a circle — if not, the shape was not applied');
});

test('an empty shape does not pass: a mask with no transparent pixels would return the input unchanged', () => {
    assert.throws(() => buildShapeMaskPng(8, 8, new Uint8Array(64), 0));
    assert.throws(() => buildShapeMaskPng(8, 8, new Uint8Array(10), 0), /.*/,
        'a mismatched buffer size must also fail, not silently clip');
});

test('the edge must not be allowed to eat the core of the shape', () => {
    // a 400 px edge on a circle of radius 40 — the clamp must leave a fully transparent core
    const w = 120, h = 120;
    const png = buildShapeMaskPng(w, h, circle(w, h, 40), 400);
    assert.ok(png.length > 0);
    const same = buildShapeMaskPng(w, h, circle(w, h, 40), 64);
    assert.deepEqual(Array.from(png), Array.from(same),
        'past the clamp, increasing the edge must change nothing');
});

test('maskForRequest takes the shape when there is one, and says so via the source', () => {
    const png = { input: new Blob([new Uint8Array(10)], { type: 'image/png' }) };
    const withShape = capture.maskForRequest({
        ctx: CTX, target: TARGET, feather: 0, shape: circle(CTX.w, CTX.h, 100), ...png,
    });
    assert.equal(withShape.source, 'selection');
    assert.ok(withShape.blob, 'the mask must be built');

    const withoutShape = capture.maskForRequest({ ctx: CTX, target: TARGET, feather: 0, ...png });
    assert.equal(withoutShape.source, 'rectangle', 'without a shape the old behavior remains');
});
