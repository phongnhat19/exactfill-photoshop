/* ============================================================================
 *  providers/curl-transport.js — the network OUTSIDE the Photoshop process.
 *
 *  The job: if a firewall blocks Photoshop's outbound connections (a per-process
 *  rule), the plugin still works. The request is made by a separate `curl`
 *  binary, which ships with both macOS and Windows 10+ — no install and no sidecar.
 *
 *  The chain (every link measured in PS 27.5.0):
 *    UXP → session token → batchPlay 'AdobeScriptAutomation Scripts'
 *        → a generated ES3 script → app.system("curl … &")
 *        → polling the response files → a Response-like object
 *
 *  WHY THE SCRIPT IS GENERATED, NOT CHECKED IN: the
 *  'AdobeScriptAutomation Scripts' event has no channel for arguments. The only
 *  way to pass the command is to embed it in the script text. The API key does
 *  NOT enter that text: it lives only in the `--config` file, so `ps` cannot see it.
 *
 *  WHY nativePath: building a shell command needs real paths. UXP itself creates
 *  the files in its own temporary folder, so reading and cleanup go through those
 *  same Entry objects (`entry.delete()`), not through guessed paths. Inserting
 *  the result into the document stays as before — via a session token, not a path.
 * ========================================================================== */

const curlI18n = require('../i18n.js');

/** Hosts the plugin may ask curl to contact. Anything else is refused before a process starts. */
const ALLOWED_HOSTS = new Set([
    'api.openai.com',
    'generativelanguage.googleapis.com',
    'api.wavespeed.ai',
    'openrouter.ai',
]);

function allowedUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && ALLOWED_HOSTS.has(parsed.host);
    } catch (e) {
        return false;
    }
}

function assertAllowedUrl(url) {
    if (!allowedUrl(url)) {
        let host = 'invalid-url';
        try { host = new URL(url).host || host; } catch (e) {}
        throw new Error(`Blocked network host: ${host}`);
    }
}

/** Transport state: 'auto' | 'direct' | 'curl'. The decision is in active(). */
let mode = 'auto';
/** Cache of the capability check: null | { ok, reason } */
let capability = null;
/** Synchronous copy of capability.ok — active() cannot be async. */
let capabilityOk = false;
/** Whether direct fetch failed on the network — the reason 'auto' may switch to curl. */
let directFailed = false;
/** Preflight result: whether the route is decided, and which one. */
let routeDecided = false;
let routeUseCurl = false;
let seq = 0;

/**
 * How long to wait for first contact before calling the direct path impassable.
 *
 * WHY THIS IS SEPARATE FROM THE REQUEST timeoutMs: a stream blocked by a firewall
 * does not refuse, it HANGS (measured: 20–30 s in the "no rule yet" state). If we
 * waited out the generation timeout, the user would stare at "Generating…" for up
 * to 300 s and only then get the switch. A preflight on a cheap keyless request
 * decides the route in seconds, and only once per session.
 */
const PREFLIGHT_MS = 6000;

function platform() {
    try { return require('os').platform(); } catch (e) { return 'unknown'; }
}

const isWindows = () => platform() === 'win32';

/* ── Pure functions (tested under Node, without Photoshop) ──────────────────── */

/**
 * ASCII check for a path.
 *
 * Windows cmd runs in an OEM code page (on our test machine `chcp` = 866).
 * A path with non-Latin characters — a user profile may well be a non-ASCII
 * "C:\Users\<name>" — reaches curl corrupted. Better to detect an unfit path
 * ahead of time and keep the direct fetch than to produce an opaque error.
 */
function isAsciiPath(p) {
    return typeof p === 'string' && p.length > 0 && !/[^\x20-\x7E]/.test(p);
}

/** A value for the `--config` file: double quotes, backslashes escaped. */
function quoteConfigValue(value) {
    return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * The `--config` file for curl. The URL, method, headers (including
 * Authorization) and paths live here — everything sensitive stays in a file
 * with the user's permissions, not in the process arguments.
 */
function buildCurlConfig({ url, method = 'GET', headers = {}, bodyFile, outFile,
                           headerFile, timeoutSec = 300, stream = false }) {
    const lines = [
        'url = ' + quoteConfigValue(url),
        'request = ' + quoteConfigValue(method),
        'silent',
        'show-error',
        'max-time = ' + String(Math.max(1, Math.round(timeoutSec))),
        'output = ' + quoteConfigValue(outFile),
        'dump-header = ' + quoteConfigValue(headerFile),
        // take the status and exit code from stdout, not from app.system's code:
        // on Windows after `start /b` there is no exit code at all
        'write-out = ' + quoteConfigValue('%{http_code} %{exitcode}'),
    ];
    if (stream) lines.push('no-buffer');
    for (const [name, value] of Object.entries(headers || {})) {
        if (value === undefined || value === null) continue;
        lines.push('header = ' + quoteConfigValue(`${name}: ${value}`));
    }
    if (bodyFile) lines.push('data-binary = ' + quoteConfigValue('@' + bodyFile));
    return lines.join('\n') + '\n';
}

/** Quotes for the target platform's shell. */
function shellQuote(plat, value) {
    const s = String(value);
    if (plat === 'win32') return '"' + s.replace(/"/g, '""') + '"';
    return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/**
 * Text of a one-shot ES3 script.
 *
 * ExtendScript here is ES3: no let, no arrows, no JSON. And ASCII only: the
 * encoding of `do javascript` / the event is not guaranteed, and any non-ASCII
 * becomes mojibake. The path to curl is computed inside the script ($.getenv),
 * so the plugin's runtime code contains no absolute system path.
 */
function buildJobJsx({ configFile, codeFile }) {
    /* QUOTING IS DONE BY shellQuote — the same function the tests see.
       There used to be a SECOND implementation here: an ES3 function q() that
       did not escape quotes inside a path at all. The worst combination: tests
       went green on buildCommand, which did not exist in production, while
       production ran the untested q(). A path with an apostrophe broke the
       command, curl never started, and the user saw not an error but a silent
       polling timeout. */
    const lit = (plat, v) => JSON.stringify(shellQuote(plat, v));
    const jsx = [
        '// generated by ExactFill; disposable',
        'var win = $.os.indexOf("Windows") >= 0;',
        // the path to curl is computed in place: the plugin code must contain
        // no absolute system path (straight quotes — SystemRoot cannot contain quotes)
        'var curl = win ? ("\\"" + $.getenv("SystemRoot") + "\\\\System32\\\\curl.exe\\"") : ' + lit('darwin', '/usr/bin/curl') + ';',
        'var cfg  = win ? ' + lit('win32', configFile) + ' : ' + lit('darwin', configFile) + ';',
        'var code = win ? ' + lit('win32', codeFile) + ' : ' + lit('darwin', codeFile) + ';',
        'var cmd = curl + " --config " + cfg + " > " + code + " 2>&1";',
        'cmd = win ? ("start \\"\\" /b " + cmd) : (cmd + " &");',
        'var rc = -1;',
        'try { rc = app.system(cmd); } catch (e) { rc = "threw:" + e; }',
        '"spawned rc=" + rc;',
    ].join('\n');
    if (/[^\x00-\x7F]/.test(jsx)) throw new Error('generated jsx must stay ASCII');
    return jsx;
}

/** `-w` returns "<http_code> <exitcode>"; a curl error may append text. */
function parseWriteOut(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    const m = raw.match(/(\d{3})\s+(\d+)\s*$/);
    if (!m) return { status: 0, curlExit: -1, note: raw.slice(0, 300) };
    const note = raw.slice(0, m.index).trim();
    return { status: Number(m[1]), curlExit: Number(m[2]), note: note.slice(0, 300) };
}

/** Headers from `dump-header` → a minimal headers.get(). */
function parseHeaderDump(text) {
    const map = new Map();
    for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        map.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
    }
    return { get: name => (map.has(String(name).toLowerCase()) ? map.get(String(name).toLowerCase()) : null) };
}

/** A human explanation of the curl exit codes that actually occur. */
function describeCurlExit(code) {
    if (code === 6) return curlI18n.t('transport.curlDns');
    if (code === 7) return curlI18n.t('transport.curlRefused');
    if (code === 28) return curlI18n.t('transport.curlTimeout');
    if (code === 35 || code === 60) return curlI18n.t('transport.curlTls');
    return curlI18n.t('transport.curlFailed', { code: String(code) });
}

/* ── Runtime ───────────────────────────────────────────────────────────────── */

function setMode(next) {
    mode = ['auto', 'direct', 'curl'].includes(next) ? next : 'auto';
    routeDecided = false;               // a manual choice cancels the previous verdict
    routeUseCurl = false;
    return mode;
}
const getMode = () => mode;
const noteDirectFailure = () => { directFailed = true; };
const resetDirectFailure = () => { directFailed = false; };
const isRouteDecided = () => routeDecided;

/**
 * Preflight: one cheap keyless request to learn whether the direct path works
 * at all. Any HTTP response (even 401/403/404) means "the network works" — we
 * care that a response arrived, not what its code was.
 */
async function decideRoute(origin, { fetchImpl, timeoutMs = PREFLIGHT_MS } = {}) {
    assertAllowedUrl(origin.endsWith('/') ? origin : origin + '/');
    if (routeDecided) return routeUseCurl;
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    routeDecided = true;
    routeUseCurl = false;
    if (!doFetch) return routeUseCurl;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
        await doFetch(origin + '/', { method: 'GET', signal: ctrl ? ctrl.signal : undefined });
        console.log('[curl] preflight: direct path works');
    } catch (e) {
        const cap = await probe();
        routeUseCurl = cap.ok;
        console.log(routeUseCurl
            ? `[curl] preflight: direct path did not answer (${e && e.message}) — using curl`
            : `[curl] preflight: direct path did not answer, curl is also unavailable (${cap.reason})`);
    } finally {
        if (timer) clearTimeout(timer);
    }
    return routeUseCurl;
}

/**
 * Whether we should go through curl right now.
 *
 * In 'auto' a direct-path failure is not enough: if the capability check failed
 * (no bridge, a non-ASCII path), the route is unfit, and returning true here
 * would send every later request into a transport that does not work.
 */
function active() {
    if (mode === 'direct') return false;
    if (mode === 'curl') return true;
    return routeUseCurl || (directFailed && capabilityOk);
}

async function tempFolder() {
    const lfs = require('uxp').storage.localFileSystem;
    return lfs.getTemporaryFolder();
}

/** Creates (overwrites) a file in the plugin's temporary folder. */
async function makeFile(folder, name) {
    const { storage } = require('uxp');
    return folder.createFile(name, { overwrite: true });
}

async function writeText(entry, text) {
    const { formats } = require('uxp').storage;
    await entry.write(text, { format: formats.utf8 });
}

async function writeBinary(entry, data) {
    const { formats } = require('uxp').storage;
    await entry.write(data, { format: formats.binary });
}

async function readTextSafe(entry) {
    const { formats } = require('uxp').storage;
    try { return await entry.read({ format: formats.utf8 }); } catch (e) { return ''; }
}

async function removeQuietly(entries) {
    for (const entry of entries) {
        if (!entry) continue;
        try { await entry.delete(); } catch (e) { /* stays in temp, not critical */ }
    }
}

/**
 * A one-shot capability check: a temp folder with an ASCII path and a working
 * bridge to ExtendScript. The result is cached — this is not free.
 */
async function probe() {
    if (capability) return capability;
    try {
        const folder = await tempFolder();
        if (!isAsciiPath(folder.nativePath)) {
            // the path is logged on purpose: without it you cannot tell why the
            // transport refused on someone else's machine (the likeliest cause is a
            // non-Latin user name, and a Windows profile is made of exactly that)
            console.log(`[curl] work folder is not ASCII, keeping the direct path: ${folder.nativePath}`);
            capability = { ok: false, reason: curlI18n.t('transport.nonAsciiPath') };
            capabilityOk = false;
            return capability;
        }
        const probeJsx = await makeFile(folder, 'exactfill-probe.jsx');
        await writeText(probeJsx, '"exactfill-bridge-ok";');
        const answer = await runJsx(probeJsx);
        await removeQuietly([probeJsx]);
        capability = answer === 'exactfill-bridge-ok'
            ? { ok: true, reason: '' }
            : { ok: false, reason: curlI18n.t('transport.bridgeUnavailable') };
    } catch (e) {
        capability = { ok: false, reason: e && e.message ? e.message : String(e) };
    }
    capabilityOk = capability.ok === true;
    return capability;
}

/**
 * Runs an ExtendScript file and returns its result.
 *
 * The event does NOT accept a native path: `{_path:'/abs'}` yields "invalid file
 * token used". Only a session token works, and only inside executeAsModal.
 * The value the script returned arrives in `javaScriptMessage` — that is the
 * return channel, so small answers do not need to be shuttled through files.
 */
async function runJsx(entry) {
    const { action, core } = require('photoshop');
    const lfs = require('uxp').storage.localFileSystem;
    const token = lfs.createSessionToken(entry);
    const result = await core.executeAsModal(
        () => action.batchPlay([{
            _obj: 'AdobeScriptAutomation Scripts',
            javaScript: { _path: token, _kind: 'local' },
            _options: { dialogOptions: 'dontDisplay' },
        }], { synchronousExecution: false }),
        { commandName: 'ExactFill network request' });
    const first = result && result[0];
    if (first && first._obj === 'error') throw new Error(curlI18n.t('transport.bridgeRefused'));
    return first ? first.javaScriptMessage : undefined;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * A Response-like object over curl's files: exactly what http.js uses
 * (`ok`, `status`, `headers.get`, `text()`, `body.getReader()`), and nothing more.
 * Because of that, providers and SSE parsing stay unchanged.
 */
async function curlFetch(url, { method = 'GET', headers = {}, body,
                                timeoutMs = 300000, signal, stream = false } = {}) {
    assertAllowedUrl(url);
    const cap = await probe();
    if (!cap.ok) throw new Error(cap.reason);

    const folder = await tempFolder();
    const id = `exactfill-${Date.now().toString(36)}-${++seq}`;
    const files = {};
    const created = [];
    /* THIS try IS NOT DISK HYGIENE. The .cfg holds the Authorization header
       together with the API key: it was deliberately moved into a file so it
       would not show up in `ps`. So cleaning up the files is the only thing that
       removes the key. Any throw after the files were created (the likeliest is
       runJsx, which has its own transport.bridgeRefused in i18n) used to leave
       the key in temp forever. */
    try {
    for (const [key, suffix] of [['cfg', '.cfg'], ['out', '.out'], ['hdr', '.hdr'],
                                 ['code', '.code'], ['jsx', '.jsx']]) {
        files[key] = await makeFile(folder, id + suffix);
        created.push(files[key]);
    }
    let bodyEntry = null;
    if (body !== undefined && body !== null) {
        bodyEntry = await makeFile(folder, id + '.body');
        created.push(bodyEntry);
        if (typeof body === 'string') await writeText(bodyEntry, body);
        else await writeBinary(bodyEntry, body instanceof Uint8Array ? body.buffer : body);
    }

    for (const entry of created) {
        if (!isAsciiPath(entry.nativePath)) {
            await removeQuietly(created);
            throw new Error(curlI18n.t('transport.nonAsciiPath'));
        }
    }

    await writeText(files.cfg, buildCurlConfig({
        url, method, headers,
        bodyFile: bodyEntry ? bodyEntry.nativePath : null,
        outFile: files.out.nativePath,
        headerFile: files.hdr.nativePath,
        timeoutSec: Math.ceil(timeoutMs / 1000),
        stream,
    }));
    await writeText(files.jsx, buildJobJsx({
        configFile: files.cfg.nativePath,
        codeFile: files.code.nativePath,
    }));

    const spawned = await runJsx(files.jsx);
    console.log(`[curl] ${method} ${new URL(url).host} — ${spawned}`);

    /** Polling: wait until curl finishes writing the status file. */
    async function waitForCompletion(onPartial) {
        const started = Date.now();
        let seen = 0;
        for (;;) {
            if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            const code = parseWriteOut(await readTextSafe(files.code));
            if (onPartial) {
                const text = await readTextSafe(files.out);
                if (text.length > seen) { onPartial(text.slice(seen)); seen = text.length; }
            }
            if (code) return code;
            if (Date.now() - started > timeoutMs + 5000) {
                throw Object.assign(new Error('timeout'), { name: 'AbortError' });
            }
            await sleep(stream ? 250 : 400);
        }
    }

    return { files, created, waitForCompletion, removeQuietly, readTextSafe };
    } catch (e) {
        await removeQuietly(created);
        throw e;
    }
}

/**
 * A wrapper with the Response interface for a non-streaming request.
 * Errors stay the same types as on the direct path: body parsing, retry-after
 * and message text are done by http.js.
 */
async function fetchLike(url, init = {}) {
    const run = await curlFetch(url, init);
    const started = Date.now();
    try {
        const code = await run.waitForCompletion(null);
        console.log(`[curl] ← ${code.status} (curl exit ${code.curlExit}) in ${Date.now() - started} ms`);
        if (code.curlExit !== 0 || code.status === 0) {
            const detail = describeCurlExit(code.curlExit);
            throw new Error(code.note ? `${detail} (${code.note})` : detail);
        }
        const text = await run.readTextSafe(run.files.out);
        const headers = parseHeaderDump(await run.readTextSafe(run.files.hdr));
        return {
            ok: code.status >= 200 && code.status < 300,
            status: code.status,
            headers,
            text: async () => text,
            body: null,
        };
    } finally {
        await run.removeQuietly(run.created);
    }
}

/**
 * Streaming variant: a reader over a growing file. Intermediate frames are real —
 * the curl file grows during the request (measured: 50 KB/s, steadily, per second).
 */
async function fetchLikeStream(url, init = {}) {
    const run = await curlFetch(url, { ...init, stream: true });
    const chunks = [];
    let done = false;
    let failure = null;
    let finalText = '';

    /* Cleanup used to live ONLY inside read() under `if (done)`. That works
       while the consumer reads to the end — but requestStream in http.js calls
       onEvent right in the read loop. If the preview handler throws, read() is
       never called again: .cfg (the API key) and .body (the user's image) stay
       in temp. Cleanup now hangs off the end of pump and runs exactly once. */
    let cleaned = false;
    const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        await run.removeQuietly(run.created);
    };

    const pump = run.waitForCompletion(part => chunks.push(part))
        .then(code => {
            console.log(`[curl] ← stream ${code.status} (curl exit ${code.curlExit})`);
            if (code.curlExit !== 0 || code.status === 0) {
                failure = new Error(code.note
                    ? `${describeCurlExit(code.curlExit)} (${code.note})`
                    : describeCurlExit(code.curlExit));
            }
            return code;
        })
        .catch(e => { failure = e; return null; })
        .then(async code => {
            // the last read BEFORE deletion: after delete the file cannot be read,
            // and text() is http.js's fallback when a reader is unavailable
            finalText = await run.readTextSafe(run.files.out);
            done = true;
            await cleanup();
            return code;
        });

    // the status is known only after curl finishes, so for SSE we return 200
    // optimistically, and throw the real error in the reader — that is where http.js catches it
    return {
        ok: true,
        status: 200,
        headers: parseHeaderDump(''),
        text: async () => { await pump; return finalText; },
        body: {
            getReader() {
                return {
                    async read() {
                        for (;;) {
                            if (chunks.length) return { done: false, value: chunks.shift() };
                            if (done) {
                                await cleanup();
                                if (failure) throw failure;
                                return { done: true, value: undefined };
                            }
                            await sleep(200);
                        }
                    },
                };
            },
        },
    };
}

module.exports = {
    // pure, for tests
    allowedUrl, isAsciiPath, quoteConfigValue, buildCurlConfig, shellQuote,
    buildJobJsx, parseWriteOut, parseHeaderDump, describeCurlExit,
    // state and runtime
    setMode, getMode, active, noteDirectFailure, resetDirectFailure,
    isRouteDecided, decideRoute, PREFLIGHT_MS,
    probe, fetchLike, fetchLikeStream,
};
