// api/tailor.js — POST /api/tailor
// Body: { resume, jobContext: { title, company, description } }
// Returns: { summary, bullets: [{ original, line, improved, keywords }], skills, gaps }

import { callAI, extractJson, AI_UNAVAILABLE } from "../lib/ai.js";
import { buildTailorPrompt, TAILOR_GEN_CONFIG, sanitizeTailoring } from "../lib/tailor.js";
import { applyCors, handlePreflight, rateLimit, callerKey, readJsonBody } from "../lib/http.js";
import { getUserFromRequest } from "../lib/auth.js";
import { checkAndIncrementUsage, usageLimitMessage } from "../lib/usage.js";

export default async function handler(req, res) {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." });

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
  const { resume, jobContext } = body || {};
  if (typeof resume !== "string" || resume.trim().length < 200) {
    return res.status(400).json({ error: "Upload a resume first." });
  }
  if (!jobContext || String(jobContext.description || "").trim().length < 150) {
    return res.status(400).json({ error: "Couldn't find this job's description to tailor against." });
  }

  const key = user?.sub ? `gen:${user.sub}` : `gen:${callerKey(req)}`;
  const limit = rateLimit(key);
  if (!limit.ok) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    return res.status(429).json({ error: `Rate limit reached. Retry in ${limit.retryAfter}s.` });
  }
  const usage = await checkAndIncrementUsage(user?.sub);
  if (!usage.allowed) return res.status(429).json({ error: usageLimitMessage(usage), usageLimitReached: true });

  try {
    const raw = extractJson(await callAI(buildTailorPrompt({ resume, jobContext }), TAILOR_GEN_CONFIG));
    const result = sanitizeTailoring(raw, resume, { wholeBullets: body.wholeBullets === true });
    if (!result.bullets.length && !result.summary) throw new Error("No grounded suggestions");
    return res.status(200).json(result);
  } catch (err) {
    console.error(`[tailor] failed: ${err.message}`);
    if (err.status === 429) return res.status(429).json({ error: err.message });
    return res.status(502).json({ error: AI_UNAVAILABLE });
  }
}
