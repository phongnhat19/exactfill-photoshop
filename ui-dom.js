/* ============================================================================
 *  ui-dom.js — small bricks for building DOM by hand.
 *
 *  Why: the panel had five render functions (usage, references, presets,
 *  history, cache) repeating the same three-line pattern
 *  "createElement → className → textContent → appendChild" about forty times.
 *  A mistake in that pattern does not throw — it simply does not draw the row.
 *
 *  There is NO templating engine and no innerHTML of data: the panel shows
 *  arbitrary user text (prompts, preset names), and the only safe way to
 *  display it is textContent.
 *
 *  The module is loaded through require(), not through <script>, so its
 *  top-level names do not collide with the panel's shared scope.
 * ========================================================================== */

/** Element with a class and text. Empty className/text are simply not set. */
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
}

/** Removes children. Separate from fill(), because the empty state must work too. */
function clear(node) {
    if (node) node.innerHTML = '';
}

/**
 * Replaces a container's contents with a set of ready children.
 * A missing container is not an error: the section may have been removed from
 * the markup, and rendering must not take down the whole initialization.
 */
function fill(node, children) {
    if (!node) return;
    node.innerHTML = '';
    for (const child of children) if (child) node.appendChild(child);
    return node;
}

/**
 * The cross button the panel uses to delete everything: a reference, a preset,
 * a history entry, a cache entry. It was copied four times, and one copy lost
 * its title.
 */
function iconButton({ title, onClick, className = 'icon-btn', glyph = '✕' }) {
    const btn = el('button', className, glyph);
    btn.type = 'button';
    if (title) btn.title = title;
    // The glyph ✕ is a "multiplication sign" to a screen reader. Without
    // aria-label the button was announced that way, so the label is required,
    // not decoration.
    btn.setAttribute('aria-label', title || glyph);
    btn.addEventListener('click', onClick);
    return btn;
}

module.exports = { el, clear, fill, iconButton };
