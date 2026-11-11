// content-ui.js — on-page assistance shown after autofill. Loaded before
// content.js in the same isolated world, so both share these globals.
//
//   • Colour-codes filled fields by where the answer came from.
//   • Records the previous state of every field so the fill can be undone.
//   • Shows a checklist: what was filled, AI answers to review, fields that
//     need the user, the resume used, and whether the file was attached.
//   • Learns from the user's corrections to autofilled answers.
//   • Attaches the selected resume file to resume/CV upload fields.
//   • Keeps a short session so multi-step forms continue on the next step.

var JP_MARK_ATTR = "data-jobpilot-source";
var JP_MARK_STYLE = {
  profile: { color: "#16a34a", title: "Filled from your Hiresprint profile" },
  memory: { color: "#16a34a", title: "Filled from an answer you've used before" },
  correction: { color: "#16a34a", title: "Filled with the answer you chose last time" },
  ai: { color: "#2563eb", title: "AI answer — please check it" },
  draft: { color: "#2563eb", title: "AI draft — please review and personalize" },
  library: { color: "#2563eb", title: "From your saved answers — please personalize" },
  needs: { color: "#d97706", title: "Hiresprint couldn't fill this — please complete it" },
};
var JP_SESSION_KEY = "jobpilot_session";
var JP_SESSION_MS = 30 * 60 * 1000;

var jpUndoStack = [];
var jpFillRecords = new Map(); // field id → { source, label, el, kind }
var jpFieldsById = new Map(); // field id → detected field descriptor
var jpCurrentResume = null; // { resumeId, name, scores, ... }
var jpLastJobContext = null;
var jpChecklistState = null;
var jpSeenInputs = new WeakSet(); // fields present at the last scan

// ---------- Highlights ----------

function jpHighlightTarget(el) {
  if (!el) return null;
  if (el.type === "radio" || el.type === "checkbox") {
    return el.closest("[role='radiogroup'], fieldset") || el.closest("label") || el.parentElement;
  }
  if (el.getAttribute?.("role") === "combobox") return el.closest("[class*='inputContainer'], [class*='control']") || el;
  return el;
}

function jpMark(el, source) {
  const target = jpHighlightTarget(el);
  const style = JP_MARK_STYLE[source];
  if (!target || !style) return;
  if (!target.hasAttribute(JP_MARK_ATTR)) {
    target.dataset.jobpilotPrevOutline = target.style.outline || "";
    target.dataset.jobpilotPrevOffset = target.style.outlineOffset || "";
    target.dataset.jobpilotPrevTitle = target.getAttribute("title") ?? "";
  }
  target.setAttribute(JP_MARK_ATTR, source);
  target.style.outline = `2px solid ${style.color}`;
  target.style.outlineOffset = "2px";
  target.setAttribute("title", style.title);
}

function jpUnmark(el) {
  const target = el?.hasAttribute?.(JP_MARK_ATTR) ? el : jpHighlightTarget(el);
  if (!target?.hasAttribute?.(JP_MARK_ATTR)) return;
  target.style.outline = target.dataset.jobpilotPrevOutline || "";
  target.style.outlineOffset = target.dataset.jobpilotPrevOffset || "";
  const title = target.dataset.jobpilotPrevTitle;
  if (title) target.setAttribute("title", title); else target.removeAttribute("title");
  target.removeAttribute(JP_MARK_ATTR);
  delete target.dataset.jobpilotPrevOutline;
  delete target.dataset.jobpilotPrevOffset;
  delete target.dataset.jobpilotPrevTitle;
}

function jpClearMarks() {
  for (const el of jpQueryAll(`[${JP_MARK_ATTR}]`)) jpUnmark(el);
}

// ---------- Undo ----------

function jpNativeSet(el, value) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype
    : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// Record how a field looked before we change it.
function jpSnapshot(kind, el, group) {
  if (kind === "radio") {
    const previous = (group || []).find((r) => r.checked) || null;
    jpUndoStack.push(() => {
      if (previous) { if (!previous.checked) previous.click(); }
      else for (const r of group || []) if (r.checked) { r.checked = false; r.dispatchEvent(new Event("change", { bubbles: true })); }
    });
  } else if (kind === "checkbox") {
    const was = el.checked;
    jpUndoStack.push(() => { if (el.checked !== was) el.click(); });
  } else if (kind === "file") {
    jpUndoStack.push(() => {
      try { el.value = ""; } catch { /* some sites lock the input */ }
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  } else if (el && "value" in el) {
    const was = el.value;
    jpUndoStack.push(() => { if (el.value !== was) jpNativeSet(el, was); });
  }
}

function jpUndoAll() {
  const steps = jpUndoStack.reverse();
  jpUndoStack = [];
  let undone = 0;
  for (const step of steps) {
    try { step(); undone++; } catch (err) { console.warn("[Hiresprint] Undo step failed:", err.message); }
  }
  jpClearMarks();
  jpFillRecords.clear();
  jpCoverLetter = null;
  jpHideChecklist();
  jpToast(`Undid ${undone} change${undone === 1 ? "" : "s"}.`, "info");
}

// ---------- Learning from corrections ----------

function jpFieldIdFor(el) {
  const tagged = el.closest?.(`[${FIELD_ATTR}]`) || (el.hasAttribute?.(FIELD_ATTR) ? el : null);
  if (tagged) return tagged.getAttribute(FIELD_ATTR);
  return el.getAttribute?.(GROUP_ATTR) || null;
}

function jpCurrentValue(id, el) {
  const meta = fieldRegistry[id];
  if (!meta) return "";
  if (meta.kind === "radio") {
    const checked = jpQueryAll(`[${GROUP_ATTR}="${CSS.escape(id)}"]`).find((r) => r.checked);
    return checked ? getLabelForElement(checked) : "";
  }
  if (meta.kind === "checkbox") return el.checked ? "Yes" : "No";
  if (el.tagName === "SELECT") return el.selectedOptions?.[0]?.textContent?.trim() || "";
  return el.value || "";
}

var jpLearnTimers = new Map();
function jpOnUserEdit(event) {
  if (!event.isTrusted) return;
  const el = event.target;
  const id = jpFieldIdFor(el);
  if (!id || !jpFillRecords.has(id)) return;
  const record = jpFillRecords.get(id);
  clearTimeout(jpLearnTimers.get(id));
  jpLearnTimers.set(id, setTimeout(() => {
    const value = jpCurrentValue(id, el);
    if (!value || value === record.value) return;
    record.value = value;
    record.source = "correction";
    jpMark(record.el || el, "correction");
    const field = jpFieldsById.get(id);
    if (field) {
      chrome.runtime.sendMessage({ type: "LEARN_ANSWER", field, value, resumeId: jpCurrentResume?.resumeId })
        .catch(() => {});
    }
    if (jpChecklistState) jpRenderChecklist();
  }, 600));
}

for (const type of ["change", "focusout"]) document.addEventListener(type, jpOnUserEdit, true);

// ---------- Resume file attachment ----------

var jpNormalize = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// What a file input is for, judged by its own attributes and then by the
// nearest surrounding text: "resume", "parser" (a site's own "autofill from
// resume" box, which would overwrite fields), or "other" (cover letter,
// transcript, …). Accents are ignored so "Résumé" matches.
function jpFileInputPurpose(input) {
  const own = jpNormalize([input.name, input.id, input.getAttribute("aria-label"), input.getAttribute("data-testid")].join(" "));
  if (/cover|motivation/.test(own)) return "cover";
  if (/transcript|portfolio/.test(own)) return "other";
  if (/resume|\bcv\b|curriculum/.test(own)) return "resume";
  let el = input;
  for (let depth = 0; depth < 6 && el?.parentElement; depth++) {
    el = el.parentElement;
    const text = jpNormalize(el.textContent).slice(0, 400);
    if (/autofill|auto-fill/.test(text)) return "parser";
    // The keyword nearest the start of the field's text names the field.
    const found = [
      ["resume", text.search(/resume|\bcv\b|curriculum vitae/)],
      ["cover", text.search(/cover(ing)? letter|motivation(al)? letter|letter of (motivation|interest)/)],
      ["other", text.search(/transcript|portfolio|writing sample|other (documents?|files?)|additional (documents?|files?)/)],
    ].filter(([, at]) => at >= 0).sort((a, b) => a[1] - b[1]);
    if (found.length) return found[0][0];
  }
  return "unknown";
}

function jpResumeFileInputs() {
  return jpQueryAll("input[type='file']").filter((input) => jpFileInputPurpose(input) === "resume");
}

function jpBase64ToFile({ name, type, data }) {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new File([bytes], name, { type: type || "application/octet-stream" });
}

// Upload widgets usually show the full file name once they accept a file.
function jpUploadShowsFile(input, name) {
  const wanted = jpNormalize(name);
  if (!wanted) return false;
  let el = input;
  for (let depth = 0; depth < 4 && el?.parentElement; depth++) {
    el = el.parentElement;
    if (jpNormalize(el.textContent).includes(wanted)) return true;
  }
  return false;
}

// Returns "attached" | "unavailable" (no stored file) | "none" (no field) | "blocked".
async function jpAttachResume(resumeId) {
  const inputs = jpResumeFileInputs();
  if (!inputs.length) return "none";
  const input = inputs[0];
  const stored = await chrome.runtime.sendMessage({ type: "GET_RESUME_FILE", resumeId }).catch(() => null);
  if (!stored?.data) return input.files?.length ? "attached" : "unavailable";
  if (input.files?.length || jpUploadShowsFile(input, stored.name)) return "attached";
  return jpAttachFile(input, jpBase64ToFile(stored));
}

// Put a file into an upload field the way the site expects. With `replace`,
// an existing file is swapped (e.g. after editing the cover letter).
async function jpAttachFile(input, file, { replace = false } = {}) {
  if (!replace && (input.files?.length || jpUploadShowsFile(input, file.name))) return "attached";
  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    jpSnapshot("file", input);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    if (jpUploadShowsFile(input, file.name)) return "attached";
    // Some drop zones ignore the input's change event; drop the file on them.
    const zone = input.closest("[class*='drop' i], [class*='upload' i], [role='button'], label") || input.parentElement;
    if (zone) {
      const drop = new DataTransfer();
      drop.items.add(file);
      for (const type of ["dragenter", "dragover", "drop"]) {
        zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: drop }));
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    return jpUploadShowsFile(input, file.name) || input.files?.length ? "attached" : "blocked";
  } catch (err) {
    console.warn("[Hiresprint] Could not attach file:", err.message);
    return "blocked";
  }
}

// ---------- Cover letter ----------

var JP_COVER_LABEL = /cover(ing)? letter|motivation(al)? letter|letter of (motivation|interest)/i;
var jpCoverLetter = null; // { mode, text, how: "pasted" | "attached", el }

function jpCoverTargets() {
  const files = jpQueryAll("input[type='file']").filter((input) => jpFileInputPurpose(input) === "cover");
  const texts = [];
  for (const [id, field] of jpFieldsById) {
    if (!JP_COVER_LABEL.test(field.label || "") || !(field.kind === "text" || field.tag === "textarea")) continue;
    const el = fieldRegistry[id] ? jpResolveField(id, fieldRegistry[id]) : null;
    if (el) texts.push({ id, el, label: field.label });
  }
  return { files, texts };
}

// Turns plain text into a simple one-column PDF (Helvetica, US Letter).
function jpTextToPdf(text, fileName) {
  const clean = String(text || "")
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...").replace(/\u00a0/g, " ").normalize("NFKD").replace(/[^\x20-\x7e\n]/g, "");
  const lines = [];
  for (const paragraph of clean.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if ((line + " " + word).trim().length > 84) { lines.push(line); line = word; } else line = (line + " " + word).trim();
    }
    lines.push(line);
  }
  const perPage = 44;
  const pages = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"];
  const kids = [];
  for (const page of pages) {
    const stream = `BT /F1 11 Tf 15 TL 72 720 Td ${page.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length} 0 R >>`);
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new File([pdf], fileName, { type: "application/pdf" });
}

function jpCoverFileName(name) {
  const company = String(jpLastJobContext?.company || "").replace(/^.* @ /, "");
  return `${[name, "Cover Letter", company].filter(Boolean).join(" - ").replace(/[\\/:*?"<>|]+/g, "").slice(0, 100)}.pdf`;
}

// Paste the letter into a cover-letter text box, or attach it as a PDF.
async function jpPlaceCoverLetter(text, { file, replace = false } = {}) {
  const { files, texts } = jpCoverTargets();
  if (texts.length) {
    const { el, id, label } = texts[0];
    jpSnapshot("value", el);
    fillText(el, text);
    jpFillRecords.set(id, { source: jpCoverLetter?.mode === "file" ? "profile" : "draft", label, el, value: text, kind: "text" });
    jpMark(el, jpCoverLetter?.mode === "file" ? "profile" : "draft");
    return { how: "pasted", status: "added" };
  }
  if (files.length) {
    const { structured } = await chrome.storage.local.get("structured");
    const name = [structured?.firstName, structured?.lastName].filter(Boolean).join(" ");
    const result = await jpAttachFile(files[0], file || jpTextToPdf(text, jpCoverFileName(name)), { replace });
    return { how: "attached", status: result === "attached" ? "added" : "blocked" };
  }
  return { status: "none" };
}

// Add a cover letter when the form asks for one, following the user's choice
// in the panel: their own file, an AI letter for this job, or nothing.
async function jpHandleCoverLetter() {
  const { files, texts } = jpCoverTargets();
  if (!files.length && !texts.length) return null;
  const { coverLetterMode = "off" } = await chrome.storage.local.get("coverLetterMode");
  if (coverLetterMode === "file") {
    const stored = await chrome.runtime.sendMessage({ type: "GET_COVER_LETTER_FILE" }).catch(() => null);
    if (!stored?.data) return { status: "missing" };
    jpCoverLetter = { mode: "file", text: stored.text || "" };
    if (texts.length && !stored.text) return { status: "missing-text" };
    return { ...(await jpPlaceCoverLetter(stored.text || "", { file: texts.length ? null : jpBase64ToFile(stored) })), mode: "file" };
  }
  if (coverLetterMode !== "ai") return { status: "off" };
  const { profile, structured, uploadedResumeText } = await chrome.storage.local.get(["profile", "structured", "uploadedResumeText"]);
  const result = await chrome.runtime.sendMessage({
    type: "WRITE_COVER_LETTER",
    jobContext: jpLastJobContext,
    url: location.href,
    resumeId: jpCurrentResume?.resumeId,
    structured,
    profile: [profile, jpCurrentResume?.text || uploadedResumeText].filter(Boolean).join("\n\n"),
  }).catch((err) => ({ error: err.message }));
  if (result?.error || !result?.letter) return { status: "error", message: result?.error || "No letter was returned." };
  jpCoverLetter = { mode: "ai", text: result.letter };
  return { ...(await jpPlaceCoverLetter(result.letter)), mode: "ai" };
}

// Edit the letter in a small dialog, then paste or re-attach it.
function jpEditCoverLetter() {
  if (!jpCoverLetter?.text) return;
  const host = document.createElement("div");
  host.id = "jobpilot-cover-editor";
  Object.assign(host.style, { all: "initial", position: "fixed", inset: "0", zIndex: "2147483647" });
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      .back { position: fixed; inset: 0; background: rgba(15,23,42,.45); display: flex; align-items: center; justify-content: center; }
      .box { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #fff; color: #1a1a2e;
        width: min(640px, 92vw); border-radius: 12px; padding: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.3); }
      textarea { width: 100%; height: 50vh; box-sizing: border-box; font: 13px/1.5 Georgia, serif; padding: 10px; border: 1px solid #cbd5e1; border-radius: 8px; }
      .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
      button { border: none; border-radius: 8px; padding: 8px 14px; font-weight: 600; cursor: pointer; }
      .cancel { background: #e2e8f0; } .save { background: #4a3aff; color: #fff; } .count { margin-right: auto; color: #64748b; align-self: center; }
    </style>
    <div class="back"><div class="box" role="dialog" aria-label="Edit cover letter">
      <b>Cover letter</b>
      <textarea aria-label="Cover letter text"></textarea>
      <div class="row"><span class="count"></span><button class="cancel">Cancel</button><button class="save">Save & use</button></div>
    </div></div>`;
  const area = root.querySelector("textarea");
  const count = root.querySelector(".count");
  area.value = jpCoverLetter.text;
  const updateCount = () => (count.textContent = `${area.value.split(/\s+/).filter(Boolean).length} words`);
  area.addEventListener("input", updateCount);
  updateCount();
  root.querySelector(".cancel").onclick = () => host.remove();
  root.querySelector(".save").onclick = async () => {
    const text = area.value.trim();
    host.remove();
    if (!text) return;
    jpCoverLetter.text = text;
    if (jpCoverLetter.mode === "ai") {
      chrome.runtime.sendMessage({
        type: "SAVE_COVER_LETTER", jobContext: jpLastJobContext, url: location.href, resumeId: jpCurrentResume?.resumeId, letter: text,
      }).catch(() => {});
    }
    const placed = await jpPlaceCoverLetter(text, { replace: true });
    if (jpChecklistState) {
      jpChecklistState.cover = { ...placed, mode: jpCoverLetter.mode };
      jpRenderChecklist();
    }
    jpToast(placed.status === "added" ? "Cover letter updated." : "Couldn't update the cover letter on this page.", placed.status === "added" ? "success" : "note");
  };
  document.documentElement.appendChild(host);
  area.focus();
}

// ---------- Multi-step session ----------

function jpSaveSession(resume) {
  try {
    sessionStorage.setItem(JP_SESSION_KEY, JSON.stringify({ resumeId: resume?.resumeId, name: resume?.name, at: Date.now() }));
  } catch { /* storage may be blocked on some sites */ }
}

function jpLoadSession() {
  try {
    const session = JSON.parse(sessionStorage.getItem(JP_SESSION_KEY) || "null");
    return session && Date.now() - session.at < JP_SESSION_MS ? session : null;
  } catch {
    return null;
  }
}

var jpStepObserver = null;
var jpStepTimer = null;
var jpStepOffered = false;

function jpUntaggedEmptyFields() {
  return jpQueryAll("input, textarea, select").filter((el) => {
    if (jpSeenInputs.has(el) || el.hasAttribute(FIELD_ATTR) || el.hasAttribute(GROUP_ATTR)) return false;
    if (["hidden", "submit", "button", "file", "image", "reset"].includes((el.type || "").toLowerCase())) return false;
    if (!isVisible(el)) return false;
    return el.type === "radio" || el.type === "checkbox" ? !el.checked : !el.value;
  });
}

// Watch for the next step of a multi-page application (same page, new fields).
function jpWatchForNextStep() {
  if (jpStepObserver || !document.body) return;
  jpStepObserver = new MutationObserver(() => {
    if (jpStepOffered || jpAutofillInProgress) return;
    clearTimeout(jpStepTimer);
    jpStepTimer = setTimeout(jpCheckNextStep, 900);
  });
  jpStepObserver.observe(document.body, { childList: true, subtree: true });
}

async function jpCheckNextStep() {
  if (jpStepOffered || jpAutofillInProgress || !jpLoadSession()) return;
  if (jpUntaggedEmptyFields().length < 2) return;
  jpStepOffered = true; // cleared by the next field scan (detectFields)
  jpHideChecklist(); // it describes the previous step and would cover the prompt
  const { autoFillEnabled } = await chrome.storage.local.get("autoFillEnabled");
  if (autoFillEnabled === true) {
    jpToast("Next step detected — continuing autofill…", "info");
    await runAutofillFromButton(true);
  } else {
    jpToast("Next step detected.", "info", { label: "Fill this step", run: () => runAutofillFromButton(false) });
  }
}

// ---------- Checklist panel ----------

var JP_PANEL_ID = "jobpilot-checklist";

function jpHideChecklist() {
  document.getElementById(JP_PANEL_ID)?.remove();
  jpChecklistState = null;
}

function jpShowChecklist(state) {
  jpChecklistState = state;
  jpRenderChecklist();
}

function jpFocusField(id) {
  const record = jpFillRecords.get(id);
  const meta = fieldRegistry[id];
  const el = record?.el || (meta ? jpResolveField(id, meta) : null) ||
    jpQueryOne(`[${GROUP_ATTR}="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  if (typeof el.focus === "function") el.focus({ preventScroll: true });
}

function jpRenderChecklist() {
  const state = jpChecklistState;
  if (!state) return;
  document.getElementById(JP_PANEL_ID)?.remove();
  const host = document.createElement("div");
  host.id = JP_PANEL_ID;
  Object.assign(host.style, { all: "initial", position: "fixed", right: "20px", bottom: "80px", zIndex: "2147483647" });
  const root = host.attachShadow({ mode: "open" });
  const records = [...jpFillRecords.entries()].map(([id, r]) => ({ id, ...r }));
  const known = records.filter((r) => ["profile", "memory", "correction"].includes(r.source));
  const review = records.filter((r) => ["ai", "draft", "library"].includes(r.source));
  const needs = state.needs || [];
  const short = (text) => {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    return t.length > 60 ? `${t.slice(0, 57)}…` : t;
  };
  const resume = jpCurrentResume;
  const chosenScore = resume?.scores?.find((s) => s.id === resume.resumeId);
  const scoreText = !chosenScore ? ""
    : chosenScore.informative ? ` · ${chosenScore.score}% match` : " · couldn't find the job description to score";
  const skillsText = chosenScore?.informative
    ? [chosenScore.matched?.length ? `✓ ${chosenScore.matched.slice(0, 5).join(", ")}` : "",
       chosenScore.missing?.length ? `✗ ${chosenScore.missing.slice(0, 4).join(", ")}` : ""].filter(Boolean).join("<br>")
    : "";
  const attach = {
    attached: "📎 Resume file attached",
    unavailable: "📎 Your resume file isn't saved in Hiresprint yet. Attach it here, or open Hiresprint → Your Resumes → Replace once to attach it automatically next time.",
    blocked: "📎 This site blocked automatic upload — attach your resume manually",
    none: "",
  }[state.attach || "none"];
  const cover = state.cover;
  const coverText = !cover ? "" : ({
    writing: "📝 Writing a cover letter for this job…",
    added: `📝 Cover letter ${cover.how === "pasted" ? "pasted" : "attached"} (${cover.mode === "ai" ? "AI-written for this job — review it" : "your file"})`,
    blocked: "📝 This site blocked the cover letter upload — attach it manually",
    off: "📝 This job asks for a cover letter. To add one automatically, choose AI-written or your own file under Cover letter in Hiresprint.",
    missing: "📝 Upload your cover letter file in Hiresprint (Cover letter section) to add it automatically.",
    "missing-text": "📝 This job wants the cover letter as text, but your file's text couldn't be read. Paste it yourself.",
    error: `📝 Couldn't write a cover letter: ${cover.message || "please try again."}`,
  }[cover.status] || "");
  root.innerHTML = `
    <style>
      .panel { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1a1a2e;
        width: 320px; max-height: 70vh; overflow: auto; background: #fff; border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0,0,0,.22); padding: 12px 14px; }
      .head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; margin-bottom: 8px; }
      .close { border: none; background: none; font-size: 18px; cursor: pointer; color: #64748b; }
      .row { margin: 6px 0; }
      .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
      ul { margin: 4px 0 0 0; padding-left: 18px; }
      li { margin: 3px 0; }
      a { color: #2563eb; cursor: pointer; text-decoration: underline; }
      .mini { border: 1px solid #cbd5e1; background: #f8fafc; border-radius: 6px; font-size: 11px; padding: 1px 6px; margin-left: 4px; cursor: pointer; }
      .resume { background: #f1f5f9; border-radius: 8px; padding: 6px 8px; margin: 8px 0; }
      select { font-size: 12px; margin-left: 4px; }
      .skills { font-size: 11px; color: #475569; margin-top: 4px; }
      .actions { display: flex; gap: 8px; margin-top: 10px; }
      .btn { flex: 1; border: none; border-radius: 8px; padding: 8px; font-weight: 600; cursor: pointer; }
      .undo { background: #e2e8f0; color: #1a1a2e; } .done { background: #4a3aff; color: #fff; }
    </style>
    <div class="panel" role="dialog" aria-label="Hiresprint autofill checklist">
      <div class="head"><span>⚡ Hiresprint · Filled ${records.length} field${records.length === 1 ? "" : "s"}</span>
        <button class="close" aria-label="Close">×</button></div>
      ${resume?.name ? `<div class="resume">Resume: <b>${jpEscape(resume.name)}</b>${jpEscape(scoreText)}${
        resume.scores?.length > 1 ? `
          <select class="pick" aria-label="Change resume">${resume.scores.map((s) =>
            `<option value="${jpEscape(s.id)}" ${s.id === resume.resumeId ? "selected" : ""}>${jpEscape(s.name)}${s.informative ? ` (${s.score}%)` : ""}</option>`).join("")}
          </select>` : ""}${skillsText ? `<div class="skills">${skillsText.split("<br>").map(jpEscape).join("<br>")}</div>` : ""}</div>` : ""}
      <div class="row"><span class="dot" style="background:#16a34a"></span>${known.length} from your profile and saved answers</div>
      ${review.length ? `<div class="row"><span class="dot" style="background:#2563eb"></span>${review.length} AI answer${review.length === 1 ? "" : "s"} to review
        <ul>${review.map((r) => `<li><a data-go="${jpEscape(r.id)}">${jpEscape(short(r.label))}</a>${
          r.source === "draft" || r.source === "library"
            ? ` <button class="mini" data-draft="shorter" data-id="${jpEscape(r.id)}">Shorter</button><button class="mini" data-draft="longer" data-id="${jpEscape(r.id)}">Longer</button><button class="mini" data-save="${jpEscape(r.id)}">Save ⭐</button>`
            : ""}</li>`).join("")}</ul></div>` : ""}
      ${needs.length ? `<div class="row"><span class="dot" style="background:#d97706"></span>${needs.length} need you
        <ul>${needs.map((n) => `<li><a data-go="${jpEscape(n.id)}">${jpEscape(short(n.label))}</a></li>`).join("")}</ul></div>` : ""}
      ${attach ? `<div class="row">${jpEscape(attach)}</div>` : ""}
      ${coverText ? `<div class="row">${jpEscape(coverText)}${state.cover?.status === "added" && jpCoverLetter?.text ? ` <button class="mini" data-cover-edit>Edit</button>` : ""}</div>` : ""}
      <div class="row" style="color:#64748b">Review everything, then submit the application yourself.</div>
      <div class="actions"><button class="btn undo">Undo all</button><button class="btn done">Done</button></div>
    </div>`;
  root.querySelector(".close").onclick = jpHideChecklist;
  root.querySelector(".done").onclick = jpHideChecklist;
  root.querySelector(".undo").onclick = jpUndoAll;
  root.querySelectorAll("[data-go]").forEach((a) => (a.onclick = () => jpFocusField(a.dataset.go)));
  root.querySelectorAll("[data-draft]").forEach((b) => (b.onclick = () => jpReviseDraft(b.dataset.id, b.dataset.draft, b)));
  root.querySelectorAll("[data-save]").forEach((b) => (b.onclick = () => jpSaveDraft(b.dataset.save, b)));
  const coverEdit = root.querySelector("[data-cover-edit]");
  if (coverEdit) coverEdit.onclick = jpEditCoverLetter;
  const pick = root.querySelector(".pick");
  if (pick) pick.onchange = () => jpSwitchResume(pick.value);
  document.documentElement.appendChild(host);
}

function jpEscape(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function jpReviseDraft(id, mode, button) {
  const record = jpFillRecords.get(id);
  const el = record?.el;
  if (!el) return;
  button.disabled = true;
  button.textContent = "…";
  try {
    const { profile, uploadedResumeText } = await chrome.storage.local.get(["profile", "uploadedResumeText"]);
    const result = await chrome.runtime.sendMessage({
      type: "REVISE_DRAFT", question: record.label, answer: el.value, mode,
      jobContext: jpLastJobContext, profile: [profile, jpCurrentResume?.text || uploadedResumeText].filter(Boolean).join("\n\n"),
    });
    if (result?.error || !result?.answer) throw new Error(result?.error || "No draft returned.");
    jpSnapshot("text", el);
    fillText(el, result.answer);
    record.value = result.answer;
    record.source = "draft";
    jpMark(el, "draft");
    jpToast(mode === "shorter" ? "Made it shorter." : "Expanded the answer.", "success");
  } catch (err) {
    jpToast(`Couldn't revise: ${err.message}`, "error");
  } finally {
    jpRenderChecklist();
  }
}

async function jpSaveDraft(id, button) {
  const record = jpFillRecords.get(id);
  const answer = record?.el?.value;
  if (!answer) return;
  await chrome.runtime.sendMessage({ type: "SAVE_TO_LIBRARY", question: record.label, answer }).catch(() => {});
  button.textContent = "Saved ✓";
  button.disabled = true;
}

async function jpSwitchResume(resumeId) {
  await chrome.runtime.sendMessage({
    type: "REMEMBER_RESUME_CHOICE", jobContext: jpLastJobContext, host: location.hostname, url: location.href, resumeId,
  }).catch(() => {});
  jpUndoAll();
  jpForcedResumeId = resumeId;
  await runAutofillFromButton(false);
}

var jpForcedResumeId = null;

// Ask the user to choose when two resumes match the job about equally well.
function jpAskResume(pick) {
  return new Promise((resolve) => {
    document.getElementById(JP_PANEL_ID)?.remove();
    const host = document.createElement("div");
    host.id = JP_PANEL_ID;
    Object.assign(host.style, { all: "initial", position: "fixed", right: "20px", bottom: "80px", zIndex: "2147483647" });
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .panel { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; width: 300px;
          background: #fff; color: #1a1a2e; border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.22); padding: 12px 14px; }
        button { display: block; width: 100%; margin-top: 8px; padding: 8px; border-radius: 8px; border: 1px solid #c7d2fe;
          background: #eef2ff; cursor: pointer; font-weight: 600; text-align: left; }
      </style>
      <div class="panel" role="dialog" aria-label="Choose a resume"><b>Which resume for this job?</b>
        ${pick.scores.slice(0, 3).map((s) => `<button data-id="${jpEscape(s.id)}">${jpEscape(s.name)} · ${s.score}% match</button>`).join("")}
      </div>`;
    const finish = (id) => { host.remove(); resolve(id); };
    root.querySelectorAll("button").forEach((b) => (b.onclick = () => finish(b.dataset.id)));
    setTimeout(() => host.isConnected && finish(pick.resumeId), 60000);
    document.documentElement.appendChild(host);
  });
}

// Resume chosen for this application, asking only when it's a close call.
async function jpChooseResume(jobContext, isAuto) {
  jpLastJobContext = jobContext;
  const session = jpLoadSession();
  const forced = jpForcedResumeId || session?.resumeId;
  jpForcedResumeId = null;
  const pick = await chrome.runtime.sendMessage({
    type: "PICK_RESUME", jobContext, host: location.hostname, url: location.href,
  }).catch(() => null);
  if (pick?.jobContext) jpLastJobContext = pick.jobContext;
  if (!pick || pick.error || !pick.resumeId) return pick && !pick.error ? pick : null;
  let resumeId = pick.resumeId;
  if (forced && pick.scores.some((s) => s.id === forced)) resumeId = forced;
  else if (pick.ambiguous && !isAuto) {
    resumeId = await jpAskResume(pick);
    await chrome.runtime.sendMessage({
      type: "REMEMBER_RESUME_CHOICE", jobContext, host: location.hostname, url: location.href, resumeId,
    }).catch(() => {});
  }
  if (resumeId === pick.resumeId) return pick;
  const { resumes = [] } = await chrome.storage.local.get("resumes");
  const chosen = resumes.find((r) => r.id === resumeId);
  return { ...pick, resumeId, name: chosen?.name || pick.name, text: chosen?.text || pick.text };
}
