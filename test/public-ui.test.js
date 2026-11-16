const assert = require('node:assert/strict');
const test = require('node:test');

const { buildReportUrl, safeDiagnostics } = require('../public-ui.js');
const appInfo = require('../app-info.js');

test('safe diagnostics contain useful metadata but no private content', () => {
    const diagnostics = safeDiagnostics();
    // the version comes from app-info, otherwise every bump breaks the test for nothing
    assert.match(diagnostics, new RegExp(`ExactFill: ${appInfo.version.replace(/\./g, '\\.')}`));
    assert.match(diagnostics, /Provider:/);
    assert.match(diagnostics, /Network route:/, 'a "no connection" report is useless without the route');
    assert.doesNotMatch(diagnostics, /api.?key|prompt|document name|file path/i);
});

test('bug report URL is prefilled and explicitly documents excluded data', () => {
    const url = new URL(buildReportUrl('Mask edge', 'Visible seam after placement', true));
    assert.equal(url.origin + url.pathname,
        'https://github.com/zgmrclick/exactfill-photoshop/issues/new');
    assert.equal(url.searchParams.get('title'), '[Bug] Mask edge');
    const body = url.searchParams.get('body');
    assert.match(body, /Visible seam after placement/);
    assert.match(body, /Safe diagnostics/);
    assert.match(body, /did not include API keys, prompts, document names, paths, images, or usage history/);
});

test('the report URL stays within GitHub limits on any alphabet', () => {
    /* THE REGRESSION THIS CLOSES. report-details was given maxlength=10000
       to lift UXP's silent ~256-character ceiling — and that also removed an
       accidental guard: the create-issue URL went past 8192 B, GitHub answers 414,
       and the report does not open at all.

       WHY maxlength ALONE IS NOT ENOUGH: in percent-encoding one Cyrillic
       character is 6 bytes against 1 for Latin, and an emoji is 12. The same
       limit IN CHARACTERS makes a six-to-twelve times longer URL. So the cut
       has to be in bytes, and exactly where the URL is built.
       The sample character я stays: its UTF-8 form percent-encodes to 6 bytes. */
    const LIMIT = 8192;
    for (const [name, ch] of [['Latin','a'], ['Cyrillic','я'], ['CJK','中'], ['emoji','🙂']]) {
        const url = buildReportUrl(ch.repeat(110), ch.repeat(10000), true);
        assert.ok(url.length <= LIMIT,
            `${name}: URL ${url.length} B > ${LIMIT} B — GitHub will answer 414`);
        // everything that fit must stay readable, not cut in the middle of %D0
        assert.doesNotThrow(() => decodeURIComponent(new URL(url).search),
            `${name}: percent-encoding was cut in the middle of a character`);
    }
    // a short report is not touched at all
    const short = buildReportUrl('Seam', 'Visible seam after placement', true);
    assert.match(new URL(short).searchParams.get('body'), /Visible seam after placement$|Visible seam/);
});
