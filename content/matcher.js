"use strict";

(() => {
  const root = globalThis;
  root.PrivacyLens ||= {};

  const RULES = Object.freeze([
    Object.freeze({
      type: "credential",
      priority: 1,
      expression: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?([^\s"'`,;<>]{6,})/gi,
      valueGroup: 1
    }),
    Object.freeze({
      type: "api-key",
      priority: 2,
      expression: /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g
    }),
    Object.freeze({
      type: "access-token",
      priority: 3,
      expression: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/gi,
      valueGroup: 1
    }),
    Object.freeze({
      type: "access-token",
      priority: 4,
      expression: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
    }),
    Object.freeze({
      type: "email",
      priority: 5,
      expression: /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/gi
    }),
    Object.freeze({
      type: "phone",
      priority: 6,
      expression: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})[ .-]\d{3,4}[ .-]\d{4}\b/g
    })
  ]);
  const MAX_REGEX_SCAN_LENGTH = 4096;
  const MAX_REGEX_MATCHES_PER_RULE = 100;

  function collectMatches(value, options = {}) {
    const text = typeof value === "string" ? value : String(value || "");
    const candidates = [];
    const enabledTypes = options && typeof options.enabledTypes === "object"
      ? options.enabledTypes
      : null;

    RULES.forEach((rule) => {
      if (enabledTypes && enabledTypes[rule.type] === false) return;
      const expression = new RegExp(rule.expression.source, rule.expression.flags);
      let match = expression.exec(text);

      while (match) {
        const captured = rule.valueGroup ? match[rule.valueGroup] : match[0];
        const relativeOffset = rule.valueGroup ? match[0].lastIndexOf(captured) : 0;
        const start = match.index + Math.max(0, relativeOffset);
        const end = start + captured.length;

        if (captured && end > start) {
          candidates.push({ start, end, type: rule.type, priority: rule.priority });
        }

        if (match[0].length === 0) expression.lastIndex += 1;
        match = expression.exec(text);
      }
    });

    collectCustomMatches(text, options.customTerms).forEach((match) => candidates.push(match));
    collectCustomRegexMatches(text, options.customRegexRules).forEach((match) => candidates.push(match));

    return removeOverlaps(candidates);
  }

  function collectCustomRegexMatches(text, customRegexRules) {
    if (!Array.isArray(customRegexRules) || !customRegexRules.length) return [];
    const matches = [];
    const source = text.slice(0, MAX_REGEX_SCAN_LENGTH);

    customRegexRules.forEach((rule) => {
      if (!rule || typeof rule.pattern !== "string") return;
      const validation = root.PrivacyLens.Settings?.validateCustomRegexPattern(rule.pattern, rule.flags);
      if (!validation || !validation.ok) return;

      let expression;
      try {
        expression = new RegExp(rule.pattern, `${validation.flags.replace(/g/g, "")}g`);
      } catch {
        return;
      }

      let count = 0;
      let match = expression.exec(source);
      while (match && count < MAX_REGEX_MATCHES_PER_RULE) {
        const captured = match[0];
        if (captured) {
          matches.push({
            start: match.index,
            end: match.index + captured.length,
            type: `custom-regex:${rule.id || "rule"}`,
            priority: 0
          });
          count += 1;
        }
        if (!captured) expression.lastIndex += 1;
        match = expression.exec(source);
      }
    });

    return matches;
  }

  function collectCustomMatches(text, customTerms) {
    if (!Array.isArray(customTerms) || !customTerms.length) return [];
    const source = text.toLocaleLowerCase();
    const matches = [];

    customTerms.forEach((value) => {
      if (typeof value !== "string") return;
      const term = value.trim();
      if (!term) return;
      const needle = term.toLocaleLowerCase();
      let index = source.indexOf(needle);
      while (index !== -1) {
        const end = index + needle.length;
        const startsWithWord = isWordCharacter(needle[0]);
        const endsWithWord = isWordCharacter(needle[needle.length - 1]);
        const leftIsClear = !startsWithWord || isCustomTermBoundary(text, index);
        const rightIsClear = !endsWithWord || isCustomTermBoundary(text, end);
        if (leftIsClear && rightIsClear) {
          matches.push({ start: index, end, type: "custom-term", priority: 0 });
        }
        index = source.indexOf(needle, Math.max(index + 1, end));
      }
    });
    return matches;
  }

  function isWordCharacter(value) {
    return typeof value === "string" && /[\p{L}\p{N}_]/u.test(value);
  }

  function isCustomTermBoundary(text, index) {
    if (index <= 0 || index >= text.length) return true;
    const left = text[index - 1];
    const right = text[index];
    if (!isWordCharacter(left) || !isWordCharacter(right)) return true;
    if (/[\p{Ll}\p{N}]/u.test(left) && /\p{Lu}/u.test(right)) return true;
    return /\p{Lu}/u.test(left)
      && /\p{Lu}/u.test(right)
      && /\p{Ll}/u.test(text[index + 1] || "");
  }

  function removeOverlaps(candidates) {
    const selected = [];
    const sorted = [...candidates].sort((left, right) => {
      return left.start - right.start
        || left.priority - right.priority
        || (right.end - right.start) - (left.end - left.start);
    });

    sorted.forEach((candidate) => {
      const overlaps = selected.some((existing) => {
        return candidate.start < existing.end && candidate.end > existing.start;
      });
      if (!overlaps) selected.push(candidate);
    });

    return selected.sort((left, right) => left.start - right.start);
  }

  function maskText(value, matches = collectMatches(value), treatment = "redact") {
    const text = typeof value === "string" ? value : String(value || "");
    if (!matches.length) return text;

    let cursor = 0;
    let output = "";
    matches.forEach((match) => {
      output += text.slice(cursor, match.start);
      const maskCharacter = treatment === "blur" ? "•" : "█";
      output += text.slice(match.start, match.end).replace(/\S/g, maskCharacter);
      cursor = match.end;
    });
    return output + text.slice(cursor);
  }

  root.PrivacyLens.Matcher = Object.freeze({
    collectMatches,
    maskText,
    supportedTypes: Object.freeze(["email", "phone", "api-key", "access-token", "credential"])
  });
})();
