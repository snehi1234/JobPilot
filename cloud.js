// cloud.js — sync the user's profile with the backend (cloud storage), so it
// follows them across devices. Callers must surface synchronization failures.

import { BACKEND_URL } from "./config.js";
import { getIdToken } from "./auth.js";

const CLOUD_ENABLED = Boolean(BACKEND_URL);

async function checkResponse(response) {
  if (response.ok) return;
  const error = new Error(`Profile service returned HTTP ${response.status}.`);
  error.status = response.status;
  throw error;
}

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
    const res = await fetch(`${BACKEND_URL}/api/profile`, {
      method: "GET",
      headers: await authHeaders(),
    });
    await checkResponse(res);
    const data = await res.json();
    return data.profile || null;
}

// Save the user's profile to the cloud. Returns true on success.
export async function cloudSave({ structured, profileText, resumeText, resumes }) {
  if (!CLOUD_ENABLED) return false;
    const res = await fetch(`${BACKEND_URL}/api/profile`, {
      method: "PUT",
      headers: await authHeaders(),
      body: JSON.stringify({ structured, profileText, resumeText, resumes }),
    });
    await checkResponse(res);
    return true;
}

// Delete the user's cloud data ("delete my data").
export async function cloudDelete() {
  if (!CLOUD_ENABLED) return false;
    const res = await fetch(`${BACKEND_URL}/api/profile`, {
      method: "DELETE",
      headers: await authHeaders(),
    });
    await checkResponse(res);
    return true;
}
