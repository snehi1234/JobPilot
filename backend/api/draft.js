// api/draft.js — POST /api/draft
// Body: { question, answer, mode: "shorter" | "longer" | "regenerate", jobContext, profile }
// Returns: { answer }

import { callAI, extractJson, AI_UNAVAILABLE } from "../lib/ai.js";
import { buildDraftPrompt, DRAFT_GEN_CONFIG, DRAFT_MODES } from "../lib/prompts.js";
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
  const { question, answer, mode, jobContext, profile } = body || {};
  if (typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "Missing 'question'." });
  }
  if (!DRAFT_MODES.includes(mode)) {
    return res.status(400).json({ error: `'mode' must be one of: ${DRAFT_MODES.join(", ")}.` });
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
    const prompt = buildDraftPrompt({ question, answer, mode, jobContext: jobContext || {}, profile });
    const parsed = extractJson(await callAI(prompt, DRAFT_GEN_CONFIG));
    const text = typeof parsed?.answer === "string" ? parsed.answer.trim() : "";
    if (!text) throw new Error("Empty draft");
    return res.status(200).json({ answer: text });
  } catch (err) {
    console.error(`[draft] AI request failed: ${err.message}`);
    if (err.status === 429) return res.status(429).json({ error: err.message });
    return res.status(502).json({ error: AI_UNAVAILABLE });
  }
}
