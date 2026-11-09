// api/generate.js — POST /api/generate
// Body: { fields, profile, jobContext, structured, parsedEntries }
// Returns: { suggestions: [...] }
//
// The extension calls this endpoint; the Groq API key stays server-side.

import { callAI, extractJson } from "../lib/ai.js";
import { buildFillPrompt, FILL_GEN_CONFIG } from "../lib/prompts.js";
import {
  applyCors,
  handlePreflight,
  rateLimit,
  callerKey,
  readJsonBody,
} from "../lib/http.js";
import { getUserFromRequest } from "../lib/auth.js";
import { checkAndIncrementUsage, usageLimitMessage } from "../lib/usage.js";

export default async function handler(req, res) {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  // Verify the signed-in user (if auth is configured on the server).
  let user;
  try {
    user = await getUserFromRequest(req);
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message });
  }

  // Rate-limit per authenticated user when available, else per IP.
  const key = user?.sub ? `gen:${user.sub}` : `gen:${callerKey(req)}`;
  const limit = rateLimit(key);
  if (!limit.ok) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    return res
      .status(429)
      .json({ error: `Rate limit reached. Retry in ${limit.retryAfter}s.` });
  }

  // Monthly per-user usage cap — protects the shared AI quota from any one
  // heavy user starving everyone else.
  const usage = await checkAndIncrementUsage(user?.sub);
  if (!usage.allowed) {
    return res.status(429).json({
      error: usageLimitMessage(usage),
      usageLimitReached: true,
    });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return res.status(400).json({ error: "Invalid JSON body." });
  }

  const { fields, profile, jobContext, structured, parsedEntries } = body;
  if (!Array.isArray(fields) || fields.length === 0) {
    return res.status(400).json({ error: "Missing 'fields' array." });
  }

  try {
    const t0 = Date.now();
    const prompt = buildFillPrompt(fields, profile, jobContext, structured, parsedEntries);
    console.log(
      `[generate] user=${user?.email || "anon"} fields=${fields.length} promptChars=${prompt.length}`
    );
    const text = await callAI(prompt, FILL_GEN_CONFIG);
    const parsed = extractJson(text);
    console.log(
      `[generate] done in ${Date.now() - t0}ms, suggestions=${parsed.suggestions?.length || 0}`
    );
    return res.status(200).json({ suggestions: parsed.suggestions || [] });
  } catch (err) {
    const status = err.status === 429 ? 429 : 502;
    return res.status(status).json({ error: err.message || "AI request failed." });
  }
}
