// auth.js — "Sign in with Google" for the extension using Chrome's identity API.
//
// Flow: launchWebAuthFlow opens Google's OAuth consent, Google redirects back to
// https://<extension-id>.chromiumapp.org/ with an id_token in the URL fragment.
// We store that token and send it to the backend, which verifies it and knows
// exactly which user is calling.

import { GOOGLE_CLIENT_ID } from "./config.js";

const AUTH_KEY = "auth"; // chrome.storage.local key: { idToken, user, exp }

export function isAuthConfigured() {
  return Boolean(GOOGLE_CLIENT_ID);
}

// Decode a JWT payload (no verification — that happens server-side).
function decodeJwt(token) {
  try {
    const payload = token.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Return the current signed-in user, or null. Refreshes silently if expired.
export async function getCurrentUser() {
  const { [AUTH_KEY]: auth } = await chrome.storage.local.get(AUTH_KEY);
  if (!auth?.idToken) return null;
  // Token still valid (with 60s buffer)?
  if (auth.exp && Date.now() / 1000 < auth.exp - 60) return auth.user;
  // Expired — try a silent re-auth.
  try {
    return await signIn({ interactive: false });
  } catch {
    return null;
  }
}

export async function getIdToken() {
  const { [AUTH_KEY]: auth } = await chrome.storage.local.get(AUTH_KEY);
  if (!auth?.idToken) return null;
  if (auth.exp && Date.now() / 1000 >= auth.exp - 60) {
    // Expired — refresh silently.
    try {
      await signIn({ interactive: false });
      const { [AUTH_KEY]: fresh } = await chrome.storage.local.get(AUTH_KEY);
      return fresh?.idToken || null;
    } catch {
      return null;
    }
  }
  return auth.idToken;
}

// Kick off (or silently refresh) Google sign-in. Resolves with the user object.
export async function signIn({ interactive = true } = {}) {
  if (!GOOGLE_CLIENT_ID) throw new Error("Google sign-in is not configured.");

  const redirectUri = chrome.identity.getRedirectURL(); // https://<id>.chromiumapp.org/
  const nonce = crypto.randomUUID();

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      response_type: "id_token",
      redirect_uri: redirectUri,
      scope: "openid email profile",
      nonce,
      prompt: interactive ? "consent" : "none",
    }).toString();

  const redirectResponse = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive,
  });

  // The id_token comes back in the URL fragment.
  const fragment = new URL(redirectResponse).hash.substring(1);
  const idToken = new URLSearchParams(fragment).get("id_token");
  if (!idToken) throw new Error("No id_token returned from Google.");

  const claims = decodeJwt(idToken);
  if (!claims || claims.nonce !== nonce) {
    throw new Error("Invalid token (nonce mismatch).");
  }

  const user = {
    sub: claims.sub,
    email: claims.email,
    name: claims.name,
    picture: claims.picture,
  };
  const { [AUTH_KEY]: previousAuth } = await chrome.storage.local.get(AUTH_KEY);
  await chrome.storage.local.set({
    [AUTH_KEY]: { idToken, user, exp: claims.exp },
    ...(previousAuth?.user?.sub !== user.sub ? { autoFillEnabled: false } : {}),
  });
  return user;
}

export async function signOut() {
  await chrome.storage.local.remove([AUTH_KEY, "autoFillEnabled", "parseCache"]);
}
