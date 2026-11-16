/* ============================================================================
 *  main.js — selection → Vietnamese edit conversation → provider → Smart Object.
 *
 *  There is NO geometry here (geometry.js), NO pixel work (capture.js),
 *  NO insertion (place.js) and NO knowledge of providers (providers/).
 *  The old main.js had 2797 lines, of which ~850 served this flow.
 *
 *  There are deliberately no variations here. They inserted N layers on top of
 *  each other with the same mask: you paid for four and had to compare them by
 *  clicking visibility in the Layers panel. Instead: Regenerate (the same area,
 *  without a new selection) and a result cache (reinsertion is free).
 * ========================================================================== */

const { app, core, action } = require('photoshop');
const { batchPlay } = require('photoshop').action;
const uxpStorage = require('uxp').storage;

const providers = require('./providers/index.js');
const openrouter = require('./providers/openrouter.js');
const conversation = require('./conversation.js');
const geometry   = require('./geometry.js');
const place      = require('./place.js');
const capture    = require('./capture.js');
const cache      = require('./cache.js');
const presetManager  = require('./presets.js');
const historyManager = require('./history.js');
const usageTracker   = require('./usage.js');
const ledger         = require('./ledger.js');
const dom            = require('./ui-dom.js');
const mainI18n       = require('./i18n.js');
const { mimeOfB64 } = require('./png.js');

/* Storage keys and settings reads live separately: the first so there are not
   five copies of the string 'ai_provider' across files, the second so coercing
   quality to what the model can do can be tested in node, not only in Photoshop. */
const { LEGACY, SECURE } = require('./storage-keys.js');
const {
    LS, num, checked,
    currentProvider, currentCaps, allowedQualities, currentQuality, readSettings,
} = require('./panel-settings.js');

const $ = id => document.getElementById(id);
const TRANSPORTS = ['auto', 'direct', 'curl'];
const httpTransport = require('./providers/http.js').transport;

let busy = false;
let abortCtrl = null;
let talkFlight = 0;
const talkSession = conversation.createSession();
let references = [];        // [{ name, blob }]
let lastRun = null;         // { prompt, provider, model, ctx, target, ... }
let modelRefreshSeq = 0;    // guards against races when the provider changes quickly

/* ── Selection ─────────────────────────────────────────────────────────────── */

/**
 * Selection bounds WITHOUT imaging.getSelection.
 * Reason: getSelection/getData() crashes Photoshop on a CMYK document, and we
 * only need four numbers. doc.selection.bounds provides them (PS 25.0+);
 * for older hosts, the same descriptor via batchPlay.
 */
async function readSelectionBounds(doc) {
    try {
        const sel = doc.selection;
        if (sel && sel.bounds) {
            return { bounds: sel.bounds, solid: sel.solid !== false };
        }
    } catch (e) { /* fall through to batchPlay */ }

    const r = await batchPlay([{
        _obj: 'get',
        _target: [{ _property: 'selection' }, { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
    }], {});
    const s = r && r[0] && r[0].selection;
    if (!s) return null;
    const v = x => (x && typeof x === 'object' && '_value' in x) ? x._value : x;
    if (v(s.left) === undefined) return null;
    return {
        bounds: { left: v(s.left), top: v(s.top), right: v(s.right), bottom: v(s.bottom) },
        solid: true,   // batchPlay cannot tell the shape — treat it as a rectangle
    };
}

/** Expands the target area with context and clamps it to the canvas. */
function expandForContext(target, doc, padPercent) {
    if (!padPercent) return { ...target };
    /* The percent is computed ON EACH AXIS SEPARATELY. This used to be one pad
       from the longer side — and on a 1011×423 strip "15%" meant +30% of the width
       but +72% of the height, and asymmetric after clamping to the canvas (measured
       2026-09-09: ctx 1315×611 instead of the expected 1315×549). The user saw a
       frame twice as large as they asked for in the card, and paid for it. */
    const padX = Math.round(target.w * (padPercent / 100));
    const padY = Math.round(target.h * (padPercent / 100));
    const left   = Math.max(0, target.left - padX);
    const top    = Math.max(0, target.top - padY);
    const right  = Math.min(doc.width, target.right + padX);
    const bottom = Math.min(doc.height, target.bottom + padY);
    return { left, top, right, bottom, w: right - left, h: bottom - top };
}

/* ── UI ────────────────────────────────────────────────────────────────────── */

function setStatus(text) {
    const el = $('status-text');
    if (el) {
        el.textContent = text || '';
        el.classList.toggle('has-content', Boolean(text));
    }
}

function setBusy(on) {
    busy = on;
    const btn = $('talk-send');
    if (btn) {
        btn.disabled = on;                 // double-click guard — the old code did not have one
        btn.setAttribute('aria-busy', on ? 'true' : 'false');
    }
    const regen = $('regen-btn');
    if (regen) regen.disabled = on || !lastRun;
    const refine = $('refine-btn');
    // Refine needs not only a previous run but a provider that can hold a
    // conversation: Gemini has no such route, and the button must show that.
    if (refine) {
        refine.disabled = on || !canRefine();
        /* The conversation turn is visible only here. The difference between the
           first turn (pixels go) and a continuation (an id goes) is a different
           price and different model behavior, so it must be written, not guessed. */
        const turn = !canRefine() ? ''
            : lastRun.responseId
                ? mainI18n.t('plan.refineTurn', { number: (lastRun.turn || 1) + 1 })
                : mainI18n.t('plan.refineFirst');
        refine.setAttribute('title', turn
            ? `${mainI18n.t('action.refineTitle')} — ${mainI18n.t('plan.refine', { turn })}`
            : mainI18n.t('action.refineTitle'));
    }
    const cancel = $('cancel-btn');
    if (cancel) cancel.classList.toggle('hidden', !on);
    const sp = $('spinner');
    if (sp) sp.classList.toggle('hidden', !on);
    if (window.aiAuth && typeof window.aiAuth.setSettingsLocked === 'function') {
        window.aiAuth.setSettingsLocked(on);
    }
}

function showPreview(b64) {
    const wrap = $('preview-wrap'), img = $('preview-img');
    if (!wrap || !img) return;
    if (!b64) { wrap.classList.add('hidden'); img.removeAttribute('src'); return; }
    img.src = `data:${mimeOfB64(b64)};base64,` + b64;
    wrap.classList.remove('hidden');
}

/**
 * A count badge next to a section heading.
 * NOT via CSS `.badge:empty` — UXP does not support that pseudo-class, and an
 * empty badge drew as a blue dot next to every section.
 */
function setBadge(id, text) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
}

/**
 * Prompt character counter.
 *
 * WHY IT EXISTS AT ALL: a UXP field without an explicit `maxlength` silently
 * stops accepting input at about 256 characters — no error, no truncated tail.
 * The limit in the markup removes that ceiling, and the counter makes the new
 * limit visible, so the story "the text simply stopped being typed" does not
 * repeat with a different number. A 60% threshold keeps the panel clean in ordinary use.
 */
function updateCharCount(inputId, counterId, showFrom = 0.6) {
    const el = $(inputId), out = $(counterId);
    if (!el || !out) return;
    const limit = Number(el.getAttribute('maxlength')) || 0;
    const used = String(el.value || '').length;
    if (!limit || used < limit * showFrom) {
        out.classList.add('hidden');
        return;
    }
    out.textContent = `${used} / ${limit}`;
    out.classList.remove('hidden');
    out.classList.toggle('near', used >= limit * 0.9 && used < limit);
    out.classList.toggle('full', used >= limit);
}

/**
 * Makes sure a numeric control is visible.
 *
 * WHY THIS IS NEEDED: UXP does not draw components that are not in its list,
 * and it does so SILENTLY — `sp-number-field` left only labels in the panel,
 * with no fields. `sp-slider` is documented, but we guard the same way as with
 * streaming fetch: if the height is zero after render, we substitute a segmented
 * control of plain <button> elements, which demonstrably work in this panel (quality).
 *
 * The substitute keeps the same id and .value property, so the rest of the code
 * reads the value the same way and does not know about the substitution.
 */
function ensureNumericControl(id, lsKey, values, unit) {
    const el = $(id);
    if (!el) return;
    if (el.offsetHeight > 0) return;          // it drew — nothing to do

    console.log(`[ui] ${id}: sp-slider did not draw — using a segmented control`);
    const saved = Number(localStorage.getItem(lsKey));
    const initial = values.includes(saved) ? saved : values[Math.floor(values.length / 2)];

    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.className = 'field-title';
    label.textContent = el.querySelector('sp-label')?.textContent || id;
    const seg = document.createElement('div');
    seg.className = 'seg numeric-seg';
    seg.setAttribute('role', 'group');

    const holder = document.createElement('div');
    holder.id = id;                            // the same id
    holder.value = String(initial);
    holder.style.display = 'none';

    for (const v of values) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'seg-btn numeric-seg-btn' + (v === initial ? ' active' : '');
        btn.textContent = v + unit;
        btn.dataset.value = String(v);
        btn.setAttribute('aria-pressed', v === initial ? 'true' : 'false');
        btn.addEventListener('click', () => {
            holder.value = String(v);
            localStorage.setItem(lsKey, String(v));
            seg.querySelectorAll('.seg-btn').forEach(b => {
                const active = b.dataset.value === String(v);
                b.classList.toggle('active', active);
                b.setAttribute('aria-pressed', active ? 'true' : 'false');
            });
            refreshPlanLine();
        });
        seg.appendChild(btn);
    }

    field.append(label, seg, holder);
    el.replaceWith(field);
}

/**
 * In Photoshop, sp-picker does not rebuild a closed trigger after an async
 * replacement of options. So we build the whole control outside the DOM and
 * substitute it already finished — together with a value that matches one of the items.
 */
function fillPicker(id, items, selectedValue) {
    const old = $(id);
    if (!old) return null;

    const picker = document.createElement('sp-picker');
    picker.id = id;
    for (const attr of ['size', 'class', 'title']) {
        const value = old.getAttribute(attr);
        if (value !== null) picker.setAttribute(attr, value);
    }
    if (old.disabled) picker.disabled = true;
    picker.setAttribute('value', selectedValue);
    const selected = items.find(it => it.value === selectedValue);
    if (selected) {
        // UXP sometimes leaves the trigger empty even with a correct value.
        // label/placeholder give the same visible text as a safe fallback.
        picker.setAttribute('label', selected.label);
        picker.setAttribute('placeholder', selected.label);
        // "Sunburst" and "Flare" explain nothing by themselves, and a 230-pixel
        // panel has no room for a separate caption — so the hint lives in the
        // picker title. sp-menu-item has no title of its own in UXP.
        if (selected.title) picker.setAttribute('title', selected.title);
    }

    const menu = document.createElement('sp-menu');
    menu.setAttribute('slot', 'options');
    for (const it of items) {
        const item = document.createElement('sp-menu-item');
        item.setAttribute('value', it.value);
        item.textContent = it.label;
        if (it.value === selectedValue) {
            item.setAttribute('selected', '');
            item.selected = true;
        }
        menu.appendChild(item);
    }
    picker.appendChild(menu);
    old.replaceWith(picker);
    picker.value = selectedValue;
    return picker;
}

function bindModelPicker(picker, items) {
    if (!picker) return;
    picker.addEventListener('change', e => {
        localStorage.setItem(LS.model, e.target.value);
        // The set of quality levels belongs to the MODEL: gpt-image-2.5 has xhigh
        // and max, the others do not. Without this line the panel would keep buttons
        // a new model would reject or an old one would not understand.
        initQuality();
        const picked = (items || []).find(it => it.value === e.target.value);
        // Without the else, the previous model's hint ("shuts down 2026-12-01")
        // would stay on a model it does not apply to.
        if (picked && picked.title) picker.setAttribute('title', picked.title);
        else picker.removeAttribute('title');
        applyProviderCapabilities();
        refreshPlanLine();
    });
}

/**
 * Which model to show as selected. The saved one if it is still in the list;
 * for a retired one, the provider's replacement (mini → Flare, not the most
 * expensive list[0]); otherwise the first in the list.
 */
function pickSavedModel(list, saved, provider) {
    if (list.some(m => m.id === saved)) return saved;
    const gone = saved && provider.retirement ? provider.retirement(saved) : null;
    if (gone && list.some(m => m.id === gone.replacement)) return gone.replacement;
    return list[0].id;
}

/**
 * Fills the model list.
 *
 * The two awaits are SEPARATE on purpose. `getKey` and `p.models` used to share
 * one try — and when getKey threw (secureStorage.getItem on a missing key does
 * throw), we never reached p.models, so the built-in fallback list was not even
 * asked. The picker stayed with NO items, and the reason was only in the console.
 */
async function refreshModels() {
    const p = currentProvider();
    const refreshSeq = ++modelRefreshSeq;

    let apiKey = null;
    try { apiKey = await window.aiAuth.getKey(p.keyName); }
    catch (e) { console.log('[ui] key not entered yet — taking the list without it'); }

    let list = [];
    try { list = (await p.models(apiKey)) || []; }
    catch (e) { console.warn('[ui] model list was not received:', e.message); }

    // Last line: providers have a built-in list that does not need the network.
    if (!list.length) {
        try { list = (await p.models(null)) || []; }
        catch (e) { console.warn('[ui] the built-in list failed too:', e.message); }
    }
    if (!list.length) {
        setStatus(mainI18n.t('status.noModels', { provider: p.label }));
        return;
    }
    // without this line "the network gave no list" cannot be told from
    // "the list arrived, but the picker was not redrawn"
    console.log(`[ui] models: ${p.id} → ${list.length} (${list.slice(0, 3).map(m => m.id).join(', ')})`);

    // While the network list was loading, the user may already have chosen another
    // provider. The old result must not overwrite the new picker.
    if (refreshSeq !== modelRefreshSeq || currentProvider().id !== p.id) return;

    const saved = localStorage.getItem(LS.model);
    const pick = pickSavedModel(list, saved, p);
    localStorage.setItem(LS.model, pick);
    // A retired model was replaced silently — and the price may have changed with it. Say so.
    const gone = saved && pick !== saved && p.retirement ? p.retirement(saved) : null;
    if (gone) {
        const next = list.find(m => m.id === pick);
        setStatus(mainI18n.t('status.modelRetired', {
            model: saved, date: gone.shutdown, replacement: next ? next.label : pick,
        }));
    }
    const items = list.map(m => ({
        value: m.id,
        label: m.label,
        title: m.hintKey ? mainI18n.t(m.hintKey, m.hintParams) : '',
    }));
    const picker = fillPicker('model-select', items, pick);
    bindModelPicker(picker, items);
    // The model may just have changed (another provider, another list) — quality
    // levels must be redrawn for it before the user presses anything.
    initQuality();
    applyProviderCapabilities();
}

/** Model caps override the provider flag when the model declares the control. */
function capabilityOn(provider, flag, capsKey) {
    const caps = currentCaps();
    if (caps && Object.prototype.hasOwnProperty.call(caps, capsKey)) return caps[capsKey] !== false;
    return provider[flag] !== false;
}

/** Disables controls the provider does not support, instead of ignoring them silently. */
function applyProviderCapabilities() {
    const p = currentProvider();
    const dim = (id, ok, why) => {
        const el = $(id);
        if (!el) return;
        el.disabled = !ok;
        el.parentElement?.classList.toggle('unsupported', !ok);
        if (!ok) {
            el.title = why;
        } else {
            const key = el.getAttribute('data-i18n-title');
            if (key) el.title = mainI18n.t(key);
        }
    };
    dim('transparent-bg', capabilityOn(p, 'supportsTransparent', 'transparent'),
        mainI18n.t('cap.noTransparent', { provider: p.label }));
    dim('live-preview', capabilityOn(p, 'supportsStream', 'stream'),
        mainI18n.t('cap.noPreview', { provider: p.label }));
    dim('add-ref-btn', capabilityOn(p, 'supportsReferences', 'references'),
        mainI18n.t('cap.noReferences', { provider: p.label }));
    dim('ignore-pixels', capabilityOn(p, 'supportsIgnorePixels', 'ignorePixels'),
        mainI18n.t('cap.noIgnore', { provider: p.label }));
}

/**
 * Redraws the quality switch for the MODEL, not for a fixed list.
 * Call it after every model change — otherwise the panel keeps buttons the
 * current model does not accept.
 */
function initQuality() {
    const group = $('quality-toggle');
    if (!group) return;
    const list = allowedQualities();
    const saved = currentQuality();
    group.setAttribute('aria-label', mainI18n.t('field.quality'));
    group.innerHTML = '';

    /* GEOMETRY, NOT TASTE: gpt-image-2.5 has six levels. In one row of a 230 px
       panel each button would get ~31 px and turn into "…". So from five levels
       the switch goes into two rows of three.

       Rows and edges are placed by JS, not CSS: :nth-child and :nth-last-child
       are unverified in this panel, and UXP has already silently ignored a
       pseudo-class once (:empty drew empty badges as dots). We know the button
       index exactly — so we count it here. */
    const perRow = 3;
    const wrap = list.length > 4;
    group.classList.toggle('seg-wrap', wrap);

    list.forEach((q, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'seg-btn' + (q === saved ? ' active' : '');
        if (wrap) {
            if ((i + 1) % perRow === 0) btn.classList.add('seg-row-end');
            if (i < list.length - (list.length % perRow || perRow)) btn.classList.add('seg-row-top');
        }
        btn.textContent = mainI18n.t(`quality.${q}`);
        btn.dataset.value = q;
        btn.setAttribute('aria-pressed', q === saved ? 'true' : 'false');
        btn.addEventListener('click', () => {
            localStorage.setItem(LS.quality, q);
            group.querySelectorAll('.seg-btn').forEach(b => {
                const active = b.dataset.value === q;
                b.classList.toggle('active', active);
                b.setAttribute('aria-pressed', active ? 'true' : 'false');
            });
            refreshPlanLine();
        });
        group.appendChild(btn);
    });
}

/**
 * Choice of network route.
 *
 * WHAT THIS ACTUALLY FIXES: the `network.domains` permission in the manifest has
 * no power over a system firewall — the request leaves the Photoshop process, and
 * a "block Photoshop" rule cuts it. A child `curl` is a separate binary, so it
 * does not fall under that rule. "Auto" costs nothing while the direct path works:
 * it switches only after a real network failure.
 */
function initTransport() {
    const group = $('transport-toggle');
    if (!group) return;
    const saved = TRANSPORTS.includes(localStorage.getItem(LS.transport))
        ? localStorage.getItem(LS.transport) : 'auto';
    httpTransport.setMode(saved);
    group.setAttribute('aria-label', mainI18n.t('field.transport'));
    group.innerHTML = '';
    for (const value of TRANSPORTS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'seg-btn' + (value === saved ? ' active' : '');
        btn.textContent = mainI18n.t(`transport.${value}`);
        btn.dataset.value = value;
        btn.setAttribute('aria-pressed', value === saved ? 'true' : 'false');
        btn.addEventListener('click', () => {
            localStorage.setItem(LS.transport, value);
            httpTransport.setMode(value);
            // a manual choice clears the memory of a failure: otherwise 'auto' would
            // stay on curl forever after one accidental network error
            httpTransport.resetDirectFailure();
            group.querySelectorAll('.seg-btn').forEach(b => {
                const active = b.dataset.value === value;
                b.classList.toggle('active', active);
                b.setAttribute('aria-pressed', active ? 'true' : 'false');
            });
            refreshTransportBadge();
            if (value !== 'direct') setStatus(mainI18n.t('transport.firstApproval'));
        });
        group.appendChild(btn);
    }
    refreshTransportBadge();
}

/** The badge shows not the user's choice but the route actually in use right now. */
function refreshTransportBadge() {
    setBadge('net-badge', httpTransport.active() ? mainI18n.t('transport.curl') : '');
}

/* ── The line "what will actually be requested" ────────────────────────────── */

/**
 * Shows the request size BEFORE the button is pressed. That is the answer to
 * "more for quality, less to save money": the quality level is visible in
 * megapixels, not on faith. Reading the selection here is outside executeAsModal —
 * it is only a `get`, and the document does not change.
 */
let planTimer = null;
function schedulePlanLine() {
    if (planTimer) clearTimeout(planTimer);
    planTimer = setTimeout(() => {
        refreshPlanLine();
        noteContextDrift();
    }, 250);
}

function setPlanCard(titleKey, body, ready) {
    const card = $('plan-card');
    const title = $('plan-title');
    const line = $('plan-line');
    if (!card || !title || !line) return;
    title.textContent = mainI18n.t(titleKey);
    line.textContent = body || '';
    card.classList.toggle('dim', !ready);
}

/**
 * The price line for the plan card. Empty when there are no observations — an
 * invented number is worse than none here: people decide whether to press based on it.
 */
function forecastNote({ provider, model, quality, plan }) {
    try {
        const f = usageTracker.forecastCost({
            provider: provider.id, model, quality, plan, history: ledger.load(),
        });
        if (f.usd === null) {
            return provider.id === 'wavespeed'
                ? ` · ${mainI18n.t('plan.costUnavailable')}` : '';
        }
        const usd = usageTracker.formatUsd(f.usd);
        return f.low === f.high
            ? ` · ${mainI18n.t('plan.cost', { usd })}`
            : ` · ${mainI18n.t('plan.costRange', {
                usd,
                low: usageTracker.formatUsd(f.low),
                high: usageTracker.formatUsd(f.high),
            })}`;
    } catch (e) {
        console.warn('[ui] price forecast failed:', e.message);
        return '';
    }
}

async function refreshPlanLine() {
    const el = $('plan-line');
    if (!el) return;
    try {
        const doc = app.activeDocument;
        if (!doc) { setPlanCard('plan.notReadyTitle', mainI18n.t('plan.noDocument'), false); return; }

        const sel = await readSelectionBounds(doc).catch(() => null);
        if (!sel || !sel.bounds) {
            setPlanCard('plan.selectTitle', mainI18n.t('plan.selectArea'), false);
            return;
        }
        const target = geometry.integerTarget(sel.bounds);
        if (target.w < 1 || target.h < 1) {
            setPlanCard('plan.selectTitle', mainI18n.t('plan.emptySelection'), false);
            return;
        }
        const s = readSettings();
        const ctx = expandForContext(target, doc, s.padPercent);
        const provider = currentProvider();
        const model = localStorage.getItem(LS.model);
        const plan = geometry.planRequest(provider.capsFor(model), ctx, s.quality);

        let what;
        if (plan.size) {
            const [w, h] = String(plan.size).split('x').map(Number);
            what = `${w}×${h} · ${(w * h / 1e6).toFixed(2)} ${mainI18n.t('unit.megapixels')}`;
            // The most expensive and least predictable mode must be named before
            // the button is pressed, not discovered from the bill.
            const caps = provider.capsFor(model);
            if (caps.stablePx && w * h > caps.stablePx) {
                what += ` · ${mainI18n.t('plan.experimental')}`;
            }
        } else if (plan.aspectRatio) {
            what = `${plan.aspectRatio} · ${plan.imageSize}`;
        } else {
            what = mainI18n.t('plan.defaultSize');
        }
        const io = inputPlan(s, provider, ctx);
        const inputNote = !io.sendsPixels
            ? ` · ${mainI18n.t('plan.inputNone')}`
            : ` · ${mainI18n.t(io.viaDuplicate ? 'plan.inputPngLarge'
                             : io.lossless ? 'plan.inputPng' : 'plan.inputJpeg')}`
              /* The shape matters: through it the model receives neighboring pixels
                 as context, not as permission to paint. We promise it only where we
                 can actually read it — in CMYK we do not call getSelection at all. */
              + (io.wantMask ? ` · ${mainI18n.t(
                    !sel.solid && capture.isSafeMode(String(doc.mode))
                        ? 'plan.withShapeMask' : 'plan.withMask')}` : '')
              // A hard edge with a mask is a visible seam at the join. The 16 px
              // default was not an aesthetic choice: see the comment on buildRectMaskPng.
              + (io.wantMask && !s.feather ? ` · ${mainI18n.t('plan.hardEdge')}` : '');
        setPlanCard('plan.readyTitle', mainI18n.t('plan.request', {
            what,
            cost: forecastNote({ provider, model, quality: s.quality, plan }),
            input: inputNote,
            width: target.w,
            height: target.h,
            context: s.padPercent ? mainI18n.t('plan.context', { width: ctx.w, height: ctx.h }) : '',
            refs: references.length ? mainI18n.t('plan.refs', { count: references.length }) : '',
        }), true);
    } catch (e) {
        setPlanCard('plan.notReadyTitle', '', false);
        console.warn('[ui] plan failed:', e.message);
    }
}

/* ── Persistent cost log ────────────────────────────────────────────────────── */

function recordUsage(meta, usage) {
    ledger.record(meta, usage);
    renderUsage();
}

function amountWithUnknown(summary) {
    const amount = `≈${usageTracker.formatUsd(summary.usd)}`;
    return summary.unknownCost
        ? mainI18n.t('usage.unknown', { amount, count: summary.unknownCost }) : amount;
}

/** One summary row: today / 7 days / all. */
function usageCard(label, data) {
    const card = dom.el('div', 'usage-card');
    card.append(
        dom.el('span', 'usage-card-label', label),
        dom.el('strong', '', amountWithUnknown(data)),
        dom.el('span', 'usage-card-meta',
            `${data.requests} ${mainI18n.t('usage.requestsShort')} · ` +
            `${usageTracker.formatTokens(data.inputTokens)} ${mainI18n.t('usage.inputShort')} / ` +
            `${usageTracker.formatTokens(data.outputTokens)} ${mainI18n.t('usage.outputShort')}`),
    );
    return card;
}

/** One request in the recent list. */
function usageRow(entry) {
    const when = new Date(entry.at);
    const date = when.toLocaleDateString(mainI18n.dateLocale(), { day: '2-digit', month: '2-digit' });
    const time = when.toLocaleTimeString(mainI18n.dateLocale(), { hour: '2-digit', minute: '2-digit' });
    const shape = [entry.quality, entry.size, entry.aspectRatio].filter(Boolean).join(' · ');

    const info = dom.el('div', 'usage-info');
    info.append(
        dom.el('div', 'usage-main', `${entry.providerLabel || entry.provider} · ${entry.model}`),
        dom.el('div', 'usage-meta',
            `${date} ${time}${shape ? ` · ${shape}` : ''} · ` +
            `${usageTracker.formatTokens(entry.inputTokens)} ${mainI18n.t('usage.inputShort')} / ` +
            `${usageTracker.formatTokens(entry.outputTokens)} ${mainI18n.t('usage.outputShort')}`),
    );
    const row = dom.el('div', 'usage-row');
    row.append(info, dom.el('div', 'usage-amount',
        Number.isFinite(entry.costUsd) ? `≈${usageTracker.formatUsd(entry.costUsd)}` : '—'));
    return row;
}

/** Compact line under the button — the only thing visible without expanding the section. */
function usageCompactLine(stats) {
    const lastAmount = Number.isFinite(stats.last.costUsd)
        ? `≈${usageTracker.formatUsd(stats.last.costUsd)}` : mainI18n.t('usage.costUnknown');
    return `${mainI18n.t('usage.last')}: ${lastAmount} · ` +
        `${mainI18n.t('usage.today').toLowerCase()}: ${amountWithUnknown(stats.today)} ` +
        `(${stats.today.requests}) · ${mainI18n.t('usage.sevenDays')}: ${amountWithUnknown(stats.sevenDays)} ` +
        `(${stats.sevenDays.requests})`;
}

function renderUsage() {
    const compact = $('cost-line');
    const summaryEl = $('usage-summary');
    const listEl = $('usage-list');
    const stats = ledger.summarize();

    if (!stats.last) {
        if (compact) { compact.textContent = ''; compact.classList.add('hidden'); }
        if (summaryEl) summaryEl.textContent = mainI18n.t('usage.empty');
        dom.clear(listEl);
        setBadge('usage-badge', '');
        return;
    }

    if (compact) {
        compact.textContent = usageCompactLine(stats);
        compact.classList.remove('hidden');
    }
    setBadge('usage-badge', `${usageTracker.formatUsd(stats.today.usd)} · ${stats.today.requests}`);

    dom.fill(summaryEl, [
        [mainI18n.t('usage.today'), stats.today],
        [mainI18n.t('usage.sevenDays'), stats.sevenDays],
        [mainI18n.t('usage.all'), stats.all],
    ].map(([label, data]) => usageCard(label, data)));

    dom.fill(listEl, stats.recent.map(usageRow));
}

/* ── References ─────────────────────────────────────────────────────────────── */

function renderRefs() {
    dom.fill($('ref-list'), references.map((r, i) => {
        const chip = dom.el('span', 'chip', r.name);
        chip.appendChild(dom.iconButton({
            title: mainI18n.t('common.delete'),
            className: 'chip-x',
            onClick: () => { references.splice(i, 1); renderRefs(); refreshPlanLine(); },
        }));
        return chip;
    }));
    setBadge('ref-count', references.length ? String(references.length) : '');
}

async function pickReferences() {
    try {
        const files = await uxpStorage.localFileSystem.getFileForOpening({
            allowMultiple: true,
            types: ['png', 'jpg', 'jpeg', 'webp'],
        });
        const arr = Array.isArray(files) ? files : (files ? [files] : []);
        for (const f of arr) {
            const buf = await f.read({ format: uxpStorage.formats.binary });
            const lower = String(f.name).toLowerCase();
            const type = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg'
                       : lower.endsWith('.webp') ? 'image/webp' : 'image/png';
            references.push({ name: f.name, blob: new Blob([buf], { type }) });
        }
        renderRefs();
        refreshPlanLine();
    } catch (e) {
        if (e && /cancel/i.test(String(e.message))) return;
        console.error('[ui] references were not added:', e.message);
        setStatus(mainI18n.t('refs.addError', { error: e.message }));
    }
}

/* ── Presets, history, cache ────────────────────────────────────────────────── */

function renderPresets() {
    dom.fill($('preset-list'), presetManager.getAll().map(p => {
        const cb = dom.el('sp-checkbox', '', p.name);
        if (p.active) cb.setAttribute('checked', '');
        cb.addEventListener('change', e => presetManager.toggleActive(p.id, e.target.checked));
        const row = dom.el('div', 'preset-row');
        row.append(cb, dom.iconButton({
            title: mainI18n.t('common.delete'),
            onClick: () => { presetManager.delete(p.id); renderPresets(); },
        }));
        return row;
    }));
    const active = presetManager.getAll().filter(p => p.active).length;
    setBadge('preset-count', active ? String(active) : '');
}

function renderHistory() {
    dom.fill($('history-list'), historyManager.getAll().map(h => {
        const txt = dom.el('span', 'history-prompt',
            (h.prompt || '').slice(0, 90) || mainI18n.t('common.noPrompt'));
        txt.title = mainI18n.t('history.restore');
        txt.addEventListener('click', () => {
            const input = $('prompt-input');
            if (input) {
                input.value = h.prompt || '';
                localStorage.setItem(LS.prompt, input.value);
                // Without this line the counter stayed on the previous text:
                // a prompt restored from history can be any length, and the input
                // event does not fire when value is changed from code.
                updateCharCount('prompt-input', 'prompt-count');
            }
            if (h.ctx) { lastRun = { ...h, references: [] }; setBusy(false); }
            refreshPlanLine();
        });
        const row = dom.el('div', 'history-row');
        row.append(txt, dom.iconButton({
            title: mainI18n.t('common.delete'),
            onClick: () => { historyManager.delete(h.id); renderHistory(); },
        }));
        return row;
    }));
}

function renderCache() {
    const entries = cache.list();
    dom.fill($('cache-list'), entries.map(entry => {
        const meta = entry.meta || {};
        const when = new Date(entry.at).toLocaleTimeString();
        const txt = dom.el('span', 'cache-info',
            `${when} · ${(entry.size / 1024).toFixed(0)} KB · ` +
            `${(meta.prompt || '').slice(0, 40) || mainI18n.t('common.noPrompt')}`);

        const insert = dom.el('button', 'mini-btn', mainI18n.t('cache.insert'));
        insert.type = 'button';
        insert.title = mainI18n.t('cache.insertTitle');
        insert.addEventListener('click', () => reinsert(entry.id));

        const row = dom.el('div', 'cache-row');
        row.append(txt, insert, dom.iconButton({
            title: mainI18n.t('common.delete'),
            onClick: async () => { await cache.remove(entry.id); renderCache(); },
        }));
        return row;
    }));
    setBadge('cache-badge', entries.length ? `${entries.length} · ${cache.human()}` : '');
}

function buildPrompt() {
    let text = ($('prompt-input')?.value || '').trim();
    for (const p of presetManager.getAll()) {
        if (p.active && p.content) text += ' ' + p.content;
    }
    return text.trim();
}

/* ── Insertion ─────────────────────────────────────────────────────────────── */

/**
 * One insertion path for a NEW generation and for a repeat from cache — so the
 * mask, channel and residual are computed the same way and do not diverge across two copies of the code.
 */
async function insertImage(b64, ctx, target, feather) {
    await core.executeAsModal(async () => {
        const channelName = 'AiSel_' + Date.now();
        let haveChannel = false;
        try {
            // During a long generation the user can change the selection. Do not
            // apply someone else's mask to the old area: save the channel only
            // when the current bounds still match the target.
            const current = await readSelectionBounds(app.activeDocument).catch(() => null);
            const currentTarget = current && current.bounds ? geometry.integerTarget(current.bounds) : null;
            const sameTarget = currentTarget && ['left', 'top', 'right', 'bottom']
                .every(k => currentTarget[k] === target[k]);
            if (!sameTarget) throw new Error('the active selection changed — using the target rectangle');
            // Official DOM Selection API (PS 25+). The previous batchPlay
            // encoded selection as an enum by mistake and therefore created no channel.
            await app.activeDocument.selection.save(channelName);
            haveChannel = true;
        } catch (e) {
            // No active selection (the typical case for a repeat from cache) —
            // place.js will build the mask from the target rectangle.
            console.log('[main] selection was not saved to a channel:', e.message);
        }
        try {
            const report = await place.placeGeneratedSmartObject(
                b64, ctx, haveChannel ? channelName : null,
                { maskFeather: feather, maskBounds: target });
            const r = report.residual || {};
            const el = $('residual-text');
            if (el) {
                const zero = [r.dx, r.dy, r.dw, r.dh].every(v => Math.abs(Number(v) || 0) < 0.01);
                /* Falling back to a rectangular mask used to be ONLY in the console.
                   And this is exactly the case where the selection shape stopped cutting
                   the layer: everything sharing the target's bounding box stayed
                   repainted. That cannot stay silent — the user looks at the result, not the log. */
                const fallback = haveChannel ? '' : ` · ${mainI18n.t('residual.rectMask')}`;
                el.textContent = (zero
                    ? mainI18n.t('residual.exact')
                    : mainI18n.t('residual.value', r)) + fallback;
                el.className = 'residual' + (zero && haveChannel ? ' ok' : ' warn');
            }
            console.log('[main] residual', JSON.stringify(report.residual),
                report.warnings.length ? 'warnings: ' + report.warnings.join('; ') : '');
        } finally {
            if (haveChannel) {
                try {
                    await app.activeDocument.channels.getByName(channelName).remove();
                } catch (e) {}
            }
        }
    }, { commandName: mainI18n.t('command.insert') });
}

async function reinsert(cacheId) {
    if (busy) return;
    const entry = cache.list().find(e => e.id === cacheId);
    if (!entry) { setStatus(mainI18n.t('cache.missing')); renderCache(); return; }
    const doc = app.activeDocument;
    if (!doc) { await core.showAlert(mainI18n.t('alert.openDocument')); return; }

    setBusy(true);
    try {
        setStatus(mainI18n.t('cache.reading'));
        const b64 = await cache.get(cacheId);
        if (!b64) { setStatus(mainI18n.t('cache.fileMissing')); renderCache(); return; }
        const m = entry.meta || {};
        // If there is an active selection — insert into IT; otherwise into the saved area.
        const sel = await readSelectionBounds(doc).catch(() => null);
        let ctx = m.ctx, target = m.target;
        if (sel && sel.bounds) {
            target = geometry.integerTarget(sel.bounds);
            ctx = expandForContext(target, doc, Number(m.padPercent) || 0);
            setStatus(mainI18n.t('cache.insertCurrent'));
        } else if (!ctx) {
            setStatus(mainI18n.t('cache.noCoordinates'));
            return;
        } else {
            setStatus(mainI18n.t('cache.insertSaved'));
        }
        showPreview(b64);
        await insertImage(b64, ctx, target, readSettings().feather);
        setStatus(mainI18n.t('cache.inserted'));
    } catch (e) {
        console.error('[main] repeat from cache:', e);
        setStatus(mainI18n.t('error.failed', { error: e.message || e }));
    } finally {
        setBusy(false);
    }
}

/* ── Main flow ─────────────────────────────────────────────────────────────── */

/**
 * Preconditions for a run. Every refusal is a showAlert and null; keeping them
 * in onGenerate would mean twenty lines of guards before the first useful action.
 */
async function collectRunInputs(mode) {
    const doc = app.activeDocument;
    if (!doc) { await core.showAlert(mainI18n.t('alert.openDocument')); return null; }

    const model = localStorage.getItem(LS.model);
    if (!model) { await core.showAlert(mainI18n.t('alert.chooseModel')); return null; }

    /* Only Regenerate takes the old prompt. Refine is the opposite: its whole
       point is the NEW text, so it reads the field, like an ordinary run. */
    const prompt = mode === 'again' && lastRun ? lastRun.prompt : buildPrompt();
    if (!prompt) { await core.showAlert(mainI18n.t('alert.writePrompt')); return null; }

    const provider = currentProvider();
    const apiKey = await window.aiAuth.getKey(provider.keyName);
    if (!apiKey) {
        const message = mainI18n.t('settings.needKey', { provider: provider.label });
        if (window.aiAuth.openSettings) await window.aiAuth.openSettings(message);
        else await core.showAlert(mainI18n.t('alert.noKey', { provider: provider.label }));
        return null;
    }
    const s = readSettings();
    if (!capabilityOn(provider, 'supportsIgnorePixels', 'ignorePixels')) s.ignorePixels = false;
    return { doc, provider, model, prompt, apiKey, s };
}

/**
 * The area: either from the live selection, or the same one as last time.
 * null means "there is nothing to work with", and the alert has already been shown.
 */
async function resolveRegion(reuse, doc, padPercent) {
    if (reuse && lastRun && lastRun.target) {
        setStatus(mainI18n.t('status.sameArea'));
        /* The area is the same, but the context pad is read NOW. This used to
           return the saved lastRun.ctx — and moving the context slider before
           Regenerate silently did nothing: the same frame, the same price,
           no hint in the interface (measured 2026-09-09). */
        return { target: lastRun.target, ctx: expandForContext(lastRun.target, doc, padPercent) };
    }
    setStatus(mainI18n.t('status.readSelection'));
    const sel = await core.executeAsModal(() => readSelectionBounds(app.activeDocument),
        { commandName: mainI18n.t('command.readSelection') });
    if (!sel || !sel.bounds) { await core.showAlert(mainI18n.t('alert.selectArea')); return null; }

    const target = geometry.integerTarget(sel.bounds);
    if (target.w < 1 || target.h < 1) {
        await core.showAlert(mainI18n.t('alert.emptySelection'));
        return null;
    }
    if (!sel.solid) {
        // Not a problem: the layer mask is built from the real selection channel,
        // so a lasso and an ellipse are cropped correctly. The request uses the bounding box.
        console.log('[main] selection is not rectangular — request uses the bounding box, ' +
                    'layer mask uses the actual shape');
    }
    return { target, ctx: expandForContext(target, doc, padPercent) };
}

/**
 * What goes in the request body: whether there will be a mask, and in which format the input is.
 *
 * ONE PLACE FOR TWO CONSUMERS ON PURPOSE. While this decision lived twice — in
 * the plan card and in capturePayload — they diverged: the card looked only at
 * the "lossless input" checkbox and promised "input JPEG", while the mask silently
 * forced PNG. Measured on a live host 2026-09-09: the card said 58 KB JPEG, 1227 KB
 * PNG was sent. The format formula is the same as in capture.captureRegion:
 * lossless = wantLossless || requirePng.
 */
function inputPlan(s, provider, ctx) {
    const wantMask = provider.supportsMask && s.padPercent > 0 && !s.ignorePixels;
    const lossless = s.lossless || wantMask;
    return {
        wantMask,
        lossless,
        sendsPixels: !s.ignorePixels,
        viaDuplicate: lossless && ctx.w * ctx.h > capture.LOSSLESS_MAX_PX,
    };
}

/** Capture pixels plus the request mask — what will go in the request body. */
async function capturePayload({ s, provider, ctx, target }) {
    /* The mask decision is made BEFORE capture: OpenAI requires the input and
       the mask to be the same format, so the presence of a mask decides the input format. */
    const { wantMask } = inputPlan(s, provider, ctx);

    let cap = { blob: null, lossless: false };
    if (!s.ignorePixels) {
        setStatus(mainI18n.t('status.capturing'));
        cap = await core.executeAsModal(
            () => capture.captureRegion(ctx, s.layerOnly, s.lossless, wantMask),
            { commandName: mainI18n.t('command.capture') });
        console.log(`[main] captured: ${cap.docMode} ${cap.bpc}-bit` +
                    `${cap.viaDuplicate ? ' (via duplicate)' : ''}` +
                    `${cap.lossless ? ' PNG' : ' JPEG'}`);
    }

    /* The selection shape is read in a SEPARATE modal block, once the document
       mode is known: in CMYK getSelection crashes Photoshop, and we do not go there. */
    let shape = null;
    if (wantMask) {
        const got = await core.executeAsModal(() => capture.selectionShape(ctx, target, cap.docMode),
            { commandName: mainI18n.t('command.readSelection') });
        shape = got.data;
        if (got.reason) console.warn('[main] selection shape unavailable, mask is rectangular:', got.reason);
    }

    const mask = wantMask
        ? capture.maskForRequest({ ctx, target, feather: s.feather, input: cap.blob, shape })
        : { blob: null, bytes: 0, reason: '' };
    if (mask.reason) console.warn('[main] there will be no mask:', mask.reason);
    else if (mask.blob) console.log(`[main] mask ${ctx.w}×${ctx.h} (${mask.source}), ` +
                                    `edge ${s.feather} px: ${(mask.bytes / 1024).toFixed(1)} KB`);

    return { input: cap.blob, mask: mask.blob };
}

/** Memory of a run: cache, history and the repeat buttons. */
async function rememberRun(meta, image, s) {
    const cacheId = await cache.save(image, meta);
    renderCache();
    // cacheId in lastRun — so the first Refine turn has somewhere to take pixels
    // from, without holding megabytes of base64 in panel memory between runs.
    lastRun = { ...meta, cacheId };
    historyManager.add({ ...meta, cacheId, settings: s });
    renderHistory();
}

/**
 * Whether there is something to refine. Three conditions, and each can refuse
 * on its own: there was a run, pixels or a conversation id remain from it, and
 * the provider can do the route at all.
 */
function canRefine() {
    if (!lastRun || !lastRun.ctx) return false;
    if (currentProvider().supportsRefine !== true) return false;
    return Boolean(lastRun.responseId || lastRun.cacheId);
}

/**
 * Refine: the request to the provider plus what insertion needs to know.
 *
 * GEOMETRY COMES FROM THE RUN BEING REFINED, not from the current settings.
 * What is refined is an already painted tile; if we reread the context slider
 * the way Regenerate does, the picture would land in a frame it does not depict.
 */
async function runRefine({ provider, model, prompt, apiKey, s }) {
    const previousImage = lastRun.responseId ? null : await cache.get(lastRun.cacheId);
    if (!lastRun.responseId && !previousImage) {
        await core.showAlert(mainI18n.t('cache.fileMissing'));
        return null;
    }
    setStatus(mainI18n.t('status.refining'));
    const plan = lastRun.plan || geometry.planRequest(provider.capsFor(model), lastRun.ctx, s.quality);
    console.log('[main] refine:', JSON.stringify(plan),
                'ctx', lastRun.ctx.w + '×' + lastRun.ctx.h,
                lastRun.responseId ? 'conversation continuation' : 'first turn');

    const res = await provider.refine({
        apiKey, model, prompt, plan,
        previousResponseId: lastRun.responseId || null,
        previousImage,
        signal: abortCtrl ? abortCtrl.signal : undefined,
        onPartial: s.livePreview ? (b64, idx) => {
            showPreview(b64);
            setStatus(mainI18n.t('status.partial', { number: (idx ?? 0) + 1 }));
        } : null,
        onProgress: st => setStatus(st),
    });
    return { res, plan, ctx: lastRun.ctx, target: lastRun.target };
}

function contextStamp(doc, target, s) {
    const layers = doc && doc.activeLayers;
    const layer = (layers && layers[0]) || (doc && doc.activeLayer) || null;
    return {
        docId: doc.id,
        layerId: layer && layer.id != null ? layer.id : 0,
        layerOnly: !!s.layerOnly,
        pad: Number(s.padPercent) || 0,
        left: target.left, top: target.top, right: target.right, bottom: target.bottom,
    };
}

async function readContextStamp() {
    const doc = app.activeDocument;
    if (!doc) return null;
    const s = readSettings();
    const sel = await core.executeAsModal(() => readSelectionBounds(doc),
        { commandName: mainI18n.t('command.readSelection') });
    if (!sel || !sel.bounds) return null;
    return contextStamp(doc, geometry.integerTarget(sel.bounds), s);
}

/** A moved document, layer, or selection retires the in-memory discussion. */
async function noteContextDrift() {
    if (busy || !talkSession.messages.length || !talkSession.anchor) return;
    const stamp = await readContextStamp();
    if (!stamp || conversation.sameStamp(talkSession.anchor, stamp)) return;
    talkFlight += 1;
    talkSession.epoch += 1;
    talkSession.messages = [];
    talkSession.anchor = null;
    talkSession.brief = '';
    talkSession.generatedOp = null;
    renderTalk();
    setTalkState(mainI18n.t('talk.context'));
}

function setTalkState(text) {
    const el = $('talk-state');
    if (el) el.textContent = text || '';
}

function renderTalk() {
    const log = $('talk-log');
    if (!log) return;
    dom.fill(log, talkSession.messages.map(msg => {
        const row = dom.el('div', 'talk-msg ' + (msg.role === 'user' ? 'talk-user' : 'talk-assistant'));
        row.append(
            dom.el('div', 'talk-who', mainI18n.t(msg.role === 'user' ? 'talk.you' : 'talk.assistant')),
            dom.el('div', 'talk-body', msg.text),
        );
        return row;
    }));
    log.scrollTop = log.scrollHeight;
    const brief = $('talk-brief');
    if (brief) {
        const text = (talkSession.brief || '').trim();
        brief.textContent = text ? `${mainI18n.t('talk.briefLabel')}: ${text}` : '';
        brief.classList.toggle('hidden', !text);
    }
}

function clearComposer() {
    const input = $('prompt-input');
    if (input) input.value = '';
    localStorage.setItem(LS.prompt, '');
    updateCharCount('prompt-input', 'prompt-count');
}

/**
 * Shared tail for a paid edit. Regenerate, Refine, and a ready discussion all
 * land here so placement and history stay one path. A superseded turn does not
 * insert: the response arrived after cancel, reset, or a context change.
 */
async function acceptResult({ res, plan, ctx, target, input, refBlobs, refining, prompt,
                               provider, model, s, docId, stillCurrent }) {
    const images = (res && res.images) || [];
    if (!images.length) { await core.showAlert(mainI18n.t('alert.noImages')); return; }
    showPreview(images[0]);
    recordUsage({
        provider: provider.id,
        providerLabel: provider.label,
        model,
        quality: s.quality,
        plan,
        route: refining ? 'responses' : 'edits',
        imageCount: images.length,
        hasImageInput: refining || !!input || refBlobs.length > 0,
    }, res.usage);
    if (stillCurrent && !stillCurrent()) return;
    if (!app.activeDocument || app.activeDocument.id !== docId) {
        await core.showAlert(mainI18n.t('alert.documentChanged'));
        return;
    }
    setStatus(mainI18n.t('status.inserting'));
    await insertImage(images[0], ctx, target, s.feather);
    await rememberRun({
        prompt: refining ? lastRun.prompt : prompt,
        provider: provider.id, model, ctx, target, plan,
        padPercent: refining ? lastRun.padPercent : s.padPercent,
        quality: s.quality,
        responseId: res.responseId || null,
        turn: refining ? (lastRun.turn || 1) + 1 : 1,
        refinedWith: refining ? prompt : undefined,
    }, images[0], s);
    setStatus(mainI18n.t('status.done'));
    setTalkState('');
}

function stopTalk(message) {
    talkFlight += 1;
    talkSession.epoch += 1;
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = null;
    if (message) setTalkState(message);
    setBusy(false);
}

function resetTalk() {
    talkFlight += 1;
    talkSession.epoch += 1;
    talkSession.messages = [];
    talkSession.anchor = null;
    talkSession.brief = '';
    talkSession.generatedOp = null;
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = null;
    renderTalk();
    setTalkState(mainI18n.t('talk.resetDone'));
    setStatus('');
    setBusy(false);
}

async function onDiscuss() {
    if (busy) return;
    const draft = ($('prompt-input')?.value || '').trim();
    if (!draft) { setTalkState(mainI18n.t('talk.empty')); return; }
    const flight = ++talkFlight;
    abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const signal = abortCtrl ? abortCtrl.signal : undefined;
    setBusy(true);
    showPreview(null);
    const residual = $('residual-text');
    if (residual) residual.textContent = '';

    try {
        const openrouterKey = await window.aiAuth.getKey(SECURE.openrouter);
        if (flight !== talkFlight) return;
        if (!openrouterKey) {
            const message = mainI18n.t('settings.openrouterNeed');
            if (window.aiAuth.openSettings) await window.aiAuth.openSettings(message, 'openrouter-key-input');
            else await core.showAlert(message);
            return;
        }
        const outcome = await conversation.runTurn(talkSession, {
            text: draft,
            signal,
            presets: presetManager.getAll().filter(p => p.active && p.content).map(p => p.content),
            cancelledText: mainI18n.t('talk.cancelled'),
            fallbackQuestion: mainI18n.t('talk.fallback'),
            onPhase: phase => {
                if (flight === talkFlight) renderTalk();
                const key = {
                    thinking: 'talk.thinking',
                    deciding: 'talk.deciding',
                    clarify: 'talk.clarify',
                    context: 'talk.context',
                }[phase];
                if (key && flight === talkFlight) setTalkState(mainI18n.t(key));
            },
            capture: async () => {
                const doc = app.activeDocument;
                if (!doc) { await core.showAlert(mainI18n.t('alert.openDocument')); return null; }
                const s = readSettings();
                const region = await resolveRegion(false, doc, s.padPercent);
                if (!region) return null;
                const provider = currentProvider();
                const payload = await capturePayload({
                    s: { ...s, ignorePixels: false }, provider, ctx: region.ctx, target: region.target,
                });
                if (!payload.input) return null;
                return {
                    blob: payload.input,
                    mask: payload.mask,
                    ctx: region.ctx,
                    target: region.target,
                    docId: doc.id,
                    stamp: contextStamp(doc, region.target, s),
                };
            },
            context: () => readContextStamp(),
            chat: info => openrouter.completeChat({
                apiKey: openrouterKey,
                messages: info.messages,
                imageBlob: info.image && info.image.blob,
                clarify: info.clarify,
                brief: info.brief,
                signal,
            }),
            decide: info => openrouter.completeDecision({
                apiKey: openrouterKey,
                messages: info.messages,
                brief: info.brief,
                imageBlob: info.image && info.image.blob,
                stamp: info.stamp,
                references: references.map(item => ({ name: item.name })),
                withdrawn: info.withdrawn,
                signal,
            }),
            generate: async ({ prompt, image, stillCurrent }) => {
                if (!stillCurrent()) return;
                const provider = currentProvider();
                const model = localStorage.getItem(LS.model);
                if (!model) {
                    await core.showAlert(mainI18n.t('alert.chooseModel'));
                    const err = new Error('model');
                    err.workflow = true;
                    throw err;
                }
                const apiKey = await window.aiAuth.getKey(provider.keyName);
                if (!apiKey) {
                    const message = mainI18n.t('settings.needKey', { provider: provider.label });
                    if (window.aiAuth.openSettings) await window.aiAuth.openSettings(message);
                    else await core.showAlert(mainI18n.t('alert.noKey', { provider: provider.label }));
                    const err = new Error('key');
                    err.workflow = true;
                    throw err;
                }
                if (!stillCurrent()) return;
                if (!conversation.sameStamp(image.stamp, await readContextStamp())) {
                    setTalkState(mainI18n.t('talk.context'));
                    const err = new Error('context');
                    err.workflow = true;
                    throw err;
                }
                if (!stillCurrent()) return;
                const s = readSettings();
                if (!capabilityOn(provider, 'supportsIgnorePixels', 'ignorePixels')) s.ignorePixels = false;
                const plan = geometry.planRequest(provider.capsFor(model), image.ctx, s.quality);
                console.log('[main] request plan:', JSON.stringify(plan), 'ctx', image.ctx.w + '×' + image.ctx.h);
                setStatus(mainI18n.t('status.generating'));
                setTalkState(mainI18n.t('talk.generating'));
                const wantPreview = s.livePreview && provider.supportsStream !== false;
                const refBlobs = (provider.supportsReferences !== false) ? references.map(item => item.blob) : [];
                const sendPixels = !s.ignorePixels;
                const res = await provider.generate({
                    apiKey, model, prompt,
                    imageBlob: sendPixels ? image.blob : null,
                    maskBlob: sendPixels ? image.mask : null,
                    references: refBlobs,
                    plan,
                    background: s.transparent && capabilityOn(provider, 'supportsTransparent', 'transparent') ? 'transparent' : null,
                    ignorePixels: s.ignorePixels,
                    signal,
                    onPartial: wantPreview ? (b64, idx) => {
                        showPreview(b64);
                        setStatus(mainI18n.t('status.partial', { number: (idx ?? 0) + 1 }));
                    } : null,
                    onProgress: st => setStatus(st),
                });
                await acceptResult({
                    res, plan, ctx: image.ctx, target: image.target,
                    input: sendPixels ? image.blob : null, refBlobs,
                    refining: false, prompt, provider, model, s,
                    docId: image.docId, stillCurrent,
                });
            },
        });
        if (flight !== talkFlight) return;
        renderTalk();
        if (outcome.accepted) clearComposer();
        const quiet = outcome.generated || outcome.reason === 'blocked' || outcome.reason === 'cancelled';
        if (!quiet) {
            const key = {
                clarify: 'talk.clarify',
                malformed: 'talk.badReply',
                api: 'talk.apiError',
                context: 'talk.context',
                empty: 'talk.empty',
            }[outcome.reason];
            if (key) setTalkState(mainI18n.t(key));
        }
    } catch (e) {
        if (flight !== talkFlight) return;
        if (e && e.cancelled) {
            setStatus(mainI18n.t('status.cancelled'));
        } else {
            console.error('[main] discussion failed');
            setTalkState(mainI18n.t('talk.apiError'));
            setStatus(mainI18n.t('status.error'));
        }
    } finally {
        if (flight === talkFlight) {
            abortCtrl = null;
            setBusy(false);
            try { refreshTransportBadge(); } catch (err) {}
        }
    }
}

async function onGenerate(mode) {
    if (busy) return;
    const refining = mode === 'refine';
    if (refining && !canRefine()) {
        await core.showAlert(mainI18n.t('plan.refineNoRun'));
        return;
    }

    const run = await collectRunInputs(mode);
    if (!run) return;
    const { doc, provider, model, prompt, apiKey, s } = run;

    const docId = doc.id;
    const flight = ++talkFlight;
    abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    setBusy(true);
    showPreview(null);
    const residual = $('residual-text');
    if (residual) residual.textContent = '';

    try {
        let res, plan, ctx, target, input = null, refBlobs = [];

        if (refining) {
            const done = await runRefine({ provider, model, prompt, apiKey, s });
            if (!done) return;
            ({ res, plan, ctx, target } = done);
        } else {
            /* 1. Area */
            const region = await resolveRegion(mode === 'again', doc, s.padPercent);
            if (!region) return;
            ({ target, ctx } = region);

            /* 2. What to ask the provider */
            plan = geometry.planRequest(provider.capsFor(model), ctx, s.quality);
            console.log('[main] request plan:', JSON.stringify(plan), 'ctx', ctx.w + '×' + ctx.h);

            /* 3. Pixels and mask — the user's document does not change */
            const payload = await capturePayload({ s, provider, ctx, target });
            input = payload.input;

            /* 4. Generation — outside the modal context, so Photoshop is not blocked */
            setStatus(mainI18n.t('status.generating'));
            const wantPreview = s.livePreview && provider.supportsStream !== false;
            refBlobs = (provider.supportsReferences !== false)
                ? references.map(r => r.blob) : [];

            res = await provider.generate({
                apiKey, model, prompt,
                imageBlob: input, maskBlob: payload.mask,
                references: refBlobs,
                plan,
                background: s.transparent && capabilityOn(provider, 'supportsTransparent', 'transparent') ? 'transparent' : null,
                ignorePixels: s.ignorePixels,
                signal: abortCtrl ? abortCtrl.signal : undefined,
                onPartial: wantPreview ? (b64, idx) => {
                    showPreview(b64);
                    setStatus(mainI18n.t('status.partial', { number: (idx ?? 0) + 1 }));
                } : null,
                onProgress: st => setStatus(st),
            });
        }

        /* Refine does not overwrite the stored prompt: Regenerate after it means
           the original idea, not the line "make the shadow softer". */
        await acceptResult({
            res, plan, ctx, target, input, refBlobs, refining, prompt, provider, model, s, docId,
        });

    } catch (e) {
        if (flight !== talkFlight) return;
        if (e && e.cancelled) {
            setStatus(mainI18n.t('status.cancelled'));
        } else {
            console.error('[main]', e);
            await core.showAlert(mainI18n.t('error.failed', { error: e && e.message ? e.message : e }));
            setStatus(mainI18n.t('status.error'));
        }
    } finally {
        if (flight === talkFlight) {
            abortCtrl = null;
            setBusy(false);
            // 'auto' may have switched to curl inside this run — the badge must
            // show the actual route, not the one from the start
            try { refreshTransportBadge(); } catch (e) {}
        }
    }
}

/* ── Startup ───────────────────────────────────────────────────────────────── */

/**
 * UI initialization. Each block is in its own try: in the old plugin a
 * ReferenceError in initializeModels aborted initialization, and with it the
 * refine picker and the chat tab died silently.
 */
async function initUI() {
    try {
        const list = providers.list();
        const stored = localStorage.getItem(LS.provider);
        const saved = list.some(p => p.id === stored) ? stored : list[0].id;
        localStorage.setItem(LS.provider, saved);
        fillPicker('provider-select', list.map(p => ({ value: p.id, label: p.label })), saved);
        const picker = $('provider-select');
        if (picker) picker.addEventListener('change', async e => {
            localStorage.setItem(LS.provider, e.target.value);
            localStorage.removeItem(LS.model);
            await window.aiAuth.refreshAuthUI();
            await refreshModels();
            applyProviderCapabilities();
            refreshPlanLine();
        });
    } catch (e) { console.error('[ui] providers:', e.message); }

    try { await refreshModels(); } catch (e) { console.error('[ui] models:', e.message); }

    try { initQuality(); } catch (e) { console.error('[ui] quality:', e.message); }
    try { initTransport(); } catch (e) { console.error('[ui] network route:', e.message); }
    try { applyProviderCapabilities(); } catch (e) { console.error('[ui] capabilities:', e.message); }

    try {
        const bind = (id, key, def, prop = 'value') => {
            const el = $(id);
            if (!el) return;
            const saved = localStorage.getItem(key);
            if (saved !== null) el[prop] = prop === 'checked' ? saved === 'true' : saved;
            else if (def !== undefined) el[prop] = def;
            el.addEventListener('change', () => {
                localStorage.setItem(key, String(prop === 'checked' ? el.checked : el.value));
                refreshPlanLine();
            });
        };
        bind('prompt-input', LS.prompt, '');
        bind('context-pad', LS.pad, '15');
        bind('edge-feather', LS.feather, '16');
        // sp-slider emits the value on the input event, not only on change
        for (const id of ['context-pad', 'edge-feather']) {
            const el = $(id);
            if (el) el.addEventListener('input', () => {
                localStorage.setItem(id === 'context-pad' ? LS.pad : LS.feather, String(el.value));
                schedulePlanLine();
            });
        }
        bind('use-layer-only', LS.layerOnly, false, 'checked');
        bind('lossless-input', LS.lossless, true, 'checked');
        bind('transparent-bg', LS.transparent, false, 'checked');
        bind('ignore-pixels', LS.ignorePixels, false, 'checked');
        bind('live-preview', LS.preview, true, 'checked');
        const prompt = $('prompt-input');
        if (prompt) {
            prompt.addEventListener('input', () => {
                localStorage.setItem(LS.prompt, prompt.value);
                updateCharCount('prompt-input', 'prompt-count');
            });
            // a prompt restored from localStorage can be long too
            updateCharCount('prompt-input', 'prompt-count');
        }
    } catch (e) { console.error('[ui] settings:', e.message); }

    // The render check is AFTER binding, because the substitute removes the element from the DOM.
    try {
        ensureNumericControl('context-pad', LS.pad, [0, 5, 10, 15, 25, 40], '%');
        ensureNumericControl('edge-feather', LS.feather, [0, 8, 16, 32, 64, 128, 256], '');
    } catch (e) { console.error('[ui] numeric controls:', e.message); }

    // load() IS REQUIRED. Without it presetManager starts with an empty array,
    // and the very first add() saved the empty list plus the new item — silently
    // destroying every previously saved preset, and the built-in "Upscale & Enhance"
    // never appeared. The gate is the test "every stateful manager really loads
    // during initialization".
    try { await presetManager.load(); renderPresets(); } catch (e) { console.error('[ui] presets:', e.message); }
    try { await historyManager.load(); renderHistory(); } catch (e) { console.error('[ui] history:', e.message); }
    try { renderCache(); } catch (e) { console.error('[ui] cache:', e.message); }
    try { renderRefs(); renderUsage(); } catch (e) { console.error('[ui] statistics:', e.message); }
    try { await refreshPlanLine(); } catch (e) {}
}

/**
 * A Photoshop event listener so the "what will be requested" line stays alive
 * on its own. The API shape changed (array of strings → array of objects), so we
 * try both and quietly do without it if neither works: the line then updates on
 * a settings change and when the panel is clicked.
 */
function watchSelection() {
    const events = ['set', 'historyStateChanged', 'select'];
    const cb = () => schedulePlanLine();
    try {
        action.addNotificationListener(events.map(event => ({ event })), cb);
        return;
    } catch (e) { /* the other form is below */ }
    try {
        action.addNotificationListener(events, cb);
    } catch (e) {
        console.log('[ui] not listening to selection events:', e.message);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initUI();
    watchSelection();

    const btn = $('talk-send');
    if (btn) btn.addEventListener('click', () => onDiscuss());
    const reset = $('talk-reset');
    if (reset) reset.addEventListener('click', () => resetTalk());
    const composer = $('prompt-input');
    if (composer) composer.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            onDiscuss();
        }
    });

    const regen = $('regen-btn');
    if (regen) regen.addEventListener('click', () => onGenerate('again'));

    const refineBtn = $('refine-btn');
    if (refineBtn) refineBtn.addEventListener('click', () => onGenerate('refine'));

    const cancel = $('cancel-btn');
    if (cancel) cancel.addEventListener('click', () => {
        if (!busy) return;
        stopTalk();
        setStatus(mainI18n.t('status.cancelled'));
    });

    // Esc — cancel the active request.
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && busy && abortCtrl) {
            e.preventDefault();
            stopTalk();
            setStatus(mainI18n.t('status.cancelled'));
        }
    });

    const addRef = $('add-ref-btn');
    if (addRef) addRef.addEventListener('click', pickReferences);
    const clearRef = $('clear-ref-btn');
    if (clearRef) clearRef.addEventListener('click', () => { references = []; renderRefs(); refreshPlanLine(); });

    const clearCache = $('clear-cache-btn');
    if (clearCache) clearCache.addEventListener('click', async () => {
        await cache.clear(); renderCache(); setStatus(mainI18n.t('status.cacheCleared'));
    });

    const clearUsage = $('clear-usage-btn');
    if (clearUsage) clearUsage.addEventListener('click', () => {
        localStorage.removeItem(LS.usage);
        // The old timeless counter is no longer read; clear it together with
        // the new log if it is left over from a previous version.
        localStorage.removeItem(LEGACY.sessionUsage);
        renderUsage();
        setStatus(mainI18n.t('status.usageCleared'));
    });

    const addPreset = $('add-preset-btn');
    if (addPreset) addPreset.addEventListener('click', () => {
        const name = $('new-preset-name')?.value?.trim();
        const content = $('new-preset-content')?.value?.trim();
        if (!name || !content) return;
        presetManager.add(name, content);
        $('new-preset-name').value = '';
        $('new-preset-content').value = '';
        renderPresets();
    });

    // Collapsible sections. Mouse and keyboard are both supported, and
    // aria-expanded stays in sync — in a narrow panel it is also a reliable source of the chevron state.
    for (const [head, body] of [['opts-header', 'opts-body'], ['usage-header', 'usage-body'],
                                ['net-header', 'net-body'],
                                ['ref-header', 'ref-body'], ['cache-header', 'cache-body'],
                                ['preset-header', 'preset-body'], ['history-header', 'history-body'],
                                ['report-header', 'report-body']]) {
        const h = $(head), b = $(body);
        if (!h || !b) continue;
        const sync = () => h.setAttribute('aria-expanded', b.classList.contains('hidden') ? 'false' : 'true');
        const toggle = () => { b.classList.toggle('hidden'); sync(); };
        sync();
        h.addEventListener('click', toggle);
        h.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle();
            }
        });
    }
});

/* The key changed — the model list may have changed with it. */
document.addEventListener('exactfill:keychange', async () => {
    try { await refreshModels(); } catch (e) { console.error('[ui] models after the key:', e.message); }
    try { applyProviderCapabilities(); refreshPlanLine(); } catch (e) {}
});

document.addEventListener('exactfill:localechange', () => {
    initQuality();
    initTransport();
    applyProviderCapabilities();
    renderPresets();
    renderHistory();
    renderCache();
    renderRefs();
    renderUsage();
    renderTalk();
    refreshPlanLine();
});
