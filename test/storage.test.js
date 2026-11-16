const assert = require('node:assert/strict');
const test = require('node:test');

function storage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: key => data.has(key) ? data.get(key) : null,
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: key => data.delete(key),
    };
}

test('corrupt history does not break the panel and accepts a new record', async () => {
    global.localStorage = storage({ nanobanana_prompt_history: '{"old":true}' });
    delete require.cache[require.resolve('../history.js')];
    const history = require('../history.js');
    await history.load();
    assert.deepEqual(history.getAll(), []);
    history.add({ prompt: 'test' });
    assert.equal(history.getAll().length, 1);
});

test('corrupt presets recover without a runtime error', async () => {
    global.localStorage = storage({ googleAiPresets: '42' });
    delete require.cache[require.resolve('../presets.js')];
    const presets = require('../presets.js');
    await presets.load();
    assert.ok(Array.isArray(presets.getAll()));
    presets.add('New', 'Text');
    assert.ok(presets.getAll().some(p => p.name === 'New'));
});

test('every stateful manager really loads during initialization', () => {
    // WHY A STATIC CHECK, NOT A UNIT: the tests above call load() THEMSELVES,
    // so they would pass even if the panel never called it. That is exactly what
    // happened: `presetManager.load()` was not in main.js at all, presets started
    // empty, and the very first add() overwrote what had been saved.
    const fs = require('node:fs');
    const path = require('node:path');
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

    for (const [mod, varName] of [['presets.js', 'presetManager'], ['history.js', 'historyManager']]) {
        const source = fs.readFileSync(path.join(__dirname, '..', mod), 'utf8');
        if (!/\basync load\s*\(/.test(source)) continue;   // nothing to check without load()
        assert.match(main, new RegExp(`await\\s+${varName}\\.load\\(\\)`),
            `${mod}: has load(), but main.js does not call it — state will not be restored`);
    }
});
