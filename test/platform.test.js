const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const appInfo = require('../app-info.js');

/* THE LIST IS DERIVED FROM THE FILE SYSTEM, NOT WRITTEN BY HAND.
   It used to be a literal — and a new module simply did not exist for any of
   the checks below: neither "no absolute paths", nor "the bridge in only one
   module", nor (worst) "the build forgot no file". So you could add a module,
   build a release without it and get green tests on a ZIP that does not work.
   Now a new file automatically falls under every gate, and the build has to
   be updated — because otherwise the test fails. */
const runtimeFiles = [
    ...fs.readdirSync(ROOT).filter(f => f.endsWith('.js')),
    ...fs.readdirSync(path.join(ROOT, 'providers'))
        .filter(f => f.endsWith('.js')).map(f => `providers/${f}`),
].sort();

// The only file that needs native paths by the nature of the task: to build a
// command for the system shell. UXP itself creates the files in its temp folder,
// so reading and cleanup go through those same Entry objects. Insertion into the
// document stays as before — through a session token, and this exception does not cover it.
const NATIVE_PATH_ALLOWED = new Set(['providers/curl-transport.js']);

test('public metadata and manifest stay aligned', () => {
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.version, appInfo.version);
    assert.equal(manifest.name, 'ExactFill');
    assert.equal(appInfo.name, 'ExactFill');
    assert.equal(appInfo.supportUrl, 'https://ko-fi.com/havryil89140');
    assert.equal(manifest.id, appInfo.id, 'plugin id must stay stable so private-build settings survive');
    assert.match(appInfo.repository, /zgmrclick\/exactfill-photoshop$/);
    assert.equal(manifest.manifestVersion, 5);
    assert.equal(manifest.host?.minVersion, '25.0.0');
    assert.equal(manifest.entrypoints?.[0]?.label?.default, 'ExactFill');
    assert.deepEqual(manifest.entrypoints?.[0]?.minimumSize, { width: 230, height: 260 });
    assert.deepEqual(manifest.entrypoints?.[0]?.preferredDockedSize, { width: 300, height: 600 });
    assert.deepEqual(manifest.entrypoints?.[0]?.preferredFloatingSize, { width: 320, height: 680 });
    assert.equal(manifest.icons?.[0]?.path, 'icons/exactfill.svg');
    assert.deepEqual(manifest.entrypoints?.[0]?.icons?.map(icon => icon.path),
        ['icons/panel-dark.png', 'icons/panel-light.png']);
    assert.deepEqual(manifest.entrypoints?.[0]?.icons?.map(icon => icon.scale), [[1, 2], [1, 2]]);
    for (const [file, size] of [['panel-dark@1x.png', 23], ['panel-dark@2x.png', 46],
                                ['panel-light@1x.png', 23], ['panel-light@2x.png', 46]]) {
        const png = fs.readFileSync(path.join(ROOT, 'icons', file));
        assert.equal(png.subarray(1, 4).toString(), 'PNG', `${file} must be a PNG`);
        assert.equal(png.readUInt32BE(16), size, `${file} width`);
        assert.equal(png.readUInt32BE(20), size, `${file} height`);
        assert.equal(png[25], 6, `${file} must use RGBA truecolor, like Photoshop's native panel icons`);
    }
});

test('manifest v5 has the same permissions on macOS and Windows', () => {
    assert.equal(manifest.requiredPermissions?.localFileSystem, 'request');
    assert.deepEqual(manifest.requiredPermissions?.launchProcess?.schemes, ['https']);
    assert.ok(manifest.requiredPermissions?.network?.domains?.includes('https://api.openai.com'));
    assert.ok(manifest.requiredPermissions?.network?.domains?.includes('https://generativelanguage.googleapis.com'));
});

test('runtime contains no absolute platform-specific paths', () => {
    for (const file of runtimeFiles) {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.doesNotMatch(source, /\/Applications\//, `${file}: macOS absolute path`);
        assert.doesNotMatch(source, /[A-Za-z]:\\\\(?:Program Files|Users|Windows)\\\\/, `${file}: Windows absolute path`);
        if (!NATIVE_PATH_ALLOWED.has(file)) {
            assert.doesNotMatch(source, /\.nativePath\b/, `${file}: nativePath bypasses UXP tokens`);
        }
    }
});

test('the curl transport keeps its dangerous parts contained', () => {
    const source = fs.readFileSync(path.join(ROOT, 'providers/curl-transport.js'), 'utf8');
    // the key lives only in the --config file: process arguments are visible in ps(1)
    assert.match(source, /data-binary = /);
    assert.doesNotMatch(source, /Authorization[^\n]*\+/, 'no key concatenated into a command');
    // the path to curl must be computed in the generated script, not hardcoded here
    assert.match(source, /getenv\("SystemRoot"\)/);
    assert.doesNotMatch(source, /\/usr\/local\/bin\/curl/);
    // only the transport may talk to the ExtendScript bridge
    for (const file of runtimeFiles.filter(f => f !== 'providers/curl-transport.js')) {
        assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'),
            /AdobeScriptAutomation Scripts/, `${file}: bridge use must stay in one module`);
    }
    // place.js still inserts through a token, not through a path
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'place.js'), 'utf8'), /\.nativePath\b/);
});

test('a request mask is never paired with a non-PNG input', () => {
    // OpenAI: "the source image and the mask must share the same format and
    // dimensions". The server does not reject a mismatch — it quietly ignores the
    // mask, and the model repaints the whole frame. Symptom: "the model does not see the selection".
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const capture = fs.readFileSync(path.join(ROOT, 'capture.js'), 'utf8');
    const png = fs.readFileSync(path.join(ROOT, 'png.js'), 'utf8');

    // the mask decision must be made BEFORE capture and must control the format
    assert.match(main, /captureRegion\(ctx, s\.layerOnly, s\.lossless, wantMask\)/);
    /* And it must stay in ONE place. While the formula lived twice — once in
       the plan card, once in capturePayload — they diverged, and the card
       promised JPEG where PNG was sent (measured on the host 2026-09-09).
       The gate is on the number of matches: a second line with this formula is the relapse. */
    assert.equal((main.match(/provider\.supportsMask && s\.padPercent > 0/g) || []).length, 1,
        'the wantMask formula must exist exactly once — in inputPlan');
    assert.match(main, /function inputPlan\(s, provider, ctx\)/);
    assert.match(main, /const \{ wantMask \} = inputPlan\(s, provider, ctx\);/,
        'capturePayload takes the decision from inputPlan');
    assert.match(main, /const io = inputPlan\(s, provider, ctx\);/,
        'the plan card takes the decision from the same inputPlan');
    // The last line moved into capture.maskForRequest — it is checked there by
    // behavior (test/mask-blend.test.js), not by text. What remains here is a gate
    // that main.js does not build a mask past that function.
    assert.match(capture, /input\.type !== 'image\/png'[\s\S]{0,200}reason:/);
    assert.match(main, /capture\.maskForRequest\(/);
    assert.doesNotMatch(main, /buildRectMaskPng\(/,
        'only capture.maskForRequest builds the mask — otherwise the invariant is bypassed');
    // The speed threshold must not be allowed to degrade the FORMAT — only to
    // switch the worker. `lossless` is therefore const: no line below can quietly
    // rewrite it to JPEG, neither when PNG is required because of a mask, nor when
    // the user simply checked "lossless input".
    assert.match(capture, /const lossless = wantLossless \|\| requirePng;/);
    assert.doesNotMatch(capture, /\blossless = false\b/,
        'the threshold must not be allowed to cancel the format choice');
    assert.match(capture, /const viaDuplicateOnly = lossless && w \* h > LOSSLESS_MAX_PX;/);
    // the mask is RGBA (type 6), as in the documentation example
    assert.match(png, /encodePng\(px, width, height, 4\)/);
});

test('every input field declares maxlength — otherwise UXP silently silences it at ~256 characters', () => {
    // Measured on the host, not derived from the docs: a UXP field without an
    // EXPLICIT maxlength simply stops accepting input at about 256 characters.
    // No error, no truncated tail, no event — the prompt silently turned out
    // shorter than what was written. Adobe documents this nowhere, so the only
    // protection against the bug coming back is this gate.
    for (const file of ['index.html', 'test/ui-harness.html']) {
        const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const tags = html.match(/<(?:textarea|sp-textfield)\b[^>]*>/g) || [];
        assert.ok(tags.length, `${file}: no input fields found — the test lost its subject`);
        for (const tag of tags) {
            assert.match(tag, /\smaxlength="\d+"/,
                `${file}: a field without maxlength → ${tag.slice(0, 70)}`);
        }
        // rows= does nothing at all in UXP (the official list of known issues):
        // only CSS sets the height, and the attribute in the markup would mislead
        assert.doesNotMatch(html, /<textarea[^>]*\srows=/, `${file}: rows does nothing in UXP`);
    }
    // the new limit is visible to the user, not only to the code
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.match(main, /function updateCharCount\(/);
    assert.match(main, /updateCharCount\('prompt-input', 'prompt-count'\)/);
    assert.match(fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8'), /\.char-count\s*\{/);
});

test('local requires resolve with exact filename case', () => {
    for (const file of runtimeFiles) {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        for (const match of source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
            const requested = path.resolve(path.dirname(path.join(ROOT, file)), match[1]);
            const dir = path.dirname(requested);
            const base = path.basename(requested);
            assert.ok(fs.readdirSync(dir).includes(base), `${file}: missing or wrong case: ${match[1]}`);
        }
    }
});

test('HTML scripts do not redeclare top-level UXP globals', () => {
    const owners = new Map();
    for (const file of ['i18n.js', 'public-ui.js', 'auth.js', 'main.js']) {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const names = [];
        for (const match of source.matchAll(/^(?:const|let|class|function)\s+([A-Za-z_$][\w$]*)/gm)) {
            names.push(match[1]);
        }
        for (const match of source.matchAll(/^(?:const|let)\s+\{([^}]+)\}\s*=/gm)) {
            names.push(...match[1].split(',').map(part => part.trim().split(/[:=]/)[0].trim()).filter(Boolean));
        }
        for (const name of names) {
            assert.equal(owners.has(name), false,
                `${name} is declared by both ${owners.get(name)} and ${file}; UXP runs HTML scripts in one scope`);
            owners.set(name, file);
        }
    }
});

test('panel has an owned vertical scroll region and accessible disclosures', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.match(html, /id="main" class="panel-scroll hidden"/);
    assert.match(css, /\.panel-scroll\s*\{[^}]*overflow-y:\s*auto/s);
    assert.match(css, /body\s*\{[^}]*overflow:\s*hidden/s);
    assert.match(html, /role="button" tabindex="0" aria-controls="opts-body"/);
    assert.match(main, /setAttribute\('aria-expanded'/);
    assert.match(main, /e\.key === 'Enter' \|\| e\.key === ' '/);
});

test('critical panel controls use deterministic UXP-safe markup', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.match(html, /id="generate-btn" type="button" class="action-btn primary-btn/);
    assert.match(html, /id="plan-card" class="plan-card dim"/);
    assert.match(html, /class="advanced-stack"/);
    assert.match(html, /<svg class="chevron"/);
    assert.doesNotMatch(html, /prompt\.shortcut|⌘\/Ctrl/);
    assert.doesNotMatch(css, /\.shortcut\s*\{/);
    assert.doesNotMatch(main, /metaKey|ctrlKey/);
    assert.match(css, /\.control-grid\s*\{[^}]*display:\s*flex/s);
    assert.doesNotMatch(css, /\.control-grid\s*\{[^}]*display:\s*grid/s);
    assert.doesNotMatch(css, /\.chevron\s*\{[^}]*border-(?:right|bottom):/s);
});

test('macOS development deploy excludes non-runtime content', () => {
    const sh = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
    // docs/ is the project site with a demo video of ~1 MB. Photoshop scans Plug-ins
    // on every start, so anything that is not runtime does not go there.
    for (const nonRuntime of ['INSTALL.txt', 'README.md', 'README.uk.md', 'package.json',
                              'LICENSE', 'PRIVACY.md', '.github', 'scripts', 'dist', 'docs']) {
        assert.match(sh, new RegExp(`--exclude '${nonRuntime.replace('.', '\\.')}'`));
    }
    assert.match(sh, /Plugins → ExactFill/);
    assert.match(sh, /--include 'icons\/exactfill\.svg'/);
    assert.match(sh, /--include 'icons\/panel-\*\.png'/);
    assert.match(sh, /--exclude 'icons\/\*'/);
    assert.match(sh, /--exclude 'verify-assumptions\.psjs'/);
});

test('deploy target matches the installed plugin folder', () => {
    // The script pointed at AiImagePS for a long time — the name from before the rename.
    // Photoshop does not crash because of that, and that is why the bug lived: instead of
    // updating the working folder, deploy silently created a SECOND copy next to it with the same manifest id.
    const sh = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
    const dest = sh.match(/^DEST="([^"]+)"/m);
    assert.ok(dest, 'deploy.sh must declare DEST');
    assert.equal(dest[1].split('/').pop(), manifest.name,
        'the destination folder must match manifest.name');
});

test('one universal guide documents manual installation on both platforms', () => {
    const guide = fs.readFileSync(path.join(ROOT, 'INSTALL.txt'), 'utf8');
    assert.match(guide, /WINDOWS/);
    assert.match(guide, /macOS/);
    assert.match(guide, /ExactFill/);
    assert.match(guide, /Plug-ins/);
    assert.match(guide, /manifest\.json/);
    assert.match(guide, /api\.openai\.com/);
    assert.match(guide, /generativelanguage\.googleapis\.com/);
    assert.match(guide, /explicit Block rule/);
    assert.equal(fs.existsSync(path.join(ROOT, 'deploy.ps1')), false);
    assert.equal(fs.existsSync(path.join(ROOT, 'Install AI Image.cmd')), false);
});

test('release builder whitelists every runtime module', () => {
    const script = fs.readFileSync(path.join(ROOT, 'scripts/build-release.sh'), 'utf8');
    for (const file of [...runtimeFiles, 'index.html', 'style.css', 'manifest.json', 'icons/exactfill.svg']) {
        assert.match(script, new RegExp(file.replace(/[./-]/g, '\\$&')), `build omits ${file}`);
    }
    for (const file of ['panel-dark@1x.png', 'panel-dark@2x.png', 'panel-light@1x.png', 'panel-light@2x.png']) {
        assert.match(script, new RegExp(file.replace(/[.@-]/g, '\\$&')), `build omits icons/${file}`);
    }
});

test('public demo ships a lightweight accessible comparison and real video', () => {
    const html = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const video = path.join(ROOT, 'docs/assets/exactfill-demo.mp4');
    for (const file of ['demo-before.jpg', 'demo-generating.jpg', 'demo-after.jpg']) {
        assert.ok(fs.statSync(path.join(ROOT, 'docs/assets', file)).size > 0, `${file} is empty`);
    }
    assert.match(html, /type="range"[^>]*aria-label="Reveal before or after image"/);
    assert.match(html, /<video controls playsinline/);
    assert.match(html, /assets\/exactfill-demo\.mp4/);
    assert.ok(fs.statSync(video).size < 5 * 1024 * 1024, 'demo video should remain GitHub-friendly');
    assert.match(readme, /zgmrclick\.github\.io\/exactfill-photoshop/);
    assert.match(html, /https:\/\/ko-fi\.com\/havryil89140/);
    assert.match(readme, /https:\/\/ko-fi\.com\/havryil89140/);
});

test('GitHub Sponsor button points to the ExactFill Ko-fi page', () => {
    const funding = fs.readFileSync(path.join(ROOT, '.github', 'FUNDING.yml'), 'utf8');
    assert.equal(funding.trim(), 'ko_fi: havryil89140');
});

test('the quality segmented control puts six levels in two rows of three', () => {
    /* MEASURED ON THE HOST, NOT IN A BROWSER. In the browser stand a flex-basis
       of 33.333% gave exactly three buttons in a row. In Photoshop 27.5.0 the same
       three overflowed the row by a few pixels and landed TWO at a time — three
       rows instead of two. Cause: .seg-btn has no box-sizing: border-box (there is
       no global rule in the file either), so border-right: 1px is added to the basis.

       The gate covers both halves of the cause: box-sizing and a basis with margin. */
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    const segBtn = css.slice(css.indexOf('.seg-btn {'), css.indexOf('.seg-btn:last-child'));
    assert.match(segBtn, /box-sizing:\s*border-box/,
        'otherwise border-right is added to flex-basis');

    const basis = css.match(/\.seg-wrap \.seg-btn \{[^}]*flex:\s*1\s+1\s+([\d.]+)%/);
    assert.ok(basis, 'the row flex-basis must stay in percent, so it does not depend on the width');
    const pct = Number(basis[1]);
    assert.ok(pct * 3 <= 100 && pct * 4 > 100,
        `basis ${pct}%: three buttons must fit (${pct * 3}% ≤ 100), and a fourth must not (${pct * 4}% > 100)`);
});

test('refine is bound to the geometry of the run it refines', () => {
    /* THE MOST EXPENSIVE BUG ON THIS ROUTE would be a silent one. Regenerate
       deliberately rereads the context slider NOW (see resolveRegion). If Refine
       did the same, a tile painted for a 1315×611 frame would land in a 1920×391
       frame — and insertion would silently stretch the wrong picture.
       So the gate is on the source of the coordinates: lastRun, not readSettings. */
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const body = main.slice(main.indexOf('async function runRefine('),
                            main.indexOf('async function onGenerate('));
    assert.ok(body, 'runRefine must exist separately from onGenerate');
    assert.match(body, /ctx:\s*lastRun\.ctx,\s*target:\s*lastRun\.target/,
        'the refine frame is taken from the previous run');
    assert.doesNotMatch(body, /expandForContext|resolveRegion/,
        'recomputing the frame from the current settings is exactly the bug this gate exists for');

    // The conversation link: without responseId the next turn would start over and
    // silently lose memory — the only reason this route exists at all.
    assert.match(main, /responseId:\s*res\.responseId \|\| null/);
    assert.match(main, /previousResponseId:\s*lastRun\.responseId \|\| null/);

    // Refine does not overwrite the prompt: otherwise Regenerate after it would
    // repeat the line "make the shadow softer" against the original pixels.
    assert.match(main, /prompt:\s*refining \? lastRun\.prompt : prompt/);
});

test('the response format is tied to the resolution in the file, and the tie does not break silently', () => {
    /* This is a gate on the DEPENDENCY, not on a constant. Exact insertion rests
       on place.js writing the document resolution into the received file (pHYs in
       PNG, JFIF density in JPEG), otherwise placeEvent assumes 72 ppi. Since
       2026-10-08 place.js knows both formats, because Gemini returns only JPEG.
       WebP has no resolution field at all — so OpenAI still asks for the format
       EXPLICITLY on all three routes, and webp is forbidden. */
    const openai = fs.readFileSync(path.join(ROOT, 'providers/openai.js'), 'utf8');
    assert.match(openai, /const OUTPUT_FORMAT = 'png';/);
    // The three routes are named, not counted: a match counter would break on
    // every mention in a comment and would train us to edit the test instead of the code.
    assert.match(openai, /\{ name: 'output_format', data: OUTPUT_FORMAT \}/, 'images/edits');
    assert.match(openai, /n: 1, output_format: OUTPUT_FORMAT/, 'images/generations');
    assert.match(openai, /type: 'image_generation', output_format: OUTPUT_FORMAT/, 'responses');
    assert.doesNotMatch(openai, /output_format['"]?\s*[:,]\s*['"]webp/,
        'WebP has no resolution field — insertion would lose accuracy');

    const place = fs.readFileSync(path.join(ROOT, 'place.js'), 'utf8');
    assert.match(place, /prepareForPlace\(base64ToBytes\(b64\), doc\.resolution\)/,
        'this is the line that makes the resolution carry');
    assert.match(place, /createFile\(`ai_\$\{Date\.now\(\)\}_\$\{Math\.floor\(Math\.random\(\) \* 1e4\)\}\.\$\{file\.ext\}`/,
        'the temp file extension must match the bytes — Photoshop reads the format from it');
});
