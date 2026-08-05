"use strict";

(() => {
  const root = globalThis;
  root.PrivacyLens ||= {};

  const MASK_NAME = "privacy-lens-sensitive";
  const STYLE_ID = "privacy-lens-page-effects";
  const BLUR_PROPERTY = "--privacy-lens-private-blur";
  const CLASS_IMAGES_HIDDEN = "privacy-lens-private-images-hidden";
  const CLASS_IMAGES_BLURRED = "privacy-lens-private-images-blurred";
  const CLASS_IMAGES_NSFW = "privacy-lens-private-images-nsfw";
  const CLASS_TEXT_REDACTED = "privacy-lens-private-text-redacted";
  const CLASS_TEXT_BLURRED = "privacy-lens-private-text-blurred";
  const CLASS_SOFT = "privacy-lens-private-blur-soft";
  const CLASS_FROSTED = "privacy-lens-private-blur-frosted";
  const FIELD_MASK_ATTRIBUTE = "data-privacy-lens-sensitive-field";
  const FIELD_SELECTOR = [
    "input",
    "textarea",
    "select",
    "[contenteditable]:not([contenteditable='false'])",
    "[role='textbox']",
    ".CodeMirror",
    ".cm-editor",
    ".monaco-editor",
    ".ace_editor",
    "[data-slate-editor]",
    "[data-lexical-editor]",
    "[data-code-editor]"
  ].join(",");
  const IGNORED_INPUT_TYPES = new Set([
    "button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"
  ]);
  const SKIP_SELECTOR = [
    "script",
    "style",
    "noscript",
    "template",
    "textarea",
    "input",
    "select",
    "option",
    "[contenteditable]:not([contenteditable='false'])",
    "[role='textbox']",
    ".CodeMirror",
    ".cm-editor",
    ".monaco-editor",
    ".ace_editor",
    "[data-slate-editor]",
    "[data-lexical-editor]",
    "[data-code-editor]",
    "[aria-hidden='true']"
  ].join(",");

  class TextMasker {
    constructor(documentValue, matcher, onCountChange = () => undefined, options = {}) {
      this.document = documentValue;
      this.matcher = matcher;
      this.onCountChange = onCountChange;
      this.enabled = false;
      this.count = 0;
      this.textCount = 0;
      this.attributeCount = 0;
      this.fieldCount = 0;
      this.observer = null;
      this.scanQueued = false;
      this.originals = new WeakMap();
      this.maskedNodes = new Set();
      this.maskedAttributes = new Map();
      this.maskedFields = new Map();
      this.fieldEventBound = (event) => this.handleFieldEvent(event);
      const windowValue = this.document.defaultView || root;
      this.highlightRegistry = windowValue.CSS && windowValue.CSS.highlights;
      this.HighlightClass = windowValue.Highlight || root.Highlight;
      this.previousHighlight = null;
      this.matchOptions = {
        enabledTypes: options.enabledTypes || null,
        customTerms: Array.isArray(options.customTerms) ? options.customTerms : [],
        customRegexRules: Array.isArray(options.customRegexRules) ? options.customRegexRules : [],
        protectFormFields: options.protectFormFields !== false
      };
      this.treatment = options.treatment === "blur" ? "blur" : "redact";
      this.usesHighlights = Boolean(
        this.highlightRegistry
        && typeof this.highlightRegistry.set === "function"
        && typeof this.HighlightClass === "function"
      );
    }

    setOptions(value = {}) {
      this.matchOptions = {
        enabledTypes: value.enabledTypes || null,
        customTerms: Array.isArray(value.customTerms) ? value.customTerms : [],
        customRegexRules: Array.isArray(value.customRegexRules) ? value.customRegexRules : [],
        protectFormFields: value.protectFormFields !== false
      };
      this.restart();
    }

    setTreatment(value) {
      const treatment = value === "blur" ? "blur" : "redact";
      if (treatment === this.treatment) return;
      this.treatment = treatment;
      this.restart();
    }

    restart() {
      if (!this.enabled) return;
      const previousHighlight = this.previousHighlight;
      this.disconnect();
      this.clear();
      this.previousHighlight = previousHighlight;
      this.observe();
      this.scan();
    }

    setEnabled(value) {
      const next = value === true;
      if (next === this.enabled) {
        if (next) this.scan();
        return;
      }

      this.enabled = next;
      if (next) {
        if (this.usesHighlights && typeof this.highlightRegistry.get === "function") {
          this.previousHighlight = this.highlightRegistry.get(MASK_NAME) || null;
        }
        this.observe();
        this.scan();
      } else {
        this.disconnect();
        this.clear();
      }
    }

    observe() {
      if (this.observer) return;
      const MutationObserverClass = (this.document.defaultView || root).MutationObserver;
      this.document.addEventListener("beforeinput", this.fieldEventBound, true);
      this.document.addEventListener("input", this.fieldEventBound, true);
      this.document.addEventListener("change", this.fieldEventBound, true);
      this.observer = new MutationObserverClass((mutations) => {
        if (!this.enabled) return;

        if (!this.usesHighlights) {
          this.handleFallbackMutations(mutations);
          return;
        }

        this.queueScan();
      });
      this.observer.observe(this.document.documentElement, {
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["href", "title", "aria-label", "value", "type", "name", "autocomplete", "placeholder", "role", "contenteditable"],
        subtree: true
      });
    }

    disconnect() {
      if (this.observer) this.observer.disconnect();
      this.observer = null;
      this.scanQueued = false;
      this.document.removeEventListener("beforeinput", this.fieldEventBound, true);
      this.document.removeEventListener("input", this.fieldEventBound, true);
      this.document.removeEventListener("change", this.fieldEventBound, true);
    }

    scan() {
      if (!this.enabled) return;
      const nodes = this.collectEligibleTextNodes();
      if (this.usesHighlights) this.applyHighlights(nodes);
      else this.applyFallback(nodes);
      this.maskLinkAttributes();
      this.maskFormFields();
    }

    queueScan() {
      if (this.scanQueued) return;
      this.scanQueued = true;
      const queue = typeof root.queueMicrotask === "function"
        ? root.queueMicrotask.bind(root)
        : (callback) => Promise.resolve().then(callback);
      queue(() => {
        this.scanQueued = false;
        this.scan();
      });
    }

    collectEligibleTextNodes(startNode = this.document.body || this.document.documentElement) {
      if (!startNode) return [];
      const view = this.document.defaultView || root;
      const NodeFilterValue = view.NodeFilter;
      const nodes = [];
      const walker = this.document.createTreeWalker(startNode, NodeFilterValue.SHOW_TEXT, {
        acceptNode: (node) => {
          if (!node.data || !node.data.trim()) return NodeFilterValue.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent || parent.closest(SKIP_SELECTOR)) return NodeFilterValue.FILTER_REJECT;
          return NodeFilterValue.FILTER_ACCEPT;
        }
      });

      let node = walker.nextNode();
      while (node) {
        if (this.collectNodeMatches(node).length) nodes.push(node);
        node = walker.nextNode();
      }
      return nodes;
    }

    collectNodeMatches(node) {
      if (!node?.data) return [];
      const matches = this.matcher.collectMatches(node.data, this.matchOptions);
      if (matches.length) return matches;
      const anchor = node.parentElement?.closest("a[href]");
      if (anchor && this.isSensitiveDestination(anchor)) {
        const start = node.data.search(/\S/);
        if (start < 0) return [];
        const end = node.data.search(/\s*$/);
        return [{ start, end, type: "link" }];
      }
      return [];
    }

    isSensitiveDestination(anchor) {
      const href = (anchor.getAttribute("href") || "").trim();
      if (/^mailto:/i.test(href)) return this.matchOptions.enabledTypes?.email !== false;
      if (/^tel:/i.test(href)) return this.matchOptions.enabledTypes?.phone !== false;
      return false;
    }

    applyHighlights(nodes) {
      const ranges = [];
      let count = 0;
      nodes.forEach((node) => {
        this.collectNodeMatches(node).forEach((match) => {
          const range = this.document.createRange();
          range.setStart(node, match.start);
          range.setEnd(node, match.end);
          ranges.push(range);
          count += 1;
        });
      });

      this.highlightRegistry.delete(MASK_NAME);
      if (ranges.length) this.highlightRegistry.set(MASK_NAME, new this.HighlightClass(...ranges));
      this.setTextCount(count);
    }

    applyFallback(nodes) {
      nodes.forEach((node) => this.maskFallbackNode(node));
      this.recountFallback();
    }

    maskFallbackNode(node) {
      const matches = this.collectNodeMatches(node);
      if (!matches.length) return;
      const masked = this.matcher.maskText(node.data, matches, this.treatment);
      this.originals.set(node, { original: node.data, masked, count: matches.length });
      this.maskedNodes.add(node);
      node.data = masked;
    }

    handleFallbackMutations(mutations) {
      mutations.forEach((mutation) => {
        if (mutation.type === "attributes") {
          if (mutation.attributeName === "href") {
            this.restoreFallbackSubtree(mutation.target);
            this.collectEligibleTextNodes(mutation.target).forEach((textNode) => this.maskFallbackNode(textNode));
          }
          return;
        }

        if (mutation.type === "characterData") {
          const node = mutation.target;
          const record = this.originals.get(node);
          if (record && node.data === record.masked) return;
          if (record) {
            this.originals.delete(node);
            this.maskedNodes.delete(node);
          }
          if (this.isEligibleTextNode(node)) this.maskFallbackNode(node);
          return;
        }

        mutation.removedNodes.forEach((node) => {
          this.restoreFallbackSubtree(node);
          this.restoreAttributeSubtree(node);
        });
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 3 && this.isEligibleTextNode(node)) {
            this.maskFallbackNode(node);
          } else if (node.nodeType === 1) {
            this.collectEligibleTextNodes(node).forEach((textNode) => this.maskFallbackNode(textNode));
          }
        });
      });
      this.recountFallback();
      this.maskLinkAttributes();
      this.maskFormFields();
    }

    restoreFallbackSubtree(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        this.restoreFallbackNode(node);
        return;
      }
      if (node.nodeType !== 1) return;
      const view = this.document.defaultView || root;
      const walker = this.document.createTreeWalker(node, view.NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();
      while (textNode) {
        this.restoreFallbackNode(textNode);
        textNode = walker.nextNode();
      }
    }

    restoreFallbackNode(node) {
      const record = this.originals.get(node);
      if (record && node.data === record.masked) node.data = record.original;
      this.originals.delete(node);
      this.maskedNodes.delete(node);
    }

    isEligibleTextNode(node) {
      if (!node || node.nodeType !== 3 || !node.data || !node.data.trim()) return false;
      const parent = node.parentElement;
      return Boolean(
        parent
        && !parent.closest(SKIP_SELECTOR)
        && this.collectNodeMatches(node).length
      );
    }

    recountFallback() {
      let count = 0;
      this.maskedNodes.forEach((node) => {
        const record = this.originals.get(node);
        if (!node.isConnected || !record) {
          this.restoreFallbackNode(node);
          return;
        }
        count += record.count;
      });
      this.setTextCount(count);
    }

    maskLinkAttributes() {
      if (!this.enabled) return;
      const seen = new Map();
      let count = 0;

      this.document.querySelectorAll("a[title], a[aria-label], [role='link'][title], [role='link'][aria-label]").forEach((anchor) => {
        ["title", "aria-label"].forEach((attributeName) => {
          if (!anchor.hasAttribute(attributeName)) return;
          let seenAttributes = seen.get(anchor);
          if (!seenAttributes) {
            seenAttributes = new Set();
            seen.set(anchor, seenAttributes);
          }
          seenAttributes.add(attributeName);

          const records = this.maskedAttributes.get(anchor);
          const existing = records?.get(attributeName);
          const current = anchor.getAttribute(attributeName) || "";
          const source = existing && current === existing.masked ? existing.original : current;
          let matches = this.matcher.collectMatches(source, this.matchOptions);
          if (!matches.length && this.isSensitiveDestination(anchor)) {
            const start = source.search(/\S/);
            if (start >= 0) matches = [{ start, end: source.search(/\s*$/), type: "link" }];
          }

          if (!matches.length) {
            if (existing) this.restoreMaskedAttribute(anchor, attributeName, existing);
            return;
          }

          const masked = this.matcher.maskText(source, matches, this.treatment);
          let nextRecords = this.maskedAttributes.get(anchor);
          if (!nextRecords) {
            nextRecords = new Map();
            this.maskedAttributes.set(anchor, nextRecords);
          }
          nextRecords.set(attributeName, { original: source, masked, count: matches.length });
          if (current !== masked) anchor.setAttribute(attributeName, masked);
          count += matches.length;
        });
      });

      this.maskedAttributes.forEach((records, element) => {
        records.forEach((record, attributeName) => {
          if (seen.get(element)?.has(attributeName)) return;
          this.restoreMaskedAttribute(element, attributeName, record);
        });
        if (!records.size) this.maskedAttributes.delete(element);
      });
      this.setAttributeCount(count);
    }

    restoreAttributeSubtree(node) {
      if (!node || node.nodeType !== 1) return;
      this.maskedAttributes.forEach((records, element) => {
        if (element !== node && !node.contains(element)) return;
        records.forEach((record, attributeName) => {
          this.restoreMaskedAttribute(element, attributeName, record);
        });
        this.maskedAttributes.delete(element);
      });
    }

    restoreMaskedAttribute(element, attributeName, record) {
      if (element.getAttribute(attributeName) === record.masked) {
        element.setAttribute(attributeName, record.original);
      }
      const records = this.maskedAttributes.get(element);
      records?.delete(attributeName);
      if (records && !records.size) this.maskedAttributes.delete(element);
    }

    handleFieldEvent(event) {
      if (!this.enabled || !this.matchOptions.protectFormFields) return;
      const target = event.target;
      if (!target || target.nodeType !== 1) return;
      const field = target.matches(FIELD_SELECTOR) ? target : target.closest(FIELD_SELECTOR);
      if (!field || !this.isEligibleFormField(field)) return;
      const value = event.type === "beforeinput" ? this.predictFieldValue(field, event) : undefined;
      this.updateFieldMask(field, value);
      this.recountFields();
    }

    predictFieldValue(field, event) {
      const current = this.getFieldValue(field);
      if (!event || typeof event.data !== "string" || event.inputType?.startsWith("delete")) return current;
      if (typeof field.selectionStart === "number" && typeof field.selectionEnd === "number") {
        return `${current.slice(0, field.selectionStart)}${event.data}${current.slice(field.selectionEnd)}`;
      }
      return `${current}${event.data}`;
    }

    maskFormFields() {
      if (!this.matchOptions.protectFormFields) {
        this.clearMaskedFields();
        return;
      }

      const seen = new Set();
      let count = 0;
      this.document.querySelectorAll(FIELD_SELECTOR).forEach((field) => {
        if (!this.isEligibleFormField(field)) return;
        seen.add(field);
        count += this.updateFieldMask(field);
      });

      this.maskedFields.forEach((record, field) => {
        if (seen.has(field)) return;
        this.restoreMaskedField(field, record);
      });
      this.setFieldCount(count);
    }

    updateFieldMask(field, value = this.getFieldValue(field)) {
      const matches = this.collectFieldMatches(field, value);
      const existing = this.maskedFields.get(field);
      if (!matches.length) {
        if (existing) this.restoreMaskedField(field, existing);
        return 0;
      }

      const record = existing || {
        hadAttribute: field.hasAttribute(FIELD_MASK_ATTRIBUTE),
        attributeValue: field.getAttribute(FIELD_MASK_ATTRIBUTE),
        count: 0
      };
      record.count = matches.length;
      this.maskedFields.set(field, record);
      if (field.getAttribute(FIELD_MASK_ATTRIBUTE) !== "true") {
        field.setAttribute(FIELD_MASK_ATTRIBUTE, "true");
      }
      return record.count;
    }

    collectFieldMatches(field, value) {
      const source = typeof value === "string" ? value : String(value || "");
      if (!source.trim()) return [];
      const matches = this.matcher.collectMatches(source, this.matchOptions);
      if (matches.length) return matches;

      const descriptor = [
        field.tagName,
        field.getAttribute("type"),
        field.getAttribute("name"),
        field.id,
        field.getAttribute("autocomplete"),
        field.getAttribute("aria-label"),
        field.getAttribute("placeholder"),
        field.labels ? [...field.labels].map((label) => label.textContent || "").join(" ") : "",
        field.closest("label")?.textContent || ""
      ].filter(Boolean).join(" ").toLocaleLowerCase();
      const typeEnabled = (type) => this.matchOptions.enabledTypes?.[type] !== false;
      let type = "";

      if (typeEnabled("credential") && /(?:password|passcode|passphrase|current-password|new-password|one-time-code|\bpin\b)/.test(descriptor)) {
        type = "credential";
      } else if (typeEnabled("payment-card") && /\bcc-(?:name|given-name|additional-name|family-name|number|exp|exp-month|exp-year|csc|type)\b|(?:credit|debit|payment)[ _-]*card|card[ _-]*(?:number|name|expiry|expiration|cvc|cvv)|\b(?:cvc|cvv|card security code)\b/.test(descriptor)) {
        type = "payment-card";
      } else if (typeEnabled("phone") && /(?:telephone|phone|mobile|\btel\b)/.test(descriptor)) {
        type = "phone";
      } else if (typeEnabled("email") && /(?:email|e-mail)/.test(descriptor)) {
        type = "email";
      } else if (typeEnabled("crypto") && /(?:bitcoin|ethereum|solana|crypto|wallet|public[ _-]*key|private[ _-]*key|seed[ _-]*phrase|mnemonic|\bbtc\b|\beth\b)/.test(descriptor)) {
        type = "crypto";
      }

      if (!type) return [];
      const start = source.search(/\S/);
      const end = source.search(/\s*$/);
      return start >= 0 && end > start ? [{ start, end, type, priority: 0 }] : [];
    }

    getFieldValue(field) {
      if (field && typeof field.value === "string") return field.value;
      return field?.textContent || "";
    }

    isEligibleFormField(field) {
      if (!field || !field.isConnected || field.closest("[data-privacy-lens-owned='true']")) return false;
      if (field.closest("[aria-hidden='true']") || field.hidden) return false;
      if (field.tagName === "INPUT" && IGNORED_INPUT_TYPES.has((field.getAttribute("type") || "text").toLocaleLowerCase())) return false;
      return true;
    }

    recountFields() {
      let count = 0;
      this.maskedFields.forEach((record, field) => {
        if (!field.isConnected || !this.isEligibleFormField(field)) {
          this.restoreMaskedField(field, record);
          return;
        }
        count += record.count;
      });
      this.setFieldCount(count);
    }

    restoreMaskedField(field, record) {
      if (record.hadAttribute) field.setAttribute(FIELD_MASK_ATTRIBUTE, record.attributeValue || "");
      else field.removeAttribute(FIELD_MASK_ATTRIBUTE);
      this.maskedFields.delete(field);
    }

    clearMaskedFields() {
      this.maskedFields.forEach((record, field) => this.restoreMaskedField(field, record));
      this.maskedFields.clear();
      this.setFieldCount(0);
    }

    clear() {
      if (this.usesHighlights) {
        if (this.previousHighlight) this.highlightRegistry.set(MASK_NAME, this.previousHighlight);
        else this.highlightRegistry.delete(MASK_NAME);
        this.previousHighlight = null;
      }

      this.maskedNodes.forEach((node) => {
        this.restoreFallbackNode(node);
      });
      this.maskedNodes.clear();
      this.maskedAttributes.forEach((records, element) => {
        records.forEach((record, attributeName) => {
          if (element.getAttribute(attributeName) === record.masked) {
            element.setAttribute(attributeName, record.original);
          }
        });
      });
      this.maskedAttributes.clear();
      this.clearMaskedFields();
      this.setTextCount(0);
      this.setAttributeCount(0);
    }

    setTextCount(value) {
      this.textCount = Number.isFinite(value) ? value : 0;
      this.syncCount();
    }

    setAttributeCount(value) {
      this.attributeCount = Number.isFinite(value) ? value : 0;
      this.syncCount();
    }

    setFieldCount(value) {
      this.fieldCount = Number.isFinite(value) ? value : 0;
      this.syncCount();
    }

    syncCount() {
      const count = this.textCount + this.attributeCount + this.fieldCount;
      if (count === this.count) return;
      this.count = count;
      this.onCountChange(count);
    }
  }

  class NsfwFilter {
    constructor(documentValue, classifyImage = null) {
      this.document = documentValue;
      this.view = documentValue.defaultView || root;
      this.classifyImage = typeof classifyImage === "function" ? classifyImage : null;
      this.enabled = false;
      this.observer = null;
      this.records = new WeakMap();
      this.trackedImages = new Set();
      this.cache = new Map();
      this.scanQueued = false;
    }

    setEnabled(value) {
      const next = value === true;
      if (next === this.enabled) {
        if (next) this.scan();
        return;
      }
      this.enabled = next;
      if (next) {
        this.observe();
        this.scan();
      } else {
        this.disconnect();
        this.clear();
      }
    }

    observe() {
      if (this.observer) return;
      const body = this.document.body || this.document.documentElement;
      if (!body || !this.view.MutationObserver) return;
      this.observer = new this.view.MutationObserver(() => this.queueScan());
      this.observer.observe(body, {
        childList: true,
        attributes: true,
        subtree: true,
        attributeFilter: ["src", "srcset", "sizes"]
      });
    }

    queueScan() {
      if (!this.enabled || this.scanQueued) return;
      this.scanQueued = true;
      const queue = typeof root.queueMicrotask === "function"
        ? root.queueMicrotask.bind(root)
        : (callback) => Promise.resolve().then(callback);
      queue(() => {
        this.scanQueued = false;
        this.scan();
      });
    }

    scan() {
      if (!this.enabled) return;
      this.document.querySelectorAll("img:not([data-privacy-lens-owned])").forEach((image) => {
        this.classify(image);
      });
    }

    async classify(image) {
      if (!this.enabled || !image || !image.isConnected) return;
      const sourceUrl = image.currentSrc || image.src || "";
      const existing = this.records.get(image);
      if (existing && existing.sourceUrl === sourceUrl) return;

      this.trackedImages.add(image);
      this.records.set(image, { sourceUrl, status: "pending" });
      image.dataset.privacyLensNsfwStatus = "pending";

      if (!sourceUrl || !this.classifyImage) {
        this.setStatus(image, sourceUrl, "error");
        return;
      }

      const cached = this.cache.get(sourceUrl);
      if (cached) {
        this.setStatus(image, sourceUrl, cached);
        return;
      }

      try {
        const result = await this.classifyImage(image, sourceUrl);
        const status = result && result.safe === true ? "safe" : "unsafe";
        this.cache.set(sourceUrl, status);
        this.setStatus(image, sourceUrl, status);
      } catch {
        this.setStatus(image, sourceUrl, "error");
      }
    }

    setStatus(image, sourceUrl, status) {
      if (!this.enabled || !image.isConnected) return;
      const currentUrl = image.currentSrc || image.src || "";
      if (currentUrl !== sourceUrl) {
        this.classify(image);
        return;
      }
      this.records.set(image, { sourceUrl, status });
      image.dataset.privacyLensNsfwStatus = status;
    }

    disconnect() {
      if (this.observer) this.observer.disconnect();
      this.observer = null;
      this.scanQueued = false;
    }

    clear() {
      this.trackedImages.forEach((image) => {
        delete image.dataset.privacyLensNsfwStatus;
      });
      this.trackedImages.clear();
      this.records = new WeakMap();
      this.cache.clear();
    }

    destroy() {
      this.enabled = false;
      this.disconnect();
      this.clear();
      this.cache.clear();
    }
  }

  class TitleProtector {
    constructor(documentValue, replacement = "Top Secret") {
      this.document = documentValue;
      this.replacement = replacement;
      this.enabled = false;
      this.originalTitle = null;
      this.observer = null;
      this.writeQueued = false;
    }

    setReplacement(value) {
      this.replacement = typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : "Top Secret";
      if (this.enabled) this.writeNeutralTitle();
    }

    setEnabled(value) {
      const next = value === true;
      if (next === this.enabled) return;
      this.enabled = next;

      if (next) {
        this.originalTitle = this.document.title;
        this.observe();
        this.writeNeutralTitle();
      } else {
        this.disconnect();
        const title = this.originalTitle;
        this.originalTitle = null;
        if (title !== null) this.document.title = title;
      }
    }

    observe() {
      const view = this.document.defaultView || root;
      this.observer = new view.MutationObserver(() => {
        if (!this.enabled || this.document.title === this.replacement) return;
        this.originalTitle = this.document.title;
        this.queueNeutralTitle();
      });
      this.observer.observe(this.document.documentElement, {
        childList: true,
        characterData: true,
        subtree: true
      });
    }

    queueNeutralTitle() {
      if (this.writeQueued) return;
      this.writeQueued = true;
      const queue = typeof root.queueMicrotask === "function"
        ? root.queueMicrotask.bind(root)
        : (callback) => Promise.resolve().then(callback);
      queue(() => {
        this.writeQueued = false;
        if (this.enabled) this.writeNeutralTitle();
      });
    }

    writeNeutralTitle() {
      if (this.document.title !== this.replacement) this.document.title = this.replacement;
    }

    getInfo() {
      return {
        protected: this.enabled,
        originalTitle: this.originalTitle ?? this.document.title
      };
    }

    disconnect() {
      if (this.observer) this.observer.disconnect();
      this.observer = null;
      this.writeQueued = false;
    }
  }

  class PrivacyEngine {
    constructor(documentValue, options = {}) {
      if (!documentValue || !documentValue.documentElement) {
        throw new TypeError("PrivacyEngine requires a document.");
      }
      if (!root.PrivacyLens.Matcher || !root.PrivacyLens.Settings) {
        throw new Error("Privacy Lens matcher and settings must load before the engine.");
      }

      this.document = documentValue;
      this.rootElement = documentValue.documentElement;
      this.isTopFrame = options.isTopFrame !== false;
      this.state = root.PrivacyLens.Settings.defaultPageState();
      this.originalBlurValue = this.rootElement.style.getPropertyValue(BLUR_PROPERTY);
      this.originalBlurPriority = this.rootElement.style.getPropertyPriority(BLUR_PROPERTY);
      this.masker = new TextMasker(
        documentValue,
        root.PrivacyLens.Matcher,
        typeof options.onMaskCountChange === "function" ? options.onMaskCountChange : () => undefined,
        options.redactionOptions
      );
      this.nsfwFilter = new NsfwFilter(documentValue, options.classifyImage);
      this.titleProtector = new TitleProtector(documentValue, options.neutralTitle);
      this.installStyle();
    }

    installStyle() {
      const style = this.document.createElement("style");
      style.id = this.document.getElementById(STYLE_ID) ? `${STYLE_ID}-extension` : STYLE_ID;
      style.dataset.privacyLensOwned = "true";
      style.textContent = `
        html.${CLASS_TEXT_REDACTED} ::highlight(${MASK_NAME}) {
          color: transparent;
          background-color: #090806;
          text-shadow: none;
          -webkit-text-fill-color: transparent;
        }
        html.${CLASS_TEXT_BLURRED} ::highlight(${MASK_NAME}) {
          color: transparent;
          background-color: transparent;
          text-shadow: 0 0 5px rgba(12, 9, 5, .96);
          -webkit-text-fill-color: transparent;
        }
        html.${CLASS_TEXT_REDACTED} [${FIELD_MASK_ATTRIBUTE}="true"] {
          color: transparent !important;
          caret-color: transparent !important;
          text-shadow: none !important;
          text-decoration-color: transparent !important;
          -webkit-text-fill-color: transparent !important;
          background-color: #090806 !important;
          background-image: linear-gradient(#090806, #090806) !important;
          box-shadow: inset 0 0 0 1000px #090806 !important;
        }
        html.${CLASS_TEXT_REDACTED} [${FIELD_MASK_ATTRIBUTE}="true"] *,
        html.${CLASS_TEXT_REDACTED} [${FIELD_MASK_ATTRIBUTE}="true"]::placeholder {
          color: transparent !important;
          caret-color: transparent !important;
          text-shadow: none !important;
          -webkit-text-fill-color: transparent !important;
        }
        html.${CLASS_TEXT_BLURRED} [${FIELD_MASK_ATTRIBUTE}="true"],
        html.${CLASS_TEXT_BLURRED} [${FIELD_MASK_ATTRIBUTE}="true"] * {
          color: transparent !important;
          caret-color: transparent !important;
          text-shadow: 0 0 6px rgba(12, 9, 5, .98) !important;
          text-decoration-color: transparent !important;
          -webkit-text-fill-color: transparent !important;
        }
        html.${CLASS_TEXT_BLURRED} [${FIELD_MASK_ATTRIBUTE}="true"]::placeholder {
          color: transparent !important;
          -webkit-text-fill-color: transparent !important;
        }
        html.${CLASS_TEXT_REDACTED} [${FIELD_MASK_ATTRIBUTE}="true"]::selection,
        html.${CLASS_TEXT_BLURRED} [${FIELD_MASK_ATTRIBUTE}="true"]::selection,
        html.${CLASS_TEXT_REDACTED} [${FIELD_MASK_ATTRIBUTE}="true"] *::selection,
        html.${CLASS_TEXT_BLURRED} [${FIELD_MASK_ATTRIBUTE}="true"] *::selection {
          color: transparent !important;
          background: #090806 !important;
          -webkit-text-fill-color: transparent !important;
        }
        html.${CLASS_IMAGES_HIDDEN} body img,
        html.${CLASS_IMAGES_HIDDEN} body picture,
        html.${CLASS_IMAGES_HIDDEN} body svg,
        html.${CLASS_IMAGES_HIDDEN} body canvas,
        html.${CLASS_IMAGES_HIDDEN} body video,
        html.${CLASS_IMAGES_HIDDEN} body iframe,
        html.${CLASS_IMAGES_HIDDEN} body input[type="image"],
        html.${CLASS_IMAGES_HIDDEN} body object[type^="image"],
        html.${CLASS_IMAGES_HIDDEN} body embed[type^="image"] {
          visibility: hidden !important;
          opacity: 0 !important;
        }
        html.${CLASS_IMAGES_HIDDEN},
        html.${CLASS_IMAGES_HIDDEN} body,
        html.${CLASS_IMAGES_HIDDEN} body *,
        html.${CLASS_IMAGES_HIDDEN}::before,
        html.${CLASS_IMAGES_HIDDEN}::after,
        html.${CLASS_IMAGES_HIDDEN} body::before,
        html.${CLASS_IMAGES_HIDDEN} body::after,
        html.${CLASS_IMAGES_HIDDEN} body *::before,
        html.${CLASS_IMAGES_HIDDEN} body *::after {
          background-image: none !important;
        }
        html.${CLASS_IMAGES_BLURRED} body img,
        html.${CLASS_IMAGES_BLURRED} body svg,
        html.${CLASS_IMAGES_BLURRED} body canvas,
        html.${CLASS_IMAGES_BLURRED} body video,
        html.${CLASS_IMAGES_BLURRED} body iframe,
        html.${CLASS_IMAGES_BLURRED} body input[type="image"],
        html.${CLASS_IMAGES_BLURRED} body object[type^="image"],
        html.${CLASS_IMAGES_BLURRED} body embed[type^="image"] {
          filter: blur(var(${BLUR_PROPERTY}, 12px)) !important;
        }
        html.${CLASS_IMAGES_NSFW} body img:not([data-privacy-lens-nsfw-status="safe"]),
        html.${CLASS_IMAGES_NSFW} body svg,
        html.${CLASS_IMAGES_NSFW} body canvas,
        html.${CLASS_IMAGES_NSFW} body video,
        html.${CLASS_IMAGES_NSFW} body iframe,
        html.${CLASS_IMAGES_NSFW} body input[type="image"],
        html.${CLASS_IMAGES_NSFW} body object[type^="image"],
        html.${CLASS_IMAGES_NSFW} body embed[type^="image"] {
          filter: brightness(0) grayscale(1) !important;
          background-color: #050403 !important;
        }
        html.${CLASS_IMAGES_NSFW},
        html.${CLASS_IMAGES_NSFW} body,
        html.${CLASS_IMAGES_NSFW} body * {
          background-image: none !important;
        }
        html.${CLASS_SOFT} > body {
          filter: blur(var(${BLUR_PROPERTY}, 12px)) !important;
        }
        html.${CLASS_FROSTED} > body {
          filter: blur(calc(var(${BLUR_PROPERTY}, 12px) + 6px)) grayscale(1) saturate(0) contrast(.58) brightness(1.14) !important;
        }
      `;
      (this.document.head || this.rootElement).appendChild(style);
      this.styleElement = style;
    }

    setNeutralTitle(value) {
      this.titleProtector.setReplacement(value);
    }

    setRedactionOptions(value) {
      this.masker.setOptions(value);
    }

    applyState(value) {
      this.state = root.PrivacyLens.Settings.sanitizePageState(value, {
        defaultBlurStrength: this.state.blurStrength,
        defaultBlurTreatment: this.state.blurTreatment,
        defaultImageTreatment: this.state.imageTreatment,
        defaultTextTreatment: this.state.textTreatment
      });

      this.rootElement.classList.toggle(
        CLASS_IMAGES_HIDDEN,
        this.state.imagesProtected && this.state.imageTreatment === "hidden"
      );
      this.rootElement.classList.toggle(
        CLASS_IMAGES_BLURRED,
        this.state.imagesProtected && this.state.imageTreatment === "blur"
      );
      this.rootElement.classList.toggle(
        CLASS_IMAGES_NSFW,
        this.state.imagesProtected && this.state.imageTreatment === "nsfw"
      );
      this.rootElement.classList.toggle(
        CLASS_TEXT_REDACTED,
        this.state.sensitiveMasked && this.state.textTreatment === "redact"
      );
      this.rootElement.classList.toggle(
        CLASS_TEXT_BLURRED,
        this.state.sensitiveMasked && this.state.textTreatment === "blur"
      );
      this.rootElement.classList.toggle(
        CLASS_SOFT,
        this.state.blurEnabled && this.state.blurTreatment === "soft"
      );
      this.rootElement.classList.toggle(
        CLASS_FROSTED,
        this.state.blurEnabled && this.state.blurTreatment === "frosted"
      );

      const needsBlurStrength = this.state.blurEnabled
        || (this.state.imagesProtected && this.state.imageTreatment === "blur");
      if (needsBlurStrength) {
        this.rootElement.style.setProperty(BLUR_PROPERTY, `${this.state.blurStrength}px`);
      } else {
        this.restoreBlurProperty();
      }

      this.masker.setTreatment(this.state.textTreatment);
      this.masker.setEnabled(this.state.sensitiveMasked);
      this.nsfwFilter.setEnabled(
        this.state.imagesProtected && this.state.imageTreatment === "nsfw"
      );
      if (this.isTopFrame) this.titleProtector.setEnabled(this.state.titleProtected);
      return this.getState();
    }

    reset(value = {}) {
      const defaults = root.PrivacyLens.Settings.sanitizePageState(value, this.state);
      return this.applyState({
        ...defaults,
        imagesProtected: false,
        blurEnabled: false,
        titleProtected: false,
        sensitiveMasked: false
      });
    }

    getState() {
      return { ...this.state, maskCount: this.masker.count };
    }

    getTitleInfo() {
      return this.titleProtector.getInfo();
    }

    destroy() {
      this.reset(this.state);
      this.masker.disconnect();
      this.nsfwFilter.destroy();
      this.titleProtector.disconnect();
      this.styleElement?.remove();
      this.styleElement = null;
    }

    restoreBlurProperty() {
      if (this.originalBlurValue) {
        this.rootElement.style.setProperty(BLUR_PROPERTY, this.originalBlurValue, this.originalBlurPriority);
      } else {
        this.rootElement.style.removeProperty(BLUR_PROPERTY);
      }
    }
  }

  root.PrivacyLens.TextMasker = TextMasker;
  root.PrivacyLens.NsfwFilter = NsfwFilter;
  root.PrivacyLens.TitleProtector = TitleProtector;
  root.PrivacyLens.PrivacyEngine = PrivacyEngine;
  root.PrivacyLens.EngineConstants = Object.freeze({
    MASK_NAME,
    STYLE_ID,
    CLASS_IMAGES_HIDDEN,
    CLASS_IMAGES_BLURRED,
    CLASS_IMAGES_NSFW,
    CLASS_TEXT_REDACTED,
    CLASS_TEXT_BLURRED,
    CLASS_SOFT,
    CLASS_FROSTED
  });
})();
