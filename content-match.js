// content-match.js — shows how well your resumes match the job you're
// viewing, on job postings and job boards (before you apply). Loaded before
// content.js in the same isolated world. Runs in the top frame only.
//
// Uses only the job text shown on the page; nothing is fetched or sent to the
// server (resume matching runs in the extension's background worker).

var JP_BADGE_ID = "hiresprint-match";

// Job boards: where the description lives on each site.
var JP_BOARDS = [
  { host: /(^|\.)linkedin\.com$/, path: /^\/jobs\//, title: [".job-details-jobs-unified-top-card__job-title", ".jobs-unified-top-card__job-title", ".top-card-layout__title", "h1"], company: [".job-details-jobs-unified-top-card__company-name", ".jobs-unified-top-card__company-name", ".topcard__org-name-link"], description: ["#job-details", ".jobs-description__content", ".jobs-box__html-content", ".description__text"] },
  { host: /(^|\.)indeed\.[a-z.]+$/, path: /./, title: ["[data-testid='jobsearch-JobInfoHeader-title']", ".jobsearch-JobInfoHeader-title", "h1"], company: ["[data-testid='inlineHeader-companyName']", "[data-company-name]"], description: ["#jobDescriptionText"] },
  { host: /(^|\.)glassdoor\.[a-z.]+$/, path: /./, title: ["[data-test='job-title']", "h1"], company: ["[data-test='employer-name']"], description: ["[class*='JobDetails_jobDescription']", "[data-test='jobDescriptionContent']", "#JobDescriptionContainer"] },
  { host: /(^|\.)(ziprecruiter|dice|wellfound|builtin|simplyhired|monster)\.[a-z.]+$/, path: /./, title: ["h1"], company: [], description: ["[class*='job_description' i]", "[class*='jobDescription' i]", "[class*='job-description' i]", "[data-testid*='description' i]", "article"] },
];

var jpMatchKey = "";
var jpMatchTimer = null;
var jpMatchClosed = false;

function jpFirstText(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const text = el?.innerText?.trim();
    if (text) return text;
  }
  return "";
}

// The job shown on this page, or null if this isn't a job posting.
function jpJobOnPage() {
  const board = JP_BOARDS.find((b) => b.host.test(location.hostname) && b.path.test(location.pathname));
  if (board) {
    const description = jpFirstText(board.description).slice(0, 6000);
    const title = jpFirstText(board.title).split("\n")[0].slice(0, 200);
    if (!description || !title) return null;
    return { title, company: jpFirstText(board.company).split("\n")[0].slice(0, 120), description };
  }
  // Company career sites and ATS postings and applications.
  if (typeof looksLikeJobApplication !== "function") return null;
  if (!looksLikeJobApplication() && !jpLooksLikePosting()) return null;
  // Greenhouse, Lever, Ashby, … show the description above the form, so the
  // badge appears whenever the page has a real description (form open or not).
  const ctx = typeof scrapeJobContext === "function" ? scrapeJobContext() : null;
  const formOpen = typeof jpFormVisible === "function" && jpFormVisible();
  if (formOpen && ctx) {
    // With a form on the page, only a real description container counts —
    // never the whole page's text (that would score the form's labels).
    const ats = (typeof jpAtsJobContext === "function" && jpAtsJobContext()) || {};
    ctx.description = ats.description || scrapeJobDescription({ specificOnly: true });
  }
  if (!ctx?.description || ctx.description.length < 300) return null;
  return { title: ctx.title, company: ctx.company, description: ctx.description };
}

// A job posting on a company's own careers site (e.g. careers.example.com/jobs/123,
// where the application opens later or in an embedded form).
function jpLooksLikePosting() {
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].some((s) => /"JobPosting"/.test(s.textContent || ""));
  if (ld) return true;
  const url = location.pathname + location.search;
  if (!/(\/jobs?\/|\/careers?\/|\/positions?\/|\/openings?\/|\/vacanc|\/requisitions?\/|\/job-?details?|[?&](gh_jid|jobid|job_id|jid)=)/i.test(url)) return false;
  const apply = [...document.querySelectorAll("a, button, input[type='button'], input[type='submit']")].some((el) =>
    /^\s*apply\b/i.test(el.innerText || el.value || "") && el.getClientRects().length > 0);
  if (!apply) return false;
  return /(responsibilit|qualifications|requirements|what you('|’)ll do|about the role|you will|you'll|experience (with|in))/i.test(document.body?.innerText || "");
}

function jpRemoveBadge() {
  document.getElementById(JP_BADGE_ID)?.remove();
}

async function jpUpdateMatchBadge() {
  if (window !== window.top || jpMatchClosed) return;
  try { if (!chrome.runtime?.id) return; } catch { return; }
  const { matchBadgeEnabled, auth, resumes = [], uploadedResumeText } =
    await chrome.storage.local.get(["matchBadgeEnabled", "auth", "resumes", "uploadedResumeText"]);
  if (matchBadgeEnabled === false || !auth?.idToken || (!resumes.length && !uploadedResumeText)) return jpRemoveBadge();
  const job = jpJobOnPage();
  if (!job) return jpRemoveBadge();
  const key = `${job.title}|${job.description.length}|${resumes.length}`;
  if (key === jpMatchKey && document.getElementById(JP_BADGE_ID)) return;
  jpMatchKey = key;
  const pick = await chrome.runtime.sendMessage({
    type: "PICK_RESUME", noFetch: true, host: location.hostname, url: location.href, jobContext: job,
  }).catch(() => null);
  if (!pick?.scores?.length || !pick.scores.some((s) => s.informative)) return jpRemoveBadge();
  jpRenderBadge(job, pick);
}

function jpRenderBadge(job, pick) {
  jpRemoveBadge();
  const best = pick.scores[0];
  const host = document.createElement("div");
  host.id = JP_BADGE_ID;
  Object.assign(host.style, { all: "initial", position: "fixed", top: "84px", right: "18px", zIndex: "2147483646" });
  const root = host.attachShadow({ mode: "open" });
  const tone = best.score >= 70 ? "good" : best.score >= 45 ? "ok" : "low";
  root.innerHTML = `
    <style>
      .wrap { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1a1a2e; }
      .pill { display: flex; align-items: center; gap: 6px; background: #fff; border: 1px solid #e5e7eb; border-radius: 999px;
        padding: 6px 10px 6px 8px; box-shadow: 0 4px 14px rgba(0,0,0,.14); cursor: pointer; }
      .pct { font-weight: 700; border-radius: 999px; padding: 1px 8px; }
      .good .pct { background: #dcfce7; color: #166534; } .ok .pct { background: #fef3c7; color: #92400e; } .low .pct { background: #fee2e2; color: #991b1b; }
      .x { border: none; background: none; color: #94a3b8; cursor: pointer; font-size: 15px; padding: 0 0 0 2px; }
      .panel { margin-top: 6px; width: 290px; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 10px 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,.16); }
      .row { display: flex; justify-content: space-between; gap: 8px; margin: 3px 0; }
      .row b { font-weight: 600; }
      .muted { color: #64748b; font-size: 12px; }
      .skills { font-size: 12px; margin-top: 6px; }
      .hidden { display: none; }
      .tailor { margin-top: 8px; width: 100%; border: none; border-radius: 8px; padding: 7px; background: #4a3aff; color: #fff; font-weight: 600; cursor: pointer; }
    </style>
    <div class="wrap ${tone}">
      <div class="pill" role="button" tabindex="0" aria-expanded="false" title="Hiresprint resume match">
        <span>⚡</span><span class="pct"></span><span class="name"></span><button class="x" aria-label="Hide match">×</button>
      </div>
      <div class="panel hidden">
        <div class="muted">Resume match for this job</div>
        <div class="scores"></div>
        <div class="skills matched"></div>
        <div class="skills missing"></div>
        <button class="tailor" type="button">✨ Tailor my resume for this job</button>
      </div>
    </div>`;
  root.querySelector(".pct").textContent = `${best.score}% match`;
  root.querySelector(".name").textContent = pick.scores.length > 1 ? `· ${best.name}` : "";
  const scores = root.querySelector(".scores");
  for (const s of pick.scores) {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement(s === best ? "b" : "span");
    name.textContent = s.name || "Resume";
    const pct = document.createElement("span");
    pct.textContent = `${s.score}%`;
    row.append(name, pct);
    scores.appendChild(row);
  }
  if (best.matched?.length) root.querySelector(".matched").textContent = `✓ ${best.matched.slice(0, 8).join(", ")}`;
  if (best.missing?.length) root.querySelector(".missing").textContent = `✗ Not on your resume: ${best.missing.slice(0, 6).join(", ")}`;
  const pill = root.querySelector(".pill");
  const panel = root.querySelector(".panel");
  const toggle = () => {
    panel.classList.toggle("hidden");
    pill.setAttribute("aria-expanded", String(!panel.classList.contains("hidden")));
  };
  pill.addEventListener("click", (e) => { if (!e.target.closest(".x")) toggle(); });
  pill.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  root.querySelector(".x").addEventListener("click", () => { jpMatchClosed = true; jpRemoveBadge(); });
  root.querySelector(".tailor").addEventListener("click", async () => {
    await chrome.storage.local.set({ pendingTailor: { url: location.href, at: Date.now() } });
    chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" }).catch(() => {});
  });
  document.documentElement.appendChild(host);
}

function jpScheduleMatch() {
  // Throttle (not debounce): busy pages like LinkedIn change constantly.
  if (jpMatchTimer) return;
  jpMatchTimer = setTimeout(() => {
    jpMatchTimer = null;
    jpUpdateMatchBadge().catch(() => {});
  }, 1200);
}

if (window === window.top && typeof MutationObserver === "function") {
  // Job boards swap the selected job without a page load; watch for changes.
  new MutationObserver(jpScheduleMatch).observe(document.documentElement, { childList: true, subtree: true });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ("matchBadgeEnabled" in changes || "resumes" in changes)) { jpMatchKey = ""; jpScheduleMatch(); }
  });
  jpScheduleMatch();
}
