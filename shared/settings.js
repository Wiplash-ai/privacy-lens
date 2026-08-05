"use strict";

(() => {
  const root = globalThis;
  root.PrivacyLens ||= {};

  const SETTINGS_KEY = "privacyLensSettings";
  const SETTINGS_SCHEMA_VERSION = 6;
  const MAX_SAVED_SITES = 100;
  const MAX_CUSTOM_TERMS = 50;
  const MAX_CUSTOM_REGEX_RULES = 20;
  const MAX_REGEX_PATTERN_LENGTH = 160;
  const DEFAULT_NSFW_API_URL = root.PrivacyLens.Config?.defaultNsfwApiUrl
    || "https://labs.wiplash.ai/privacy-lens/api/v1/classify";
  const REDACTION_TYPES = Object.freeze(["email", "phone", "payment-card", "crypto", "api-key", "access-token", "credential"]);
  const DEFAULT_REDACTION_TYPES = Object.freeze(Object.fromEntries(
    REDACTION_TYPES.map((type) => [type, true])
  ));
  const DEFAULT_SETTINGS = Object.freeze({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    defaultBlurStrength: 12,
    defaultBlurTreatment: "soft",
    defaultImageTreatment: "blur",
    defaultTextTreatment: "redact",
    protectFormFields: true,
    redactionTypes: DEFAULT_REDACTION_TYPES,
    customTerms: Object.freeze([]),
    customRegexRules: Object.freeze([]),
    nsfwFilterEnabled: false,
    nsfwApiUrl: DEFAULT_NSFW_API_URL,
    nsfwApiToken: "",
    neutralTitle: "Top Secret",
    resetOnClose: false,
    widgetSide: "right",
    widgetPosition: null,
    savedSites: Object.freeze({})
  });

  const DEFAULT_PAGE_STATE = Object.freeze({
    imagesProtected: false,
    imageTreatment: DEFAULT_SETTINGS.defaultImageTreatment,
    blurEnabled: false,
    blurStrength: DEFAULT_SETTINGS.defaultBlurStrength,
    blurTreatment: DEFAULT_SETTINGS.defaultBlurTreatment,
    titleProtected: false,
    sensitiveMasked: false,
    textTreatment: DEFAULT_SETTINGS.defaultTextTreatment
  });

  function sanitizeSettings(value) {
    const source = isRecord(value) ? value : {};
    const savedSites = {};

    if (isRecord(source.savedSites)) {
      Object.entries(source.savedSites).slice(0, MAX_SAVED_SITES).forEach(([hostname, state]) => {
        if (isSafeHostname(hostname)) {
          savedSites[hostname.toLowerCase()] = sanitizePageState(state, source);
        }
      });
    }

    const position = isRecord(source.widgetPosition)
      ? {
          left: finiteNumber(source.widgetPosition.left),
          top: finiteNumber(source.widgetPosition.top)
        }
      : null;

    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      defaultBlurStrength: clampInteger(source.defaultBlurStrength, 2, 28, DEFAULT_SETTINGS.defaultBlurStrength),
      defaultBlurTreatment: sanitizeTreatment(source.defaultBlurTreatment),
      defaultImageTreatment: sanitizeImageTreatment(source.defaultImageTreatment),
      defaultTextTreatment: sanitizeTextTreatment(source.defaultTextTreatment),
      protectFormFields: source.protectFormFields !== false,
      redactionTypes: sanitizeRedactionTypes(source.redactionTypes),
      customTerms: sanitizeCustomTerms(source.customTerms),
      customRegexRules: sanitizeCustomRegexRules(source.customRegexRules),
      nsfwFilterEnabled: source.nsfwFilterEnabled === true,
      nsfwApiUrl: sanitizeNsfwApiUrl(source.nsfwApiUrl),
      nsfwApiToken: sanitizeNsfwApiToken(source.nsfwApiToken),
      neutralTitle: sanitizeNeutralTitle(migrateNeutralTitle(source)),
      resetOnClose: source.resetOnClose === true,
      widgetSide: source.widgetSide === "left" ? "left" : "right",
      widgetPosition: position && position.left !== null && position.top !== null ? position : null,
      savedSites
    };
  }

  function sanitizePageState(value, settingsValue = DEFAULT_SETTINGS) {
    const source = isRecord(value) ? value : {};
    const settings = isRecord(settingsValue) ? settingsValue : DEFAULT_SETTINGS;
    const fallbackStrength = clampInteger(
      settings.defaultBlurStrength,
      2,
      28,
      DEFAULT_SETTINGS.defaultBlurStrength
    );
    const fallbackTreatment = sanitizeTreatment(settings.defaultBlurTreatment);

    return {
      imagesProtected: source.imagesProtected === true || source.imagesHidden === true,
      imageTreatment: ["blur", "hidden", "nsfw"].includes(source.imageTreatment)
        ? source.imageTreatment
        : source.imagesHidden === true
          ? "hidden"
          : sanitizeImageTreatment(settings.defaultImageTreatment),
      blurEnabled: source.blurEnabled === true,
      blurStrength: clampInteger(source.blurStrength, 2, 28, fallbackStrength),
      blurTreatment: ["soft", "frosted"].includes(source.blurTreatment)
        ? source.blurTreatment
        : fallbackTreatment,
      titleProtected: source.titleProtected === true,
      sensitiveMasked: source.sensitiveMasked === true,
      textTreatment: ["redact", "blur"].includes(source.textTreatment)
        ? source.textTreatment
        : sanitizeTextTreatment(settings.defaultTextTreatment)
    };
  }

  function defaultPageState(settingsValue = DEFAULT_SETTINGS) {
    const settings = sanitizeSettings(settingsValue);
    return sanitizePageState({
      blurStrength: settings.defaultBlurStrength,
      blurTreatment: settings.defaultBlurTreatment,
      imageTreatment: settings.defaultImageTreatment,
      textTreatment: settings.defaultTextTreatment
    }, settings);
  }

  function createStore(storageArea) {
    if (!storageArea || typeof storageArea.get !== "function" || typeof storageArea.set !== "function") {
      throw new TypeError("Privacy Lens requires a browser storage area.");
    }

    return Object.freeze({
      async get() {
        const stored = await storageGet(storageArea, { [SETTINGS_KEY]: null });
        const settings = sanitizeSettings(stored[SETTINGS_KEY]);

        if (!stored[SETTINGS_KEY] || JSON.stringify(stored[SETTINGS_KEY]) !== JSON.stringify(settings)) {
          await storageSet(storageArea, { [SETTINGS_KEY]: settings });
        }

        return settings;
      },

      async save(patch) {
        const current = await this.get();
        const settings = sanitizeSettings({ ...current, ...(isRecord(patch) ? patch : {}) });
        await storageSet(storageArea, { [SETTINGS_KEY]: settings });
        return settings;
      },

      async reset() {
        const settings = sanitizeSettings(DEFAULT_SETTINGS);
        await storageSet(storageArea, { [SETTINGS_KEY]: settings });
        return settings;
      }
    });
  }

  function createBrowserStore() {
    if (!root.chrome || !root.chrome.storage || !root.chrome.storage.local) {
      throw new Error("Browser extension storage is unavailable.");
    }

    return createStore(root.chrome.storage.local);
  }

  function storageGet(area, defaults) {
    return new Promise((resolve, reject) => {
      area.get(defaults, (value) => {
        const error = root.chrome && root.chrome.runtime ? root.chrome.runtime.lastError : null;
        if (error) reject(new Error(error.message));
        else resolve(value || defaults);
      });
    });
  }

  function storageSet(area, values) {
    return new Promise((resolve, reject) => {
      area.set(values, () => {
        const error = root.chrome && root.chrome.runtime ? root.chrome.runtime.lastError : null;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  function sanitizeTreatment(value) {
    return value === "frosted" ? "frosted" : "soft";
  }

  function sanitizeImageTreatment(value) {
    return ["hidden", "nsfw"].includes(value) ? value : "blur";
  }

  function sanitizeTextTreatment(value) {
    return value === "blur" ? "blur" : "redact";
  }

  function sanitizeRedactionTypes(value) {
    const source = isRecord(value) ? value : DEFAULT_REDACTION_TYPES;
    return Object.fromEntries(REDACTION_TYPES.map((type) => [type, source[type] !== false]));
  }

  function sanitizeCustomTerms(value) {
    const values = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(/[\n,]/)
        : [];
    const seen = new Set();
    const terms = [];
    values.slice(0, MAX_CUSTOM_TERMS * 2).forEach((entry) => {
      if (typeof entry !== "string") return;
      const term = entry.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
      const key = term.toLocaleLowerCase();
      if (!term || seen.has(key)) return;
      seen.add(key);
      terms.push(term);
    });
    return terms.slice(0, MAX_CUSTOM_TERMS);
  }

  function sanitizeCustomRegexRules(value) {
    if (!Array.isArray(value)) return [];
    const seenIds = new Set();
    const rules = [];

    value.slice(0, MAX_CUSTOM_REGEX_RULES * 2).forEach((entry, index) => {
      if (!isRecord(entry)) return;
      const pattern = typeof entry.pattern === "string"
        ? entry.pattern.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, MAX_REGEX_PATTERN_LENGTH)
        : "";
      const validation = validateCustomRegexPattern(pattern, entry.flags);
      if (!validation.ok) return;

      const rawName = typeof entry.name === "string" ? entry.name : "";
      const name = rawName.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48)
        || `Custom type ${index + 1}`;
      let id = typeof entry.id === "string"
        ? entry.id.replace(/[^a-z0-9_-]/gi, "").slice(0, 64)
        : "";
      if (!id || seenIds.has(id)) id = `regex-${index + 1}`;
      while (seenIds.has(id)) id = `${id}-copy`;
      seenIds.add(id);
      rules.push({ id, name, pattern, flags: validation.flags });
    });

    return rules.slice(0, MAX_CUSTOM_REGEX_RULES);
  }

  function validateCustomRegexPattern(patternValue, flagsValue = "i") {
    const pattern = typeof patternValue === "string" ? patternValue : "";
    const flags = sanitizeRegexFlags(flagsValue);
    if (!pattern.trim()) return { ok: false, error: "Enter a pattern.", flags };
    if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
      return { ok: false, error: `Patterns are limited to ${MAX_REGEX_PATTERN_LENGTH} characters.`, flags };
    }
    if (/\\[1-9]/.test(pattern)) {
      return { ok: false, error: "Backreferences are not supported.", flags };
    }
    if (/\(\?<([=!])/.test(pattern)) {
      return { ok: false, error: "Lookbehind is not supported.", flags };
    }
    if (/\([^)]*(?:\*|\+|\?|\{\d+(?:,\d*)?\})[^)]*\)\s*(?:\*|\+|\?|\{\d+(?:,\d*)?\})/.test(pattern)) {
      return { ok: false, error: "Nested repetition is not supported.", flags };
    }
    if (/\([^)]*\|[^)]*\)\s*(?:\*|\+|\?|\{\d+(?:,\d*)?\})/.test(pattern)) {
      return { ok: false, error: "Repeated alternation groups are not supported.", flags };
    }
    if (/(?:\.\*|\.\+)[\s\S]*(?:\.\*|\.\+)/.test(pattern)) {
      return { ok: false, error: "Multiple unbounded wildcards are not supported.", flags };
    }

    try {
      new RegExp(pattern, flags);
      return { ok: true, error: "", flags };
    } catch {
      return { ok: false, error: "This regular expression is not valid.", flags };
    }
  }

  function sanitizeRegexFlags(value) {
    const source = typeof value === "string" ? value.toLowerCase() : "i";
    return [...new Set([...source].filter((flag) => ["i", "m", "u"].includes(flag)))].join("") || "i";
  }

  function sanitizeNsfwApiUrl(value) {
    if (typeof value !== "string" || !value.trim()) return DEFAULT_NSFW_API_URL;
    try {
      const parsed = new URL(value.trim());
      const isLoopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
      if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
        return DEFAULT_NSFW_API_URL;
      }
      parsed.username = "";
      parsed.password = "";
      parsed.hash = "";
      return parsed.href.slice(0, 500);
    } catch {
      return DEFAULT_NSFW_API_URL;
    }
  }

  function sanitizeNsfwApiToken(value) {
    if (typeof value !== "string") return "";
    return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 512);
  }

  function sanitizeNeutralTitle(value) {
    if (typeof value !== "string") return DEFAULT_SETTINGS.neutralTitle;
    const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
    return normalized || DEFAULT_SETTINGS.neutralTitle;
  }

  function migrateNeutralTitle(source) {
    if (!isRecord(source)) return undefined;
    if (Number(source.schemaVersion) >= SETTINGS_SCHEMA_VERSION) return source.neutralTitle;
    return typeof source.neutralTitle === "string" && source.neutralTitle.trim() === "Private tab"
      ? DEFAULT_SETTINGS.neutralTitle
      : source.neutralTitle;
  }

  function isSafeHostname(value) {
    return typeof value === "string"
      && value.length > 0
      && value.length <= 253
      && /^[a-z0-9.-]+$/i.test(value);
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clampInteger(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(number)));
  }

  root.PrivacyLens.Settings = Object.freeze({
    SETTINGS_KEY,
    SETTINGS_SCHEMA_VERSION,
    REDACTION_TYPES,
    MAX_CUSTOM_REGEX_RULES,
    MAX_REGEX_PATTERN_LENGTH,
    DEFAULT_NSFW_API_URL,
    DEFAULT_SETTINGS,
    DEFAULT_PAGE_STATE,
    sanitizeSettings,
    sanitizePageState,
    defaultPageState,
    sanitizeCustomRegexRules,
    validateCustomRegexPattern,
    sanitizeNsfwApiUrl,
    createStore,
    createBrowserStore,
    isSafeHostname
  });
})();
