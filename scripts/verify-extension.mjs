import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(root, "dist", "dev-chrome");
const demoRoot = path.join(root, "tests", "fixtures", "browser-page");
const screenshotRoot = path.join(root, "artifacts", "review");
const profile = await mkdtemp(path.join(os.tmpdir(), "privacy-lens-playwright-"));
const server = createDemoServer(demoRoot);

await mkdir(screenshotRoot, { recursive: true });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const demoUrl = `http://127.0.0.1:${address.port}/`;
const classifierUrl = process.env.PRIVACY_LENS_TEST_API_URL || "https://classifier.test/privacy-lens/api/v1/classify";

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
    "--disable-default-apps"
  ],
  viewport: { width: 1280, height: 800 }
});

if (!process.env.PRIVACY_LENS_TEST_API_URL) {
  await context.route("https://classifier.test/**", async (route) => {
    const body = route.request().postDataBuffer() || Buffer.alloc(0);
    if (!body.includes(Buffer.from('name="image"'))) {
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "missing_image", message: "image is required" } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ safe: false, score: 0.96, model: "deterministic-test-stub", request_id: "browser-test" }) });
  });
}

try {
  let worker = context.serviceWorkers().find((candidate) => candidate.url().endsWith("/background.js"));
  if (!worker) {
    worker = await context.waitForEvent("serviceworker", {
      predicate: (candidate) => candidate.url().endsWith("/background.js"),
      timeout: 8000
    });
  }
  assert.ok(worker, "Privacy Lens service worker should start");
  const savedSettings = await callBackground(worker, {
    type: "PRIVACY_LENS_SAVE_SETTINGS",
    settings: {
      customTerms: ["Project Nightfall", "Jo Lane"],
      customRegexRules: [{ id: "episode-id", name: "Episode IDs", pattern: "Episode [0-9]{2}", flags: "i" }],
      nsfwFilterEnabled: true,
      nsfwApiUrl: classifierUrl
    }
  });
  assert.equal(savedSettings.settings.neutralTitle, "Top Secret");

  const page = context.pages()[0] || await context.newPage();
  await page.goto(demoUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(450);
  const tabId = await findDemoTab(worker, address.port);

  await page.screenshot({ path: path.join(screenshotRoot, "demo-clear.png"), fullPage: false });
  await sendToTopFrame(worker, tabId, { type: "PRIVACY_LENS_TOGGLE_WIDGET" });
  const host = page.locator("#privacy-lens-widget-host");
  await host.waitFor({ state: "visible" });
  await sendToTopFrame(worker, tabId, { type: "PRIVACY_LENS_SET_WIDGET_EXPANDED", expanded: true });

  const mediaBlurState = {
    imagesProtected: true,
    imageTreatment: "blur",
    blurEnabled: false,
    blurStrength: 11,
    blurTreatment: "soft",
    titleProtected: false,
    sensitiveMasked: true,
    textTreatment: "blur"
  };
  const mediaBlurResponse = await sendToTopFrame(worker, tabId, {
    type: "PRIVACY_LENS_APPLY_STATE",
    state: mediaBlurState,
    neutralTitle: "Top Secret"
  });
  assert.equal(mediaBlurResponse.ok, true);
  assert.equal(await page.locator("html").evaluate((element) => element.classList.contains("privacy-lens-private-images-blurred")), true);
  assert.match(await page.locator("#sensitiveStill").evaluate((element) => getComputedStyle(element).filter), /blur\(11px\)/);
  assert.match(await page.locator("#sensitiveVideo").evaluate((element) => getComputedStyle(element).filter), /blur\(11px\)/);
  assert.equal(await page.locator("html").evaluate((element) => element.classList.contains("privacy-lens-private-text-blurred")), true);
  await page.screenshot({ path: path.join(screenshotRoot, "media-blur-default.png"), fullPage: false });
  await sendToTopFrame(worker, tabId, { type: "PRIVACY_LENS_HIDE_WIDGET" });
  await host.waitFor({ state: "hidden" });
  await page.locator(".sensitive-copy").screenshot({ path: path.join(screenshotRoot, "document-text-blur.png") });
  await sendToTopFrame(worker, tabId, { type: "PRIVACY_LENS_SHOW_WIDGET" });
  await sendToTopFrame(worker, tabId, { type: "PRIVACY_LENS_SET_WIDGET_EXPANDED", expanded: true });

  await sendToTopFrame(worker, tabId, {
    type: "PRIVACY_LENS_APPLY_STATE",
    state: { ...mediaBlurState, imageTreatment: "hidden" },
    neutralTitle: "Top Secret"
  });
  assert.equal(await page.locator("#sensitiveStill").evaluate((element) => getComputedStyle(element).visibility), "hidden");
  assert.equal(await page.locator("#sensitiveVideo").evaluate((element) => getComputedStyle(element).visibility), "hidden");

  const nsfwResponse = await sendToTopFrame(worker, tabId, {
    type: "PRIVACY_LENS_APPLY_STATE",
    state: { ...mediaBlurState, imageTreatment: "nsfw", sensitiveMasked: false },
    neutralTitle: "Top Secret"
  });
  assert.equal(nsfwResponse.ok, true);
  await page.waitForFunction(() => ["safe", "unsafe"].includes(document.getElementById("sensitiveStill")?.dataset.privacyLensNsfwStatus));
  const modelVerdict = await page.locator("#sensitiveStill").getAttribute("data-privacy-lens-nsfw-status");
  const modelFilter = await page.locator("#sensitiveStill").evaluate((element) => getComputedStyle(element).filter);
  if (modelVerdict === "unsafe") assert.match(modelFilter, /brightness\(0\)/);
  else assert.doesNotMatch(modelFilter, /brightness\(0\)/);
  await page.screenshot({ path: path.join(screenshotRoot, "media-nsfw-api-verdict.png"), fullPage: false });

  const redactionOnlyResponse = await sendToTopFrame(worker, tabId, {
    type: "PRIVACY_LENS_APPLY_STATE",
    state: {
      ...mediaBlurState,
      imagesProtected: false,
      sensitiveMasked: true,
      textTreatment: "redact"
    },
    neutralTitle: "Top Secret"
  });
  assert.ok(redactionOnlyResponse.maskCount >= 9);
  const protectedFields = await page.locator("#producerEmail, #producerPhone, #recordingPassword, #privateNote, #paymentCard, #bitcoinKey, .monaco-editor").evaluateAll((fields) => fields.map((field) => ({
    id: field.id || "editor",
    masked: field.getAttribute("data-privacy-lens-sensitive-field"),
    value: typeof field.value === "string" ? field.value : field.textContent,
    background: getComputedStyle(field).backgroundColor,
    fill: getComputedStyle(field).webkitTextFillColor
  })));
  assert.equal(protectedFields.every((field) => field.masked === "true"), true, "Sensitive form and editor values should receive a visual mask");
  assert.equal(protectedFields.every((field) => field.background === "rgb(9, 8, 6)"), true, "Redacted fields should render as opaque black bars");
  assert.match(protectedFields.find((field) => field.id === "producerEmail").value, /producer\.private@example\.com/);
  assert.match(protectedFields.find((field) => field.id === "producerPhone").value, /512-555-0188/);
  assert.equal(protectedFields.find((field) => field.id === "recordingPassword").value, "FixtureOnly!48");
  assert.match(protectedFields.find((field) => field.id === "paymentCard").value, /4111 1111 1111 1111/);
  assert.match(protectedFields.find((field) => field.id === "bitcoinKey").value, /^K/);
  const recordingPasswordMasked = await page.locator("pre code").evaluate((code) => {
    const highlight = globalThis.CSS?.highlights?.get("privacy-lens-sensitive");
    if (highlight) {
      return [...highlight].some((range) => code.contains(range.startContainer) && range.toString() === "FixtureOnly!48");
    }
    return !/FixtureOnly!48/.test(code.textContent || "");
  });
  assert.equal(recordingPasswordMasked, true, "Prefixed recording_password assignments should conceal only their value");
  for (const { selector, firstCharacter, restoredValue } of [
    { selector: "#producerPhone", firstCharacter: "5", restoredValue: "+1 512-555-0188" },
    { selector: "#recordingPassword", firstCharacter: "s", restoredValue: "FixtureOnly!48" }
  ]) {
    const field = page.locator(selector);
    await field.fill("");
    await page.waitForFunction((fieldSelector) => !document.querySelector(fieldSelector)?.hasAttribute("data-privacy-lens-sensitive-field"), selector);
    await field.pressSequentially(firstCharacter);
    await page.waitForFunction((fieldSelector) => document.querySelector(fieldSelector)?.getAttribute("data-privacy-lens-sensitive-field") === "true", selector);
    assert.equal(await field.inputValue(), firstCharacter, `${selector} should keep the first typed character while concealing it visually`);
    await field.fill(restoredValue);
    await page.waitForFunction((fieldSelector) => document.querySelector(fieldSelector)?.getAttribute("data-privacy-lens-sensitive-field") === "true", selector);
  }
  const linkedSecretState = await page.locator("#linkedSecret").evaluate((link) => {
    const highlight = globalThis.CSS?.highlights?.get("privacy-lens-sensitive");
    const highlighted = highlight
      ? [...highlight].some((range) => link.contains(range.startContainer))
      : !/Jo Lane|jo@night-signal\.test/i.test(link.textContent || "");
    return { highlighted, href: link.getAttribute("href") };
  });
  assert.equal(linkedSecretState.highlighted, true, "Detected text inside a link should be visibly redacted");
  assert.equal(linkedSecretState.href, "mailto:jo@fixture.test");
  const aliasLinkState = await page.locator("#aliasSecretLink").evaluate((link) => {
    const highlight = globalThis.CSS?.highlights?.get("privacy-lens-sensitive");
    const highlighted = highlight
      ? [...highlight].some((range) => link.contains(range.startContainer))
      : !/Account manager/i.test(link.textContent || "");
    return { highlighted, href: link.getAttribute("href") };
  });
  assert.equal(aliasLinkState.highlighted, true, "A sensitive link destination should conceal its visible alias");
  assert.equal(aliasLinkState.href, "mailto:classified.agent@fixture.test");
  const hiddenWidget = await sendToTopFrame(worker, tabId, { type: "PRIVACY_LENS_HIDE_WIDGET" });
  assert.equal(hiddenWidget.visible, false);
  await host.waitFor({ state: "hidden" });
  await page.locator(".sensitive-copy").screenshot({ path: path.join(screenshotRoot, "document-redaction.png") });
  await page.locator("#producerEmail").locator("..").screenshot({ path: path.join(screenshotRoot, "form-field-redaction.png") });
  await sendToTopFrame(worker, tabId, { type: "PRIVACY_LENS_SHOW_WIDGET" });
  await sendToTopFrame(worker, tabId, { type: "PRIVACY_LENS_SET_WIDGET_EXPANDED", expanded: true });

  const softState = {
    imagesProtected: true,
    imageTreatment: "blur",
    blurEnabled: true,
    blurStrength: 11,
    blurTreatment: "soft",
    titleProtected: true,
    sensitiveMasked: true,
    textTreatment: "redact"
  };
  const softResponse = await sendToTopFrame(worker, tabId, {
    type: "PRIVACY_LENS_APPLY_STATE",
    state: softState,
    neutralTitle: "Top Secret"
  });
  assert.equal(softResponse.ok, true);
  assert.equal(await page.locator("html").evaluate((element) => element.classList.contains("privacy-lens-private-blur-soft")), true);
  const softFilter = await page.locator("body").evaluate((element) => getComputedStyle(element).filter);
  assert.match(softFilter, /blur\(11px\)/);
  assert.doesNotMatch(softFilter, /grayscale/);

  const protectedState = { ...softState, blurTreatment: "frosted" };
  const response = await sendToTopFrame(worker, tabId, {
    type: "PRIVACY_LENS_APPLY_STATE",
    state: protectedState,
    neutralTitle: "Top Secret"
  });
  assert.equal(response.ok, true);
  assert.ok(response.maskCount >= 9, `Expected at least 9 built-in/custom sensitive matches, found ${response.maskCount}`);

  await page.waitForFunction(() => document.title === "Top Secret");
  assert.equal(await page.title(), "Top Secret");
  assert.equal(await page.locator("html").evaluate((element) => element.classList.contains("privacy-lens-private-images-blurred")), true);
  assert.equal(await page.locator("html").evaluate((element) => element.classList.contains("privacy-lens-private-blur-frosted")), true);
  const frostedFilter = await page.locator("body").evaluate((element) => getComputedStyle(element).filter);
  assert.match(frostedFilter, /grayscale\(1\)/);
  assert.match(frostedFilter, /contrast\(0\.58\)/);
  assert.equal(await page.locator("html").evaluate((element) => element.classList.contains("privacy-lens-private-text-redacted")), true);
  assert.match(await page.locator("#sensitiveStill").evaluate((element) => getComputedStyle(element).filter), /blur\(11px\)/);
  assert.equal(await page.locator("#producerEmail").inputValue(), "producer.private@example.com");
  assert.match(await page.locator("#producerPhone").inputValue(), /512-555-0188/);
  assert.equal(await page.locator("#recordingPassword").inputValue(), "FixtureOnly!48");
  assert.match(await page.locator("#privateNote").inputValue(), /512-555-0122/);
  assert.equal(await page.locator("#paymentCard").inputValue(), "4111 1111 1111 1111");
  assert.match(await page.locator("#bitcoinKey").inputValue(), /^K/);
  assert.match(await page.locator(".monaco-editor").textContent(), /keep-editor-values-untouched/);

  const firstMaskCount = response.maskCount;
  await page.locator("#addContact").click({ force: true });
  await page.waitForFunction(() => document.querySelectorAll("[data-demo-update]").length === 1);
  await page.waitForTimeout(120);
  const dynamicState = await sendToTopFrame(worker, tabId, { type: "PRIVACY_LENS_GET_STATE" });
  assert.ok(dynamicState.maskCount >= firstMaskCount + 2, "Dynamic email and phone should be masked");

  await page.evaluate(() => { document.title = "Night Signal — Updated Private Rundown"; });
  await page.waitForFunction(() => document.title === "Top Secret");
  const hostRect = await host.boundingBox();
  assert.ok(hostRect && hostRect.x >= 0 && hostRect.y >= 0 && hostRect.x + hostRect.width <= 1280 && hostRect.y + hostRect.height <= 800, "Desktop widget should remain inside the viewport");
  await page.screenshot({ path: path.join(screenshotRoot, "desktop-protected.png"), fullPage: false });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(180);
  const mobileRect = await host.boundingBox();
  assert.ok(mobileRect && mobileRect.x >= 0 && mobileRect.y >= 0 && mobileRect.x + mobileRect.width <= 390 && mobileRect.y + mobileRect.height <= 844, `Mobile widget should remain inside the viewport: ${JSON.stringify(mobileRect)}`);
  await page.screenshot({ path: path.join(screenshotRoot, "mobile-protected.png"), fullPage: false });

  const reset = await sendToTopFrame(worker, tabId, {
    type: "PRIVACY_LENS_RESET",
    state: { blurStrength: 12, blurTreatment: "soft" },
    neutralTitle: "Top Secret"
  });
  assert.equal(reset.ok, true);
  await page.waitForFunction(() => document.title === "Night Signal — Updated Private Rundown");
  assert.equal(await page.locator("html").evaluate((element) => [...element.classList].some((name) => name.startsWith("privacy-lens-private-"))), false);
  assert.notEqual(await page.locator(".hero-art img").evaluate((element) => getComputedStyle(element).visibility), "hidden");
  assert.equal(await page.locator("#producerEmail").getAttribute("data-privacy-lens-sensitive-field"), null);
  assert.equal(await page.locator("#producerPhone").getAttribute("data-privacy-lens-sensitive-field"), null);
  assert.equal(await page.locator("#recordingPassword").getAttribute("data-privacy-lens-sensitive-field"), null);
  assert.equal(await page.locator("#paymentCard").getAttribute("data-privacy-lens-sensitive-field"), null);
  assert.equal(await page.locator("#producerEmail").inputValue(), "producer.private@example.com");

  await page.setViewportSize({ width: 1280, height: 800 });
  const secondPage = await context.newPage();
  await secondPage.goto(`${demoUrl}?tab=second`, { waitUntil: "domcontentloaded" });
  await secondPage.evaluate(() => { document.title = "Second confidential rundown"; });
  await secondPage.waitForTimeout(220);
  const secondTabId = await findDemoTab(worker, address.port, "tab=second");

  const pickerResponse = await sendToTopFrame(worker, tabId, {
    type: "PRIVACY_LENS_SET_TAB_PICKER_EXPANDED",
    expanded: true
  });
  assert.equal(pickerResponse.ok, true);
  assert.ok(pickerResponse.tabCount >= 2, "Widget tab dropdown should list open webpage tabs");
  await page.screenshot({ path: path.join(screenshotRoot, "widget-tab-dropdown.png"), fullPage: false });

  let titleTabs = await callBackground(worker, {
    type: "PRIVACY_LENS_SET_TAB_TITLE_PRIVACY",
    tabId: secondTabId,
    enabled: true
  });
  assert.equal(titleTabs.ok, true);
  await secondPage.waitForFunction(() => document.title === "Top Secret");
  assert.equal(await page.title(), "Night Signal — Updated Private Rundown");
  assert.equal(titleTabs.tabs.find((tab) => tab.id === secondTabId).protected, true);
  assert.equal(titleTabs.tabs.find((tab) => tab.id === secondTabId).title, "Second confidential rundown");

  titleTabs = await callBackground(worker, { type: "PRIVACY_LENS_SET_ALL_TABS_TITLE_PRIVACY", enabled: true });
  assert.equal(titleTabs.allTabsProtected, true);
  await page.waitForFunction(() => document.title === "Top Secret");
  await secondPage.waitForFunction(() => document.title === "Top Secret");

  titleTabs = await callBackground(worker, { type: "PRIVACY_LENS_SET_ALL_TABS_TITLE_PRIVACY", enabled: false });
  assert.equal(titleTabs.allTabsProtected, false);
  await page.waitForFunction(() => document.title === "Night Signal — Updated Private Rundown");
  await secondPage.waitForFunction(() => document.title === "Second confidential rundown");

  titleTabs = await callBackground(worker, {
    type: "PRIVACY_LENS_SET_TAB_TITLE_PRIVACY",
    tabId: secondTabId,
    enabled: true
  });
  assert.equal(titleTabs.tabs.find((tab) => tab.id === secondTabId).protected, true);

  const extensionId = new URL(worker.url()).hostname;
  const optionsPage = await context.newPage();
  await optionsPage.setViewportSize({ width: 1280, height: 800 });
  await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`, { waitUntil: "domcontentloaded" });
  await optionsPage.locator("#settingsForm").waitFor({ state: "visible" });
  await optionsPage.locator("[data-tab-id]").first().waitFor({ state: "attached" });
  assert.equal(await optionsPage.getByText("No network connection").count(), 0);
  assert.equal(await optionsPage.locator("input[name='defaultImageTreatment'][value='blur']").isChecked(), true);
  assert.equal(await optionsPage.locator("input[name='defaultTextTreatment'][value='redact']").isChecked(), true);
  assert.equal(await optionsPage.locator("#protectFormFields").isChecked(), true);
  assert.equal(await optionsPage.locator("[data-redaction-type='payment-card']").isChecked(), true);
  assert.equal(await optionsPage.locator("[data-redaction-type='crypto']").isChecked(), true);
  assert.equal(await optionsPage.locator("#neutralTitle").inputValue(), "Top Secret");
  assert.match(await optionsPage.locator("#customTerms").inputValue(), /Project Nightfall/);
  assert.equal(await optionsPage.locator("#nsfwFilterEnabled").isChecked(), true);
  assert.match(await optionsPage.locator("#nsfwApiUrl").inputValue(), /privacy-lens\/api\/v1\/classify/);
  await optionsPage.locator("#customTerms").focus();
  await optionsPage.locator("#customTerms").press("End");
  await optionsPage.locator("#customTerms").pressSequentially("\nQuarterly layoffs", { delay: 12 });
  await optionsPage.waitForTimeout(500);
  assert.match(await optionsPage.locator("#customTerms").inputValue(), /Quarterly layoffs$/);
  await optionsPage.locator("#addRegexRuleButton").click();
  const newRegex = optionsPage.locator(".regex-rule").last();
  await newRegex.locator("[data-regex-name]").fill("Case IDs");
  await newRegex.locator("[data-regex-pattern]").fill("CASE-[0-9]{6}");
  await newRegex.locator("[data-regex-flags]").fill("i");
  await optionsPage.waitForTimeout(500);
  const regexSettings = await callBackground(worker, { type: "PRIVACY_LENS_GET_SETTINGS" });
  assert.equal(regexSettings.settings.customRegexRules.some((rule) => rule.name === "Case IDs" && rule.pattern === "CASE-[0-9]{6}"), true);
  await optionsPage.evaluate(() => window.scrollTo(0, 0));
  await optionsPage.screenshot({ path: path.join(screenshotRoot, "settings-desktop.png"), fullPage: false });
  await optionsPage.setViewportSize({ width: 390, height: 844 });
  await optionsPage.evaluate(() => window.scrollTo(0, 0));
  await optionsPage.screenshot({ path: path.join(screenshotRoot, "settings-mobile.png"), fullPage: false });
  await optionsPage.setViewportSize({ width: 1280, height: 800 });
  await optionsPage.locator("#customTerms").scrollIntoViewIfNeeded();
  await optionsPage.screenshot({ path: path.join(screenshotRoot, "redaction-settings-desktop.png"), fullPage: false });
  await optionsPage.locator("#tabPrivacyTitle").scrollIntoViewIfNeeded();
  await optionsPage.screenshot({ path: path.join(screenshotRoot, "tab-privacy-desktop.png"), fullPage: false });
  await optionsPage.setViewportSize({ width: 390, height: 844 });
  await optionsPage.locator("#tabPrivacyTitle").scrollIntoViewIfNeeded();
  await optionsPage.screenshot({ path: path.join(screenshotRoot, "tab-privacy-mobile.png"), fullPage: false });
  await optionsPage.close();
  await callBackground(worker, {
    type: "PRIVACY_LENS_SET_TAB_TITLE_PRIVACY",
    tabId: secondTabId,
    enabled: false
  });
  await secondPage.close();

  console.log("Verified real MV3 runtime: distinct blur treatments, media blur/hidden/opt-in NSFW API, linked document and non-destructive form-field redaction/blur, payment-card and crypto detection, stable phrase editing, custom regex, widget tab dropdown, selected/all-tab titles, title restoration, dynamic DOM, desktop, and mobile layout.");
  console.log(`Review screenshots: ${path.relative(root, screenshotRoot)}/`);
} finally {
  await context.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}

function findDemoTab(worker, port, urlFragment = "") {
  return worker.evaluate(async ({ port, urlFragment }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url
      && candidate.url.includes(`127.0.0.1:${port}`)
      && candidate.url.includes(urlFragment));
    if (!tab || !Number.isInteger(tab.id)) throw new Error("Demo tab was not found.");
    return tab.id;
  }, { port, urlFragment });
}

function callBackground(worker, message) {
  return worker.evaluate(async ({ message }) => handleMessage(message, {}), { message });
}

function sendToTopFrame(worker, tabId, message) {
  return worker.evaluate(async ({ tabId, message }) => {
    return chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  }, { tabId, message });
}

function createDemoServer(directory) {
  const types = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".mp4": "video/mp4"
  };

  return http.createServer(async (request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(directory, relative);
    if (filePath !== directory && !filePath.startsWith(`${directory}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(filePath);
      response.writeHead(200, { "content-type": types[path.extname(filePath)] || "application/octet-stream", "cache-control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
}
