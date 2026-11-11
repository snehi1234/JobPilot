# Hiresprint Backend

A serverless proxy (Vercel) that holds the Groq API key and serves the
Hiresprint Chrome extension for **all users** — so end users never need their own
model key.

## Free-tier provider policy

- Keep the Groq organization on its **Free** plan. Do not upgrade or add billing.
- Inference uses `llama-3.1-8b-instant` and `llama-3.3-70b-versatile`, with
  token-aware ordering and failover only within Groq.
- Quota/rate-limit errors return HTTP 429. Neither the backend nor extension
  falls back to Gemini or a different provider.
- Existing `GEMINI_API_KEY` environment values are unused. Provider charges
  ultimately depend on the Groq account plan, not just the model names in code.

## Endpoints

| Method | Path                 | Purpose                                              |
| ------ | -------------------- | ---------------------------------------------------- |
| GET    | `/api/health`        | Active provider and required configuration flags    |
| POST   | `/api/generate`      | Fields + profile → AI fill suggestions               |
| POST   | `/api/parse-resume`  | Resume text → experience/education counts + entries  |
| GET/PUT/DELETE | `/api/profile` | Read, save, or delete the authenticated profile |

The Groq API key lives ONLY on the server (env var `GROQ_API_KEY`) and is
never exposed to the extension.

## Local development

1. Install the Vercel CLI:
   ```
   npm i -g vercel
   ```
2. Add your key:
   ```
   cp .env.example .env
   # edit .env and set your GROQ_API_KEY and other required settings
   ```
3. Run locally:
   ```
   vercel dev
   ```
   The API is served at `http://localhost:3000/api/...`.

## Deploy to production

1. From the `backend/` folder:
   ```
   vercel --prod
   ```
2. In the Vercel dashboard → Project → Settings → Environment Variables, add:
   ```
   GROQ_API_KEY = <your Groq Free-plan key>
   GOOGLE_CLIENT_ID = <the same OAuth client ID used by the extension>
   SUPABASE_URL = <your Supabase project URL>
   SUPABASE_SERVICE_ROLE_KEY = <your server-side Supabase key>
   ```
3. Note your production URL, e.g. `https://jobpilot-backend.vercel.app`.
4. Set that URL as `BACKEND_URL` in the extension (see the extension's
   `config.js`).

## Security notes

- CORS is restricted to `chrome-extension://` and localhost origins.
- A simple in-memory rate limiter guards each caller. For production scale,
  back it with Upstash Redis keyed by the authenticated user id.
- Configure Google sign-in for production; requests and monthly usage limits
  are associated with the authenticated account.
- `.vercelignore` excludes personal photos, environment files, and tests.

Run backend tests with `node --test .\tests\ai.test.js` from this directory.
