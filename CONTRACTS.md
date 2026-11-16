# Module contracts — the single source of truth

Plugin `ai-image-ps`. One scenario: a rectangular selection → a prompt → provider/model/quality
→ a Smart Object exactly on the selection. RGB and CMYK, 8/16/32 bit.

**Do not change the signatures below without editing this file.** Modules are written independently and must
fit together on the first try.

---

## `geometry.js` — DONE, do not touch

A pure module, no `require('photoshop')`. Tested in node.

```js
unwrap(n)                          // {_unit,_value} → number, or a number as-is
integerTarget(bounds)              // → {left,top,right,bottom,w,h}  integers; rounds the EDGE, not the width
planFrame(target, nat)             // nat={w,h} native PNG → {mode:'exact'|'cover',left,top,right,bottom}
planRequest(caps, target, quality) // → {size:'WxH',quality} | {aspectRatio:'W:H',imageSize:'2K'}
exactSize(target, caps, quality)   // → 'WxH' | null
QUALITY_BUDGET                     // {low:1.2e6, medium:3e6, high:8294400, auto:3e6}
```

`caps` describes the model's GEOMETRIC capabilities:
```js
{ arbitrary:true, step:16, maxEdge:3840, minPx:655360, maxPx:8294400, maxRatio:3 } // gpt-image-2
{ arbitrary:false, sizes:['1024x1024','1536x1024','1024x1536'] }                   // gpt-image-1/1.5/mini
{ arbitrary:false, aspects:['1:1','3:2',…], imageSizes:['1K','2K','4K'] }          // gemini
```

## `place.js` — DONE, do not touch

```js
placeGeneratedSmartObject(b64, bounds, channelName) // → report; CALL INSIDE executeAsModal
withPixels(params, fn)                              // getPixels + dispose in finally
setPngResolution(pngBytes, ppi)                     // writes the pHYs chunk
readPngSize(pngBytes)                               // → {w,h} from IHDR
```

`report = { mode, nat:{w,h}, target, applied, residual:{dx,dy,dw,dh}, warnings:[] }`
`residual` is the main accuracy metric and must be 0.

---

## `capture.js` — TO WRITE

One capture pipeline for the whole plugin. **Do not call `imaging.getPixels` anywhere else.**

```js
/**
 * Captures pixels of the selected area as JPEG.
 * Call INSIDE core.executeAsModal.
 * @param {{left,top,right,bottom}} bounds — integer bounds (from geometry.integerTarget)
 * @param {boolean} useLayerOnly — take only the active layer, not the composite
 * @returns {Promise<{blob: Blob, docMode: string, bpc: number, viaDuplicate: boolean}>}
 */
async function captureRegion(bounds, useLayerOnly = false)
module.exports = { captureRegion, buildRectMaskPng };
```

Required rules:

1. **Whitelist by `doc.mode`.**
   - `RGBColorMode` / `GrayscaleMode` / `LabColorMode` → direct:
     ```js
     imaging.getPixels({ sourceBounds, applyAlpha:false, layerID?,
       colorSpace:'RGB', colorProfile:'sRGB IEC61966-2.1', componentSize:8 })
     ```
     `componentSize:8` replaces `convertMode depth:8`. `colorProfile` is required —
     without it the conversion is nondeterministic (the known "black or negative colors" bug).
   - **everything else** (`CMYKColorMode`, Indexed, Duotone, Multichannel, Bitmap) → the copy path:
     ```js
     const dup = await doc.duplicate();
     try {
       await batchPlay convertMode → RGBColorMode (merge:false, flatten:false)
       await batchPlay convertMode → depth 8
       await dup.crop(bounds)            // or selection + crop
       await dup.saveAs.jpg(tempFile, { quality: 12 }, true)
       // read tempFile bytes → Blob
     } finally { await dup.closeWithoutSaving(); }
     ```
     **Never touch the user's document.** No `convertMode` on `app.activeDocument`.
     Reason: `getPixels`/`getData()` in CMYK **crashes Photoshop** (PS 26.9), and `putPixels`
     does not accept CMYK at all — `createImageDataFromBuffer.colorSpace` documents only
     RGB/Grayscale/Lab.

2. **Fallback for 16/32 bit.** There is a risk that `componentSize:8` on a 16-bit document throws
   "Photoshop Error. Code: -1" (a regression since PS 26.3). So: try `componentSize:8`,
   and **on any error** quietly switch to the copy path. Do not try to convert
   by hand — the old `encodeAs8BitJpeg` did `>>8` on the 16-bit range [0..32768], which made
   the image twice as dark.

3. **`withPixels` from `place.js`** — everything that receives ImageData must go through it.
   ImageData must not cross a function boundary.

4. **`buildRectMaskPng(ctxW, ctxH, rect)`** — an inpainting mask for a rectangular area.
   `rect` is in context coordinates. Alpha=0 (transparent) = "change here", alpha=255 = "keep".
   **Do NOT use stored-deflate** — the old `encodeMaskPNG` produced 4.00 MiB for 1024²
   at the OpenAI limit of "<4MB". Options: (a) 1-bit PNG grayscale+tRNS, (b) real deflate
   via RLE-like encoding of identical rows, (c) a temporary document + `saveAs.png`.
   A rectangle repeats rows, so (a) or (b) produce kilobytes.

---

## `providers/openai.js`, `providers/google.js`, `providers/index.js` — TO WRITE

```js
// providers/index.js
module.exports = {
  list(),          // → [{id:'openai',label:'OpenAI'},{id:'google',label:'Google'}]
  get(id),         // → provider | null
};

// each provider:
module.exports = {
  id: 'openai',
  label: 'OpenAI',
  keyName: 'openAiApiKey',                 // key in storage.secureStorage
  async models(apiKey),                    // → [{id,label,caps}]  caps — see geometry.js
  supportsMask: true,                      // Gemini — false
  /**
   * @param {{apiKey,model,prompt,imageBlob,maskBlob,plan,n,onProgress}} o
   *   plan — what geometry.planRequest returned (placed in the payload as-is)
   *   onProgress(current,total,status,error)
   * @returns {Promise<string[]>}  an array of base64 PNG. NOTHING ELSE.
   */
  async generate(o),
};
```

The source of the code is the old SDKs, but **clean them up**:

**OpenAI** (`GPT-imagePluginPS/openAiSdk.js`):
- keep `generateImage` (POST `images/generations`) and `editImage` (POST `images/edits`, multipart)
- **delete** `generateImageWithContext` and the whole `/v1/responses` path (imported, never called
  anywhere), `refinePrompt`, `generateChat`, and the dead `OPENAI_IMAGE2_SIZES`/`OPENAI_IMAGE1_SIZES`
- models and `caps`: `gpt-image-2` → `arbitrary:true` (the rest are three fixed sizes);
  `gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini` → `sizes:['1024x1024','1536x1024','1024x1536']`
- `input_fidelity:'high'` — for all of them, **except** `gpt-image-2` (it already processes at high; the parameter
  is unavailable for it)
- **add a retry on 429** with `Retry-After` and exponential backoff. Do not retry 400/401/403.
- the timeout must **cancel** the request (`AbortController`), not merely reject the promise,
  and the timer must be cleared in `finally`
- check the response format: if there is no `data[i].b64_json`, throw a readable error
  instead of falling into `atob`

**Google** (`NanoBananaPluginPS/googleAiSdk.js`):
- keep the `generateContent` path (`gemini-*-image`); throw out **all of Imagen** (shutdown 2026-08-17)
- **restore** `generationConfig.imageConfig.{aspectRatio,imageSize}` — the comment in the old code
  that it is "an undocumented field" is WRONG. `imageSize` uses a capital "K": `'1K'|'2K'|'4K'`.
  `responseModalities:['TEXT','IMAGE']` stays required.
- models: `gemini-3-pro-image`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`.
  **Delete** `gemini-1.5-*`, `gemini-2.0-flash-exp`, and all `imagen-3.0-*`.
- the key is **not in the URL query string** — the `x-goog-api-key` header
- check `finishReason` and `promptFeedback`: a safety block must produce human-readable text,
  not a `TypeError`
- `supportsMask:false` — there is no mask parameter. Show the area through context with a fill.

---

## `main.js` — TO WRITE, target size ≤ 300 lines

A single flow. The file must contain no other logic.

```
1. Gate (NOT modal):
   doc = app.activeDocument            → none: alert "Open a document"
   sel = doc.selection.bounds          → null: alert "Select an area"
   doc.selection.solid === false       → warning "this flow is for a rectangular selection"
   The Generate button is locked for the whole operation (right now it can be pressed twice).

2. target = geometry.integerTarget(sel)
   provider = providers.get(localStorage.provider)
   model, quality, n — from the UI
   plan = geometry.planRequest(caps, target, quality)

3. executeAsModal → capture.captureRegion(target, useLayerOnly) → {blob}
   Mask: if provider.supportsMask and CONTEXT_PAD > 0 — capture.buildRectMaskPng(...)

4. NOT modal → provider.generate({...}) → base64[]

5. executeAsModal → for each b64:
     place.placeGeneratedSmartObject(b64, target, channelName)
   Before the loop, save the selection to a temporary channel; delete the channel in finally.
   Log report.residual for every insertion.

6. Check that the document is THE SAME as in step 3 (compare doc.id) — otherwise alert and exit.
```

Required:
- save to `localStorage`: `provider`, `model`, `quality`, `n`, `prompt`, `useLayerOnly`
- **no `saveDebugBlob`** — it accumulated 3 GB across 484 files
- every `catch` shows the user the error text; there must be no silent `return null` anywhere

## `index.html` + `style.css` — TO WRITE

One panel, no tabs. Elements:
prompt (textarea) · provider (sp-picker) · model (sp-picker) · quality (4 buttons
low/medium/high/auto) · variation count (sp-number-field 1-4) · "active layer only" (checkbox) ·
Generate + spinner · presets section (collapsible) · history section (collapsible) · API-key controls.

**Remove:** the Grid and Chat tabs, Refine-prompt, Whole-Image/Gen-Fill, Upscale,
Reference images, and the context toggle.
`style.css` — take it from the old one and cut the rules for dead blocks (about 700 lines remain of 1600).

## `manifest.json` — TO WRITE

```
id: ai-image-ps            name: AI Image
host.app PS, minVersion "25.0.0"      ← doc.selection.bounds/.solid since 25.0
manifestVersion 5
requiredPermissions.localFileSystem: "request"
requiredPermissions.network.domains: ["https://api.openai.com",
                                      "https://generativelanguage.googleapis.com",
                                      "https://api.wavespeed.ai",
                                      "https://openrouter.ai"]
  ← WITHOUT http://localhost:3000 (it was in the old manifest for no reason)
entrypoints: one panel, icons/openai.svg
```

---

## `providers/wavespeed.js` — WaveSpeedAI

Registry id `wavespeed`, secureStorage name `wavespeedApiKey`. `generate` returns
`{ images: [base64], usage: null }`. It uploads with `POST /api/v3/media/upload/binary`,
submits the selected edit model once, then polls `GET /api/v3/predictions/{id}/result`.
Fetch goes only to `https://api.wavespeed.ai`. It does not use `providers/http.js`
or the curl transport. Capture and placement are unchanged.

## Edit conversation

The primary control is a Vietnamese multi-turn discussion, not a one-shot Generate
button. The transcript lives in memory until **Cuộc mới**. OpenRouter key
`openrouterApiKey` is stored in `secureStorage`.

1. `google/gemini-3.8-flash` via `POST https://openrouter.ai/api/v1/chat/completions`
   maintains the brief and, only when needed, a Vietnamese question.
2. `heygen/heygen-decision-1-turbo` via `POST https://openrouter.ai/api/alpha/decisions`
   sees the selected image, surrounding context, original conversation and proposed brief.
3. Choice `ready` generates once with the selected image provider. `clarify`,
   `cancelled`, a malformed payload, a refusal or an API error does not.
4. Cancel, reset, or a changed document, layer or selection invalidates that turn
   before the paid generation.

## Style

- Comments in **English**, about the why, not a restatement of what the line does.
- No new dependencies. Only `photoshop` and `uxp`.
- `node --check` must pass on every file.
- Do not copy old code without a reason — half of it is dead.
