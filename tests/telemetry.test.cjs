const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "lib", "telemetry.mjs")).href);

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const list = typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(obj) { Object.assign(data, structuredClone(obj)); },
  };
}

test("platformOf maps hosts to coarse platform names only", async () => {
  const { platformOf } = await load();
  assert.equal(platformOf("https://boards.greenhouse.io/acme/jobs/1"), "greenhouse");
  assert.equal(platformOf("https://job-boards.greenhouse.io/acme/jobs/1"), "greenhouse");
  assert.equal(platformOf("https://nvidia.wd5.myworkdayjobs.com/en-US/x"), "workday");
  assert.equal(platformOf("https://careers-acme.icims.com/jobs/1/job"), "icims");
  assert.equal(platformOf("https://jobs.smartrecruiters.com/Acme/123"), "smartrecruiters");
  assert.equal(platformOf("https://acme.taleo.net/careersection/2/jobapply.ftl"), "taleo");
  assert.equal(platformOf("https://career4.successfactors.com/career?company=acme"), "successfactors");
  assert.equal(platformOf("https://www.linkedin.com/jobs/view/1"), "linkedin");
  assert.equal(platformOf("https://notgreenhouse.io.evil.com/"), "other");
  assert.equal(platformOf("https://careers.acme.com/apply"), "other");
  assert.equal(platformOf("not a url"), "other");
  assert.equal(platformOf("https://api.example.app/practice.html", "https://api.example.app"), "practice");
  assert.equal(platformOf("https://api.example.app/admin", "https://api.example.app"), "other");
});

test("events are queued, batched, and removed only after a successful send", async () => {
  const { createTelemetry } = await load();
  const storage = memoryStorage();
  const sent = [];
  let fail = true;
  const t = createTelemetry({
    storage, now: () => 1000, flushDelayMs: 1e9,
    send: async (events, id) => { if (fail) throw new Error("offline"); sent.push({ events, id }); },
  });
  assert.equal(await t.track("autofill", { fields: 5 }), true);
  assert.equal(await t.track("not_an_event"), false);
  await assert.rejects(t.flush(), /offline/);
  assert.equal(storage.data.telemetryQueue.length, 1, "kept for retry");
  fail = false;
  assert.equal(await t.flush(), 1);
  assert.equal(storage.data.telemetryQueue.length, 0);
  assert.equal(sent[0].events[0].name, "autofill");
  assert.match(sent[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(await t.installId(), sent[0].id, "install id is stable");
});

test("turning usage stats off stops tracking and clears the queue", async () => {
  const { createTelemetry } = await load();
  const storage = memoryStorage();
  const t = createTelemetry({ storage, send: async () => { throw new Error("should not send"); }, flushDelayMs: 1e9 });
  await t.track("sign_in");
  await t.setEnabled(false);
  assert.deepEqual(storage.data.telemetryQueue, []);
  assert.equal(await t.track("autofill"), false);
  assert.equal(await t.flush(), 0);
  await t.setEnabled(true);
  assert.equal(await t.track("autofill"), true);
});

test("the queue is capped so storage can't grow forever", async () => {
  const { createTelemetry } = await load();
  const storage = memoryStorage();
  const t = createTelemetry({ storage, send: async () => {}, flushDelayMs: 1e9 });
  for (let i = 0; i < 230; i++) await t.track("autofill", { fields: i });
  assert.equal(storage.data.telemetryQueue.length, 200);
  assert.equal(storage.data.telemetryQueue[0].props.fields, 30, "oldest dropped first");
});

test("rating prompt: after 3 good fills, snoozes two weeks, never after rating", async () => {
  const { shouldAskForRating, applyRatingAction, RATE_SNOOZE_MS } = await load();
  const now = 10 * RATE_SNOOZE_MS;
  assert.equal(shouldAskForRating({ successfulFills: 2 }, now), false);
  assert.equal(shouldAskForRating({ successfulFills: 3 }, now), true);
  const later = applyRatingAction({ successfulFills: 3 }, "later", now);
  assert.equal(shouldAskForRating(later, now + 1000), false);
  assert.equal(shouldAskForRating(later, now + RATE_SNOOZE_MS + 1), true);
  assert.equal(shouldAskForRating(applyRatingAction(later, "rate", now), now + 10 * RATE_SNOOZE_MS), false);
  assert.equal(shouldAskForRating(applyRatingAction(later, "never", now), now + 10 * RATE_SNOOZE_MS), false);
});
