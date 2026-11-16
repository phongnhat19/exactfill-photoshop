/* ============================================================================
 *  test/settings.test.js — panel-settings.js and the single source of storage keys.
 * ========================================================================== */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const stub = require('./stubs/dom.js');
const env = stub.install();
const { doc, store } = env;

const settings = require('../panel-settings.js');
const { LS, LEGACY } = require('../storage-keys.js');
const ROOT = path.join(__dirname, '..');

test('storage keys are declared in exactly one file', () => {
    /* WHY THIS MATTERS: 'ai_provider' was written as a literal in five files.
       Renaming it in one place did NOT break the panel — it simply read a different
       key — but it silently spoiled the diagnostics in a bug report ("Provider:
       unknown"). Divergences like that have already cost this plugin two
       investigations, so the gate stands on the literal. */
    const offenders = [];
    for (const file of fs.readdirSync(ROOT).filter(f => f.endsWith('.js'))) {
        if (file === 'storage-keys.js') continue;
        // comments do not count: naming a key in an explanation is not the same
        // as declaring it a second time, and stripping the mention from the text would be pointless
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        for (const m of src.matchAll(/'(ai_[a-z_0-9]+|googleAiPresets|nanobanana_[a-z_]+|exactfill_locale)'/g)) {
            offenders.push(`${file}: ${m[1]}`);
        }
    }
    assert.deepEqual(offenders, [],
        'a storage key is declared only in storage-keys.js; everything else takes it from there');
});

test('no key is declared twice under different names', () => {
    const values = [...Object.values(LS), ...Object.values(LEGACY)];
    assert.equal(new Set(values).size, values.length, `duplicate among: ${values}`);
});

test('quality is coerced to the model and is NEVER raised', () => {
    /* Matrix of "saved wish × model". Raising it here is not cosmetic:
       it is someone else's money, because xhigh/max cost more than high. */
    const cases = [
        ['gpt-image-2.5-sunburst', 'max',    'max'],
        ['gpt-image-2.5-flare',    'xhigh',  'xhigh'],
        ['gpt-image-2',            'max',    'high'],
        ['gpt-image-2',            'xhigh',  'high'],
        ['gpt-image-1',            'max',    'high'],
        ['gpt-image-1-mini',       'xhigh',  'high'],
        ['gpt-image-1.5',          'medium', 'medium'],
        ['gpt-image-2.5-sunburst', 'low',    'low'],
        ['no-such-model',       'max',    'high'],
    ];
    store.set(LS.provider, 'openai');
    for (const [model, saved, want] of cases) {
        store.set(LS.model, model);
        store.set(LS.quality, saved);
        assert.equal(settings.currentQuality(), want, `${model} + ${saved}`);
        assert.ok(settings.allowedQualities().includes(settings.currentQuality()),
            `${model}: the coerced level must be among the allowed ones`);
    }
    // the wish stays untouched — so max comes back on its own
    assert.equal(store.get(LS.quality), 'max', 'coercion must not overwrite the user\'s choice');
});

test('an unknown provider falls back to the first one instead of crashing the panel', () => {
    store.set(LS.provider, 'no-such-provider');
    assert.ok(settings.currentProvider().id, 'there must be some provider');
    assert.doesNotThrow(() => settings.currentCaps());
    store.set(LS.provider, 'openai');
});

test('numeric settings are clamped to the documented limits', () => {
    const pad = doc.getElementById('context-pad');
    const feather = doc.getElementById('edge-feather');
    for (const [value, wantPad] of [['-40', 0], ['999', 50], ['15', 15], ['not a number', 15], ['', 15]]) {
        pad.value = value;
        assert.equal(settings.readSettings().padPercent, wantPad, `context-pad="${value}"`);
    }
    for (const [value, wantFeather] of [['-1', 0], ['9999', 256], ['32', 32], ['', 16]]) {
        feather.value = value;
        assert.equal(settings.readSettings().feather, wantFeather, `edge-feather="${value}"`);
    }
});
