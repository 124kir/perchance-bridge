# Perchance Bridge

Bring images into your SillyTavern chats with Perchance. Generate good-looking images for free using a browser-based service: there is no ComfyUI installation, local image model, powerful GPU or dedicated image-generation hardware to set up. You can write a prompt yourself or ask your connected text model to describe the current scene.

Perchance is a third-party service: availability, quality and any usage limits depend on that service. Using a text model to prepare a prompt may incur charges from your text-model provider; you can enter a prompt manually instead.

**Extension:** 0.7.0 · **Companion userscript:** 0.5.0 · **Minimum SillyTavern version:** 1.19.0

## Features

- Generate from a prompt, chat menu, slash command or AI tool.
- Draft prompts from the chat using the connected text model and SillyTavern's Image Generation templates.
- Review and edit prompts before sending; use negative prompts, text-based styles and batches of 1–8 images.
- Import images made manually, including in Perchance Professional.
- English interface by default, with a Russian option in extension settings.

Bridge is separate from the built-in Image Generation backend: `/sd` continues to use its own configuration. Bridge's text styles are not Perchance Professional's native styles.

## Installation

1. Install this repository in SillyTavern's `public/scripts/extensions/third-party/perchance-bridge` directory and refresh SillyTavern.
2. Install a userscript manager in the same browser. Create a script from [perchance-companion.user.js](perchance-companion.user.js) and save it. If upgrading an existing companion, replace its contents with version 0.5.0.
3. Open SillyTavern on `localhost` or `127.0.0.1`, open the Perchance Bridge settings and click **Connect channel — open Perchance tab**.
4. Complete any Perchance access check manually. Keep the tab open, enter a prompt and generate from the panel or chat menu.

To change the interface language, select **Language / Язык** in the extension settings and refresh the SillyTavern page. The choice is saved.

The companion uses userscript-manager storage to communicate between local SillyTavern and the Perchance tab. It runs on local addresses, the Perchance Image API page and the embedded generator host listed in the script. Changes to the host, browser or site restrictions may break the connection. The experimental iframe mode can also be blocked; manual image import is available.

## Usage

`/perchance a red fox in the forest` generates from a supplied prompt. `/perchance` without an argument drafts a prompt from the chat. Other commands include `/perchance-you`, `/perchance-face`, `/perchance-me`, `/perchance-story`, `/perchance-last`, `/perchance-raw-last`, `/perchance-background`, `/perchance-cast`, `/perchance-count 3` and `/perchance-style anime`.

Raw Last uses the latest non-system message without calling the text model. Background adds an image to the chat; it does not change the interface background.

Prompt review is enabled by default. A batch is confirmed once and generated sequentially. Cancellation or an error stops remaining requests; completed results are kept. Cancelling local waiting does not guarantee that generation in the Perchance tab has stopped.

## Data and limitations

When drafting from chat, SillyTavern sends context to your configured text-model provider. The final visual prompt and generation parameters are sent to Perchance. Transport messages temporarily pass through userscript-manager storage and are deleted after sending. Bridge diagnostics record technical events and counts rather than prompt or model response text.

Synthetic tests verify the code and transport, but cannot guarantee compatibility with every browser, userscript manager or current state of Perchance. The complete live workflow with companion 0.5.0 has not yet been verified end to end.

## Development

Run the synthetic tests with a Node.js version that supports the built-in test runner:

```powershell
node --test tests/*.test.mjs
```

The tests do not require personal chats or a connection to Perchance. The HTML development fixtures in `tests/` may offer actions that make real requests; check their purpose before using them.

## License

[MIT](LICENSE).
