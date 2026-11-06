// cloud.js — sync the user's profile with the backend (cloud storage), so it
// follows them across devices. Falls back silently to local-only when the
// backend/DB isn't available.

import { BACKEND_URL } from "./config.js";
import { getIdToken } from "./auth.js";

const CLOUD_ENABLED = Boolean(BACKEND_URL);

async function authHeaders() {
  const token = await getIdToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// Fetch the signed-in user's profile from the cloud. Returns null if none / off.
export async function cloudLoad() {
  if (!CLOUD_ENABLED) return null;
  try {
    const res = await fetch(`${BACKEND_URL}/api/profile`, {
      method: "GET",
      headers: await authHeaders(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.profile || null;
  } catch (err) {
    console.warn("[JobPilot] cloudLoad failed:", err.message);
    return null;
  }
}

// Save the user's profile to the cloud. Returns true on success.
export async function cloudSave({ structured, profileText, resumeText }) {
  if (!CLOUD_ENABLED) return false;
  try {
    const res = await fetch(`${BACKEND_URL}/api/profile`, {
      method: "PUT",
      headers: await authHeaders(),
      body: JSON.stringify({ structured, profileText, resumeText }),
    });
    return res.ok;
  } catch (err) {
    console.warn("[JobPilot] cloudSave failed:", err.message);
    return false;
  }
}

// Delete the user's cloud data ("delete my data").
export async function cloudDelete() {
  if (!CLOUD_ENABLED) return false;
  try {
    const res = await fetch(`${BACKEND_URL}/api/profile`, {
      method: "DELETE",
      headers: await authHeaders(),
    });
    return res.ok;
  } catch (err) {
    console.warn("[JobPilot] cloudDelete failed:", err.message);
    return false;
  }
}
