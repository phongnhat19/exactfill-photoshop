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
const secureStore = storage.secureStorage;
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
};

/** Which key the panel cares about right now — depends on the selected provider. */
function activeKeyName() {
    const providers = require('./providers/index.js');
    const id = localStorage.getItem(authKeys.provider) || providers.first().id;
    const p = providers.get(id) || providers.first();
    return p.keyName;
}

async function refreshAuthUI() {
    const keyName = activeKeyName();
    const ok = await hasKey(keyName);

    const auth = document.getElementById('auth');
    const main = document.getElementById('main');
    const signout = document.getElementById('signout');
    if (auth) auth.classList.toggle('hidden', ok);
    if (main) main.classList.toggle('hidden', !ok);
    if (signout) {
        signout.classList.toggle('hidden', !ok);
        signout.textContent = authI18n.t('auth.change');
    }

    const providers = require('./providers/index.js');
    const p = providers.get(localStorage.getItem(authKeys.provider)) || providers.first();
    const label = document.getElementById('auth-provider-label');
    if (label) label.textContent = p.label;
    const link = document.getElementById('open-key-page');
    if (link) link.dataset.url = p.keyPage || KEY_LINKS[keyName] || '';
}

async function submitAuth() {
    const input = document.getElementById('api-key-input');
    const value = input && input.value && input.value.trim();
    if (!value) return;
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
        console.error('[auth] key was not saved:', e && e.message);
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

document.addEventListener('DOMContentLoaded', () => {
    refreshAuthUI();

    const signout = document.getElementById('signout');
    if (signout) signout.addEventListener('click', toggleAuthEdit);

    const submit = document.getElementById('submit-auth');
    if (submit) submit.addEventListener('click', submitAuth);

    const link = document.getElementById('open-key-page');
    if (link) {
        link.addEventListener('click', async e => {
            e.preventDefault();
            const url = link.dataset.url;
            if (!url) return;
            try {
                await shell.openExternal(url, authI18n.t('auth.openConsent'));
            } catch (err) {
                console.error('[auth] link did not open:', err && err.message);
                const status = document.getElementById('auth-status');
                if (status) status.textContent = authI18n.t('auth.openError', {
                    error: err && err.message ? err.message : err,
                });
            }
        });
    }
});

document.addEventListener('exactfill:localechange', () => refreshAuthUI());

// main.js calls refreshAuthUI when the provider changes — the panel must
// switch to the matching key
window.aiAuth = { getKey, setKey, hasKey, refreshAuthUI, activeKeyName };
