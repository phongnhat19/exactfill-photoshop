/* ============================================================================
 *  auth.js — API keys, one per provider.
 *
 *  The old auth.js knew exactly one key ('openAiApiKey') and was hard-wired
 *  to the UI. Now that there are two providers, the key is a parameter.
 *
 *  secureStorage is isolated per plugin id, so keys from the old plugins do
 *  not move here — they have to be entered again. That is not a bug; it is
 *  how UXP works.
 * ========================================================================== */

const { shell, storage } = require('uxp');
const authKeys = require('./storage-keys.js').LS;
const OPENROUTER_KEY = require('./storage-keys.js').SECURE.openrouter;
const secureStore = storage.secureStorage;
const OPENROUTER_PAGE = 'https://openrouter.ai/keys';
const authI18n = require('./i18n.js');

/**
 * secureStorage returns the key as a Uint8Array, not a string — hence
 * String.fromCharCode. Do it in chunks: apply on a large array overflows the stack.
 */
async function getKey(keyName) {
    try {
        const raw = await secureStore.getItem(keyName);
        if (!raw) return null;
        if (typeof raw === 'string') return raw;
        let s = '';
        const CHUNK = 4096;
        for (let i = 0; i < raw.length; i += CHUNK) {
            s += String.fromCharCode.apply(null, raw.subarray(i, Math.min(i + CHUNK, raw.length)));
        }
        return s || null;
    } catch (e) {
        // "not found" in secureStorage is thrown, not returned as null
        return null;
    }
}

async function setKey(keyName, value) {
    await secureStore.setItem(keyName, value);
}

async function hasKey(keyName) {
    return !!(await getKey(keyName));
}

/* ── UI ────────────────────────────────────────────────────────────────────── */

/* The key-page URL lives ON THE PROVIDER (providers/*.js keyPage) — so adding
   a third provider does not require editing this file too. This is only a
   fallback for when that field is empty. */
const KEY_LINKS = {
    openAiApiKey: 'https://platform.openai.com/api-keys',
    googleApiKey: 'https://aistudio.google.com/apikey',
    wavespeedApiKey: 'https://wavespeed.ai/accesskey',
};

function selectedProvider() {
    const providers = require('./providers/index.js');
    const id = localStorage.getItem(authKeys.provider) || providers.first().id;
    return providers.get(id) || providers.first();
}

/** Which key the panel cares about right now — depends on the selected provider. */
function activeKeyName() {
    return selectedProvider().keyName;
}

async function removeKey(keyName) {
    await secureStore.removeItem(keyName);
}

function keyProblem(value) {
    const trimmed = String(value == null ? '' : value).trim();
    if (!trimmed) return { ok: false, code: 'empty' };
    if (/[\u0000-\u001F\u007F]/.test(trimmed)) return { ok: false, code: 'control' };
    return { ok: true, value: trimmed };
}

function settingsOpen() {
    const settings = document.getElementById('settings');
    return !!(settings && !settings.classList.contains('hidden'));
}

async function paintKeyState() {
    const p = selectedProvider();
    const saved = await hasKey(p.keyName);
    const label = document.getElementById('settings-key-label');
    if (label) label.textContent = authI18n.t('settings.keyLabel', { provider: p.label });
    const state = document.getElementById('settings-key-state');
    if (state) state.textContent = saved ? authI18n.t('settings.saved') : authI18n.t('settings.missing');
    const page = p.keyPage || KEY_LINKS[p.keyName] || '';
    const link = document.getElementById('settings-key-page');
    if (link) link.dataset.url = page;
    const routerSaved = await hasKey(OPENROUTER_KEY);
    const routerState = document.getElementById('openrouter-key-state');
    if (routerState) {
        routerState.textContent = authI18n.t(routerSaved ? 'settings.openrouterSaved' : 'settings.openrouterMissing');
    }
    const routerLink = document.getElementById('openrouter-key-page');
    if (routerLink) routerLink.dataset.url = OPENROUTER_PAGE;
    return saved;
}

function clearNamedKey(inputId, toggleId) {
    const input = document.getElementById(inputId);
    if (input) input.value = '';
    setNamedVisible(inputId, toggleId, false);
}

function clearKeyField() {
    clearNamedKey('settings-key-input', 'settings-toggle-key');
    clearNamedKey('openrouter-key-input', 'openrouter-toggle-key');
}

function setNamedVisible(inputId, toggleId, show) {
    const input = document.getElementById(inputId);
    const toggle = document.getElementById(toggleId);
    if (input) {
        const type = show ? 'text' : 'password';
        input.setAttribute('type', type);
        input.type = type;
    }
    if (toggle) toggle.textContent = authI18n.t(show ? 'settings.hide' : 'settings.show');
}

function setKeyVisible(show) {
    setNamedVisible('settings-key-input', 'settings-toggle-key', show);
}

function focusEl(id) {
    const el = document.getElementById(id);
    if (el && typeof el.focus === 'function') el.focus();
    return el;
}

async function openSettings(message, focusId) {
    const settings = document.getElementById('settings');
    const auth = document.getElementById('auth');
    const main = document.getElementById('main');
    if (auth) auth.classList.add('hidden');
    if (main) main.classList.add('hidden');
    if (settings) settings.classList.remove('hidden');
    clearKeyField();
    await paintKeyState();
    const status = document.getElementById('settings-status');
    if (status) status.textContent = message || '';
    focusEl(focusId || 'settings-key-input') || focusEl('settings-heading');
}

async function closeSettings() {
    const settings = document.getElementById('settings');
    if (settings) settings.classList.add('hidden');
    clearKeyField();
    const status = document.getElementById('settings-status');
    if (status) status.textContent = '';
    await refreshAuthUI();
    focusEl('open-settings');
}

function setSettingsLocked(on) {
    for (const id of ['open-settings', 'settings-back', 'settings-save-key', 'settings-remove-key',
                      'settings-toggle-key', 'settings-key-input', 'openrouter-save-key',
                      'openrouter-remove-key', 'openrouter-toggle-key', 'openrouter-key-input',
                      'submit-auth', 'api-key-input', 'signout']) {
        const el = document.getElementById(id);
        if (el) el.disabled = !!on;
    }
}

async function refreshAuthUI() {
    const keyName = activeKeyName();
    const ok = await hasKey(keyName);
    await paintKeyState();
    if (settingsOpen()) return;

    const auth = document.getElementById('auth');
    const main = document.getElementById('main');
    const signout = document.getElementById('signout');
    if (auth) auth.classList.toggle('hidden', ok);
    if (main) main.classList.toggle('hidden', !ok);
    if (signout) {
        signout.classList.toggle('hidden', !ok);
        signout.textContent = authI18n.t('auth.change');
    }

    const p = selectedProvider();
    const label = document.getElementById('auth-provider-label');
    if (label) label.textContent = p.label;
    const link = document.getElementById('open-key-page');
    if (link) link.dataset.url = p.keyPage || KEY_LINKS[keyName] || '';
}

async function submitAuth() {
    const input = document.getElementById('api-key-input');
    const parsed = keyProblem(input && input.value);
    if (!parsed.ok) return;
    const value = parsed.value;
    try {
        await setKey(activeKeyName(), value);
        if (input) input.value = '';
        await refreshAuthUI();
        /* The model list depends on the KEY: availability is asked from
           /v1/models. Without this event a freshly entered key started filtering
           the picker only after the panel was reopened — so the user saw
           models they do not have and got a 404 instead of an explanation. */
        if (typeof document !== 'undefined' && typeof Event !== 'undefined') {
            document.dispatchEvent(new Event('exactfill:keychange'));
        }
    } catch (e) {
        console.error('[auth] key was not saved');
        const status = document.getElementById('auth-status');
        if (status) status.textContent = authI18n.t('auth.saveError', {
            error: e && e.message ? e.message : e,
        });
    }
}

async function toggleAuthEdit() {
    const auth = document.getElementById('auth');
    const main = document.getElementById('main');
    const btn = document.getElementById('signout');
    if (!auth || !main || !btn) return;

    const editing = !auth.classList.contains('hidden');
    if (editing) {
        await refreshAuthUI();                 // "Keep" — just restore the previous state
    } else {
        main.classList.add('hidden');
        auth.classList.remove('hidden');
        btn.textContent = authI18n.t('auth.keep');
        const input = document.getElementById('api-key-input');
        if (input) input.value = '';
    }
}

async function saveNamedKey(keyName, inputId, toggleId) {
    const input = document.getElementById(inputId);
    const status = document.getElementById('settings-status');
    const parsed = keyProblem(input && input.value);
    if (!parsed.ok) {
        if (status) status.textContent = authI18n.t(parsed.code === 'control'
            ? 'settings.controlChars' : 'settings.empty');
        return false;
    }
    const previous = await getKey(keyName);
    try {
        await setKey(keyName, parsed.value);
        clearNamedKey(inputId, toggleId);
        if (status) status.textContent = authI18n.t('settings.savedOk');
        await paintKeyState();
        return true;
    } catch (e) {
        console.error('[auth] key was not saved');
        if (status) status.textContent = `${authI18n.t('auth.saveError', {
            error: 'Secure storage failed',
        })} ${authI18n.t('settings.unchanged')}`;
        const still = await getKey(keyName);
        if (previous && still !== previous) {
            try { await setKey(keyName, previous); } catch (err) {}
        }
        return false;
    }
}

async function removeNamedKey(keyName, inputId, toggleId) {
    const status = document.getElementById('settings-status');
    if (!(await hasKey(keyName))) {
        clearNamedKey(inputId, toggleId);
        if (status) status.textContent = authI18n.t('settings.missing');
        await paintKeyState();
        return;
    }
    try {
        await removeKey(keyName);
        clearNamedKey(inputId, toggleId);
        if (status) status.textContent = authI18n.t('settings.removed');
        await paintKeyState();
    } catch (e) {
        console.error('[auth] key was not removed');
        if (status) status.textContent = authI18n.t('settings.removeError', {
            error: 'Secure storage failed',
        });
    }
}

async function saveSettingsKey() {
    const saved = await saveNamedKey(activeKeyName(), 'settings-key-input', 'settings-toggle-key');
    if (!saved) return;
    if (typeof document !== 'undefined' && typeof Event !== 'undefined') {
        document.dispatchEvent(new Event('exactfill:keychange'));
    }
    const settings = document.getElementById('settings');
    if (settings) settings.classList.add('hidden');
    await refreshAuthUI();
}

async function removeSettingsKey() {
    const name = activeKeyName();
    await removeNamedKey(name, 'settings-key-input', 'settings-toggle-key');
    if (!(await hasKey(name)) && typeof document !== 'undefined' && typeof Event !== 'undefined') {
        document.dispatchEvent(new Event('exactfill:keychange'));
    }
}

function bindAuthUi() {
    if (bindAuthUi.done) return;
    bindAuthUi.done = true;
    refreshAuthUI();

    const signout = document.getElementById('signout');
    if (signout) signout.addEventListener('click', toggleAuthEdit);

    const submit = document.getElementById('submit-auth');
    if (submit) submit.addEventListener('click', submitAuth);

    const open = document.getElementById('open-settings');
    if (open) open.addEventListener('click', () => openSettings(''));
    const back = document.getElementById('settings-back');
    if (back) back.addEventListener('click', () => closeSettings());
    const save = document.getElementById('settings-save-key');
    if (save) save.addEventListener('click', () => saveSettingsKey());
    const remove = document.getElementById('settings-remove-key');
    if (remove) remove.addEventListener('click', () => removeSettingsKey());
    const toggle = document.getElementById('settings-toggle-key');
    if (toggle) toggle.addEventListener('click', () => {
        const input = document.getElementById('settings-key-input');
        const hidden = !input || input.getAttribute('type') !== 'text';
        setKeyVisible(hidden);
    });
    const settingsLink = document.getElementById('settings-key-page');
    if (settingsLink) settingsLink.addEventListener('click', e => openKeyPage(e, settingsLink));
    const routerSave = document.getElementById('openrouter-save-key');
    if (routerSave) routerSave.addEventListener('click', () => saveNamedKey(
        OPENROUTER_KEY, 'openrouter-key-input', 'openrouter-toggle-key'));
    const routerRemove = document.getElementById('openrouter-remove-key');
    if (routerRemove) routerRemove.addEventListener('click', () => removeNamedKey(
        OPENROUTER_KEY, 'openrouter-key-input', 'openrouter-toggle-key'));
    const routerToggle = document.getElementById('openrouter-toggle-key');
    if (routerToggle) routerToggle.addEventListener('click', () => {
        const input = document.getElementById('openrouter-key-input');
        const hidden = !input || input.getAttribute('type') !== 'text';
        setNamedVisible('openrouter-key-input', 'openrouter-toggle-key', hidden);
    });
    const routerLink = document.getElementById('openrouter-key-page');
    if (routerLink) routerLink.addEventListener('click', e => openKeyPage(e, routerLink));

    document.addEventListener('exactfill:busy', e => {
        setSettingsLocked(e && e.detail && e.detail.busy);
    });

    const link = document.getElementById('open-key-page');
    if (link) link.addEventListener('click', e => openKeyPage(e, link));
}

async function openKeyPage(e, link) {
    e.preventDefault();
    const url = link.dataset.url;
    if (!url) return;
    try {
        await shell.openExternal(url, authI18n.t('auth.openConsent'));
    } catch (err) {
        console.error('[auth] link did not open:', err && err.message);
        const status = document.getElementById(settingsOpen() ? 'settings-status' : 'auth-status');
        if (status) status.textContent = authI18n.t('auth.openError', {
            error: err && err.message ? err.message : err,
        });
    }
}

document.addEventListener('DOMContentLoaded', bindAuthUi);
if (typeof document !== 'undefined' && document.getElementById('open-settings')) bindAuthUi();

document.addEventListener('exactfill:localechange', () => refreshAuthUI());

// main.js calls refreshAuthUI when the provider changes — the panel must
// switch to the matching key
window.aiAuth = {
    getKey, setKey, hasKey, removeKey, refreshAuthUI, activeKeyName, openSettings, setSettingsLocked,
};
