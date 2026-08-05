# Privacy Lens store listing draft

## Short description

Blur or hide media; protect selected tab titles; redact chosen
secrets locally; and optionally screen compressed images with your API.

## Full description

Privacy Lens adds a compact, draggable privacy controller to ordinary webpages.
Use it before a screen share, recording, public presentation, or shoulder-surf
risk to blur or hide images/video, apply adjustable page blur, replace
revealing selected or all tab titles with “Top Secret,” and conceal emails,
phone numbers, payment cards, Bitcoin/crypto addresses and keys, API/access
tokens, credential values, or chosen literal terms.

Sensitive text can use a government-document-style black redaction or a blur.
Built-in categories are individually selectable, custom words stay literal,
and advanced users can add bounded custom regex secret types. The same session
tab picker is available from both the page widget and settings.

Every control is reversible. Dynamic page content is handled automatically.
Matching inputs and editable controls are visually concealed without changing
what the page stores, validates, copies, or submits. Form-field protection is
on by default and can be disabled in Settings. Preferences, custom rules, and
opt-in remembered-site rules stay in local browser storage.

Optional NSFW screening is disabled by default. If enabled, the extension
compresses page images to at most 512 px and sends only those image bytes to the
configured API. Safe verdicts reveal the image; unsafe, pending, and error
states stay blacked out. No image model is bundled, and no production endpoint
is deployed from this repository.

No account. No analytics. No page-text upload. No browsing-history sync. No
remote assets.

## Permission justification

- `storage`: remembers local preferences, widget position, and user-approved
  site rules, custom terms, regex rules, optional API endpoint/token, plus
  temporary selected-tab identifiers for the browser session.
- `tabs`: shows open tabs in local settings and applies title protection to the
  selected ordinary webpage tabs. Titles and URLs are never transmitted.
- Access to `http://*/*` and `https://*/*`: renders the controller, applies the
  requested reversible effects, and—only after NSFW opt-in—fetches and
  compresses page images and reaches the configured classifier.

Privacy Lens does not request history, downloads, clipboard, identity,
notifications, or network interception permissions. Firefox declares optional
website-content transmission and requests that consent only when remote image
screening is enabled.
