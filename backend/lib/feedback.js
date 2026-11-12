// lib/feedback.js — validation for user feedback reports and the admin check.
// Pure functions (no I/O) so they're easy to test.

export const FEEDBACK_TYPES = ["bug", "wrong-answer", "site", "idea", "other"];
export const FEEDBACK_STATUSES = ["new", "in-progress", "fixed", "wont-fix"];
export const MAX_FEEDBACK_PER_DAY = 5;

const str = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const num = (value) => (Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), 100000) : null);

// The page a report came from, without query strings or fragments (which can
// carry tracking ids or personal data).
export function cleanSite(value) {
  const text = str(value, 500);
  if (!text) return "";
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    if (!/^https?:$/.test(url.protocol)) return "";
    return `${url.hostname}${url.pathname}`.replace(/\/+$/, "").slice(0, 200);
  } catch {
    return "";
  }
}

// Only the diagnostic fields the extension sends; everything else is dropped.
export function sanitizeDetails(details) {
  const d = details && typeof details === "object" ? details : {};
  const fields = d.fields && typeof d.fields === "object" ? d.fields : {};
  const out = {
    site: cleanSite(d.site),
    version: str(d.version, 20),
    browser: str(d.browser, 160),
    lastError: str(d.lastError, 300),
    attach: str(d.attach, 20),
    cover: str(d.cover, 20),
    match: str(d.match, 60),
    fields: {
      found: num(fields.found),
      filled: num(fields.filled),
      needs: num(fields.needs),
      missing: Array.isArray(fields.missing) ? fields.missing.map((m) => str(m, 120)).filter(Boolean).slice(0, 20) : [],
    },
  };
  if (out.fields.found === null && out.fields.filled === null && out.fields.needs === null && !out.fields.missing.length) {
    delete out.fields;
  }
  for (const key of Object.keys(out)) if (out[key] === "") delete out[key];
  return out;
}

// Returns { ok: true, value } or { ok: false, error }.
export function sanitizeFeedback(body) {
  const b = body && typeof body === "object" ? body : {};
  const type = FEEDBACK_TYPES.includes(b.type) ? b.type : "other";
  const message = str(b.message, 2000);
  if (message.length < 3) return { ok: false, error: "Please describe the problem or idea." };
  return {
    ok: true,
    value: {
      type,
      message,
      contact_ok: b.contactOk === true,
      details: b.includeDetails === false ? {} : sanitizeDetails(b.details),
    },
  };
}

// The admin page is limited to the verified Google accounts listed in the
// ADMIN_EMAILS setting (comma-separated).
export function isAdmin(claims, adminEmails = process.env.ADMIN_EMAILS || "") {
  const allowed = adminEmails.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const email = String(claims?.email || "").toLowerCase();
  const verified = claims?.email_verified === true || claims?.email_verified === "true";
  return Boolean(email && verified && allowed.includes(email));
}

// What the admin page shows for a report. A reporter's email is included only
// if they agreed to be contacted.
export function toAdminView(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    type: row.type,
    status: row.status,
    message: row.message,
    details: row.details || {},
    email: row.contact_ok ? row.email || "" : "",
    reporter: String(row.user_sub || "").slice(-6),
  };
}
