const assert = require('node:assert/strict');
const test = require('node:test');

const t = require('../providers/curl-transport.js');

test('the API key never reaches the command line, only the config file', () => {
    const config = t.buildCurlConfig({
        url: 'https://api.openai.com/v1/images/edits',
        method: 'POST',
        headers: { Authorization: 'Bearer sk-secret-value', 'Content-Type': 'application/json' },
        bodyFile: '/tmp/x.body', outFile: '/tmp/x.out', headerFile: '/tmp/x.hdr',
    });
    assert.match(config, /header = "Authorization: Bearer sk-secret-value"/);
    assert.match(config, /data-binary = "@\/tmp\/x\.body"/);
    // ps(1) shows the arguments of any process — the command must not contain secrets.
    // We check the generated script itself: that is the only thing that actually reaches the shell.
    const jsx = t.buildJobJsx({ configFile: '/tmp/x.cfg', codeFile: '/tmp/x.code' });
    assert.doesNotMatch(jsx, /sk-secret-value/);
    assert.doesNotMatch(jsx, /Authorization/);
});

test('status and curl exit code travel through write-out, not through the shell', () => {
    const config = t.buildCurlConfig({
        url: 'https://api.openai.com/v1/models', outFile: '/o', headerFile: '/h',
    });
    // on Windows there is no exit code after `start /b`, so it has to be in -w
    assert.match(config, /write-out = "%\{http_code\} %\{exitcode\}"/);
    assert.deepEqual(t.parseWriteOut('401 0'), { status: 401, curlExit: 0, note: '' });
    assert.deepEqual(t.parseWriteOut('000 28'), { status: 0, curlExit: 28, note: '' });
    assert.equal(t.parseWriteOut('curl: (6) Could not resolve host\n000 6').curlExit, 6);
    assert.match(t.parseWriteOut('curl: (6) Could not resolve host\n000 6').note, /resolve host/);
    assert.equal(t.parseWriteOut(''), null, 'empty file means curl has not finished yet');
});

test('each platform gets its own async launch and quoting', () => {
    // Both branches live in one generated script: ES3 only picks a ready
    // string by $.os, and the quotes were already put there by shellQuote during assembly.
    const jsx = t.buildJobJsx({ configFile: "/tmp/it's.cfg", codeFile: '/tmp/a.code' });
    assert.match(jsx, /cmd \+ " &"/, 'POSIX backgrounds with &');
    assert.match(jsx, /start \\"\\" \/b /, 'cmd needs start /b; & there is sequential, not background');
    assert.ok(jsx.includes(JSON.stringify(t.shellQuote('darwin', "/tmp/it's.cfg"))),
        'single quote inside a path must be escaped by shellQuote, not by a second implementation');
    assert.ok(jsx.includes(JSON.stringify(t.shellQuote('win32', "/tmp/it's.cfg"))),
        'the Windows branch quotes with double quotes');
});

test('config values escape backslashes so Windows paths survive', () => {
    assert.equal(t.quoteConfigValue('C:\\Temp\\a.cfg'), '"C:\\\\Temp\\\\a.cfg"');
    assert.equal(t.quoteConfigValue('say "hi"'), '"say \\"hi\\""');
});

test('non-ASCII work paths are rejected before curl mangles them', () => {
    // cmd on the test machine runs in code page 866: a profile outside ASCII
    // would reach curl corrupted, so such a path is better rejected up front.
    // The samples use accented Latin (é, ä) — same non-ASCII rejection, no Cyrillic required.
    assert.equal(t.isAsciiPath('/Users/zg/Library/Caches/ExactFill'), true);
    assert.equal(t.isAsciiPath('C:\\Users\\Renée\\AppData\\Local\\Temp'), false);
    assert.equal(t.isAsciiPath('/Users/Mär/tmp'), false);
    assert.equal(t.isAsciiPath(''), false);
});

test('generated ExtendScript stays ASCII and ES3', () => {
    const jsx = t.buildJobJsx({ configFile: '/tmp/a.cfg', codeFile: '/tmp/a.code' });
    assert.doesNotMatch(jsx, /[^\x00-\x7F]/, 'do javascript encoding is not guaranteed');
    assert.doesNotMatch(jsx, /\b(?:let|const)\s/, 'ExtendScript is ES3');
    assert.doesNotMatch(jsx, /=>/);
    assert.doesNotMatch(jsx, /\bJSON\b/, 'ExtendScript has no JSON object');
    assert.match(jsx, /app\.system\(/);
    assert.match(jsx, /getenv\("SystemRoot"\)/, 'curl path must be derived, not hardcoded');
    assert.doesNotMatch(jsx, /C:\\\\Windows/);
    assert.throws(() => t.buildJobJsx({ configFile: '/tmp/filé.cfg', codeFile: '/x' }),
        /ASCII/, 'a non-Latin path must fail loudly, not silently');
});

test('curl exit codes turn into explanations, not bare numbers', () => {
    for (const code of [6, 7, 28, 35, 60]) {
        assert.match(t.describeCurlExit(code), /\S/);
        assert.doesNotMatch(t.describeCurlExit(code), /^\d+$/);
    }
    assert.match(t.describeCurlExit(99), /99/, 'unknown codes still report the number');
});

test('response headers are parsed so Retry-After keeps working', () => {
    const headers = t.parseHeaderDump('HTTP/2 429\r\nRetry-After: 12\r\nContent-Type: application/json\r\n');
    assert.equal(headers.get('retry-after'), '12');
    assert.equal(headers.get('Retry-After'), '12', 'header lookup is case-insensitive');
    assert.equal(headers.get('x-missing'), null);
});

test('mode gates the route and auto only switches after a real failure', () => {
    t.setMode('direct');
    t.resetDirectFailure();
    assert.equal(t.active(), false);
    t.noteDirectFailure();
    assert.equal(t.active(), false, 'direct stays direct even after a failure');

    assert.equal(t.setMode('curl'), 'curl');
    assert.equal(t.active(), true);

    t.setMode('auto');
    t.resetDirectFailure();
    assert.equal(t.active(), false, 'auto must not pay for curl until the direct route fails');
    t.noteDirectFailure();
    // There is neither UXP nor a bridge here — exactly the case where the route is unusable.
    // 'auto' must stay direct, otherwise every following request would go
    // into a transport that cannot work.
    assert.equal(t.active(), false, 'auto needs a working bridge, not just a failure');

    assert.equal(t.setMode('nonsense'), 'auto', 'unknown modes fall back to auto');
    t.resetDirectFailure();
});

test('preflight decides the route in seconds instead of waiting out the request timeout', async () => {
    t.setMode('auto');
    t.resetDirectFailure();
    assert.equal(t.isRouteDecided(), false);

    // the direct path answers — even a 403 proves the network is there
    let calls = 0;
    const answering = async () => { calls++; return { ok: false, status: 403 }; };
    assert.equal(await t.decideRoute('https://api.openai.com', { fetchImpl: answering }), false);
    assert.equal(t.isRouteDecided(), true);
    assert.equal(t.active(), false);
    await t.decideRoute('https://api.openai.com', { fetchImpl: answering });
    assert.equal(calls, 1, 'the verdict is cached for the session');

    // a blocked path hangs rather than failing — the deadline is built for that
    t.setMode('auto');
    assert.equal(t.isRouteDecided(), false, 'changing mode must clear the verdict');
    const hanging = (url, init) => new Promise((resolve, reject) => {
        if (init && init.signal) init.signal.addEventListener('abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const started = Date.now();
    // there is no bridge here, so curl stays unavailable and the route does not change,
    // but the point is that the decision arrives in milliseconds, not in 300 s
    assert.equal(await t.decideRoute('https://api.openai.com', { fetchImpl: hanging, timeoutMs: 120 }), false);
    assert.ok(Date.now() - started < 3000, 'a hanging route must not be waited out');
    assert.ok(t.PREFLIGHT_MS <= 10000, 'the real deadline stays in seconds');
});

test('an unavailable bridge is reported, not silently swallowed', async () => {
    const cap = await t.probe();
    assert.equal(cap.ok, false, 'there is no Photoshop in the test runner');
    assert.match(cap.reason, /\S/, 'the reason must be sayable in the panel');
    await assert.rejects(() => t.fetchLike('https://api.openai.com/v1/models'), /\S/);
});

test('streaming asks curl not to buffer, otherwise there is no live preview', () => {
    const streamed = t.buildCurlConfig({ url: 'https://x/y', outFile: '/o', headerFile: '/h', stream: true });
    assert.match(streamed, /^no-buffer$/m);
    const plain = t.buildCurlConfig({ url: 'https://x/y', outFile: '/o', headerFile: '/h' });
    assert.doesNotMatch(plain, /no-buffer/);
});

/* ── Gates on the lifetime of temporary files ──────────────────────────────
 *
 * WHY STATIC, NOT UNITS: curlFetch does require('uxp') and require('photoshop')
 * inside. Node does not have them, and rewriting the module for injection is a
 * bigger risk than the check itself. So we read the source as text: the same
 * trick already used in storage.test.js for the load() call.
 */
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'providers', 'curl-transport.js'), 'utf8');
const slice = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to));

test('curl files are cleaned up even if the request never started', () => {
    // THIS IS NOT DISK HYGIENE, IT IS THE ONLY THING THAT REMOVES THE KEY. The
    // Authorization header was deliberately moved into the --config file so it
    // would not show up in `ps` (the test above). So a .cfg on disk == the API
    // key in the clear. runJsx throws in the normal case — i18n even has a
    // separate transport.bridgeRefused string for it — and that throw used to
    // leave the .cfg in temp forever.
    const body = slice('async function curlFetch', 'async function fetchLike');
    assert.match(body, /catch[\s\S]{0,200}removeQuietly\(created\)/,
        'curlFetch must remove created in the catch and rethrow');
});

test('a streaming request cleans up files even if the consumer throws', () => {
    // removeQuietly used to live ONLY inside read() under `if (done)`. That
    // works while the consumer reads to the end. But requestStream in http.js
    // calls onEvent right in the loop: if the preview handler throws, read()
    // is never called again, and .cfg (the key) and .body (the user's image)
    // stay in temp.
    const body = slice('async function fetchLikeStream', '\nmodule.exports');
    assert.match(body, /pump[\s\S]{0,600}removeQuietly/,
        'cleanup must hang off the end of pump, not only off read()');
});

test('the shell command is built by the same function the tests check', () => {
    // THE TEST AND THE RUNTIME DIVERGED: buildCommand/shellQuote were covered
    // by tests but never called — the real command was assembled by the ES3
    // script's own q(), which did not escape quotes inside a path at all. So
    // the tests were green on a function that is not there in battle. The same
    // class of bug as the forgotten presetManager.load().
    const risky = "/tmp/it's here.cfg";
    const jsx = t.buildJobJsx({ configFile: risky, codeFile: '/tmp/a.code' });
    // not "looks like escaping", but literally the result of the tested function
    assert.ok(jsx.includes(JSON.stringify(t.shellQuote('darwin', risky))),
        'an apostrophe in a path must be escaped by shellQuote itself');
    assert.doesNotMatch(jsx, /function q\(/,
        'no second quoting implementation in ES3 — only shellQuote escapes');
    assert.equal(typeof t.buildCommand, 'undefined',
        'buildCommand is gone: one implementation — one place for a bug');
});
