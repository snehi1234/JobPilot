// onboarding.js — logic for the welcome page: Google sign-in and opening the
// side panel so the user can set up their profile.

import { isAuthConfigured, getCurrentUser, signIn } from "./auth.js";

const els = {
  signInBtn: document.getElementById("signInBtn"),
  signedIn: document.getElementById("signedIn"),
  avatar: document.getElementById("avatar"),
  email: document.getElementById("email"),
  openPanelBtn: document.getElementById("openPanelBtn"),
  doneBtn: document.getElementById("doneBtn"),
};

function renderSignedIn(user) {
  els.signInBtn.classList.add("hidden");
  els.signedIn.classList.remove("hidden");
  els.email.textContent = user.email || user.name || "Signed in";
  if (user.picture) els.avatar.src = user.picture;
}

async function init() {
  if (!isAuthConfigured()) {
    // Auth not configured (dev) — hide the sign-in step gracefully.
    els.signInBtn.textContent = "Sign-in not configured";
    els.signInBtn.disabled = true;
    return;
  }

  const user = await getCurrentUser();
  if (user) renderSignedIn(user);

  els.signInBtn.addEventListener("click", async () => {
    els.signInBtn.disabled = true;
    els.signInBtn.textContent = "Signing in…";
    try {
      const u = await signIn({ interactive: true });
      renderSignedIn(u);
    } catch (err) {
      els.signInBtn.disabled = false;
      els.signInBtn.textContent = "Sign in with Google";
      alert(`Sign-in failed: ${err.message}`);
    }
  });
}

// Open the side panel on the user's current window.
async function openPanel() {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
  } catch (err) {
    alert("Click the JobPilot icon in your toolbar to open the panel.");
  }
}

els.openPanelBtn.addEventListener("click", openPanel);
els.doneBtn.addEventListener("click", async () => {
  await openPanel();
  // Close the onboarding tab after opening the panel.
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id) chrome.tabs.remove(tab.id);
});

init();
