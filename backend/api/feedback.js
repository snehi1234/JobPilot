// api/feedback.js — POST /api/feedback
// Body: { type, message, contactOk, includeDetails, details }
// Stores a bug report or idea from a signed-in user. Limited per user per day.

import { applyCors, handlePreflight, rateLimit, callerKey, readJsonBody } from "../lib/http.js";
import { getUserFromRequest } from "../lib/auth.js";
import { isDbConfigured, insertFeedback, countFeedbackSince } from "../lib/db.js";
import { sanitizeFeedback, MAX_FEEDBACK_PER_DAY } from "../lib/feedback.js";

export default async function handler(req, res) {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." });
  if (!isDbConfigured()) return res.status(503).json({ error: "Feedback is temporarily unavailable." });

  let user;
  try {
    user = await getUserFromRequest(req);
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message });
  }
  if (!user?.sub) return res.status(401).json({ error: "Please sign in to send feedback." });

  const limit = rateLimit(`fb:${user.sub || callerKey(req)}`);
  if (!limit.ok) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    return res.status(429).json({ error: `Please wait ${limit.retryAfter}s before sending more feedback.` });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return res.status(400).json({ error: "Invalid JSON body." });
  }
  const parsed = sanitizeFeedback(body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    if ((await countFeedbackSince(user.sub, since)) >= MAX_FEEDBACK_PER_DAY) {
      return res.status(429).json({ error: `You can send up to ${MAX_FEEDBACK_PER_DAY} reports a day. Thank you — please try again tomorrow.` });
    }
    const saved = await insertFeedback({
      ...parsed.value,
      user_sub: user.sub,
      email: user.email || null,
      status: "new",
    });
    return res.status(200).json({ ok: true, id: saved.id });
  } catch (err) {
    console.error(`[feedback] save failed: ${err.message}`);
    return res.status(500).json({ error: "Couldn't send your feedback. Please try again." });
  }
}
