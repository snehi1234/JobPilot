// api/admin-feedback.js — the admin page's API (same origin as /admin).
//   GET   /api/admin-feedback?config=1  → { clientId } (public; for Google sign-in)
//   GET   /api/admin-feedback           → { reports: [...] }        (admins only)
//   PATCH /api/admin-feedback           → body { id, status }        (admins only)
//
// Admins are the verified Google accounts listed in the ADMIN_EMAILS setting.

import { readJsonBody } from "../lib/http.js";
import { getUserFromRequest } from "../lib/auth.js";
import { isDbConfigured, listFeedback, updateFeedbackStatus } from "../lib/db.js";
import { isAdmin, toAdminView, FEEDBACK_STATUSES } from "../lib/feedback.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET" && req.query?.config !== undefined) {
    return res.status(200).json({ clientId: process.env.GOOGLE_CLIENT_ID || "" });
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.ADMIN_EMAILS) {
    return res.status(503).json({ error: "Admin access is not configured." });
  }

  let user;
  try {
    user = await getUserFromRequest(req);
  } catch (err) {
    return res.status(401).json({ error: "Please sign in again." });
  }
  if (!isAdmin(user)) return res.status(403).json({ error: "This account is not an admin." });
  if (!isDbConfigured()) return res.status(503).json({ error: "Database not configured." });

  try {
    if (req.method === "GET") {
      const rows = await listFeedback(500);
      return res.status(200).json({ admin: user.email, reports: rows.map(toAdminView) });
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody(req).catch(() => ({}));
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid report id." });
      if (!FEEDBACK_STATUSES.includes(body.status)) return res.status(400).json({ error: "Invalid status." });
      const row = await updateFeedbackStatus(id, body.status);
      if (!row) return res.status(404).json({ error: "Report not found." });
      return res.status(200).json({ report: toAdminView(row) });
    }
    return res.status(405).json({ error: "Method not allowed." });
  } catch (err) {
    console.error(`[admin-feedback] ${req.method} failed: ${err.message}`);
    return res.status(500).json({ error: "Database request failed." });
  }
}
