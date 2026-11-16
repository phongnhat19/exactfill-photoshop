/* ============================================================================
 *  png.js — a minimal PNG encoder with REAL deflate.
 *
 *  Why not the old encodeMaskPNG: it wrote deflate STORED blocks, meaning no
 *  compression. A 1024×1024 RGBA mask came out at 4,195,659 B ≈ 4.00 MiB, and
 *  OpenAI's mask limit is "less than 4MB". So the working window was about
 *  655,360…1,040,000 pixels and that was it; a 2048×1536 mask weighed ~12 MB
 *  and the request was guaranteed to fail.
 *
 *  This is fixed-Huffman deflate with RLE matches. For a mask (huge uniform
 *  areas) it compresses hundreds of times. No dependencies.
 *
 *  A pure module: no require('photoshop'), tested in node via zlib.inflateSync.
 * ========================================================================== */

const pngI18n = require('./i18n.js');

/* ── CRC32 / bits ──────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function adler32(buf) {
    let s1 = 1, s2 = 0;
    for (let i = 0; i < buf.length; i++) {
        s1 = (s1 + buf[i]) % 65521;
        s2 = (s2 + s1) % 65521;
    }
    return ((s2 << 16) | s1) >>> 0;
}

function w32(a, o, v) {
    a[o] = (v >>> 24) & 255; a[o + 1] = (v >>> 16) & 255;
    a[o + 2] = (v >>> 8) & 255; a[o + 3] = v & 255;
}

/**
 * Bit writer for deflate.
 * The subtlety that is easy to get wrong: in deflate control bits are written
 * LSB-first, and Huffman codes MSB-first ("packed starting with the most
 * significant bit of the code"). That is why there are two methods.
 */
class BitWriter {
    constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
    /** Control fields: least significant bit first. */
    bits(value, count) {
        for (let i = 0; i < count; i++) {
            this.cur |= ((value >>> i) & 1) << this.n;
            if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
        }
    }
    /** Huffman code: most significant bit first. */
    code(value, count) {
        for (let i = count - 1; i >= 0; i--) {
            this.cur |= ((value >>> i) & 1) << this.n;
            if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
        }
    }
    align() { if (this.n) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; } }
    out() { this.align(); return Uint8Array.from(this.bytes); }
}

/* ── Fixed Huffman tables (RFC 1951, §3.2.5-3.2.6) ─────────────────────────── */

// Lengths 3..258 → code 257..285 + extra bits
const LEN_BASE  = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LEN_EXTRA = [0,0,0,0,0,0,0,0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4,  4,  5,  5,  5,  5,  0];
// Distances 1..32768 → code 0..29 + extra bits
const DIST_BASE  = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const DIST_EXTRA = [0,0,0,0,1,1,2, 2, 3, 3, 4, 4, 5, 5,  6,  6,  7,  7,  8,  8,   9,   9,  10,  10,  11,  11,  12,   12,   13,   13];

/** A literal in fixed Huffman. */
function putLiteral(bw, b) {
    if (b <= 143) bw.code(0x30 + b, 8);           // 00110000..10111111
    else          bw.code(0x190 + (b - 144), 9);  // 110010000..111111111
}

/** Length of a match. */
function putLength(bw, len) {
    let i = LEN_BASE.length - 1;
    while (LEN_BASE[i] > len) i--;
    const sym = 257 + i;
    if (sym <= 279) bw.code(sym - 256, 7);        // 0000001..0010111
    else            bw.code(0xC0 + (sym - 280), 8);
    if (LEN_EXTRA[i]) bw.bits(len - LEN_BASE[i], LEN_EXTRA[i]);
}

/** Largest distance a back-reference may use: the deflate window is 32 KiB. */
const MAX_DIST = 32768;

/** Match distance — in fixed Huffman, distance codes are exactly 5 bits. */
function putDistance(bw, dist) {
    // Not a silent degradation, an exception: past the window putDistance would
    // write a truncated number, and the stream would be invalid only for the
    // inflater — the error would surface at adler32, far from the cause.
    if (dist < 1 || dist > MAX_DIST) throw new Error(`deflate: distance ${dist} outside the window 1..${MAX_DIST}`);
    let i = DIST_BASE.length - 1;
    while (DIST_BASE[i] > dist) i--;
    bw.code(i, 5);
    if (DIST_EXTRA[i]) bw.bits(dist - DIST_BASE[i], DIST_EXTRA[i]);
}

/**
 * Deflate in fixed-Huffman mode with RLE matches.
 *
 * A deliberate limit: we look for repeats only at distance = 1 (the same byte)
 * and distance = rowStride (the same byte in the previous row). For a mask and
 * any image with uniform rows that is enough, and a full LZ77 with a hash
 * table would be extra risk of a bug. The data is always valid: the worst case
 * degenerates to literals, that is stored size plus control bits.
 *
 * @param {Uint8Array} data
 * @param {number} rowStride — row length in bytes including the filter byte
 */
function deflateRle(data, rowStride) {
    /* THE REGRESSION THIS CLOSES: a row wider than the deflate window (32 KiB)
       cannot refer to the previous row — the format forbids it, it is not our
       choice. We used to try anyway, putDistance wrote a truncated distance,
       and the PNG came out corrupt. In practice this showed up on panoramic
       canvases: a mask from 8192 px wide (RGBA) and input from 10923 px (RGB).
       For such rows only a match at distance 1 remains — for a mask with long
       uniform runs that is almost all of the compression. */
    const rowDist = (rowStride > 0 && rowStride <= MAX_DIST) ? rowStride : 0;

    const bw = new BitWriter();
    bw.bits(1, 1);   // BFINAL = 1
    bw.bits(1, 2);   // BTYPE = 01 (fixed Huffman)

    const n = data.length;
    let i = 0;
    while (i < n) {
        let bestLen = 0, bestDist = 0;

        // repeat of the same byte
        if (i > 0 && i + 3 <= n && data[i] === data[i - 1]) {
            let l = 0;
            while (l < 258 && i + l < n && data[i + l] === data[i - 1]) l++;
            if (l >= 3) { bestLen = l; bestDist = 1; }
        }
        // repeat of the row above — this is what compresses masks
        if (rowDist > 0 && i >= rowDist) {
            let l = 0;
            while (l < 258 && i + l < n && data[i + l] === data[i + l - rowDist]) l++;
            if (l >= 3 && l > bestLen) { bestLen = l; bestDist = rowDist; }
        }

        if (bestLen >= 3) {
            putLength(bw, bestLen);
            putDistance(bw, bestDist);
            i += bestLen;
        } else {
            putLiteral(bw, data[i]);
            i++;
        }
    }
    bw.code(0, 7);   // symbol 256 = end of block

    const body = bw.out();
    const out = new Uint8Array(2 + body.length + 4);
    out[0] = 0x78; out[1] = 0x01;            // zlib header (CMF/FLG, divisible by 31)
    out.set(body, 2);
    w32(out, 2 + body.length, adler32(data));
    return out;
}

/* ── PNG ───────────────────────────────────────────────────────────────────── */

function makeChunk(type, data) {
    const n = data.length;
    const out = new Uint8Array(12 + n);
    w32(out, 0, n);
    for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
    if (n) out.set(data, 8);
    const crcBuf = new Uint8Array(4 + n);
    for (let k = 0; k < 4; k++) crcBuf[k] = type.charCodeAt(k);
    if (n) crcBuf.set(data, 4);
    w32(out, 8 + n, crc32(crcBuf));
    return out;
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function concat(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

/**
 * Encodes a PNG from raw components.
 * @param {Uint8Array} pixels — chunky, `components` bytes per pixel
 * @param {number} components 1=Grey, 2=Grey+A, 3=RGB, 4=RGBA
 */
function encodePng(pixels, width, height, components) {
    const COLOR_TYPE = { 1: 0, 2: 4, 3: 2, 4: 6 };
    const colorType = COLOR_TYPE[components];
    if (colorType === undefined) throw new Error(pngI18n.t('png.components', { count: components }));

    const rowBytes = width * components;
    const stride   = rowBytes + 1;
    const raw = new Uint8Array(height * stride);
    for (let y = 0; y < height; y++) {
        raw[y * stride] = 0;                    // filter None: the RLE below catches rows anyway
        raw.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), y * stride + 1);
    }

    const ihdr = new Uint8Array(13);
    w32(ihdr, 0, width); w32(ihdr, 4, height);
    ihdr[8] = 8; ihdr[9] = colorType;           // bit depth 8

    return concat([
        Uint8Array.from(PNG_SIG),
        makeChunk('IHDR', ihdr),
        makeChunk('IDAT', deflateRle(raw, stride)),
        makeChunk('IEND', new Uint8Array(0)),
    ]);
}

/** Size from IHDR. The single source of truth for the provider response's pixels. */
function readPngSize(png) {
    if (png.length < 24) throw new Error(pngI18n.t('png.tooShort'));
    for (let i = 0; i < 8; i++) {
        if (png[i] !== PNG_SIG[i]) throw new Error(pngI18n.t('png.invalid'));
    }
    const rd = o => ((png[o] << 24) | (png[o + 1] << 16) | (png[o + 2] << 8) | png[o + 3]) >>> 0;
    return { w: rd(16), h: rd(20) };
}

/**
 * Writes resolution into the pHYs chunk.
 *
 * Why: Place Embedded scales content by docPPI/filePPI — documented behavior
 * "by design". A provider PNG has no pHYs chunk, so Photoshop treats it as
 * 72 ppi and in a 300 ppi document inflates it to 416.7%. Matching resolution
 * makes the factor 1, and the geometry correction becomes cosmetic.
 *
 * By spec pHYs appears once and BEFORE the first IDAT, so an existing one is overwritten.
 */
function setPngResolution(png, ppi) {
    const ppm = Math.max(1, Math.round(ppi * 39.3700787));   // 300 ppi → 11811 px/m
    const data = new Uint8Array(9);
    w32(data, 0, ppm); w32(data, 4, ppm); data[8] = 1;       // unit = 1 (metre)

    const rd = o => ((png[o] << 24) | (png[o + 1] << 16) | (png[o + 2] << 8) | png[o + 3]) >>> 0;
    let off = 8, insertAt = -1;
    while (off + 8 <= png.length) {
        const len  = rd(off);
        const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
        if (type === 'pHYs') {
            if (len !== 9) return png;                        // broken chunk — do not make it worse
            const out = png.slice();
            out.set(data, off + 8);
            w32(out, off + 8 + len, crc32(out.subarray(off + 4, off + 8 + len)));
            return out;
        }
        if (type === 'IHDR') insertAt = off + 12 + len;
        if (type === 'IDAT' || type === 'IEND') break;
        off += 12 + len;
    }
    if (insertAt < 0) return png;
    const chunk = makeChunk('pHYs', data);
    const out = new Uint8Array(png.length + chunk.length);
    out.set(png.subarray(0, insertAt), 0);
    out.set(chunk, insertAt);
    out.set(png.subarray(insertAt), insertAt + chunk.length);
    return out;
}

/**
 * Inpainting mask for a rectangular area.
 * OpenAI's convention: alpha = 0 (transparent) — "change here";
 * alpha = 255 (opaque) — "keep as context".
 *
 * Grey+Alpha (2 bytes/pixel) instead of RGBA — half the data into deflate,
 * and the provider does not read the grey channel anyway.
 *
 * feather is the gradient width IN PIXELS, symmetric around the edge
 * (feather/2 outside, feather/2 inside). A hard edge makes a visible seam:
 * the model paints up to the line, and a difference in grain or light reads as a scar.
 * A smooth transition forces it to blend with the context.
 *
 * Compression barely suffers from the gradient: RLE catches the rows, and the
 * non-uniform band is only around the perimeter.
 *
 * @param {{left,top,right,bottom}} rect — in mask coordinates, not document coordinates
 * @param {number} feather — 0 = hard edge
 */
/**
 * A box blur, separated by axis: three passes approximate a Gaussian, and it
 * stays O(n) — on a 1.3 MP mask that is milliseconds, while a true distance
 * to the contour would cost seconds in JS.
 */
function blurAxis(src, dst, w, h, r, vertical) {
    const outer = vertical ? w : h;
    const inner = vertical ? h : w;
    const step = vertical ? w : 1;
    const win = 2 * r + 1;
    for (let o = 0; o < outer; o++) {
        const base = vertical ? o : o * w;
        const at = i => src[base + Math.min(inner - 1, Math.max(0, i)) * step];
        let sum = 0;
        for (let i = -r; i <= r; i++) sum += at(i);
        for (let i = 0; i < inner; i++) {
            dst[base + i * step] = (sum / win) + 0.5;
            sum += at(i + r + 1) - at(i - r);
        }
    }
}

function boxBlur(src, w, h, radius) {
    const r = Math.max(1, Math.round(radius));
    const a = new Uint8Array(w * h);
    const b = new Uint8Array(w * h);
    a.set(src);
    // three box passes ≈ Gaussian; each split into two axes, O(n) overall
    for (let pass = 0; pass < 3; pass++) {
        blurAxis(a, b, w, h, r, false);
        blurAxis(b, a, w, h, r, true);
    }
    return a;
}

/**
 * Inpainting mask of an ARBITRARY shape — from the real selection, not its frame.
 *
 * WHY THIS EXISTS BESIDE buildRectMaskPng. Until 2026-09-09 the API always
 * received a rectangle, even though Photoshop knew the contour: the LAYER mask
 * was cut to the shape, the REQUEST mask was not. The consequence was measured
 * on the host: everything that shared a bounding box with the target, the model
 * was allowed to redraw, and a person whose head landed in a corner of the frame
 * had it erased. Also, real pixels inside the frame but outside the shape were
 * given to the model as "erase this" instead of "here is context".
 *
 * @param {Uint8Array} sel — w*h, 255 = "change here", 0 = "keep as context"
 * @param {number} feather — full transition width in pixels, symmetric around the contour
 */
function buildShapeMaskPng(width, height, sel, feather = 0) {
    if (!sel || sel.length !== width * height) {
        throw new Error(pngI18n.t('png.emptyMask'));
    }
    /* Three box passes give a visible transition about 3r wide, not r —
       so the radius is feather/3, otherwise an "edge of 16 px" would blur 48.
       And we clamp it to half the shorter side of the shape itself: a wider
       gradient would eat its core, and no fully transparent pixels would remain
       at all — the model would return the input unchanged. */
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (sel[y * width + x] > 127) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0) throw new Error(pngI18n.t('png.emptyMask'));
    const f = Math.min(feather, (maxX - minX) / 2, (maxY - minY) / 2);
    const soft = f >= 2 ? boxBlur(sel, width, height, f / 3) : sel;
    const px = new Uint8Array(width * height * 4);
    let editable = 0;
    for (let i = 0, o = 0; i < width * height; i++, o += 4) {
        const a = 255 - soft[i];            // alpha: 0 = change, 255 = keep
        if (a < 128) editable++;
        px[o] = px[o + 1] = px[o + 2] = a;  // RGB is cosmetic; the provider reads alpha
        px[o + 3] = a;
    }
    // An empty mask would mean "change nothing" — the model would return the input.
    if (!editable) throw new Error(pngI18n.t('png.emptyMask'));
    return encodePng(px, width, height, 4);
}

function buildRectMaskPng(width, height, rect, feather = 0) {
    const L = Math.max(0, Math.round(rect.left));
    const T = Math.max(0, Math.round(rect.top));
    const R = Math.min(width, Math.round(rect.right));
    const B = Math.min(height, Math.round(rect.bottom));
    if (R <= L || B <= T) throw new Error(pngI18n.t('png.emptyMask'));

    // a gradient wider than half the area would eat it entirely — then "change"
    // would not remain at all, and the model would return the input unchanged
    const f = Math.max(0, Math.min(feather, (R - L) / 2 - 1, (B - T) / 2 - 1));
    const half = f / 2;

    // RGBA, not "grey + alpha": the OpenAI documentation example is exactly that,
    // and the mask format should not be more exotic than necessary — alpha is the
    // only channel the provider reads, but color type 4 already cost us one investigation
    const px = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const dy = Math.min(y - T, B - 1 - y);
        let o = y * width * 4;
        for (let x = 0; x < width; x++, o += 4) {
            const dx = Math.min(x - L, R - 1 - x);
            const d = Math.min(dx, dy);              // >0 inside, <0 outside
            let a;
            if (f < 1) {
                a = d >= 0 ? 0 : 255;
            } else {
                let t = (d + half) / f;              // 0 at the outer edge of the band, 1 at the inner
                t = t < 0 ? 0 : t > 1 ? 1 : t;
                t = t * t * (3 - 2 * t);             // smoothstep — no kink at the band edges
                a = Math.round(255 * (1 - t));
            }
            px[o] = px[o + 1] = px[o + 2] = a;   // RGB: cosmetic, the provider does not read it
            px[o + 3] = a;                       // alpha: 0 = change, 255 = keep
        }
    }
    return encodePng(px, width, height, 4);
}

/* ── Response JPEG ───────────────────────────────────────────────────────────
 *
 * Gemini `generateContent` returns JPEG ONLY (measured 2026-10-08):
 * the `responseFormat.image.mimeType` enum accepts `IMAGE_JPEG` and rejects any
 * PNG name, and `imageConfig` has no format field at all. PNG cannot be
 * requested — so insertion must know a second format.
 *
 * Only what place.js needs is here: size (from SOF) and resolution (JFIF APP0,
 * the analogue of pHYs). Pixels are not decoded — Photoshop does that itself in placeEvent.
 */

const isJpeg = b => b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
const isPng = b => b.length > 8 && PNG_SIG.every((v, i) => b[i] === v);

/** Size from SOFn. Huffman tables (C4), JPG (C8) and arithmetic (CC) are not SOF. */
function readJpegSize(jpg) {
    let off = 2;
    while (off + 4 <= jpg.length) {
        if (jpg[off] !== 0xFF) break;
        const marker = jpg[off + 1];
        if (marker === 0xFF) { off++; continue; }            // padding between segments
        if (marker === 0xD9 || marker === 0xDA) break;       // EOI / start of scan
        const len = (jpg[off + 2] << 8) | jpg[off + 3];
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
            if (off + 9 > jpg.length) break;
            return { h: (jpg[off + 5] << 8) | jpg[off + 6], w: (jpg[off + 7] << 8) | jpg[off + 8] };
        }
        off += 2 + len;
    }
    throw new Error(pngI18n.t('png.invalid'));
}

/**
 * Writes resolution into JFIF APP0 — why, see setPngResolution.
 * Gemini puts APP0 immediately after SOI (300 dpi); if it is missing, we insert it.
 * JFIF density is 16-bit and integer: fractional ppi is rounded.
 */
function setJpegResolution(jpg, ppi) {
    const dpi = Math.min(65535, Math.max(1, Math.round(ppi)));
    const isJfif = jpg[2] === 0xFF && jpg[3] === 0xE0 &&
        String.fromCharCode(jpg[6], jpg[7], jpg[8], jpg[9], jpg[10]) === 'JFIF\0' &&
        ((jpg[4] << 8) | jpg[5]) >= 16;
    if (isJfif) {
        const out = jpg.slice();
        out[13] = 1;                                         // units: dots per inch
        out[14] = dpi >> 8; out[15] = dpi & 0xFF;
        out[16] = dpi >> 8; out[17] = dpi & 0xFF;
        return out;
    }
    const app0 = Uint8Array.from([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00,
        0x01, 0x01, 1, dpi >> 8, dpi & 0xFF, dpi >> 8, dpi & 0xFF, 0x00, 0x00]);
    return concat([jpg.subarray(0, 2), app0, jpg.subarray(2)]);
}

/**
 * Provider result → bytes for placeEvent. The format is detected from the bytes,
 * not from the response mimeType: the same bytes later sit in the cache and history
 * with no metadata.
 */
function prepareForPlace(bytes, ppi) {
    if (isPng(bytes)) {
        const out = setPngResolution(bytes, ppi);
        return { bytes: out, size: readPngSize(out), ext: 'png' };
    }
    if (isJpeg(bytes)) {
        const out = setJpegResolution(bytes, ppi);
        return { bytes: out, size: readJpegSize(out), ext: 'jpg' };
    }
    throw new Error(pngI18n.t('png.invalid'));
}

/** MIME from the first base64 bytes: `/9j/` is FF D8 FF, that is JPEG. */
const mimeOfB64 = b64 => (String(b64).startsWith('/9j/') ? 'image/jpeg' : 'image/png');

module.exports = {
    crc32, adler32, w32, makeChunk, deflateRle, MAX_DIST,
    encodePng, readPngSize, setPngResolution, buildRectMaskPng, buildShapeMaskPng, boxBlur,
    isJpeg, readJpegSize, setJpegResolution, prepareForPlace, mimeOfB64,
};
