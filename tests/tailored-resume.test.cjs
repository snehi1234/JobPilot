const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "lib", "tailored-resume.mjs")).href);
const RESUME = `Alex Example
alex@example.com | +1 202 555 0142 | linkedin.com/in/alex
Experience
Senior Engineer, Acme — Jan 2021 – Present
• Built a payments ledger in Java and Kafka handling 2M events/day
• Worked on the partner onboarding API used by 300+ partners
Education
M.S. Computer Science, 2018`;

test("accepted suggestions replace exact bullets and add a summary", async () => {
  const { applyTailoring } = await load();
  const out = applyTailoring(RESUME, {
    summary: "Backend engineer focused on streaming systems.",
    bullets: [{ line: "• Worked on the partner onboarding API used by 300+ partners", improved: "Designed the partner onboarding API adopted by 300+ partners" },
      { line: "• Not on the resume", improved: "Should be ignored" }],
  });
  assert.match(out, /• Designed the partner onboarding API adopted by 300\+ partners/);
  assert.doesNotMatch(out, /Worked on the partner/);
  assert.doesNotMatch(out, /Should be ignored/);
  const lines = out.split("\n");
  assert.equal(lines[2], "Summary", "summary goes after the contact block");
  assert.equal(lines[3], "Backend engineer focused on streaming systems.");
  assert.match(out, /• Built a payments ledger/);
  const existing = applyTailoring("Name\nSummary\nOld summary text.\n\nExperience\n• x", { summary: "New summary." });
  assert.match(existing, /Summary\nNew summary\./);
  assert.doesNotMatch(existing, /Old summary/);
});

test("the PDF is valid, multi-page when needed, and escapes text safely", async () => {
  const { renderResumePdf } = await load();
  const bytes = renderResumePdf(RESUME + "\n" + "• A (very) long bullet with a backslash \\ and “quotes” — é ".repeat(3) + "\n".repeat(1) + Array.from({ length: 90 }, (_, i) => `• Bullet ${i}`).join("\n"));
  const pdf = new TextDecoder().decode(bytes);
  assert.ok(pdf.startsWith("%PDF-1.4") && pdf.trimEnd().endsWith("%%EOF"));
  assert.match(pdf, /\/Count 3 /, "about 50 bullets per page");
  assert.match(pdf, /\(Alex Example\) Tj/);
  assert.match(pdf, /\\\(very\\\)/);
  assert.match(pdf, /\\\\ and "quotes" - \\351/);
  assert.match(pdf, /\(EXPERIENCE\) Tj/);
  // Every xref offset points at its object.
  const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  offsets.forEach((o, i) => assert.ok(pdf.startsWith(`${i + 1} 0 obj`, o), `object ${i + 1}`));
});
