/* ============================================================================
 *  ledger.js — cost ledger on disk.
 *
 *  Why a separate file, not part of usage.js: usage.js is deliberately pure —
 *  "no Photoshop/DOM/localStorage" — which is why the pricing arithmetic can
 *  run in node. Moving localStorage into it would break that decision just to
 *  save one file. Storage lives here; the format and arithmetic stay there.
 *
 *  Split out of main.js: the panel should not know which key or shape the
 *  ledger uses.
 * ========================================================================== */

const ledgerKeys = require('./storage-keys.js').LS;
const usageTracker = require('./usage.js');

/**
 * Reads the ledger. A damaged ledger must NOT take down the panel: worse than
 * lost statistics is a panel that will not open because of them.
 */
function load() {
    try {
        const parsed = JSON.parse(localStorage.getItem(ledgerKeys.usage));
        // The object form leaves room for a future migration, but we also read
        // the early array form if it already landed in a local build.
        const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
        return usageTracker.prune(entries || []);
    } catch (e) {
        console.warn('[usage] ledger is damaged — starting empty:', e.message);
        return [];
    }
}

function save(entries) {
    const clean = usageTracker.prune(entries);
    localStorage.setItem(ledgerKeys.usage, JSON.stringify({ version: 1, entries: clean }));
    return clean;
}

/** Adds an entry and returns the updated ledger — the caller does the render. */
function record(meta, usage) {
    const entries = load();
    entries.unshift(usageTracker.createEntry(meta, usage));
    return save(entries);
}

const summarize = () => usageTracker.summarize(load());

module.exports = { load, save, record, summarize };
