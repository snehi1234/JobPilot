// config.js — central configuration for Hiresprint.
//
// BACKEND_URL: when set to your deployed backend (e.g.
//   "https://jobpilot-backend.vercel.app"), the extension calls the backend and
//   users do NOT need their own API key.
// When left empty (""), AI requests fail explicitly. This release has no
// client-side model calls or alternate paid-provider fallback.

export const BACKEND_URL = "https://backend-alpha-seven-87.vercel.app";

// GOOGLE_CLIENT_ID: an OAuth 2.0 "Web application" client ID from Google Cloud
// Console. Used for "Sign in with Google". Leave empty to disable auth (the
// extension then works without login, using the local/backend flow as before).
//
// Setup (one-time):
//   1. https://console.cloud.google.com → APIs & Services → Credentials
//   2. Create Credentials → OAuth client ID → type "Web application"
//   3. Under "Authorized redirect URIs" add:
//        https://<YOUR_EXTENSION_ID>.chromiumapp.org/
//      (find <YOUR_EXTENSION_ID> on chrome://extensions for Hiresprint)
//   4. Copy the client ID here.
export const GOOGLE_CLIENT_ID = "136843611240-20qa0e8f5234di2kjth0a37mp6hihmiq.apps.googleusercontent.com";
