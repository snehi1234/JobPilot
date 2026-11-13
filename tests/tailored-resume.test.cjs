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

const WRAPPED = `Sam Sample
sam@example.com | Seattle, WA
Professional Experience
Example Corp
Software Engineer   Sept 2024   –   Present
●   Led the design and delivery of File Exchange, a net - new platform capability   that extended partner integration beyond B2B APIs to
secure UI - driven file upload/download. It was adopted by 30+ partners, processing
8,600+ files/day.
●   Built core components of a secure financial platform   (C#, .NET Core 6, Python, Vue.js) for stock and fund - transfer
operations, designing the data - access layer for testability.
Other Co
Full Stack Engineer   Jul 2023   –   Aug 2024
●   Drove the migration of a legacy Java application to .NET.
Education
MS, Computer Science`;

test("wrapped bullets are joined so a rewrite replaces the whole bullet", async () => {
  const { reflowBullets, applyTailoring } = await load();
  const lines = reflowBullets(WRAPPED).split("\n");
  const first = lines.find((l) => l.includes("File Exchange"));
  assert.match(first, /beyond B2B APIs to secure UI - driven .* processing 8,600\+ files\/day\.$/);
  assert.ok(lines.includes("Other Co"), "company names after a finished bullet stay on their own line");
  assert.ok(lines.some((l) => /^Full Stack Engineer/.test(l)), "dated title lines are never joined");
  const out = applyTailoring(WRAPPED, { bullets: [{ line: first.trim(), improved: "Delivered File Exchange, secure UI-driven file upload/download beyond B2B APIs, adopted by 30+ partners processing 8,600+ files/day." }] });
  assert.match(out, /Delivered File Exchange/);
  assert.doesNotMatch(out, /secure UI - driven file upload\/download\. It was adopted/, "no leftover tail of the old bullet");
  assert.doesNotMatch(out, /^8,600\+ files\/day\.$/m);
});

test("the extension and the server join bullets the same way", async () => {
  const { reflowBullets } = await load();
  const server = await import(pathToFileURL(path.join(__dirname, "..", "backend", "lib", "tailor.js")).href);
  assert.equal(server.reflowBullets(WRAPPED), reflowBullets(WRAPPED));
});
