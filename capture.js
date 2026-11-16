/* ============================================================================
 *  capture.js — the ONLY pixel-capture pipeline. Nowhere else in the plugin
 *  is imaging.getPixels called.
 *
 *  The main rule: NEVER TOUCH THE USER'S DOCUMENT.
 *  The old plugin ran convertMode CMYK→RGB and 16→8 on the live document, and
 *  pastePhase converted it back — irreversible for the whole layout: a swatch
 *  of 0/0/0/100 became four-color rich black, and the conversion back used the
 *  working profile from Color Settings, not the document profile. It is almost
 *  invisible on screen and shows up on film.
 *
 *  Two paths:
 *    RGB / Grayscale / Lab → imaging.getPixels with colorSpace + componentSize.
 *        getPixels is documented to CONVERT ("If omitted, then the color space of
 *        the source document is used to convert colors"), and componentSize
 *        (-1|8|16|32) replaces convertMode depth:8 with one field.
 *    CMYK and the other modes → through a document DUPLICATE.
 *        Reason: getPixels/getData() in CMYK CRASHES Photoshop (bug report 26.9;
 *        Grayscale/RGB/Lab work, Bitmap/Indexed/Multichannel fail
 *        gracefully, CMYK crashes). There is no documented CMYK in imaging
 *        at all: createImageDataFromBuffer.colorSpace lists only
 *        RGB/Grayscale/Lab.
 * ========================================================================== */

const { app, core, imaging } = require('photoshop');
const { batchPlay } = require('photoshop').action;
const uxpStorage = require('uxp').storage;

const { withPixels } = require('./place.js');
const { buildRectMaskPng, buildShapeMaskPng, encodePng } = require('./png.js');
const { isolateLayerTree } = require('./layer-tree.js');
const captureI18n = require('./i18n.js');

/** Modes the imaging API handles safely. Everything else goes through a duplicate. */
const SAFE_MODES = ['RGBColorMode', 'grayscaleMode', 'GrayscaleMode', 'labColorMode', 'LabColorMode'];

const isSafeMode = mode => SAFE_MODES.some(m => String(mode).toLowerCase() === m.toLowerCase());

/**
 * Threshold for lossless input.
 *
 * Why a threshold: JPEG q12 eats small type and edges — the model faithfully
 * reproduces artifacts we created ourselves. PNG does not. But our deflate is
 * fixed-Huffman with RLE only at distance 1 and rowStride: on a uniform mask
 * that compresses hundreds of times, on a photograph it is almost literals. So
 * 2000×1500 RGB produces ~9 MB and several seconds of work in JS.
 *
 * 2 MP is the point where this is still fast. Above it Photoshop itself writes
 * the PNG through a document duplicate: the format does NOT depend on the
 * threshold, only the writer does.
 */
const LOSSLESS_MAX_PX = 2_000_000;

/**
 * Builds a JPEG from ImageData.
 * encodeImageData requires colorSpace === 'RGB', so 4 components (RGBA) must
 * be reduced to 3. There is deliberately NO bit-depth arithmetic here: we ask
 * getPixels for componentSize:8, so the old bug (16→8 via >>8 on the range
 * [0..32768], which made the image twice as dark) is impossible by construction.
 */
async function imageDataToJpegBlob(imageData) {
    let toEncode = imageData;
    let temp = null;

    if (imageData.components === 4) {
        const src = await imageData.getData();
        const count = imageData.width * imageData.height;
        const rgb = new Uint8Array(count * 3);
        for (let i = 0; i < count; i++) {
            rgb[i * 3]     = src[i * 4];
            rgb[i * 3 + 1] = src[i * 4 + 1];
            rgb[i * 3 + 2] = src[i * 4 + 2];
        }
        temp = await imaging.createImageDataFromBuffer(rgb, {
            width: imageData.width,
            height: imageData.height,
            components: 3,
            componentSize: 8,
            colorSpace: 'RGB',
            chunky: true,
        });
        toEncode = temp;
    }

    try {
        const encoded = await imaging.encodeImageData({ imageData: toEncode });
        const bytes = encoded instanceof Uint8Array ? encoded : Uint8Array.from(encoded);
        return new Blob([bytes], { type: 'image/jpeg' });
    } finally {
        if (temp) { try { temp.dispose(); } catch (e) {} }
    }
}

/**
 * Builds a PNG from ImageData with our encoder — lossless input.
 * Alpha is dropped: the provider does not need it, and 3 components instead of
 * 4 is a quarter fewer bytes in deflate.
 */
async function imageDataToPngBlob(imageData) {
    const src = await imageData.getData();
    const w = imageData.width, h = imageData.height;
    const comps = imageData.components;
    let rgb;
    if (comps === 3) {
        rgb = src instanceof Uint8Array ? src : Uint8Array.from(src);
    } else if (comps === 4) {
        const count = w * h;
        rgb = new Uint8Array(count * 3);
        for (let i = 0; i < count; i++) {
            rgb[i * 3]     = src[i * 4];
            rgb[i * 3 + 1] = src[i * 4 + 1];
            rgb[i * 3 + 2] = src[i * 4 + 2];
        }
    } else if (comps === 1) {
        // Grayscale document: expand to RGB, because providers expect color
        const count = w * h;
        rgb = new Uint8Array(count * 3);
        for (let i = 0; i < count; i++) {
            const v = src[i];
            rgb[i * 3] = v; rgb[i * 3 + 1] = v; rgb[i * 3 + 2] = v;
        }
    } else {
        throw new Error(captureI18n.t('capture.components', { count: comps }));
    }
    const t0 = Date.now();
    const png = encodePng(rgb, w, h, 3);
    console.log(`[capture] PNG ${w}×${h}: ${(png.length / 1048576).toFixed(2)} MB ` +
                `in ${Date.now() - t0} ms`);
    return new Blob([png], { type: 'image/png' });
}

/** Direct path — the document is not changed in any way. */
async function captureDirect(bounds, useLayerOnly, lossless) {
    const params = {
        sourceBounds: {
            left: bounds.left, top: bounds.top,
            right: bounds.right, bottom: bounds.bottom,
        },
        applyAlpha: false,
        colorSpace: 'RGB',
        // without an explicit profile the conversion is nondeterministic — the known
        // "black or negative type of image colors" symptom
        colorProfile: 'sRGB IEC61966-2.1',
        componentSize: 8,
    };
    if (useLayerOnly) {
        const layer = app.activeDocument.activeLayers[0];
        if (layer) params.layerID = layer.id;
    }
    return withPixels(params, lossless ? imageDataToPngBlob : imageDataToJpegBlob);
}

/**
 * Duplicate path: convert the COPY, save JPEG, close the copy.
 * imaging is not involved here at all, so CMYK has nowhere to crash.
 */
async function captureViaDuplicate(bounds, useLayerOnly, lossless) {
    const doc = app.activeDocument;
    let dup = null;
    let file = null;
    try {
        dup = await doc.duplicate();

        if (useLayerOnly) {
            // Do not delete top-level layers: the active layer may be nested
            // in a group. Isolate its branch by visibility on the copy.
            const keep = dup.activeLayers[0];
            if (!keep || !isolateLayerTree(dup.layers, keep.id)) {
                throw new Error(captureI18n.t('capture.layerMissing'));
            }
        }

        // GUARD. convertMode without _target acts on the ACTIVE document. If
        // duplicate() failed to make the copy active, we would convert the
        // user's document — the same irreversible CMYK→RGB we were escaping.
        // So we check explicitly and would rather refuse than ruin the layout.
        if (!app.activeDocument || app.activeDocument.id !== dup.id) {
            throw new Error(captureI18n.t('capture.copyInactive'));
        }
        const onDup = [{ _ref: 'document', _id: dup.id }];

        // Mode and bit depth first, then crop: convertMode on a smaller canvas
        // is cheaper, but a crop BEFORE conversion changes bounds, so this order
        // is required.
        if (!isSafeMode(dup.mode)) {
            await batchPlay([{
                _obj: 'convertMode',
                _target: onDup,
                to: { _class: 'RGBColorMode' },
                merge: false, flatten: false,
                _options: { dialogOptions: 'dontDisplay' },
            }], {});
        }
        if (dup.bitsPerChannel !== 8) {
            await batchPlay([{ _obj: 'convertMode', _target: onDup, depth: 8,
                _options: { dialogOptions: 'dontDisplay' } }], {});
        }

        await dup.crop({
            left: bounds.left, top: bounds.top,
            right: bounds.right, bottom: bounds.bottom,
        });

        const folder = await uxpStorage.localFileSystem.getTemporaryFolder();
        // Photoshop itself writes the PNG — our encoder is not involved here, so
        // the speed threshold does not apply to this path at all.
        if (lossless) {
            file = await folder.createFile(`cap_${Date.now()}.png`, { overwrite: true });
            await dup.saveAs.png(file, { compression: 6, interlaced: false }, true);
            const buf = await file.read({ format: uxpStorage.formats.binary });
            return new Blob([buf], { type: 'image/png' });
        }
        file = await folder.createFile(`cap_${Date.now()}.jpg`, { overwrite: true });
        await dup.saveAs.jpg(file, { quality: 12 }, true);

        const buf = await file.read({ format: uxpStorage.formats.binary });
        return new Blob([buf], { type: 'image/jpeg' });

    } finally {
        if (dup) { try { await dup.closeWithoutSaving(); } catch (e) {
            console.error('[capture] document copy did not close:', e.message);
        } }
        if (file) { try { await file.delete(); } catch (e) {} }
    }
}

/**
 * Captures the selected area as JPEG.
 * Call INSIDE core.executeAsModal.
 *
 * @param {{left,top,right,bottom}} bounds — integer bounds (geometry.integerTarget)
 * @param {boolean} useLayerOnly — only the active layer instead of the composite
 * @param {boolean} wantLossless — request PNG instead of JPEG. Above LOSSLESS_MAX_PX
 *        this means the duplicate path, NOT a silent return to JPEG.
 * @param {boolean} requirePng — PNG is mandatory: a mask goes in the request, and OpenAI
 *        requires the same format for input and mask. Practically the same as wantLossless;
 *        it stays separate because this is a protocol requirement, not a user preference.
 * @returns {Promise<{blob:Blob, docMode:string, bpc:number, viaDuplicate:boolean, lossless:boolean}>}
 */
async function captureRegion(bounds, useLayerOnly = false, wantLossless = true,
                             requirePng = false) {
    const doc = app.activeDocument;
    if (!doc) throw new Error(captureI18n.t('capture.noDocument'));

    const docMode = String(doc.mode);
    const bpc = doc.bitsPerChannel;
    const w = bounds.right - bounds.left;
    const h = bounds.bottom - bounds.top;
    if (w < 1 || h < 1) {
        throw new Error(captureI18n.t('capture.emptyArea', { width: w, height: h }));
    }

    const lossless = wantLossless || requirePng;
    /* The threshold applies only to OUR JS encoder (fixed-Huffman without real
       deflate): on a 2000×1500 photograph it produces ~9 MB and several seconds
       in JS. Photoshop writes its own PNG and needs no threshold.

       THIS USED TO BE A SILENT FEATURE LOSS: above the threshold the "lossless
       input" checkbox quietly became JPEG — but only when no mask was needed.
       The same switch worked or not depending on a completely different setting
       (the context percent). Now the threshold does not cancel the user's
       choice; it only switches the WRITER: above it Photoshop writes the PNG
       through a document duplicate. */
    const viaDuplicateOnly = lossless && w * h > LOSSLESS_MAX_PX;
    if (viaDuplicateOnly) {
        console.log(`[capture] ${w}×${h} = ${(w * h / 1e6).toFixed(1)} MP — above the ` +
                    `${LOSSLESS_MAX_PX / 1e6} MP threshold for our encoder: Photoshop writes the PNG ` +
                    'through a document duplicate');
    }

    if (!viaDuplicateOnly && isSafeMode(docMode)) {
        try {
            const blob = await captureDirect(bounds, useLayerOnly, lossless);
            return { blob, docMode, bpc, viaDuplicate: false, lossless };
        } catch (e) {
            // Known regression: componentSize:8 from a 16-bit document throws
            // "Photoshop Error. Code: -1" starting with PS 26.3 (it worked in 25.0).
            // Do NOT convert 16→8 by hand — that is where the double-darkening bug was.
            console.warn(`[capture] direct path failed (${e.message}) — using a duplicate`);
        }
    }

    const blob = await captureViaDuplicate(bounds, useLayerOnly, lossless);
    return { blob, docMode, bpc, viaDuplicate: true, lossless };
}

/**
 * Request mask — or null with an explanation of WHY it is missing.
 *
 * THE INVARIANT THIS FUNCTION EXISTS FOR: the mask travels ONLY with a PNG
 * input. OpenAI requires the input and the mask to be the same format, and the
 * server does NOT reject a mismatch — it silently ignores the mask, and the
 * model redraws the whole frame. The user's symptom: "the model does not see
 * the selection". Better to drop the mask on purpose and record the reason
 * than to send a request that quietly does the wrong thing.
 *
 * This used to live as lines inside onGenerate, and the only gate was a regex
 * over the text of main.js in platform.test.js. The invariant is now tested as
 * a function.
 *
 * @returns {{blob: Blob|null, bytes: number, reason: string}} reason is non-empty
 *          exactly when there will be no mask
 */
/**
 * Shape of the active selection in ctx-frame pixels: 255 = "change here".
 * Call INSIDE core.executeAsModal.
 *
 * WHY THIS MAY RETURN null, AND WHY THAT IS NORMAL. `imaging.getSelection`
 * crashes Photoshop on a CMYK document (the same SIGSEGV as getPixels —
 * see the imaging comment at the top of this file), so outside
 * RGB/Grayscale/Lab we do not touch it at all. No shape means a rectangular
 * mask, exactly the behavior from before 2026-09-09. A degradation, not a break.
 *
 * @returns {Promise<{data: Uint8Array|null, reason: string}>}
 */
async function selectionShape(ctx, target, docMode) {
    if (!isSafeMode(docMode)) {
        return { data: null, reason: `${docMode}: getSelection is not used outside RGB/Grayscale/Lab` };
    }
    let res = null;
    try {
        res = await imaging.getSelection({ documentID: app.activeDocument.id });
        const d = res.imageData;

        /* sourceBounds in getSelection DOES NOT WORK AS A CROP (measured in
           PS 27.5, 2026-09-09): we asked for a ctx frame of 1920×391 and got
           a raster of 1920×340, exactly the selection's own frame. So we
           assemble the frame ourselves: take what was returned and place it
           into ctx at the offset. */
        const box = res.sourceBounds || target;
        const bw = box.right - box.left, bh = box.bottom - box.top;
        if (d.width !== bw || d.height !== bh) {
            return { data: null, reason: `returned ${d.width}×${d.height}, but the frame is ${bw}×${bh}` };
        }

        const raw = await d.getData();
        const comps = d.components || 1;
        const out = new Uint8Array(ctx.w * ctx.h);   // 0 = "keep", outside the selection
        const dx = box.left - ctx.left, dy = box.top - ctx.top;
        for (let y = 0; y < d.height; y++) {
            const ty = y + dy;
            if (ty < 0 || ty >= ctx.h) continue;
            for (let x = 0; x < d.width; x++) {
                const tx = x + dx;
                if (tx < 0 || tx >= ctx.w) continue;
                out[ty * ctx.w + tx] = raw[(y * d.width + x) * comps];
            }
        }
        return { data: out, reason: '' };
    } catch (e) {
        return { data: null, reason: `getSelection: ${e.message}` };
    } finally {
        if (res && res.imageData) { try { res.imageData.dispose(); } catch (e) {} }
    }
}

function maskForRequest({ ctx, target, feather = 0, input, shape = null }) {
    if (!input) return { blob: null, bytes: 0, source: '', reason: 'no input — a mask has nothing to attach to' };
    if (input.type !== 'image/png') {
        return { blob: null, bytes: 0, source: '',
                 reason: `input is ${input.type}, not PNG: OpenAI requires the same format for input and mask` };
    }
    /* The real selection shape is better than its frame: everything that shares
       the bounding box with the target stays CONTEXT for the model, not permission
       to paint. */
    try {
        const png = shape
            ? buildShapeMaskPng(ctx.w, ctx.h, shape, feather)
            : buildRectMaskPng(ctx.w, ctx.h, {
                left: target.left - ctx.left, top: target.top - ctx.top,
                right: target.right - ctx.left, bottom: target.bottom - ctx.top,
            }, feather);
        return {
            blob: new Blob([png], { type: 'image/png' }), bytes: png.length,
            source: shape ? 'selection' : 'rectangle', reason: '',
        };
    } catch (e) {
        return { blob: null, bytes: 0, source: '', reason: `mask was not built: ${e.message}` };
    }
}

module.exports = { captureRegion, buildRectMaskPng, maskForRequest, selectionShape,
                   isSafeMode, LOSSLESS_MAX_PX };
