import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = path.join(root, "artifacts", "packages");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));

assertReleaseManifest(manifest);
await execFileAsync(process.execPath, [path.join(root, "scripts", "build.mjs")], { cwd: root });
await rm(artifactRoot, { recursive: true, force: true });
await mkdir(artifactRoot, { recursive: true });

const outputs = [
  ["chrome", `privacy-lens-chrome-v${manifest.version}.zip`],
  ["edge", `privacy-lens-edge-v${manifest.version}.zip`],
  ["opera", `privacy-lens-opera-v${manifest.version}.zip`],
  ["firefox", `privacy-lens-firefox-v${manifest.version}.xpi`]
];

for (const [browser, filename] of outputs) {
  await execFileAsync("zip", ["-X", "-q", "-r", path.join(artifactRoot, filename), "."], {
    cwd: path.join(root, "dist", browser)
  });
}

console.log("Created Chrome, Edge, Opera, and Firefox archives in artifacts/packages/.");

function assertReleaseManifest(value) {
  if (value.manifest_version !== 3) throw new Error("Privacy Lens packages must use Manifest V3.");
  if (JSON.stringify(value.permissions) !== JSON.stringify(["storage", "tabs"])) {
    throw new Error("Privacy Lens may request only storage and tabs extension permissions.");
  }
  const source = JSON.stringify(value).toLowerCase();
  ["localhost", "127.0.0.1", "analytics", "api_key"].forEach((token) => {
    if (source.includes(token)) throw new Error(`Release manifest contains forbidden token: ${token}`);
  });
}
