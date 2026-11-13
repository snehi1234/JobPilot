// Generates Chrome Web Store screenshots and landing-page images from the real
// extension UI. Not part of the normal suite: run with STORE_SHOTS=1.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect, profile } = require("./extension.cjs");

test.skip(!process.env.STORE_SHOTS, "Set STORE_SHOTS=1 to regenerate store screenshots.");
test.setTimeout(240000);

const OUT = path.join(__dirname, "..", "..", "store-assets");
const RAW = path.join(OUT, "raw");
const WEB = path.join(__dirname, "..", "..", "backend", "public", "img");
const BACKEND = "https://backend-alpha-seven-87.vercel.app";
const POSTING = "https://job-boards.greenhouse.io/northwindlabs/jobs/42";

const RESUME = `Alex Example
alex@example.com | +1 202-555-0142 | linkedin.com/in/example | Seattle, WA

Summary
Software engineer with four years of experience building backend platforms, cloud infrastructure, and developer tooling. I enjoy turning slow, manual workflows into reliable self-service systems, and I care about clear APIs, strong testing, and calm on-call rotations.

Experience
Software Engineer, Example Inc — Sep 2022 – Present
• Built Python and Go microservices on Kubernetes serving 2M requests a day.
• Designed REST APIs and PostgreSQL data models for the billing platform.
• Automated deployments with Terraform and GitHub Actions, cutting release time 60%.
• Added Redis caching and observability dashboards, reducing p99 latency 35%.
• Led migration of 14 services from VMs to containers with zero customer downtime.
• Mentored 3 engineers and ran weekly design reviews for the platform team.

Backend Engineer Intern, Sample Systems — May 2021 – Aug 2021
• Developed Java Spring Boot APIs for order tracking used by 40 warehouse sites.
• Wrote integration tests that raised coverage from 52% to 85%.
• Built an internal CLI that automated environment setup, saving 5 hours a week.

Projects
Open-source job queue (Go): Lightweight distributed task queue with retries, rate limiting, and metrics; 300+ GitHub stars.
Cost dashboard (Python): Daily AWS cost reports per team using Lambda and PostgreSQL, saving $8K a month.

Education
Master of Science, Computer Science — Example University, 2022

Skills
Python, Go, Java, Kubernetes, Docker, AWS, Terraform, PostgreSQL, Redis, REST APIs, CI/CD`;
const DATA_RESUME = "Data Analyst. SQL, Tableau, Excel, dashboards, A/B testing, Python, statistics.";

const POSTING_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Northwind Labs — Senior Software Engineer, Platform</title>
<style>body{margin:0;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937;background:#fff}
header{display:flex;align-items:center;gap:12px;padding:16px 40px;border-bottom:1px solid #e5e7eb;font-weight:800;font-size:20px}
header span{width:30px;height:30px;border-radius:8px;background:#0f766e;display:inline-block}
main{max-width:820px;margin:0 auto;padding:36px 40px}h1{font-size:34px;margin:0 0 6px}.meta{color:#6b7280;margin-bottom:22px}
.apply{display:inline-block;background:#0f766e;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;margin-bottom:26px}
h2{font-size:20px;margin:24px 0 6px}ul{padding-left:22px}</style></head><body>
<header><span></span>Northwind Labs</header><main>
<h1>Senior Software Engineer, Platform</h1><div class="meta">Seattle, WA or Remote · Full-time · Engineering</div>
<a class="apply" href="/jobs/42/apply">Apply for this job</a>
<div class="job-description"><h2>About the role</h2><p>Our Platform team owns the services, APIs, and developer tooling every product team builds on.</p>
<h2>What you'll do</h2><ul><li>Build reliable backend services and REST APIs in Python and Go.</li>
<li>Run services on Kubernetes and Docker in AWS with Terraform and CI/CD.</li>
<li>Improve observability and performance of distributed systems.</li>
<li>Own data models in PostgreSQL and Redis; partner on Kafka streaming.</li></ul>
<h2>What we're looking for</h2><ul><li>4+ years building production software.</li><li>Microservices, cloud platforms, SQL, automated testing.</li><li>Bonus: Rust or GraphQL experience.</li></ul></div>
</main></body></html>`;

async function seed(app) {
  await app.worker.evaluate(async ({ details, resume, data }) => {
    const pdf = btoa("%PDF-1.4 synthetic");
    await chrome.storage.local.set({
      structured: { ...details, workAuth: "Yes", sponsorship: "No", salaryRole1: "Software Engineer", salaryAmount1: "$165,000",
        noticePeriod: "2 weeks", startAvailability: "2 weeks after offer", relocation: "Yes", workArrangement: "Open to any", clearance: "None", over18: "Yes", defaultSource: "LinkedIn" },
      uploadedResumeText: resume,
      resumes: [
        { id: "sw", name: "Software Engineer", text: resume, fileName: "Alex_Example_SWE.pdf", layout: { pages: 1, splitRowRatio: 0 } },
        { id: "da", name: "Data Analyst", text: data, fileName: "Alex_Example_Data.pdf" },
      ],
      defaultResumeId: "sw",
      resumeFiles: { sw: { name: "Alex_Example_SWE.pdf", type: "application/pdf", data: pdf }, da: { name: "Alex_Example_Data.pdf", type: "application/pdf", data: pdf } },
      onboardingHidden: true,
      ratingState: { never: true },
    });
  }, { details: profile, resume: RESUME, data: DATA_RESUME });
}

async function frame(app, { file, title, sub, image, layout }) {
  const page = await app.context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  const src = `data:image/png;base64,${fs.readFileSync(image).toString("base64")}`;
  const wide = layout === "wide";
  await page.setContent(`<!doctype html><html><body style="margin:0">
  <div style="width:1280px;height:800px;overflow:hidden;position:relative;font-family:-apple-system,Segoe UI,Roboto,sans-serif;
    background:radial-gradient(900px 500px at 85% 0%,#ede9fe 0%,transparent 60%),linear-gradient(160deg,#f8f7ff,#eef2ff);">
    ${wide ? `
      <div style="position:absolute;left:0;right:0;top:44px;text-align:center">
        <div style="font-size:44px;font-weight:800;color:#14142b;letter-spacing:-.02em">${title}</div>
        <div style="font-size:21px;color:#4b5563;margin-top:8px">${sub}</div>
      </div>
      <img src="${src}" style="position:absolute;left:110px;top:186px;width:1060px;border-radius:14px 14px 0 0;box-shadow:0 20px 60px rgba(20,20,43,.25);border:1px solid #e5e7eb">`
    : `
      <div style="position:absolute;left:80px;top:0;bottom:0;width:520px;display:flex;flex-direction:column;justify-content:center">
        <div style="display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px;color:#4a3aff;margin-bottom:18px">⚡ Hiresprint</div>
        <div style="font-size:50px;line-height:1.08;font-weight:800;color:#14142b;letter-spacing:-.02em">${title}</div>
        <div style="font-size:22px;line-height:1.45;color:#4b5563;margin-top:18px">${sub}</div>
      </div>
      <div style="position:absolute;right:70px;top:40px;bottom:40px;width:560px;display:flex;align-items:center;justify-content:center">
        <img src="${src}" style="max-height:720px;max-width:560px;border-radius:16px;box-shadow:0 20px 60px rgba(20,20,43,.25);border:1px solid #e5e7eb;background:#fff">
      </div>`}
  </div></body></html>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, file) });
  await page.close();
}

test("store screenshots", async ({ app }) => {
  fs.mkdirSync(RAW, { recursive: true });
  fs.mkdirSync(WEB, { recursive: true });
  await seed(app);
  app.api.suggestions = (fields) => fields.flatMap((field) => {
    const label = field.label.toLowerCase();
    const say = (value) => [{ id: field.id, label: field.label, value, confidence: "high" }];
    if (/why do you want/.test(label)) return say("I love building the platforms other engineers depend on. At Example Inc I built Python and Go microservices on Kubernetes and cut release time 60% with Terraform pipelines — I'd love to bring that to Northwind's Platform team.");
    if (/authorized/.test(label)) return say("Yes");
    if (/sponsorship/.test(label)) return say("No");
    if (/hear about/.test(label)) return say("LinkedIn");
    if (/current company/.test(label)) return say("Example Inc");
    if (/linkedin/.test(label)) return say(profile.linkedin);
    if (/website|github/.test(label)) return say("https://github.com/example");
    if (/location/.test(label)) return say("Seattle, WA");
    return [];
  });
  await app.context.route(`${BACKEND}/api/tailor`, (route) => route.fulfill({ json: {
    summary: "Platform engineer who builds Python and Go microservices on Kubernetes and AWS.",
    bullets: [
      { original: "• Built Python and Go microservices on Kubernetes serving 2M requests a day.", line: "• Built Python and Go microservices on Kubernetes serving 2M requests a day.",
        improved: "• Built and operated Python and Go microservices and REST APIs on Kubernetes and Docker, serving 2M requests a day.", keywords: ["REST APIs", "Docker"] },
      { original: "• Designed REST APIs and PostgreSQL data models for the billing platform.", line: "• Designed REST APIs and PostgreSQL data models for the billing platform.",
        improved: "• Designed REST APIs and SQL data models (PostgreSQL) for the distributed billing platform.", keywords: ["SQL", "distributed systems"] },
      { original: "• Added Redis caching and observability dashboards, reducing p99 latency 35%.", line: "• Added Redis caching and observability dashboards, reducing p99 latency 35%.",
        improved: "• Improved performance of distributed systems with Redis caching and observability dashboards, reducing p99 latency 35%.", keywords: ["distributed systems", "observability"] },
    ],
    skills: ["Kafka"], gaps: ["Rust", "GraphQL"],
  } }));
  await app.context.route("https://job-boards.greenhouse.io/**", (route) => route.fulfill({ status: 404, body: "Not found" }));
  await app.context.route(POSTING, (route) => route.fulfill({ contentType: "text/html", body: POSTING_PAGE }));

  // 1. Autofill on the practice application.
  const form = await app.context.newPage();
  await form.setViewportSize({ width: 1280, height: 800 });
  await form.goto(`${BACKEND}/practice.html`);
  await expect(form.locator("#jobpilot-fab")).toBeVisible({ timeout: 15000 });
  await expect(async () => {
    await form.locator("#jobpilot-fab").getByRole("button", { name: /autofill/i }).click({ timeout: 2000 });
    await expect(form.locator("#jobpilot-toast")).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  await expect(form.locator("#why")).not.toHaveValue("", { timeout: 15000 });
  await expect(form.locator("#jobpilot-checklist")).toBeAttached({ timeout: 15000 });
  await form.waitForTimeout(2500);
  await form.locator("#jobpilot-toast").evaluate((t) => t.remove()).catch(() => {});
  await form.evaluate(() => { document.querySelector(".banner")?.remove(); document.getElementById("jobpilot-fab")?.remove(); });
  await form.locator("#application").evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 20));
  await form.waitForTimeout(500);
  await form.screenshot({ path: path.join(RAW, "autofill.png") });

  // 2. Match badge on a company job posting.
  const post = await app.context.newPage();
  await post.setViewportSize({ width: 1280, height: 800 });
  await post.goto(POSTING);
  const badge = post.locator("#hiresprint-match");
  await expect(badge).toBeAttached({ timeout: 15000 });
  await badge.evaluate((host) => host.shadowRoot.querySelector(".pill").click());
  await post.evaluate(() => document.getElementById("jobpilot-fab")?.remove());
  await post.waitForTimeout(800);
  await post.screenshot({ path: path.join(RAW, "match.png") });

  // 3. Tailor in the side panel for that posting (zoomed for a sharp image).
  const { panel } = app;
  await panel.setViewportSize({ width: 630, height: 1500 });
  await panel.reload();
  await panel.evaluate(() => { document.body.style.zoom = "1.5"; });
  await post.bringToFront();
  await expect(panel.locator("#matchCard")).toBeVisible({ timeout: 15000 });
  await panel.locator("#tailorBtn").click();
  await expect(panel.locator(".tailor-item").first()).toBeVisible({ timeout: 15000 });
  await expect(panel.locator(".tailor-score")).toContainText(/→/);
  await panel.waitForTimeout(500);
  await panel.locator("#matchCard").screenshot({ path: path.join(RAW, "tailor.png") });

  // 4. ATS check.
  await panel.locator("#resumeList .resume-row").first().getByRole("button", { name: "ATS check" }).click();
  await expect(panel.locator(".ats-report")).toBeVisible();
  await panel.waitForTimeout(400);
  await panel.locator("#resumeList").evaluate((el) => el.closest("section").scrollIntoView({ block: "start" }));
  await panel.locator("#resumeList").screenshot({ path: path.join(RAW, "ats.png") });

  // 5. Answer Studio.
  await panel.locator("#answerStudio").evaluate((el) => el.querySelectorAll("details").forEach((d) => (d.open = true)));
  await panel.waitForTimeout(400);
  await panel.locator("#answerStudio").screenshot({ path: path.join(RAW, "studio.png") });

  const shots = [
    { file: "hiresprint-1-autofill-1280x800.png", image: "autofill.png", layout: "wide",
      title: "Fill job applications in one click", sub: "Profile answers in green, AI answers to review in blue — you always submit yourself." },
    { file: "hiresprint-2-match-1280x800.png", image: "match.png", layout: "wide",
      title: "See your match on every job posting", sub: "Scores each of your resumes against the job, with matched and missing skills." },
    { file: "hiresprint-3-tailor-1280x800.png", image: "tailor.png",
      title: "Tailor your resume to the job", sub: "Rewrites your own bullets in the job's language — never invents experience. Accept each change, then attach it." },
    { file: "hiresprint-4-ats-1280x800.png", image: "ats.png",
      title: "Pass the ATS check", sub: "See how applicant tracking systems read your resume, and exactly what to fix." },
    { file: "hiresprint-5-studio-1280x800.png", image: "studio.png",
      title: "Answer once, reuse everywhere", sub: "Salary by role, notice period, relocation, and more — filled the same way on every application." },
  ];
  for (const s of shots) await frame(app, { ...s, image: path.join(RAW, s.image) });

  fs.copyFileSync(path.join(RAW, "autofill.png"), path.join(WEB, "shot-autofill.png"));
  fs.copyFileSync(path.join(RAW, "match.png"), path.join(WEB, "shot-match.png"));
  fs.copyFileSync(path.join(OUT, "hiresprint-3-tailor-1280x800.png"), path.join(WEB, "shot-tailor.png"));

  // Promo tiles and the social preview image.
  const icon = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, "..", "..", "icons", "icon128.png")).toString("base64")}`;
  const tile = async (file, w, h, big, shot) => {
    const page = await app.context.newPage();
    await page.setViewportSize({ width: w, height: h });
    const shotSrc = shot ? `data:image/png;base64,${fs.readFileSync(shot).toString("base64")}` : "";
    await page.setContent(`<!doctype html><body style="margin:0"><div style="width:${w}px;height:${h}px;display:flex;align-items:center;gap:${big ? 40 : 18}px;position:relative;overflow:hidden;
      padding:0 ${big ? 90 : 30}px;box-sizing:border-box;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#fff;
      background:radial-gradient(${w}px ${h}px at 90% 0%,#7c3aed 0%,transparent 60%),linear-gradient(135deg,#1e1b4b,#4a3aff)">
      ${shotSrc ? `<img src="${shotSrc}" style="position:absolute;right:-60px;top:70px;width:720px;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.45);transform:rotate(-4deg)">` : ""}
      <img src="${icon}" style="width:${big ? 150 : 84}px;height:${big ? 150 : 84}px;border-radius:${big ? 32 : 18}px;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.3)">
      <div><div style="font-size:${big ? 64 : 38}px;font-weight:800;letter-spacing:-.02em">Hiresprint</div>
      <div style="font-size:${big ? 30 : 17}px;color:#ddd6fe;margin-top:${big ? 10 : 4}px;line-height:1.3">${big ? "AI job application autofill,<br>resume match &amp; tailoring" : "Apply to jobs in minutes"}</div></div>
    </div></body>`);
    await page.screenshot({ path: file });
    await page.close();
  };
  await tile(path.join(OUT, "hiresprint-promo-small-440x280.png"), 440, 280, false);
  await tile(path.join(OUT, "hiresprint-promo-marquee-1400x560.png"), 1400, 560, true, path.join(RAW, "autofill.png"));
  await tile(path.join(WEB, "og.png"), 1200, 630, true, path.join(RAW, "autofill.png"));
});
