import assert from "node:assert/strict";
import test from "node:test";
import { createRuntime, waitForMutations } from "./helpers.mjs";

const fixture = `<!doctype html><html><head><title>Original private title</title></head><body>
  <p id="copy">Email guest@example.com or call 512-555-0198.</p>
  <a id="secretLink" href="mailto:linked@example.com" title="Email linked@example.com">Email linked@example.com</a>
  <a id="aliasLink" href="mailto:hidden@example.com" aria-label="Account manager">Account manager</a>
  <a id="regularLink" href="https://example.com/r/1vf0f3q_xpost_hi_im_jonathan_former_airtable_fde_nice_to/" title="About this demo">About this demo</a>
  <a id="customLink" href="https://example.com/ai" title="Read AI workflows">Explore AI workflows</a>
  <span id="roleLink" role="link" tabindex="0" aria-label="Open AI briefing">AI briefing</span>
  <a id="camelLink" href="https://example.com/r/AgentsOfAI">r/AgentsOfAI</a>
  <pre><code id="staticCode">api_key=fixture-secret-12345</code></pre>
  <input id="email" value="form@example.com">
  <textarea id="note">Call 512-555-0111</textarea>
  <div id="editable" contenteditable="true">password=editable-secret</div>
  <div id="editor" class="monaco-editor">secret=editor-secret</div>
  <img id="photo" src="fixture.png" alt="Fixture">
  <video id="video"></video>
</body></html>`;

test("masking is reversible and excludes controls and code editors", async () => {
  const dom = await createRuntime(fixture);
  const engine = new dom.window.PrivacyLens.PrivacyEngine(dom.window.document, { isTopFrame: true });
  engine.applyState({ sensitiveMasked: true });

  assert.doesNotMatch(dom.window.document.getElementById("copy").textContent, /guest@example\.com/);
  assert.doesNotMatch(dom.window.document.getElementById("staticCode").textContent, /fixture-secret-12345/);
  assert.doesNotMatch(dom.window.document.getElementById("secretLink").textContent, /linked@example\.com/);
  assert.doesNotMatch(dom.window.document.getElementById("aliasLink").textContent, /Account manager/);
  assert.equal(dom.window.document.getElementById("regularLink").textContent, "About this demo");
  assert.equal(dom.window.document.getElementById("regularLink").getAttribute("title"), "About this demo");
  assert.equal(dom.window.document.getElementById("secretLink").getAttribute("href"), "mailto:linked@example.com");
  assert.equal(dom.window.document.getElementById("aliasLink").getAttribute("href"), "mailto:hidden@example.com");
  assert.doesNotMatch(dom.window.document.getElementById("secretLink").getAttribute("title"), /linked@example\.com/);
  assert.doesNotMatch(dom.window.document.getElementById("aliasLink").getAttribute("aria-label"), /Account manager/);
  assert.equal(dom.window.document.getElementById("email").value, "form@example.com");
  assert.match(dom.window.document.getElementById("note").value, /512-555-0111/);
  assert.match(dom.window.document.getElementById("editable").textContent, /editable-secret/);
  assert.match(dom.window.document.getElementById("editor").textContent, /editor-secret/);
  assert.equal(engine.getState().maskCount, 7);

  engine.reset();
  assert.match(dom.window.document.getElementById("copy").textContent, /guest@example\.com/);
  assert.match(dom.window.document.getElementById("staticCode").textContent, /fixture-secret-12345/);
  assert.match(dom.window.document.getElementById("secretLink").textContent, /linked@example\.com/);
  assert.equal(dom.window.document.getElementById("aliasLink").textContent, "Account manager");
  assert.equal(dom.window.document.getElementById("secretLink").getAttribute("title"), "Email linked@example.com");
  assert.equal(dom.window.document.getElementById("aliasLink").getAttribute("aria-label"), "Account manager");
  dom.window.close();
});

test("custom terms redact only exact words in link names and titles", async () => {
  const dom = await createRuntime(fixture);
  const engine = new dom.window.PrivacyLens.PrivacyEngine(dom.window.document, {
    redactionOptions: {
      enabledTypes: { email: false, phone: false, "api-key": false, "access-token": false, credential: false },
      customTerms: ["AI", "agents"]
    }
  });

  engine.applyState({ sensitiveMasked: true });
  const customLink = dom.window.document.getElementById("customLink");
  assert.equal(customLink.textContent, "Explore ██ workflows");
  assert.equal(customLink.getAttribute("title"), "Read ██ workflows");
  assert.equal(dom.window.document.getElementById("roleLink").textContent, "██ briefing");
  assert.equal(dom.window.document.getElementById("roleLink").getAttribute("aria-label"), "Open ██ briefing");
  assert.equal(dom.window.document.getElementById("camelLink").textContent, "r/██████Of██");
  assert.equal(dom.window.document.getElementById("regularLink").textContent, "About this demo");
  assert.equal(dom.window.document.getElementById("regularLink").getAttribute("title"), "About this demo");
  assert.equal(engine.getState().maskCount, 6);

  engine.reset();
  assert.equal(customLink.textContent, "Explore AI workflows");
  assert.equal(customLink.getAttribute("title"), "Read AI workflows");
  assert.equal(dom.window.document.getElementById("roleLink").textContent, "AI briefing");
  assert.equal(dom.window.document.getElementById("roleLink").getAttribute("aria-label"), "Open AI briefing");
  assert.equal(dom.window.document.getElementById("camelLink").textContent, "r/AgentsOfAI");
  dom.window.close();
});

test("dynamic and externally updated text is masked and restored to its latest value", async () => {
  const dom = await createRuntime(fixture);
  const engine = new dom.window.PrivacyLens.PrivacyEngine(dom.window.document);
  engine.applyState({ sensitiveMasked: true });

  const dynamic = dom.window.document.createElement("p");
  dynamic.id = "dynamic";
  dynamic.textContent = "New contact dynamic@example.com and 214-555-0177";
  dom.window.document.body.appendChild(dynamic);
  await waitForMutations(dom);
  assert.doesNotMatch(dynamic.textContent, /dynamic@example\.com/);

  dynamic.textContent = "Updated contact latest@example.com";
  await waitForMutations(dom);
  assert.doesNotMatch(dynamic.textContent, /latest@example\.com/);

  engine.reset();
  assert.equal(dynamic.textContent, "Updated contact latest@example.com");
  dom.window.close();
});

test("detached fallback nodes are restored before page code can reuse them", async () => {
  const dom = await createRuntime(fixture);
  const engine = new dom.window.PrivacyLens.PrivacyEngine(dom.window.document);
  engine.applyState({ sensitiveMasked: true });
  const copy = dom.window.document.getElementById("copy");
  assert.doesNotMatch(copy.textContent, /guest@example\.com/);

  copy.remove();
  await waitForMutations(dom);
  assert.match(copy.textContent, /guest@example\.com/);

  dom.window.document.body.appendChild(copy);
  await waitForMutations(dom);
  assert.doesNotMatch(copy.textContent, /guest@example\.com/);
  engine.reset();
  assert.match(copy.textContent, /guest@example\.com/);
  dom.window.close();
});

test("image privacy supports shared-strength blur, hidden, and stamp treatments", async () => {
  const dom = await createRuntime(fixture);
  const root = dom.window.document.documentElement;
  root.style.filter = "contrast(1.1)";
  const engine = new dom.window.PrivacyLens.PrivacyEngine(dom.window.document);

  engine.applyState({ imagesProtected: true, imageTreatment: "blur", blurStrength: 17 });
  assert.equal(root.classList.contains("privacy-lens-private-images-blurred"), true);
  assert.equal(root.style.getPropertyValue("--privacy-lens-private-blur"), "17px");

  engine.applyState({ imagesProtected: true, imageTreatment: "hidden", blurStrength: 17 });
  assert.equal(root.classList.contains("privacy-lens-private-images-hidden"), true);
  assert.equal(root.classList.contains("privacy-lens-private-images-blurred"), false);

  engine.applyState({ imagesProtected: true, imageTreatment: "stamp", blurStrength: 17 });
  assert.equal(root.classList.contains("privacy-lens-private-images-stamped"), true);
  assert.ok(dom.window.document.getElementById("privacy-lens-media-stamps"));
  assert.match(engine.styleElement.textContent, /brightness\(0\) grayscale\(1\)/);

  engine.applyState({ imagesProtected: true, imageTreatment: "hidden", blurEnabled: true, blurStrength: 17, blurTreatment: "frosted" });
  assert.equal(root.classList.contains("privacy-lens-private-blur-frosted"), true);
  assert.match(engine.styleElement.textContent, /grayscale\(1\).*contrast\(\.58\)/s);
  assert.equal(root.style.filter, "contrast(1.1)");

  engine.reset();
  assert.equal([...root.classList].some((name) => name.startsWith("privacy-lens-private-")), false);
  assert.equal(root.style.getPropertyValue("--privacy-lens-private-blur"), "");
  assert.equal(root.style.filter, "contrast(1.1)");
  assert.equal(dom.window.document.getElementById("privacy-lens-media-stamps"), null);
  dom.window.close();
});

test("optional NSFW image screening reveals safe images, conceals unsafe images, and restores cleanly", async () => {
  const dom = await createRuntime(fixture);
  const document = dom.window.document;
  const classified = [];
  const engine = new dom.window.PrivacyLens.PrivacyEngine(document, {
    classifyImage: async (_image, sourceUrl) => {
      classified.push(sourceUrl);
      return { safe: !sourceUrl.includes("unsafe") };
    }
  });

  engine.applyState({ imagesProtected: true, imageTreatment: "nsfw" });
  await waitForMutations(dom);
  assert.equal(document.documentElement.classList.contains("privacy-lens-private-images-nsfw"), true);
  assert.equal(document.getElementById("photo").dataset.privacyLensNsfwStatus, "safe");

  const unsafe = document.createElement("img");
  unsafe.id = "unsafePhoto";
  unsafe.src = "unsafe-fixture.png";
  document.body.appendChild(unsafe);
  await waitForMutations(dom);
  assert.equal(unsafe.dataset.privacyLensNsfwStatus, "unsafe");
  assert.equal(classified.length, 2);

  engine.reset();
  assert.equal(document.documentElement.classList.contains("privacy-lens-private-images-nsfw"), false);
  assert.equal(document.getElementById("photo").hasAttribute("data-privacy-lens-nsfw-status"), false);
  assert.equal(unsafe.hasAttribute("data-privacy-lens-nsfw-status"), false);
  dom.window.close();
});

test("text privacy supports document redaction, blur, type filters, and custom terms", async () => {
  const dom = await createRuntime(fixture);
  const root = dom.window.document.documentElement;
  const copy = dom.window.document.getElementById("copy");
  const engine = new dom.window.PrivacyLens.PrivacyEngine(dom.window.document, {
    redactionOptions: {
      enabledTypes: { email: true, phone: false },
      customTerms: ["Email"]
    }
  });

  engine.applyState({ sensitiveMasked: true, textTreatment: "redact" });
  assert.equal(root.classList.contains("privacy-lens-private-text-redacted"), true);
  assert.match(copy.textContent, /█/);
  assert.match(copy.textContent, /512-555-0198/);

  engine.applyState({ sensitiveMasked: true, textTreatment: "blur" });
  assert.equal(root.classList.contains("privacy-lens-private-text-blurred"), true);
  assert.match(copy.textContent, /•/);
  assert.doesNotMatch(copy.textContent, /█/);

  engine.reset();
  assert.equal(copy.textContent, "Email guest@example.com or call 512-555-0198.");
  dom.window.close();
});

test("title protection restores the latest title supplied by the page", async () => {
  const dom = await createRuntime(fixture);
  const engine = new dom.window.PrivacyLens.PrivacyEngine(dom.window.document, { neutralTitle: "Top Secret" });
  engine.applyState({ titleProtected: true });
  assert.equal(dom.window.document.title, "Top Secret");

  dom.window.document.title = "Latest episode title";
  await waitForMutations(dom);
  assert.equal(dom.window.document.title, "Top Secret");

  engine.reset();
  assert.equal(dom.window.document.title, "Latest episode title");
  dom.window.close();
});
