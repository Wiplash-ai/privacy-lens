<p align="center">
  <img src="assets/brand-mark.svg" alt="Privacy Lens logo" width="116">
</p>

<h1 align="center">Privacy Lens</h1>

<p align="center">A local-first privacy layer for safer displays, recordings, screen shares, and public browsing.</p>

Privacy Lens is a framework-free Manifest V3 extension for Chrome, Edge,
Firefox, and Opera. It gives each page four reversible privacy layers from one
draggable widget:

- Blur, hide, or black out images and video. Large blackouts receive a diagonal
  Top Secret stamp; small media becomes a clean black redaction.
- Blur the whole page with distinct soft-focus and frosted treatments.
- Redact or blur emails, phone numbers, credentials, tokens, sensitive link
  labels, custom phrases, and bounded custom regex rules.
- Replace the current, selected, or every accessible tab title with
  **Top Secret**, then restore the latest original titles.

Everything above runs inside the browser. There is no account, analytics,
advertising, remote script, or screenshot capture. Settings and optional site
rules stay in extension storage, and one restore action removes every page
effect.

## Optional image screening

An advanced NSFW image treatment is disabled by default. When a user explicitly
enables it, Privacy Lens fetches an image without credentials or a referrer,
rasterizes it to a JPEG no larger than 512 px on either edge, and sends only the
compressed image to the configured classifier endpoint. Pending, unsafe,
timeout, malformed, and error results remain blacked out; only an explicit
`safe: true` verdict reveals the image.

Privacy Lens does not ship an AI model or classifier service. The public,
model-agnostic API contract is documented at
[labs.wiplash.ai/privacy-lens/api-docs](https://labs.wiplash.ai/privacy-lens/api-docs/),
and users may configure their own compatible endpoint. Video classification is
outside v1; ordinary video still follows the local blur, hide, and stamp
controls.

## Permissions

- `storage` saves local preferences, widget position, custom terms and regex
  rules, optional endpoint configuration, and remembered site rules.
- The browser's built-in `tabs` API lists open tabs for local title selection
  and sends title-protection commands to ordinary webpage tabs. Titles and URLs
  are not transmitted or retained as browsing history.
- `http://*/*` and `https://*/*` let the content controller apply reversible
  effects on ordinary pages and fetch an image only when optional screening is
  enabled.

No scripting, history, downloads, clipboard, notification, identity, or
network-interception permission is requested. Browser-owned and store pages
remain inaccessible. Firefox asks for optional `websiteContent` transmission
consent only when remote image screening is enabled.

## Development

Requirements: Node.js 20+, npm, `zip`, and a Chromium-compatible browser.

```bash
npm install
npm test
npm run build
npm run package:stores
npm run verify:browser
```

`npm run build` generates unpacked builds under `dist/` for Chrome, Edge,
Opera, Firefox, and development Chrome. `npm run package:stores` writes one
archive per supported browser to `artifacts/packages/`. `npm run verify` runs
unit, release-invariant, packaging, and real-browser integration checks.

The browser integration uses a deterministic test fixture and classifier stub.
It covers all four widget controls, four image treatments, both text
treatments, linked-label redaction, dynamic DOM updates, custom phrases and
regex rules, tab selection, all-tab title protection, restoration, and
desktop/mobile bounds.

## Load unpacked

Chrome, Edge, or Opera:

1. Run `npm run build`.
2. Open the browser's extension-management page and enable developer mode.
3. Select **Load unpacked** and choose the matching directory under `dist/`.

Firefox:

1. Run `npm run build`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on** and choose `dist/firefox/manifest.json`.

## Repository boundary

This public repository contains only the extension, its tests, build tooling,
store copy, and a deterministic browser-test fixture. The Wiplash Labs website,
live demo, and classifier implementation are maintained separately and are not
part of this repository.

## License

[MIT](LICENSE). Produced by Wiplash AI.
