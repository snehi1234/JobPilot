# Hiresprint — Deployment & Setup Guide

This guide covers the two things needed to run Hiresprint for real users:
**(1) install Node + deploy the backend**, and **(2) configure Google Sign-In**.

For Chrome Web Store release 0.1.2, the draft extension ID is
`gnohpngndnfdlbacmbmnoilgeaeljhep`. Add
`https://gnohpngndnfdlbacmbmnoilgeaeljhep.chromiumapp.org/` to the existing
OAuth client's redirect URIs without removing development redirects.

Automatic filling is off by default. Users must explicitly enable it in the
side panel after reading the data-sharing disclosure; manual filling remains
available. Consent is local to the browser and resets on sign-out, account
change, or profile deletion. Deploy the updated public privacy policy before
submitting the store draft. The backend's `.vercelignore` excludes personal
photos and local environment files from deployment.

This release uses only Groq. Keep the Groq organization on its **Free** plan;
do not add billing or upgrade it. Requests can fall back between the configured
Groq models, but never to Gemini or a different provider. Exhausted quotas
produce an error. Existing Gemini credentials are unused.

Validate release behavior with:
```
node --test .\tests\autofill-consent.test.cjs .\tests\background-routing.test.cjs .\backend\tests\ai.test.js
```
Then package with `powershell -File .\build-extension.ps1`.

---

## Prerequisite: install Node.js (needed for deploy)

Use a supported Node.js LTS release. If Node.js is not installed:

1. Download the **LTS** installer from https://nodejs.org
2. Run it (accept defaults). This installs both `node` and `npm`.
3. **Close and reopen** the terminal, then verify:
   ```
   node --version
   npm --version
   ```

---

## Part 1 — Deploy the backend (Vercel)

1. Install the Vercel CLI:
   ```
   npm i -g vercel
   ```
2. From the backend folder:
   ```
   cd backend
   vercel
   ```
   Follow the prompts (log in, link/create a project).
3. Add your secrets in the Vercel dashboard
   (Project → Settings → Environment Variables):
   ```
   GROQ_API_KEY     = <your Groq Free-plan key>
   GOOGLE_CLIENT_ID = <your OAuth client ID>   # from Part 2 (optional but recommended)
   ```
4. Deploy to production:
   ```
   vercel --prod
   ```
5. Copy your URL (e.g. `https://jobpilot-backend.vercel.app`) and set it in
   the extension's `config.js`:
   ```js
   export const BACKEND_URL = "https://jobpilot-backend.vercel.app";
   ```
6. Reload the extension. It now calls YOUR backend — users need no API key.

Test the backend:
```
https://<your-url>/api/health   →   { "ok": true, "aiProvider": "groq", "groqConfigured": true, ... }
```

---

## Part 2 — Configure Google Sign-In

1. Load the extension (chrome://extensions) and copy its **ID**.
2. Go to https://console.cloud.google.com → **APIs & Services → Credentials**.
3. **Create Credentials → OAuth client ID**.
4. Application type: **Web application**.
5. Under **Authorized redirect URIs**, add:
   ```
   https://<YOUR_EXTENSION_ID>.chromiumapp.org/
   ```
6. Copy the **Client ID** and set it in the extension's `config.js`:
   ```js
   export const GOOGLE_CLIENT_ID = "xxxx.apps.googleusercontent.com";
   ```
7. Also set the same value as `GOOGLE_CLIENT_ID` in the backend env vars so the
   server verifies tokens.
8. Reload the extension → a **"Sign in with Google"** bar appears in the panel.

When `GOOGLE_CLIENT_ID` is set on the backend, every request must include a
valid signed-in user, and rate limits apply **per user**.

---

## Toggle summary

| Setting                         | Empty (default)                  | Set                                   |
| ------------------------------- | -------------------------------- | ------------------------------------- |
| `config.js` → `BACKEND_URL`     | AI requests disabled             | Calls your hosted backend             |
| `config.js` → `GOOGLE_CLIENT_ID`| No login shown                   | Shows "Sign in with Google"           |
| backend env `GOOGLE_CLIENT_ID`  | Auth not enforced (IP limits)    | Requires a valid user (per-user limits)|

For local development, point `BACKEND_URL` at the local backend. Release with
both backend settings configured and the Groq organization on its Free plan.
