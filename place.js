/* ============================================================================
 *  place.js — the central function that inserts a generated image.
 *
 *  Principle: do NOT predict where Photoshop will put the layer. PLACE → MEASURE →
 *  act RELATIVE TO WHAT WAS MEASURED → measure again. The scale percent is not
 *  a source of error here precisely because the denominator is the frame just
 *  read, not an assumption. putPixels is not used anywhere, so this works in
 *  RGB, CMYK, Grayscale, 8/16/32 bit.
 *  Replaces: main.js:556-661 (getImageDataFromBase64), :779-871
 *  (pasteSingleAsSmartObject), :873-963 (pasteBackImages).
 *
 *  MEASURED in Photoshop 27.5.0 (not from the docs — Adobe does not document
 *  batchPlay IDs). Steps 4-5 below were copied verbatim into verify/probe6.jsx
 *  and run: a matrix of 14 cases × RGB 8/16/32, CMYK 8/16, Grayscale 16 ×
 *  300 and 72 ppi × even/odd/fractional bounds/1×1/cover/off canvas/
 *  negative origin/scale-up — residual 0 everywhere, one pass per case.
 *  Logs: verify/probe6.txt (this algorithm), verify/probe2-5.txt (how we
 *  got here). The console metric is report.residual and must be zero.
 * ========================================================================== */
const { app, core, imaging, constants } = require('photoshop');
const { batchPlay } = require('photoshop').action;
const uxpStorage = require('uxp').storage;
const placeI18n = require('./i18n.js');

/**
 * The only allowed way to touch imaging in the whole plugin: dispose in finally
 * is structurally impossible to forget, and ImageData does not cross a function
 * boundary. The INSERT path (below) never calls it — that is why it does not
 * crash in CMYK and does not leak. The helper is needed only by the CAPTURE
 * path (capture.js).
 */
async function withPixels(params, fn) {
    const res = await imaging.getPixels(params);
    try { return await fn(res.imageData, res); }
    finally { try { res.imageData.dispose(); } catch (e) { console.warn('[dispose]', e.message); } }
}

/* PNG/JPEG helpers live in png.js (real deflate there, not the old code's stored blocks). */
const { readPngSize, setPngResolution, prepareForPlace } = require('./png.js');

function base64ToBytes(b64) {
    const bin = atob(b64.replace(/^data:[^,]+,/, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/* ── Measurement channel ───────────────────────────────────────────────────── */
const PX = v => ({ _unit: 'pixelsUnit', _value: v });
const unwrap = n => (n && typeof n === 'object' && '_value' in n) ? n._value : n;

/**
 * Reads the ACTUAL Smart Object frame via smartObjectMore.transform (8 numbers =
 * 4 corners). This is the only truthful channel: layer.bounds returns only the
 * area with opaque pixels INSIDE THE CANVAS (a 100×100 SO came back as 62×62),
 * so transparent AI edges and overflow past the canvas break any bounds correction.
 */
async function readSoFrame() {
    let res;
    try {
        res = await batchPlay([{
            _obj: 'get',
            _target: [
                { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' },
                { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' },
            ],
        }], {});
    } catch (e) {
        console.warn('[place] get layer failed:', e.message);
        return null;
    }
    const more = res && res[0] && res[0].smartObjectMore;
    if (!more || !more.transform || more.transform.length < 8) return null;
    const q = Array.prototype.slice.call(more.transform, 0, 8).map(unwrap);
    if (q.some(v => typeof v !== 'number' || !isFinite(v))) return null;
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];

    // Skew means transform DIVERGES from nonAffineTransform. The mere presence
    // of the key is not a signal: measured in PS 27.5 — right after a clean place,
    // nonAffineTransform duplicates transform byte for byte. A check on !!more.
    // nonAffineTransform would warn falsely on EVERY insertion.
    let skewed = false;
    if (more.nonAffineTransform && more.nonAffineTransform.length >= 8) {
        const n = Array.prototype.slice.call(more.nonAffineTransform, 0, 8).map(unwrap);
        for (let i = 0; i < 8; i++) {
            if (Math.abs(n[i] - q[i]) > 0.001) { skewed = true; break; }
        }
    }
    return {
        left: Math.min.apply(null, xs), right: Math.max.apply(null, xs),
        top: Math.min.apply(null, ys), bottom: Math.max.apply(null, ys),
        size: more.size ? { w: unwrap(more.size.width), h: unwrap(more.size.height) } : null,
        skewed,
    };
}

/** Fallback channel when smartObjectMore is unavailable. Truthful only while the
 *  layer is fully on the canvas and opaque — so the result is marked unreliable. */
function readLayerFrameFallback(layer, doc) {
    const b = layer.bounds;
    const L = unwrap(b.left), T = unwrap(b.top), R = unwrap(b.right), B = unwrap(b.bottom);
    const clipped = L <= 0 || T <= 0 || R >= doc.width || B >= doc.height;
    return { left: L, top: T, right: R, bottom: B, size: null, skewed: false, unreliable: clipped };
}

/* ══════════════════════════════════════════════════════════════════════════
 *  TWO GEOMETRY PRIMITIVES. Both measured in live Photoshop 27.5.0
 *  (see verify/probe4.txt and verify/probe6.txt): a matrix of 14 cases
 *  × RGB8/CMYK8/CMYK16/RGB16/RGB32/Gray8 × 300 and 72 ppi gave residual 0.
 *
 *  WHAT IS NO LONGER HERE, AND WHY. This used to be a `transform` from
 *  `rectangle`→`quadrilateral` — an "absolute" placement of four corners.
 *  Measured: that command DOES NOTHING. It throws no error, returns success,
 *  and leaves the frame unchanged — in all three unit variants
 *  (pixelsUnit, distanceUnit, bare doubles). The worst kind of failure: it is
 *  caught neither by an exception nor by a static check, only by measuring the after-state.
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * Scale in PERCENT of the current frame, center QCSAverage.
 * The percent is not a source of accumulated error here, because `pw` is computed
 * not from an assumption but from the frame JUST MEASURED, and the frame is
 * measured again after the step. Photoshop snaps to a whole pixel itself: a
 * frame of 245.76 at pw=81.7871% became exactly 201 (measured in RGB 16-bit 72 ppi).
 */
async function scaleSo(pw, ph) {
    // Smoother when scaling up, Sharper when scaling down — Photoshop applies
    // interpolation to the SO's NATIVE raster (size stayed 1024×1024 even at
    // a scale of 0.0977%), so repeated calls do not degrade quality
    const interp = (pw >= 100 || ph >= 100) ? 'bicubicSmoother' : 'bicubicSharper';
    await batchPlay([{
        _obj: 'transform',
        _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
        freeTransformCenterState: { _obj: 'quadCenterState', _enum: 'quadCenterState', _value: 'QCSAverage' },
        width:  { _unit: 'percentUnit', _value: pw },
        height: { _unit: 'percentUnit', _value: ph },
        interpolation: { _enum: 'interpolationType', _value: interp },
        _options: { dialogOptions: 'dontDisplay' },
    }], {});
}

/**
 * Moves the layer in PIXELS.
 *
 * Units are critical. `distanceUnit` (charID `#Rlt`) is POINTS (1/72″), and
 * Photoshop converts them through the document ppi: a request of −567 in a
 * 300 ppi document produced −2362 = −567 × 300/72. `pixelsUnit` is correct at
 * both 300 and 72 ppi — checked separately on both.
 *
 * Fractional deltas are not supported: move(0.25, −0.75) actually produced (0, −1).
 * So we round explicitly — that is API semantics, not a loss of precision: after
 * scaling the frame is already integer, so the delta is integer too.
 */
async function moveSo(dx, dy, layer) {
    const h = Math.round(dx), v = Math.round(dy);
    if (h === 0 && v === 0) return;
    try {
        await batchPlay([{
            _obj: 'move',
            _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
            to: { _obj: 'offset', horizontal: PX(h), vertical: PX(v) },
            _options: { dialogOptions: 'dontDisplay' },
        }], {});
    } catch (e) {
        // DOM fallback — measured as equivalent
        if (layer) await layer.translate(h, v);
        else throw e;
    }
}

/* ── "Resize Image During Place" preference ────────────────────────────────── */
const PREF_TARGET = [
    { _ref: 'property', _property: 'generalPreferences' },
    { _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' },
];
async function getResizeDuringPlace() {
    try {
        const r = await batchPlay([{ _obj: 'get', _target: PREF_TARGET }], {});
        const v = r && r[0] && r[0].generalPreferences && r[0].generalPreferences.resizePastePlace;
        return typeof v === 'boolean' ? v : null;
    } catch (e) { return null; }
}
async function setResizeDuringPlace(value) {
    try {
        await batchPlay([{ _obj: 'set', _target: PREF_TARGET,
            to: { _obj: 'generalPreferences', resizePastePlace: value } }], {});
        return true;
    } catch (e) { console.warn('[place] resizePastePlace preference did not change:', e.message); return false; }
}

/* Geometry lives in geometry.js (a pure module, tested in node on 9 cases). */
const { integerTarget, insetBlendRadius, planFrame } = require('./geometry.js');

/* ══════════════════════════════════════════════════════════════════════════
 *  MAIN FUNCTION
 *  b64        — PNG or JPEG in base64 from the provider (Gemini returns JPEG only)
 *  bounds     — selection bounds in document pixels (may be fractional)
 *  channelName— alpha channel with the saved selection; null = rectangular mask
 *  opts.maskBounds — original selection bounds for a guaranteed fallback
 *  Call INSIDE core.executeAsModal.
 * ═════════════════════════════════════════════════════════════════════════ */
async function placeGeneratedSmartObject(b64, bounds, channelName, opts = {}) {
    const maskFeather = Math.max(0, Number(opts.maskFeather) || 0);
    const doc = app.activeDocument;
    if (!doc) throw new Error(placeI18n.t('place.noDocument'));

    const target = integerTarget(bounds);
    if (target.w < 1 || target.h < 1) {
        throw new Error(placeI18n.t('place.emptyTarget', { width: target.w, height: target.h }));
    }

    const file = prepareForPlace(base64ToBytes(b64), doc.resolution);
    const nat = file.size;
    const dst = planFrame(target, nat);

    let tempFile = null;
    let prefWas = null;
    const disposables = [];      // invariant: everything with dispose() goes here
    const report = { mode: dst.mode, nat, target, applied: null, residual: null, warnings: [] };

    try {
        /* 1. File on disk + session token. The bytes enter Photoshop as a file —
              the imaging API is not involved at all, so CMYK/16/32 bit is safe. */
        const fs = uxpStorage.localFileSystem;
        const folder = await fs.getTemporaryFolder();
        tempFile = await folder.createFile(`ai_${Date.now()}_${Math.floor(Math.random() * 1e4)}.${file.ext}`,
            { overwrite: true });
        await tempFile.write(file.bytes.buffer.slice(file.bytes.byteOffset,
                                                    file.bytes.byteOffset + file.bytes.byteLength),
            { format: uxpStorage.formats.binary });
        const token = fs.createSessionToken(tempFile);

        /* 2. Turn off fit-to-canvas: it SHRINKS anything that does not fit the canvas.
              Not critical for accuracy (the correction below fixes it anyway),
              but without this the SO can arrive cropped to the canvas. */
        prefWas = await getResizeDuringPlace();
        if (prefWas === true) await setResizeDuringPlace(false);

        /* 3. Place. Do NOT try to set position and scale — they depend on
              pHYs, preferences, and the canvas anyway. What matters is that the
              layer appears as a Smart Object with the native raster inside. */
        await batchPlay([{
            _obj: 'placeEvent',
            null: { _path: token, _kind: 'local' },
            linked: false,
            freeTransformCenterState: { _obj: 'quadCenterState', _enum: 'quadCenterState', _value: 'QCSAverage' },
            offset: { _obj: 'offset', horizontal: PX(0), vertical: PX(0) },
            _options: { dialogOptions: 'dontDisplay' },
        }], {});

        const layer = doc.activeLayers[0];
        if (!layer) throw new Error(placeI18n.t('place.noLayer'));
        try { layer.name = `AI ${new Date().toLocaleTimeString()}`; } catch (e) {}

        /* 4. Reset transforms to native 1:1. Measured: the command produces
              exactly the native width (4266.667 → 1024) AND moves the layer —
              we do not care, because step 5 measures afterwards. The benefit is
              that it normalizes both PPI scaling and fit-to-canvas, so the percent
              in step 5 is computed from the native raster, not from a cropped one. */
        try {
            await batchPlay([{ _obj: 'placedLayerResetTransforms',
                _options: { dialogOptions: 'dontDisplay' } }], {});
        } catch (e) { report.warnings.push('placedLayerResetTransforms unavailable'); }

        /* 5. FEEDBACK LOOP: measure → scale from the measurement →
              measure → move from the measurement → measure. No PREDICTED
              value is used anywhere; every action is computed from the frame
              just read. Measured on a matrix of 14 cases: one pass is enough
              in all of them; the second is left as insurance. */
        const measure = async () => {
            let f = await readSoFrame();
            if (f) {
                // Plausibility gate: the frame must be non-zero and within
                // ±2 canvases. If smartObjectMore ever starts returning something
                // other than document coordinates, it shows up here, and we honestly
                // switch to the fallback channel instead of quietly placing the layer wrong.
                const w = f.right - f.left, h = f.bottom - f.top;
                const sane = w > 0.005 && h > 0.005
                    && f.left > -3 * doc.width && f.right < 4 * doc.width
                    && f.top > -3 * doc.height && f.bottom < 4 * doc.height;
                if (!sane) {
                    report.warnings.push('smartObjectMore.transform implausible — falling back to layer.bounds');
                    f = null;
                }
            }
            if (!f) {
                f = readLayerFrameFallback(layer, doc);
                if (f.unreliable) report.warnings.push('layer.bounds clipped by the canvas — accuracy is not guaranteed');
            }
            return f;
        };

        let cur = await measure();
        if (cur.size && (Math.abs(cur.size.w - nat.w) > 1 || Math.abs(cur.size.h - nat.h) > 1)) {
            report.warnings.push(`smartObjectMore.size ${cur.size.w}×${cur.size.h} ≠ IHDR ${nat.w}×${nat.h}`);
        }
        report.applied = { left: dst.left, top: dst.top, right: dst.right, bottom: dst.bottom };

        const tw = dst.right - dst.left, th = dst.bottom - dst.top;
        const hit = f => Math.abs(dst.left - f.left) < 0.01 && Math.abs(dst.top - f.top) < 0.01
                      && Math.abs(tw - (f.right - f.left)) < 0.01
                      && Math.abs(th - (f.bottom - f.top)) < 0.01;

        for (let pass = 0; pass < 2 && !hit(cur); pass++) {
            const cw = cur.right - cur.left, ch = cur.bottom - cur.top;
            if (cw < 0.005 || ch < 0.005) {
                report.warnings.push(`frame degenerated (${cw}×${ch}) — scale skipped`);
                break;
            }
            const pw = tw / cw * 100, ph = th / ch * 100;
            if (Math.abs(pw - 100) > 1e-9 || Math.abs(ph - 100) > 1e-9) {
                await scaleSo(pw, ph);
                cur = await measure();
            }
            await moveSo(dst.left - cur.left, dst.top - cur.top, layer);
            cur = await measure();
        }

        report.residual = {
            dx: +(dst.left - cur.left).toFixed(3), dy: +(dst.top - cur.top).toFixed(3),
            dw: +(tw - (cur.right - cur.left)).toFixed(3),
            dh: +(th - (cur.bottom - cur.top)).toFixed(3),
        };
        if (cur.skewed) report.warnings.push('SO has a non-affine transform (transform ≠ nonAffineTransform)');

        /* 6. Layer mask: show exactly the selection. For cover this also crops
              the overflow; for exact it protects against a subpixel edge. */
        const maskTarget = integerTarget(opts.maskBounds || target);
        const maskApplied = await applySelectionMask(channelName, maskTarget, maskFeather);
        report.mask = { applied: maskApplied, source: channelName ? 'selection' : 'rectangle',
            feather: maskFeather };
        if (!maskApplied) throw new Error(placeI18n.t('place.noMask'));

        console.log('[place]', JSON.stringify(report));
        return report;

    } catch (e) {
        console.error('[place] error:', e && e.message);
        throw e;
    } finally {
        // On this path disposables stays empty — and that is the main win:
        // ImageData is never created on insert, so there is nothing to leak and
        // nothing to crash in CMYK. finally stays as an invariant for later.
        for (const d of disposables) { try { d.dispose(); } catch (e) {} }
        if (prefWas === true) { try { await setResizeDuringPlace(true); } catch (e) {} }
        if (tempFile) { try { await tempFile.delete(); } catch (e) {} }
    }
}

/**
 * Restores the selection from an alpha channel (fallback: a rectangle) and builds the mask.
 * Returns true only when the layer-mask creation command actually ran.
 *
 * feather is the width of the INNER mask transition in pixels. This is the SECOND
 * mask, not the one sent to OpenAI: Gemini does not accept a request mask at all,
 * and this one runs on the Photoshop side for both providers.
 *
 * A plain feather is symmetric and extends past the selection. If the surrounding
 * context is narrower than the feather, the semi-transparent mask reaches the
 * physical edge of the Smart Object and a new hard seam appears there. So
 * contract + feather places the whole transition INSIDE the original area: at
 * its edge the AI layer is already fully hidden, and the center stays fully opaque.
 */
async function applySelectionMask(channelName, target, feather = 0) {
    const restore = async () => {
        if (channelName) {
            try {
                const channel = app.activeDocument.channels.getByName(channelName);
                await app.activeDocument.selection.load(channel, constants.SelectionType.REPLACE);
                return true;
            } catch (e) {
                console.warn('[place] selection channel did not restore, using a rectangle:', e.message);
            }
        }
        try {
            await app.activeDocument.selection.selectRectangle({
                top: target.top, left: target.left,
                bottom: target.bottom, right: target.right,
            }, constants.SelectionType.REPLACE, 0, false);
            return true;
        } catch (e) {
            console.error('[place] rectangular selection for the mask was not created:', e.message);
            return false;
        }
    };
    if (!await restore()) return;
    if (feather > 0) {
        // Use the official DOM API (PS 25+), not a raw batchPlay
        // `_obj: feather`. The latter showed a system dialog in PS 27.5,
        // "The Feather command is currently unavailable", even when catch caught the error.
        //
        // Contract the selection before feather so the outer edge of the gradient
        // ends on the original boundary instead of hanging to the Smart Object edge.
        try {
            const sel = app.activeDocument.selection;
            const b = sel && sel.bounds;
            if (b) {
                const radius = insetBlendRadius(b, feather);
                if (radius >= 1) {
                    await sel.contract(radius, true);
                    await sel.feather(radius, true);
                    console.log(`[place] inner blend: ${radius * 2} px ` +
                                `(contract ${radius} + feather ${radius})`);
                }
            }
        } catch (e) {
            // contract may have changed the selection before feather failed — restore
            // the original shape so we do not accidentally create a cropped mask.
            console.warn('[place] inner blend failed:', e.message);
            await restore();
        }
    }
    try {
        await batchPlay([{ _obj: 'make', new: { _class: 'channel' },
            at: { _ref: 'channel', _enum: 'channel', _value: 'mask' },
            using: { _enum: 'userMaskEnabled', _value: 'revealSelection' } }], {});
    } catch (e) {
        console.error('[place] mask was not created:', e.message);
        return false;
    }
    await restore();
    return true;
}

module.exports = {
    placeGeneratedSmartObject,
    withPixels,
    // re-export for callers — the implementations live in png.js / geometry.js
    setPngResolution, readPngSize,
    integerTarget, planFrame,
};
