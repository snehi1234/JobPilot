const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "lib", "answer-engine.mjs")).href);
const profile = {
  firstName: "Alex", lastName: "Example", email: "alex@example.com", phone: "+1 (202) 555-0142",
  location: "Seattle, WA", linkedin: "https://linkedin.com/in/example", website: "https://github.com/example",
  experience: "5+", workAuth: "H-1B", sponsorship: "Yes",
};
const f = (id, label, kind = "text", extra = {}) => ({ id: String(id), label, kind, occurrence: 0, ...extra });

test("profile rules answer common contact fields without AI", async () => {
  const { resolveLocally } = await load();
  const fields = [
    f(1, "First Name*"), f(2, "Last name"), f(3, "Full Name"), f(4, "Email address"),
    f(5, "Mobile Phone"), f(6, "LinkedIn Profile"), f(7, "GitHub"), f(8, "City"),
    f(9, "Years of experience"), f(10, "Why do you want to work here?", "text", { tag: "textarea" }),
  ];
  const { suggestions, pending } = resolveLocally(fields, { structured: profile, context: {} });
  const v = Object.fromEntries(suggestions.map((s) => [s.id, s.value]));
  assert.equal(v[1], "Alex");
  assert.equal(v[2], "Example");
  assert.equal(v[3], "Alex Example");
  assert.equal(v[4], "alex@example.com");
  assert.equal(v[5], "+1 (202) 555-0142");
  assert.equal(v[6], "https://linkedin.com/in/example");
  assert.equal(v[7], "https://github.com/example");
  assert.equal(v[8], "Seattle");
  assert.equal(v[9], "5");
  assert.deepEqual(pending.map((p) => p.id), ["10"]);
});

test("special rules: phone country code, today's date, source, visa, sponsorship", async () => {
  const { resolveLocally } = await load();
  const today = new Date(2026, 10, 9);
  const fields = [
    f(1, "Country code", "combobox"), f(2, "Country Phone Code", "text"),
    f(3, "Please enter today's date on your acknowledgement."), f(4, "How did you hear about us?", "select"),
    f(5, "Please confirm your visa type?"), f(6, "Will you require sponsorship?", "radio"),
  ];
  const { suggestions } = resolveLocally(fields, { structured: profile, context: { today, sourceHint: "LinkedIn" } });
  const v = Object.fromEntries(suggestions.map((s) => [s.id, s.value]));
  assert.equal(v[1], "United States");
  assert.equal(v[2], "+1");
  assert.equal(v[3], "11/09/2026");
  assert.equal(v[4], "LinkedIn");
  assert.equal(v[5], "H-1B");
  assert.equal(v[6], "Yes");
});

test("questions about other people are never answered with the user's details", async () => {
  const { resolveLocally } = await load();
  const { suggestions } = resolveLocally(
    [f(1, "Referrer email"), f(2, "Emergency contact phone"), f(3, "Manager name")],
    { structured: profile, context: {} });
  assert.equal(suggestions.length, 0);
});

test("remembered answers are reused, but not job-specific or low-confidence ones", async () => {
  const { resolveLocally, rememberAnswers } = await load();
  const fields = [
    f(1, "Are you legally authorized to work in the US?", "radio", { options: ["Yes", "No"] }),
    f(2, "Why are you interested in this role?"),
    f(3, "Gender", "select", { options: ["Male", "Female", "Decline"] }),
    f(4, "Expected salary"),
  ];
  const memory = rememberAnswers({ version: "v1", entries: {} }, fields, [
    { id: "1", value: "Yes", confidence: "high" },
    { id: "2", value: "Because…", confidence: "high" },
    { id: "3", value: "Male", confidence: "low" },
    { id: "4", value: "$150,000", confidence: "high" },
  ]);
  const next = [f(9, "Are you legally authorized to work in the US?", "radio", { options: ["No", "Yes"] }), f(10, "Why are you interested in this role?")];
  const { suggestions, pending } = resolveLocally(next, { structured: {}, memory, context: {} });
  assert.deepEqual(suggestions.map((s) => [s.id, s.value, s.source]), [["9", "Yes", "memory"]]);
  assert.deepEqual(pending.map((p) => p.id), ["10"]);
  assert.equal(Object.keys(memory.entries).length, 1);
});

test("repeated questions are remembered per position", async () => {
  const { resolveLocally, rememberAnswers } = await load();
  const fields = [f(1, "School", "combobox", { occurrence: 0 }), f(2, "School", "combobox", { occurrence: 1 })];
  const memory = rememberAnswers({ entries: {} }, fields, [
    { id: "1", value: "Indiana University Bloomington", confidence: "high" },
    { id: "2", value: "Maulana Azad National Institute of Technology", confidence: "high" },
  ]);
  const { suggestions } = resolveLocally(fields, { structured: {}, memory, context: {} });
  assert.deepEqual(suggestions.map((s) => s.value), ["Indiana University Bloomington", "Maulana Azad National Institute of Technology"]);
});

test("any profile change produces a new version, invalidating remembered answers", async () => {
  const { profileVersion } = await load();
  const a = await profileVersion(profile, "resume text");
  assert.equal(a, await profileVersion({ ...profile }, "resume text"));
  assert.notEqual(a, await profileVersion({ ...profile, phone: "+1 202 555 0199" }, "resume text"));
  assert.notEqual(a, await profileVersion(profile, "resume text updated"));
});
