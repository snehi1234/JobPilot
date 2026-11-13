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
        async get(keys) { return Object.fromEntries([].concat(keys).map((key) => [key, store[key]])); },
        async remove(keys) { for (const key of [].concat(keys)) delete store[key]; },
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
        getManifest: () => ({ version: "0.0.0" }),
      },
    },
    setTimeout,
    clearTimeout,
    URL,
  });
  const engine = readFileSync(path.join(__dirname, "..", "lib", "answer-engine.mjs"), "utf8").replace(/^export /gm, "");
  vm.runInContext(engine, context);
  const matcher = readFileSync(path.join(__dirname, "..", "lib", "match-score.mjs"), "utf8").replace(/^export /gm, "");
  vm.runInContext(matcher, context);
  const jd = readFileSync(path.join(__dirname, "..", "lib", "job-description.mjs"), "utf8").replace(/^export /gm, "");
  vm.runInContext(jd, context);
  const tel = readFileSync(path.join(__dirname, "..", "lib", "telemetry.mjs"), "utf8").replace(/^export /gm, "");
  vm.runInContext(tel, context);
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

test("resume pick uses stored resumes, remembers a manual choice per company, and migrates old profiles", async () => {
  const h = harness("https://jobpilot.example.invalid", []);
  h.store.uploadedResumeText = "Legacy resume text with Python";
  const legacy = await h.request({ type: "PICK_RESUME", jobContext: { title: "Engineer" }, host: "x.example" });
  assert.equal(legacy.resumeId, "default");
  assert.equal(legacy.reason, "only");
  assert.equal(legacy.text, "Legacy resume text with Python");

  h.store.resumes = [
    { id: "sw", name: "Software", text: "Java Kubernetes Docker microservices PostgreSQL Redis REST APIs" },
    { id: "de", name: "Data", text: "Spark Airflow dbt Snowflake SQL Kafka ETL" },
  ];
  h.store.defaultResumeId = "sw";
  const job = { company: "Plaid", title: "Data Engineer", description: "Spark, Airflow, dbt, Snowflake, SQL, Kafka." };
  const pick = await h.request({ type: "PICK_RESUME", jobContext: job, host: "jobs.ashbyhq.com" });
  assert.equal(pick.resumeId, "de");
  assert.equal(pick.name, "Data");
  assert.equal(pick.count, 2);

  await h.request({ type: "REMEMBER_RESUME_CHOICE", jobContext: job, host: "jobs.ashbyhq.com", resumeId: "sw" });
  const again = await h.request({ type: "PICK_RESUME", jobContext: job, host: "jobs.ashbyhq.com" });
  assert.equal(again.resumeId, "sw");
  assert.equal(again.reason, "remembered");
  const fresh = await h.request({ type: "PICK_RESUME", jobContext: job, host: "jobs.ashbyhq.com", ignoreRemembered: true });
  assert.equal(fresh.resumeId, "de");
  assert.equal(h.calls.length, 0, "resume picking never calls the backend");
});

test("corrections and remembered answers are kept separately per resume", async () => {
  const h = harness("https://jobpilot.example.invalid", [
    { status: 200, body: { suggestions: [{ id: "1", value: "Yes", confidence: "high" }] } },
    { status: 200, body: { suggestions: [{ id: "1", value: "Yes", confidence: "high" }] } },
  ]);
  const field = { id: "1", label: "Are you open to relocation?", kind: "radio", options: ["Yes", "No"], occurrence: 0 };
  const message = { type: "GENERATE_ANSWERS", fields: [field], profile: "P", structured: {}, jobContext: {} };

  await h.request({ ...message, resumeId: "sw" });
  const learned = await h.request({ type: "LEARN_ANSWER", field, value: "No", resumeId: "sw" });
  assert.equal(learned.learned, true);
  const sw = await h.request({ ...message, resumeId: "sw" });
  assert.equal(JSON.stringify(sw.suggestions.map((s) => [s.value, s.source])), JSON.stringify([["No", "correction"]]));
  assert.equal(h.calls.length, 1);

  const de = await h.request({ ...message, resumeId: "de" });
  assert.equal(h.calls.length, 2, "another resume does not reuse the first resume's answers");
  assert.equal(de.suggestions[0].value, "Yes");
});

test("saved long answers fill matching questions; drafts and files route correctly", async () => {
  const h = harness("https://jobpilot.example.invalid", [
    { status: 200, body: { answer: "Shorter draft" } },
  ]);
  await h.request({ type: "SAVE_TO_LIBRARY", question: "Why do you want to work here?", answer: "Because of the mission." });
  const result = await h.request({
    type: "GENERATE_ANSWERS", profile: "P", structured: {}, jobContext: {}, localOnly: true,
    fields: [{ id: "9", label: "Why do you want to work here at Acme?", kind: "text", tag: "textarea", occurrence: 0 }],
  });
  assert.equal(JSON.stringify(result.suggestions.map((s) => [s.value, s.source])), JSON.stringify([["Because of the mission.", "library"]]));

  const draft = await h.request({ type: "REVISE_DRAFT", question: "Why?", answer: "Long", mode: "shorter", jobContext: {}, profile: "P" });
  assert.equal(draft.answer, "Shorter draft");
  assert.equal(h.calls[0].url, "https://jobpilot.example.invalid/api/draft");

  h.store.resumeFiles = { sw: { name: "cv.pdf", type: "application/pdf", data: "QUJD" } };
  assert.equal((await h.request({ type: "GET_RESUME_FILE", resumeId: "sw" })).name, "cv.pdf");
  assert.equal(await h.request({ type: "GET_RESUME_FILE", resumeId: "missing" }), null);
});

test("cover letters skip the answer engine, are written once per job and resume, and keep edits", async () => {
  const letter = "Dear Hiring Team,\n\n" + "Built systems. ".repeat(40) + "\n\nSincerely,\nAlex";
  const h = harness("https://jobpilot.example.invalid", [
    { status: 200, body: { suggestions: [] } },
    { status: 200, body: { letter } },
    { status: 200, body: { letter: letter + " v2" } },
  ]);
  const generated = await h.request({
    type: "GENERATE_ANSWERS", profile: "P", structured: {}, jobContext: {},
    fields: [{ id: "1", label: "Cover Letter", kind: "text", tag: "textarea", occurrence: 0 }, { id: "2", label: "Portfolio URL", kind: "text", occurrence: 0 }],
  });
  assert.equal(JSON.stringify(JSON.parse(h.calls[0].options.body).fields.map((f) => f.id)), JSON.stringify(["2"]));
  assert.equal(generated.suggestions.length, 0);

  const job = { title: "Data Engineer", company: "Acme" };
  const message = { type: "WRITE_COVER_LETTER", jobContext: job, url: "https://jobs.example/acme/1", resumeId: "de", profile: "Resume", structured: { firstName: "Alex" } };
  const first = await h.request(message);
  assert.equal(first.letter, letter);
  assert.equal(h.calls[1].url, "https://jobpilot.example.invalid/api/cover-letter");
  assert.equal(JSON.parse(h.calls[1].options.body).jobContext.title, "Data Engineer");
  const again = await h.request(message);
  assert.equal(again.cached, true);
  assert.equal(h.calls.length, 2, "the same job and resume reuse the letter");

  await h.request({ ...message, type: "SAVE_COVER_LETTER", letter: "Edited letter" });
  assert.equal((await h.request(message)).letter, "Edited letter");
  const fresh = await h.request({ ...message, regenerate: true });
  assert.match(fresh.letter, /v2$/);
  assert.equal(h.calls.length, 3);

  h.store.coverLetterFile = { name: "cover.pdf", type: "application/pdf", data: "QUJD", text: "Hello" };
  assert.equal((await h.request({ type: "GET_COVER_LETTER_FILE" })).name, "cover.pdf");
});

test("feedback is sent to the backend with only the allowed fields", async () => {
  const h = harness("https://jobpilot.example.invalid", [{ status: 200, body: { ok: true, id: 7 } }]);
  const result = await h.request({
    type: "SEND_FEEDBACK",
    feedback: { type: "bug", message: "School not filled", contactOk: true, includeDetails: false, details: { site: "x" }, extra: "nope" },
  });
  assert.equal(result.id, 7);
  assert.equal(h.calls[0].url, "https://jobpilot.example.invalid/api/feedback");
  const body = JSON.parse(h.calls[0].options.body);
  assert.equal(JSON.stringify(Object.keys(body).sort()), JSON.stringify(["contactOk", "details", "includeDetails", "message", "type"]));
  assert.equal(JSON.stringify(body.details), "{}", "details are dropped when the user unticks them");
});
