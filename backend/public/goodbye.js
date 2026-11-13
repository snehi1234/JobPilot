const installId = new URLSearchParams(location.search).get("i") || "";

document.getElementById("reasons").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-reason]");
  if (!button) return;
  document.querySelectorAll("#reasons button").forEach((b) => (b.disabled = true));
  if (installId) {
    await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId, events: [{ name: "uninstall_reason", props: { reason: button.dataset.reason } }] }),
    }).catch(() => {});
  }
  document.getElementById("reasons").style.display = "none";
  document.getElementById("thanks").style.display = "block";
});
