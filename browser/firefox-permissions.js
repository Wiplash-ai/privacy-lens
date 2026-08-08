"use strict";

(() => {
  const root = globalThis;
  root.PrivacyLens ||= {};
  root.PrivacyLens.FirefoxPermissions = Object.freeze({
    request(value) {
      return new Promise((resolve, reject) => {
        chrome.permissions.request(value, (granted) => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(granted === true);
        });
      });
    },
    remove(value) {
      return new Promise((resolve) => chrome.permissions.remove(value, resolve));
    }
  });
})();
