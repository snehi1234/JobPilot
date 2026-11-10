// api/profile.js — per-user profile storage.
//   GET    /api/profile          → returns the signed-in user's profile
//   PUT    /api/profile          → creates/updates it   (body: { structured, profileText, resumeText, resumes })
//   DELETE /api/profile          → deletes it ("delete my data")
//
// Requires a valid signed-in user (Google ID token in Authorization header).

import { applyCors, handlePreflight, readJsonBody } from "../lib/http.js";
import { getUserFromRequest } from "../lib/auth.js";
import { isDbConfigured, getProfile, upsertProfile, deleteProfile } from "../lib/db.js";
import { sanitizeResumes } from "../lib/resumes.js";

export default async function handler(req, res) {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;

  if (!isDbConfigured()) {
    return res.status(503).json({ error: "Cloud storage not configured on the server." });
  }

  // Must be signed in.
  let user;
  try {
    user = await getUserFromRequest(req);
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message });
  }
  if (!user?.sub) {
    return res.status(401).json({ error: "Authentication required." });
  }

  try {
    if (req.method === "GET") {
      const row = await getProfile(user.sub);
      return res.status(200).json({
        profile: row
          ? {
              structured: row.structured || {},
              profileText: row.profile_text || "",
              resumeText: row.resume_text || "",
              resumes: Array.isArray(row.resumes) ? row.resumes : [],
              updatedAt: row.updated_at,
            }
          : null,
      });
    }

    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      const saved = await upsertProfile(user.sub, {
        email: user.email,
        structured: body.structured || {},
        profileText: body.profileText || "",
        resumeText: body.resumeText || "",
        resumes: Array.isArray(body.resumes) ? sanitizeResumes(body.resumes) : undefined,
      });
      return res.status(200).json({ ok: true, updatedAt: saved.updated_at });
    }

    if (req.method === "DELETE") {
      await deleteProfile(user.sub);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed." });
  } catch (err) {
    console.error(`[profile] ${req.method} failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}
