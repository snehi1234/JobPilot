// lib/usage.js — per-user daily and monthly AI-request caps, backed by Supabase.
//
// Every Hiresprint user shares one Groq Free-plan organization (per model:
// 30 requests/min, 1K requests/day, 8K tokens/min, 200K tokens/day). These
// caps stop any single user from exhausting that shared budget. The extension
// answers most fields locally (profile rules + remembered answers), so a
// typical application needs at most one AI request.
//
// Uses a Postgres function (increment_usage) for atomic increments, so
// concurrent requests can't race past a limit. Daily and monthly counters are
// separate rows ("YYYY-MM-DD" and "YYYY-MM" period keys).
//
// Env vars (optional):
//   USAGE_DAILY_LIMIT    AI requests per user per UTC day   (default 25)
//   USAGE_MONTHLY_LIMIT  AI requests per user per month     (default 300)

import { isDbConfigured } from "./db.js";

const DEFAULT_DAILY_LIMIT = 25;
const DEFAULT_MONTHLY_LIMIT = 300;

function envLimit(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function monthlyLimit() {
  return envLimit("USAGE_MONTHLY_LIMIT", DEFAULT_MONTHLY_LIMIT);
}

export function dailyLimit() {
  return envLimit("USAGE_DAILY_LIMIT", DEFAULT_DAILY_LIMIT);
}

function periodKeys(date = new Date()) {
  const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  return { month, day: `${month}-${String(date.getUTCDate()).padStart(2, "0")}` };
}

async function increment(userSub, period) {
  const url = process.env.SUPABASE_URL.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${url}/rest/v1/rpc/increment_usage`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_user_sub: userSub, p_month: period }),
  });
  if (!res.ok) throw new Error(`increment_usage failed: ${res.status}`);
  return res.json();
}

// Checks and increments the caller's daily and monthly counters. Returns
// { allowed, count, limit, period }. Fails open on database errors, since the
// in-memory per-minute limiter still applies.
export async function checkAndIncrementUsage(userSub) {
  const limits = { day: dailyLimit(), month: monthlyLimit() };
  if (!userSub || !isDbConfigured()) {
    return { allowed: true, count: 0, limit: limits.month, period: "month" };
  }
  const keys = periodKeys();
  try {
    const today = await increment(userSub, keys.day);
    if (today > limits.day) return { allowed: false, count: today, limit: limits.day, period: "day" };
    const month = await increment(userSub, keys.month);
    return { allowed: month <= limits.month, count: month, limit: limits.month, period: "month" };
  } catch (err) {
    console.warn("[usage]", err.message);
    return { allowed: true, count: 0, limit: limits.month, period: "month" };
  }
}

export function usageLimitMessage(usage) {
  return usage.period === "day"
    ? `Daily AI limit reached (${usage.limit} requests). Fields from your profile and remembered answers still fill instantly; the AI resets at midnight UTC.`
    : `Monthly AI limit reached (${usage.limit} requests). It resets at the start of next month.`;
}
