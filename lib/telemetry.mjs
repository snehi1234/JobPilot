// lib/telemetry.mjs — anonymous product-usage events (counts only).
// Events carry a random install id, the extension version, and a few small
// properties (job platform, number of fields, durations). Never page URLs,
// form contents, resume text, or answers. Users can turn this off in the panel.

export const TELEMETRY_EVENTS = [
  "install", "update", "panel_session", "sign_in", "resume_added", "autofill",
  "tailor", "tailor_used", "cover_letter", "ats_check", "badge_tailor",
  "feedback", "rate_prompt", "practice_open",
];

const PLATFORM_HOSTS = [
  ["greenhouse", /(^|\.)greenhouse\.io$/],
  ["lever", /(^|\.)lever\.co$/],
  ["ashby", /(^|\.)ashbyhq\.com$/],
  ["workday", /(^|\.)(myworkdayjobs|myworkdaysite|workday)\.com$/],
  ["icims", /(^|\.)icims\.com$/],
  ["smartrecruiters", /(^|\.)smartrecruiters\.com$/],
  ["taleo", /(^|\.)taleo\.net$/],
  ["successfactors", /(^|\.)(successfactors\.(com|eu)|sapsf\.(com|eu)|jobs2web\.com)$/],
  ["linkedin", /(^|\.)linkedin\.com$/],
  ["indeed", /(^|\.)indeed\.com$/],
  ["glassdoor", /(^|\.)glassdoor\.[a-z.]+$/],
];

// Map a page URL to a coarse job-platform name; the URL itself is never sent.
export function platformOf(url, practiceOrigin = "") {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "other";
  }
  if (practiceOrigin && u.origin === practiceOrigin && /\/practice(\.html)?$/.test(u.pathname)) return "practice";
  const host = u.hostname.toLowerCase();
  for (const [name, re] of PLATFORM_HOSTS) if (re.test(host)) return name;
  return "other";
}

const MAX_QUEUE = 200;

// Storage-backed queue with batched upload. `deps` keeps it testable:
// { storage: chrome.storage.local-like, send: async (events) => void, now }
export function createTelemetry({ storage, send, now = () => Date.now(), flushDelayMs = 30_000 }) {
  let timer = null;
  let flushing = null;

  async function enabled() {
    const { usageStatsEnabled } = await storage.get("usageStatsEnabled");
    return usageStatsEnabled !== false;
  }

  async function installId() {
    const { installId: existing } = await storage.get("installId");
    if (existing) return existing;
    const id = crypto.randomUUID();
    await storage.set({ installId: id });
    return id;
  }

  async function track(name, props = {}) {
    if (!TELEMETRY_EVENTS.includes(name) || !(await enabled())) return false;
    const { telemetryQueue = [] } = await storage.get("telemetryQueue");
    telemetryQueue.push({ name, ts: now(), props });
    await storage.set({ telemetryQueue: telemetryQueue.slice(-MAX_QUEUE) });
    schedule();
    return true;
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch(() => {});
    }, flushDelayMs);
    timer?.unref?.();
  }

  async function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      const { telemetryQueue = [] } = await storage.get("telemetryQueue");
      if (!telemetryQueue.length) return 0;
      if (!(await enabled())) {
        await storage.set({ telemetryQueue: [] });
        return 0;
      }
      const batch = telemetryQueue.slice(0, 50);
      await send(batch, await installId());
      // Events tracked while sending stay queued for the next flush.
      const { telemetryQueue: latest = [] } = await storage.get("telemetryQueue");
      await storage.set({ telemetryQueue: latest.slice(batch.length) });
      if (latest.length > batch.length) schedule();
      return batch.length;
    })();
    try {
      return await flushing;
    } finally {
      flushing = null;
    }
  }

  async function setEnabled(on) {
    await storage.set({ usageStatsEnabled: on !== false });
    if (on === false) await storage.set({ telemetryQueue: [] });
  }

  return { track, flush, installId, enabled, setEnabled };
}

// Rating prompt: ask after a few successful autofills, never more than once
// every two weeks, and never again after "Rate" or "Don't ask again".
export const RATE_AFTER_FILLS = 3;
export const RATE_SNOOZE_MS = 14 * 86400_000;

export function shouldAskForRating(state = {}, nowMs = Date.now()) {
  if (state.rated || state.never) return false;
  if ((state.successfulFills || 0) < RATE_AFTER_FILLS) return false;
  if (state.snoozedAt && nowMs - state.snoozedAt < RATE_SNOOZE_MS) return false;
  return true;
}

export function applyRatingAction(state = {}, action, nowMs = Date.now()) {
  const next = { ...state };
  if (action === "rate") next.rated = true;
  else if (action === "never") next.never = true;
  else if (action === "later" || action === "feedback") next.snoozedAt = nowMs;
  return next;
}
