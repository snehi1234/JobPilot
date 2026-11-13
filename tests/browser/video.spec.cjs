// Records the Chrome Web Store demo video from the real extension UI.
// Not part of the normal suite. Run via tests/browser/make-video.cjs.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect, profile } = require("./extension.cjs");

test.skip(!process.env.JOBPILOT_RECORD_DIR, "Run tests/browser/make-video.cjs to record the demo video.");
test.setTimeout(300000);

const BACKEND = "https://backend-alpha-seven-87.vercel.app";
const POSTING = "https://job-boards.greenhouse.io/northwindlabs/jobs/42";
const OUT = process.env.JOBPILOT_RECORD_DIR;

const RESUME_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:11pt Helvetica,Arial,sans-serif;margin:40px 50px;color:#111}h1{margin:0;font-size:22pt}h2{font-size:12pt;border-bottom:1px solid #999;margin:16px 0 6px}
p{margin:3px 0}ul{margin:3px 0 6px 18px;padding:0}li{margin:2px 0}</style></head><body>
<h1>Alex Example</h1><p>alex@example.com | +1 202-555-0142 | linkedin.com/in/example | Seattle, WA</p>
<h2>Summary</h2><p>Software engineer with four years of experience building backend platforms, cloud infrastructure, and developer tooling.</p>
<h2>Experience</h2><p><b>Software Engineer, Example Inc</b> — Sep 2022 – Present</p><ul>
<li>Built Python and Go microservices on Kubernetes serving 2M requests a day.</li>
<li>Designed REST APIs and PostgreSQL data models for the billing platform.</li>
<li>Automated deployments with Terraform and GitHub Actions, cutting release time 60%.</li>
<li>Added Redis caching and observability dashboards, reducing p99 latency 35%.</li></ul>
<p><b>Backend Engineer Intern, Sample Systems</b> — May 2021 – Aug 2021</p><ul>
<li>Developed Java Spring Boot APIs for order tracking used by 40 warehouse sites.</li>
<li>Wrote integration tests that raised coverage from 52% to 85%.</li></ul>
<h2>Education</h2><p>Master of Science, Computer Science — Example University, 2022</p>
<h2>Skills</h2><p>Python, Go, Java, Kubernetes, Docker, AWS, Terraform, PostgreSQL, Redis, REST APIs, CI/CD</p>
</body></html>`;

const POSTING_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Northwind Labs — Senior Software Engineer, Platform</title>
<style>body{margin:0;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937;background:#fff}
header{display:flex;align-items:center;gap:12px;padding:16px 40px;border-bottom:1px solid #e5e7eb;font-weight:800;font-size:20px}
header span{width:30px;height:30px;border-radius:8px;background:#0f766e;display:inline-block}
main{max-width:760px;margin:0 0 0 80px;padding:30px 40px}h1{font-size:32px;margin:0 0 6px}.meta{color:#6b7280;margin-bottom:18px}
.apply{display:inline-block;background:#0f766e;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;margin-bottom:20px}
h2{font-size:19px;margin:20px 0 6px}ul{padding-left:22px}</style></head><body>
<header><span></span>Northwind Labs</header><main>
<h1>Senior Software Engineer, Platform</h1><div class="meta">Seattle, WA or Remote · Full-time · Engineering</div>
<a class="apply" href="#">Apply for this job</a>
<div class="job-description"><h2>About the role</h2><p>Our Platform team owns the services, APIs, and developer tooling every product team builds on.</p>
<h2>What you'll do</h2><ul><li>Build reliable backend services and REST APIs in Python and Go.</li>
<li>Run services on Kubernetes and Docker in AWS with Terraform and CI/CD.</li>
<li>Improve observability and performance of distributed systems.</li>
<li>Own data models in PostgreSQL and Redis; partner on Kafka streaming.</li></ul>
<h2>What we're looking for</h2><ul><li>4+ years building production software.</li><li>Microservices, cloud platforms, SQL, automated testing.</li><li>Bonus: Rust or GraphQL experience.</li></ul></div>
</main></body></html>`;

const COVER_LETTER = `Dear Northwind Labs Hiring Team,

I'm excited to apply for the Software Engineer, Platform role. At Example Inc I build Python and Go microservices on Kubernetes that serve 2M requests a day, and I automated our deployments with Terraform and GitHub Actions, cutting release time by 60%.

Your Platform team's focus on reliable services and great developer tooling is exactly the work I enjoy most. I'd love to bring my experience with REST APIs, PostgreSQL, and observability to help every Northwind team ship faster.

Thank you for your consideration,
Alex Example`;

// ---------- Overlays: captions, a visible cursor, and the panel stage ----------

async function overlay(page) {
  await page.evaluate(() => {
    if (document.getElementById("__vid_cursor")) return;
    const style = document.createElement("style");
    style.textContent = `
      #__vid_cursor{position:fixed;left:640px;top:600px;width:26px;height:26px;z-index:2147483647;pointer-events:none;
        transition:left .7s cubic-bezier(.4,0,.2,1),top .7s cubic-bezier(.4,0,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
      #__vid_cursor.click::after{content:"";position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;
        background:rgba(74,58,255,.35);animation:__vid_ping .45s ease-out}
      @keyframes __vid_ping{from{transform:scale(.3);opacity:1}to{transform:scale(1.6);opacity:0}}
      #__vid_caption{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);opacity:0;z-index:2147483646;pointer-events:none;
        background:rgba(20,20,43,.92);color:#fff;font:600 24px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;padding:14px 26px;border-radius:14px;
        box-shadow:0 10px 30px rgba(0,0,0,.3);transition:all .4s ease;max-width:1100px;text-align:center;white-space:nowrap}
      #__vid_caption.on{opacity:1;transform:translateX(-50%) translateY(0)}
      #__vid_caption small{display:block;font-weight:400;font-size:17px;color:#c7d2fe;margin-top:2px}`;
    document.documentElement.appendChild(style);
    const cursor = document.createElement("div");
    cursor.id = "__vid_cursor";
    cursor.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2l16 9-7 2-3 7z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(cursor);
    const cap = document.createElement("div");
    cap.id = "__vid_caption";
    document.documentElement.appendChild(cap);
  });
}

async function caption(page, title, sub = "") {
  await overlay(page);
  await page.evaluate(({ title, sub }) => {
    const cap = document.getElementById("__vid_caption");
    cap.classList.remove("on");
    setTimeout(() => {
      cap.innerHTML = "";
      cap.append(title);
      if (sub) { const s = document.createElement("small"); s.textContent = sub; cap.append(s); }
      cap.classList.add("on");
    }, 250);
  }, { title, sub });
  await page.waitForTimeout(500);
}

async function moveTo(page, locator) {
  await overlay(page);
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) return;
  await page.evaluate(({ x, y }) => {
    const c = document.getElementById("__vid_cursor");
    c.style.left = `${x}px`;
    c.style.top = `${y}px`;
  }, { x: box.x + Math.min(box.width / 2, 40), y: box.y + box.height / 2 });
  await page.waitForTimeout(800);
}

async function clickLike(page, locator) {
  await moveTo(page, locator);
  await page.evaluate(() => {
    const c = document.getElementById("__vid_cursor");
    c.classList.remove("click");
    void c.offsetWidth;
    c.classList.add("click");
  });
  await page.waitForTimeout(150);
  await locator.click();
}

async function smoothScroll(page, y, ms = 1500) {
  await page.evaluate(async ({ y, ms }) => {
    const start = window.scrollY;
    const t0 = performance.now();
    await new Promise((done) => {
      const step = (now) => {
        const k = Math.min(1, (now - t0) / ms);
        window.scrollTo(0, start + (y - start) * (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2));
        if (k < 1) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    });
  }, { y, ms });
}

// Shows the side panel like it sits in Chrome: docked right, with a caption on the left.
async function stagePanel(panel) {
  await panel.evaluate(() => {
    const s = document.createElement("style");
    s.textContent = `html{background:radial-gradient(900px 500px at 20% 0%,#ede9fe 0%,transparent 60%),linear-gradient(160deg,#f8f7ff,#eef2ff)!important;min-height:100%}
      body{zoom:1.3;width:420px;margin:0 50px 0 auto!important;box-shadow:-10px 0 40px rgba(20,20,43,.15);min-height:100vh}
      #__vid_caption{left:330px!important;bottom:auto!important;top:300px!important;white-space:normal!important;width:520px;text-align:left!important;
        background:none!important;box-shadow:none!important;color:#14142b!important;font-size:40px!important;line-height:1.12!important;font-weight:800!important;padding:0!important}
      #__vid_caption small{color:#4b5563!important;font-size:21px!important;font-weight:400!important;margin-top:14px!important;line-height:1.4}
      #__vid_brand{position:fixed;left:70px;top:240px;font:800 22px -apple-system,Segoe UI,Roboto,sans-serif;color:#4a3aff}`;
    document.documentElement.appendChild(s);
    const b = document.createElement("div");
    b.id = "__vid_brand";
    b.textContent = "⚡ Hiresprint";
    document.documentElement.appendChild(b);
  });
  await overlay(panel);
}

async function card(app, html, ms, scenes) {
  const page = await app.context.newPage();
  const created = Date.now();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0">
    <div style="width:1280px;height:720px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;
      font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#fff;background:radial-gradient(1200px 600px at 85% 0%,#7c3aed 0%,transparent 60%),linear-gradient(135deg,#1e1b4b,#4a3aff)">
      <div style="animation:in .8s ease both">${html}</div></div>
    <style>@keyframes in{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}</style></body>`);
  const start = (Date.now() - created) / 1000 + 0.2;
  await page.waitForTimeout(ms);
  scenes.push({ video: await page.video().path(), start, end: (Date.now() - created) / 1000 });
  await page.close();
}

test("demo video", async ({ app }) => {
  const scenes = [];
  const icon = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, "..", "..", "icons", "icon128.png")).toString("base64")}`;
  const { context, worker } = app;

  app.api.suggestions = (fields) => fields.flatMap((field) => {
    const label = field.label.toLowerCase();
    const say = (value) => [{ id: field.id, label: field.label, value, confidence: "high" }];
    if (/why do you want/.test(label)) return say("I love building the platforms other engineers depend on. At Example Inc I built Python and Go microservices on Kubernetes and cut release time 60% with Terraform — I'd love to bring that to Northwind's Platform team.");
    if (/authorized/.test(label)) return say("Yes");
    if (/hear about/.test(label)) return say("LinkedIn");
    if (/current company/.test(label)) return say("Example Inc");
    if (/website|github/.test(label)) return say("https://github.com/example");
    if (/location/.test(label)) return say("Seattle, WA");
    return [];
  });
  await context.route(`${BACKEND}/api/cover-letter`, (route) => route.fulfill({ json: { letter: COVER_LETTER } }));
  await context.route(`${BACKEND}/api/tailor`, (route) => route.fulfill({ json: {
    summary: "Platform engineer who builds Python and Go microservices on Kubernetes and AWS.",
    bullets: [
      { original: "Built Python and Go microservices on Kubernetes serving 2M requests a day.", line: "Built Python and Go microservices on Kubernetes serving 2M requests a day.",
        improved: "Built and operated Python and Go microservices and REST APIs on Kubernetes and Docker, serving 2M requests a day.", keywords: ["REST APIs", "Docker"] },
      { original: "Designed REST APIs and PostgreSQL data models for the billing platform.", line: "Designed REST APIs and PostgreSQL data models for the billing platform.",
        improved: "Designed REST APIs and SQL data models (PostgreSQL) for the distributed billing platform.", keywords: ["SQL", "distributed systems"] },
      { original: "Added Redis caching and observability dashboards, reducing p99 latency 35%.", line: "Added Redis caching and observability dashboards, reducing p99 latency 35%.",
        improved: "Improved performance of distributed systems with Redis caching and observability dashboards, reducing p99 latency 35%.", keywords: ["distributed systems"] },
    ],
    skills: ["Kafka"], gaps: ["Rust", "GraphQL"],
  } }));
  await context.route("https://job-boards.greenhouse.io/**", (route) => route.fulfill({ status: 404, body: "Not found" }));
  await context.route(POSTING, (route) => route.fulfill({ contentType: "text/html", body: POSTING_PAGE }));

  // A real PDF resume to upload.
  const maker = await context.newPage();
  await maker.setContent(RESUME_HTML);
  const pdfPath = path.join(OUT, "Alex_Example_Resume.pdf");
  fs.writeFileSync(pdfPath, await maker.pdf({ format: "Letter" }));
  await maker.close();

  await worker.evaluate(async () => {
    await chrome.storage.local.remove(["resumes", "uploadedResumeText", "resumeFiles", "defaultResumeId", "onboardingHidden"]);
    await chrome.storage.local.set({ structured: {}, coverLetterMode: "ai", ratingState: { never: true } });
  });

  // ---- Intro ----
  await card(app, `<img src="${icon}" style="width:120px;height:120px;border-radius:26px;background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.35)">
    <div style="font-size:64px;font-weight:800;margin-top:22px;letter-spacing:-.02em">Hiresprint</div>
    <div style="font-size:28px;color:#ddd6fe;margin-top:8px">Apply to jobs in minutes, not hours.</div>`, 3200, scenes);

  // ---- 1. Setup: upload a resume ----
  const panel = await context.newPage();
  const panelCreated = Date.now();
  const pt = () => (Date.now() - panelCreated) / 1000;
  await panel.setViewportSize({ width: 1280, height: 720 });
  await panel.goto(`chrome-extension://${app.id}/sidepanel.html`);
  await expect(panel.locator("#appContent")).toBeVisible();
  await panel.waitForTimeout(1200);
  await stagePanel(panel);
  let s = pt();
  await caption(panel, "Set up once in 2 minutes", "Upload your resume — your details fill in automatically.");
  await panel.waitForTimeout(1500);
  await moveTo(panel, panel.locator("label[for='resumeFile'], #resumeFile").first());
  await panel.locator("#resumeFile").setInputFiles(pdfPath);
  await expect(panel.locator("#resumeList .resume-row")).toHaveCount(1, { timeout: 20000 });
  await panel.waitForTimeout(800);
  await panel.locator("#sf_firstName").evaluate((el) => el.scrollIntoView({ block: "center", behavior: "smooth" }));
  await expect(panel.locator("#sf_firstName")).toHaveValue(profile.firstName, { timeout: 15000 });
  await panel.waitForTimeout(2600);
  await panel.locator("#startCard").evaluate((el) => el.scrollIntoView({ block: "start", behavior: "smooth" })).catch(() => {});
  await panel.waitForTimeout(1800);
  scenes.push({ video: await panel.video().path(), start: s, end: pt() });

  // A second resume, so matching can pick between them.
  await worker.evaluate(async () => {
    const { resumes = [] } = await chrome.storage.local.get("resumes");
    resumes.push({ id: "da", name: "Data Analyst", text: "Data Analyst. SQL, Tableau, Excel, dashboards, A/B testing, statistics.", fileName: "Alex_Example_Data.pdf" });
    await chrome.storage.local.set({ resumes });
  });

  // ---- 2. Match badge on a job posting ----
  const post = await context.newPage();
  const postCreated = Date.now();
  await post.setViewportSize({ width: 1280, height: 720 });
  await post.goto(POSTING);
  const badge = post.locator("#hiresprint-match");
  await expect(badge).toBeAttached({ timeout: 15000 });
  await post.evaluate(() => document.getElementById("jobpilot-fab")?.remove());
  s = (Date.now() - postCreated) / 1000;
  await caption(post, "See your match on every job posting", "LinkedIn, Indeed, Glassdoor, Workday, and company career pages");
  await post.waitForTimeout(1400);
  const pill = badge.locator(".pill");
  await clickLike(post, pill);
  await post.waitForTimeout(3600);
  await moveTo(post, badge.locator("button").filter({ hasText: /Tailor/ }));
  await post.waitForTimeout(1200);
  scenes.push({ video: await post.video().path(), start: s, end: (Date.now() - postCreated) / 1000 });

  // ---- 3. Tailor the resume ----
  await post.bringToFront();
  await panel.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(panel.locator("#matchCard")).toBeVisible({ timeout: 15000 });
  await panel.locator("#matchCard").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await panel.waitForTimeout(600);
  s = pt();
  await caption(panel, "Tailor your resume to the job", "Rewrites your own bullets in the job's words. Never invents experience.");
  await panel.waitForTimeout(1600);
  await clickLike(panel, panel.locator("#tailorBtn"));
  await expect(panel.locator(".tailor-item").first()).toBeVisible({ timeout: 15000 });
  await panel.waitForTimeout(1800);
  await panel.evaluate(() => document.querySelector(".tailor-score")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  await panel.waitForTimeout(3200);
  const use = panel.getByRole("button", { name: "Use for this application" });
  await use.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "smooth" }));
  await panel.waitForTimeout(900);
  await clickLike(panel, use);
  await panel.waitForTimeout(1800);
  scenes.push({ video: await panel.video().path(), start: s, end: pt() });

  // ---- 4. Autofill an application, with a cover letter ----
  const form = await context.newPage();
  const formCreated = Date.now();
  const ft = () => (Date.now() - formCreated) / 1000;
  await form.setViewportSize({ width: 1280, height: 720 });
  await form.goto(`${BACKEND}/practice.html`);
  await expect(form.locator("#jobpilot-fab")).toBeVisible({ timeout: 15000 });
  await form.evaluate(() => document.querySelector(".banner")?.remove());
  await form.locator("#application").evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 10));
  await form.waitForTimeout(800);
  s = ft();
  await caption(form, "One click fills the whole application", "Contact details, work history, dropdowns, and screening questions");
  await form.waitForTimeout(1500);
  const fab = form.locator("#jobpilot-fab").getByRole("button", { name: /autofill/i });
  await clickLike(form, fab);
  await expect(form.locator("#first_name")).toHaveValue(profile.firstName, { timeout: 15000 });
  await expect(form.locator("#why")).not.toHaveValue("", { timeout: 15000 });
  await form.waitForTimeout(1800);
  await caption(form, "Green from your profile, blue AI answers to review", "Your best-matching resume is attached automatically");
  await smoothScroll(form, await form.locator("#authorized").evaluate((el) => el.getBoundingClientRect().top + window.scrollY - 200), 2200);
  await form.waitForTimeout(1600);
  await expect(form.locator("#cover_letter")).not.toHaveValue("", { timeout: 20000 });
  await caption(form, "A cover letter written for this job", "AI-written per job, or your own file — pasted or attached as a PDF");
  await smoothScroll(form, await form.locator("#cover_letter").evaluate((el) => el.getBoundingClientRect().top + window.scrollY - 160), 2000);
  await form.waitForTimeout(3200);
  await caption(form, "Review the checklist, then submit it yourself", "Undo everything in one click. Hiresprint never submits for you.");
  await moveTo(form, form.locator("#jobpilot-checklist"));
  await form.waitForTimeout(3200);
  scenes.push({ video: await form.video().path(), start: s, end: ft() });

  // ---- 5. ATS check ----
  await panel.bringToFront();
  await panel.locator("#resumeList").evaluate((el) => el.closest("section").scrollIntoView({ block: "start" }));
  await panel.waitForTimeout(500);
  s = pt();
  await caption(panel, "Pass the ATS check", "See how applicant tracking systems read your resume — and what to fix.");
  await panel.waitForTimeout(1300);
  await clickLike(panel, panel.locator("#resumeList .resume-row").first().getByRole("button", { name: "ATS check" }));
  await expect(panel.locator(".ats-report")).toBeVisible();
  await panel.waitForTimeout(3800);
  scenes.push({ video: await panel.video().path(), start: s, end: pt() });

  // ---- 6. Answer Studio ----
  await panel.locator("#answerStudio").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await panel.waitForTimeout(400);
  s = pt();
  await caption(panel, "Answer common questions once", "Salary by role, notice period, relocation, and more — reused everywhere.");
  await panel.waitForTimeout(900);
  for (const [id, value] of [["salaryRole1", "Software Engineer"], ["salaryAmount1", "$165,000"], ["noticePeriod", "2 weeks"]]) {
    const field = panel.locator(`#sf_${id}`);
    if (!(await field.count())) continue;
    await moveTo(panel, field);
    await field.pressSequentially(value, { delay: 55 });
  }
  await panel.waitForTimeout(1800);
  scenes.push({ video: await panel.video().path(), start: s, end: pt() });

  // ---- Outro ----
  await card(app, `<div style="font-size:24px;color:#ddd6fe;font-weight:600;letter-spacing:.04em;text-transform:uppercase">Works on</div>
    <div style="font-size:30px;font-weight:700;margin:14px 0 34px;line-height:1.5;max-width:1000px">Workday · Greenhouse · Lever · Ashby · iCIMS · SmartRecruiters<br>Taleo · SuccessFactors · LinkedIn · Indeed · and more</div>
    <img src="${icon}" style="width:84px;height:84px;border-radius:20px;background:#fff">
    <div style="font-size:54px;font-weight:800;margin-top:14px">Add Hiresprint to Chrome — free</div>
    <div style="font-size:22px;color:#c7d2fe;margin-top:10px">Autofill · Match score · Resume tailoring · ATS check · Cover letters · Answer Studio</div>`, 5200, scenes);

  fs.writeFileSync(path.join(OUT, "scenes.json"), JSON.stringify(scenes, null, 2));
});
