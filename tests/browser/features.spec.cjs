const { test, expect, profile } = require("./extension.cjs");

const JOB_URL = "https://careers.acme.test/jobs/123/apply";
const SOFTWARE = "Software Engineer. Java, Kubernetes, Docker, microservices, PostgreSQL, Redis, REST APIs, distributed systems.";
const DATA = "Data Engineer. ETL data pipelines with Spark, Airflow, dbt, Snowflake, SQL, Python, Kafka.";

const PAGE = `<!doctype html><html><head><title>Acme - Data Engineer</title></head><body>
<h1>Data Engineer</h1>
<div class="job-description">Own ETL pipelines using Spark, Airflow and dbt on Snowflake. Strong SQL and Python. Kafka streaming.</div>
<form id="app" onsubmit="event.preventDefault()">
  <div id="step1">
    <label for="fn">First name</label><input id="fn" name="fn">
    <label for="ln">Last name</label><input id="ln" name="ln">
    <label for="em">Email</label><input id="em" name="em" type="email">
    <label for="reloc">Are you open to relocation?</label>
    <select id="reloc" name="reloc"><option value="">Select…</option><option>Yes</option><option>No</option></select>
    <label for="why">Why do you want to work at Acme?</label><textarea id="why" name="why"></textarea>
    <label for="cv">Resume/CV</label><input id="cv" name="cv" type="file">
    <button type="button" id="next">Next</button>
  </div>
</form>
<script>
  document.getElementById("next").onclick = () => {
    document.getElementById("step1").remove();
    const step = document.createElement("div");
    step.id = "step2";
    step.innerHTML = '<label for="ph">Phone number</label><input id="ph" name="ph">' +
      '<label for="li">LinkedIn profile</label><input id="li" name="li">' +
      '<label for="city">City</label><input id="city" name="city">';
    document.getElementById("app").appendChild(step);
  };
</script></body></html>`;

async function setup(app, { resumes = true } = {}) {
  const { context, worker, api } = app;
  await context.route(JOB_URL, (route) => route.fulfill({ contentType: "text/html", body: PAGE }));
  await worker.evaluate(async ({ details, software, data, withResumes }) => {
    const pdf = btoa("%PDF-1.4 synthetic");
    await chrome.storage.local.set({
      structured: details,
      uploadedResumeText: software,
      ...(withResumes ? {
        resumes: [
          { id: "sw", name: "Software", text: software, fileName: "software.pdf" },
          { id: "de", name: "Data", text: data, fileName: "data.pdf" },
        ],
        defaultResumeId: "sw",
        resumeFiles: {
          sw: { name: "software.pdf", type: "application/pdf", data: pdf },
          de: { name: "data.pdf", type: "application/pdf", data: pdf },
        },
      } : {}),
    });
  }, { details: profile, software: SOFTWARE, data: DATA, withResumes: resumes });
  api.suggestions = (fields) => fields.flatMap((field) => {
    if (/relocation/i.test(field.label)) return [{ id: field.id, label: field.label, value: "Yes", confidence: "high" }];
    if (/why do you want/i.test(field.label)) return [{ id: field.id, label: field.label, value: "AI draft about pipelines.", confidence: "medium" }];
    return [];
  });
  const job = await context.newPage();
  await job.goto(JOB_URL);
  await expect(job.locator("#jobpilot-fab")).toBeVisible({ timeout: 15000 });
  return job;
}

// The floating button can re-render right after the page loads; retry the
// click until a fill visibly starts.
async function autofill(job) {
  await expect(async () => {
    await job.locator("#jobpilot-fab").getByRole("button", { name: /autofill/i }).click({ timeout: 2000 });
    await expect(job.locator("#jobpilot-toast")).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
}
const checklist = (job) => job.locator("#jobpilot-checklist");

test("fills, colour-codes, attaches the best-matching resume, and shows the checklist", async ({ app }) => {
  const job = await setup(app);
  await autofill(job);
  await expect(job.locator("#fn")).toHaveValue("Alex");
  await expect(job.locator("#em")).toHaveValue(profile.email);
  await expect(job.locator("#reloc")).toHaveValue("Yes", { timeout: 10000 });
  await expect(job.locator("#why")).toHaveValue("AI draft about pipelines.");

  await expect(job.locator("#fn")).toHaveAttribute("data-jobpilot-source", "profile");
  await expect(job.locator("#reloc")).toHaveAttribute("data-jobpilot-source", "ai");
  await expect(job.locator("#why")).toHaveAttribute("data-jobpilot-source", "draft");

  // The data-engineering job picks the "Data" resume and attaches its file.
  await expect.poll(() => job.locator("#cv").evaluate((el) => el.files[0]?.name || "")).toBe("data.pdf");
  const generate = app.api.calls.find((c) => c.endpoint === "/api/generate");
  expect(generate.body.profile).toContain("Spark");

  const panel = checklist(job);
  await expect(panel).toBeAttached();
  const text = await panel.evaluate((host) => host.shadowRoot.textContent);
  expect(text).toContain("Resume: Data");
  expect(text).toMatch(/AI answers? to review/);
  expect(text).toContain("Resume file attached");
  expect(text).toContain("Shorter");
  expect(app.api.errors).toEqual([]);
});

test("undo restores the page exactly as it was", async ({ app }) => {
  const job = await setup(app);
  await job.locator("#ln").fill("Typed-before");
  await autofill(job);
  await expect(job.locator("#reloc")).toHaveValue("Yes", { timeout: 10000 });
  await expect(checklist(job)).toBeAttached();
  await checklist(job).evaluate((host) => host.shadowRoot.querySelector(".undo").click());
  await expect(job.locator("#fn")).toHaveValue("");
  await expect(job.locator("#ln")).toHaveValue("Typed-before");
  await expect(job.locator("#reloc")).toHaveValue("");
  await expect(job.locator("#why")).toHaveValue("");
  expect(await job.locator("#cv").evaluate((el) => el.files.length)).toBe(0);
  expect(await job.locator("[data-jobpilot-source]").count()).toBe(0);
  await expect(checklist(job)).not.toBeAttached();
});

test("a corrected answer is learned and reused without asking the AI", async ({ app }) => {
  const job = await setup(app);
  await autofill(job);
  await expect(job.locator("#reloc")).toHaveValue("Yes", { timeout: 10000 });
  // A real keyboard change (trusted events), as a user would make it.
  await job.locator("#reloc").focus();
  await job.keyboard.press("ArrowDown");
  await job.keyboard.press("Tab");
  await expect(job.locator("#reloc")).toHaveValue("No");
  await expect(job.locator("#reloc")).toHaveAttribute("data-jobpilot-source", "correction", { timeout: 3000 });
  const learned = await app.worker.evaluate(async () => (await chrome.storage.local.get("answerCorrections")).answerCorrections);
  expect(JSON.stringify(learned)).toContain("No");

  await job.reload();
  await expect(job.locator("#jobpilot-fab")).toBeVisible({ timeout: 15000 });
  const before = app.api.calls.filter((c) => c.endpoint === "/api/generate").length;
  await autofill(job);
  await expect(job.locator("#reloc")).toHaveValue("No", { timeout: 10000 });
  await expect(job.locator("#reloc")).toHaveAttribute("data-jobpilot-source", "correction");
  await expect.poll(() => app.api.calls.filter((c) => c.endpoint === "/api/generate").length, { timeout: 5000 }).toBeGreaterThanOrEqual(before);
  const lastFields = app.api.calls.filter((c) => c.endpoint === "/api/generate").slice(before).flatMap((c) => c.body.fields.map((f) => f.label));
  expect(lastFields.some((label) => /relocation/i.test(label))).toBe(false);
});

test("the next step of a multi-page form is detected and filled", async ({ app }) => {
  const job = await setup(app);
  await autofill(job);
  await expect(job.locator("#reloc")).toHaveValue("Yes", { timeout: 10000 });
  await expect(checklist(job)).toBeAttached();
  await job.locator("#next").click();
  const action = job.locator("#jobpilot-toast").getByRole("button", { name: "Fill this step" });
  await expect(action).toBeVisible({ timeout: 8000 });
  await action.click();
  await expect(job.locator("#ph")).toHaveValue(profile.phone, { timeout: 10000 });
  await expect(job.locator("#li")).toHaveValue(profile.linkedin);
  await expect(job.locator("#city")).toHaveValue("Seattle");
  await expect(job.locator("#ph")).toHaveAttribute("data-jobpilot-source", "profile");
});

test("side panel lists resumes and shows the match for the open job", async ({ app }) => {
  const job = await setup(app);
  const { panel } = app;
  await panel.reload();
  await expect(panel.locator("#resumeList .resume-row")).toHaveCount(2);
  await expect(panel.locator("#resumeList input[type='text']").first()).toHaveValue("Software");
  // The panel reads the active tab; bring the job page to the front.
  await job.bringToFront();
  await panel.evaluate(() => window.dispatchEvent(new Event("focus")));
  await panel.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "https://careers.acme.test/*" });
    const jobContext = await chrome.tabs.sendMessage(tab.id, { type: "GET_JOB_CONTEXT" });
    const pick = await chrome.runtime.sendMessage({ type: "PICK_RESUME", jobContext, host: "careers.acme.test" });
    window.__pick = pick;
  });
  const pick = await panel.evaluate(() => window.__pick);
  expect(pick.resumeId).toBe("de");
  expect(pick.scores[0].score).toBeGreaterThan(pick.scores[1].score);
});
