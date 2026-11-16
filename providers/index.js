/* ============================================================================
 *  providers/index.js — provider registry. Deliberately thin.
 *
 *  The point of the layer: main.js knows nothing about OpenAI or Google.
 *  Adding a third provider means one file beside these plus one line here.
 *  That is why two separate plugins no longer need to exist.
 * ========================================================================== */

const openai = require('./openai.js');
const google = require('./google.js');

const ALL = [openai, google];

/** For filling the provider picker. */
function list() {
    return ALL.map(p => ({ id: p.id, label: p.label, supportsMask: p.supportsMask }));
}

function get(id) {
    return ALL.find(p => p.id === id) || null;
}

/** The first provider is the default when localStorage has nothing saved yet. */
function first() {
    return ALL[0];
}

module.exports = { list, get, first };
