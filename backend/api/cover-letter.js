// api/cover-letter.js — POST /api/cover-letter
// Body: { jobContext: { title, company, description }, profile, structured }
// Returns: { letter }

import { callAI, extractJson, AI_UNAVAILABLE } from "../lib/ai.js";
import { buildCoverLetterPrompt, COVER_LETTER_GEN_CONFIG } from "../lib/prompts.js";
import { applyCors, handlePreflight, rateLimit, callerKey, readJsonBody } from "../lib/http.js";
import { getUserFromRequest } from "../lib/auth.js";
import { checkAndIncrementUsage, usageLimitMessage } from "../lib/usage.js";

export default async function handler(req, res) {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  let user;
  try {
    user = await getUserFromRequest(req);
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return res.status(400).json({ error: "Invalid JSON body." });
  }
  const { jobContext, profile, structured } = body || {};
  if (typeof profile !== "string" || !profile.trim()) {
    return res.status(400).json({ error: "A resume is needed to write a cover letter." });
  }

  const key = user?.sub ? `gen:${user.sub}` : `gen:${callerKey(req)}`;
  const limit = rateLimit(key);
  if (!limit.ok) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    return res.status(429).json({ error: `Rate limit reached. Retry in ${limit.retryAfter}s.` });
  }
  const usage = await checkAndIncrementUsage(user?.sub);
  if (!usage.allowed) {
    return res.status(429).json({ error: usageLimitMessage(usage), usageLimitReached: true });
  }

  try {
    const prompt = buildCoverLetterPrompt({ jobContext: jobContext || {}, profile, structured: structured || {} });
    const parsed = extractJson(await callAI(prompt, COVER_LETTER_GEN_CONFIG));
    const letter = typeof parsed?.letter === "string" ? parsed.letter.trim() : "";
    if (letter.split(/\s+/).length < 80) throw new Error("Cover letter too short");
    return res.status(200).json({ letter });
  } catch (err) {
    console.error(`[cover-letter] AI request failed: ${err.message}`);
    if (err.status === 429) return res.status(429).json({ error: err.message });
    return res.status(502).json({ error: AI_UNAVAILABLE });
  }
}
