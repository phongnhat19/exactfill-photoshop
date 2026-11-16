# WaveSpeedAI provider and API key settings

Status: Implemented in the working tree. Owner review is still pending. Spec PR review and merge are still pending. No review or merge is claimed here.
Source revision: e71910e837842b1ff93c659b0c687795973c28dc.
Feature issue: Pending; GitHub reports that issues are disabled for this fork.
Workflow: Strict, verified from the authenticated master branch configuration.

## Outcome

Use WaveSpeedAI for personal Photoshop image editing. Add a model picker with
Nano Banana 2, Nano Banana Pro, Seedream 5.5 Edit, and Qwen Image 2.0 Edit.
Add an in-panel Settings page for entering, replacing and removing the WaveSpeed
API key. Keep existing pixel capture, Smart Object placement and layer masks.

Proposed defaults (builder decisions): WaveSpeedAI first for a fresh installation;
Nano Banana 2 Edit as the initial model. Preserve previously saved provider choices
and keep existing providers available. Persist a selected WaveSpeed model across restarts.

## Verified API sources

Consulted Context7 `/websites/wavespeed_ai` and the corresponding official pages
on 16 November 2026. Explicit version labels below avoid silently switching models.

| UI label | POST path relative to https://api.wavespeed.ai/api/v3/ | Input limit, including captured image |
| --- | --- | --- |
| Nano Banana 2 Edit | google/nano-banana-2/edit | 14 images |
| Nano Banana Pro Edit | google/nano-banana-pro/edit | 14 images |
| Seedream 5.5 Edit | bytedance/seedream-v5.5/edit | 10 images |
| Qwen Image 2.0 Edit | wavespeed-ai/qwen-image-2.0/edit | 3 images; each dimension 384–3072px; prompt at most 800 characters |

- https://wavespeed.ai/docs/docs-api/google/nano-banana-2/edit
- https://wavespeed.ai/docs/docs-api/google/nano-banana-pro/edit
- https://wavespeed.ai/docs/docs-api/bytedance/seedream-v5.5/edit
- https://wavespeed.ai/docs/docs-api/wavespeed-ai/qwen-image-2.0/edit
- https://wavespeed.ai/docs/upload-files-api
- https://wavespeed.ai/docs/get-result
- https://wavespeed.ai/docs/base64-output

## Settings and daily use

Reuse the current Spectrum controls, typography, spacing and panel theme. Add a
labelled Settings button and a Back button. The Settings view is reachable before
an API key exists. It contains a visibly labelled password field, Show/Hide button,
Save key, Remove key, a link to WaveSpeed's official key/account page, and inline
status feedback. It fits the existing 230px minimum panel width.

Save trimmed nonempty keys under `wavespeedApiKey` in existing UXP secureStorage;
reject control characters. Never prefill an existing key into the field. Show only
whether a key is saved; clear the input after saving and when leaving Settings.
Remove deletes the stored key. Report storage failures without losing the existing
key or claiming success. Do not make a paid generation request when saving a key.
Disable key changes and Settings navigation during a generation.

Saving returns to the editing workflow. Missing-key Generate attempts open Settings
with a clear message. Keyboard focus moves to the page heading/key field and returns
to the Settings trigger on Back. Use associated labels and an aria-live status.

## Provider contract and networking

Add `providers/wavespeed.js` implementing the current registry interface: id,
label, keyName, keyPage, models, capsFor, generate, and capability flags.
`generate` returns `{ images: [base64], usage: null }`, matching current main.js.
Do not fabricate OpenAI/Google token costs for WaveSpeed; show cost unavailable
unless a documented WaveSpeed-specific estimate is added in this feature.

1. Validate key, prompt, supported model, input count, model-specific input bounds,
   and options before any network request. Unsupported text-only generation is
   disabled for these edit endpoints; no silent ignoring of the captured image.
2. Upload the captured Blob first, followed by optional references, using the
   documented raw binary `POST /media/upload/binary` compatibility endpoint with
   Content-Type and generic filename headers. Read `data.download_url` as model input.
   Bound files to that endpoint's documented 100MB request limit. Do not send local
   document paths or filenames. This endpoint is a deliberate UXP compatibility
   choice: it keeps authenticated requests on one origin and avoids arbitrary
   presigned-storage origins. No new SDK or dependency is needed.
3. Submit the selected model once with prompt, image URLs, model-specific geometry,
   `enable_base64_output: true`, and `enable_sync_mode: false`. Never retry a submit
   after an ambiguous transport failure: another POST could create a second billed
   job. Tell the user the task may still exist and to inspect WaveSpeed History.
4. Poll `/predictions/{encoded-id}/result` at least two seconds apart. Retry transient
   polling failures with bounded backoff and Retry-After. Stop on completed, failed,
   cancelled, timeout or deleted. Bound total client waiting to ten minutes and each
   request to 60 seconds. Cancel aborts fetch and pending waits; it does not promise
   server-side cancellation or a refund.
5. Validate returned base64 file bytes as a supported PNG/JPEG before using the
   existing placement pipeline. Base64 mode can still return URLs for oversized or
   unavailable conversions: reject those with a clear error in this first version;
   do not fetch arbitrary output URLs or send them Authorization headers.

Use direct UXP fetch for WaveSpeed; do not route through the existing curl fallback
that writes secrets to disk. Add only `https://api.wavespeed.ai` to manifest network
permissions. Redact keys and provider bodies that could echo secrets from errors,
logs, reports and persisted metadata. Raw authorization material is never saved
outside secureStorage.

## Model controls

The current geometry planner remains the source for selection aspect and placement.
Declare model-specific caps, then map its output to each API's parameter names.
Nano Banana tiers: 1k/2k/4k; Seedream tiers: 1k/2k in the initial UI (the optional
1.5k tier is not required). Qwen uses its documented width*height size form and
does not receive resolution or aspect_ratio. Use the API limits in the model table; validate Qwen input dimensions without silently resampling.

No WaveSpeed model advertises a request mask or live preview. Retain Photoshop's
local output mask. Transparent output is enabled only for Seedream's documented
background option. Hide or disable unsupported controls with a short explanation.
Do not silently truncate extra references or Qwen prompts. Refine-with-server-memory
is unavailable; Regenerate continues through the existing fresh-request path.

## Scope and tests

Affected surfaces: providers/index.js, new wavespeed provider, auth.js, index.html,
style.css, main.js capability/auth flow, panel-settings.js if needed, i18n.js (both
locale aliases), manifest.json, usage display, build-release.sh provider/file lists,
CONTRACTS.md, README and PRIVACY docs, unit tests and UXP DOM/storage stubs.
No capture/placement algorithm rewrite, live paid API tests, account backend,
arbitrary endpoint editor, SDK dependency, or broad plugin redesign.

Acceptance tests:

- Four models appear; each sends only supported fields and validates image limits.
- Upload order is captured image then references; HTTP/malformed-upload errors stop
  before submit. Keys go only to the WaveSpeed API origin.
- Submit occurs once; an ambiguous timeout never resubmits. Queued/processing then
  completed returns valid images; all failure terminal statuses stop polling.
- Polling respects interval/backoff; abort and deadline clear timers and stop reads.
- Empty/malformed outputs, unsupported URL outputs, unknown model and invalid key
  produce useful redacted errors. PNG and JPEG outputs use existing placement prep.
- Settings save/replace/remove survives reload, clears visible key fields, handles
  storage failure, preserves keys when navigating Back, and is accessible before auth.
- Registry defaults, English locale aliases, capability controls and release contents
  include the new provider without breaking existing provider behavior.

Use mocked fetch and fake timing: Red → Green → Refactor. Run npm test, npm run check,
npm run build and git diff --check. Existing unrelated baseline: model-list test
expects at least six models but currently receives five. Keep that failure explicit.

## Review prerequisites

Owner review: pending. Spec PR review/merge: pending. Issue publication is blocked
until the owner enables repository issues. Product code in this working tree was
implemented from an explicit request to follow this spec. That request does not
record an owner review or a merged spec PR.
