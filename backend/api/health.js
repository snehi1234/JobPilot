// api/health.js — GET /api/health — quick check that the server + key are set.
import { applyCors, handlePreflight } from "../lib/http.js";
import { monthlyLimit } from "../lib/usage.js";
import { listGroqModels } from "../lib/ai.js";

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

  return res.status(200).json({
    ok: true,
    service: "jobpilot-backend",
    aiProvider: "groq",
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
    availableModels,
    modelError,
    authEnforced: Boolean(process.env.GOOGLE_CLIENT_ID),
    dbConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    usageMonthlyLimit: monthlyLimit(),
    time: new Date().toISOString(),
  });
}
