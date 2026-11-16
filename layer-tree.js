'use strict';

/**
 * Leaves visible only the tree branch that contains the active layer.
 *
 * Visibility changes only on the document duplicate. Unlike deleting
 * top-level layers, this still works when the active layer is nested in a
 * group: the group and its ancestors stay visible, sibling branches do not.
 *
 * @returns {boolean} whether keepId was found in this branch
 */
function isolateLayerTree(layers, keepId) {
    let found = false;
    for (const layer of Array.from(layers || [])) {
        let inKeptBranch = layer.id === keepId;

        if (!inKeptBranch) {
            let children = [];
            try { children = layer.layers ? Array.from(layer.layers) : []; } catch (e) {}
            if (children.length) inKeptBranch = isolateLayerTree(children, keepId);
        }

        // This runs on the document copy. Do not swallow the error: cancelling
        // the capture is better than quietly sending the whole layout to the provider.
        layer.visible = inKeptBranch;
        if (inKeptBranch) found = true;
    }
    return found;
}

module.exports = { isolateLayerTree };
