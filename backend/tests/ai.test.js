import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { callAI, extractJson } from "../lib/ai.js";
import generate from "../api/generate.js";
import parseResume from "../api/parse-resume.js";
import health from "../api/health.js";

beforeEach((t) => {
  const settings = {
    GROQ_API_KEY: "synthetic-groq-test-key",
    GEMINI_API_KEY: "unused-synthetic-test-key",
    GOOGLE_CLIENT_ID: "",
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
  };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
});

function mockGroq(t, statuses) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "https://api.groq.com/openai/v1/models") {
      return new Response(JSON.stringify({ data: [
        { id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }, { id: "whisper-large-v3" },
      ] }), { status: 200 });
    }
    assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
    calls.push(JSON.parse(options.body));
    const status = statuses[calls.length - 1];
    assert.notEqual(status, undefined, "Unexpected extra provider request");
    return new Response(
      status === 200
        ? JSON.stringify({ choices: [{ message: { content: '{"suggestions":[]}' } }] })
        : "Synthetic provider error",
      { status, headers: { "Content-Type": "application/json" } }
    );
  });
  return calls;
}

function responseRecorder() {
  return {
    statusCode: 200,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("uses an available preferred model with JSON output", async (t) => {
  const calls = mockGroq(t, [200]);
  const result = await callAI("Synthetic test prompt", { maxOutputTokens: 1000, temperature: 0 });
  assert.equal(result, '{"suggestions":[]}');
  assert.equal(calls[0].model, "openai/gpt-oss-120b");
  assert.equal(calls[0].temperature, 0);
  assert.equal(calls[0].max_tokens, 1000);
  assert.deepEqual(calls[0].response_format, { type: "json_object" });
});

test("never selects retired or non-chat models", async (t) => {
  const calls = mockGroq(t, [500, 200]);
  await callAI("x".repeat(24000));
  assert.deepEqual(calls.map((c) => c.model), ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
});

test("a model rate limit can fall back to the other Groq model", async (t) => {
  const calls = mockGroq(t, [429, 200]);
  await callAI("Synthetic test prompt");
  assert.deepEqual(calls.map((call) => call.model), [
    "openai/gpt-oss-120b", "openai/gpt-oss-20b",
  ]);
});

test("exhausting both Groq models returns 429 without any other provider", async (t) => {
  const calls = mockGroq(t, [429, 429]);
  await assert.rejects(callAI("Synthetic test prompt"), (err) => {
    assert.equal(err.status, 429);
    assert.match(err.message, /No other AI provider/);
    return true;
  });
  assert.equal(calls.length, 2);
});

test("a later missing-model error does not hide an earlier quota error", async (t) => {
  mockGroq(t, [429, 404]);
  await assert.rejects(callAI("Synthetic test prompt"), (err) => err.status === 429);
});

test("provider failures never route to Gemini even when its old key is present", async (t) => {
  const calls = mockGroq(t, [500, 503]);
  await assert.rejects(callAI("Synthetic test prompt"), (err) => err.status === 503);
  assert.equal(calls.length, 2);
});

test("invalid credentials fail immediately without another provider", async (t) => {
  const calls = mockGroq(t, [401]);
  await assert.rejects(callAI("Synthetic test prompt"), (err) => err.status === 401);
  assert.equal(calls.length, 1);
});

test("a missing Groq key disables inference even if the old Gemini key exists", async (t) => {
  delete process.env.GROQ_API_KEY;
  const calls = mockGroq(t, []);
  await assert.rejects(callAI("Synthetic test prompt"), (err) => err.status === 503);
  assert.equal(calls.length, 0);
});

for (const [name, handler, body] of [
  ["resume parsing", parseResume, { profile: "Synthetic test profile" }],
  ["answer generation", generate, {
    profile: "Synthetic test profile",
    fields: [{ id: "name", label: "Name", kind: "text", type: "text" }],
  }],
]) {
  test(`${name} exposes provider quota exhaustion as HTTP 429`, async (t) => {
    const calls = mockGroq(t, [429, 429]);
    const response = responseRecorder();
    await handler({
      method: "POST",
      headers: { origin: "chrome-extension://test", "x-forwarded-for": "192.0.2.1" },
      body,
    }, response);
    assert.equal(response.statusCode, 429);
    assert.match(response.body.error, /Groq quota/);
    assert.equal(response.body.counts, undefined);
    assert.equal(response.body.suggestions, undefined);
    assert.equal(calls.length, 2);
  });
}

test("health identifies Groq as the only active AI provider", async (t) => {
  mockGroq(t, []);
  const response = responseRecorder();
  await health({ method: "GET", headers: {} }, response);
  assert.equal(response.body.aiProvider, "groq");
  assert.equal(response.body.groqConfigured, true);
  assert.ok(response.body.availableModels.includes("openai/gpt-oss-120b"));
  assert.equal("geminiConfigured" in response.body, false);
});

test("the shared JSON helper still handles fenced responses", () => {
  assert.deepEqual(extractJson('```json\n{"suggestions":[]}\n```'), { suggestions: [] });
});
