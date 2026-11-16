/* ============================================================================
 *  storage-keys.js — the ONLY place localStorage keys are declared.
 *
 *  Why a separate file. Before it, `ai_provider` was a string literal in five
 *  files: main.js, auth.js, i18n.js, and six times in public-ui.js. Renaming
 *  the key in one place did NOT break the panel — it simply started reading a
 *  different key. What broke was the bug report: diagnostics showed
 *  "Provider: unknown", and the cause would have been the last place anyone
 *  looked. A classic silent mismatch this plugin has already hit (the same
 *  thing happened with presetManager.load() and with buildCommand).
 *
 *  The module is deliberately dependency-free: i18n.js, auth.js and
 *  public-ui.js all load it — anything is fine except a cycle.
 *
 *  The `ai_` prefix and the names stay as they are: users already have
 *  settings saved under these names, and renaming them would wipe that
 *  silently.
 * ========================================================================== */

const LS = {
    provider: 'ai_provider',
    model: 'ai_model',
    quality: 'ai_quality',
    prompt: 'ai_prompt',
    layerOnly: 'ai_layer_only',
    pad: 'ai_context_pad',
    feather: 'ai_edge_feather',
    lossless: 'ai_lossless',
    transparent: 'ai_transparent',
    ignorePixels: 'ai_ignore_pixels',
    preview: 'ai_live_preview',
    usage: 'ai_usage_ledger_v1',
    transport: 'ai_transport',
    cache: 'ai_result_cache_v1',
    locale: 'exactfill_locale',   // no ai_ prefix — already saved that way for users
};

/** Keys the plugin only REMOVES. Kept here so they are not reintroduced. */
const LEGACY = {
    sessionUsage: 'ai_session_usage',      // session ledger, replaced by LS.usage
    presets: 'googleAiPresets',            // fork leftover, kept because presets are saved
    history: 'nanobanana_prompt_history',  // same
};

/** secureStorage names. These are not localStorage keys and must not be copied there. */
const SECURE = {
    openrouter: 'openrouterApiKey',
};

module.exports = { LS, LEGACY, SECURE };
