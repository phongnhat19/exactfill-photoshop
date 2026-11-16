/* ============================================================================
 *  JPEG responses: size and resolution for place.js.
 *
 *  Gemini `generateContent` returns only JPEG (measured 2026-10-08: the enum
 *  responseFormat.image.mimeType knows only IMAGE_JPEG). Until then place.js
 *  accepted only PNG and failed on `png.invalid` — so every Gemini generation
 *  that returned JPEG died after it had already been paid for.
 * ========================================================================== */

const assert = require('node:assert/strict');
const test = require('node:test');
const P = require('../png.js');

const seg = (marker, body) => Uint8Array.from([0xFF, marker, (body.length + 2) >> 8, (body.length + 2) & 0xFF, ...body]);
const jfif = dpi => seg(0xE0, [0x4A, 0x46, 0x49, 0x46, 0x00, 1, 1, 1, dpi >> 8, dpi & 0xFF, dpi >> 8, dpi & 0xFF, 0, 0]);
const sof0 = (w, h) => seg(0xC0, [8, h >> 8, h & 0xFF, w >> 8, w & 0xFF, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const join = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
};
const SOI = Uint8Array.from([0xFF, 0xD8]);
const EOI = Uint8Array.from([0xFF, 0xD9]);

/* The same segment sequence as in a real 2.1 response (8:1, 1K):
   APP0 JFIF 300 dpi → APP11 (C2PA/JUMBF) → DQT → SOF0 2928×352 → DHT → SOS. */
const geminiLike = () => join(SOI, jfif(300), seg(0xEB, new Array(40).fill(7)),
    seg(0xDB, new Array(65).fill(1)), sof0(2928, 352), seg(0xC4, new Array(29).fill(0)), EOI);

test('JPEG size is read from SOF, not from whichever segment comes first', () => {
    assert.deepEqual(P.readJpegSize(geminiLike()), { w: 2928, h: 352 });
});

test('document resolution rewrites the JFIF density in place', () => {
    const src = geminiLike();
    const out = P.setJpegResolution(src, 72);
    assert.equal(out.length, src.length, 'an existing APP0 is edited, not duplicated');
    assert.equal(out[13], 1, 'units are dpi');
    assert.equal((out[14] << 8) | out[15], 72);
    assert.equal((out[16] << 8) | out[17], 72);
    assert.equal((src[14] << 8) | src[15], 300, 'the input is not mutated — it still sits in the cache');
    assert.deepEqual(P.readJpegSize(out), { w: 2928, h: 352 });
});

test('a JPEG without APP0 gets a JFIF segment immediately after SOI', () => {
    const src = join(SOI, sof0(1024, 768), EOI);
    const out = P.setJpegResolution(src, 300.4);
    assert.equal(out.length, src.length + 18);
    assert.equal(String.fromCharCode(...out.subarray(6, 11)), 'JFIF\0');
    assert.equal((out[14] << 8) | out[15], 300, 'JFIF holds only integer dpi');
    assert.deepEqual(P.readJpegSize(out), { w: 1024, h: 768 });
});

test('prepareForPlace tells the format from the bytes and gives a file extension', () => {
    const jpg = P.prepareForPlace(geminiLike(), 300);
    assert.equal(jpg.ext, 'jpg');
    assert.deepEqual(jpg.size, { w: 2928, h: 352 });

    const png = P.prepareForPlace(P.encodePng(new Uint8Array(4 * 3 * 3), 4, 3, 3), 300);
    assert.equal(png.ext, 'png');
    assert.deepEqual(png.size, { w: 4, h: 3 });

    assert.throws(() => P.prepareForPlace(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 300));
});

test('preview and Refine label JPEG as JPEG', () => {
    const b64 = Buffer.from(geminiLike()).toString('base64');
    assert.ok(b64.startsWith('/9j/'));
    assert.equal(P.mimeOfB64(b64), 'image/jpeg');
    const png = Buffer.from(P.encodePng(new Uint8Array(3), 1, 1, 3)).toString('base64');
    assert.equal(P.mimeOfB64(png), 'image/png');
});
