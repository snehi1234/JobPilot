// Records the Chrome Web Store demo video from the real extension UI, in sync
// with the narration. Run through tests/browser/make-video.cjs (not part of the
// normal suite). Frames are captured at 1920x1080 over the DevTools protocol.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect, profile } = require("./extension.cjs");

const DIR = process.env.JOBPILOT_VIDEO_DIR;
test.skip(!DIR, "Run tests/browser/make-video.cjs to record the demo video.");
test.setTimeout(600000);

const BACKEND = "https://backend-alpha-seven-87.vercel.app";
const POSTING = "https://job-boards.greenhouse.io/northwindlabs/jobs/42";
const BEATS = DIR ? JSON.parse(fs.readFileSync(path.join(DIR, "beats.json"), "utf8")) : {};
const CHAPTERS = ["Set up", "Match score", "Tailor", "Autofill", "ATS check", "Answer Studio"];

const RESUME_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:10.5pt "Times New Roman",serif;margin:40px 52px;color:#111}h1{text-align:center;margin:0;font-size:20pt}.c{text-align:center;margin:2px 0 6px}
h2{font-size:11.5pt;border-bottom:1px solid #000;margin:12px 0 5px}p{margin:2px 0}ul{margin:2px 0 6px;padding-left:20px}li{margin:2px 0;text-align:justify}</style></head><body>
<h1>Alex Example</h1><p class="c">alex@example.com | +1 202-555-0142 | linkedin.com/in/example | Seattle, WA</p>
<h2>Summary</h2><p>Software engineer with four years of experience building backend platforms, cloud infrastructure, and developer tooling for fast-growing product teams.</p>
<h2>Experience</h2><p><b>Software Engineer, Example Inc</b> — Sep 2022 – Present</p><ul>
<li><b>Built Python and Go microservices</b> on Kubernetes serving 2M requests a day for the commerce platform.</li>
<li><b>Designed REST APIs and PostgreSQL data models</b> for the billing platform used by every product team.</li>
<li><b>Automated deployments</b> with Terraform and GitHub Actions, cutting release time by 60% across 14 services.</li>
<li><b>Added Redis caching and observability dashboards</b>, reducing p99 latency by 35% during peak traffic.</li></ul>
<p><b>Backend Engineer Intern, Sample Systems</b> — May 2021 – Aug 2021</p><ul>
<li><b>Developed Java Spring Boot APIs</b> for order tracking used by 40 warehouse sites.</li>
<li><b>Wrote integration tests</b> that raised coverage from 52% to 85%.</li></ul>
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

// ---------- 1080p recorder (DevTools screencast) ----------

async function record(page, name) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1.5, mobile: false });
  await page.waitForTimeout(300);
  const frames = [];
  cdp.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
    frames.push({ data, t: metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 93, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  const start = Date.now() / 1000;
  const voice = [];
  return {
    now: () => Date.now() / 1000 - start,
    voice,
    async stop() {
      await page.waitForTimeout(150);
      await cdp.send("Page.stopScreencast").catch(() => {});
      const end = Date.now() / 1000;
      const dir = path.join(DIR, `scene-${name}`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const lines = [];
      frames.forEach((f, i) => {
        const file = path.join(dir, `f${String(i).padStart(5, "0")}.jpg`);
        fs.writeFileSync(file, Buffer.from(f.data, "base64"));
        const from = i === 0 ? start : f.t;
        const to = i + 1 < frames.length ? frames[i + 1].t : end;
        lines.push(`file '${file.replace(/\\/g, "/")}'`, `duration ${Math.max(0.001, to - from).toFixed(4)}`);
      });
      if (frames.length) lines.push(`file '${path.join(dir, `f${String(frames.length - 1).padStart(5, "0")}.jpg`).replace(/\\/g, "/")}'`);
      fs.writeFileSync(path.join(dir, "frames.txt"), lines.join("\n"));
      return { name, dir, length: end - start, voice };
    },
  };
}

// Run one narrated beat: actions play while the line is spoken; the beat lasts
// at least as long as the voice clip.
async function beat(rec, scene, index, actions = async () => {}) {
  const b = BEATS[scene][index];
  const at = rec.now();
  rec.voice.push({ file: b.file, offset: at + 0.15 });
  await actions();
  const left = at + b.dur + 0.45 - rec.now();
  if (left > 0) await new Promise((r) => setTimeout(r, left * 1000));
}

// ---------- On-screen effects ----------

async function fx(page) {
  await page.evaluate(() => {
    if (document.getElementById("__fx")) return;
    const style = document.createElement("style");
    style.id = "__fx";
    style.textContent = `
      #__cur{position:fixed;left:640px;top:640px;width:28px;height:28px;z-index:2147483647;pointer-events:none;
        transition:left .75s cubic-bezier(.45,0,.2,1),top .75s cubic-bezier(.45,0,.2,1);filter:drop-shadow(0 3px 4px rgba(0,0,0,.35))}
      #__cur.click::after{content:"";position:absolute;left:-16px;top:-16px;width:32px;height:32px;border-radius:50%;background:rgba(124,58,237,.45);animation:__ping .5s ease-out}
      @keyframes __ping{from{transform:scale(.3);opacity:1}to{transform:scale(1.9);opacity:0}}
      #__cap{position:fixed;left:50%;bottom:30px;transform:translate(-50%,24px) scale(.96);opacity:0;z-index:2147483646;pointer-events:none;
        background:linear-gradient(135deg,rgba(30,27,75,.95),rgba(74,58,255,.95));color:#fff;font:700 26px/1.25 -apple-system,Segoe UI,Roboto,sans-serif;
        padding:14px 28px;border-radius:16px;box-shadow:0 14px 40px rgba(30,27,75,.35);transition:all .45s cubic-bezier(.2,.9,.3,1.2);white-space:nowrap}
      #__cap.on{opacity:1;transform:translate(-50%,0) scale(1)}
      #__chap{position:fixed;left:24px;top:22px;z-index:2147483646;pointer-events:none;display:flex;gap:8px;align-items:center;
        font:700 15px -apple-system,Segoe UI,Roboto,sans-serif;color:#1e1b4b;background:rgba(255,255,255,.92);border:1px solid #ddd6fe;
        border-radius:999px;padding:8px 14px 8px 8px;box-shadow:0 8px 24px rgba(30,27,75,.15);transform:translateX(-140%);transition:transform .6s cubic-bezier(.2,.9,.3,1.2)}
      #__chap.on{transform:none}
      #__chap b{background:linear-gradient(135deg,#4a3aff,#7c3aed);color:#fff;border-radius:999px;padding:3px 10px;font-size:13px}
      #__chap i{display:block;width:120px;height:5px;border-radius:9px;background:#ede9fe;overflow:hidden;font-style:normal}
      #__chap i::after{content:"";display:block;height:100%;width:var(--p);background:linear-gradient(90deg,#4a3aff,#7c3aed);transition:width .8s}
      #__spot{position:fixed;z-index:2147483645;pointer-events:none;border-radius:14px;box-shadow:0 0 0 9999px rgba(15,12,40,.38);
        transition:all .55s cubic-bezier(.4,0,.2,1);opacity:0}
      #__spot.on{opacity:1}
      #__spot::after{content:"";position:absolute;inset:-6px;border-radius:18px;border:3px solid #a78bfa;animation:__pulse 1.4s ease-in-out infinite}
      @keyframes __pulse{0%,100%{opacity:.95;transform:scale(1)}50%{opacity:.4;transform:scale(1.02)}}
      #__stat{position:fixed;right:40px;top:90px;z-index:2147483646;pointer-events:none;background:#fff;border-radius:18px;padding:16px 22px;
        box-shadow:0 20px 50px rgba(30,27,75,.3);font:600 18px -apple-system,Segoe UI,Roboto,sans-serif;color:#1e1b4b;transform:translateY(-20px) scale(.8);opacity:0;
        transition:all .6s cubic-bezier(.2,.9,.3,1.3)}
      #__stat.on{transform:none;opacity:1}
      #__stat .big{font-size:40px;font-weight:800;background:linear-gradient(135deg,#4a3aff,#db2777);-webkit-background-clip:text;color:transparent;display:block}`;
    document.documentElement.appendChild(style);
    for (const id of ["__cur", "__cap", "__chap", "__spot", "__stat"]) {
      const el = document.createElement("div");
      el.id = id;
      document.documentElement.appendChild(el);
    }
    document.getElementById("__cur").innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28"><path d="M4 2l16 9-7 2-3 7z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  });
}

async function caption(page, text) {
  await fx(page);
  await page.evaluate((text) => {
    const c = document.getElementById("__cap");
    c.classList.remove("on");
    setTimeout(() => { c.textContent = text; c.classList.add("on"); }, 220);
  }, text);
}

async function chapter(page, n) {
  await fx(page);
  await page.evaluate(({ n, names }) => {
    const c = document.getElementById("__chap");
    c.innerHTML = `<b>${n}/${names.length}</b><span>${names[n - 1]}</span><i></i>`;
    c.style.setProperty("--p", `${Math.round(((n - 1) / names.length) * 100)}%`);
    requestAnimationFrame(() => { c.classList.add("on"); setTimeout(() => c.style.setProperty("--p", `${Math.round((n / names.length) * 100)}%`), 300); });
  }, { n, names: CHAPTERS });
}

async function spotlight(page, locator, pad = 8) {
  await fx(page);
  const box = locator ? await locator.boundingBox().catch(() => null) : null;
  await page.evaluate(({ box, pad }) => {
    const s = document.getElementById("__spot");
    if (!box) { s.classList.remove("on"); return; }
    Object.assign(s.style, { left: `${box.x - pad}px`, top: `${box.y - pad}px`, width: `${box.width + pad * 2}px`, height: `${box.height + pad * 2}px` });
    s.classList.add("on");
  }, { box, pad });
}

async function stat(page, html) {
  await fx(page);
  await page.evaluate((html) => {
    const s = document.getElementById("__stat");
    s.innerHTML = html;
    requestAnimationFrame(() => s.classList.add("on"));
  }, html);
}

async function moveTo(page, locator) {
  await fx(page);
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) return;
  await page.evaluate(({ x, y }) => {
    const c = document.getElementById("__cur");
    c.style.left = `${x}px`;
    c.style.top = `${y}px`;
  }, { x: box.x + Math.min(box.width / 2, 40), y: box.y + box.height / 2 });
  await page.waitForTimeout(800);
}

async function clickLike(page, locator) {
  await moveTo(page, locator);
  await page.evaluate(() => {
    const c = document.getElementById("__cur");
    c.classList.remove("click");
    void c.offsetWidth;
    c.classList.add("click");
  });
  await page.waitForTimeout(160);
  await locator.click();
}

async function smoothScroll(page, y, ms = 1400) {
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

// Side panel shown docked on the right of a branded stage, like it sits in Chrome.
async function stagePanel(panel) {
  await panel.evaluate(() => {
    const s = document.createElement("style");
    s.textContent = `html{background:radial-gradient(900px 520px at 15% 10%,#ede9fe 0%,transparent 60%),radial-gradient(700px 500px at 30% 100%,#fce7f3 0%,transparent 60%),linear-gradient(160deg,#f8f7ff,#eef2ff)!important;min-height:100%}
      body{zoom:1.3;width:420px;margin:0 50px 0 auto!important;box-shadow:-10px 0 40px rgba(20,20,43,.15);min-height:100vh}
      #__stage{position:fixed;left:70px;top:0;bottom:0;width:560px;display:flex;flex-direction:column;justify-content:center;pointer-events:none;font-family:-apple-system,Segoe UI,Roboto,sans-serif}
      #__stage .brand{font:800 22px -apple-system,Segoe UI,Roboto,sans-serif;color:#4a3aff;margin-bottom:16px}
      #__stage h1{font-size:46px;line-height:1.08;margin:0;color:#14142b;letter-spacing:-.02em;transition:all .5s cubic-bezier(.2,.9,.3,1.2)}
      #__stage p{font-size:22px;line-height:1.45;color:#4b5563;margin:16px 0 0;transition:all .5s .08s cubic-bezier(.2,.9,.3,1.2)}
      #__stage.out h1,#__stage.out p{opacity:0;transform:translateY(18px)}
      #__cap{display:none!important}`;
    document.documentElement.appendChild(s);
    const st = document.createElement("div");
    st.id = "__stage";
    st.className = "out";
    st.innerHTML = '<div class="brand">⚡ Hiresprint</div><h1></h1><p></p>';
    document.documentElement.appendChild(st);
  });
  await fx(panel);
}

async function stageText(panel, title, sub) {
  await panel.evaluate(({ title, sub }) => {
    const st = document.getElementById("__stage");
    st.classList.add("out");
    setTimeout(() => {
      st.querySelector("h1").textContent = title;
      st.querySelector("p").textContent = sub;
      st.classList.remove("out");
    }, 300);
  }, { title, sub });
}

async function card(app, html, scene, scenes) {
  const page = await app.context.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;overflow:hidden">
    <div id="bg" style="width:1280px;height:720px;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;
      font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#fff;background:linear-gradient(120deg,#1e1b4b,#4a3aff,#7c3aed,#db2777);background-size:300% 300%;animation:bg 9s ease infinite">
      ${Array.from({ length: 14 }, (_, i) => `<span class="dot" style="left:${(i * 89) % 1240}px;top:${(i * 157) % 680}px;animation-delay:${(i % 7) * 0.4}s;width:${6 + (i % 4) * 4}px;height:${6 + (i % 4) * 4}px"></span>`).join("")}
      ${html}</div>
    <style>@keyframes bg{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
      .dot{position:absolute;border-radius:50%;background:rgba(255,255,255,.18);animation:float 6s ease-in-out infinite}
      @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-26px)}}
      .pop{animation:pop .9s cubic-bezier(.2,1.4,.3,1) both}.up{animation:up .8s cubic-bezier(.2,.9,.3,1) both}
      @keyframes pop{from{transform:scale(.2) rotate(-12deg);opacity:0}to{transform:none;opacity:1}}
      @keyframes up{from{transform:translateY(26px);opacity:0}to{transform:none;opacity:1}}
      .chip{display:inline-block;margin:6px;padding:9px 16px;border-radius:999px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.35);font-weight:600;font-size:19px}
      .cta{display:inline-block;margin-top:26px;background:#fff;color:#4a3aff;font-weight:800;font-size:26px;padding:16px 34px;border-radius:16px;animation:up .8s 1.6s both, glow 1.6s 2.4s ease-in-out infinite}
      @keyframes glow{0%,100%{box-shadow:0 0 0 0 rgba(255,255,255,.6)}50%{box-shadow:0 0 0 14px rgba(255,255,255,0)}}</style></body>`);
  const rec = await record(page, scene);
  await beat(rec, scene, 0, async () => {});
  await page.waitForTimeout(500);
  scenes.push(await rec.stop());
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
  await context.route(`${BACKEND}/api/tailor`, (route) => {
    const resume = String(route.request().postDataJSON()?.resume || "");
    const lineWith = (s) => resume.split("\n").map((l) => l.trim()).find((l) => l.includes(s)) || s;
    const rewrite = (key, improved, keywords) => { const line = lineWith(key); return { original: line, line, improved, keywords }; };
    return route.fulfill({ json: {
      summary: "Platform engineer with four years building Python and Go microservices, REST APIs, and cloud infrastructure on Kubernetes and AWS.",
      bullets: [
        rewrite("Built Python and Go microservices", "Built Python and Go microservices and REST APIs on Kubernetes and Docker, serving 2M requests a day for the platform.", ["REST APIs", "Docker"]),
        rewrite("Designed REST APIs and PostgreSQL", "Designed REST APIs and SQL data models in PostgreSQL for the distributed billing platform used by every team.", ["SQL", "distributed systems"]),
        rewrite("Added Redis caching", "Added Redis caching and observability dashboards for distributed systems, reducing p99 latency by 35% at peak.", ["observability"]),
      ],
      skills: ["Kafka"], gaps: ["Rust", "GraphQL"],
    } });
  });
  await context.route("https://job-boards.greenhouse.io/**", (route) => route.fulfill({ status: 404, body: "Not found" }));
  await context.route(POSTING, (route) => route.fulfill({ contentType: "text/html", body: POSTING_PAGE }));

  const maker = await context.newPage();
  await maker.setContent(RESUME_HTML);
  const pdfPath = path.join(DIR, "Alex_Example_Resume.pdf");
  fs.writeFileSync(pdfPath, await maker.pdf({ format: "Letter" }));
  await maker.close();
  await worker.evaluate(async () => {
    await chrome.storage.local.remove(["resumes", "uploadedResumeText", "resumeFiles", "defaultResumeId"]);
    await chrome.storage.local.set({ structured: {}, coverLetterMode: "ai", ratingState: { never: true }, onboardingHidden: true });
  });

  // ---- Intro ----
  await card(app, `<img class="pop" src="${icon}" style="width:130px;height:130px;border-radius:28px;background:#fff;box-shadow:0 18px 50px rgba(0,0,0,.35)">
    <div class="up" style="font-size:72px;font-weight:800;margin-top:24px;letter-spacing:-.02em;animation-delay:.35s">Hiresprint</div>
    <div class="up" style="font-size:30px;color:#ede9fe;margin-top:8px;animation-delay:.7s">Apply to jobs in minutes, not hours.</div>
    <div class="up" style="margin-top:22px;animation-delay:1.1s"><span class="chip">⚡ Autofill</span><span class="chip">🎯 Match score</span><span class="chip">✨ Tailor</span><span class="chip">📝 Cover letters</span></div>`, "intro", scenes);

  // ---- 1. Set up ----
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 1280, height: 720 });
  await panel.goto(`chrome-extension://${app.id}/sidepanel.html`);
  await expect(panel.locator("#appContent")).toBeVisible();
  await panel.waitForTimeout(1000);
  await stagePanel(panel);
  await panel.locator("#resumeList").evaluate((el) => el.closest("section").scrollIntoView({ block: "start" }));
  let rec = await record(panel, "setup");
  await chapter(panel, 1);
  await beat(rec, "setup", 0, async () => {
    await stageText(panel, "Set up once", "Upload your resume — that's it.");
    await panel.waitForTimeout(600);
    const upload = panel.locator("label[for='resumeFile']");
    await clickLike(panel, upload).catch(() => {});
    await panel.locator("#resumeFile").setInputFiles(pdfPath);
    await expect(panel.locator("#resumeList .resume-row")).toHaveCount(1, { timeout: 20000 });
    await spotlight(panel, panel.locator("#resumeList"));
  });
  await beat(rec, "setup", 1, async () => {
    await spotlight(panel, null);
    await stageText(panel, "Your profile fills itself in", "Name, contact details, links, and work history.");
    await panel.locator("#sf_firstName").evaluate((el) => el.closest("section").scrollIntoView({ block: "start", behavior: "smooth" }));
    await expect(panel.locator("#sf_firstName")).toHaveValue(profile.firstName, { timeout: 15000 });
    await panel.waitForTimeout(900);
    await spotlight(panel, panel.locator("#sf_firstName").locator("xpath=ancestor::section[1]"), 4);
  });
  await spotlight(panel, null);
  scenes.push(await rec.stop());

  await worker.evaluate(async () => {
    const { resumes = [] } = await chrome.storage.local.get("resumes");
    resumes.push({ id: "da", name: "Data Analyst", text: "Data Analyst. SQL, Tableau, Excel, dashboards, A/B testing, statistics.", fileName: "Alex_Example_Data.pdf" });
    await chrome.storage.local.set({ resumes });
  });

  // ---- 2. Match score on a job posting ----
  const post = await context.newPage();
  await post.setViewportSize({ width: 1280, height: 720 });
  await post.goto(POSTING);
  const badge = post.locator("#hiresprint-match");
  await expect(badge).toBeAttached({ timeout: 15000 });
  await post.evaluate(() => document.getElementById("jobpilot-fab")?.remove());
  rec = await record(post, "match");
  await chapter(post, 2);
  await beat(rec, "match", 0, async () => {
    await caption(post, "🎯 Your match, right on the job posting");
    await post.waitForTimeout(500);
    await spotlight(post, badge.locator(".pill"), 10);
  });
  await beat(rec, "match", 1, async () => {
    await spotlight(post, null);
    await clickLike(post, badge.locator(".pill"));
    await post.waitForTimeout(600);
    await caption(post, "✓ Skills you have   ✗ Skills you're missing");
    await spotlight(post, badge.locator(".panel"), 8);
  });
  await spotlight(post, null);
  scenes.push(await rec.stop());

  // ---- 3. Tailor ----
  await post.bringToFront();
  await panel.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(panel.locator("#matchCard")).toBeVisible({ timeout: 15000 });
  await panel.locator("#matchCard").evaluate((el) => el.scrollIntoView({ block: "start" }));
  rec = await record(panel, "tailor");
  await chapter(panel, 3);
  await beat(rec, "tailor", 0, async () => {
    await stageText(panel, "Tailor your resume in one click", "For this exact job.");
    await panel.waitForTimeout(500);
    await clickLike(panel, panel.locator("#tailorBtn"));
    await expect(panel.locator(".tailor-item").first()).toBeVisible({ timeout: 15000 });
  });
  await beat(rec, "tailor", 1, async () => {
    await stageText(panel, "Your score goes up", "Your own bullets, in the job's words. Nothing invented.");
    await panel.locator(".tailor-score").evaluate((el) => el.scrollIntoView({ block: "start", behavior: "smooth" }));
    await panel.waitForTimeout(700);
    await spotlight(panel, panel.locator(".tailor-score"), 6);
    await panel.waitForTimeout(2200);
    await spotlight(panel, panel.locator(".tailor-item").nth(1), 4);
  });
  await beat(rec, "tailor", 2, async () => {
    await spotlight(panel, null);
    await stageText(panel, "Keeps your resume's design", "Only the changed bullets are rewritten in your own file.");
    const use = panel.getByRole("button", { name: "Use for this application" });
    await use.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "smooth" }));
    await panel.waitForTimeout(700);
    await clickLike(panel, use);
    await expect(panel.locator(".tailor-note")).toContainText(/Kept your resume's design|keep your resume's design/, { timeout: 15000 });
    await spotlight(panel, panel.locator(".tailor-note"), 6);
  });
  await spotlight(panel, null);
  scenes.push(await rec.stop());

  // ---- 4. Autofill with a cover letter ----
  const form = await context.newPage();
  await form.setViewportSize({ width: 1280, height: 720 });
  await form.goto(`${BACKEND}/practice.html`);
  await expect(form.locator("#jobpilot-fab")).toBeVisible({ timeout: 15000 });
  await form.evaluate(() => document.querySelector(".banner")?.remove());
  await form.locator("#application").evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 10));
  rec = await record(form, "autofill");
  await chapter(form, 4);
  await beat(rec, "autofill", 0, async () => {
    await caption(form, "⚡ One click on any application");
    await form.waitForTimeout(400);
    await clickLike(form, form.locator("#jobpilot-fab").getByRole("button", { name: /autofill/i }));
  });
  await beat(rec, "autofill", 1, async () => {
    await expect(form.locator("#first_name")).toHaveValue(profile.firstName, { timeout: 15000 });
    await caption(form, "🟢 From your profile   🔵 AI answers to review");
    await spotlight(form, form.locator("#first_name").locator("xpath=ancestor::div[contains(@class,'row2')][1]"), 6);
    await form.waitForTimeout(1600);
    await spotlight(form, null);
    await expect(form.locator("#why")).not.toHaveValue("", { timeout: 15000 });
    await smoothScroll(form, await form.locator("#why").evaluate((el) => el.getBoundingClientRect().top + window.scrollY - 260), 1800);
    await spotlight(form, form.locator("#why"), 6);
  });
  await beat(rec, "autofill", 2, async () => {
    await spotlight(form, null);
    await expect(form.locator("#cover_letter")).not.toHaveValue("", { timeout: 20000 });
    await caption(form, "📝 A cover letter written for this job");
    await smoothScroll(form, await form.locator("#cover_letter").evaluate((el) => el.getBoundingClientRect().top + window.scrollY - 200), 1500);
    await spotlight(form, form.locator("#cover_letter"), 6);
  });
  await beat(rec, "autofill", 3, async () => {
    await spotlight(form, null);
    await caption(form, "✅ Review the checklist — you submit");
    await spotlight(form, form.locator("#jobpilot-checklist"), 4);
    await form.waitForTimeout(1200);
    await stat(form, '<span style="color:#6b7280;font-size:15px">Time per application</span><span class="big">20 min → 1 min</span>');
  });
  await spotlight(form, null);
  scenes.push(await rec.stop());

  // ---- 5. ATS check ----
  await panel.locator("#resumeList").evaluate((el) => el.closest("section").scrollIntoView({ block: "start" }));
  rec = await record(panel, "ats");
  await chapter(panel, 5);
  await beat(rec, "ats", 0, async () => {
    await stageText(panel, "Pass the ATS check", "See how hiring systems read your resume.");
    await clickLike(panel, panel.locator("#resumeList .resume-row").first().getByRole("button", { name: "ATS check" }));
    await expect(panel.locator(".ats-report")).toBeVisible();
    await panel.waitForTimeout(500);
    await spotlight(panel, panel.locator(".ats-report"), 4);
  });
  await spotlight(panel, null);
  scenes.push(await rec.stop());

  // ---- 6. Answer Studio ----
  await panel.locator("#answerStudio").evaluate((el) => el.scrollIntoView({ block: "start" }));
  rec = await record(panel, "studio");
  await chapter(panel, 6);
  await beat(rec, "studio", 0, async () => {
    await stageText(panel, "Answer once, reuse everywhere", "Salary, notice period, relocation, and more.");
    for (const [id, value] of [["salaryRole1", "Software Engineer"], ["salaryAmount1", "$165,000"], ["noticePeriod", "2 weeks"]]) {
      const field = panel.locator(`#sf_${id}`);
      await moveTo(panel, field);
      await field.pressSequentially(value, { delay: 45 });
    }
  });
  scenes.push(await rec.stop());

  // ---- Outro ----
  await card(app, `<div class="up" style="font-size:20px;color:#ede9fe;font-weight:700;letter-spacing:.08em;text-transform:uppercase">Works on</div>
    <div class="up" style="font-size:28px;font-weight:700;margin:12px 0 26px;line-height:1.5;max-width:1040px;animation-delay:.3s">Workday · Greenhouse · Lever · Ashby · iCIMS · SmartRecruiters<br>Taleo · SuccessFactors · LinkedIn · Indeed · and more</div>
    <img class="pop" src="${icon}" style="width:92px;height:92px;border-radius:22px;background:#fff;animation-delay:.8s">
    <div class="up" style="font-size:56px;font-weight:800;margin-top:14px;animation-delay:1.1s">Add Hiresprint to Chrome</div>
    <div class="cta">It's free →</div>`, "outro", scenes);

  fs.writeFileSync(path.join(DIR, "scenes.json"), JSON.stringify(scenes, null, 2));
});
