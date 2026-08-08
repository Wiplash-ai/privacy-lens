import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { root } from "./helpers.mjs";

test("page loads never mount or show the controls until the user invokes Privacy Lens", async () => {
  const source = await readFile(path.join(root, "content/content-script.js"), "utf8");
  assert.match(source, /function ensureWidget\(\) \{\s*if \(!widgetHost\) buildWidget\(\);\s*\}/);
  assert.match(source, /function showWidget\(\) \{\s*ensureWidget\(\);/);
  assert.doesNotMatch(source, /if \(IS_TOP_FRAME\) \{\s*buildWidget\(\);/);
  assert.doesNotMatch(source, /window\.setTimeout\(\(\) => \{\s*callRuntime\(\{ type: "PRIVACY_LENS_APPLY_TO_TAB"/);
});

test("page style injection uses portable DOM attributes for embedded document frames", async () => {
  const source = await readFile(path.join(root, "content/privacy-engine.js"), "utf8");
  assert.match(source, /setAttribute\("data-privacy-lens-owned", "true"\)/);
  assert.doesNotMatch(source, /style\.dataset\.privacyLensOwned/);
});
