"use strict";

(() => {
  const root = globalThis;
  root.PrivacyLens ||= {};
  root.PrivacyLens.Config = Object.freeze({
    environment: "development",
    defaultNsfwApiUrl: "https://labs.wiplash.ai/privacy-lens/api/v1/classify"
  });
})();
