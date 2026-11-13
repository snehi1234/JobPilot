// lib/events.js — validation for anonymous product-usage events.
// Pure functions (no I/O) so they're easy to test. Only a fixed list of event
// names and small, non-identifying properties are accepted: never page URLs,
// form contents, resume text, or answers.

export const EVENT_NAMES = [
  "install",
  "update",
  "uninstall",
  "uninstall_reason",
  "panel_session",
  "sign_in",
  "resume_added",
  "autofill",
  "tailor",
  "tailor_used",
  "cover_letter",
  "ats_check",
  "badge_tailor",
  "feedback",
  "rate_prompt",
  "practice_open",
];

export const EVENT_PLATFORMS = [
  "greenhouse", "lever", "ashby", "workday", "icims", "smartrecruiters", "taleo",
  "successfactors", "linkedin", "indeed", "glassdoor", "practice", "other",
];

export const MAX_EVENTS_PER_REQUEST = 50;
export const EVENT_RETENTION_DAYS = 180;

// Allowed property keys and how to clean them.
const NUM_PROPS = { fields: 500, seconds: 6 * 60 * 60, score: 100, count: 1000 };
const STR_PROPS = ["source", "action", "from", "reason"];

const token = (value) =>
  typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 32) : "";

export function cleanInstallId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : "";
}

export function cleanVersion(value) {
  const v = typeof value === "string" ? value.trim() : "";
  return /^\d+(\.\d+){0,3}$/.test(v) ? v : null;
}

export function cleanProps(props) {
  const out = {};
  if (!props || typeof props !== "object") return out;
  for (const [key, max] of Object.entries(NUM_PROPS)) {
    const n = Number(props[key]);
    if (props[key] !== undefined && Number.isFinite(n)) out[key] = Math.max(0, Math.min(max, Math.round(n)));
  }
  for (const key of STR_PROPS) {
    const v = token(props[key]);
    if (v) out[key] = v;
  }
  if (props.platform !== undefined) {
    const p = token(props.platform);
    out.platform = EVENT_PLATFORMS.includes(p) ? p : "other";
  }
  return out;
}

// Turn a client batch into rows ready to insert. Unknown events are dropped;
// client timestamps are trusted only within the last 7 days.
export function sanitizeEvents(body, { now = Date.now(), userSub = null } = {}) {
  const installId = cleanInstallId(body?.installId);
  if (!installId) return { ok: false, error: "Missing install id." };
  const version = cleanVersion(body?.version);
  const list = Array.isArray(body?.events) ? body.events.slice(0, MAX_EVENTS_PER_REQUEST) : [];
  const rows = [];
  for (const ev of list) {
    const name = token(ev?.name);
    if (!EVENT_NAMES.includes(name)) continue;
    const ts = Number(ev?.ts);
    const at = Number.isFinite(ts) && ts <= now + 60_000 && ts >= now - 7 * 86400_000 ? Math.min(ts, now) : now;
    rows.push({
      install_id: installId,
      user_sub: userSub,
      name,
      version,
      props: cleanProps(ev?.props),
      created_at: new Date(at).toISOString(),
    });
  }
  return { ok: true, rows };
}
