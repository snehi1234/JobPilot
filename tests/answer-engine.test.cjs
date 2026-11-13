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

test("user corrections win over profile rules and memory; saved long answers fill drafts", async () => {
  const { resolveLocally, recordCorrection, rememberAnswers } = await load();
  const city = f(1, "City");
  const auth = f(2, "Are you legally authorized to work in the US?", "radio", { options: ["Yes", "No"] });
  const why = f(3, "Why do you want to work at Plaid?", "text", { tag: "textarea" });
  let corrections = recordCorrection(undefined, city, "  Redmond ");
  corrections = recordCorrection(corrections, auth, "No");
  assert.equal(recordCorrection(corrections, f(9, "Referrer name"), "Sam"), corrections, "non-reusable fields are not learned");
  assert.equal(recordCorrection(corrections, city, "   "), corrections, "blank edits are ignored");
  const memory = rememberAnswers({ entries: {} }, [auth], [{ id: "2", value: "Yes", confidence: "high" }]);
  const library = [{ question: "Why do you want to work at Stripe?", answer: "Saved answer" }];
  const { suggestions, pending } = resolveLocally([city, auth, why], { structured: profile, memory, corrections, library, context: {} });
  assert.deepEqual(suggestions.map((s) => [s.id, s.value, s.source]), [
    ["1", "Redmond", "correction"], ["2", "No", "correction"], ["3", "Saved answer", "library"],
  ]);
  assert.equal(pending.length, 0);
});

test("library answers need a close question match and only fill long questions", async () => {
  const { findLibraryAnswer, isLongQuestion } = await load();
  const library = [
    { question: "Why are you interested in this role?", answer: "A" },
    { question: "Describe a challenging project you led.", answer: "B" },
  ];
  assert.equal(findLibraryAnswer(library, "Why are you interested in this position?")?.answer, "A");
  assert.equal(findLibraryAnswer(library, "Why are you interested in this role at Plaid?")?.answer, "A");
  assert.equal(findLibraryAnswer(library, "Describe a challenging project you led")?.answer, "B");
  assert.equal(findLibraryAnswer(library, "What is your expected salary?"), null);
  assert.equal(isLongQuestion(f(1, "Tell us about yourself")), true);
  assert.equal(isLongQuestion(f(2, "LinkedIn Profile")), false);
});

test("user-facing extension pages never name internal vendors or plans", () => {
  const fs = require("node:fs");
  const root = path.join(__dirname, "..");
  for (const file of ["sidepanel.html", "onboarding.html", "privacy.html", "terms.html", "sidepanel.js", "content.js", "content-ui.js", "content-match.js", "content-workday.js",
    "backend/public/index.html", "backend/public/privacy.html", "backend/public/terms.html", "backend/public/admin.html", "backend/public/admin.js"]) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(text, /\b(groq|supabase|vercel|gemini|gpt-oss)\b|free[- ]tier|free plan|paid provider/i, file);
  }
});

test("cover-letter questions are never answered as ordinary questions", async () => {
  const { isCoverLetterField } = await load();
  assert.equal(isCoverLetterField(f(1, "Cover Letter", "text", { tag: "textarea" })), true);
  assert.equal(isCoverLetterField(f(2, "Covering letter (optional)")), true);
  assert.equal(isCoverLetterField(f(3, "Motivation letter")), true);
  assert.equal(isCoverLetterField(f(4, "Cover letter", "combobox")), false);
  assert.equal(isCoverLetterField(f(5, "Why do you want to work here?")), false);
});

test("the old product name never appears in anything users see", () => {
  const fs = require("node:fs");
  const root = path.join(__dirname, "..");
  const files = ["manifest.json", "sidepanel.html", "sidepanel.js", "onboarding.html", "onboarding.js", "privacy.html", "terms.html",
    "content.js", "content-ui.js", "background.js", "auth.js", "cloud.js", "STORE_LISTING.md",
    "backend/public/index.html", "backend/public/privacy.html", "backend/public/terms.html", "backend/lib/ai.js"];
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf8"), /JobPilot|Job Pilot/, file);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.match(manifest.name, /^Hiresprint/);
  assert.ok(manifest.name.length <= 75 && manifest.short_name.length <= 12 && manifest.description.length <= 132);
});

test("public pages use the support address, never a personal email", () => {
  const fs = require("node:fs");
  const root = path.join(__dirname, "..");
  for (const file of ["privacy.html", "terms.html", "onboarding.html", "sidepanel.html", "STORE_LISTING.md", "README.md",
    "backend/public/index.html", "backend/public/privacy.html", "backend/public/terms.html", "backend/public/admin.html", "backend/public/admin.js"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf8"), /snehithbootla1@/i, file);
  }
  for (const file of ["privacy.html", "backend/public/privacy.html"]) {
    assert.match(fs.readFileSync(path.join(root, file), "utf8"), /hiresprint\.support@gmail\.com/, file);
  }
});

test("Answer Studio answers common questions exactly, with salary by role", async () => {
  const { resolveLocally, salaryFor } = await load();
  const studio = {
    ...profile, salary: "$170,000", salaryRole1: "data", salaryAmount1: "$160,000", salaryRole2: "manager", salaryAmount2: "$210,000",
    noticePeriod: "2 weeks", startAvailability: "Immediately", relocation: "Yes", workArrangement: "Hybrid",
    clearance: "None", over18: "Yes", preferredName: "Sam", pronouns: "he/him", defaultSource: "Company website",
  };
  assert.equal(salaryFor(studio, "Senior Data Engineer"), "$160,000");
  assert.equal(salaryFor(studio, "Engineering Manager, Payments"), "$210,000");
  assert.equal(salaryFor(studio, "Backend Engineer"), "$170,000");
  const fields = [
    f(1, "What are your salary expectations?"), f(2, "Desired compensation", "select"), f(3, "Current salary"),
    f(4, "What is your notice period?"), f(5, "When can you start?"), f(6, "Are you willing to relocate?", "radio"),
    f(7, "Work arrangement preference", "select"), f(8, "Do you have an active security clearance?", "radio"),
    f(9, "Are you at least 18 years of age?", "radio"), f(10, "Preferred name"), f(11, "Pronouns", "combobox"),
    f(12, "How did you hear about us?", "select"), f(13, "Are you willing to work on-site 3 days a week in a hybrid setup?", "radio"),
    f(14, "Are you currently based in Seattle and willing to work on-site?", "radio"), f(15, "Start Date (month)", "select"),
  ];
  const { suggestions, pending } = resolveLocally(fields, { structured: studio, context: { jobTitle: "Senior Data Engineer" } });
  const v = Object.fromEntries(suggestions.map((s) => [s.id, s.value]));
  assert.equal(v[1], "$160,000");
  assert.equal(v[2], "$160,000");
  assert.equal(v[3], undefined, "current salary is never answered with the target");
  assert.equal(v[4], "2 weeks");
  assert.equal(v[5], "Immediately");
  assert.equal(v[6], "Yes");
  assert.equal(v[7], "Hybrid");
  assert.equal(v[8], "None");
  assert.equal(v[9], "Yes");
  assert.equal(v[10], "Sam");
  assert.equal(v[11], "he/him");
  assert.equal(v[12], "Company website", "falls back to the default source when the page gives none");
  assert.equal(v[13], "Yes");
  assert.equal(v[14], undefined, "compound location questions go to the AI");
  assert.equal(v[15], undefined, "education/experience start dates are not availability");
  assert.ok(pending.some((p) => p.id === "14") && pending.some((p) => p.id === "3"));
  assert.ok(suggestions.every((s) => s.source === "profile"));

  const remote = resolveLocally([f(1, "Are you able to work in the office 5 days a week?", "radio")], { structured: { workArrangement: "Remote" }, context: {} });
  assert.equal(remote.suggestions[0].value, "No");
  const empty = resolveLocally([f(1, "What is your notice period?")], { structured: {}, context: {} });
  assert.equal(empty.suggestions.length, 0, "blank Answer Studio fields fall through to the AI");
});
