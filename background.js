"use strict";

if (!globalThis.PrivacyLens || !globalThis.PrivacyLens.Config) {
  importScripts("shared/runtime-config.js");
}
if (!globalThis.PrivacyLens.Settings) {
  importScripts("shared/settings.js");
}

const settingsStore = PrivacyLens.Settings.createBrowserStore();
const TITLE_SESSION_KEY = "privacyLensTitleSession";
const titleSessionMemory = { allTabsProtected: false, protectedTabIds: [] };
const ACTION_ICONS = Object.freeze({
  16: "assets/icons/icon16.png",
  32: "assets/icons/icon32.png"
});
const MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_API_RESPONSE_BYTES = 64 * 1024;
const CLASSIFIER_TIMEOUT_MS = 12000;
const CLASSIFIER_MAX_DIMENSION = 512;
const CLASSIFIER_JPEG_QUALITY = 0.62;

refreshActionIcon();

chrome.runtime.onInstalled.addListener(() => {
  settingsStore.get();
  refreshActionIcon();
  restoreTitlePrivacy();
});

chrome.runtime.onStartup.addListener(() => {
  settingsStore.get();
  refreshActionIcon();
  restoreTitlePrivacy();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || typeof changeInfo.url === "string") {
    applyRememberedTitlePrivacy(tabId, tab).catch(() => undefined);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeClosedTabFromTitleSession(tabId).catch(() => undefined);
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab || !Number.isInteger(tab.id)) return;

  sendTabMessage(tab.id, { type: "PRIVACY_LENS_TOGGLE_WIDGET" }, { frameId: 0 })
    .then(() => clearActionError(tab.id))
    .catch(() => showActionError(tab.id));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({
      ok: false,
      error: error && error.message ? error.message : "Privacy Lens could not complete that action."
    }));

  return true;
});

async function handleMessage(message, sender) {
  const type = message && message.type;

  switch (type) {
    case "PRIVACY_LENS_GET_SETTINGS":
      return { ok: true, settings: await settingsStore.get() };
    case "PRIVACY_LENS_SAVE_SETTINGS":
      return { ok: true, settings: await settingsStore.save(message.settings) };
    case "PRIVACY_LENS_RESET_SETTINGS":
      return { ok: true, settings: await settingsStore.reset() };
    case "PRIVACY_LENS_APPLY_TO_TAB":
      return broadcastState(requireSenderTab(sender), message.state, message.syncTitleSelection === true);
    case "PRIVACY_LENS_RESET_TAB":
      return resetTab(requireSenderTab(sender));
    case "PRIVACY_LENS_OPEN_OPTIONS":
      await openOptionsPage();
      return { ok: true };
    case "PRIVACY_LENS_GET_TITLE_TABS":
      return getTitleTabs();
    case "PRIVACY_LENS_SET_TAB_TITLE_PRIVACY":
      return setTabTitlePrivacy(message.tabId, message.enabled === true);
    case "PRIVACY_LENS_SET_ALL_TABS_TITLE_PRIVACY":
      return setAllTabsTitlePrivacy(message.enabled === true);
    case "PRIVACY_LENS_CLASSIFY_IMAGE":
      requireSenderTab(sender);
      return classifySourceImage(message.sourceUrl);
    case "PRIVACY_LENS_TEST_NSFW_API":
      return testNsfwApi();
    default:
      return { ok: false, error: "Unknown Privacy Lens message." };
  }
}

async function classifySourceImage(sourceUrlValue) {
  const settings = await settingsStore.get();
  if (!settings.nsfwFilterEnabled) {
    throw new Error("The optional NSFW image API is disabled in Privacy Lens settings.");
  }

  const sourceUrl = validateImageSourceUrl(sourceUrlValue);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);

  try {
    const sourceResponse = await fetch(sourceUrl, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "force-cache",
      signal: controller.signal
    });
    if (!sourceResponse.ok) throw new Error(`The page image returned HTTP ${sourceResponse.status}.`);
    const contentType = (sourceResponse.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) throw new Error("The selected page resource is not an image.");
    const sourceBlob = await readBlobWithLimit(sourceResponse, MAX_SOURCE_IMAGE_BYTES, contentType);
    const compressed = await compressImage(sourceBlob);
    return await postClassifierImage(compressed, settings, controller.signal);
  } catch (error) {
    if (error && error.name === "AbortError") throw new Error("The image privacy API timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function testNsfwApi() {
  const settings = await settingsStore.get();
  if (!settings.nsfwFilterEnabled) {
    throw new Error("Enable the optional NSFW image API before testing it.");
  }
  const compressed = await createTestImage();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);
  try {
    return await postClassifierImage(compressed, settings, controller.signal);
  } catch (error) {
    if (error && error.name === "AbortError") throw new Error("The image privacy API timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function validateImageSourceUrl(value) {
  if (typeof value !== "string" || value.length > 2000) throw new Error("The page image URL is invalid.");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("The page image URL is invalid.");
  }
  if (!["http:", "https:", "data:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP, HTTPS, and embedded data images can be classified.");
  }
  return parsed.href;
}

async function readBlobWithLimit(response, limit, contentType) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > limit) throw new Error("The page image is too large to classify safely.");
  if (!response.body || typeof response.body.getReader !== "function") {
    const blob = await response.blob();
    if (blob.size > limit) throw new Error("The page image is too large to classify safely.");
    return blob;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("The page image is too large to classify safely.");
    }
    chunks.push(value);
  }
  return new Blob(chunks, { type: contentType });
}

async function compressImage(sourceBlob) {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
    throw new Error("This browser cannot securely compress images in the extension background.");
  }
  const bitmap = await createImageBitmap(sourceBlob);
  try {
    const scale = Math.min(1, CLASSIFIER_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("The browser could not prepare the image for classification.");
    context.fillStyle = "#000";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type: "image/jpeg", quality: CLASSIFIER_JPEG_QUALITY });
  } finally {
    if (typeof bitmap.close === "function") bitmap.close();
  }
}

async function createTestImage() {
  if (typeof OffscreenCanvas !== "function") {
    throw new Error("This browser cannot create a local classifier test image.");
  }
  const canvas = new OffscreenCanvas(32, 32);
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#d8bd89";
  context.fillRect(0, 0, 32, 32);
  context.fillStyle = "#9d0f0f";
  context.fillRect(7, 14, 18, 4);
  return canvas.convertToBlob({ type: "image/jpeg", quality: CLASSIFIER_JPEG_QUALITY });
}

async function postClassifierImage(imageBlob, settings, signal) {
  const endpoint = PrivacyLens.Settings.sanitizeNsfwApiUrl(settings.nsfwApiUrl);
  const form = new FormData();
  form.append("image", imageBlob, "privacy-lens.jpg");
  form.append("client_version", chrome.runtime.getManifest().version);
  form.append("max_dimension", String(CLASSIFIER_MAX_DIMENSION));
  const headers = { Accept: "application/json" };
  if (settings.nsfwApiToken) headers.Authorization = `Bearer ${settings.nsfwApiToken}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: form,
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "error",
    signal
  });
  if (!response.ok) throw new Error(`The image privacy API returned HTTP ${response.status}.`);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_API_RESPONSE_BYTES) throw new Error("The image privacy API response was too large.");
  const responseText = await response.text();
  if (new TextEncoder().encode(responseText).byteLength > MAX_API_RESPONSE_BYTES) {
    throw new Error("The image privacy API response was too large.");
  }

  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error("The image privacy API returned invalid JSON.");
  }
  if (!payload || typeof payload.safe !== "boolean") {
    throw new Error("The image privacy API response is missing a boolean safe verdict.");
  }
  const score = Number(payload.score);
  return {
    ok: true,
    safe: payload.safe,
    score: Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : null,
    model: typeof payload.model === "string" ? payload.model.slice(0, 120) : "",
    requestId: typeof payload.request_id === "string" ? payload.request_id.slice(0, 120) : ""
  };
}

async function broadcastState(tab, value, syncTitleSelection) {
  const settings = await settingsStore.get();
  let state = PrivacyLens.Settings.sanitizePageState(value, settings);
  if (!syncTitleSelection) {
    const session = await getTitleSession();
    if (session.allTabsProtected || session.protectedTabIds.includes(tab.id)) {
      state = { ...state, titleProtected: true };
    }
  }
  await sendTabMessage(tab.id, {
    type: "PRIVACY_LENS_APPLY_STATE",
    state,
    neutralTitle: settings.neutralTitle
  }).catch(() => undefined);
  if (syncTitleSelection) await updateTitleSessionFromPage(tab.id, state.titleProtected);
  return { ok: true, state };
}

async function resetTab(tab) {
  const settings = await settingsStore.get();
  const state = PrivacyLens.Settings.defaultPageState(settings);
  await sendTabMessage(tab.id, {
    type: "PRIVACY_LENS_RESET",
    state,
    neutralTitle: settings.neutralTitle
  }).catch(() => undefined);
  await updateTitleSessionFromPage(tab.id, false);
  return { ok: true, state };
}

async function getTitleTabs() {
  const [tabs, session] = await Promise.all([queryTabs({}), getTitleSession()]);
  const protectedIds = new Set(session.protectedTabIds);
  const orderedTabs = tabs
    .sort((left, right) => Number(right.active) - Number(left.active) || left.index - right.index);
  const titleTabs = await Promise.all(orderedTabs.map(async (tab) => {
    const accessible = isNormalPage(tab.url);
    const protectedValue = accessible && (session.allTabsProtected || protectedIds.has(tab.id));
    let title = typeof tab.title === "string" ? tab.title : "Untitled tab";

    if (protectedValue && Number.isInteger(tab.id)) {
      const titleInfo = await sendTabMessage(
        tab.id,
        { type: "PRIVACY_LENS_GET_TITLE_INFO" },
        { frameId: 0 }
      ).catch(() => null);
      if (titleInfo && typeof titleInfo.originalTitle === "string" && titleInfo.originalTitle.trim()) {
        title = titleInfo.originalTitle;
      }
    }

    return {
      id: tab.id,
      title,
      hostname: getHostname(tab.url),
      active: tab.active === true,
      accessible,
      protected: protectedValue
    };
  }));

  return {
    ok: true,
    allTabsProtected: session.allTabsProtected,
    tabs: titleTabs
  };
}

async function setTabTitlePrivacy(tabIdValue, enabled) {
  const tabId = Number(tabIdValue);
  if (!Number.isInteger(tabId)) throw new Error("A valid tab is required.");
  const tab = await getTab(tabId);
  if (!isNormalPage(tab.url)) throw new Error("Privacy Lens cannot change this browser-owned tab.");
  const session = await getTitleSession();
  let protectedIds = new Set(session.protectedTabIds);
  if (session.allTabsProtected) {
    const tabs = await queryTabs({});
    protectedIds = new Set(tabs
      .filter((candidate) => Number.isInteger(candidate.id) && isNormalPage(candidate.url))
      .map((candidate) => candidate.id));
  }
  if (enabled) protectedIds.add(tabId);
  else protectedIds.delete(tabId);
  await setTitleSession({ allTabsProtected: false, protectedTabIds: [...protectedIds] });
  await applyTitlePrivacy(tabId, enabled);
  return getTitleTabs();
}

async function setAllTabsTitlePrivacy(enabled) {
  const tabs = await queryTabs({});
  const accessibleTabs = tabs.filter((tab) => Number.isInteger(tab.id) && isNormalPage(tab.url));
  await setTitleSession({ allTabsProtected: enabled, protectedTabIds: [] });
  await Promise.all(accessibleTabs.map((tab) => applyTitlePrivacy(tab.id, enabled).catch(() => undefined)));
  return getTitleTabs();
}

async function updateTitleSessionFromPage(tabId, enabled) {
  const session = await getTitleSession();
  if (session.allTabsProtected && enabled) return session;

  let protectedIds = new Set(session.protectedTabIds);
  let allTabsProtected = session.allTabsProtected;
  if (allTabsProtected && !enabled) {
    const tabs = await queryTabs({});
    protectedIds = new Set(tabs
      .filter((tab) => Number.isInteger(tab.id) && tab.id !== tabId && isNormalPage(tab.url))
      .map((tab) => tab.id));
    allTabsProtected = false;
  } else if (enabled) {
    protectedIds.add(tabId);
  } else {
    protectedIds.delete(tabId);
  }

  return setTitleSession({ allTabsProtected, protectedTabIds: [...protectedIds] });
}

async function applyTitlePrivacy(tabId, enabled) {
  const settings = await settingsStore.get();
  return sendTabMessage(tabId, {
    type: "PRIVACY_LENS_SET_TITLE_PROTECTION",
    enabled,
    neutralTitle: settings.neutralTitle
  }, { frameId: 0 });
}

async function applyRememberedTitlePrivacy(tabId, tabValue) {
  const session = await getTitleSession();
  if (!session.allTabsProtected && !session.protectedTabIds.includes(tabId)) return;
  const tab = tabValue && tabValue.id === tabId ? tabValue : await getTab(tabId);
  if (isNormalPage(tab.url)) await applyTitlePrivacy(tabId, true);
}

async function restoreTitlePrivacy() {
  const session = await getTitleSession();
  if (!session.allTabsProtected && !session.protectedTabIds.length) return;
  const tabs = await queryTabs({});
  await Promise.all(tabs.map((tab) => {
    const shouldProtect = isNormalPage(tab.url)
      && (session.allTabsProtected || session.protectedTabIds.includes(tab.id));
    return shouldProtect ? applyTitlePrivacy(tab.id, true).catch(() => undefined) : undefined;
  }));
}

async function removeClosedTabFromTitleSession(tabId) {
  const session = await getTitleSession();
  if (!session.protectedTabIds.includes(tabId)) return;
  await setTitleSession({
    ...session,
    protectedTabIds: session.protectedTabIds.filter((id) => id !== tabId)
  });
}

async function getTitleSession() {
  if (!chrome.storage.session) return sanitizeTitleSession(titleSessionMemory);
  const stored = await storageGet(chrome.storage.session, { [TITLE_SESSION_KEY]: titleSessionMemory });
  return sanitizeTitleSession(stored[TITLE_SESSION_KEY]);
}

async function setTitleSession(value) {
  const session = sanitizeTitleSession(value);
  titleSessionMemory.allTabsProtected = session.allTabsProtected;
  titleSessionMemory.protectedTabIds = [...session.protectedTabIds];
  if (chrome.storage.session) await storageSet(chrome.storage.session, { [TITLE_SESSION_KEY]: session });
  return session;
}

function sanitizeTitleSession(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    allTabsProtected: source.allTabsProtected === true,
    protectedTabIds: Array.isArray(source.protectedTabIds)
      ? [...new Set(source.protectedTabIds.filter(Number.isInteger))]
      : []
  };
}

function isNormalPage(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function getHostname(url) {
  try {
    return new URL(url).hostname || "This page";
  } catch {
    return "Browser or extension page";
  }
}

function requireSenderTab(sender) {
  if (!sender || !sender.tab || !Number.isInteger(sender.tab.id)) {
    throw new Error("This action must come from a browser tab.");
  }
  return sender.tab;
}

function sendTabMessage(tabId, message, options) {
  return new Promise((resolve, reject) => {
    const callback = (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    };

    if (options) chrome.tabs.sendMessage(tabId, message, options, callback);
    else chrome.tabs.sendMessage(tabId, message, callback);
  });
}

function queryTabs(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tabs || []);
    });
  });
}

function getTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tab);
    });
  });
}

function storageGet(area, defaults) {
  return new Promise((resolve, reject) => {
    area.get(defaults, (values) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(values || defaults);
    });
  });
}

function storageSet(area, values) {
  return new Promise((resolve, reject) => {
    area.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function openOptionsPage() {
  return new Promise((resolve) => chrome.runtime.openOptionsPage(resolve));
}

function refreshActionIcon() {
  return new Promise((resolve) => chrome.action.setIcon({ path: ACTION_ICONS }, resolve));
}

function showActionError(tabId) {
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#9d0f0f" });
  chrome.action.setBadgeText({ tabId, text: "!" });
  chrome.action.setTitle({ tabId, title: "Privacy Lens cannot run on this browser page" });
}

function clearActionError(tabId) {
  chrome.action.setBadgeText({ tabId, text: "" });
  chrome.action.setTitle({ tabId, title: "Toggle Privacy Lens" });
}
