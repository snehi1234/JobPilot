const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function harness(backendUrl, responses) {
  const calls = [];
  let onMessage;
  let token = "synthetic-test-token";
  let refreshes = 0;
  const store = {};
  const context = vm.createContext({
    BACKEND_URL: backendUrl,
    TextEncoder,
    crypto: globalThis.crypto,
    getIdToken: async () => token,
    signIn: async () => { refreshes++; token = "refreshed-test-token"; },
    console,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const result = responses[calls.length - 1];
      assert.ok(result, "Unexpected extra request");
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "Content-Type": "application/json" },
      });
    },
    chrome: {
      storage: { local: {
        async get(key) { return { [key]: store[key] }; },
        async set(values) { Object.assign(store, values); },
      } },
      sidePanel: {
        setPanelBehavior: async () => {},
        open: async () => {},
      },
      action: { onClicked: { addListener() {} } },
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener: (listener) => { onMessage = listener; } },
      },
    },
  });
  const engine = readFileSync(path.join(__dirname, "..", "lib", "answer-engine.mjs"), "utf8").replace(/^export /gm, "");
  vm.runInContext(engine, context);
  const source = readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  vm.runInContext(source.replace(/^import .*;\r?$/gm, ""), context);
  return {
    calls,
    store,
    get refreshes() { return refreshes; },
    request: (message) => new Promise((resolve) => onMessage(message, {}, resolve)),
  };
}

test("a missing backend cannot activate a client-side model fallback", async () => {
  const h = harness("", []);
  const result = await h.request({
    type: "COUNT_ENTRIES", profile: "Synthetic test profile", apiKey: "unused-test-key",
  });
  assert.match(result.error, /backend is not configured/);
  assert.equal(h.calls.length, 0);
});

test("resume quota errors reach the UI instead of success-shaped default counts", async () => {
  const h = harness("https://jobpilot.example.invalid", [
    { status: 429, body: { error: "Groq quota reached (429)." } },
  ]);
  const result = await h.request({ type: "COUNT_ENTRIES", profile: "Synthetic test profile" });
  assert.match(result.error, /Groq quota/);
  assert.equal(result.counts, undefined);
  assert.equal(h.calls[0].url, "https://jobpilot.example.invalid/api/parse-resume");
  assert.equal(h.calls.length, 1);
});

test("generation uses only the authenticated backend and preserves suggestions", async () => {
  const h = harness("https://jobpilot.example.invalid", [
    { status: 200, body: { suggestions: [{ id: "name", value: "Test Person" }] } },
  ]);
  const result = await h.request({
    type: "GENERATE_ANSWERS",
    fields: [{ id: "name", label: "Name" }],
    profile: "Synthetic test profile",
    apiKey: "unused-test-key",
  });
  assert.equal(result.suggestions[0].value, "Test Person");
  assert.equal(h.calls[0].url, "https://jobpilot.example.invalid/api/generate");
  assert.equal(h.calls[0].options.headers.Authorization, "Bearer synthetic-test-token");
  assert.equal(h.calls.length, 1);
});

test("the existing one-time authentication refresh still works", async () => {
  const h = harness("https://jobpilot.example.invalid", [
    { status: 401, body: { error: "Expired token" } },
    { status: 200, body: { counts: { experience: 1, education: 1 }, entries: {} } },
  ]);
  const result = await h.request({ type: "COUNT_ENTRIES", profile: "Synthetic test profile" });
  assert.equal(result.counts.experience, 1);
  assert.equal(h.refreshes, 1);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].options.headers.Authorization, "Bearer refreshed-test-token");
  assert.ok(h.calls.every((call) => call.url === "https://jobpilot.example.invalid/api/parse-resume"));
});

test("resume parsing is cached so repeat autofills make one AI call", async () => {
  const parsed = { counts: { experience: 1, education: 1 }, entries: { experience: [], education: [] } };
  const h = harness("https://jobpilot.example.invalid", [{ status: 200, body: parsed }]);
  const first = await h.request({ type: "COUNT_ENTRIES", profile: "Synthetic test profile" });
  const second = await h.request({ type: "COUNT_ENTRIES", profile: "Synthetic test profile" });
  assert.deepEqual(first, parsed);
  assert.deepEqual(second, parsed);
  assert.equal(h.calls.length, 1);
});

test("answers come from profile and memory first; only unknown fields reach the AI", async () => {
  const h = harness("https://jobpilot.example.invalid", [
    { status: 200, body: { suggestions: [{ id: "2", label: "Are you authorized?", value: "Yes", confidence: "high" }] } },
  ]);
  const fields = [
    { id: "1", label: "Email", kind: "text", occurrence: 0 },
    { id: "2", label: "Are you authorized?", kind: "radio", options: ["Yes", "No"], occurrence: 0 },
  ];
  const message = { type: "GENERATE_ANSWERS", fields, profile: "Synthetic", structured: { email: "alex@example.com" }, jobContext: {} };

  const local = await h.request({ ...message, localOnly: true });
  assert.equal(JSON.stringify(local.suggestions.map((s) => s.value)), JSON.stringify(["alex@example.com"]));
  assert.equal(JSON.stringify(local.pending), JSON.stringify(["2"]));
  assert.equal(h.calls.length, 0, "localOnly never calls the backend");

  const first = await h.request(message);
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.stringify(JSON.parse(h.calls[0].options.body).fields.map((f) => f.id)), JSON.stringify(["2"]));
  assert.equal(first.suggestions.length, 2);

  const second = await h.request(message);
  assert.equal(h.calls.length, 1, "remembered answer avoids a second AI call");
  assert.equal(JSON.stringify(second.suggestions.map((s) => s.source)), JSON.stringify(["profile", "memory"]));

  const changed = await h.request({ ...message, structured: { email: "new@example.com" }, localOnly: true });
  assert.equal(JSON.stringify(changed.pending), JSON.stringify(["2"]), "editing the profile clears remembered answers");
});
