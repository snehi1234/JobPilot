// Keep the Groq organization on its Free plan. Model failover stays within
// Groq; quota exhaustion must never trigger a different provider.

import { extractJson } from "./json.js";
export { extractJson };

// ----- Groq (OpenAI-compatible chat completions) -----

// Both free-tier models, with their approximate tokens-per-minute (TPM) limits.
// 8b-instant is faster but has a SMALLER TPM budget; 70b handles bigger prompts.
// Preference order. Only models the key can actually use are tried, so model
// retirements or project-level model restrictions don't break requests.
const PREFERRED_MODELS = [
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
  "qwen/qwen3-32b",
  "moonshotai/kimi-k2-instruct",
  "llama-3.1-8b-instant",
];
const MODEL_CACHE_MS = 10 * 60 * 1000;
let modelCache = { ids: null, exp: 0 };

export async function listGroqModels() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return [];
  if (modelCache.ids && Date.now() < modelCache.exp) return modelCache.ids;
  const res = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const err = new Error(`Groq ${res.status} listing models`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const ids = (data?.data || []).filter((m) => m.active !== false).map((m) => m.id);
  modelCache = { ids, exp: Date.now() + MODEL_CACHE_MS };
  return ids;
}

async function usableModels() {
  const available = new Set(await listGroqModels());
  const preferred = PREFERRED_MODELS.filter((id) => available.has(id));
  if (preferred.length) return preferred.slice(0, 3);
  const fallback = [...available].filter((id) => !/whisper|tts|guard|embed|compound/i.test(id));
  if (fallback.length) return fallback.slice(0, 3);
  const err = new Error("No usable Groq chat models are available to this API key.");
  err.status = 503;
  throw err;
}

// Rough token estimate (~4 chars/token) used to pick a model that fits.
function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

async function callGroq(prompt, { maxOutputTokens, temperature }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    const e = new Error("Groq is not configured. AI requests are disabled.");
    e.status = 503;
    throw e;
  }

  const order = await usableModels();

  let lastErr;
  let rateLimitErr;
  for (const model of order) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content:
                "You are a precise assistant that returns ONLY valid JSON, no markdown fences, no commentary.",
            },
            { role: "user", content: prompt },
          ],
          temperature: temperature ?? 0.2,
          max_tokens: Math.min(maxOutputTokens ?? 8192, 32768),
          response_format: { type: "json_object" },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        const err = new Error(`Groq ${res.status} on ${model}: ${errText.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content || "";
      if (!text) throw new Error(`Empty response from Groq ${model}.`);
      return text;
    } catch (err) {
      lastErr = err;
      if (err.status === 429) rateLimitErr = err;
      // Try next model on size (413), rate limit (429), overload, or missing model.
      if ([400, 404, 413, 429, 500, 502, 503, 504].includes(err.status)) continue;
      throw err;
    }
  }
  throw rateLimitErr || lastErr || new Error("All Groq models failed.");
}

export async function callAI(prompt, generationConfig = {}) {
  try {
    return await callGroq(prompt, generationConfig);
  } catch (err) {
    if (err.status === 429) {
      const limited = new Error(
        "Groq quota or rate limit reached (429). Try again later. No other AI provider will be used."
      );
      limited.status = 429;
      throw limited;
    }
    throw err;
  }
}
