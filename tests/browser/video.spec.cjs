// Records the Chrome Web Store demo video from the real extension UI, in sync
// with the narration. Run through tests/browser/make-video.cjs (not part of the
// normal suite). Frames are captured at 3200x1800 over the DevTools protocol;
// make-video.cjs adds camera moves, captions, transitions, music, and effects.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect, profile } = require("./extension.cjs");

const DIR = process.env.JOBPILOT_VIDEO_DIR;
test.skip(!DIR, "Run tests/browser/make-video.cjs to record the demo video.");
test.setTimeout(900000);

const DPR = 2.5; // 1280x720 CSS px → 3200x1800 frames
const LINKEDIN = process.env.VIDEO_VARIANT === "linkedin"; // ~60s cut with subtitles, no chapter cards
const BACKEND = "https://backend-alpha-seven-87.vercel.app";
const POSTING = "https://job-boards.greenhouse.io/northwindlabs/jobs/42";
const BEATS = DIR ? JSON.parse(fs.readFileSync(path.join(DIR, "beats.json"), "utf8")) : {};
const CHAPTERS = [
  { name: "Set up", emoji: "🚀", colors: ["#4f46e5", "#06b6d4"] },
  { name: "Match score", emoji: "🎯", colors: ["#7c3aed", "#ec4899"] },
  { name: "Tailor your resume", emoji: "✨", colors: ["#0ea5e9", "#22c55e"] },
  { name: "One-click autofill", emoji: "⚡", colors: ["#f59e0b", "#ef4444"] },
  { name: "ATS check", emoji: "🤖", colors: ["#10b981", "#3b82f6"] },
  { name: "Answer Studio", emoji: "🗂️", colors: ["#ec4899", "#8b5cf6"] },
];

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

// ---------- Recorder (DevTools screencast) ----------

async function record(page, name, chapter = 0) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: DPR, mobile: false });
  await page.waitForTimeout(350);
  const frames = [];
  cdp.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
    frames.push({ data, t: metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: 3200, maxHeight: 1800, everyNthFrame: 1 });
  const start = Date.now() / 1000;
  const rec = {
    now: () => Date.now() / 1000 - start,
    voice: [], subs: [], captions: [], cam: [{ t: 0, x: 0, y: 0, w: 1280 }], sfx: [], chapter,
    async stop() {
      await page.waitForTimeout(150);
      await cdp.send("Page.stopScreencast").catch(() => {});
      const end = Date.now() / 1000;
      const dir = path.join(DIR, `scene-${name}`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const list = frames.map((f, i) => {
        const file = path.join(dir, `f${String(i).padStart(5, "0")}.jpg`);
        fs.writeFileSync(file, Buffer.from(f.data, "base64"));
        return { file, t: Math.max(0, f.t - start) };
      });
      return { name, dir, frames: list, length: end - start, voice: rec.voice, subs: rec.subs, captions: rec.captions, cam: rec.cam, sfx: rec.sfx, chapter: rec.chapter };
    },
  };
  return rec;
}

// One narrated beat: actions play while the line is spoken; the beat lasts at
// least as long as the voice clip.
async function beat(rec, scene, index, actions = async () => {}) {
  const b = BEATS[scene][index];
  const at = rec.now();
  rec.voice.push({ file: b.file, offset: at + 0.15 });
  rec.subs.push({ t: at + 0.15, dur: b.dur, text: b.text });
  await actions();
  const left = at + b.dur + (LINKEDIN ? 1.05 : 0.45) - rec.now();
  if (left > 0) await new Promise((r) => setTimeout(r, left * 1000));
}

const sfx = (rec, name, delay = 0) => rec.sfx.push({ t: rec.now() + delay, name });
const caption = (rec, text) => rec.captions.push({ t: rec.now(), text });

// Camera: zoom to a region (in CSS px); make-video.cjs animates between keyframes.
async function focus(rec, locator, zoom = 1.4) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return;
  const w = 1280 / zoom;
  const h = (w * 9) / 16;
  const x = Math.min(Math.max(box.x + box.width / 2 - w / 2, 0), 1280 - w);
  const y = Math.min(Math.max(box.y + box.height / 2 - h / 2, 0), 720 - h);
  rec.cam.push({ t: rec.now(), x, y, w });
}
const wide = (rec) => rec.cam.push({ t: rec.now(), x: 0, y: 0, w: 1280 });

// ---------- In-page effects ----------

async function fx(page) {
  await page.evaluate(() => {
    if (document.getElementById("__fx")) return;
    const style = document.createElement("style");
    style.id = "__fx";
    style.textContent = `
      #__cur{position:fixed;left:640px;top:640px;width:30px;height:30px;z-index:2147483647;pointer-events:none;
        transition:left .7s cubic-bezier(.45,0,.2,1),top .7s cubic-bezier(.45,0,.2,1);filter:drop-shadow(0 3px 5px rgba(0,0,0,.35))}
      #__cur.click::before,#__cur.click::after{content:"";position:absolute;left:-18px;top:-18px;width:36px;height:36px;border-radius:50%;border:3px solid #a855f7;animation:__ring .6s ease-out forwards}
      #__cur.click::after{border-color:#ec4899;animation-delay:.12s}
      @keyframes __ring{from{transform:scale(.2);opacity:1}to{transform:scale(2.1);opacity:0}}
      #__spot{position:fixed;z-index:2147483645;pointer-events:none;border-radius:14px;box-shadow:0 0 0 9999px rgba(15,12,40,.32);
        transition:all .55s cubic-bezier(.4,0,.2,1);opacity:0}
      #__spot.on{opacity:1}
      #__spot::after{content:"";position:absolute;inset:-6px;border-radius:18px;padding:3px;
        background:conic-gradient(from var(--a),#a855f7,#ec4899,#f59e0b,#22c55e,#06b6d4,#a855f7);
        -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:__spin 2.2s linear infinite}
      @property --a{syntax:"<angle>";initial-value:0deg;inherits:false}
      @keyframes __spin{to{--a:360deg}}
      #__stat{position:fixed;left:28px;top:250px;z-index:2147483647;pointer-events:none;background:#fff;border-radius:20px;padding:18px 26px;
        box-shadow:0 24px 60px rgba(30,27,75,.35);font:600 18px -apple-system,Segoe UI,Roboto,sans-serif;color:#1e1b4b;transform:translateY(-30px) scale(.6) rotate(-6deg);opacity:0;
        transition:all .7s cubic-bezier(.2,1.5,.3,1)}
      #__stat.on{transform:none;opacity:1}
      #__stat .big{font-size:44px;font-weight:900;background:linear-gradient(90deg,#4f46e5,#ec4899,#f59e0b);-webkit-background-clip:text;color:transparent;display:block}
      [data-jobpilot-source]{animation:__glow 1.6s ease-out 1}
      @keyframes __glow{0%{box-shadow:0 0 0 0 rgba(168,85,247,0)}25%{box-shadow:0 0 0 7px rgba(168,85,247,.45),0 0 26px rgba(236,72,153,.45)}100%{box-shadow:0 0 0 0 rgba(168,85,247,0)}}
      #__confetti{position:fixed;inset:0;z-index:2147483644;pointer-events:none}`;
    document.documentElement.appendChild(style);
    for (const id of ["__cur", "__spot", "__stat"]) {
      const el = document.createElement("div");
      el.id = id;
      document.documentElement.appendChild(el);
    }
    document.getElementById("__cur").innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2l16 9-7 2-3 7z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    // Confetti burst from a point.
    window.__confetti = (x, y, count = 140) => {
      let c = document.getElementById("__confetti");
      if (!c) {
        c = document.createElement("canvas");
        c.id = "__confetti";
        document.documentElement.appendChild(c);
      }
      const dpr = window.devicePixelRatio || 1;
      c.width = innerWidth * dpr; c.height = innerHeight * dpr;
      const ctx = c.getContext("2d");
      ctx.scale(dpr, dpr);
      const colors = ["#a855f7", "#ec4899", "#f59e0b", "#22c55e", "#06b6d4", "#4f46e5", "#ef4444"];
      const parts = Array.from({ length: count }, () => ({
        x, y, vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 15 - 4, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
        w: 6 + Math.random() * 8, h: 4 + Math.random() * 6, c: colors[(Math.random() * colors.length) | 0],
      }));
      const t0 = performance.now();
      const tick = (now) => {
        const k = (now - t0) / 1000;
        ctx.clearRect(0, 0, innerWidth, innerHeight);
        for (const p of parts) {
          p.vy += 0.45; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
          ctx.save(); ctx.globalAlpha = Math.max(0, 1 - k / 2.4); ctx.translate(p.x, p.y); ctx.rotate(p.r);
          ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
        }
        if (k < 2.5) requestAnimationFrame(tick); else ctx.clearRect(0, 0, innerWidth, innerHeight);
      };
      requestAnimationFrame(tick);
    };
  });
}

async function confetti(rec, page, locator) {
  await fx(page);
  const box = locator ? await locator.boundingBox().catch(() => null) : null;
  await page.evaluate(({ x, y }) => window.__confetti(x, y), { x: box ? box.x + box.width / 2 : 640, y: box ? box.y + box.height / 2 : 360 });
  sfx(rec, "chime");
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

async function stat(rec, page, html) {
  await fx(page);
  await page.evaluate((html) => {
    const s = document.getElementById("__stat");
    s.innerHTML = html;
    requestAnimationFrame(() => s.classList.add("on"));
  }, html);
  sfx(rec, "pop");
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
  await page.waitForTimeout(760);
}

async function clickLike(rec, page, locator) {
  await moveTo(page, locator);
  await page.evaluate(() => {
    const c = document.getElementById("__cur");
    c.classList.remove("click");
    void c.offsetWidth;
    c.classList.add("click");
  });
  sfx(rec, "click");
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

// Side panel docked on the right of a colourful, moving stage.
async function stagePanel(panel) {
  await panel.evaluate(() => {
    const s = document.createElement("style");
    s.textContent = `html{background:#f5f3ff!important;min-height:100%;overflow-x:hidden}
      #__blobs{position:fixed;inset:-20%;z-index:-1;pointer-events:none;filter:blur(60px);opacity:.75}
      #__blobs i{position:absolute;width:46vw;height:46vw;border-radius:50%;animation:__drift 14s ease-in-out infinite alternate}
      #__blobs i:nth-child(1){background:#a78bfa;left:5%;top:10%}
      #__blobs i:nth-child(2){background:#f9a8d4;left:25%;top:45%;animation-duration:17s;animation-delay:-4s}
      #__blobs i:nth-child(3){background:#67e8f9;left:-5%;top:55%;animation-duration:12s;animation-delay:-8s}
      #__blobs i:nth-child(4){background:#fde68a;left:30%;top:0%;animation-duration:19s}
      @keyframes __drift{0%{transform:translate(0,0) scale(1)}50%{transform:translate(8vw,-6vh) scale(1.15)}100%{transform:translate(-6vw,8vh) scale(.95)}}
      body{zoom:1.45;width:420px;margin:0 36px 0 auto!important;box-shadow:-14px 0 50px rgba(76,29,149,.22);min-height:100vh;background:#f6f7fb}
      #__stage{position:fixed;left:64px;top:0;bottom:0;width:560px;display:flex;flex-direction:column;justify-content:center;pointer-events:none;font-family:-apple-system,Segoe UI,Roboto,sans-serif}
      #__stage .brand{font:800 22px -apple-system,Segoe UI,Roboto,sans-serif;color:#4f46e5;margin-bottom:14px;display:flex;gap:10px;align-items:center}
      #__stage .emoji{font-size:58px;display:inline-block;margin-bottom:6px;animation:__bob 2.4s ease-in-out infinite}
      @keyframes __bob{0%,100%{transform:translateY(0) rotate(-6deg)}50%{transform:translateY(-10px) rotate(6deg)}}
      #__stage h1{font-size:50px;line-height:1.06;margin:0;letter-spacing:-.02em;background:linear-gradient(90deg,#4f46e5,#c026d3,#ea580c);-webkit-background-clip:text;color:transparent;
        transition:all .55s cubic-bezier(.2,1.3,.3,1)}
      #__stage p{font-size:23px;line-height:1.45;color:#374151;margin:16px 0 0;transition:all .55s .08s cubic-bezier(.2,1.3,.3,1)}
      #__stage.out h1,#__stage.out p,#__stage.out .emoji{opacity:0;transform:translateY(24px) scale(.96)}
      #__score{margin-top:26px;display:none;align-items:center;gap:16px;font-weight:900;font-size:64px}
      #__score.on{display:flex;animation:__in .7s cubic-bezier(.2,1.5,.3,1) both}
      #__score .from{color:#9ca3af;font-size:44px}#__score .arrow{font-size:40px;color:#a855f7}
      #__score .to{background:linear-gradient(90deg,#16a34a,#06b6d4);-webkit-background-clip:text;color:transparent}
      @keyframes __in{from{opacity:0;transform:scale(.4)}to{opacity:1;transform:none}}`;
    document.documentElement.appendChild(s);
    const blobs = document.createElement("div");
    blobs.id = "__blobs";
    blobs.innerHTML = "<i></i><i></i><i></i><i></i>";
    document.documentElement.appendChild(blobs);
    const st = document.createElement("div");
    st.id = "__stage";
    st.className = "out";
    st.innerHTML = '<div class="brand">⚡ Hiresprint</div><div class="emoji"></div><h1></h1><p></p><div id="__score"><span class="from"></span><span class="arrow">➜</span><span class="to"></span></div>';
    document.documentElement.appendChild(st);
  });
  await fx(panel);
}

async function stageText(rec, panel, emoji, title, sub) {
  await panel.evaluate(({ emoji, title, sub }) => {
    const st = document.getElementById("__stage");
    st.classList.add("out");
    document.getElementById("__score").classList.remove("on");
    setTimeout(() => {
      st.querySelector(".emoji").textContent = emoji;
      st.querySelector("h1").textContent = title;
      st.querySelector("p").textContent = sub;
      st.classList.remove("out");
    }, 320);
  }, { emoji, title, sub });
  sfx(rec, "pop", 0.32);
}

// Count the score up on the stage, with confetti.
async function scoreUp(rec, panel, from, to) {
  await panel.evaluate(({ from, to }) => {
    const el = document.getElementById("__score");
    el.querySelector(".from").textContent = `${from}%`;
    const out = el.querySelector(".to");
    el.classList.add("on");
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 1300);
      out.textContent = `${Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)))}%`;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, { from, to });
  await panel.waitForTimeout(1300);
  await confetti(rec, panel, panel.locator("#__score .to"));
}

// Full-screen animated cards (intro, chapters, outro).
async function card(app, html, name, scenes, { beatScene = null, seconds = 1.6, colors = ["#4f46e5", "#db2777"] } = {}) {
  const page = await app.context.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;overflow:hidden">
    <div id="bg" style="width:1280px;height:720px;position:relative;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;
      font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#fff;background:linear-gradient(120deg,${colors[0]},${colors[1]},#1e1b4b,${colors[0]});background-size:300% 300%;animation:bg 6s ease infinite">
      <div class="ring" style="width:900px;height:900px"></div><div class="ring" style="width:620px;height:620px;animation-delay:-1.5s"></div>
      ${Array.from({ length: 22 }, (_, i) => `<span class="dot" style="left:${(i * 89) % 1260}px;top:${(i * 157) % 700}px;animation-delay:${(i % 9) * -0.5}s;width:${6 + (i % 5) * 5}px;height:${6 + (i % 5) * 5}px;background:${["#fde68a", "#f9a8d4", "#a5f3fc", "#ddd6fe", "#bbf7d0"][i % 5]}"></span>`).join("")}
      <div style="position:relative;z-index:2">${html}</div></div>
    <style>@keyframes bg{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
      .dot{position:absolute;border-radius:50%;opacity:.5;animation:float 5s ease-in-out infinite}
      @keyframes float{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-34px) scale(1.3)}}
      .ring{position:absolute;left:50%;top:50%;border-radius:50%;border:2px solid rgba(255,255,255,.18);transform:translate(-50%,-50%);animation:ring 3s ease-in-out infinite}
      @keyframes ring{0%,100%{transform:translate(-50%,-50%) scale(.92)}50%{transform:translate(-50%,-50%) scale(1.05)}}
      .pop{animation:pop .9s cubic-bezier(.2,1.6,.3,1) both}.up{animation:up .7s cubic-bezier(.2,1.2,.3,1) both}
      @keyframes pop{from{transform:scale(.1) rotate(-25deg);opacity:0}to{transform:none;opacity:1}}
      @keyframes up{from{transform:translateY(34px);opacity:0}to{transform:none;opacity:1}}
      .chip{display:inline-block;margin:6px;padding:10px 18px;border-radius:999px;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.4);font-weight:700;font-size:20px;animation:up .6s both}
      .cta{display:inline-block;margin-top:26px;background:#fff;color:#4f46e5;font-weight:900;font-size:28px;padding:16px 36px;border-radius:18px;animation:up .7s 1.4s both,glow 1.4s 2.2s ease-in-out infinite}
      @keyframes glow{0%,100%{box-shadow:0 0 0 0 rgba(255,255,255,.7)}50%{box-shadow:0 0 0 16px rgba(255,255,255,0)}}</style></body>`);
  const rec = await record(page, name);
  sfx(rec, "whoosh");
  if (beatScene) await beat(rec, beatScene, 0, async () => {});
  else await page.waitForTimeout(seconds * 1000);
  await page.waitForTimeout(LINKEDIN && name === "outro" ? 2600 : 400);
  scenes.push(await rec.stop());
  await page.close();
}

async function chapterCard(app, n, scenes) {
  if (LINKEDIN) return;
  const c = CHAPTERS[n - 1];
  await card(app, `<div class="pop" style="font-size:96px">${c.emoji}</div>
    <div class="up" style="font-size:22px;font-weight:800;letter-spacing:.2em;opacity:.85;animation-delay:.15s">STEP ${n} OF ${CHAPTERS.length}</div>
    <div class="up" style="font-size:64px;font-weight:900;margin-top:8px;letter-spacing:-.02em;animation-delay:.3s">${c.name}</div>`, `ch${n}`, scenes, { seconds: 1.5, colors: c.colors });
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
  await card(app, `<img class="pop" src="${icon}" style="width:140px;height:140px;border-radius:30px;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.4)">
    <div class="up" style="font-size:80px;font-weight:900;margin-top:22px;letter-spacing:-.02em;animation-delay:.3s">Hiresprint</div>
    <div class="up" style="font-size:32px;margin-top:6px;animation-delay:.6s">Apply to jobs in minutes, not hours.</div>
    <div style="margin-top:22px"><span class="chip" style="animation-delay:1s">⚡ Autofill</span><span class="chip" style="animation-delay:1.15s">🎯 Match score</span><span class="chip" style="animation-delay:1.3s">✨ Tailor</span><span class="chip" style="animation-delay:1.45s">📝 Cover letters</span><span class="chip" style="animation-delay:1.6s">🤖 ATS check</span></div>`,
  "intro", scenes, { beatScene: "intro", colors: ["#4f46e5", "#db2777"] });

  // ---- 1. Set up ----
  await chapterCard(app, 1, scenes);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 1280, height: 720 });
  await panel.goto(`chrome-extension://${app.id}/sidepanel.html`);
  await expect(panel.locator("#appContent")).toBeVisible();
  await panel.waitForTimeout(800);
  await stagePanel(panel);
  await panel.locator("#resumeList").evaluate((el) => el.closest("section").scrollIntoView({ block: "start" }));
  let rec = await record(panel, "setup", 1);
  await beat(rec, "setup", 0, async () => {
    await stageText(rec, panel, "📄", "Set up once", "Upload your resume — that's it.");
    await panel.waitForTimeout(500);
    await clickLike(rec, panel, panel.locator("label[for='resumeFile']")).catch(() => {});
    await panel.locator("#resumeFile").setInputFiles(pdfPath);
    await expect(panel.locator("#resumeList .resume-row")).toHaveCount(1, { timeout: 20000 });
    sfx(rec, "pop");
    await spotlight(panel, panel.locator("#resumeList"));
  });
  await beat(rec, "setup", 1, async () => {
    await spotlight(panel, null);
    await stageText(rec, panel, "🪄", "Your profile fills itself in", "Name, contact details, links, and work history.");
    await panel.locator("#sf_firstName").evaluate((el) => el.closest("section").scrollIntoView({ block: "start", behavior: "smooth" }));
    await expect(panel.locator("#sf_firstName")).toHaveValue(profile.firstName, { timeout: 15000 });
    await panel.waitForTimeout(900);
    await spotlight(panel, panel.locator("#sf_firstName").locator("xpath=ancestor::section[1]"), 4);
    await confetti(rec, panel, panel.locator("#sf_firstName"));
  });
  await spotlight(panel, null);
  scenes.push(await rec.stop());

  await worker.evaluate(async () => {
    const { resumes = [] } = await chrome.storage.local.get("resumes");
    resumes.push({ id: "da", name: "Data Analyst", text: "Data Analyst. SQL, Tableau, Excel, dashboards, A/B testing, statistics.", fileName: "Alex_Example_Data.pdf" });
    await chrome.storage.local.set({ resumes });
  });

  // ---- 2. Match score ----
  await chapterCard(app, 2, scenes);
  const post = await context.newPage();
  await post.setViewportSize({ width: 1280, height: 720 });
  await post.goto(POSTING);
  const badge = post.locator("#hiresprint-match");
  await expect(badge).toBeAttached({ timeout: 15000 });
  await post.evaluate(() => document.getElementById("jobpilot-fab")?.remove());
  rec = await record(post, "match", 2);
  await beat(rec, "match", 0, async () => {
    caption(rec, "🎯  Your match, right on the job posting");
    await post.waitForTimeout(400);
    await focus(rec, badge.locator(".pill"), 1.9);
    await spotlight(post, badge.locator(".pill"), 10);
    sfx(rec, "pop", 0.3);
  });
  await beat(rec, "match", 1, async () => {
    await spotlight(post, null);
    await clickLike(rec, post, badge.locator(".pill"));
    await post.waitForTimeout(500);
    caption(rec, "✅  Skills you have    ❌  Skills you're missing");
    await focus(rec, badge.locator(".panel"), 1.75);
    await spotlight(post, badge.locator(".panel"), 8);
  });
  await spotlight(post, null);
  wide(rec);
  await post.waitForTimeout(700);
  scenes.push(await rec.stop());

  // ---- 3. Tailor ----
  await chapterCard(app, 3, scenes);
  await post.bringToFront();
  await panel.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(panel.locator("#matchCard")).toBeVisible({ timeout: 15000 });
  await panel.locator("#matchCard").evaluate((el) => el.scrollIntoView({ block: "start" }));
  rec = await record(panel, "tailor", 3);
  await beat(rec, "tailor", 0, async () => {
    await stageText(rec, panel, "✨", "Tailor in one click", "Made for this exact job.");
    await panel.waitForTimeout(500);
    await clickLike(rec, panel, panel.locator("#tailorBtn"));
    await expect(panel.locator(".tailor-item").first()).toBeVisible({ timeout: 15000 });
    sfx(rec, "pop");
  });
  await beat(rec, "tailor", 1, async () => {
    await stageText(rec, panel, "📈", "Your score goes up", "Your own bullets, in the job's words. Nothing invented.");
    await panel.locator(".tailor-score").evaluate((el) => el.scrollIntoView({ block: "start", behavior: "smooth" }));
    await panel.waitForTimeout(700);
    await spotlight(panel, panel.locator(".tailor-score"), 6);
    const [from, to] = (await panel.locator(".tailor-score").innerText()).match(/\d+/g).map(Number);
    await scoreUp(rec, panel, from, to);
    await panel.waitForTimeout(800);
    await spotlight(panel, panel.locator(".tailor-item").nth(1), 4);
  });
  await beat(rec, "tailor", 2, async () => {
    await spotlight(panel, null);
    await stageText(rec, panel, "🎨", "Keeps your design", "Only the changed bullets are rewritten in your own file.");
    const use = panel.getByRole("button", { name: "Use for this application" });
    await use.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "smooth" }));
    await panel.waitForTimeout(600);
    await clickLike(rec, panel, use);
    await expect(panel.locator(".tailor-note")).toContainText(/Kept your resume's design|keep your resume's design/, { timeout: 15000 });
    await spotlight(panel, panel.locator(".tailor-note"), 6);
    sfx(rec, "pop");
  });
  await spotlight(panel, null);
  scenes.push(await rec.stop());

  // ---- 4. Autofill ----
  await chapterCard(app, 4, scenes);
  const form = await context.newPage();
  await form.setViewportSize({ width: 1280, height: 720 });
  await form.goto(`${BACKEND}/practice.html`);
  await expect(form.locator("#jobpilot-fab")).toBeVisible({ timeout: 15000 });
  await form.evaluate(() => document.querySelector(".banner")?.remove());
  await form.locator("#application").evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 10));
  await fx(form);
  rec = await record(form, "autofill", 4);
  await beat(rec, "autofill", 0, async () => {
    caption(rec, "⚡  One click on any application");
    await form.waitForTimeout(300);
    const fab = form.locator("#jobpilot-fab").getByRole("button", { name: /autofill/i });
    await focus(rec, fab, 1.5);
    await clickLike(rec, form, fab);
  });
  await beat(rec, "autofill", 1, async () => {
    await expect(form.locator("#first_name")).toHaveValue(profile.firstName, { timeout: 15000 });
    caption(rec, "🟢  From your profile    🔵  AI answers to review");
    await focus(rec, form.locator("#first_name").locator("xpath=ancestor::div[contains(@class,'row2')][1]"), 1.45);
    sfx(rec, "pop");
    await form.waitForTimeout(1600);
    await expect(form.locator("#why")).not.toHaveValue("", { timeout: 15000 });
    wide(rec);
    await smoothScroll(form, await form.locator("#why").evaluate((el) => el.getBoundingClientRect().top + window.scrollY - 260), 1600);
    await focus(rec, form.locator("#why"), 1.5);
    await spotlight(form, form.locator("#why"), 6);
  });
  await beat(rec, "autofill", 2, async () => {
    await spotlight(form, null);
    await expect(form.locator("#cover_letter")).not.toHaveValue("", { timeout: 20000 });
    caption(rec, "📝  A cover letter written for this job");
    wide(rec);
    await smoothScroll(form, await form.locator("#cover_letter").evaluate((el) => el.getBoundingClientRect().top + window.scrollY - 200), 1300);
    await focus(rec, form.locator("#cover_letter"), 1.55);
    await spotlight(form, form.locator("#cover_letter"), 6);
    sfx(rec, "pop");
  });
  await beat(rec, "autofill", 3, async () => {
    await spotlight(form, null);
    caption(rec, "✅  Review the checklist — you submit");
    await focus(rec, form.locator("#jobpilot-checklist"), 1.5);
    await spotlight(form, form.locator("#jobpilot-checklist"), 4);
    await form.waitForTimeout(1500);
    await spotlight(form, null);
    wide(rec);
    await form.waitForTimeout(500);
    await stat(rec, form, '<span style="color:#6b7280;font-size:16px">⏱ Time per application</span><span class="big">15 min → 1 min</span>');
    await confetti(rec, form, form.locator("#__stat"));
  });
  scenes.push(await rec.stop());

  // ---- 5. ATS check ----
  await chapterCard(app, 5, scenes);
  await panel.locator("#resumeList").evaluate((el) => el.closest("section").scrollIntoView({ block: "start" }));
  rec = await record(panel, "ats", 5);
  await beat(rec, "ats", 0, async () => {
    await stageText(rec, panel, "🤖", "Pass the ATS check", "See how hiring systems read your resume.");
    await clickLike(rec, panel, panel.locator("#resumeList .resume-row").first().getByRole("button", { name: "ATS check" }));
    await expect(panel.locator(".ats-report")).toBeVisible();
    await panel.waitForTimeout(400);
    await spotlight(panel, panel.locator(".ats-report"), 4);
    await confetti(rec, panel, panel.locator(".ats-score"));
  });
  await spotlight(panel, null);
  scenes.push(await rec.stop());

  // ---- 6. Answer Studio ----
  await chapterCard(app, 6, scenes);
  await panel.locator("#answerStudio").evaluate((el) => el.scrollIntoView({ block: "start" }));
  rec = await record(panel, "studio", 6);
  await beat(rec, "studio", 0, async () => {
    await stageText(rec, panel, "🗂️", "Answer once, reuse everywhere", "Salary, notice period, relocation, and more.");
    for (const [id, value] of [["salaryRole1", "Software Engineer"], ["salaryAmount1", "$165,000"], ["noticePeriod", "2 weeks"]]) {
      const field = panel.locator(`#sf_${id}`);
      await moveTo(panel, field);
      sfx(rec, "click");
      await field.pressSequentially(value, { delay: 45 });
    }
  });
  scenes.push(await rec.stop());

  // ---- Outro ----
  await card(app, `<div class="up" style="font-size:21px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;opacity:.9">Works on</div>
    <div class="up" style="font-size:30px;font-weight:800;margin:12px 0 26px;line-height:1.5;max-width:1060px;animation-delay:.25s">Workday · Greenhouse · Lever · Ashby · iCIMS · SmartRecruiters<br>Taleo · SuccessFactors · LinkedIn · Indeed · and more</div>
    <img class="pop" src="${icon}" style="width:100px;height:100px;border-radius:24px;background:#fff;animation-delay:.7s">
    <div class="up" style="font-size:60px;font-weight:900;margin-top:14px;animation-delay:1s">Add Hiresprint to Chrome</div>
    <div class="cta">It's free →</div>`, "outro", scenes, { beatScene: "outro", colors: ["#7c3aed", "#f97316"] });

  // ---- Overlay images for captions and the chapter pill (composited in post) ----
  const ov = await context.newPage();
  await ov.setViewportSize({ width: 2560, height: 400 });
  const overlayDir = path.join(DIR, "overlays");
  fs.mkdirSync(overlayDir, { recursive: true });
  const renderOverlay = async (html, file) => {
    await ov.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent"><div id="o" style="display:inline-block">${html}</div></body>`);
    await ov.locator("#o").screenshot({ path: file, omitBackground: true });
  };
  let n = 0;
  for (const scene of scenes) {
    for (const c of scene.captions) {
      c.png = path.join(overlayDir, `cap-${n++}.png`);
      await renderOverlay(`<div style="font:800 54px/1.25 'Segoe UI',Roboto,sans-serif;color:#fff;padding:26px 52px;border-radius:30px;
        background:linear-gradient(120deg,rgba(79,70,229,.96),rgba(192,38,211,.96),rgba(234,88,12,.96));box-shadow:0 0 0 4px rgba(255,255,255,.25)">${c.text}</div>`, c.png);
    }
    if (LINKEDIN) {
      for (const s of scene.subs || []) {
        s.png = path.join(overlayDir, `sub-${n++}.png`);
        await renderOverlay(`<div style="max-width:1900px;font:700 50px/1.3 'Segoe UI',Roboto,sans-serif;color:#fff;text-align:center;padding:18px 36px;border-radius:22px;
          background:rgba(15,12,40,.82);text-shadow:0 2px 6px rgba(0,0,0,.4)">${s.text}</div>`, s.png);
      }
    }
    if (scene.chapter) {
      const c = CHAPTERS[scene.chapter - 1];
      scene.chapterPng = path.join(overlayDir, `chapter-${scene.chapter}.png`);
      await renderOverlay(`<div style="display:flex;align-items:center;gap:18px;font:800 34px 'Segoe UI',Roboto,sans-serif;color:#1e1b4b;background:rgba(255,255,255,.95);
        padding:14px 30px 14px 14px;border-radius:999px;border:3px solid ${c.colors[0]}">
        <span style="background:linear-gradient(135deg,${c.colors[0]},${c.colors[1]});color:#fff;border-radius:999px;padding:8px 22px">${scene.chapter}/${CHAPTERS.length}</span>
        <span>${c.emoji} ${c.name}</span></div>`, scene.chapterPng);
    }
  }
  await ov.close();
  fs.writeFileSync(path.join(DIR, "scenes.json"), JSON.stringify(scenes, null, 2));
});
