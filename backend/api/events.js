// api/events.js — anonymous product-usage events.
//   POST /api/events                      body { installId, version, events: [{ name, ts, props }] }
//   GET  /api/events?uninstall=1&i=…&v=…  Chrome opens this when the extension is
//                                         removed; records it and shows a goodbye page.
// Signed-in requests are linked to the account so metrics can count users;
// signing in is not required, and a bad token never blocks the event.

import { applyCors, handlePreflight, rateLimit, readJsonBody } from "../lib/http.js";
import { getUserFromRequest } from "../lib/auth.js";
import { isDbConfigured, insertEvents, deleteEventsBefore } from "../lib/db.js";
import { sanitizeEvents, cleanInstallId, cleanVersion, EVENT_RETENTION_DAYS } from "../lib/events.js";

async function optionalUser(req) {
  if (!req.headers.authorization) return null;
  try {
    return await getUserFromRequest(req);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;

  if (req.method === "GET") {
    const installId = cleanInstallId(req.query?.i);
    if (req.query?.uninstall !== undefined && installId && isDbConfigured()) {
      await insertEvents([{
        install_id: installId,
        user_sub: null,
        name: "uninstall",
        version: cleanVersion(req.query?.v),
        props: {},
        created_at: new Date().toISOString(),
      }]).catch((err) => console.error(`[events] uninstall save failed: ${err.message}`));
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Location", installId ? `/goodbye.html?i=${encodeURIComponent(installId)}` : "/goodbye.html");
    return res.status(302).end();
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  if (!isDbConfigured()) return res.status(202).json({ ok: true, stored: 0 });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return res.status(400).json({ error: "Invalid JSON body." });
  }

  const installId = cleanInstallId(body?.installId);
  if (!installId) return res.status(400).json({ error: "Missing install id." });
  // The shared limiter allows 6 calls a minute; the extension batches events.
  const limit = rateLimit(`ev:${installId}`);
  if (!limit.ok) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    return res.status(429).json({ error: "Too many requests." });
  }

  const user = await optionalUser(req);
  const parsed = sanitizeEvents(body, { userSub: user?.sub || null });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  try {
    await insertEvents(parsed.rows);
    if (Math.random() < 0.02) {
      const cutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 86400_000).toISOString();
      deleteEventsBefore(cutoff).catch((err) => console.error(`[events] cleanup failed: ${err.message}`));
    }
    return res.status(200).json({ ok: true, stored: parsed.rows.length });
  } catch (err) {
    console.error(`[events] save failed: ${err.message}`);
    return res.status(500).json({ error: "Couldn't save events." });
  }
}
