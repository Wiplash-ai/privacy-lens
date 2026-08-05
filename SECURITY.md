# Security Policy

Report suspected security or privacy issues privately to
[support@wiplash.ai](mailto:support@wiplash.ai). Include the browser, extension
version, reproduction steps, and expected impact, but do not include real page
content, credentials, or private browsing data.

Privacy Lens requests local storage, the browser's built-in tabs API for
user-selected title protection, and access to ordinary HTTP/HTTPS pages. Core
controls have no remote runtime dependency. Optional NSFW screening is disabled
by default and uses a single background-only network port.

Custom regex patterns are limited to 160 characters and 20 rules. Backreferences,
lookbehind, nested repetition, repeated alternation, and multiple unbounded
wildcards are rejected, matching is capped per rule, and scanning is limited to
4,096-character text-node slices. These checks reduce but do
not mathematically eliminate regular-expression denial-of-service risk.

Remote image requests omit credentials and referrers. Source images are capped
at 10 MB, rasterized to JPEG with a maximum 512 px edge, and sent without their
source/page URL. API calls time out after 12 seconds, reject redirects, cap JSON
responses at 64 KB, and validate the boolean verdict. HTTPS is required except
for loopback development. Failures keep images blacked out.

Bearer tokens are stored in local extension storage, not a hardware-backed
secret vault. Use a narrowly scoped, revocable token and an endpoint with rate
limits, authentication, request limits, log redaction, short retention, and an
appropriate abuse-reporting process.
