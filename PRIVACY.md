# Privacy Lens Privacy Policy

Effective August 4, 2026

Privacy Lens is local-first. Its page effects, text detection, tab-title
controls, and settings work inside the browser. The extension does not send
page text, browsing history, source page URLs, tab titles, custom terms, custom
regex rules, settings, analytics, crash reports, or usage events to Wiplash AI.

The extension reads rendered page text, form values, and page elements only to
apply the privacy controls the user requests. When Secrets and form-field
protection are enabled, it checks input and editable-field values locally and
adds a reversible visual mask to matching fields. It does not replace, submit,
store, or transmit those values. Scripts and styles remain excluded from text
matching. When the user opens tab-title controls, Privacy Lens reads open tab
titles and URLs locally so the user can choose which ordinary webpage tabs to
protect.

If the user adds custom terms, custom regex secret types, or disables built-in
detection categories, those preferences are stored locally and supplied only
to the on-page matcher. Built-in payment-card rules require a Luhn-valid number,
while conservative Bitcoin and cryptocurrency rules recognize common address,
public-key, and private-key encodings. Regex patterns are length- and
count-limited, and unsafe constructs are rejected. They are never uploaded or
used for training.

## Optional NSFW image screening

Remote image screening is disabled by default. If the user explicitly enables
it, Privacy Lens fetches an image without page credentials or a referrer,
rasterizes it to a JPEG with a maximum 512 px edge, and sends the compressed
image to the endpoint configured by the user. The request also includes the
extension version and the number 512. It does not include the source image URL,
page URL, page title, page text, tab identifier, redaction rules, or browsing
history. A user may optionally store a bearer token for that endpoint in local
extension storage.

The API operator receives the compressed image and can also observe ordinary
network metadata such as the user's IP address and request time. Retention,
caching, training, security, and legal practices are controlled by that
operator. Review its policy before enabling the feature. The Wiplash endpoint's
current policy is published at https://labs.wiplash.ai/privacy-lens/privacy/.
Until a safe response arrives, and after any unsafe response, timeout, or error,
Privacy Lens keeps the image concealed.

Privacy Lens stores preferences (including custom terms, regex rules, endpoint,
and optional token), widget position, site rules the user explicitly chooses to
remember, and temporary selected-tab identifiers for the current browser
session. It does not store tab titles or URLs as browsing history. Users can
disable remote screening, clear site rules, reset settings, restore tabs/pages,
or uninstall the extension at any time.

Privacy Lens contains no account system, analytics SDK, advertising SDK, CDN,
or AI model in its extension packages. The optional classifier is the only
external data flow.
Questions or privacy requests may be sent to
[support@wiplash.ai](mailto:support@wiplash.ai).

This document describes the extension's current technical behavior. Endpoint
operators should obtain legal review for their own privacy notice, retention,
model-training, regional, and children's-privacy obligations before production
use.
