# Platform: Photoshop/UXP pitfalls and decisions

What the code does not show: why it is built this way, what was tried and rejected, and what was
measured on the host contrary to the documentation. Module signatures are in `CONTRACTS.md`; raw
measurements are in `verify/README.md`. Measurements are Photoshop 27.5 (2026), macOS, unless noted
otherwise.

## The main point: the imaging API does not work outside RGB

- `imaging.getPixels` / `putPixels` / `createImageDataFromBuffer` / `getSelection` — **RGB,
  Grayscale, and Lab only**. In CMYK, `getData()` **crashes Photoshop** (SIGSEGV); Bitmap/Indexed/Multichannel
  fail gracefully. `putPixels` has no `colorSpace`, and `createImageDataFromBuffer.colorSpace` does not
  accept CMYK → a CMYK `imageData` cannot be constructed → any route through `putPixels` forces a
  conversion of the whole document.
- **Reading non-RGB:** `doc.duplicate()` → `convertMode` on the **copy** → `saveAs.jpg` → close the copy.
  Before `convertMode`, check `app.activeDocument.id === dup.id`: without `_target` the command acts on
  the active document.
- **Inserting:** `placeEvent` with a file session token — Photoshop converts the color itself, and the
  document stays CMYK/16-bit. Then measure the frame → scale → `move`.
- `componentSize: 8` in `getPixels` replaces `convertMode depth:8`, but a 16-bit document can throw
  "Photoshop Error. Code: -1" (a regression since PS 26.3) — always keep a duplicate fallback.
- The 16-bit range in UXP is `[0..32768]`, not `[0..65535]`: a manual `>>8` comes out twice as dark. Do not
  convert by hand — request `componentSize: 8`.

## Tried and rejected

| What | Why |
|---|---|
| Fixing the placement shift with `Math.round` | Rounding the center itself produced a deterministic +1 px shift on odd widths. The loop was open: the code never read where the layer actually landed. The fix is to measure the after-state |
| `putPixels` + `newPlacedLayer` + `transform` | Requires RGB 8-bit → CMYK→RGB→CMYK is not reversible (100% K becomes rich black), and the Smart Object keeps fractional geometry → semi-transparent edges |
| `convertMode` on the live document plus a history rollback | At insertion time the rollback would also undo the insertion itself |
| PNG with stored-deflate | A 1024² mask is exactly 4 MiB at the OpenAI limit of <4 MB. Real deflate is required (fixed-Huffman + RLE) |
| `transform` `rectangle`→`quadrilateral` for an absolute Smart Object frame | **Does nothing and returns success** — in every unit variant. Caught only by measurement |
| `transform` with `offset` + percent | `offset` is not computed from the frame center — the layer jumped 1200–1800 px. Position belongs in a separate `move` |
| `batchPlay({_obj:'feather'})` | System dialog "command unavailable". Use the DOM `selection.feather(radius, true)` (PS 25+) |
| descriptor `{_ref:'channel', _enum:'channel', _value:'selection'}` | Wrong (selection is a property reference): the channel and the fallback mask were silently not created. Use `selection.save/load/selectRectangle` |
| Filtering or labeling models from OpenAI `/v1/models` | The catalog is not access (see "Models") |
| `chatgpt-image-latest` | Fixed sizes only (kills exact placement), a moving target and a moving price against static `caps`/`usage.js` |
| Windows one-click scripts (`deploy.ps1`, `.cmd`) | Tied to a Photoshop version and to PowerShell/UAC — fragile. The canon is one ZIP |

## Measured on the host — what the documentation does not say

- **`smartObjectMore.transform` is document coordinates**, 8 numbers TL→TR→BR→BL, `double`.
  `layer.bounds` is useless for measurement: only opaque pixels inside the canvas.
- `place` **does not convert the document** (CMYK 8/16, RGB 16/32, Gray 16) — one history step.
- **`distanceUnit` in `move` is points (1/72″)**, not pixels. The correct unit is `pixelsUnit`.
- `nonAffineTransform` is always present and, after a clean `place`, duplicates `transform`; skew is a mismatch, not mere presence.
- There is no fractional shift (`move(0.25, −0.75)` → `(0, −1)`); after a scale Photoshop snaps to integers itself.
- A Smart Object keeps the native raster — repeated scaling does not degrade it.
- **`pHYs` removes Place's PPI scaling** (without it, 1024 px at 300 ppi becomes 4266.667). Therefore
  OpenAI **`output_format` must stay `png`**: WebP has no resolution field. Gemini JPEG places
  exactly regardless of JFIF density.
- Fit-to-canvas is real (1024 in an 800×600 canvas → 600×600), but under "measure → act" that is only a resample.
- **`getSelection` ignores `sourceBounds`** — it returns the selection's own frame. Read `res.sourceBounds` and
  blit into your own buffer at the offset. The node stub does not show this.
- Adobe does not document batchPlay IDs — absence from the reference is not a sign of risk; verify by recording an action
  (Alchemist) or with `.psjs`.

## Two masks, and they are different

- **Request mask** (`png.js:buildRectMaskPng`) — always the selection bbox rectangle; alpha 0 = change.
  Sent only when context > 0 (at 0 the frame equals the selection). The pad comes from the longer side (`expandForContext`).
- **Layer mask** (`place.js:applySelectionMask`) — the real shape via a channel (`selection.save` → `load` →
  reveal). The lasso protects the document, not the request: the model receives a rectangular hole and we pay for the bbox.
  If the selection changes during generation → fall back to a rectangular mask, visible in `residual.rectMask`.
- **PNG mask + JPEG input = the mask silently does nothing** (OpenAI requires the same format and size; the server does not
  complain). Above `LOSSLESS_MAX_PX` the input degrades to JPEG → the bug "the model does not see the selection" is intermittent.
  The mask and format decision is one function, `inputPlan()`; a gate counts copies of the formula.
- Soft layer edge: the UI value is the full transition width; `radius = width/2`, `selection.contract(radius)` and
  `feather(radius)` — the transition stays inside the selection (a symmetric feather was cut by a line at the Smart Object edge).
  Radius ≤ a quarter of the shorter side − 1. UI range 0–256 px.
- "Active layer only" mode: on the duplicate, recursively leave the active layer's branch visible (deleting
  top-level neighbors destroys a nested layer together with its group).

## Models

- **All knowledge lives in the model's `caps`** (size, quality levels, `inputFidelity`, `stablePx`). String exceptions by
  name broke four files in part. A new model is `MODELS` plus a price in `usage.js`; the gate is `test/models.test.js`.
- Levels `xhigh`/`max` are accepted only by 2.5 (others → 400). `coerceQuality` coerces **downward only**, and the coerced
  value is not written to localStorage (that stores the user's preference).
- `xhigh`/`max` do not give more pixels than `high` — they buy render effort. **Output tokens do not grow
  with area** (3.6 MP at max ≈ 5400 tokens).
- **OpenAI `/v1/models` is a catalog, not an access right**: new models worked even when they were not in the
  catalog. OpenAI `models()` does not touch the network (gate test). For Google the opposite is true — ListModels is the truth.
- Free access probe: an intentionally invalid request (`size=1x1`), then read the refusal reason
  (`model_not_found` vs a complaint about `size`). **Always with controls** (a real model and a nonexistent one). The script is
  `verify/check-models.sh`. Gemini: `countTokens` with a control; an empty `generateContent` body does not distinguish them.
  Gemini field reconnaissance: `contents: []` + a field → `Unknown name` / `Invalid value` / valid.
- **Retirement is `RETIRED` by date** (`Map id → {shutdown, replacement}`): a release lives on users' machines
  for months. Hidden from 00:00 UTC on the shutdown day; the replacement is explicit (mini → Flare, not `list[0]`, so the
  bill does not rise silently); a 404 on a retired model → `error.modelRetired`. Prices of retired models stay in `usage.js`.
  Do not tie tests to a model that is being retired.
- Google: a new model's ID may not contain `-image` → catalog parsing is `pickImageModels()`; **`FALLBACK_MODELS` order
  is the default**. ListModels also lists retired models. Check shutdown dates on both Google pages
  (pricing and deprecations contradict each other).
- **Gemini `generateContent` returns JPEG only** (`IMAGE_JPEG` is the only valid value). `png.prepareForPlace()`
  detects the format from the bytes.
- Multi-turn refine on `/v1/responses` uses only `previous_response_id`: sending `image_generation_call`
  by id with a reasoning host model → 400 (the `reasoning` ancestor is missing). The tool accepts its own `model` field.
- Preview exists only in the OpenAI stream: `partial_images:3` is required (the default 0 = final only); SSE may use CRLF.
  Gemini is `generateContent` with no intermediates; migration to the Interactions API is separate work.

## Network and the curl transport

- `network.domains` does not bypass a firewall: the request leaves the Photoshop process. Only outbound HTTPS
  to `api.openai.com` / `generativelanguage.googleapis.com` is required. In Windows Defender, `Block Photoshop`
  beats `Allow`.
- **A blocked fetch does not fail; it hangs.** So `auto` does a **keyless preflight of 6 s** before the first
  request (any HTTP response means the path is alive) and can fall back.
- The curl route (`providers/curl-transport.js`): UXP → session token → `batchPlay` `AdobeScriptAutomation Scripts`
  → ExtendScript `app.system("curl … &")` → poll a file. Measured: **a firewall block on Photoshop does not cover the child
  curl** (macOS, per-binary rules); the `-o` file grows during download → SSE preview stays alive.
  Domain or gateway blocking is not bypassed by this.
- Forms that do not work: `{_path: '/abs'}` → `invalid file token`; `javaScript: '<string>'` → `-128`;
  `.psjs` is not launched by this event; `createPersistentToken` is not needed. The batchPlay result contains
  `javaScriptMessage` — a two-way channel. UXP `fs` has no `unlinkSync`.
- **The API key lives only in the `--config` file** (not argv, which is visible in `ps`) → cleaning up temp files is the only
  thing that removes the key: `try/finally` in `curlFetch`, and stream cleanup even if the handler throws.
- The exit code comes from `-w "%{http_code} %{exitcode}"` written to a file (after `start /b` there is no code). curl exit 6 —
  address not resolved (a fresh firewall block), 7 — refused, 28 — timeout or the firewall is still asking.
  A firewall with no decision (a LuLu alert) **hangs**; it does not refuse — 20 s is not a block; retry after a rule.
- Windows: `curl.exe` is present by default; Defender `AllowOutbound` → no dialog. Code page 866 —
  work files only on an ASCII path (`%PROGRAMDATA%\ExactFill`); background in cmd is `start /b ""`.
  **Do not claim Windows parity** until it is verified in a real Photoshop on Windows.
- A standalone `.psjs` has no network permissions (a sandbox without a manifest) — that is not a firewall.

## UXP UI

- **An input without `maxlength` silently stops input at ~256 characters** — an undocumented UXP default.
  Not rendering and not the box. Gate: every field declares `maxlength`. `rows`/`cols` on a textarea are ignored — height is CSS.
- All `<script src>` from `index.html` share **one lexical scope**: identical top-level `const` names take down the panel
  (`Identifier … already declared`). Name imports differently in each file. CommonJS is a separate scope.
- `display:grid` in PS 27 removed controls with no error → critical geometry is `flex` only. UXP ignores `:empty` and
  `:nth-child` — JS sets classes. `box-sizing` is not global: `flex-basis 33.333%` + border
  gave 2 per row instead of 3 → `border-box` + `flex: 1 1 30%`. **The browser harness does not measure UXP layout.**
- `sp-number-field` does not draw → `sp-slider` with a fallback to segments (`[ui] sp-slider did not draw` in
  the log is normal). After async filling, `sp-picker` does not redraw its trigger → build a new picker
  outside the DOM with ready options and `value`, replace it, and reattach `change`.
- Hybrid: Spectrum `sp-picker`/`sp-checkbox` plus our own `<button>` elements with inline SVG. A CSS-border chevron
  breaks; an SVG logo has no gradient/`defs`.
- Viewport shell: `html/body` at 100% with no scroll, a fixed `.brand-bar`, and `#main.panel-scroll` scrolls
  (`min-height:0; overflow-y:auto`). Minimum 230 px with no horizontal overflow.
- The panel icon is PNG RGBA 8-bit 23×23/46×46; the manifest says `panel-dark.png`, on disk `@1x`/`@2x`, and separate
  light/dark with `species: "toolbar"`. Changing icons means a new patch version (metadata cache).
- Manifest: `localFileSystem: "request"`, domains, `launchProcess.schemes: ["https"]`. Always handle the Promise from
  `openExternal` and secureStorage.
- Runtime has no absolute paths and no `.nativePath`; `require` case is exact (Windows).
- A UXP panel is not included in a window capture (it is drawn as a separate layer) — only a full-screen shot;
  a synthetic `cmd+V` into a field is not accepted.

## Storage, cost, build

- `secureStorage` and `localStorage` are isolated **per manifest id** → the id stayed `ai-image-ps` after the
  rename to ExactFill, so keys are not lost. localStorage keys live only in `storage-keys.js`.
- Cost is the ledger `ai_usage_ledger_v1` (localStorage survives restart; "per session" is wrong): the price
  is fixed in the entry at request time and written **before** insertion (the charge already exists). Tokens: OpenAI
  `input_tokens_details` + `output_tokens`; Gemini by modality (do not multiply `candidatesTokenCount`
  by the text rate — the image is in there too). Price sources sit next to the table in `usage.js`.
- Our own deflate: `distance ≤ 32768` (RFC 1951) — on wide canvases the "previous row" distance
  is disabled; the area threshold `LOSSLESS_MAX_PX` is not saved by the width window.
- A new root `*.js` → `ROOT_FILES` in `scripts/build-release.sh`. Non-runtime → `--exclude` in
  `deploy.sh` (Photoshop scans `Plug-ins` on every start; `--delete-excluded` is required —
  `--delete` does not remove excluded files). Do not keep a Git repo inside `Plug-ins`.

## Bug class: a test is green for something that is not in production

This happened in `presets.js` (the test called `load()` itself; the panel never did), `curl-transport.js` (tests
covered `buildCommand`; production used a different function without escaping), the ZIP file list (a literal list in the test),
and the report URL length (GitHub 414). **Rule:** if you check a function, also check that it is the one being called
(a static test of the source text); derive file lists from the filesystem. The same applies to "silent feature downgrade"
(`images/generations` instead of `edits` with no error): providers log the actual endpoint.

## How to check without Photoshop and in Photoshop

- `node --test test/main-boot.test.js` — the whole `initUI` under node (`test/stubs/dom.js`, DOM from the real
  `index.html`). "No `console.error`" means initialization completed. It does not catch layout.
- Live Photoshop from the terminal (macOS): `osascript -e 'tell application "Adobe Photoshop 2026" to do
  javascript "String($.evalFile(new File(\"/tmp/probe.jsx\")))"'`. That is ExtendScript (ES3, no `JSON`),
  but `executeAction` and `batchPlay` are the same Action Manager. The script is ASCII; `rulerUnits = PIXELS` and
  restore in `finally`; close your own documents with `DONOTSAVECHANGES`. The `do javascript file` form is 8800.
- After deploy, a new `UXPLogs_*.log`: no `SyntaxError|ReferenceError|TypeError`. The insertion metric is
  `report.residual` = 0.
