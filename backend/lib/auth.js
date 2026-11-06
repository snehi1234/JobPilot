// lib/auth.js — verify Google ID tokens on the server.
//
// The extension sends the Google id_token as "Authorization: Bearer <token>".
// We verify it against Google's public certs and return the user's claims.
// This ties every request to a real Google account instead of an IP address.

const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
let certsCache = { keys: null, exp: 0 };

async function getGoogleCerts() {
  const now = Date.now();
  if (certsCache.keys && now < certsCache.exp) return certsCache.keys;
  const res = await fetch(CERTS_URL);
  const data = await res.json();
  // Cache for 1 hour (Google rotates keys but sends cache headers ~ this long).
  certsCache = { keys: data.keys, exp: now + 60 * 60 * 1000 };
  return data.keys;
}

function b64urlToUint8(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// Verify a Google ID token (RS256). Returns the decoded claims or throws.
export async function verifyGoogleToken(idToken, expectedClientId) {
  if (!idToken) throw new Error("Missing token.");
  const [headerB64, payloadB64, sigB64] = idToken.split(".");
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error("Malformed token.");

  const header = JSON.parse(new TextDecoder().decode(b64urlToUint8(headerB64)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToUint8(payloadB64)));

  // Basic claim checks.
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) throw new Error("Token expired.");
  const iss = payload.iss;
  if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") {
    throw new Error("Invalid issuer.");
  }
  if (expectedClientId && payload.aud !== expectedClientId) {
    throw new Error("Invalid audience.");
  }

  // Find the matching public key by kid.
  const keys = await getGoogleCerts();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Signing key not found.");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToUint8(sigB64),
    signed
  );
  if (!valid) throw new Error("Invalid signature.");

  return payload; // includes sub, email, name, picture, ...
}

// Extract + verify from a request. Returns claims, or null if auth not enforced.
export async function getUserFromRequest(req) {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  // If no client ID configured on the server, auth is not enforced.
  if (!clientId) return null;

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) {
    const err = new Error("Authentication required.");
    err.status = 401;
    throw err;
  }
  try {
    return await verifyGoogleToken(token, clientId);
  } catch (e) {
    const err = new Error(`Auth failed: ${e.message}`);
    err.status = 401;
    throw err;
  }
}
