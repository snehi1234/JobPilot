import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeResumes, MAX_RESUMES } from "../lib/resumes.js";
import { buildDraftPrompt, DRAFT_MODES, buildCoverLetterPrompt } from "../lib/prompts.js";

test("resume lists are validated, trimmed, de-duplicated and capped", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, name: `R${i}`, text: "text" }));
  assert.equal(sanitizeResumes(many).length, MAX_RESUMES);
  const out = sanitizeResumes([
    { id: "a<script>", name: "x".repeat(100), text: "t".repeat(70000), fileName: "cv.pdf", isDefault: "yes" },
    { id: "a<script>", name: "dup", text: "dup" },
    { id: "b", name: "", text: "   " },
    null,
    "junk",
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "ascript");
  assert.equal(out[0].name.length, 60);
  assert.equal(out[0].text.length, 60000);
  assert.equal(out[0].isDefault, true, "the first resume becomes the default when none is marked");
  assert.deepEqual(sanitizeResumes("nope"), []);
  const marked = sanitizeResumes([{ id: "a", text: "x" }, { id: "b", text: "y", isDefault: true }]);
  assert.deepEqual(marked.map((r) => r.isDefault), [false, true]);
});

test("draft prompts include the task for each mode and forbid invented facts", () => {
  assert.deepEqual(DRAFT_MODES, ["shorter", "longer", "regenerate"]);
  const prompt = buildDraftPrompt({
    question: "Why us?", answer: "Because.", mode: "shorter",
    jobContext: { title: "Engineer", company: "Acme", description: "Build things" }, profile: "Resume text",
  });
  assert.match(prompt, /Engineer at Acme/);
  assert.match(prompt, /half as long/);
  assert.match(prompt, /Never invent/);
  assert.match(prompt, /Resume text/);
});

test("cover letter prompts ask for ~250 grounded words for the specific job", () => {
  const prompt = buildCoverLetterPrompt({
    jobContext: { title: "Backend Engineer", company: "Software Engineer, Backend @ Wisdom AI", description: "Kafka and Go" },
    profile: "Resume text", structured: { firstName: "Alex", lastName: "Example" },
  });
  assert.match(prompt, /Job title: Backend Engineer/);
  assert.match(prompt, /Company: Wisdom AI/);
  assert.match(prompt, /About 250 words/);
  assert.match(prompt, /Never invent/);
  assert.match(prompt, /Candidate name: Alex Example/);
  assert.match(prompt, /Kafka and Go/);
});