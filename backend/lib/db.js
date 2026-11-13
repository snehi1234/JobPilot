// lib/db.js — Supabase REST access for storing per-user profiles.
//
// Uses the Supabase service-role key (server-only) to read/write the
// `profiles` table. Each row is keyed by the user's Google `sub` (subject) id,
// so every user's data is isolated.
//
// Env vars:
//   SUPABASE_URL              e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY the service_role secret (NOT the anon key)

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase not configured.");
  return { url: url.replace(/\/$/, ""), key };
}

export function isDbConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const TABLE = "profiles";

// Fetch a user's profile row, or null if none exists.
export async function getProfile(userSub) {
  const { url, key } = config();
  const res = await fetch(
    `${url}/rest/v1/${TABLE}?user_sub=eq.${encodeURIComponent(userSub)}&select=*`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    }
  );
  if (!res.ok) throw new Error(`DB read failed: ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

// Insert or update a user's profile (upsert on user_sub).
export async function upsertProfile(userSub, data) {
  const { url, key } = config();
  const row = {
    user_sub: userSub,
    email: data.email || null,
    structured: data.structured || {},
    profile_text: data.profileText || "",
    resume_text: data.resumeText || "",
    updated_at: new Date().toISOString(),
  };
  if (data.resumes !== undefined) row.resumes = data.resumes;
  let res = await writeProfileRow(url, key, row);
  // Databases not yet migrated lack the resumes column; keep saving the rest.
  if (!res.ok && row.resumes !== undefined && res.status === 400) {
    const body = await res.clone().text();
    if (/resumes/.test(body)) {
      const { resumes, ...rest } = row;
      res = await writeProfileRow(url, key, rest);
    }
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`DB write failed: ${res.status} ${t.slice(0, 200)}`);
  }
  const rows = await res.json();
  return rows[0] || row;
}

function writeProfileRow(url, key, row) {
  return fetch(`${url}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(row),
  });
}

// Lightweight connectivity/schema check used by /api/health. Returns only
// status information, never row data.
export async function checkProfilesTable() {
  const { url, key } = config();
  const res = await fetch(`${url}/rest/v1/${TABLE}?select=user_sub&limit=0`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (res.ok) return { ok: true, status: res.status };
  const body = await res.json().catch(() => ({}));
  return { ok: false, status: res.status, code: body.code || null, hint: (body.message || "").slice(0, 160) };
}

// Delete a user's profile (for "delete my data").
export async function deleteProfile(userSub) {
  const { url, key } = config();
  const res = await fetch(
    `${url}/rest/v1/${TABLE}?user_sub=eq.${encodeURIComponent(userSub)}`,
    {
      method: "DELETE",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    }
  );
  if (!res.ok) throw new Error(`DB delete failed: ${res.status}`);
  return true;
}

// ---------- Feedback reports ----------

const FEEDBACK = "feedback";

async function feedbackRequest(query, { method = "GET", body, prefer } = {}) {
  const { url, key } = config();
  const headers = { apikey: key, Authorization: "Bearer " + key };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${url}/rest/v1/${FEEDBACK}${query}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Feedback ${method} failed: ${res.status} ${text.slice(0, 160)}`);
  }
  return method === "DELETE" ? true : res.json();
}

export async function insertFeedback(row) {
  const rows = await feedbackRequest("", { method: "POST", body: row, prefer: "return=representation" });
  return rows[0] || row;
}

// Number of reports a user sent since the given time (for the daily limit).
export async function countFeedbackSince(userSub, sinceIso) {
  const rows = await feedbackRequest(
    `?select=id&user_sub=eq.${encodeURIComponent(userSub)}&created_at=gte.${encodeURIComponent(sinceIso)}&limit=50`
  );
  return rows.length;
}

export function listFeedback(limit = 500) {
  return feedbackRequest(`?select=*&order=created_at.desc&limit=${Math.min(Math.max(1, limit), 1000)}`);
}

export async function updateFeedbackStatus(id, status) {
  const rows = await feedbackRequest(`?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { status, updated_at: new Date().toISOString() },
    prefer: "return=representation",
  });
  return rows[0] || null;
}

export function deleteFeedbackForUser(userSub) {
  return feedbackRequest(`?user_sub=eq.${encodeURIComponent(userSub)}`, { method: "DELETE" });
}

// ---------- Usage events (admin metrics) ----------

async function restRequest(path, { method = "GET", body, prefer } = {}) {
  const { url, key } = config();
  const headers = { apikey: key, Authorization: "Bearer " + key };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DB ${method} ${path.split("?")[0]} failed: ${res.status} ${text.slice(0, 160)}`);
  }
  if (method === "DELETE" || prefer === "return=minimal") return true;
  return res.json();
}

export function insertEvents(rows) {
  if (!rows.length) return Promise.resolve(true);
  return restRequest("events", { method: "POST", body: rows, prefer: "return=minimal" });
}

export function deleteEventsForUser(userSub) {
  return restRequest(`events?user_sub=eq.${encodeURIComponent(userSub)}`, { method: "DELETE" });
}

export function deleteEventsBefore(iso) {
  return restRequest(`events?created_at=lt.${encodeURIComponent(iso)}`, { method: "DELETE" });
}

export function getAdminMetrics(days = 30) {
  return restRequest("rpc/admin_metrics", { method: "POST", body: { p_days: days } });
}
