/* ============================================================================
 *  geometry.js — all size and position arithmetic in one place.
 *
 *  Rule 1: round the EDGE, not the width.
 *      round(right) - round(left)   ← never shifts the left edge
 *      round(right - left)          ← shifts +1 px on an odd width
 *  The second form (main.js:581-582 of the old plugin) produced a deterministic
 *  down-right shift on every odd selection.
 *
 *  Rule 2: no percentages and no center. Position is always absolute.
 *
 *  A pure module: no require('photoshop'), tested in node.
 * ========================================================================== */

/** Unwraps {_unit,_value} from an ActionDescriptor, or returns a number as-is. */
const unwrap = n => (n && typeof n === 'object' && '_value' in n) ? n._value : n;

/**
 * Selection bounds → integer document pixels.
 * Rounds the four EDGES independently, so the width is the difference of
 * edges that are already integers. The left/top edge never shifts.
 */
function integerTarget(bounds) {
    const left   = Math.round(unwrap(bounds.left));
    const top    = Math.round(unwrap(bounds.top));
    const right  = Math.round(unwrap(bounds.right));
    const bottom = Math.round(unwrap(bounds.bottom));
    return { left, top, right, bottom, w: right - left, h: bottom - top };
}

/**
 * Radius for blending inside the layer mask.
 *
 * The user value is the full transition width. Photoshop feather spreads to
 * both sides of the current edge, so we first contract the selection by half
 * the width, then feather by that same radius. The outer edge of the gradient
 * then ends on the original selection boundary and cannot reach the physical
 * edge of the Smart Object.
 */
function insetBlendRadius(bounds, blendWidth) {
    const w = Math.max(0, unwrap(bounds.right) - unwrap(bounds.left));
    const h = Math.max(0, unwrap(bounds.bottom) - unwrap(bounds.top));
    const wanted = Math.max(0, Number(blendWidth) || 0) / 2;

    // After contract + feather an opaque core must remain. Otherwise a large
    // value on a small selection makes the whole result semi-transparent.
    const maxRadius = Math.max(0, Math.min(w, h) / 4 - 1);
    return Math.floor(Math.min(wanted, maxRadius, 500));
}

/**
 * Where to place the Smart Object frame.
 *   'exact' — exactly on the selection. The aspect matched within ASPECT_TOL,
 *             and the leftover unevenness is invisible (≤0.5%).
 *   'cover' — the native aspect is kept, the overflow hangs past the selection
 *             and is hidden by the layer mask. There are never empty bands.
 *
 * Replaces DISTORTION_THRESHOLD = 0.1 from the old plugin, which allowed 10%
 * of visible distortion — a square could become a noticeable rectangle.
 */
const ASPECT_TOL = 0.005;

function planFrame(target, nat) {
    const aspectErr = Math.abs((target.w / target.h) / (nat.w / nat.h) - 1);
    if (aspectErr <= ASPECT_TOL) {
        return {
            mode: 'exact',
            left: target.left, top: target.top,
            right: target.right, bottom: target.bottom,
        };
    }
    const s  = Math.max(target.w / nat.w, target.h / nat.h);
    const fw = Math.round(nat.w * s);
    const fh = Math.round(nat.h * s);
    // ONE rounding per axis, not two — otherwise the same error we were
    // escaping comes back.
    const left = target.left + Math.round((target.w - fw) / 2);
    const top  = target.top  + Math.round((target.h - fh) / 2);
    return { mode: 'cover', left, top, right: left + fw, bottom: top + fh };
}

/* ── Quality levels ────────────────────────────────────────────────────────── */

/**
 * Canonical ladder of levels by increasing cost. `auto` is deliberately off it:
 * it is not a level, it is "the provider decides".
 *
 * WHICH LEVELS EXIST is decided by the MODEL (caps.qualities), not the panel.
 * Only gpt-image-2.5 accepts `xhigh` and `max`; for gpt-image-1 that is HTTP 400
 * instead of an image.
 */
const QUALITY_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Coerces the saved level to what the current model accepts.
 *
 * ALWAYS DOWNWARD. If `max` was chosen on gpt-image-2.5 and the user switches
 * to gpt-image-1, we take `high` — the highest available, but not above the wish.
 * Raising the level would silently increase the bill on someone else's decision.
 */
function coerceQuality(saved, allowed) {
    const list = (Array.isArray(allowed) && allowed.length)
        ? allowed : QUALITY_LADDER.concat('auto');
    if (list.includes(saved)) return saved;
    for (let i = QUALITY_LADDER.indexOf(saved); i >= 0; i--) {
        if (list.includes(QUALITY_LADDER[i])) return QUALITY_LADDER[i];
    }
    return list.includes('auto') ? 'auto' : list[0];
}

/* ── Request size sent to the provider ─────────────────────────────────────── */

/**
 * Pixel budget by quality level. It controls PRICE and resolution, but NOT
 * geometry: the selection aspect is always kept. On quality='high' the old
 * plugin deliberately took the largest candidate from a fixed list
 * (preferLarge) — it broke the aspect for the sake of size. Here it is the opposite.
 */
const QUALITY_BUDGET = {
    low:    1_200_000,   // ≈1.2 MP — cheap, enough for small edits
    medium: 3_000_000,   // ≈3 MP
    high:   8_294_400,   // maximum for gpt-image-2/2.5 (8,294,400 px)
    // xhigh and max do NOT give more pixels: 'high' already hits the model's
    // own maxPx. On gpt-image-2.5 these levels buy more render effort at the
    // same resolution, and we pay in output tokens, not area.
    // That is why the plan card shows the same megapixels for high/xhigh/max —
    // that is true, not a calculation error.
    xhigh:  8_294_400,
    max:    8_294_400,
    auto:   3_000_000,
};

/**
 * Exact size for a model that accepts an arbitrary resolution (gpt-image-2).
 * Model limits arrive in caps; they are not hardcoded:
 *   step    — side multiple (16)
 *   maxEdge — maximum side (3840)
 *   minPx   — minimum pixel count (655,360)
 *   maxPx   — maximum pixel count (8,294,400)
 *   maxRatio— maximum aspect ratio (3)
 *
 * Returns 'WxH' or null if it cannot fit (the caller then falls back
 * to the fixed list via bestFixedSize).
 */
function exactSize(target, caps, quality = 'medium') {
    const step    = caps.step    || 16;
    const maxEdge = caps.maxEdge || 4096;
    const minPx   = caps.minPx   || 1;
    const maxPx   = caps.maxPx   || Infinity;
    if (target.w < 1 || target.h < 1) return null;

    const ratio = target.w / target.h;
    if (caps.maxRatio) {
        const r = Math.max(ratio, 1 / ratio);
        if (r > caps.maxRatio) return null;   // do not force the aspect — that is visible distortion
    }

    // Wanted area = selection area × quality multiplier, clamped between
    // the API minimum and the level budget.
    //
    // Why a MULTIPLIER, not just the selection area: generating with extra
    // pixels and scaling down to the frame is supersampling; it gives a cleaner
    // edge and finer detail. This used to be max(area, minPx) BEFORE the budget
    // clamp, and a 1000×600 selection (0.6 MP < minPx 655,360) made all three
    // quality levels produce the same 1120×672 — the slider was decorative.
    //
    // Why not "the whole budget on high": for a 40×40 selection that would ask
    // for 2880×2880 = 8.29 MP, money for pixels that are thrown away immediately.
    const AIM = { low: 1, medium: 2, high: 8, xhigh: 8, max: 8, auto: 2 };
    const aim = AIM[quality] ?? AIM.medium;
    const budget = Math.min(QUALITY_BUDGET[quality] ?? QUALITY_BUDGET.medium, maxPx);
    const wantPx = Math.max(minPx, Math.min(budget, target.w * target.h * aim));

    // Successive k adjustments spoil the aspect (the step multiple rounds
    // the sides differently), and exact degenerates into cover with overflow.
    // So we do not adjust, we SEARCH: 240 candidates for maxEdge=3840 is cheap.
    let best = null;
    for (let w = step; w <= maxEdge; w += step) {
        // nearest multiple of step that holds the aspect
        let h = Math.round((w / ratio) / step) * step;
        if (h < step) h = step;
        if (h > maxEdge) continue;
        const px = w * h;
        if (px < minPx || px > maxPx) continue;
        if (caps.maxRatio) {
            const r = Math.max(w / h, h / w);
            if (r > caps.maxRatio) continue;
        }
        const aspectErr = Math.abs((w / h) / ratio - 1);
        const pxErr     = Math.abs(px - wantPx) / wantPx;
        // Aspect matters more than area: an aspect error shows up as distortion,
        // an area error only as an extra resample.
        const score = aspectErr * 1000 + pxErr;
        if (!best || score < best.score) best = { w, h, score, aspectErr, px };
    }
    return best ? `${best.w}x${best.h}` : null;
}

/**
 * The closest aspect from a fixed list — for models that do not accept an
 * arbitrary resolution (gpt-image-1/1.5/mini).
 * It does NOT take "the largest" — it takes the closest aspect, because the
 * rest is finished by downscale on insert.
 */
function bestFixedSize(target, sizes) {
    if (!sizes || !sizes.length) return null;
    const ratio = target.w / target.h;
    let best = sizes[0], bestDiff = Infinity;
    for (const s of sizes) {
        const [sw, sh] = s.split('x').map(Number);
        const diff = Math.abs(ratio - sw / sh);
        if (diff < bestDiff) { bestDiff = diff; best = s; }
    }
    return best;
}

/**
 * The closest aspect ratio from a list of 'W:H' — for Gemini, which accepts
 * aspectRatio + imageSize, not pixels.
 */
function bestAspect(target, aspects) {
    if (!aspects || !aspects.length) return null;
    const ratio = target.w / target.h;
    let best = aspects[0], bestDiff = Infinity;
    for (const a of aspects) {
        const [aw, ah] = a.split(':').map(Number);
        const diff = Math.abs(ratio - aw / ah);
        if (diff < bestDiff) { bestDiff = diff; best = a; }
    }
    return best;
}

/**
 * The single place that decides what to ask the provider for.
 * Returns an object the provider puts into its payload as-is:
 *   { size: 'WxH', quality }                    — OpenAI
 *   { aspectRatio: 'W:H', imageSize: '2K' }     — Google
 */
function planRequest(caps, target, quality = 'medium') {
    if (caps.arbitrary) {
        const size = exactSize(target, caps, quality);
        if (size) return { size, quality };
        // did not fit — fall back to the same model's fixed list
    }
    if (caps.sizes) {
        return { size: bestFixedSize(target, caps.sizes), quality };
    }
    if (caps.aspects) {
        // 1K≈1 MP, 2K≈4 MP, 4K≈16 MP
        const px = { '512': 262_144, '1K': 1_048_576, '2K': 4_194_304, '4K': 16_777_216 };
        const order = (caps.imageSizes || ['1K']).slice()
            .sort((a, b) => (px[a] || 0) - (px[b] || 0));

        // This used to take the largest size that fits the quality budget. The
        // thresholds lined up badly: 1K = 1.05 MP, 2K = 4.19 MP, budgets 1.2 / 3 / 8.29 MP —
        // so low AND medium both produced 1K, and the slider was almost decorative.
        // Gemini levels are discrete, so we pick them by position, not by arithmetic.
        const idx = { low: 0, medium: 1, high: order.length - 1,
                      xhigh: order.length - 1, max: order.length - 1, auto: 1 };
        let i = Math.min(idx[quality] ?? 1, order.length - 1);

        // But do not ask for absurdly more than the area itself: for a 200×200
        // selection, "high quality" would otherwise order 4K = 16 MP that is thrown away immediately.
        const ceiling = target.w * target.h * 8;
        while (i > 0 && (px[order[i]] || 0) > ceiling) i--;

        return { aspectRatio: bestAspect(target, caps.aspects), imageSize: order[i] };
    }
    return { quality };
}

module.exports = {
    unwrap,
    QUALITY_LADDER,
    coerceQuality,
    integerTarget,
    insetBlendRadius,
    planFrame,
    exactSize,
    bestFixedSize,
    bestAspect,
    planRequest,
    ASPECT_TOL,
    QUALITY_BUDGET,
};
