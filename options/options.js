"use strict";

const store = PrivacyLens.Settings.createBrowserStore();
const form = document.getElementById("settingsForm");
const strength = document.getElementById("defaultBlurStrength");
const strengthValue = document.getElementById("defaultBlurStrengthValue");
const customTerms = document.getElementById("customTerms");
const regexRuleList = document.getElementById("regexRuleList");
const addRegexRuleButton = document.getElementById("addRegexRuleButton");
const nsfwFilterEnabled = document.getElementById("nsfwFilterEnabled");
const nsfwApiUrl = document.getElementById("nsfwApiUrl");
const nsfwApiToken = document.getElementById("nsfwApiToken");
const testNsfwApiButton = document.getElementById("testNsfwApiButton");
const siteRuleList = document.getElementById("siteRuleList");
const clearSitesButton = document.getElementById("clearSitesButton");
const resetSettingsButton = document.getElementById("resetSettingsButton");
const tabList = document.getElementById("tabList");
const allTabsTitle = document.getElementById("allTabsTitle");
const refreshTabsButton = document.getElementById("refreshTabsButton");
const toast = document.getElementById("toast");
let settings = PrivacyLens.Settings.sanitizeSettings();
let titleTabs = { allTabsProtected: false, tabs: [] };
let saveTimer = 0;
let saveQueue = Promise.resolve();
let toastTimer = 0;
let tabRefreshTimer = 0;

initialize();

async function initialize() {
  settings = await store.get();
  await loadTitleTabs();
  render();
  form.addEventListener("input", handleInput);
  form.addEventListener("change", () => save());
  nsfwFilterEnabled.addEventListener("change", handleNsfwConsentChange);
  addRegexRuleButton.addEventListener("click", addRegexRule);
  regexRuleList.addEventListener("click", handleRegexRuleClick);
  testNsfwApiButton.addEventListener("click", testNsfwApi);
  clearSitesButton.addEventListener("click", clearSites);
  resetSettingsButton.addEventListener("click", resetSettings);
  refreshTabsButton.addEventListener("click", loadTitleTabs);
  allTabsTitle.addEventListener("change", handleAllTabsTitleChange);
  tabList.addEventListener("change", handleTabTitleChange);
  chrome.storage.onChanged.addListener(handleStorageChange);
  chrome.tabs.onCreated.addListener(queueTabRefresh);
  chrome.tabs.onRemoved.addListener(queueTabRefresh);
  chrome.tabs.onUpdated.addListener(queueTabRefresh);
}

function handleInput(event) {
  strengthValue.textContent = `${strength.value}px`;
  if (event.target.closest(".regex-rule")) validateRegexRow(event.target.closest(".regex-rule"));
  if (event.target === nsfwFilterEnabled) updateNsfwControls();
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => save({ quiet: true }), 180);
}

async function save(options = {}) {
  clearTimeout(saveTimer);
  const patch = {
    defaultBlurStrength: Number(strength.value),
    defaultBlurTreatment: form.elements.defaultBlurTreatment.value,
    defaultImageTreatment: form.elements.defaultImageTreatment.value,
    defaultTextTreatment: form.elements.defaultTextTreatment.value,
    redactionTypes: Object.fromEntries([...form.querySelectorAll("[data-redaction-type]")]
      .map((input) => [input.dataset.redactionType, input.checked])),
    customTerms: customTerms.value.split("\n"),
    customRegexRules: collectRegexRules(),
    nsfwFilterEnabled: nsfwFilterEnabled.checked,
    nsfwApiUrl: nsfwApiUrl.value,
    nsfwApiToken: nsfwApiToken.value,
    neutralTitle: document.getElementById("neutralTitle").value,
    widgetSide: form.elements.widgetSide.value,
    widgetPosition: null,
    resetOnClose: document.getElementById("resetOnClose").checked
  };
  saveQueue = saveQueue.catch(() => undefined).then(async () => {
    settings = await store.save(patch);
    renderSiteRules();
    return settings;
  });
  await saveQueue;
  if (!options.quiet) showToast("Settings saved locally");
}

async function clearSites() {
  clearTimeout(saveTimer);
  await saveQueue.catch(() => undefined);
  if (!Object.keys(settings.savedSites).length) return;
  settings = await store.save({ savedSites: {} });
  renderSiteRules();
  showToast("Saved site rules cleared");
}

async function resetSettings() {
  clearTimeout(saveTimer);
  await saveQueue.catch(() => undefined);
  settings = await store.reset();
  render();
  showToast("Privacy Lens settings reset");
}

function render() {
  strength.value = String(settings.defaultBlurStrength);
  strengthValue.textContent = `${settings.defaultBlurStrength}px`;
  form.elements.defaultBlurTreatment.value = settings.defaultBlurTreatment;
  form.elements.defaultImageTreatment.value = settings.defaultImageTreatment;
  form.elements.defaultTextTreatment.value = settings.defaultTextTreatment;
  form.querySelectorAll("[data-redaction-type]").forEach((input) => {
    input.checked = settings.redactionTypes[input.dataset.redactionType] !== false;
  });
  customTerms.value = settings.customTerms.join("\n");
  nsfwFilterEnabled.checked = settings.nsfwFilterEnabled;
  nsfwApiUrl.value = settings.nsfwApiUrl;
  nsfwApiToken.value = settings.nsfwApiToken;
  renderRegexRules(settings.customRegexRules);
  updateNsfwControls();
  document.getElementById("neutralTitle").value = settings.neutralTitle;
  form.elements.widgetSide.value = settings.widgetSide;
  document.getElementById("resetOnClose").checked = settings.resetOnClose;
  renderSiteRules();
  renderTitleTabs();
}

function renderRegexRules(rules) {
  regexRuleList.replaceChildren();
  rules.forEach((rule) => regexRuleList.appendChild(createRegexRuleRow(rule)));
  addRegexRuleButton.disabled = rules.length >= PrivacyLens.Settings.MAX_CUSTOM_REGEX_RULES;
}

function createRegexRuleRow(rule = {}) {
  const row = document.createElement("article");
  row.className = "regex-rule";
  row.dataset.ruleId = rule.id || createRuleId();

  const header = document.createElement("div");
  header.className = "regex-rule-header";
  const label = document.createElement("strong");
  label.textContent = "Regex secret type";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.removeRegex = "true";
  remove.textContent = "Remove";
  header.append(label, remove);

  const name = document.createElement("input");
  name.className = "text-input";
  name.dataset.regexName = "true";
  name.type = "text";
  name.maxLength = 48;
  name.placeholder = "Type name, e.g. Case IDs";
  name.value = rule.name || "";
  name.setAttribute("aria-label", "Custom regex type name");

  const patternLine = document.createElement("div");
  patternLine.className = "regex-pattern-line";
  const slashOpen = document.createElement("span");
  slashOpen.textContent = "/";
  const pattern = document.createElement("input");
  pattern.className = "text-input regex-pattern";
  pattern.dataset.regexPattern = "true";
  pattern.type = "text";
  pattern.maxLength = PrivacyLens.Settings.MAX_REGEX_PATTERN_LENGTH;
  pattern.placeholder = "CASE-[0-9]{6}";
  pattern.value = rule.pattern || "";
  pattern.spellcheck = false;
  pattern.autocomplete = "off";
  pattern.setAttribute("aria-label", "Regular expression pattern");
  const slashClose = document.createElement("span");
  slashClose.textContent = "/";
  const flags = document.createElement("input");
  flags.className = "text-input regex-flags";
  flags.dataset.regexFlags = "true";
  flags.type = "text";
  flags.maxLength = 3;
  flags.value = rule.flags || "i";
  flags.spellcheck = false;
  flags.setAttribute("aria-label", "Regular expression flags; i, m, and u supported");
  patternLine.append(slashOpen, pattern, slashClose, flags);

  const feedback = document.createElement("small");
  feedback.className = "regex-feedback";
  feedback.setAttribute("aria-live", "polite");
  row.append(header, name, patternLine, feedback);
  validateRegexRow(row);
  return row;
}

function addRegexRule() {
  if (regexRuleList.children.length >= PrivacyLens.Settings.MAX_CUSTOM_REGEX_RULES) return;
  const row = createRegexRuleRow();
  regexRuleList.appendChild(row);
  addRegexRuleButton.disabled = regexRuleList.children.length >= PrivacyLens.Settings.MAX_CUSTOM_REGEX_RULES;
  row.querySelector("[data-regex-name]").focus();
}

function handleRegexRuleClick(event) {
  const button = event.target.closest("[data-remove-regex]");
  if (!button) return;
  button.closest(".regex-rule").remove();
  addRegexRuleButton.disabled = false;
  save();
}

function collectRegexRules() {
  return [...regexRuleList.querySelectorAll(".regex-rule")].flatMap((row) => {
    const rule = {
      id: row.dataset.ruleId,
      name: row.querySelector("[data-regex-name]").value,
      pattern: row.querySelector("[data-regex-pattern]").value,
      flags: row.querySelector("[data-regex-flags]").value
    };
    const validation = validateRegexRow(row);
    return validation.ok ? [rule] : [];
  });
}

function validateRegexRow(row) {
  const pattern = row.querySelector("[data-regex-pattern]").value;
  const flags = row.querySelector("[data-regex-flags]").value;
  const validation = PrivacyLens.Settings.validateCustomRegexPattern(pattern, flags);
  const feedback = row.querySelector(".regex-feedback");
  row.classList.toggle("has-error", !validation.ok);
  feedback.textContent = validation.ok ? `Active locally / flags ${validation.flags}` : validation.error;
  return validation;
}

function createRuleId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `regex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function updateNsfwControls() {
  const enabled = nsfwFilterEnabled.checked;
  testNsfwApiButton.disabled = !enabled;
  const nsfwChoice = form.querySelector("input[name='defaultImageTreatment'][value='nsfw']");
  nsfwChoice.disabled = !enabled;
  if (!enabled && nsfwChoice.checked) {
    form.querySelector("input[name='defaultImageTreatment'][value='blur']").checked = true;
  }
}

async function handleNsfwConsentChange(event) {
  if (!isFirefox()) return;
  event.stopPropagation();
  clearTimeout(saveTimer);
  try {
    if (nsfwFilterEnabled.checked) {
      const granted = await requestBrowserPermission({ data_collection: ["websiteContent"] });
      if (!granted) {
        nsfwFilterEnabled.checked = false;
        showToast("Firefox did not grant optional website-content transmission.");
      }
    } else {
      await removeBrowserPermission({ data_collection: ["websiteContent"] });
    }
  } catch {
    nsfwFilterEnabled.checked = false;
    showToast("Firefox could not update the optional data permission.");
  }
  updateNsfwControls();
  await save({ quiet: true });
}

function isFirefox() {
  return /Firefox\//.test(navigator.userAgent);
}

function requestBrowserPermission(value) {
  return new Promise((resolve, reject) => {
    chrome.permissions.request(value, (granted) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(granted === true);
    });
  });
}

function removeBrowserPermission(value) {
  return new Promise((resolve) => chrome.permissions.remove(value, resolve));
}

async function testNsfwApi() {
  testNsfwApiButton.disabled = true;
  testNsfwApiButton.textContent = "Testing…";
  try {
    await save({ quiet: true });
    const response = await sendMessage({ type: "PRIVACY_LENS_TEST_NSFW_API" });
    if (!response || !response.ok) throw new Error(response?.error || "API test failed");
    showToast(`API connected · test image returned ${response.safe ? "safe" : "unsafe"}`);
  } catch (error) {
    showToast(error && error.message ? error.message : "API test failed");
  } finally {
    testNsfwApiButton.textContent = "Test API";
    updateNsfwControls();
  }
}

function renderSiteRules() {
  const entries = Object.entries(settings.savedSites).sort(([left], [right]) => left.localeCompare(right));
  siteRuleList.replaceChildren();
  clearSitesButton.disabled = entries.length === 0;

  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No site rules saved. Turn on “Remember on this site” from the page widget to add one.";
    siteRuleList.appendChild(empty);
    return;
  }

  entries.forEach(([hostname, rule]) => {
    const activeCount = [rule.imagesProtected, rule.blurEnabled, rule.titleProtected, rule.sensitiveMasked].filter(Boolean).length;
    const card = document.createElement("article");
    card.className = "site-card";
    const name = document.createElement("strong");
    name.textContent = hostname;
    const summary = document.createElement("span");
    summary.textContent = `${activeCount} ${activeCount === 1 ? "layer" : "layers"}`;
    card.append(name, summary);
    siteRuleList.appendChild(card);
  });
}

async function loadTitleTabs() {
  const response = await sendMessage({ type: "PRIVACY_LENS_GET_TITLE_TABS" });
  if (response && response.ok) {
    titleTabs = response;
    renderTitleTabs();
  }
}

async function handleAllTabsTitleChange() {
  const enabled = allTabsTitle.checked;
  const response = await sendMessage({
    type: "PRIVACY_LENS_SET_ALL_TABS_TITLE_PRIVACY",
    enabled
  });
  if (!response || !response.ok) return;
  titleTabs = response;
  renderTitleTabs();
  showToast(enabled ? "All accessible tab titles protected" : "All tab titles restored");
}

async function handleTabTitleChange(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.matches("[data-tab-id]")) return;
  const response = await sendMessage({
    type: "PRIVACY_LENS_SET_TAB_TITLE_PRIVACY",
    tabId: Number(input.dataset.tabId),
    enabled: input.checked
  });
  if (!response || !response.ok) {
    await loadTitleTabs();
    return;
  }
  titleTabs = response;
  renderTitleTabs();
  showToast(input.checked ? "Selected tab title protected" : "Selected tab title restored");
}

function renderTitleTabs() {
  if (!tabList || !allTabsTitle) return;
  allTabsTitle.checked = titleTabs.allTabsProtected === true;
  tabList.replaceChildren();

  if (!titleTabs.tabs.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No open tabs are available.";
    tabList.appendChild(empty);
    return;
  }

  titleTabs.tabs.forEach((tab) => {
    const row = document.createElement("label");
    row.className = "tab-row";
    row.classList.toggle("is-active", tab.protected === true);
    row.classList.toggle("is-unavailable", tab.accessible !== true);

    const check = document.createElement("span");
    check.className = "tab-check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.tabId = String(tab.id);
    input.checked = tab.protected === true;
    input.disabled = tab.accessible !== true || titleTabs.allTabsProtected === true;
    const control = document.createElement("span");
    check.append(input, control);

    const copy = document.createElement("span");
    copy.className = "tab-copy";
    const title = document.createElement("strong");
    title.textContent = tab.title || "Untitled tab";
    const hostname = document.createElement("small");
    hostname.textContent = tab.hostname || "Browser or extension page";
    copy.append(title, hostname);

    const status = document.createElement("span");
    status.className = "tab-state";
    status.textContent = tab.accessible !== true ? "Unavailable" : tab.protected ? "Protected" : "Original";
    row.append(check, copy, status);
    tabList.appendChild(row);
  });
}

function queueTabRefresh() {
  clearTimeout(tabRefreshTimer);
  tabRefreshTimer = window.setTimeout(loadTitleTabs, 180);
}

function handleStorageChange(changes, areaName) {
  if (areaName !== "local" || !changes[PrivacyLens.Settings.SETTINGS_KEY]) return;
  settings = PrivacyLens.Settings.sanitizeSettings(changes[PrivacyLens.Settings.SETTINGS_KEY].newValue);
  renderSiteRules();
  if (!form.contains(document.activeElement)) render();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 1600);
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}
