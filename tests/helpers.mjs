import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function createRuntime(html = "<!doctype html><html><head><title>Fixture title</title></head><body></body></html>") {
  const dom = new JSDOM(html, {
    url: "https://fixture.example/private",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const scripts = ["shared/runtime-config.js", "shared/settings.js", "content/matcher.js", "content/privacy-engine.js"];
  for (const relativePath of scripts) {
    const source = await readFile(path.join(root, relativePath), "utf8");
    dom.window.eval(`${source}\n//# sourceURL=${relativePath}`);
  }
  return dom;
}

export function waitForMutations(dom) {
  return new Promise((resolve) => dom.window.setTimeout(resolve, 20));
}
