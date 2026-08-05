import assert from "node:assert/strict";
import test from "node:test";
import { createRuntime } from "./helpers.mjs";

function createMemoryStorage(initial = {}) {
  let state = structuredClone(initial);
  return {
    get(defaults, callback) { callback({ ...defaults, ...structuredClone(state) }); },
    set(values, callback) { state = { ...state, ...structuredClone(values) }; callback(); },
    snapshot() { return structuredClone(state); }
  };
}

test("settings storage persists sanitized local preferences and site rules", async () => {
  const dom = await createRuntime();
  const { Settings } = dom.window.PrivacyLens;
  const area = createMemoryStorage();
  const store = Settings.createStore(area);
  const defaults = await store.get();
  assert.equal(defaults.defaultBlurStrength, 12);
  assert.equal(defaults.defaultBlurTreatment, "soft");
  assert.equal(defaults.defaultImageTreatment, "blur");
  assert.equal(defaults.defaultTextTreatment, "redact");
  assert.equal(defaults.neutralTitle, "Top Secret");
  assert.equal(defaults.redactionTypes.email, true);
  assert.equal(defaults.nsfwFilterEnabled, false);
  assert.equal(defaults.nsfwApiUrl, Settings.DEFAULT_NSFW_API_URL);

  const saved = await store.save({
    defaultBlurStrength: 99,
    defaultBlurTreatment: "frosted",
    defaultImageTreatment: "hidden",
    defaultTextTreatment: "blur",
    redactionTypes: { phone: false },
    customTerms: ["Project Nightfall", " project nightfall ", "Board minutes"],
    customRegexRules: [
      { id: "case-id", name: "Case IDs", pattern: "CASE-[0-9]{6}", flags: "iiu" },
      { id: "unsafe", name: "Unsafe", pattern: "(a+)+$", flags: "i" },
      { id: "broken", name: "Broken", pattern: "[", flags: "i" }
    ],
    nsfwFilterEnabled: true,
    nsfwApiUrl: "http://127.0.0.1:4173/privacy-lens/api/v1/classify",
    nsfwApiToken: "  local-test-token  ",
    neutralTitle: "  Recording hidden  ",
    widgetSide: "left",
    savedSites: {
      "Example.COM": { imagesProtected: true, imageTreatment: "blur", blurEnabled: true, blurStrength: 7, sensitiveMasked: true },
      "not a host!": { imagesHidden: true }
    }
  });
  assert.equal(saved.defaultBlurStrength, 28);
  assert.equal(saved.neutralTitle, "Recording hidden");
  assert.equal(saved.widgetSide, "left");
  assert.equal(saved.defaultImageTreatment, "hidden");
  assert.equal(saved.defaultTextTreatment, "blur");
  assert.equal(saved.redactionTypes.phone, false);
  assert.equal(saved.redactionTypes.email, true);
  assert.deepEqual(Array.from(saved.customTerms), ["Project Nightfall", "Board minutes"]);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.customRegexRules)), [
    { id: "case-id", name: "Case IDs", pattern: "CASE-[0-9]{6}", flags: "iu" }
  ]);
  assert.equal(saved.nsfwFilterEnabled, true);
  assert.equal(saved.nsfwApiUrl, "http://127.0.0.1:4173/privacy-lens/api/v1/classify");
  assert.equal(saved.nsfwApiToken, "local-test-token");
  assert.deepEqual(Object.keys(saved.savedSites), ["example.com"]);
  assert.equal(saved.savedSites["example.com"].sensitiveMasked, true);
  assert.equal(saved.savedSites["example.com"].imageTreatment, "blur");

  const reloaded = await store.get();
  assert.equal(reloaded.defaultBlurTreatment, "frosted");
  assert.ok(area.snapshot()[Settings.SETTINGS_KEY]);
  dom.window.close();
});

test("reset replaces saved settings and remembered sites", async () => {
  const dom = await createRuntime();
  const { Settings } = dom.window.PrivacyLens;
  const area = createMemoryStorage();
  const store = Settings.createStore(area);
  await store.save({ savedSites: { "fixture.example": { imagesProtected: true, imageTreatment: "hidden" } }, resetOnClose: true });
  const reset = await store.reset();
  assert.equal(Object.keys(reset.savedSites).length, 0);
  assert.equal(reset.resetOnClose, false);
  dom.window.close();
});

test("legacy shipped title migrates while customized titles remain intact", async () => {
  const dom = await createRuntime();
  const { Settings } = dom.window.PrivacyLens;
  const legacyArea = createMemoryStorage({
    [Settings.SETTINGS_KEY]: { neutralTitle: "Private tab" }
  });
  const legacy = await Settings.createStore(legacyArea).get();
  assert.equal(legacy.neutralTitle, "Top Secret");
  assert.equal(legacy.schemaVersion, 4);

  const customArea = createMemoryStorage({
    [Settings.SETTINGS_KEY]: { neutralTitle: "Board Meeting" }
  });
  const custom = await Settings.createStore(customArea).get();
  assert.equal(custom.neutralTitle, "Board Meeting");
  dom.window.close();
});

test("custom regex validation bounds advanced patterns and API endpoints", async () => {
  const dom = await createRuntime();
  const { Settings } = dom.window.PrivacyLens;
  assert.equal(Settings.validateCustomRegexPattern("TICKET-[A-Z]{2}-[0-9]{4}", "iu").ok, true);
  assert.equal(Settings.validateCustomRegexPattern("(a+)+$", "i").ok, false);
  assert.equal(Settings.validateCustomRegexPattern("(a|aa)+$", "i").ok, false);
  assert.equal(Settings.validateCustomRegexPattern(".*secret.*token", "i").ok, false);
  assert.equal(Settings.validateCustomRegexPattern("(?<=secret)value", "i").ok, false);
  assert.equal(Settings.validateCustomRegexPattern("(secret)\\1", "i").ok, false);
  assert.equal(Settings.sanitizeNsfwApiUrl("http://classifier.example/v1"), Settings.DEFAULT_NSFW_API_URL);
  assert.equal(Settings.sanitizeNsfwApiUrl("http://localhost:9000/v1"), "http://localhost:9000/v1");
  dom.window.close();
});
