/* ============================================================================
 *  test/stubs/dom.js — a minimal DOM plus stubs of `uxp` and `photoshop`, so
 *  main.js can ACTUALLY be loaded and run under node.
 *
 *  WHY THIS EXISTS: before this file, no test loaded main.js (1271 lines — the
 *  whole UI, orchestration and startup). It was only read as TEXT in
 *  platform.test.js and storage.test.js. So an initialization bug — a forgotten
 *  await, a call to a function that does not exist, a broken require after a
 *  refactor — was caught by nothing except running Photoshop by hand.
 *
 *  The tree is built from the REAL index.html: every element that has an id,
 *  together with its attributes. So the stand cannot drift from the markup —
 *  delete an element in the HTML, and a test will see it.
 *
 *  This is not a browser and not UXP. There is no layout, no CSS, and no real
 *  selector parser. The one goal is to walk the initialization path and see
 *  what ended up in the DOM.
 * ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..', '..');

/* ── DOM ───────────────────────────────────────────────────────────────────── */

class ClassList {
    constructor(el) { this.el = el; this.items = new Set(); }
    add(...c) { for (const x of c) if (x) this.items.add(x); this.sync(); }
    remove(...c) { for (const x of c) this.items.delete(x); this.sync(); }
    contains(c) { return this.items.has(c); }
    toggle(c, force) {
        const on = force === undefined ? !this.items.has(c) : Boolean(force);
        if (on) this.items.add(c); else this.items.delete(c);
        this.sync();
        return on;
    }
    sync() { this.el.classText = [...this.items].join(' '); }
    toString() { return [...this.items].join(' '); }
}

/** Exactly two kinds of selectors are supported: `.class` and `tag`. The code asks for nothing more. */
function matches(el, sel) {
    const s = String(sel).trim();
    return s.startsWith('.') ? el.classList.contains(s.slice(1)) : el.tagName === s.toLowerCase();
}

class El {
    constructor(tag) {
        this.tagName = String(tag).toLowerCase();
        this.children = [];
        this.parentNode = null;
        this.attributes = {};
        this.dataset = {};
        this.style = {};
        this.listeners = {};
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.text = '';
        this.classText = '';
        this.classList = new ClassList(this);
        // by default "the element drew": otherwise ensureNumericControl
        // would substitute everything, and the test would check only the fallback path
        this.offsetHeight = 12;
    }
    get className() { return this.classText; }
    set className(v) {
        this.classText = String(v || '');
        this.classList.items = new Set(this.classText.split(/\s+/).filter(Boolean));
    }
    get textContent() {
        return this.children.length ? this.children.map(c => c.textContent).join('') : this.text;
    }
    set textContent(v) { this.text = v == null ? '' : String(v); this.children = []; }
    get innerHTML() { return this.children.map(c => `<${c.tagName}>`).join(''); }
    set innerHTML(v) { if (!v) this.children = []; }
    get parentElement() { return this.parentNode; }
    get id() { return this.attributes.id || ''; }
    set id(v) { this.attributes.id = String(v); }

    setAttribute(n, v) { this.attributes[n] = String(v); }
    getAttribute(n) { return n in this.attributes ? this.attributes[n] : null; }
    removeAttribute(n) { delete this.attributes[n]; }
    hasAttribute(n) { return n in this.attributes; }

    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    append(...cs) { for (const c of cs) this.appendChild(c); }
    removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; }
        return c;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    replaceWith(next) {
        const p = this.parentNode;
        if (!p) return;
        p.children[p.children.indexOf(this)] = next;
        next.parentNode = p;
        this.parentNode = null;
    }
    insertBefore(node, ref) {
        const i = ref ? this.children.indexOf(ref) : this.children.length;
        this.children.splice(i < 0 ? this.children.length : i, 0, node);
        node.parentNode = this;
        return node;
    }

    focus() {
        let root = this;
        while (root.parentNode) root = root.parentNode;
        root.activeElement = this;
    }
    dispatchEvent(ev) {
        const type = ev && ev.type;
        for (const fn of (this.listeners[type] || []).slice()) fn(ev);
        return true;
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn) {
        const l = this.listeners[type];
        if (l) this.listeners[type] = l.filter(f => f !== fn);
    }
    /** Synchronous event dispatch — the test decides when to "press" it. */
    fire(type, ev = {}) {
        for (const fn of (this.listeners[type] || []).slice()) fn({ target: this, preventDefault() {}, ...ev });
    }

    descendants() {
        const out = [];
        const walk = e => { for (const c of e.children) { out.push(c); walk(c); } };
        walk(this);
        return out;
    }
    querySelectorAll(sel) { return this.descendants().filter(e => matches(e, sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

class Doc extends El {
    constructor() { super('#document'); }
    createElement(tag) { return new El(tag); }
    createTextNode(t) { const e = new El('#text'); e.textContent = t; return e; }
    /** A tree walk, not a map: fillPicker and ensureNumericControl REPLACE nodes, keeping the id. */
    getElementById(id) { return this.descendants().find(e => e.attributes.id === id) || null; }
    get documentElement() { return this; }
    get body() { return this; }
}

/* ── Tree from the real index.html ─────────────────────────────────────────── */

const TAG_WITH_ID = /<([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\bid="([^"]+)"([^<>]*)>/g;

function buildFromHtml(html) {
    const doc = new Doc();
    let m;
    while ((m = TAG_WITH_ID.exec(html)) !== null) {
        const [, tag, before, id, after] = m;
        const el = doc.createElement(tag);
        el.setAttribute('id', id);
        const raw = `${before} ${after}`;
        for (const [, name, value] of raw.matchAll(/([\w-]+)="([^"]*)"/g)) {
            if (name !== 'id') el.setAttribute(name, value);
        }
        /* Boolean attributes are written WITHOUT a value (`disabled`, `checked`),
           so the name="value" pair above does not see them. Until this existed, a
           button that is grey in the markup arrived at the stand enabled — and the
           "grey at start" test would have passed because the stand was lenient, not because of the code. */
        for (const flag of ['disabled', 'checked', 'hidden', 'readonly']) {
            if (!el.hasAttribute(flag) && new RegExp(`(^|\\s)${flag}(\\s|$)`).test(raw)) {
                el.setAttribute(flag, '');
            }
        }
        if (el.hasAttribute('disabled')) el.disabled = true;
        if (el.hasAttribute('checked')) el.checked = true;
        if (el.hasAttribute('class')) el.className = el.getAttribute('class');
        if (tag === 'textarea' || tag.startsWith('sp-')) el.value = '';
        doc.appendChild(el);
    }
    return doc;
}

/* ── Host stubs ────────────────────────────────────────────────────────────── */

const photoshopStub = {
    app: { activeDocument: null, documents: [] },
    core: { executeAsModal: async fn => fn({}, {}), showAlert: async () => {} },
    action: {
        batchPlay: async () => [{}],
        addNotificationListener: () => { throw new Error('no notifications in the stub'); },
    },
};

const uxpStub = {
    storage: {
        formats: { utf8: 'utf8', binary: 'binary' },
        secureStorage: {
            async getItem(key) {
                if (!this._map.has(key)) throw new Error('not found');
                return this._map.get(key);
            },
            async setItem(key, value) { this._map.set(key, String(value)); },
            async removeItem(key) { this._map.delete(key); },
            _map: new Map(),
        },
        localFileSystem: {
            getTemporaryFolder: async () => { throw new Error('no filesystem in the stub'); },
            getFileForOpening: async () => null,
            createSessionToken: () => 'token',
        },
    },
    shell: { openExternal: async () => {} },
    host: { name: 'Photoshop', version: '27.5.0', uiLocale: 'uk' },
};

/**
 * Installs the globals and intercepts require('photoshop') / require('uxp').
 * Returns { doc, storage } — the state a test checks after initialization.
 */
function install({ locale = 'uk', storage = {} } = {}) {
    const doc = buildFromHtml(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
    const store = new Map(Object.entries(storage));

    global.document = doc;
    global.localStorage = {
        getItem: k => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: k => store.delete(k),
        clear: () => store.clear(),
        get length() { return store.size; },
        key: i => [...store.keys()][i] ?? null,
    };
    global.Blob = class Blob {
        constructor(parts = [], opts = {}) {
            this.type = opts.type || '';
            this.size = parts.reduce((n, p) => n + (p.byteLength || p.length || 0), 0);
        }
    };
    global.window = {
        document: doc,
        // there is no key — that is the normal state of a first launch, and it
        // must get through initialization without exceptions
        aiAuth: {
            getKey: async () => { throw new Error('key not set'); },
            refreshAuthUI: async () => {},
        },
        addEventListener() {}, setTimeout, clearTimeout,
    };
    global.navigator = { language: locale };

    const original = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        if (request === 'photoshop' || request === 'uxp') {
            return path.join(__dirname, request === 'photoshop' ? 'photoshop.js' : 'uxp.js');
        }
        return original.call(this, request, ...rest);
    };
    require.cache[path.join(__dirname, 'photoshop.js')] = { id: 'photoshop', filename: 'photoshop.js', loaded: true, exports: photoshopStub };
    require.cache[path.join(__dirname, 'uxp.js')] = { id: 'uxp', filename: 'uxp.js', loaded: true, exports: uxpStub };

    return { doc, store, photoshop: photoshopStub, uxp: uxpStub, restore: () => { Module._resolveFilename = original; } };
}

module.exports = { install, El, Doc, buildFromHtml };
