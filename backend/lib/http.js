// lib/http.js — shared HTTP helpers: CORS and a simple in-memory rate limiter.
//
// NOTE: the in-memory limiter resets whenever the serverless function cold-
// starts, so it is only a light safeguard. For production, back this with a
// shared store (e.g. Upstash Redis) keyed by the authenticated user id.

// Allow the extension origins to call this API. Chrome extension pages send an
// Origin like "chrome-extension://<id>". We allow those plus localhost for dev.
export function applyCors(req, res) {
  const origin = req.headers.origin || "";
  const allowed =
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.0.0.1");

  res.setHeader("Access-Control-Allow-Origin", allowed ? origin : "");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// Handle the CORS preflight. Returns true if the request was a preflight.
export function handlePreflight(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

// --- Simple sliding-window rate limiter (per key, in-memory) ---
const WINDOW_MS = 60_000; // 1 minute
const MAX_PER_WINDOW = 20; // requests per key per window
const hits = new Map(); // key -> number[] (timestamps)

export function rateLimit(key) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) {
    hits.set(key, arr);
    return { ok: false, retryAfter: Math.ceil((WINDOW_MS - (now - arr[0])) / 1000) };
  }
  arr.push(now);
  hits.set(key, arr);
  return { ok: true };
}

// Identify the caller. For now we use IP; once auth lands, switch to user id.
export function callerKey(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "anonymous"
  );
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
