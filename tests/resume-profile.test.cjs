const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "lib", "resume-profile.mjs")).href);

test("extracts contact details from a synthetic resume header", async () => {
  const { extractResumeDetails } = await load();
  const d = extractResumeDetails(
    "Alex Example\nSeattle, WA | alex@example.com | +1   (202) 555 - 0142\nlinkedin.com/in/alex-example | github.com/alexexample\n" +
    "Summary\nSoftware engineer with 5+ years of experience."
  );
  assert.equal(d.firstName, "Alex");
  assert.equal(d.lastName, "Example");
  assert.equal(d.email, "alex@example.com");
  assert.equal(d.phone, "+1 (202) 555-0142");
  assert.equal(d.location, "Seattle, WA");
  assert.equal(d.linkedin, "https://linkedin.com/in/alex-example");
  assert.equal(d.website, "https://github.com/alexexample");
  assert.equal(d.experience, "5+");
});

test("phone formats with single separators still match", async () => {
  const { extractResumeDetails } = await load();
  for (const raw of ["202-555-0142", "(202) 555-0142", "202.555.0142", "+1 202 555 0142"]) {
    assert.ok(extractResumeDetails(`Alex Example\n${raw}\nSummary`).phone, raw);
  }
});

test("merging never overwrites values the user already entered", async () => {
  const { mergeResumeDetails } = await load();
  const merged = mergeResumeDetails({ email: "typed@example.com", phone: "" }, { email: "x@example.com", phone: "202-555-0142" });
  assert.equal(merged.email, "typed@example.com");
  assert.equal(merged.phone, "202-555-0142");
});
