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

const NON_CHAT = /whisper|tts|orpheus|guard|safeguard|embed|compound|allam/i;

async function usableModels() {
  const available = await listGroqModels();
  const preferred = PREFERRED_MODELS.filter((id) => available.includes(id));
  const others = available.filter((id) => !preferred.includes(id) && !NON_CHAT.test(id));
  const models = [...preferred, ...others].slice(0, 4);
  if (models.length) return models;
  const err = new Error("No usable Groq chat models are available to this API key.");
  err.status = 503;
  throw err;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Free-tier limits are per model and per minute, so a short wait usually
// clears them. Stay well inside the serverless function's 60 s limit.
const MAX_RETRY_WAIT_S = 10;
const RETRY_BUDGET_MS = 35000;

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
  const started = Date.now();

  let lastErr;
  let rateLimitErr;
  for (let pass = 0; pass < 2; pass++) {
  let shortestWait = Infinity;
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
          // gpt-oss "thinks" before answering; reasoning tokens count against
          // the per-minute token limit and add latency. Form filling needs
          // little reasoning.
          ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        const err = new Error(`Groq ${res.status} on ${model}: ${errText.slice(0, 200)}`);
        err.status = res.status;
        const retryHeader = res.headers.get("retry-after");
        const retryAfter = retryHeader === null ? NaN : Number(retryHeader);
        if (res.status === 429 && Number.isFinite(retryAfter)) shortestWait = Math.min(shortestWait, retryAfter);
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
  const waitMs = shortestWait * 1000;
  if (!rateLimitErr || shortestWait > MAX_RETRY_WAIT_S || Date.now() - started + waitMs > RETRY_BUDGET_MS) break;
  await sleep(waitMs + 250);
  }
  throw rateLimitErr || lastErr || new Error("All Groq models failed.");
}

export async function callAI(prompt, generationConfig = {}) {
  try {
    return await callGroq(prompt, generationConfig);
  } catch (err) {
    if (err.status === 429) {
      const limited = new Error(
        "JobPilot's free AI capacity is busy (rate limit 429). Please wait about a minute and try again."
      );
      limited.status = 429;
      throw limited;
    }
    throw err;
  }
}
