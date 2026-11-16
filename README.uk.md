# ExactFill for Photoshop

[Primary English README](README.md)

Exact AI edits, placed exactly in the selected area.

ExactFill is a free, open-source Photoshop plugin that connects directly to
WaveSpeedAI, OpenAI and Google Gemini with your own API keys. Select an area, describe the
change, and get the result back as a precisely placed Smart Object with a
native Photoshop layer mask.

> No account, no ExactFill server, and no internal credits. You pay the AI
> provider directly and see an API cost estimate inside the plugin.

## Demo

[![ExactFill adding a saddle and rider in Photoshop](docs/assets/demo-after.jpg)](https://zgmrclick.github.io/exactfill-photoshop/)

Try the [interactive before/after comparison](https://zgmrclick.github.io/exactfill-photoshop/)
or watch the [22-second Photoshop recording](docs/assets/exactfill-demo.mp4). The demo
uses a real selection and shows the result as a precisely placed layer.

## Why ExactFill

- Precise placement in the original selection, including odd and fractional bounds.
- A non-destructive Smart Object and a native Photoshop layer mask.
- RGB, CMYK, Grayscale, and Lab; 8/16/32-bit documents are not converted.
- WaveSpeedAI, OpenAI GPT Image (including GPT Image 2.5) and Google Gemini in one panel.
- Edge blending, context, references, a transparent background, and lossless input.
- OpenAI intermediate frames when the API and UXP support a streaming response.
- Persistent cost statistics, history, presets, and a local result cache.
- An English interface. The `uk` locale code remains as a compatibility alias with the same English text.

## Install

Download `ExactFill-1.7.1.zip` from the
[Releases](https://github.com/zgmrclick/exactfill-photoshop/releases) page, extract
the archive completely, and close Photoshop.

### Windows

Copy the entire `ExactFill` folder to your Photoshop `Plug-ins` folder, for example:

```text
C:\Program Files\Adobe\Adobe Photoshop 2026\Plug-ins\ExactFill
```

### macOS

Copy the entire `ExactFill` folder to your Photoshop `Plug-ins` folder, for example:

```text
/Applications/Adobe Photoshop 2026/Plug-ins/ExactFill
```

Start Photoshop and open **Plugins → ExactFill**. In the final `ExactFill` folder,
`manifest.json` must sit directly inside it. If you are upgrading a private **AI Image**
build, replace its old `AiImagePS` folder instead of keeping both copies.

## First run

1. Open a document and make a selection.
2. In Settings, paste an OpenRouter API key for the edit conversation.
   Settings is available before a key is saved.
3. Choose WaveSpeedAI, OpenAI or Google Gemini and paste that provider's API key.
   A new install starts on WaveSpeedAI.
4. Describe the change in the conversation. A clear request generates immediately.
5. Review the new Smart Object and adjust its mask if needed.

API keys are stored through Photoshop UXP `secureStorage`. The conversation and
selected image go to OpenRouter. The edit brief, selected pixels, and extra
references then go to the selected provider. See the
[privacy policy](PRIVACY.md) for details.

## Cost

ExactFill is free. WaveSpeedAI, OpenAI and Google may charge for API use. The plugin keeps a
local ledger and shows an estimated USD cost when the API response has enough
data. Prices and model availability can change; the provider's bill is always
final.

## Compatibility

- Adobe Photoshop 2024 or newer (`25.0+`).
- Windows and macOS use the same plugin.
- An internet connection, an OpenRouter key, and an API key for the selected image provider are required.
- Final behavior on Windows should be checked in a real Photoshop on Windows.

### Firewalls and proxies

ExactFill connects to the provider directly from Photoshop/UXP over HTTPS. If a
firewall, proxy, or security policy restricts Photoshop, allow outbound TCP
port 443 to the domain of the provider you need:

- OpenRouter (edit conversation): `openrouter.ai`
- WaveSpeedAI: `api.wavespeed.ai`
- OpenAI: `api.openai.com`
- Google Gemini: `generativelanguage.googleapis.com`

The network permission in `manifest.json` applies only inside the UXP sandbox; the
plugin cannot change or bypass a system firewall. On macOS, add these domains to
the allow rules for Photoshop/Adobe UXP in your network-filtering app. On Windows,
check **Windows Defender Firewall with Advanced Security → Outbound Rules** and
third-party firewalls. [Per Microsoft's rules](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules#rule-precedence-for-inbound-and-outbound-rules)
an explicit `Block` takes priority over a conflicting `Allow`, so a broad Photoshop
block must be disabled or replaced by a policy that supports the required domain
exceptions. Do not use fixed IP addresses: provider addresses can change.

The same English instructions are in `INSTALL.txt` of every release, including the
former Ukrainian section now translated in place.

## Bugs and support

Use the **Report a bug** form in the panel, or open a
[GitHub Issue](https://github.com/zgmrclick/exactfill-photoshop/issues/new/choose).
The form can add the version, OS, provider, model, and settings, but it does not add
API keys, prompts, document names, paths, images, or usage history.

ExactFill is free and open source. If it saves you time,
[support development on Ko-fi](https://ko-fi.com/havryil89140). A GitHub star, a
useful bug report, a short demo, or recommending it to a colleague also helps.

## Development

No npm dependencies need to be installed:

```bash
npm test
npm run build
```

License: [MIT](LICENSE).
