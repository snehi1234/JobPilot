// sidepanel.js — UI logic: save profile, trigger detection + AI, review & apply.

import * as pdfjsLib from "./lib/pdf.min.mjs";
import { isAuthConfigured, getCurrentUser, signIn, signOut } from "./auth.js";
import { cloudLoad, cloudSave, cloudDelete } from "./cloud.js";
import { extractResumeDetails, mergeResumeDetails } from "./lib/resume-profile.mjs";

// Point pdf.js at its local worker (bundled in the extension).
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.mjs");

const els = {
  profile: document.getElementById("profile"),
  resumeFile: document.getElementById("resumeFile"),
  fileName: document.getElementById("fileName"),
  save: document.getElementById("save"),
  fill: document.getElementById("fill"),
  status: document.getElementById("status"),
  reviewSection: document.getElementById("reviewSection"),
  review: document.getElementById("review"),
  applyAll: document.getElementById("applyAll"),
  deleteData: document.getElementById("deleteData"),
  fabToggle: document.getElementById("fabToggle"),
  autoFillToggle: document.getElementById("autoFillToggle"),
  fillHint: document.getElementById("fillHint"),
};

// IDs of the structured "Quick Details" fields (all prefixed sf_).
const STRUCTURED_IDS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "location",
  "country",
  "linkedin",
  "website",
  "experience",
  "workAuth",
  "sponsorship",
  "salary",
  // Voluntary demographics (EEO / diversity questions)
  "gender",
  "ethnicity",
  "disability",
  "veteran",
  "orientation",
  "transgender",
  "firstGen",
  "caretaker",
];

// Grab the structured element for a given key.
function sfEl(key) {
  return document.getElementById(`sf_${key}`);
}

// Read all structured fields into a plain object.
function readStructured() {
  const data = {};
  STRUCTURED_IDS.forEach((key) => {
    const el = sfEl(key);
    if (el) data[key] = el.value.trim();
  });
  return data;
}

// Holds the latest AI suggestions so "Apply to Page" can use them.
let currentSuggestions = [];
let currentTarget = null;
let fillInProgress = false;
let statusTimer;

// Extracted resume text from an uploaded PDF. Kept SEPARATE from the visible
// profile textbox so we don't dump the whole resume into the UI, but still use
// it for filling. Persisted in chrome.storage.local.
let uploadedResumeText = "";

// ---------- PDF extraction ----------

// Text that indicates the PDF is rights-protected (Microsoft Purview/IRM,
// Adobe DRM, etc.) — pdf.js can only read the placeholder warning page.
const PROTECTED_MARKERS = [
  "this pdf file is protected",
  "you'll need a different reader",
  "does not support opening files protected",
  "has been protected",
  "microsoft office",
  "rights management",
  "compatible pdf reader",
];

function looksProtected(text) {
  const t = text.toLowerCase();
  return PROTECTED_MARKERS.some((m) => t.includes(m));
}

async function extractPdfText(file) {
  const buffer = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  } catch (err) {
    // pdf.js throws PasswordException for encrypted files.
    if (err?.name === "PasswordException") {
      const e = new Error("PROTECTED");
      e.code = "PROTECTED";
      throw e;
    }
    throw err;
  }

  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => `${item.str || ""}${item.hasEOL ? "\n" : " "}`).join("") + "\n";
    const annotations = await page.getAnnotations();
    text += annotations
      .filter(annotation => annotation.subtype === "Link" && /^https?:\/\//i.test(annotation.url || ""))
      .map(annotation => annotation.url).join("\n") + "\n";
  }
  await pdf.destroy();
  return text.trim();
}

// ---------- DOCX extraction ----------
// .docx files are a zip archive containing word/document.xml with the text
// content in <w:t> elements, grouped into paragraphs (<w:p>). JSZip (bundled
// locally, loaded as a plain <script> so it's available as window.JSZip)
// handles the unzip; we do a simple XML text extraction ourselves to avoid
// pulling in a full docx parsing library just for plain text.
async function extractDocxText(file) {
  const buffer = await file.arrayBuffer();
  const zip = await window.JSZip.loadAsync(buffer);
  const docXmlFile = zip.file("word/document.xml");
  if (!docXmlFile) {
    throw new Error("Not a valid .docx file (missing word/document.xml).");
  }
  const xml = await docXmlFile.async("string");
  const doc = new DOMParser().parseFromString(xml, "application/xml");

  const paragraphs = Array.from(doc.getElementsByTagName("w:p"));
  const lines = paragraphs.map((p) => {
    const runs = Array.from(p.getElementsByTagName("w:t"));
    return runs.map((t) => t.textContent || "").join("");
  });
  return lines.join("\n").trim();
}

async function handleResumeUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const isDocx =
    file.name.toLowerCase().endsWith(".docx") ||
    file.type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const isPdf = file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf";

  if (!isDocx && !isPdf) {
    showStatus("Please upload a .pdf or .docx resume file.", "error");
    return;
  }

  els.fileName.textContent = `Reading ${file.name}…`;
  showStatus("Extracting text from your resume…", "info");

  try {
    const text = isDocx ? await extractDocxText(file) : await extractPdfText(file);

    // Case 1: rights-protected PDF (content is that warning message). Only
    // relevant for PDFs — .docx files don't have this failure mode.
    if (!isDocx && (looksProtected(text) || !text)) {
      els.fileName.textContent = "";
      showStatus(
        !text
          ? "Couldn't extract text — this PDF may be a scanned image. Paste your details manually below."
          : "This resume is a PROTECTED PDF (Microsoft/DRM). Its text is locked, so it can't be read. Please: open the PDF, use 'Save As' or 'Print → Save as PDF' to make an unprotected copy, then upload that — or just paste your resume text below.",
        "error"
      );
      return;
    }
    if (isDocx && !text) {
      els.fileName.textContent = "";
      showStatus(
        "Couldn't extract text from this Word document. Please paste your resume text below.",
        "error"
      );
      return;
    }

    uploadedResumeText = text;
    const initial = mergeResumeDetails(readStructured(), extractResumeDetails(text));
    STRUCTURED_IDS.forEach(key => { if (sfEl(key)) sfEl(key).value = initial[key] || ""; });
    await chrome.storage.local.set({ uploadedResumeText, structured: readStructured(), profileSyncPending: true });
    showStatus("Resume text read. Extracting profile details…", "info");
    let warning = "";
    try {
      const parsed = await chrome.runtime.sendMessage({ type: "COUNT_ENTRIES", profile: text });
      if (parsed?.error) throw new Error(parsed.error);
      if (parsed?.warning) warning = parsed.warning;
      const merged = mergeResumeDetails(readStructured(), parsed?.structured);
      STRUCTURED_IDS.forEach(key => { if (sfEl(key)) sfEl(key).value = merged[key] || ""; });
    } catch (err) {
      warning = `AI profile extraction failed: ${err.message}. Contact details found locally are still available.`;
      console.error("[JobPilot] Resume profile extraction failed:", err.message);
    }
    const synced = await save();
    els.fileName.textContent = `✓ ${file.name}`;
    showStatus(
      `Resume imported. Review Quick Details; fields not present in your resume stay blank. ` +
      (synced ? "Saved and synced." : "Saved on this device only; cloud sync failed.") +
      (warning ? ` ${warning}` : ""),
      synced && !warning ? "success" : "error"
    );
  } catch (err) {
    console.error("[JobPilot] Resume import failed:", err?.stack || err?.message || err);
    els.fileName.textContent = "";
    if (err?.code === "PROTECTED") {
      showStatus(
        "This PDF is password/encryption protected and can't be read. Make an unprotected copy (Print → Save as PDF) or paste your resume text below.",
        "error"
      );
    } else if (isDocx) {
      showStatus(
        "Failed to read the Word document. Please paste your details manually below.",
        "error"
      );
    } else {
      showStatus("Failed to read the PDF. Please paste your details manually below.", "error");
    }
  }
}

// ---------- Helpers ----------

function showStatus(message, type = "info") {
  clearTimeout(statusTimer);
  els.status.textContent = message;
  els.status.className = `status ${type}`;
  els.status.classList.remove("hidden");
}

function hideStatus() {
  els.status.classList.add("hidden");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Ensure the content script is running in the tab. Pages that were open BEFORE
// the extension was (re)loaded won't have it auto-injected, which caused the
// "Could not reach the page" error. We inject it on demand here.
async function ensureContentScript(tabId) {
  try {
    // Quick ping — if the content script answers, it's already there.
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return true;
  } catch {
    // Not present — inject it programmatically, then give it a moment to load.
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      await new Promise((r) => setTimeout(r, 300));
      return true;
    } catch (err) {
      console.warn("[JobPilot] Could not inject content script:", err.message);
      return false;
    }
  }
}

// ---------- Load saved data on open ----------

async function loadSaved() {
  const { profileSyncPending } = await chrome.storage.local.get("profileSyncPending");
  let cloud = null;
  if (!profileSyncPending) {
    try {
      cloud = await cloudLoad();
    } catch (err) {
      showStatus(`Cloud profile unavailable: ${err.message}. Using this device's saved profile.`, "error");
      console.error("[JobPilot] Could not load cloud profile:", err.message);
    }
  }
  if (cloud) {
    els.profile.value = cloud.profileText || "";
    if (cloud.resumeText) {
      uploadedResumeText = cloud.resumeText;
      els.fileName.textContent = "✓ Resume on file";
    }
    if (cloud.structured) {
      STRUCTURED_IDS.forEach((key) => {
        const el = sfEl(key);
        if (el && cloud.structured[key] != null) el.value = cloud.structured[key];
      });
    }
    // Mirror to local storage so the floating button (content script) can use it.
    await chrome.storage.local.set({
      profile: cloud.profileText || "",
      structured: cloud.structured || {},
      uploadedResumeText: cloud.resumeText || "",
    });
    return;
  }

  const { profile, structured, uploadedResumeText: savedResume } =
    await chrome.storage.local.get([
      "profile",
      "structured",
      "uploadedResumeText",
    ]);
  if (profile) els.profile.value = profile;
  if (savedResume) {
    uploadedResumeText = savedResume;
    els.fileName.textContent = "✓ Resume on file";
  }
  if (structured) {
    STRUCTURED_IDS.forEach((key) => {
      const el = sfEl(key);
      if (el && structured[key] != null) el.value = structured[key];
    });
  }
}

// ---------- Save ----------

async function save() {
  const originalLabel = els.save.textContent;
  els.save.disabled = true;
  els.save.textContent = "Saving…";

  try {
    const structured = readStructured();
    const profileText = els.profile.value.trim();
    // Always keep local storage in sync (used by the floating button).
    await chrome.storage.local.set({
      profile: profileText,
      structured,
      uploadedResumeText,
    });
    // Also push to the cloud so it syncs across devices.
    await chrome.storage.local.set({ profileSyncPending: true });
    let synced = false;
    try {
      synced = await cloudSave({ structured, profileText, resumeText: uploadedResumeText });
    } catch (err) {
      console.error("[JobPilot] Cloud sync failed:", err.message);
      showStatus(`Saved on this device. Cloud sync failed: ${err.message}`, "error");
      return false;
    }
    if (synced) await chrome.storage.local.remove("profileSyncPending");
    els.save.textContent = synced ? "✓ Saved & Synced" : "✓ Saved";
    showStatus(synced ? "Saved & synced ✓" : "Saved ✓", "success");
    statusTimer = setTimeout(hideStatus, 1500);
    return synced;
  } catch (err) {
    els.save.textContent = "Save failed — retry";
    showStatus("Couldn't save. Please try again.", "error");
    console.error(err);
    throw err;
  } finally {
    setTimeout(() => {
      els.save.textContent = originalLabel;
      els.save.disabled = false;
    }, 1600);
  }
}

// ---------- Fill flow ----------

async function fillForm() {
  if (fillInProgress) return;
  const typedProfile = els.profile.value.trim();
  const structured = readStructured();
  const hasStructured = Object.values(structured).some((v) => v);

  // Combine any typed notes with the uploaded resume text (kept out of the UI).
  const profile = [typedProfile, uploadedResumeText]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  if (!profile && !hasStructured) {
    // A file may have been attached but yielded no usable text (protected/scanned PDF).
    const fileAttached = els.resumeFile.files && els.resumeFile.files.length > 0;
    if (fileAttached) {
      return showStatus(
        "Your PDF couldn't be read (it's likely protected or a scanned image), so there's no text to use. Please fill the Quick Details, paste your resume text, or upload an unprotected PDF.",
        "error"
      );
    }
    return showStatus("Please fill in Quick Details or upload/paste your resume.", "error");
  }

  fillInProgress = true;
  els.fill.disabled = true;
  currentSuggestions = [];
  currentTarget = null;
  els.reviewSection.classList.add("hidden");
  showStatus("Scanning the page for form fields…", "info");

  try {
    await save();
    const tab = await getActiveTab();

    // Make sure the content script is present (handles tabs opened before the
    // extension loaded).
    if (tab?.id == null || /^(chrome|edge|about|chrome-extension):/.test(tab.url || "")) {
      showStatus("Open a job application page, then click Fill.", "error");
      els.fill.disabled = false;
      return;
    }
    const ready = await ensureContentScript(tab.id);
    if (!ready) {
      showStatus("Can't run on this page. Try a normal job application tab.", "error");
      els.fill.disabled = false;
      return;
    }

    // 0. Ask the AI to PARSE the resume into a list of experience/education
    //    entries. The number of entries becomes the number of rows to create.
    let counts = { experience: 1, education: 1 };
    let parsedEntries = null;
    if (profile) {
      showStatus("Reading your resume…", "info");
      const countResp = await chrome.runtime.sendMessage({
        type: "COUNT_ENTRIES",
        profile,
      });
      if (countResp?.error) throw new Error(countResp.error);
      if (countResp?.counts) counts = countResp.counts;
      if (countResp?.entries) parsedEntries = countResp.entries;
    }
    console.log("[JobPilot] Using counts:", counts, parsedEntries);

    // Show the parsed experience list so we can SEE what the AI found.
    const expNames = (parsedEntries?.experience || [])
      .map((e) => e.organization || e.position || "?")
      .join(", ");
    showStatus(
      `Resume parsed: ${counts.experience} experience(s)` +
        (expNames ? ` → ${expNames}` : "") +
        `, ${counts.education} education. Preparing form…`,
      "info"
    );
    await new Promise((r) => setTimeout(r, 2500)); // pause so you can read it

    // 1. Ask the content script to detect fields (expands repeatable sections).
    const detectResponse = await chrome.tabs.sendMessage(tab.id, {
      type: "DETECT_FIELDS",
      counts,
      parsedEntries,
    });

    if (detectResponse?.busy) {
      showStatus(
        "JobPilot is already filling this page (auto-fill just ran) — please wait a moment and try again.",
        "error"
      );
      els.fill.disabled = false;
      return;
    }
    if (detectResponse?.error) throw new Error(detectResponse.error);

    const fields = detectResponse?.fields || [];
    const jobContext = detectResponse?.jobContext || {};
    currentTarget = { tabId: tab.id, frameId: detectResponse.frameId ?? 0, scanId: detectResponse.scanId };

    if (fields.length === 0) {
      showStatus("No form fields found on this page.", "error");
      els.fill.disabled = false;
      return;
    }

    // If the parsed entries list is incomplete (fewer than the target count),
    // don't force a rigid one-to-one mapping for THAT category — let the fill
    // AI read the full resume directly for it (which it does reliably).
    // Evaluate experience/education independently so an unreliable parse in
    // one category doesn't also discard a perfectly good parse in the other.
    const expEntries = parsedEntries?.experience || [];
    const eduEntries = parsedEntries?.education || [];
    const reliableExp = expEntries.length >= counts.experience ? expEntries : null;
    const reliableEdu = eduEntries.length >= counts.education ? eduEntries : null;
    const reliableEntries =
      reliableExp || reliableEdu
        ? { experience: reliableExp || undefined, education: reliableEdu || undefined }
        : null;
    if (!reliableExp || !reliableEdu) {
      console.log(
        "[JobPilot] Some parsed entries incomplete; letting fill AI use full resume for those."
      );
    }

    showStatus(`Found ${fields.length} fields. Asking Groq…`, "info");

    // 2. Send fields + profile to the background worker for the AI call.
    const aiResponse = await chrome.runtime.sendMessage({
      type: "GENERATE_ANSWERS",
      fields,
      profile,
      jobContext,
      structured,
      parsedEntries: reliableEntries,
    });

    if (aiResponse?.error) {
      showStatus(`AI error: ${aiResponse.error}`, "error");
      els.fill.disabled = false;
      return;
    }

    if (!Array.isArray(aiResponse?.suggestions) || aiResponse.suggestions.length === 0) {
      throw new Error("No usable answers were returned. Your form has not been changed.");
    }
    currentSuggestions = aiResponse.suggestions;
    renderReview(currentSuggestions);
    showStatus(`${currentSuggestions.length} answers ready. Review them, then click Apply to Page to fill the application.`, "success");
    els.reviewSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    showStatus(
      `Autofill failed: ${err.message}`,
      "error"
    );
    console.error(err);
  } finally {
    fillInProgress = false;
    els.fill.disabled = false;
  }
}

// ---------- Review rendering ----------

function renderReview(suggestions) {
  els.review.innerHTML = "";

  if (suggestions.length === 0) {
    els.reviewSection.classList.add("hidden");
    return;
  }

  suggestions.forEach((s, i) => {
    const item = document.createElement("div");
    item.className = "review-item";

    const label = document.createElement("div");
    label.className = "field-label";
    label.textContent = s.label || s.selector || `Field ${i + 1}`;

    // Confidence badge (high / medium / low).
    if (s.confidence) {
      const badge = document.createElement("span");
      badge.className = `confidence conf-${s.confidence.toLowerCase()}`;
      badge.textContent = s.confidence;
      label.appendChild(badge);
    }

    const value = document.createElement("input");
    value.className = "field-value";
    value.type = "text";
    value.value = s.value || "";
    value.dataset.index = i;
    if (s.confidence && s.confidence.toLowerCase() === "low") {
      value.classList.add("value-low");
    }
    value.addEventListener("input", (e) => {
      currentSuggestions[e.target.dataset.index].value = e.target.value;
    });

    item.appendChild(label);
    item.appendChild(value);
    els.review.appendChild(item);
  });

  els.reviewSection.classList.remove("hidden");
}

// ---------- Apply to page ----------

async function applyAll() {
  if (!currentTarget || !currentSuggestions.length) {
    showStatus("Generate answers for an application before applying them.", "error");
    return;
  }
  const target = currentTarget;
  showStatus("Filling the form…", "info");
  els.applyAll.disabled = true;

  try {
    const result = await chrome.tabs.sendMessage(target.tabId, {
      type: "APPLY_ANSWERS",
      suggestions: currentSuggestions,
      scanId: target.scanId,
    }, { frameId: target.frameId });
    if (result?.error) throw new Error(result.error);

    // Page was reloaded/changed since we detected — markers are gone.
    if (result?.stale) {
      showStatus(
        "The page changed since scanning (did you reload?). Click ✨ Fill This Form again to re-scan, then Apply.",
        "error"
      );
      return;
    }

    const filled = result?.filled ?? 0;
    const failures = result?.failed || [];
    if (!filled) {
      throw new Error("No fields were filled. " + failures.map(item => `${item.label}: ${item.reason}`).join("; "));
    }
    showStatus(
      `Filled ${filled} fields. ` +
      (failures.length ? `${failures.length} need manual entry: ${failures.map(item => item.label).join(", ")}. ` : "") +
      "Review the application and attach your resume manually before submitting.",
      failures.length ? "error" : "success"
    );
  } catch (err) {
    showStatus(`Could not apply: ${err.message}`, "error");
    console.error(err);
  } finally {
    els.applyAll.disabled = false;
  }
}

// ---------- Auth UI ----------

const authEls = {
  bar: document.getElementById("authBar"),
  signedOut: document.getElementById("authSignedOut"),
  signedIn: document.getElementById("authSignedIn"),
  signInBtn: document.getElementById("signInBtn"),
  signOutBtn: document.getElementById("signOutBtn"),
  avatar: document.getElementById("authAvatar"),
  email: document.getElementById("authEmail"),
  appContent: document.getElementById("appContent"),
  signInPrompt: document.getElementById("signInPrompt"),
};

// Empty every visible field so no data lingers in the UI when signed out.
function clearFormUI() {
  els.profile.value = "";
  els.fileName.textContent = "";
  uploadedResumeText = "";
  STRUCTURED_IDS.forEach((key) => {
    const el = sfEl(key);
    if (el) el.value = "";
  });
  currentSuggestions = [];
  els.review.innerHTML = "";
  els.reviewSection.classList.add("hidden");
}

// Show the form only when signed in; otherwise show the sign-in prompt.
function gateContent(signedIn) {
  if (signedIn) {
    authEls.appContent.classList.remove("hidden");
    authEls.signInPrompt.classList.add("hidden");
  } else {
    authEls.appContent.classList.add("hidden");
    authEls.signInPrompt.classList.remove("hidden");
  }
}

function renderAuth(user) {
  if (user) {
    authEls.signedOut.classList.add("hidden");
    authEls.signedIn.classList.remove("hidden");
    authEls.email.textContent = user.email || user.name || "Signed in";
    authEls.avatar.src = user.picture || "";
  } else {
    authEls.signedIn.classList.add("hidden");
    authEls.signedOut.classList.remove("hidden");
    // Privacy: don't leave the previous user's email/avatar visible.
    authEls.email.textContent = "";
    authEls.avatar.removeAttribute("src");
  }
}

async function initAuth() {
  // When auth is NOT configured, there's no gating — just load and show.
  if (!isAuthConfigured()) {
    gateContent(true);
    await loadSaved();
    return;
  }

  authEls.bar.classList.remove("hidden");

  const user = await getCurrentUser();
  renderAuth(user);
  gateContent(Boolean(user));
  if (user) {
    await loadSaved();
  } else {
    clearFormUI();
  }

  authEls.signInBtn.addEventListener("click", async () => {
    try {
      const u = await signIn({ interactive: true });
      renderAuth(u);
      gateContent(true);
      await loadSaved();
      showStatus(`Signed in as ${u.email} ✓`, "success");
      setTimeout(hideStatus, 2000);
    } catch (err) {
      showStatus(`Sign-in failed: ${err.message}`, "error");
    }
  });

  authEls.signOutBtn.addEventListener("click", async () => {
    await signOut();
    // Clear locally cached profile so the floating button can't use it either.
    await chrome.storage.local.remove([
      "profile",
      "structured",
      "uploadedResumeText",
    ]);
    renderAuth(null);
    clearFormUI();
    gateContent(false);
  });
}

// Permanently delete the signed-in user's cloud + local profile data.
async function deleteMyData() {
  const sure = confirm(
    "Delete all your JobPilot data (profile, resume text, demographics)?\n\nThis cannot be undone."
  );
  if (!sure) return;

  els.deleteData.disabled = true;
  try {
    await cloudDelete();
    await chrome.storage.local.remove(["profile", "structured", "uploadedResumeText", "autoFillEnabled", "parseCache"]);
    clearFormUI();
    showStatus("Your saved profile and resume have been deleted ✓", "success");
    setTimeout(hideStatus, 2500);
  } catch (err) {
    showStatus("Could not delete data. Try again.", "error");
    console.error(err);
  } finally {
    els.deleteData.disabled = false;
  }
}

// Global on/off switch for the floating Autofill button, applies across all
// tabs and sites (persisted in chrome.storage.local, read by content.js).
async function initFabToggle() {
  const { fabEnabled } = await chrome.storage.local.get(["fabEnabled"]);
  els.fabToggle.checked = fabEnabled !== false; // default: enabled

  els.fabToggle.addEventListener("change", async () => {
    const enabled = els.fabToggle.checked;
    await chrome.storage.local.set({ fabEnabled: enabled });
    // Content scripts listen for this storage change and react on their own,
    // but also nudge the active tab directly for an instant result there.
    if (enabled) {
      try {
        const tab = await getActiveTab();
        if (tab?.id != null) {
          const ready = await ensureContentScript(tab.id);
          if (ready) await chrome.tabs.sendMessage(tab.id, { type: "SHOW_FAB" });
        }
      } catch {
        /* best-effort */
      }
    }
    showStatus(
      enabled ? "Floating Autofill button enabled ✓" : "Floating Autofill button hidden on all pages",
      "success"
    );
    setTimeout(hideStatus, 1500);
  });
}

async function initAutoFillToggle() {
  try {
    const { autoFillEnabled } = await chrome.storage.local.get(["autoFillEnabled"]);
    els.autoFillToggle.checked = autoFillEnabled === true;
    els.autoFillToggle.disabled = false;
  } catch (err) {
    showStatus("Could not load automatic-filling preferences. Reopen the panel to try again.", "error");
    console.error("[JobPilot] Could not load automatic-filling preferences:", err);
    return;
  }

  els.autoFillToggle.addEventListener("change", async () => {
    const enabled = els.autoFillToggle.checked;
    els.autoFillToggle.disabled = true;
    try {
      await chrome.storage.local.set({ autoFillEnabled: enabled });
      showStatus(
        enabled
          ? "Automatic AI filling enabled. Review every filled application before submitting."
          : "Automatic filling disabled. You can still request answers manually.",
        "success"
      );
    } catch (err) {
      els.autoFillToggle.checked = !enabled;
      showStatus("Could not save the automatic-filling preference. Please try again.", "error");
      console.error("[JobPilot] Could not save automatic-filling preference:", err);
    } finally {
      els.autoFillToggle.disabled = false;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "autoFillEnabled" in changes) {
      els.autoFillToggle.checked = changes.autoFillEnabled.newValue === true;
    }
  });
}

// ---------- Fill button gating (only enabled on real job application pages) ----------

const NON_APP_URL_RE = /^(chrome|edge|about|chrome-extension):/;

// Tracks the active tab id this loop is currently polling for, so a stale
// background poll from a previously-viewed tab doesn't overwrite the button
// state after the user has switched to a different tab.
let jpFillPollTabId = null;

async function refreshFillAvailability() {
  const tab = await getActiveTab().catch(() => null);
  const url = tab?.url || "";
  jpFillPollTabId = tab?.id ?? null;

  if (!tab?.id || NON_APP_URL_RE.test(url)) {
    setFillAvailable(false, "Open a job application page to fill it.");
    return;
  }

  const thisTabId = tab.id;
  const stillCurrent = () => jpFillPollTabId === thisTabId;

  // Some ATS pages (e.g. Greenhouse) take several seconds to fully render
  // their application form after the page "finishes loading" — the floating
  // button's own detection loop polls for up to ~15s to account for this.
  // Match that same budget here (up to 20 attempts, 750ms apart ≈ 15s) so a
  // single early check made right when the panel opens doesn't permanently
  // lock the button as disabled just because the form wasn't rendered yet.
  const MAX_ATTEMPTS = 20;
  const DELAY_MS = 750;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (!stillCurrent()) return; // user switched tabs mid-poll; abandon this run

    const pingOk = await chrome.tabs.sendMessage(thisTabId, { type: "PING" }).catch(() => null);
    if (pingOk) {
      const resp = await chrome.tabs
        .sendMessage(thisTabId, { type: "CHECK_JOB_PAGE" })
        .catch(() => null);
      if (resp?.isJobPage) {
        if (stillCurrent()) setFillAvailable(true, "");
        return;
      }
    }

    if (!stillCurrent()) return;
    setFillAvailable(false, "This doesn't look like a job application page yet…");
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  if (stillCurrent()) {
    setFillAvailable(false, "This doesn't look like a job application page.");
  }
}

function setFillAvailable(available, hintText) {
  if (fillInProgress) return;
  els.fill.disabled = !available;
  els.fill.title = available ? "" : hintText;
  if (els.fillHint) {
    els.fillHint.textContent = hintText;
    els.fillHint.classList.toggle("hidden", available);
  }
}

// Re-check whenever the panel's tab changes or a page finishes loading.
chrome.tabs.onActivated.addListener(() => refreshFillAvailability());
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status === "complete") refreshFillAvailability();
});

// ---------- Wire up ----------

els.save.addEventListener("click", () => save().catch(err => console.error("[JobPilot] Save failed:", err.message)));
els.fill.addEventListener("click", fillForm);
els.applyAll.addEventListener("click", applyAll);
els.resumeFile.addEventListener("change", handleResumeUpload);
els.deleteData.addEventListener("click", deleteMyData);
initFabToggle();
initAutoFillToggle();
refreshFillAvailability();

initAuth();
