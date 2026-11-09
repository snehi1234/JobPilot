// background.js — service worker. AI requests use the authenticated backend,
// which is restricted to Groq. Model keys never belong in the extension.

import { BACKEND_URL } from "./config.js";
import { getIdToken, signIn } from "./auth.js";
import { resolveLocally, rememberAnswers, profileVersion } from "./lib/answer-engine.mjs";

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
});

// Resolve answers locally (profile rules + remembered answers) and only send
// the remaining fields to the AI. With `localOnly`, return immediately with
// the ids still pending so the page can fill known fields first.
async function answerFields(message) {
  const fields = Array.isArray(message.fields) ? message.fields : [];
  const version = await profileVersion(message.structured, message.profile);
  let { answerMemory } = await chrome.storage.local.get("answerMemory");
  if (answerMemory?.version !== version) answerMemory = { version, entries: {} };

  const context = { sourceHint: message.jobContext?.sourceHint, today: new Date() };
  const { suggestions, pending } = message.skipLocal
    ? { suggestions: [], pending: fields }
    : resolveLocally(fields, { structured: message.structured, memory: answerMemory, context });
  if (message.localOnly) {
    return { suggestions, pending: pending.map((f) => f.id) };
  }
  if (!pending.length) return { suggestions, aiFields: 0 };

  const ai = (await backendGenerate({
    fields: pending,
    profile: message.profile,
    jobContext: message.jobContext,
    structured: message.structured,
    parsedEntries: message.parsedEntries,
  })).map((s) => ({ ...s, source: "ai" }));
  await chrome.storage.local.set({ answerMemory: { ...rememberAnswers(answerMemory, pending, ai), version } });
  return { suggestions: [...suggestions, ...ai], aiFields: pending.length };
}
