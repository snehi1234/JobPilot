// lib/usage.js — per-user monthly usage cap, backed by Supabase.
//
// Protects the shared AI quota (Groq) from any single user consuming
// it all and starving everyone else. Uses a Postgres function
// (increment_usage) for an atomic increment, so concurrent requests from the
// same user can't race past the limit.
//
// Env vars:
//   USAGE_MONTHLY_LIMIT   max AI calls (generate + parse combined) per user
//                          per calendar month. Defaults to 300 if unset.

import { isDbConfigured } from "./db.js";

const DEFAULT_LIMIT = 300;

export function monthlyLimit() {
  const n = Number(process.env.USAGE_MONTHLY_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Checks + atomically increments the caller's usage counter for this month.
// Returns { allowed, count, limit }. If the DB isn't configured, usage isn't
// tracked and every call is allowed (fails open, since a per-minute rate
// limiter already exists as a lighter safeguard).
export async function checkAndIncrementUsage(userSub) {
  const limit = monthlyLimit();
  if (!userSub || !isDbConfigured()) {
    return { allowed: true, count: 0, limit };
  }

  const url = process.env.SUPABASE_URL.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const month = currentMonthKey();

  try {
    const res = await fetch(`${url}/rest/v1/rpc/increment_usage`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_user_sub: userSub, p_month: month }),
    });
    if (!res.ok) {
      // Fail open on DB errors — don't block users due to an infra hiccup.
      console.warn("[usage] increment_usage failed:", res.status);
      return { allowed: true, count: 0, limit };
    }
    const count = await res.json();
    return { allowed: count <= limit, count, limit };
  } catch (err) {
    console.warn("[usage] increment_usage error:", err.message);
    return { allowed: true, count: 0, limit };
  }
}
