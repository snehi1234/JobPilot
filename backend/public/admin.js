// admin.js — Hiresprint admin page: review and triage feedback reports.
// All report text is rendered with textContent (never as HTML).

const API = "/api/admin-feedback";
const TOKEN_KEY = "hs_admin_token";
const TYPES = {
  bug: "🐞 Bug", "wrong-answer": "✏️ Wrong answer", site: "🌐 Site not supported", idea: "💡 Idea", other: "💬 Other",
};
const STATUSES = { new: "New", "in-progress": "In progress", fixed: "Fixed", "wont-fix": "Won't fix" };

const $ = (id) => document.getElementById(id);
let reports = [];
let statusFilter = "new";

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function decodeJwt(token) {
  try {
    return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

function getToken() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const claims = token && decodeJwt(token);
  if (!claims || claims.exp * 1000 < Date.now() + 30000) {
    sessionStorage.removeItem(TOKEN_KEY);
    return null;
  }
  return token;
}

function showGate(message = "") {
  $("gate").classList.remove("hidden");
  $("app").classList.add("hidden");
  $("refresh").classList.add("hidden");
  $("signout").classList.add("hidden");
  $("who").textContent = "";
  $("gateError").textContent = message;
}

async function api(method, body, query = "") {
  const token = getToken();
  if (!token) {
    showGate("Your session expired. Please sign in again.");
    throw new Error("signed out");
  }
  const res = await fetch(API + query, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    showGate("Your session expired. Please sign in again.");
    throw new Error("signed out");
  }
  if (res.status === 403) {
    sessionStorage.removeItem(TOKEN_KEY);
    showGate("This Google account isn't an admin of Hiresprint.");
    throw new Error("forbidden");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function load() {
  $("refresh").disabled = true;
  try {
    const data = await api("GET");
    reports = data.reports || [];
    $("gate").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("refresh").classList.remove("hidden");
    $("signout").classList.remove("hidden");
    $("who").textContent = data.admin || "";
    render();
    window.dispatchEvent(new Event("admin-loaded"));
  } catch (err) {
    if (!["signed out", "forbidden"].includes(err.message)) showGate(err.message);
  } finally {
    $("refresh").disabled = false;
  }
}

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

const siteHost = (r) => String(r.details?.site || "").split("/")[0];

function matches(r) {
  if (statusFilter && r.status !== statusFilter) return false;
  const type = $("typeFilter").value;
  if (type && r.type !== type) return false;
  const q = $("search").value.trim().toLowerCase();
  if (!q) return true;
  const d = r.details || {};
  return [r.message, d.site, d.lastError, d.version, (d.fields?.missing || []).join(" ")].join(" ").toLowerCase().includes(q);
}

function render() {
  // Status counts double as filters.
  const counts = { "": reports.length };
  for (const r of reports) counts[r.status] = (counts[r.status] || 0) + 1;
  $("stats").replaceChildren(
    ...[["new", "New"], ["in-progress", "In progress"], ["fixed", "Fixed"], ["wont-fix", "Won't fix"], ["", "All"]].map(([key, label]) =>
      el("button", { class: `stat${statusFilter === key ? " active" : ""}`, type: "button", onclick: () => { statusFilter = key; render(); } },
        [el("b", { text: String(counts[key] || 0) }), el("span", { text: label })]))
  );

  const shown = reports.filter(matches);
  $("list").replaceChildren(...(shown.length ? shown.map(card) : [el("div", { class: "empty", text: "No reports here. 🎉" })]));

  const weekAgo = Date.now() - 7 * 86400000;
  const tally = (items, key) => {
    const map = new Map();
    for (const r of items) { const k = key(r); if (k) map.set(k, (map.get(k) || 0) + 1); }
    return [...map].sort((a, b) => b[1] - a[1]).slice(0, 8);
  };
  const recentProblems = reports.filter((r) => new Date(r.createdAt).getTime() > weekAgo && r.type !== "idea");
  const top = tally(recentProblems, siteHost);
  $("topSites").replaceChildren(...(top.length ? top.map(([k, n]) => el("li", { text: `${k} — ${n}` })) : [el("li", { text: "None" })]));
  const versions = tally(reports, (r) => r.details?.version);
  $("versions").replaceChildren(...(versions.length ? versions.map(([k, n]) => el("li", { text: `v${k} — ${n}` })) : [el("li", { text: "—" })]));
}

function card(r) {
  const d = r.details || {};
  const f = d.fields || {};
  const meta = [
    d.site && `Page: ${d.site}`,
    (f.found != null || f.filled != null) && `Fields: ${f.found ?? "?"} found, ${f.filled ?? "?"} filled, ${f.needs ?? 0} left for the user`,
    f.missing?.length && `Not filled: ${f.missing.join(" · ")}`,
    d.lastError && `Last error: ${d.lastError}`,
    d.match && `Resume match: ${d.match}`,
    (d.attach || d.cover) && `Resume file: ${d.attach || "—"} · Cover letter: ${d.cover || "—"}`,
    d.browser && `Browser: ${d.browser}`,
  ].filter(Boolean);

  const actions = el("div", { class: "actions" }, Object.entries(STATUSES).map(([key, label]) =>
    el("button", { type: "button", class: r.status === key ? "on" : "", onclick: () => setStatus(r, key) , text: label })));
  if (/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(r.email || "")) {
    const subject = encodeURIComponent(`Re: your Hiresprint feedback (#${r.id})`);
    actions.append(el("a", { href: `mailto:${r.email}?subject=${subject}`, text: `✉ Reply to ${r.email}` }));
  }

  return el("article", { class: "card" }, [
    el("div", { class: "top" }, [
      el("span", { class: "type", text: TYPES[r.type] || r.type }),
      el("span", { text: `#${r.id}` }),
      siteHost(r) && el("span", { text: siteHost(r) }),
      d.version && el("span", { text: `v${d.version}` }),
      el("span", { text: timeAgo(r.createdAt), title: new Date(r.createdAt).toLocaleString() }),
      el("span", { class: `pill ${r.status}`, text: STATUSES[r.status] || r.status }),
    ]),
    el("div", { class: "msg", text: r.message }),
    meta.length ? el("div", { class: "meta" }, meta.map((line) => el("div", { text: line }))) : null,
    actions,
  ]);
}

async function setStatus(report, status) {
  if (report.status === status) return;
  const previous = report.status;
  report.status = status;
  render();
  try {
    const { report: saved } = await api("PATCH", { id: report.id, status });
    Object.assign(report, saved);
    render();
  } catch (err) {
    report.status = previous;
    render();
    if (!["signed out", "forbidden"].includes(err.message)) alert(`Couldn't update: ${err.message}`);
  }
}

function onCredential(response) {
  sessionStorage.setItem(TOKEN_KEY, response.credential);
  $("gateError").textContent = "";
  load();
}

async function init() {
  $("refresh").addEventListener("click", load);
  $("signout").addEventListener("click", () => {
    sessionStorage.removeItem(TOKEN_KEY);
    window.google?.accounts?.id?.disableAutoSelect();
    reports = [];
    showGate();
  });
  $("search").addEventListener("input", render);
  $("typeFilter").addEventListener("change", render);

  if (getToken()) load();

  const { clientId } = await fetch(`${API}?config=1`).then((r) => r.json()).catch(() => ({}));
  if (!clientId) {
    $("gateError").textContent = "Sign-in isn't configured on the server.";
    return;
  }
  const start = () => {
    google.accounts.id.initialize({ client_id: clientId, callback: onCredential, auto_select: true });
    google.accounts.id.renderButton($("signin"), { theme: "filled_blue", size: "large", text: "signin_with", shape: "pill" });
  };
  if (window.google?.accounts?.id) start();
  else {
    const wait = setInterval(() => {
      if (window.google?.accounts?.id) { clearInterval(wait); start(); }
    }, 200);
    setTimeout(() => {
      clearInterval(wait);
      if (!window.google?.accounts?.id) $("gateError").textContent = "Couldn't load Google sign-in. Check your connection or ad blocker.";
    }, 10000);
  }
}

init();
