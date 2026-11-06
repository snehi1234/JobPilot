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
  const res = await fetch(`${url}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`DB write failed: ${res.status} ${t.slice(0, 200)}`);
  }
  const rows = await res.json();
  return rows[0] || row;
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
