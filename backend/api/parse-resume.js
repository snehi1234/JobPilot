// api/parse-resume.js — POST /api/parse-resume
// Body: { profile }
// Returns: { counts: { experience, education }, entries: { experience, education } }

import { callAI } from "../lib/ai.js";
import { buildParsePrompt, PARSE_GEN_CONFIG } from "../lib/prompts.js";
import {
  applyCors,
  handlePreflight,
  rateLimit,
  callerKey,
  readJsonBody,
} from "../lib/http.js";
import { getUserFromRequest } from "../lib/auth.js";
import { checkAndIncrementUsage } from "../lib/usage.js";

// Count experience/education entries directly from resume text using date
// ranges, as a reliable floor independent of the AI parse.
function heuristicCounts(text) {
  if (!text) return { experience: 1, education: 1 };
  const months = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
  const rangeRe = new RegExp(
    `${months}\\.?\\s*\\d{4}\\s*[–\\-—to]+\\s*(${months}\\.?\\s*\\d{4}|present|now|current)`,
    "gi"
  );
  const lower = text.toLowerCase();
  const expIdx = Math.max(
    lower.indexOf("professional experience"),
    lower.indexOf("work experience"),
    lower.indexOf("experience")
  );
  const eduIdx = lower.indexOf("education");
  const count = (seg) => (seg.match(rangeRe) || []).length;

  let experience = 0;
  let education = 0;
  if (eduIdx !== -1 && expIdx !== -1) {
    if (eduIdx < expIdx) {
      education = count(text.slice(eduIdx, expIdx));
      experience = count(text.slice(expIdx));
    } else {
      experience = count(text.slice(expIdx, eduIdx));
      education = count(text.slice(eduIdx));
    }
  } else if (expIdx !== -1) {
    experience = count(text.slice(expIdx));
  } else if (eduIdx !== -1) {
    education = count(text.slice(eduIdx));
  } else {
    experience = count(text);
  }
  return { experience: Math.max(1, experience), education: Math.max(1, education) };
}

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

  const key = user?.sub ? `parse:${user.sub}` : `parse:${callerKey(req)}`;
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
      error: `Monthly usage limit reached (${usage.limit} AI requests). It resets at the start of next month.`,
      usageLimitReached: true,
    });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return res.status(400).json({ error: "Invalid JSON body." });
  }

  const { profile } = body;
  const heuristic = heuristicCounts(profile || "");
  const clamp = (n) => Math.min(8, Math.max(1, n || 1));

  try {
    const text = await callAI(buildParsePrompt(profile), PARSE_GEN_CONFIG);
    let parsed;
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      const s = text.indexOf("{");
      const e = text.lastIndexOf("}");
      parsed = s !== -1 && e !== -1 ? JSON.parse(text.slice(s, e + 1)) : {};
    }
    const expList = Array.isArray(parsed.experience) ? parsed.experience : [];
    const eduList = Array.isArray(parsed.education) ? parsed.education : [];

    return res.status(200).json({
      counts: {
        experience: clamp(Math.max(expList.length, heuristic.experience)),
        education: clamp(Math.max(eduList.length, heuristic.education)),
      },
      entries: { experience: expList, education: eduList },
    });
  } catch (err) {
    if (err.status === 429) {
      return res.status(429).json({ error: err.message });
    }
    // AI failed — fall back to the heuristic so the client still works.
    return res.status(200).json({
      counts: {
        experience: clamp(heuristic.experience),
        education: clamp(heuristic.education),
      },
      entries: null,
      warning: err.message,
    });
  }
}
