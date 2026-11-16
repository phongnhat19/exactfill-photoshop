const assert = require('node:assert/strict');
const test = require('node:test');

const { isolateLayerTree } = require('../layer-tree.js');

const layer = (id, children) => ({ id, visible: true, ...(children ? { layers: children } : {}) });

test('isolates a nested active layer, keeping its ancestors', () => {
    const keep = layer(4);
    const sibling = layer(3);
    const group = layer(2, [sibling, keep]);
    const outside = layer(1);

    assert.equal(isolateLayerTree([outside, group], 4), true);
    assert.equal(outside.visible, false);
    assert.equal(group.visible, true);
    assert.equal(sibling.visible, false);
    assert.equal(keep.visible, true);
});

test('an active group leaves all of its own contents visible', () => {
    const child = layer(3);
    const group = layer(2, [child]);
    const outside = layer(1);

    assert.equal(isolateLayerTree([outside, group], 2), true);
    assert.equal(outside.visible, false);
    assert.equal(group.visible, true);
    assert.equal(child.visible, true);
});

test('reports when the active layer is not in the tree', () => {
    const layers = [layer(1), layer(2, [layer(3)])];
    assert.equal(isolateLayerTree(layers, 99), false);
    assert.deepEqual(layers.map(item => item.visible), [false, false]);
});
