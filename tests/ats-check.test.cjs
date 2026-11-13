const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "lib", "ats-check.mjs")).href);

const GOOD = `Alex Example
alex@example.com | +1 (202) 555-0142 | linkedin.com/in/alex-example | Seattle, WA

Experience
Senior Software Engineer, Example Corp — Jan 2021 – Present
• Built a payments ledger in Java and Kafka handling 2M events/day with 99.99% uptime
• Reduced p99 latency by 45% by redesigning the caching layer with Redis
• Led a team of 4 engineers to ship the partner onboarding API used by 300+ partners
• Designed CI/CD pipelines that cut release time from 2 days to 3 hours
Software Engineer, Startup Inc — Jun 2018 – Dec 2020
• Developed REST APIs in Python serving 5,000 requests per second
• Migrated 40 services to Kubernetes, saving $120K per year in infrastructure

Education
M.S. Computer Science, Example University, 2018

Skills
Java, Python, Kafka, Kubernetes, PostgreSQL, Redis, AWS
` + " Additional detail on projects, mentoring, design reviews, and on-call ownership across teams.".repeat(20);

test("a clean, quantified resume scores well", async () => {
  const { analyzeResume } = await load();
  const { score, checks } = analyzeResume(GOOD, { fileName: "Alex_Example_Resume.pdf", layout: { pages: 1, splitRowRatio: 0.05 } });
  const by = Object.fromEntries(checks.map((c) => [c.id, c.status]));
  assert.equal(JSON.stringify(by), JSON.stringify({
    readable: "pass", layout: "pass", contact: "pass", sections: "pass", dates: "pass", length: "pass", impact: "pass", verbs: "pass", filename: "pass",
  }));
  assert.equal(score, 100);
});

test("common ATS problems are flagged with fixes", async () => {
  const { analyzeResume } = await load();
  const weak = `Alex Example
Profile
• Responsible for maintaining the backend services for the team
• Worked on various features across the product with other engineers
• Helped with testing and deployment of new releases to production
• Participated in code reviews and design discussions with the team
` + " Some more general text about interests and goals.".repeat(15);
  const { score, checks } = analyzeResume(weak, { fileName: "resume.pdf", layout: { pages: 1, splitRowRatio: 0.6 } });
  const by = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.equal(by.layout.status, "warn");
  assert.equal(by.contact.status, "fail");
  assert.match(by.contact.title, /email, phone, LinkedIn URL/);
  assert.equal(by.sections.status, "fail");
  assert.equal(by.dates.status, "warn");
  assert.equal(by.impact.status, "warn");
  assert.equal(by.verbs.status, "warn");
  assert.match(by.verbs.detail, /Responsible for/);
  assert.equal(by.filename.status, "warn");
  assert.ok(score < 60, String(score));
});

test("scanned or symbol-heavy resumes are caught", async () => {
  const { analyzeResume } = await load();
  assert.equal(analyzeResume("Scan").checks[0].status, "fail");
  const symbols = GOOD + "\uF0B7\uF0B7\uF0B7\uF0B7\uF0B7\uF0B7\uFFFD";
  assert.equal(analyzeResume(symbols).checks.find((c) => c.id === "readable").status, "warn");
  const noLayout = analyzeResume(GOOD, {});
  assert.equal(noLayout.checks.some((c) => c.id === "layout" || c.id === "filename"), false, "unknown facts are skipped, not guessed");
});

test("real-world formats: spaced phone numbers and inline or named skills sections", async () => {
  const { analyzeResume } = await load();
  const spaced = GOOD.replace("+1 (202) 555-0142", "+1   (425) 310 - 5258").replace("\nSkills\n", "\nTechnical Skills & Tools: ");
  const by = Object.fromEntries(analyzeResume(spaced).checks.map((c) => [c.id, c.status]));
  assert.equal(by.contact, "pass");
  assert.equal(by.sections, "pass");
  const expertise = GOOD.replace("\nSkills\n", "\nTechnical Expertise\n");
  assert.equal(analyzeResume(expertise).checks.find((c) => c.id === "sections").status, "pass");
  const bulletOnly = GOOD.replace("\nSkills\n", "\n• Built skills in public speaking\n");
  assert.equal(analyzeResume(bulletOnly).checks.find((c) => c.id === "sections").status, "warn", "a bullet mentioning skills isn't a heading");
});
