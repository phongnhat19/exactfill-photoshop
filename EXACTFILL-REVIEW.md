# ExactFill static security and macOS compatibility review

Reviewed 16 November 2026. Source version 1.7.1, master commit
[`d5ac1d36d076c572280b70ebbc167e1631d9b53b`](https://github.com/zgmrclick/exactfill-photoshop/tree/d5ac1d36d076c572280b70ebbc167e1631d9b53b).

Verdict: a plausible base for a custom macOS Photoshop plugin after hardening. The
normal UXP path fits Adobe's documented architecture. Do not treat the current
implementation as security-cleared: its automatic external curl transport is the
main concern. No Photoshop runtime or integration testing was performed.

## Security findings

### High in managed environments: automatic firewall workaround

[`providers/http.js:26`](https://github.com/zgmrclick/exactfill-photoshop/blob/d5ac1d36d076c572280b70ebbc167e1631d9b53b/providers/http.js#L26)
routes failed direct requests to curl automatically. The default transport mode is
auto. [`curl-transport.js:117`](https://github.com/zgmrclick/exactfill-photoshop/blob/d5ac1d36d076c572280b70ebbc167e1631d9b53b/providers/curl-transport.js#L117)
generates ExtendScript that launches `/usr/bin/curl` through `app.system`, reached
through the `AdobeScriptAutomation Scripts` batchPlay action. The source explicitly
describes escaping process-based Photoshop firewall blocking. Actual bypass depends
on the endpoint policy; it does not defeat every firewall.

This is intentional functionality, not evidence of hidden malware. It nevertheless
undermines the expectation that blocking Photoshop prevents plugin network traffic.
The UXP network allowlist is not a complete description of external-process behavior.
Recommendation: remove the bridge from the custom fork and use direct UXP networking.

### Medium: API keys and artwork written to plaintext temporary files

[`curl-transport.js:324`](https://github.com/zgmrclick/exactfill-photoshop/blob/d5ac1d36d076c572280b70ebbc167e1631d9b53b/providers/curl-transport.js#L324)
writes authorization headers into `.cfg`, request data into `.body`, and responses
into `.out`. Ordinary completion/error paths attempt deletion, but a Photoshop
crash or forced termination skips JavaScript cleanup; deletion errors are swallowed.
This exposes secrets to processes with sufficient filesystem access, particularly
under the same user account. Cross-user readability was not established.

Keys are normally stored using UXP secureStorage, which Adobe documents as encrypted.
That protection does not extend to these temporary copies. Removing curl also removes
this particular exposure. [Adobe storage documentation](https://developer.adobe.com/photoshop/uxp/guides/how-to/).

### Medium: cancellation does not terminate curl

[`curl-transport.js:379`](https://github.com/zgmrclick/exactfill-photoshop/blob/d5ac1d36d076c572280b70ebbc167e1631d9b53b/providers/curl-transport.js#L379)
checks the abort signal in the polling loop, while the generated shell command runs
curl in the background. No process handle or termination is implemented. Cancelling
can therefore leave upload/generation running and potentially billable; it also
creates cleanup races with the still-running process. Direct networking uses
AbortController, although client cancellation cannot guarantee provider-side job cancellation.

### Privacy consideration: persistent prompts and generated images

[`cache.js`](https://github.com/zgmrclick/exactfill-photoshop/blob/d5ac1d36d076c572280b70ebbc167e1631d9b53b/cache.js)
stores up to eight generated image entries in the plugin data folder and metadata
in localStorage. [`history.js`](https://github.com/zgmrclick/exactfill-photoshop/blob/d5ac1d36d076c572280b70ebbc167e1631d9b53b/history.js)
keeps up to twenty history entries; the current prompt and presets also persist.
These are not encrypted by the application code. Clear-cache and clear-history
controls exist. This is disclosed functionality, but confidential-artwork use should
have a retention choice and a combined clear-all control, including credentials.

Selected pixels, optional context, references and prompts are intentionally sent to
the chosen AI provider. Local execution of the panel does not make generation offline.

### Positive observations and scope

- The manifest restricts UXP networking to the two provider HTTPS origins; filesystem
  access is `request`, and external links are restricted to the HTTPS scheme.
- Provider endpoints are fixed. OpenAI URL image responses are rejected rather than
  fetched from arbitrary locations. Keys use request headers.
- Reviewed DOM helpers use textContent for data and innerHTML for clearing containers.
  No obvious remote-code loading, eval path, or developer telemetry was found in the
  reviewed runtime entrypoints and network/storage paths.
- package.json declares no third-party dependencies or install lifecycle scripts.
  This reduces npm supply-chain exposure; it is not a vulnerability certification.
- deploy.sh uses sudo rsync with deletion and changes ownership of its destination.
  Its destination is hardcoded to Photoshop 2026. Do not run it blindly for another
  Photoshop version; use Adobe's developer installation/package workflow.

## macOS compatibility against Adobe documentation

| Area | Static assessment |
| --- | --- |
| Plugin type | HTML/CSS/JavaScript UXP panel, not a CEP extension or native addon. |
| Manifest | v5, host PS, minimum 25.0.0. Adobe requires only 23.3+ for manifest v5, so the declared baseline satisfies that requirement. |
| API mode | Explicit apiVersion is absent. Adobe assigns API v2 when minVersion is at least 23.0; this is not a missing-field defect. |
| Core APIs | Imaging APIs, session tokens, batchPlay and executeAsModal match Adobe's documented APIs and usage patterns. No obvious core API baseline conflict was established. This is not proof that every descriptor works in every 25.x release. |
| Intel / Apple Silicon | UXP is supported natively on both. No bundled native addon needs architecture-specific compilation. Rosetta is not required by the core panel architecture. |
| Filesystem / links | The request permission and HTTPS launchProcess scheme fit file pickers and external links. Plugin data/temp storage is supported. |
| Streaming | Code checks for a readable response body and falls back to parsing the completed response. Live preview should be considered runtime-dependent. |
| External curl bridge | Not verified as a supported public Adobe UXP contract. Source comments report a particular Photoshop build, but that is not independent compatibility evidence. ASCII-only path checks can disable it. |
| Installation | Repository supplies a ZIP and manual Plug-ins-folder instructions. Those instructions are not validated by this review. Use UXP Developer Tool to load manifest.json for development and package a CCX for distribution. |

Evidence:

- [Pinned manifest](https://github.com/zgmrclick/exactfill-photoshop/blob/d5ac1d36d076c572280b70ebbc167e1631d9b53b/manifest.json).
- [Adobe manifest v5 and permissions](https://developer.adobe.com/photoshop/uxp/2022/guides/uxp-guide/uxp-misc/manifest-v5/).
- [Adobe Photoshop manifest API-version defaults](https://developer.adobe.com/photoshop/uxp/2022/guides/uxp-guide/uxp-misc/manifest-v4/photoshop-manifest/).
- [Adobe Imaging API](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/imaging).
- [Adobe modal execution](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/executeasmodal).
- [Adobe native architecture support](https://blog.developer.adobe.com/en/publish/2021/03/in-app-extensibility-support-for-arm-apple-silicon-devices).
- [Adobe UXP Developer Tool plugin loading](https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/plugin-management).
- [Adobe CCX packaging](https://developer.adobe.com/uxp/guides/how-to/distribution/package/).

macOS requirements belong to the selected Photoshop release, not this manifest.
For example, Adobe currently lists macOS 14/15/26 for Photoshop 27.x. Check the
[version-specific Photoshop requirements](https://helpx.adobe.com/photoshop/desktop/get-started/technical-requirements-installation/adobe-photoshop-on-desktop-technical-requirements.html)
for the actual host. Do not interpret 25.0+ as supporting every macOS version.
Adobe also documents a cross-origin authorization-header redirect security fix in
Photoshop 26.9's UXP integration; prefer a maintained, patched host rather than the
oldest version that the manifest accepts. This is a host advisory, not an exploit
demonstrated against ExactFill. [Adobe changelog](https://developer.adobe.com/photoshop/uxp/ps_reference/changelog/).

## Before adding custom features

1. Remove the automatic curl/ExtendScript transport and retain direct HTTPS networking.
2. Define retention and clear-all behavior for prompts, images, history and keys.
3. Give a separately installed fork its own plugin ID to avoid colliding with ExactFill's
   identity and storage. Retain the upstream MIT license/attribution in the fork.
4. Develop through UDT and distribute with a CCX; document the chosen patched host baseline.

Not checked: Photoshop loading, rendering, pixel placement, release-ZIP/source equivalence,
actual OS file permissions, provider account/model availability, or exploitability by a
live attacker. No plugin, deployment, build or test script was executed. The findings
are a focused static review, not a guarantee that the entire repository is vulnerability-free.
