// api/health.js — GET /api/health — public liveness check.
// Reports only pass/fail flags; vendor, model and limit details stay in the
// server logs. Also called by a daily cron so the database stays active.
import { applyCors, handlePreflight } from "../lib/http.js";
import { listGroqModels } from "../lib/ai.js";
import { isDbConfigured, checkProfilesTable } from "../lib/db.js";

export default async function handler(req, res) {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;

  let ai = false;
  try {
    ai = (await listGroqModels()).length > 0;
  } catch (err) {
    console.error(`[health] AI check failed: ${err.message}`);
  }

  let database = false;
  if (isDbConfigured()) {
    try {
      const table = await checkProfilesTable();
      database = table.ok;
      if (!table.ok) console.error(`[health] database check failed: ${JSON.stringify(table)}`);
    } catch (err) {
      console.error(`[health] database check failed: ${err.message}`);
    }
  }

  return res.status(200).json({
    ok: ai && database,
    ai,
    database,
    auth: Boolean(process.env.GOOGLE_CLIENT_ID),
    time: new Date().toISOString(),
  });
}
