// api/health.js — GET /api/health — quick check that the server + key are set.
import { applyCors, handlePreflight } from "../lib/http.js";
import { monthlyLimit, dailyLimit } from "../lib/usage.js";
import { listGroqModels } from "../lib/ai.js";
import { isDbConfigured, checkProfilesTable } from "../lib/db.js";

export default async function handler(req, res) {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;

  let availableModels = null;
  let modelError = null;
  try {
    availableModels = await listGroqModels();
  } catch (err) {
    modelError = err.message;
  }

  let profilesTable = null;
  if (isDbConfigured()) {
    try {
      profilesTable = await checkProfilesTable();
    } catch (err) {
      profilesTable = { ok: false, error: err.message };
    }
  }

  return res.status(200).json({
    ok: true,
    service: "jobpilot-backend",
    aiProvider: "groq",
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
    availableModels,
    modelError,
    authEnforced: Boolean(process.env.GOOGLE_CLIENT_ID),
    dbConfigured: isDbConfigured(),
    profilesTable,
    usageMonthlyLimit: monthlyLimit(),
    usageDailyLimit: dailyLimit(),
    time: new Date().toISOString(),
  });
}
