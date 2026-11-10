// background.js — service worker. AI requests use the authenticated backend,
// which is restricted to Groq. Model keys never belong in the extension.

import { BACKEND_URL } from "./config.js";
import { getIdToken, signIn } from "./auth.js";
import { resolveLocally, rememberAnswers, profileVersion, recordCorrection, isLongQuestion } from "./lib/answer-engine.mjs";
import { pickResume, companyKey } from "./lib/match-score.mjs";

// Make clicking the toolbar icon open the side panel automatically.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("setPanelBehavior failed:", err));

chrome.runtime.onInstalled.addListener((details) => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("setPanelBehavior failed:", err));

  // On first install, open the welcome/onboarding page.
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
});

// Fallback: also open on click (covers cases where behavior wasn't set yet).
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id }).catch((err) => console.error(err));
});

// Apply store updates as soon as Chrome downloads them instead of waiting for
// the extension to go idle, and check for updates when the browser starts.
chrome.runtime.onUpdateAvailable?.addListener(() => chrome.runtime.reload());
chrome.runtime.onStartup?.addListener(() => {
  Promise.resolve(chrome.runtime.requestUpdateCheck?.()).catch(() => {});
});

// ---------- Backend calls ----------

// Build headers, attaching the Google ID token when the user is signed in.
// `forceRefresh` triggers a silent (non-interactive) re-auth first, used as a
// one-time retry when the backend rejects a token as expired/invalid — this
// avoids falsely telling the user their session expired for a transient or
// near-expiry token that a silent refresh would have fixed.
async function backendHeaders(forceRefresh = false) {
  if (forceRefresh) {
    try {
      await signIn({ interactive: false });
    } catch {
      /* fall through — getIdToken() below will return whatever it can */
    }
  }
  const headers = { "Content-Type": "application/json" };
  const token = await getIdToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// POST to the backend with auth headers. On a 401, silently refresh the token
// once and retry before surfacing an error — protects against false
// "session expired" prompts caused by a stale/near-expiry cached token.
async function callBackendWithAuth(path, body) {
  if (!BACKEND_URL) {
    throw new Error("JobPilot backend is not configured. AI requests are disabled.");
  }
  let res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: await backendHeaders(),
    body: JSON.stringify(body),
  });

  if (res.status === 401) {
    res = await fetch(`${BACKEND_URL}${path}`, {
      method: "POST",
      headers: await backendHeaders(true),
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `Backend ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function backendGenerate({ fields, profile, jobContext, structured, parsedEntries }) {
  const data = await callBackendWithAuth("/api/generate", {
    fields,
    profile,
    jobContext,
    structured,
    parsedEntries,
  });
  return data.suggestions || [];
}

async function backendParse(profile) {
  // Resume parsing is deterministic for the same text, so cache it locally.
  // This halves AI calls per autofill and protects the shared free quota.
  const bytes = new TextEncoder().encode(profile || "");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  const { parseCache } = await chrome.storage.local.get("parseCache");
  if (parseCache?.hash === hash && parseCache.result?.entries) return parseCache.result;
  const result = await callBackendWithAuth("/api/parse-resume", { profile }); // { counts, entries, structured }
  if (result?.entries && !result.warning) {
    await chrome.storage.local.set({ parseCache: { hash, result } });
  }
  return result;
}

// Listen for requests from the side panel.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FRAME_INFO") {
    sendResponse({ frameId: sender.frameId ?? 0 });
    return false;
  }
  if (message.type === "OPEN_SIDE_PANEL") {
    // Open the side panel for the tab the request came from (e.g. so the user
    // can sign in / set up their profile). Must run in the user-gesture window.
    const tabId = sender.tab?.id;
    const p = tabId
      ? chrome.sidePanel.open({ tabId })
      : chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    Promise.resolve(p)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "COUNT_ENTRIES") {
    backendParse(message.profile)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "GENERATE_ANSWERS") {
    answerFields(message)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true; // keep the channel open for async response
  }

  const handlers = {
    PICK_RESUME: chooseResume,
    REMEMBER_RESUME_CHOICE: rememberResumeChoice,
    LEARN_ANSWER: learnAnswer,
    SAVE_TO_LIBRARY: saveToLibrary,
    REVISE_DRAFT: reviseDraft,
    GET_RESUME_FILE: getResumeFile,
  };
  const handler = handlers[message.type];
  if (handler) {
    handler(message)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

const resumeKey = (id) => id || "default";

async function loadResumes() {
  const { resumes, defaultResumeId, uploadedResumeText } =
    await chrome.storage.local.get(["resumes", "defaultResumeId", "uploadedResumeText"]);
  if (Array.isArray(resumes) && resumes.length) return { resumes, defaultResumeId };
  // Profiles created before multiple resumes were supported.
  return uploadedResumeText
    ? { resumes: [{ id: "default", name: "Resume", text: uploadedResumeText }], defaultResumeId: "default" }
    : { resumes: [], defaultResumeId: null };
}

// Pick the resume for this application (best match, remembered choice for
// this company, or the default) and report the scores.
async function chooseResume(message) {
  const { resumes, defaultResumeId } = await loadResumes();
  const { resumeChoices = {} } = await chrome.storage.local.get("resumeChoices");
  const key = companyKey(message.jobContext, message.host);
  const pick = pickResume(resumes, message.jobContext, {
    defaultId: defaultResumeId,
    rememberedId: message.ignoreRemembered ? undefined : resumeChoices[key],
  });
  const chosen = resumes.find((r) => r.id === pick.resumeId);
  return { ...pick, name: chosen?.name || "", text: chosen?.text || "", count: resumes.length };
}

async function rememberResumeChoice({ jobContext, host, resumeId }) {
  const { resumeChoices = {} } = await chrome.storage.local.get("resumeChoices");
  const key = companyKey(jobContext, host);
  if (!key || !resumeId) return { ok: false };
  const next = { ...resumeChoices, [key]: resumeId };
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete next[k];
  await chrome.storage.local.set({ resumeChoices: next });
  return { ok: true };
}

// A value the user typed over an autofilled answer; reused next time.
async function learnAnswer({ field, value, resumeId }) {
  const { answerCorrections = {} } = await chrome.storage.local.get("answerCorrections");
  const key = resumeKey(resumeId);
  const updated = recordCorrection(answerCorrections[key], field, value);
  await chrome.storage.local.set({ answerCorrections: { ...answerCorrections, [key]: updated } });
  return { ok: true, learned: updated !== answerCorrections[key] };
}

async function saveToLibrary({ question, answer }) {
  const q = String(question || "").trim().slice(0, 300);
  const a = String(answer || "").trim().slice(0, 4000);
  if (!q || !a) return { ok: false };
  const { answerLibrary = [] } = await chrome.storage.local.get("answerLibrary");
  const rest = answerLibrary.filter((item) => item.question !== q);
  await chrome.storage.local.set({ answerLibrary: [{ question: q, answer: a, savedAt: Date.now() }, ...rest].slice(0, 100) });
  return { ok: true };
}

async function reviseDraft({ question, answer, mode, jobContext, profile }) {
  return callBackendWithAuth("/api/draft", { question, answer, mode, jobContext, profile });
}

async function getResumeFile({ resumeId }) {
  const { resumeFiles = {} } = await chrome.storage.local.get("resumeFiles");
  return resumeFiles[resumeKey(resumeId)] || null;
}

// Resolve answers locally (corrections, profile rules, remembered answers,
// saved long answers) and only send the remaining fields to the AI. With
// `localOnly`, return immediately with the ids still pending so the page can
// fill known fields first. Memory and corrections are kept per resume.
async function answerFields(message) {
  const fields = Array.isArray(message.fields) ? message.fields : [];
  const key = resumeKey(message.resumeId);
  const version = await profileVersion(message.structured, message.profile);
  const stored = await chrome.storage.local.get(["answerMemory", "answerCorrections", "answerLibrary"]);
  const memories = stored.answerMemory && !stored.answerMemory.entries ? stored.answerMemory : {};
  let memory = memories[key];
  if (memory?.version !== version) memory = { version, entries: {} };

  const context = { sourceHint: message.jobContext?.sourceHint, today: new Date() };
  const { suggestions, pending } = message.skipLocal
    ? { suggestions: [], pending: fields }
    : resolveLocally(fields, {
        structured: message.structured,
        memory,
        context,
        corrections: stored.answerCorrections?.[key],
        library: stored.answerLibrary,
      });
  if (message.localOnly) {
    return { suggestions, pending: pending.map((f) => f.id) };
  }
  if (!pending.length) return { suggestions, aiFields: 0 };

  const byId = new Map(pending.map((f) => [String(f.id), f]));
  const ai = (await backendGenerate({
    fields: pending,
    profile: message.profile,
    jobContext: message.jobContext,
    structured: message.structured,
    parsedEntries: message.parsedEntries,
  })).map((s) => ({ ...s, source: isLongQuestion(byId.get(String(s.id)) || {}) ? "draft" : "ai" }));
  const updated = rememberAnswers(memory, pending, ai);
  await chrome.storage.local.set({ answerMemory: { ...memories, [key]: { ...updated, version } } });
  return { suggestions: [...suggestions, ...ai], aiFields: pending.length };
}
