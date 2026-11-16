/* ============================================================================
 *  test/model-retired-boot.test.js — PANEL START AFTER A MODEL IS SHUT DOWN.
 *
 *  A separate file, because it needs a different clock and a different localStorage
 *  BEFORE require('../main.js'): node --test runs each file in its own process.
 *
 *  Scenario: the user worked on gpt-image-1-mini, updated the plugin, and opened
 *  the panel after 2026-12-01. Three things must happen, and the test sees each
 *  in the DOM, not in a function it would call itself (see "a test green on
 *  something that is not there in battle"): the selection moved to Flare, retired
 *  items are gone from the picker, and the status says what happened.
 * ========================================================================== */

const assert = require('node:assert/strict');
const test = require('node:test');
const stub = require('./stubs/dom.js');

const DEC_2 = Date.parse('2026-12-02T09:00:00Z');
Date.now = () => DEC_2;

const env = stub.install({ storage: { ai_provider: 'openai', ai_model: 'gpt-image-1-mini' } });
const { doc, store } = env;

const errors = [];
const realError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); realError(...a); };

require('../main.js');

const booted = (async () => {
    doc.fire('DOMContentLoaded');
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 5));
})();

test('a saved retired model moves to its replacement, not to list[0]', async () => {
    await booted;
    assert.deepEqual(errors, []);
    assert.equal(store.get('ai_model'), 'gpt-image-2.5-flare',
        'mini is the cheapest line; Sunburst (list[0]) would silently raise the bill');
});

test('retired models are not in the picker', async () => {
    await booted;
    const items = doc.getElementById('model-select').querySelectorAll('sp-menu-item')
        .map(c => c.getAttribute('value'));
    assert.deepEqual(items, ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2']);
});

test('the panel says the model was replaced', async () => {
    await booted;
    const status = doc.getElementById('status-text').textContent;
    assert.match(status, /gpt-image-1-mini/);
    assert.match(status, /GPT Image 2\.5 Flare/);
});

test('the shutdown hint does not stay on a model it does not apply to', async () => {
    await booted;
    // November: mini is still alive and has a hint with the date. The provider
    // switch rereads the list — the way the panel does.
    Date.now = () => Date.parse('2026-11-01T09:00:00Z');
    doc.getElementById('provider-select').fire('change', { target: { value: 'openai' } });
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5));
    const model = doc.getElementById('model-select');
    model.value = 'gpt-image-1-mini';
    model.fire('change', { target: { value: 'gpt-image-1-mini' } });
    assert.match(model.getAttribute('title') || '', /2026-12-01/, 'mini must have the shutdown date');

    model.value = 'gpt-image-2';
    model.fire('change', { target: { value: 'gpt-image-2' } });
    assert.equal(model.getAttribute('title'), null, 'gpt-image-2 has no hint — the old one must disappear');
});
