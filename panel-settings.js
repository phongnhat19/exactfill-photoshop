/* ============================================================================
 *  panel-settings.js — what the panel currently has selected.
 *
 *  Split out of main.js (it was 1271 lines doing UI, orchestration, storage
 *  and statistics rendering at once). The only responsibility here is to turn
 *  localStorage plus control state into a request-settings object.
 *
 *  Why this was worth extracting instead of leaving it in place: this is where
 *  quality is coerced to what the model can do. A mistake here does not throw
 *  and is not visible in the panel — it simply arrives at the API as HTTP 400
 *  or, worse, as a silently more expensive request. As its own module it is
 *  tested in node, not in Photoshop.
 * ========================================================================== */

const { LS } = require('./storage-keys.js');
const providers = require('./providers/index.js');
const geometry = require('./geometry.js');

const $ = id => (typeof document === 'undefined' ? null : document.getElementById(id));

/** Integer from a control, clamped to bounds. An empty or broken control → def. */
const num = (id, def, lo, hi) => {
    const v = parseInt($(id)?.value ?? String(def), 10);
    return Math.max(lo, Math.min(hi, isNaN(v) ? def : v));
};
const checked = id => $(id)?.checked === true;

function currentProvider() {
    return providers.get(localStorage.getItem(LS.provider)) || providers.first();
}

/** Capabilities of the model that is selected right now. */
function currentCaps() {
    try {
        return currentProvider().capsFor(localStorage.getItem(LS.model)) || {};
    } catch (e) {
        return {};
    }
}

function allowedQualities() {
    const list = currentCaps().qualities;
    return (Array.isArray(list) && list.length)
        ? list : geometry.QUALITY_LADDER.concat('auto');
}

/**
 * The ONLY quality level for the whole panel — both the plan card and the
 * request. `readSettings` used to read localStorage directly, and a level the
 * new model does not offer would reach the API unchanged.
 *
 * The coerced result is deliberately NOT written back to localStorage: that
 * stores the user's preference, not what today's model can do. Because of
 * that, `max` comes back on its own as soon as it is available again.
 */
function currentQuality() {
    return geometry.coerceQuality(localStorage.getItem(LS.quality) || 'medium',
                                  allowedQualities());
}

function readSettings() {
    return {
        quality: currentQuality(),
        padPercent: num('context-pad', 15, 0, 50),
        feather: num('edge-feather', 16, 0, 256),
        layerOnly: checked('use-layer-only'),
        lossless: checked('lossless-input'),
        transparent: checked('transparent-bg'),
        ignorePixels: checked('ignore-pixels'),
        livePreview: checked('live-preview'),
    };
}

module.exports = {
    LS, num, checked,
    currentProvider, currentCaps, allowedQualities, currentQuality, readSettings,
};
