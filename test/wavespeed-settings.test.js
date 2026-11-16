/* Settings for the WaveSpeed key, including the path that runs before a key exists. */

const assert = require('node:assert/strict');
const test = require('node:test');
const stub = require('./stubs/dom.js');

const env = stub.install();
const { doc } = env;
require('../auth.js');
require('../main.js');

const booted = (async () => {
    doc.fire('DOMContentLoaded');
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 5));
})();

const secrets = () => env.uxp.storage.secureStorage;
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5)); };

test('settings are reachable before a key exists and do not reveal a saved key', async () => {
    await booted;
    const auth = doc.getElementById('auth');
    const main = doc.getElementById('main');
    assert.equal(auth.classList.contains('hidden'), false);
    assert.equal(main.classList.contains('hidden'), true);

    doc.getElementById('open-settings').fire('click');
    await tick();
    const settings = doc.getElementById('settings');
    assert.equal(settings.classList.contains('hidden'), false);
    assert.equal(auth.classList.contains('hidden'), true);
    assert.equal(doc.activeElement && doc.activeElement.id, 'settings-key-input');
    assert.equal(doc.getElementById('settings-key-input').value, '');
    assert.match(doc.getElementById('settings-key-state').textContent, /No key is saved/);
    assert.equal(doc.getElementById('settings-key-page').dataset.url, 'https://wavespeed.ai/accesskey');
    assert.equal(doc.getElementById('settings-status').getAttribute('aria-live'), 'polite');
    assert.equal(doc.getElementById('settings-key-label').getAttribute('for'), 'settings-key-input');

    const input = doc.getElementById('settings-key-input');
    input.value = '  first-key  ';
    doc.getElementById('settings-save-key').fire('click');
    await tick();
    assert.equal(await secrets().getItem('wavespeedApiKey'), 'first-key');
    assert.equal(input.value, '');
    assert.equal(settings.classList.contains('hidden'), true);
    assert.equal(main.classList.contains('hidden'), false);

    doc.getElementById('open-settings').fire('click');
    await tick();
    assert.equal(doc.getElementById('settings-key-input').value, '');
    assert.match(doc.getElementById('settings-key-state').textContent, /A key is saved/);
    doc.getElementById('settings-key-input').value = 'typed-but-not-saved';
    doc.getElementById('settings-back').fire('click');
    await tick();
    assert.equal(await secrets().getItem('wavespeedApiKey'), 'first-key');
    assert.equal(doc.getElementById('settings-key-input').value, '');
    assert.equal(doc.activeElement && doc.activeElement.id, 'open-settings');

    doc.getElementById('open-settings').fire('click');
    await tick();
    doc.getElementById('settings-key-input').value = 'second-key';
    doc.getElementById('settings-toggle-key').fire('click');
    assert.equal(doc.getElementById('settings-key-input').getAttribute('type'), 'text');
    doc.getElementById('settings-save-key').fire('click');
    await tick();
    assert.equal(await secrets().getItem('wavespeedApiKey'), 'second-key');

    doc.getElementById('open-settings').fire('click');
    await tick();
    const save = secrets().setItem;
    secrets().setItem = async () => { throw new Error('disk full: third-key'); };
    doc.getElementById('settings-key-input').value = 'third-key';
    doc.getElementById('settings-save-key').fire('click');
    await tick();
    secrets().setItem = save;
    assert.equal(await secrets().getItem('wavespeedApiKey'), 'second-key');
    assert.match(doc.getElementById('settings-status').textContent, /Secure storage failed/);
    assert.doesNotMatch(doc.getElementById('settings-status').textContent, /third-key/);
    assert.doesNotMatch(doc.getElementById('settings-status').textContent, /^Key saved$/);

    doc.getElementById('settings-key-input').value = 'bad\u0000key';
    doc.getElementById('settings-save-key').fire('click');
    await tick();
    assert.equal(await secrets().getItem('wavespeedApiKey'), 'second-key');
    assert.match(doc.getElementById('settings-status').textContent, /unsupported characters/);

    doc.getElementById('settings-remove-key').fire('click');
    await tick();
    await assert.rejects(() => secrets().getItem('wavespeedApiKey'));
    assert.match(doc.getElementById('settings-key-state').textContent, /No key is saved/);

    doc.dispatchEvent(new CustomEvent('exactfill:busy', { detail: { busy: true } }));
    assert.equal(doc.getElementById('settings-save-key').disabled, true);
    assert.equal(doc.getElementById('open-settings').disabled, true);
    assert.equal(doc.getElementById('settings-back').disabled, true);
    doc.dispatchEvent(new CustomEvent('exactfill:busy', { detail: { busy: false } }));
    assert.equal(doc.getElementById('settings-save-key').disabled, false);
});

test('Send without an OpenRouter key opens Settings and does not store the secret in localStorage', async () => {
    await booted;
    doc.getElementById('settings-back').fire('click');
    await tick();
    env.photoshop.app.activeDocument = {
        id: 1, width: 200, height: 200,
        selection: { bounds: { left: 0, top: 0, right: 20, bottom: 20 }, solid: true },
    };
    const prompt = doc.getElementById('prompt-input');
    prompt.value = 'paint the door';
    doc.getElementById('talk-send').fire('click');
    await tick();
    assert.equal(doc.getElementById('settings').classList.contains('hidden'), false);
    assert.match(doc.getElementById('settings-status').textContent, /OpenRouter/);
    assert.match(doc.getElementById('settings-status').textContent, /Paste it here/);
    assert.equal(doc.activeElement && doc.activeElement.id, 'openrouter-key-input');

    doc.getElementById('openrouter-key-input').value = '  or-secret  ';
    doc.getElementById('openrouter-save-key').fire('click');
    await tick();
    assert.equal(await secrets().getItem('openrouterApiKey'), 'or-secret');
    for (let i = 0; i < localStorage.length; i++) {
        assert.notEqual(localStorage.getItem(localStorage.key(i)), 'or-secret');
    }
    assert.equal(doc.getElementById('openrouter-key-input').value, '');
    assert.match(doc.getElementById('openrouter-key-state').textContent, /OpenRouter key is saved/);
});
