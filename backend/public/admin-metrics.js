// admin-metrics.js — the Metrics tab. Uses api(), el(), and $ from admin.js.
// Numbers come from anonymous usage events plus account counts.

const FEATURE_LABELS = {
  install: "Installs", update: "Updates", uninstall: "Uninstalls", uninstall_reason: "Uninstall reasons given",
  panel_session: "Side panel opens", sign_in: "Sign-ins", resume_added: "Resumes added", autofill: "Autofills",
  tailor: "Resumes tailored", tailor_used: "Tailored resumes used", cover_letter: "AI cover letters",
  ats_check: "ATS checks", badge_tailor: "Tailor from job page", feedback: "Feedback sent",
  rate_prompt: "Rating prompt events", practice_open: "Practice form opened",
};
const REASONS = {
  site: "Didn't work on my job sites", answers: "Answers not good enough", setup: "Setup too much work",
  privacy: "Privacy concerns", found_job: "Found a job 🎉", other: "Something else",
};
const SECONDS_SAVED_PER_FIELD = 20;

let metricsDays = 30;
let metricsLoaded = false;

const fmt = (n) => (Number(n) || 0).toLocaleString();
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "—");

function kpi(label, value, sub) {
  return el("div", { class: "kpi" }, [el("b", { text: value }), el("span", { text: label }), sub ? el("small", { text: sub }) : null]);
}

function panel(title, children, note) {
  return el("div", { class: "panel" }, [el("h3", { text: title }), ...[].concat(children), note ? el("p", { class: "note", text: note }) : null]);
}

function bars(rows, { total, suffix = "" } = {}) {
  const max = total || Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return el("p", { class: "empty", text: "No data yet." });
  return el("div", { class: "bars" }, rows.map((r) => {
    const fill = el("div", { class: "fill" });
    fill.style.width = `${Math.max(2, (100 * r.value) / max)}%`;
    return el("div", { class: "bar" }, [
      el("span", { text: r.label }),
      el("div", { class: "track" }, [fill]),
      el("span", { class: "val", text: r.text ?? `${fmt(r.value)}${suffix}` }),
    ]);
  }));
}

function table(headers, rows) {
  if (!rows.length) return el("p", { class: "empty", text: "No data yet." });
  const head = el("tr", {}, headers.map((h, i) => el("th", { class: i ? "n" : "", text: h })));
  return el("table", { class: "t" }, [
    el("thead", {}, [head]),
    el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c, i) => el("td", { class: i ? "n" : "", text: String(c) }))))),
  ]);
}

// Daily chart: active users and autofills as lines, installs as bars.
function dailyChart(daily) {
  const NS = "http://www.w3.org/2000/svg";
  const W = 600, H = 180, P = 24;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Daily active users, autofills, and installs");
  const n = daily.length;
  const max = Math.max(1, ...daily.map((d) => Math.max(d.active, d.autofills, d.installs)));
  const x = (i) => P + (n <= 1 ? 0 : (i * (W - 2 * P)) / (n - 1));
  const y = (v) => H - P - (v * (H - 2 * P)) / max;
  const add = (tag, attrs) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.appendChild(node);
    return node;
  };
  add("line", { x1: P, y1: H - P, x2: W - P, y2: H - P, stroke: "#e5e7eb" });
  const t = add("text", { x: 2, y: P, "font-size": 10, fill: "#64748b" });
  t.textContent = String(max);
  const bw = Math.max(2, (W - 2 * P) / Math.max(1, n) - 3);
  daily.forEach((d, i) => {
    if (d.installs) add("rect", { x: x(i) - bw / 2, y: y(d.installs), width: bw, height: H - P - y(d.installs), fill: "#c7d2fe" });
  });
  const line = (key, color) => add("polyline", {
    points: daily.map((d, i) => `${x(i)},${y(d[key])}`).join(" "), fill: "none", stroke: color, "stroke-width": 2,
  });
  line("autofills", "#16a34a");
  line("active", "#4a3aff");
  [0, Math.floor((n - 1) / 2), n - 1].filter((i, k, a) => n && a.indexOf(i) === k).forEach((i) => {
    const label = add("text", { x: x(i), y: H - 6, "font-size": 10, fill: "#64748b", "text-anchor": "middle" });
    label.textContent = String(daily[i].d).slice(5);
  });
  const legend = el("div", { class: "legend" }, [
    el("span", {}, [el("i", { style: "background:#4a3aff" }), "Active users"]),
    el("span", {}, [el("i", { style: "background:#16a34a" }), "Autofills"]),
    el("span", {}, [el("i", { style: "background:#c7d2fe" }), "Installs"]),
  ]);
  return el("div", { class: "chart" }, [svg, legend]);
}

function renderMetrics(m) {
  const root = $("metrics");
  root.textContent = "";
  const t = m.totals || {};
  const s = m.sessions || {};
  const e = m.engagement || {};
  const f = m.funnel || {};
  const hoursSaved = ((t.fieldsFilled || 0) * SECONDS_SAVED_PER_FIELD) / 3600;
  $("metricsUpdated").textContent = `Updated ${new Date(m.generatedAt).toLocaleString()}`;

  root.append(el("div", { class: "kpis" }, [
    kpi("Accounts", fmt(t.accounts), `${fmt(t.accountsWithResume)} with a resume`),
    kpi("Installs tracked", fmt(t.installs), `${fmt(t.seenInstalls)} seen · ${fmt(t.uninstalls)} uninstalled`),
    kpi("Daily active", fmt(t.dau), "last 24 hours"),
    kpi("Weekly active", fmt(t.wau), "last 7 days"),
    kpi("Monthly active", fmt(t.mau), `stickiness (DAU/MAU) ${pct(t.dau, t.mau)}`),
    kpi(`Autofills · ${m.days}d`, fmt(t.autofills), `${fmt(t.fieldsFilled)} fields filled`),
    kpi("Time saved (est.)", `${hoursSaved.toFixed(1)} h`, `~${SECONDS_SAVED_PER_FIELD}s per field`),
    kpi("Panel session", `${s.medianMinutes || 0} min`, `median · avg ${s.avgMinutes || 0} min · ${fmt(s.count)} sessions`),
    kpi("Active days / user", String(e.avgActiveDays || 0), `${fmt(e.returningUsers)} of ${fmt(e.activeUsers)} came back 2+ days`),
    kpi("AI requests this month", fmt(t.aiRequestsThisMonth), "all users combined"),
  ]));

  root.append(panel(`Daily activity · last ${m.days} days`, dailyChart(m.daily || [])));

  root.append(el("div", { class: "grid2" }, [
    panel(`Activation funnel · installs in last ${m.days} days`, bars([
      { label: "Installed", value: f.installed || 0 },
      { label: "Signed in", value: f.signedIn || 0, text: `${fmt(f.signedIn)} · ${pct(f.signedIn, f.installed)}` },
      { label: "Added resume", value: f.addedResume || 0, text: `${fmt(f.addedResume)} · ${pct(f.addedResume, f.installed)}` },
      { label: "First autofill", value: f.firstAutofill || 0, text: `${fmt(f.firstAutofill)} · ${pct(f.firstAutofill, f.installed)}` },
      { label: "Came back later", value: f.returned || 0, text: `${fmt(f.returned)} · ${pct(f.returned, f.installed)}` },
      { label: "Uninstalled", value: f.uninstalled || 0, text: `${fmt(f.uninstalled)} · ${pct(f.uninstalled, f.installed)}` },
    ], { total: Math.max(1, f.installed || 0) }), "The biggest drop between two steps is where to improve first."),
    panel("Weekly retention", table(
      ["Install week", "Installs", "Active week 2", "Active week 3"],
      (m.retention || []).filter((r) => r.installs).reverse()
        .map((r) => [r.week, fmt(r.installs), `${fmt(r.week1)} (${pct(r.week1, r.installs)})`, `${fmt(r.week2)} (${pct(r.week2, r.installs)})`]),
    ), "Share of each week's new installs still using Hiresprint 7–14 and 14–21 days later."),
  ]));

  root.append(el("div", { class: "grid2" }, [
    panel(`Feature usage · last ${m.days} days`, table(
      ["Feature", "Times used", "Users"],
      (m.features || []).filter((r) => !["install", "update", "uninstall", "uninstall_reason"].includes(r.name))
        .map((r) => [FEATURE_LABELS[r.name] || r.name, fmt(r.events), fmt(r.users)]),
    )),
    panel(`Autofills by job site · last ${m.days} days`, table(
      ["Site", "Autofills", "Users", "Avg fields"],
      (m.platforms || []).map((r) => [r.platform, fmt(r.fills), fmt(r.users), r.avgFields ?? "—"]),
    )),
  ]));

  const reasons = Object.entries(m.uninstallReasons || {}).sort((a, b) => b[1] - a[1]);
  const rate = m.ratePrompt || {};
  root.append(el("div", { class: "grid2" }, [
    panel("Why people uninstalled", bars(reasons.map(([k, v]) => ({ label: REASONS[k] || k, value: v })))),
    panel("Rating prompt", bars([
      { label: "Shown", value: rate.shown || 0 },
      { label: "Clicked Rate", value: rate.rate || 0, text: `${fmt(rate.rate)} · ${pct(rate.rate, rate.shown)}` },
      { label: "Later", value: rate.later || 0 },
      { label: "Not really", value: rate.feedback || 0 },
      { label: "Don't ask again", value: rate.never || 0 },
    ], { total: Math.max(1, rate.shown || 0) }), `ATS checks: ${fmt(m.atsScores?.checks)} · average score ${m.atsScores?.avgScore || 0}/100`),
  ]));

  root.append(panel("Active versions · last 7 days", table(
    ["Version", "Users"], (m.versions || []).map((r) => [r.version, fmt(r.users)]),
  ), "Store-side numbers (installs from the store page, impressions, weekly users, ratings) are in the Chrome Web Store dashboard → Analytics."));
}

async function loadMetrics() {
  if (!getToken()) return;
  const root = $("metrics");
  if (!metricsLoaded) root.replaceChildren(el("p", { class: "empty", text: "Loading metrics…" }));
  try {
    const data = await api("GET", null, `?view=metrics&days=${metricsDays}`);
    metricsLoaded = true;
    renderMetrics(data.metrics || {});
  } catch (err) {
    if (!["signed out", "forbidden"].includes(err.message)) {
      root.replaceChildren(el("p", { class: "error", text: `Couldn't load metrics: ${err.message}` }));
    }
  }
}

function showTab(id) {
  document.querySelectorAll(".tab").forEach((b) => {
    const on = b.dataset.tab === id;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  });
  $("feedbackView").classList.toggle("hidden", id !== "feedbackView");
  $("metricsView").classList.toggle("hidden", id !== "metricsView");
  if (id === "metricsView") loadMetrics();
}

document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
$("metricsDays").addEventListener("change", () => {
  metricsDays = Number($("metricsDays").value) || 30;
  loadMetrics();
});
$("refresh").addEventListener("click", () => {
  if (!$("metricsView").classList.contains("hidden")) loadMetrics();
});
window.addEventListener("admin-loaded", () => {
  if (!$("metricsView").classList.contains("hidden")) loadMetrics();
});
if (location.hash === "#metrics") showTab("metricsView");
