import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { root } from "./helpers.mjs";

const execFileAsync = promisify(execFile);

test("manifest is MV3 with only storage, tabs, and ordinary-page host access", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ["storage", "tabs"]);
  assert.deepEqual(manifest.host_permissions.sort(), ["http://*/*", "https://*/*"]);
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.equal(manifest.browser_specific_settings.gecko.data_collection_permissions.required[0], "none");
  assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.optional, ["websiteContent"]);
});

test("runtime has no analytics, screenshots, remote scripts, or unscoped network clients", async () => {
  const files = [
    "background.js",
    "shared/settings.js",
    "content/matcher.js",
    "content/privacy-engine.js",
    "content/content-script.js",
    "options/options.js"
  ];
  const source = (await Promise.all(files.map((file) => readFile(path.join(root, file), "utf8")))).join("\n").toLowerCase();
  const forbidden = [
    "mixpanel", "google-analytics", "segment.io", "amplitude", "sentry", "xmlhttprequest",
    "websocket", "capturevisibletab", "downloads.download", "tensorflow", "openai", "<script src=\"http"
  ];
  forbidden.forEach((token) => assert.equal(source.includes(token), false, `Unexpected runtime token: ${token}`));

  const nonBackgroundSource = (await Promise.all(files.slice(1).map((file) => readFile(path.join(root, file), "utf8")))).join("\n").toLowerCase();
  assert.equal(nonBackgroundSource.includes("fetch("), false, "Only the background image-classification port may use fetch");
  const background = await readFile(path.join(root, "background.js"), "utf8");
  assert.match(background, /nsfwFilterEnabled/);
  assert.match(background, /credentials:\s*"omit"/);
  assert.match(background, /referrerPolicy:\s*"no-referrer"/);
});

test("widget keeps only producer credit while Settings links to Labs and source", async () => {
  const source = await readFile(path.join(root, "content/content-script.js"), "utf8");
  const options = await readFile(path.join(root, "options/options.html"), "utf8");
  assert.match(source, /Produced by Wiplash\.ai/);
  assert.doesNotMatch(source, /labs\.wiplash\.ai|github\.com\/Wiplash-ai\/privacy-lens|ON-DEVICE DEFAULT|dataFlowLabel/);
  assert.match(options, /https:\/\/labs\.wiplash\.ai\/privacy-lens\//);
  assert.match(options, /https:\/\/github\.com\/Wiplash-ai\/privacy-lens/);
});

test("documentation explains permissions, local-first processing, restoration, regex, and opt-in images", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const privacy = await readFile(path.join(root, "PRIVACY.md"), "utf8");
  const listing = await readFile(path.join(root, "store-assets/LISTING.md"), "utf8");
  assert.match(readme, /built-in `tabs`/);
  assert.match(readme, /disabled by default/i);
  assert.match(readme, /compressed image/i);
  assert.match(readme, /custom\s+regex/i);
  assert.match(readme, /restore/i);
  assert.match(privacy, /page text/i);
  assert.match(privacy, /optional NSFW/i);
  assert.match(listing, /Permission justification/);
  assert.match(listing, /optional/i);
  await access(path.join(root, "docs/ARCHITECTURE.md"));
});

test("removed image stamp treatment is absent from user surfaces and runtime", async () => {
  const files = [
    "shared/settings.js",
    "content/privacy-engine.js",
    "content/content-script.js",
    "options/options.html"
  ];
  const source = (await Promise.all(files.map((file) => readFile(path.join(root, file), "utf8")))).join("\n");
  assert.doesNotMatch(source, /imageTreatment\s*===\s*["']stamp["']|value=["']stamp["']|data-image-treatment=["']stamp["']|MediaStamper/);
});

test("browser builds contain correct background formats and bundled icons", async () => {
  await execFileAsync(process.execPath, [path.join(root, "scripts/build.mjs")], { cwd: root });
  for (const browser of ["chrome", "edge", "opera"]) {
    const manifest = JSON.parse(await readFile(path.join(root, `dist/${browser}/manifest.json`), "utf8"));
    assert.equal(manifest.background.service_worker, "background.js");
    assert.equal("scripts" in manifest.background, false);
    assert.equal("browser_specific_settings" in manifest, false);
    await access(path.join(root, `dist/${browser}/assets/icons/icon128.png`));
    const config = await readFile(path.join(root, `dist/${browser}/shared/runtime-config.js`), "utf8");
    assert.match(config, /"environment": "production"/);
    assert.match(config, /https:\/\/labs\.wiplash\.ai\/privacy-lens\/api\/v1\/classify/);
    assert.doesNotMatch(config, /127\.0\.0\.1/);
  }

  const firefox = JSON.parse(await readFile(path.join(root, "dist/firefox/manifest.json"), "utf8"));
  assert.deepEqual(firefox.background.scripts, ["shared/runtime-config.js", "shared/settings.js", "background.js"]);
  assert.equal("service_worker" in firefox.background, false);
  assert.equal(firefox.browser_specific_settings.gecko.data_collection_permissions.required[0], "none");
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions.optional, ["websiteContent"]);

  const development = JSON.parse(await readFile(path.join(root, "dist/dev-chrome/manifest.json"), "utf8"));
  assert.match(development.name, /Dev/);
  const developmentConfig = await readFile(path.join(root, "dist/dev-chrome/shared/runtime-config.js"), "utf8");
  assert.match(developmentConfig, /"environment": "development"/);
  assert.match(developmentConfig, /https:\/\/labs\.wiplash\.ai\/privacy-lens\/api\/v1\/classify/);
  assert.doesNotMatch(developmentConfig, /127\.0\.0\.1/);
});
