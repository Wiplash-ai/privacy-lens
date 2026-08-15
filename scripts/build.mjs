import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const sharedEntries = [
  "background.js",
  "shared",
  "content",
  "options",
  "assets",
  "LICENSE",
  "PRIVACY.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md"
];
const baseManifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));

await rm(dist, { recursive: true, force: true });
await Promise.all([
  buildChromium("chrome", "Privacy Lens"),
  buildChromium("edge", "Privacy Lens"),
  buildChromium("opera", "PrivacyLens"),
  buildFirefox(),
  buildDevelopmentChrome()
]);

async function buildChromium(browser, shortName) {
  const target = path.join(dist, browser);
  await copyShared(target);
  const manifest = structuredClone(baseManifest);
  manifest.short_name = shortName;
  delete manifest.browser_specific_settings;
  delete manifest.background.scripts;
  await writeManifest(target, manifest);
  await writeRuntimeConfig(target, "production", "https://labs.wiplash.ai/privacy-lens/api/v1/classify");
}

async function buildFirefox() {
  const target = path.join(dist, "firefox");
  await copyShared(target);
  await cp(
    path.join(root, "browser", "firefox-permissions.js"),
    path.join(target, "options", "firefox-permissions.js")
  );
  const optionsPath = path.join(target, "options", "options.html");
  const optionsHtml = await readFile(optionsPath, "utf8");
  await writeFile(
    optionsPath,
    optionsHtml.replace(
      '    <script src="options.js"></script>',
      '    <script src="firefox-permissions.js"></script>\n    <script src="options.js"></script>'
    )
  );
  const manifest = structuredClone(baseManifest);
  delete manifest.background.service_worker;
  await writeManifest(target, manifest);
  await writeRuntimeConfig(target, "production", "https://labs.wiplash.ai/privacy-lens/api/v1/classify");
}

async function buildDevelopmentChrome() {
  const target = path.join(dist, "dev-chrome");
  await copyShared(target);
  const manifest = structuredClone(baseManifest);
  manifest.name = "Privacy Lens Dev - Screen Share Blur";
  manifest.short_name = "Privacy Lens Dev";
  delete manifest.browser_specific_settings;
  delete manifest.background.scripts;
  await writeManifest(target, manifest);
  await writeRuntimeConfig(target, "development", "https://labs.wiplash.ai/privacy-lens/api/v1/classify");
}

async function copyShared(target) {
  await mkdir(target, { recursive: true });
  await Promise.all(sharedEntries.map((entry) => cp(
    path.join(root, entry),
    path.join(target, entry),
    { recursive: true }
  )));
}

async function writeManifest(target, manifest) {
  await writeFile(path.join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function writeRuntimeConfig(target, environment, defaultNsfwApiUrl) {
  const source = `"use strict";\n\n(() => {\n  const root = globalThis;\n  root.PrivacyLens ||= {};\n  root.PrivacyLens.Config = Object.freeze(${JSON.stringify({ environment, defaultNsfwApiUrl }, null, 2)});\n})();\n`;
  await writeFile(path.join(target, "shared", "runtime-config.js"), source);
}

console.log("Built production Chrome, Edge, Opera, and Firefox packages plus dist/dev-chrome/.");
