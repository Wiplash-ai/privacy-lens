import assert from "node:assert/strict";
import test from "node:test";
import { createRuntime } from "./helpers.mjs";

test("matcher finds each supported deterministic pattern", async () => {
  const dom = await createRuntime();
  const { Matcher } = dom.window.PrivacyLens;
  const text = [
    "guest@example.com",
    "+1 (512) 555-0198",
    "sk-proj-1234567890abcdefghijkl",
    "Bearer demo_access_token_1234567890",
    "password = SignalRoom!48",
    "4111 1111 1111 1111",
    "0x5e97870f263700f46aa00d967821199b9bc5a120"
  ].join(" / ");
  const matches = Matcher.collectMatches(text);
  const types = new Set(matches.map((match) => match.type));

  assert.ok(types.has("email"));
  assert.ok(types.has("phone"));
  assert.ok(types.has("api-key"));
  assert.ok(types.has("access-token"));
  assert.ok(types.has("credential"));
  assert.ok(types.has("payment-card"));
  assert.ok(types.has("crypto"));
  assert.equal(matches.length, 7);
  dom.window.close();
});

test("matcher recognizes conservative crypto address, public-key, and private-key formats", async () => {
  const dom = await createRuntime();
  const { Matcher } = dom.window.PrivacyLens;
  const values = [
    `Bitcoin private key: ${"f".repeat(64)}`,
    `Compressed public key: 02${"a".repeat(64)}`,
    `WIF: K${"A".repeat(51)}`,
    `Extended public key: xpub${"A".repeat(107)}`
  ].join(" / ");
  const matches = Matcher.collectMatches(values, { enabledTypes: { credential: false } });

  assert.equal(matches.length, 4);
  assert.deepEqual(Array.from(matches, (match) => match.type), ["crypto", "crypto", "crypto", "crypto"]);
  assert.doesNotMatch(Matcher.maskText(values, matches), /f{32}|02a{32}|KAAAA|xpubAAAA/);
  dom.window.close();
});

test("payment-card detection requires a plausible Luhn-valid number", async () => {
  const dom = await createRuntime();
  const { Matcher } = dom.window.PrivacyLens;
  assert.equal(Matcher.collectMatches("Card 4111 1111 1111 1111").some((match) => match.type === "payment-card"), true);
  assert.equal(Matcher.collectMatches("Reference 4111 1111 1111 1112").some((match) => match.type === "payment-card"), false);
  assert.equal(Matcher.collectMatches("Reference 1111 1111 1111 1111").some((match) => match.type === "payment-card"), false);
  dom.window.close();
});

test("credential assignment masks only the secret value", async () => {
  const dom = await createRuntime();
  const { Matcher } = dom.window.PrivacyLens;
  for (const text of [
    "client_secret: very-private-secret",
    'recording_password = "SignalRoom!48"',
    "DATABASE-ACCESS_TOKEN=database-access-token-123"
  ]) {
    const matches = Matcher.collectMatches(text);
    const masked = Matcher.maskText(text, matches);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].type, "credential");
    assert.match(masked, /(?:client_secret|recording_password|DATABASE-ACCESS_TOKEN)/);
    assert.doesNotMatch(masked, /very-private-secret|SignalRoom!48|database-access-token-123/);
    assert.match(masked, /█{10,}/);
  }
  dom.window.close();
});

test("matcher removes overlaps and leaves ordinary text unchanged", async () => {
  const dom = await createRuntime();
  const { Matcher } = dom.window.PrivacyLens;
  const ordinary = "Episode 48 starts in 42 minutes with three guests.";
  assert.equal(Matcher.collectMatches(ordinary).length, 0);
  assert.equal(Matcher.maskText(ordinary), ordinary);

  const assignedKey = "api_key=sk-proj-1234567890abcdefghijkl";
  assert.equal(Matcher.collectMatches(assignedKey).length, 1);
  dom.window.close();
});

test("matcher filters built-in types and adds literal custom terms", async () => {
  const dom = await createRuntime();
  const { Matcher } = dom.window.PrivacyLens;
  const text = "Project Nightfall belongs to guest@example.com, not Nightfalling.";
  const matches = Matcher.collectMatches(text, {
    enabledTypes: { email: false },
    customTerms: ["Project Nightfall", "Nightfall"]
  });

  assert.deepEqual(Array.from(matches, (match) => match.type), ["custom-term"]);
  assert.equal(text.slice(matches[0].start, matches[0].end), "Project Nightfall");
  assert.match(Matcher.maskText(text, matches, "redact"), /█{7}/);
  assert.doesNotMatch(Matcher.maskText(text, matches, "blur"), /█/);
  dom.window.close();
});

test("custom terms match camel-case username and category segments", async () => {
  const dom = await createRuntime();
  const { Matcher } = dom.window.PrivacyLens;
  const text = "r/AgentsOfAI r/agentsofai AgentsSmith OpenAI learnAIAgents mail";
  const matches = Matcher.collectMatches(text, {
    enabledTypes: Object.fromEntries(Matcher.supportedTypes.map((type) => [type, false])),
    customTerms: ["agents", "AI"]
  });

  assert.deepEqual(
    Array.from(matches, (match) => text.slice(match.start, match.end)),
    ["Agents", "AI", "Agents", "AI", "AI", "Agents"]
  );
  assert.equal(Matcher.maskText(text, matches), "r/██████Of██ r/agentsofai ██████Smith Open██ learn████████ mail");
  dom.window.close();
});

test("matcher applies validated custom regex types and ignores unsafe rules", async () => {
  const dom = await createRuntime();
  const { Matcher } = dom.window.PrivacyLens;
  const text = "Cases CASE-103942 and case-884210 are private; CASE-X is not.";
  const matches = Matcher.collectMatches(text, {
    enabledTypes: Object.fromEntries(Matcher.supportedTypes.map((type) => [type, false])),
    customRegexRules: [
      { id: "case-id", pattern: "CASE-[0-9]{6}", flags: "i" },
      { id: "unsafe", pattern: "(a+)+$", flags: "i" }
    ]
  });

  assert.equal(matches.length, 2);
  assert.deepEqual(Array.from(matches, (match) => match.type), ["custom-regex:case-id", "custom-regex:case-id"]);
  assert.doesNotMatch(Matcher.maskText(text, matches), /103942|884210/);
  dom.window.close();
});
