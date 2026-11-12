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
  // Unknown pages on the fake job site answer 404 at once, like a real site,
  // instead of waiting on a DNS failure. Later, more specific routes win.
  await context.route("https://careers.acme.test/**", (route) => route.fulfill({ status: 404, body: "Not found" }));
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

// A single-page job site: the posting shows a short teaser, the full
// description is only in the page's JSON-LD, and "Apply" renders the form
// without a page load. The form has a site "autofill from resume" box, the
// real "Résumé" field, and a cover-letter field.
const SPA_URL = "https://careers.acme.test/jobs/456";
const SPA_PAGE = `<!doctype html><html><head><title>Acme - Data Engineer</title>
<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "Data Engineer",
  description: "<p>Own ETL data pipelines with Spark, Airflow and dbt on Snowflake.</p><ul><li>Strong SQL and Python</li><li>Kafka streaming</li></ul>" })}</script>
</head><body><main id="root"><h1>Data Engineer</h1><p>Join us.</p><button id="apply" type="button">Apply</button></main>
<script>
  document.getElementById("apply").onclick = () => {
    history.pushState({}, "", "/jobs/456/apply");
    document.getElementById("root").innerHTML =
      '<h1>Application: Data Engineer</h1><form onsubmit="event.preventDefault()">' +
      '<div class="parser"><p>Autofill from resume</p><p>Upload your resume here to autofill key application fields.</p><input type="file" id="parse"></div>' +
      '<label for="fn">First name</label><input id="fn">' +
      '<label for="em">Email</label><input id="em" type="email">' +
      '<label for="why2">Why do you want to work at Acme?</label><textarea id="why2"></textarea>' +
      '<div><div><span>Résumé*</span></div><div><div><p>Drop or select (.doc / .docx / .pdf)</p><input type="file" id="resume"></div></div></div>' +
      '<div><div><span>Cover letter</span></div><div><div><p>Drop or select (.doc / .docx / .pdf)</p><input type="file" id="cover"></div></div></div>' +
      '</form>';
  };
</script></body></html>`;

async function openSpa(app) {
  const job = await setup(app);
  await job.close();
  await app.context.route(SPA_URL, (route) => route.fulfill({ contentType: "text/html", body: SPA_PAGE }));
  await app.context.route(`${SPA_URL}/apply`, (route) => route.fulfill({ contentType: "text/html", body: SPA_PAGE }));
  const spa = await app.context.newPage();
  await spa.goto(SPA_URL);
  return spa;
}

test("single-page sites: the button appears when the form renders, the posting's description is scored, and only the résumé field gets the file", async ({ app }) => {
  const spa = await openSpa(app);
  await spa.waitForTimeout(2000);
  expect(await spa.locator("#jobpilot-fab").count()).toBe(0);
  await spa.locator("#apply").click();
  await expect(spa.locator("#jobpilot-fab")).toBeVisible({ timeout: 8000 });
  await autofill(spa);
  await expect(spa.locator("#fn")).toHaveValue("Alex", { timeout: 10000 });
  await expect.poll(() => spa.locator("#resume").evaluate((el) => el.files[0]?.name || ""), { timeout: 10000 }).toBe("data.pdf");
  expect(await spa.locator("#parse").evaluate((el) => el.files.length)).toBe(0);
  expect(await spa.locator("#cover").evaluate((el) => el.files.length)).toBe(0);
  await expect(checklist(spa)).toBeAttached();
  const text = await checklist(spa).evaluate((host) => host.shadowRoot.querySelector(".panel").innerText);
  expect(text).toMatch(/Resume: Data · \d+% match/);
  expect(text).toContain("Spark");
  const generate = app.api.calls.filter((c) => c.endpoint === "/api/generate").pop();
  expect(generate.body.jobContext.description).toContain("Airflow");
});

test("× hides the button on this page only; the panel switch hides it everywhere", async ({ app }) => {
  const job = await setup(app);
  await job.locator("#jobpilot-fab").evaluate((host) => host.shadowRoot.querySelectorAll("button")[1].click());
  await expect(job.locator("#jobpilot-fab")).toHaveCount(0);
  expect(await app.worker.evaluate(async () => (await chrome.storage.local.get("fabEnabled")).fabEnabled)).not.toBe(false);
  const other = await app.context.newPage();
  await other.goto(JOB_URL);
  await expect(other.locator("#jobpilot-fab")).toBeVisible({ timeout: 15000 });

  await app.panel.reload();
  await expect(app.panel.locator("#fabToggle")).toBeChecked();
  await app.panel.locator("#fabToggle").uncheck();
  await expect(other.locator("#jobpilot-fab")).toHaveCount(0);
  await app.panel.locator("#fabToggle").check();
  await expect(other.locator("#jobpilot-fab")).toBeVisible();
});

test("loading the scripts into an open page again (as after an update) replaces the old button", async ({ app }) => {
  const job = await setup(app);
  const errors = [];
  job.on("pageerror", (e) => errors.push(e.message));
  const before = await job.locator("#jobpilot-fab").getAttribute("data-jp-instance");
  const result = await app.panel.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content-ui.js", "content.js"] });
    return "ok";
  }, JOB_URL);
  expect(result).toBe("ok");
  await expect.poll(() => job.locator("#jobpilot-fab").getAttribute("data-jp-instance")).not.toBe(before);
  await expect(job.locator("#jobpilot-fab")).toHaveCount(1);
  await autofill(job);
  await expect(job.locator("#fn")).toHaveValue("Alex", { timeout: 10000 });
  expect(errors).toEqual([]);
});

test("on a job overview page, Autofill opens the application form and fills it", async ({ app }) => {
  const OVERVIEW = "https://careers.acme.test/jobs/789";
  const overview = `<!doctype html><html><head><title>Acme - Engineer</title></head><body>
    <nav><a href="/jobs/789">Overview</a> <a href="/jobs/789/application">Application</a></nav>
    <h1>Software Engineer</h1><p>Build things.</p><a href="/jobs/789/application">Apply for this Job</a>
    <label for="resume">Resume</label><input type="file" id="resume"></body></html>`;
  const form = `<!doctype html><html><head><title>Acme - Engineer</title></head><body>
    <nav><a href="/jobs/789">Overview</a> <a href="/jobs/789/application" aria-current="page">Application</a></nav>
    <h1>Software Engineer</h1><form onsubmit="event.preventDefault()">
    <label for="fn">First name</label><input id="fn"><label for="em">Email</label><input id="em" type="email"></form></body></html>`;
  const job = await setup(app);
  await job.close();
  await app.context.route(OVERVIEW, (route) => route.fulfill({ contentType: "text/html", body: overview }));
  await app.context.route(`${OVERVIEW}/application`, (route) => route.fulfill({ contentType: "text/html", body: form }));
  const page = await app.context.newPage();
  await page.goto(OVERVIEW);
  await expect(page.locator("#jobpilot-fab")).toBeVisible({ timeout: 15000 });
  await autofill(page);
  await expect(page).toHaveURL(/\/application$/, { timeout: 20000 });
  await expect(page.locator("#fn")).toHaveValue("Alex", { timeout: 15000 });
  await expect(page.locator("#em")).toHaveValue(profile.email);
});

// ---------- Cover letters ----------

const COVER_TEXT_URL = "https://careers.acme.test/jobs/321/apply";
const COVER_FILE_URL = "https://careers.acme.test/jobs/654/apply";
const coverPage = (coverField) => `<!doctype html><html><head><title>Acme - Data Engineer</title></head><body>
<h1>Data Engineer</h1><div class="job-description">Own ETL pipelines using Spark, Airflow and dbt on Snowflake. Strong SQL and Python.</div>
<form onsubmit="event.preventDefault()">
  <label for="fn">First name</label><input id="fn">
  <label for="em">Email</label><input id="em" type="email">
  <div><div><span>Resume*</span></div><div><input type="file" id="resume"></div></div>
  ${coverField}
</form></body></html>`;

async function openCoverPage(app, url, coverField, settings) {
  const job = await setup(app);
  await job.close();
  await app.worker.evaluate((s) => chrome.storage.local.set(s), settings);
  await app.context.route(url, (route) => route.fulfill({ contentType: "text/html", body: coverPage(coverField) }));
  const page = await app.context.newPage();
  await page.goto(url);
  await expect(page.locator("#jobpilot-fab")).toBeVisible({ timeout: 15000 });
  await autofill(page);
  try {
    await expect(page.locator("#fn")).toHaveValue("Alex", { timeout: 10000 });
  } catch (error) {
    console.log("DIAG", JSON.stringify({
      toast: await page.locator("#jobpilot-toast").textContent().catch(() => null),
      fab: await page.locator("#jobpilot-fab").count(),
      calls: app.api.calls.map((c) => c.endpoint),
      errors: app.api.errors,
    }));
    throw error;
  }
  await expect(checklist(page)).toBeAttached({ timeout: 15000 });
  return page;
}

const panelText = (page) => checklist(page).evaluate((host) => host.shadowRoot.querySelector(".panel").innerText);

test("AI cover letter is written for the job and pasted into a cover-letter text box", async ({ app }) => {
  const page = await openCoverPage(app, COVER_TEXT_URL,
    '<label for="cl">Cover Letter</label><textarea id="cl"></textarea>', { coverLetterMode: "ai" });
  await expect(page.locator("#cl")).toHaveValue(/^Dear Hiring Team,[\s\S]*Data Engineer[\s\S]*Sincerely,\nAlex Example$/, { timeout: 10000 });
  await expect(page.locator("#cl")).toHaveAttribute("data-jobpilot-source", "draft");
  await expect.poll(() => panelText(page)).toMatch(/Cover letter pasted \(AI-written for this job/);
  expect(app.api.coverLetters).toBe(1);
  const coverCall = app.api.calls.find((c) => c.endpoint === "/api/cover-letter");
  expect(coverCall.body.profile).toContain("Spark"); // the resume picked for this job (Data)
  expect(coverCall.body.jobContext.description).toContain("Airflow");
  for (const call of app.api.calls.filter((c) => c.endpoint === "/api/generate")) {
    expect(call.body.fields.some((f) => /cover letter/i.test(f.label))).toBe(false);
  }

  // Edit the letter from the checklist.
  await checklist(page).evaluate((host) => host.shadowRoot.querySelector("[data-cover-edit]").click());
  const editor = page.locator("#jobpilot-cover-editor");
  await expect(editor).toBeAttached();
  await editor.evaluate((host) => {
    const area = host.shadowRoot.querySelector("textarea");
    area.value = "Dear Hiring Team,\n\nEdited by me.\n\nSincerely,\nAlex Example";
    host.shadowRoot.querySelector(".save").click();
  });
  await expect(page.locator("#cl")).toHaveValue(/Edited by me/);
  await expect.poll(() => app.worker.evaluate(async () => JSON.stringify((await chrome.storage.local.get("coverLetterCache")).coverLetterCache))).toContain("Edited by me");
});

test("AI cover letter is attached as a PDF when the form has a cover-letter upload", async ({ app }) => {
  const page = await openCoverPage(app, COVER_FILE_URL,
    '<div><div><span>Cover letter</span></div><div><input type="file" id="cover"></div></div>', { coverLetterMode: "ai" });
  await expect.poll(() => page.locator("#cover").evaluate((el) => el.files[0]?.name || ""), { timeout: 10000 }).toMatch(/^Alex Example - Cover Letter - .*\.pdf$/);
  const head = await page.locator("#cover").evaluate(async (el) => (await el.files[0].text()).slice(0, 8));
  expect(head).toBe("%PDF-1.4");
  const pdfText = await page.locator("#cover").evaluate(async (el) => await el.files[0].text());
  expect(pdfText).toContain("(Dear Hiring Team,) Tj");
  expect(pdfText).toContain("%%EOF");
  await expect.poll(() => page.locator("#resume").evaluate((el) => el.files[0]?.name || "")).toBe("data.pdf");
  await expect.poll(() => panelText(page)).toMatch(/Cover letter attached \(AI-written/);
});

test("the user's own cover letter file is attached to every job; 'Don't add' leaves it to the user", async ({ app }) => {
  const file = { name: "my-cover.pdf", type: "application/pdf", data: Buffer.from("%PDF-1.4 mine").toString("base64"), text: "My letter" };
  const page = await openCoverPage(app, COVER_FILE_URL,
    '<div><div><span>Cover letter</span></div><div><input type="file" id="cover"></div></div>', { coverLetterMode: "file", coverLetterFile: file });
  await expect.poll(() => page.locator("#cover").evaluate((el) => el.files[0]?.name || ""), { timeout: 10000 }).toBe("my-cover.pdf");
  await expect.poll(() => panelText(page)).toMatch(/Cover letter attached \(your file\)/);
  expect(app.api.coverLetters || 0).toBe(0);

  await app.worker.evaluate(() => chrome.storage.local.set({ coverLetterMode: "off" }));
  await page.reload();
  await expect(page.locator("#jobpilot-fab")).toBeVisible({ timeout: 15000 });
  await autofill(page);
  await expect(checklist(page)).toBeAttached({ timeout: 15000 });
  await expect.poll(() => panelText(page)).toMatch(/asks for a cover letter/);
  expect(await page.locator("#cover").evaluate((el) => el.files.length)).toBe(0);
});

// ---------- Feedback ----------

test("'Report it' on the checklist sends a report with page details but no personal data", async ({ app }) => {
  const job = await setup(app);
  await autofill(job);
  await expect(job.locator("#reloc")).toHaveValue("Yes", { timeout: 10000 });
  await expect(checklist(job)).toBeAttached();
  await checklist(job).evaluate((host) => host.shadowRoot.querySelector("[data-feedback]").click());
  const dialog = job.locator("#jobpilot-feedback");
  await expect(dialog).toBeAttached();
  const preview = await dialog.evaluate((host) => host.shadowRoot.getElementById("preview").textContent);
  expect(preview).toContain("careers.acme.test/jobs/123/apply");
  await dialog.evaluate((host) => {
    const r = host.shadowRoot;
    r.getElementById("type").value = "wrong-answer";
    r.getElementById("msg").value = "Relocation should have been No";
    r.getElementById("contact").checked = true;
    r.querySelector(".send").click();
  });
  await expect.poll(() => (app.api.feedback || []).length, { timeout: 10000 }).toBe(1);
  const sent = app.api.feedback[0];
  expect(sent.type).toBe("wrong-answer");
  expect(sent.message).toBe("Relocation should have been No");
  expect(sent.contactOk).toBe(true);
  expect(sent.details.site).toBe("careers.acme.test/jobs/123/apply");
  expect(sent.details.fields.found).toBeGreaterThan(3);
  expect(sent.details.fields.filled).toBeGreaterThan(2);
  expect(sent.details.attach).toBe("attached");
  expect(sent.details.match).toMatch(/%$/);
  const raw = JSON.stringify(sent);
  for (const secret of [profile.email, profile.phone, profile.lastName, "Spark", "AI draft about pipelines"]) expect(raw).not.toContain(secret);
  await expect(dialog).not.toBeAttached({ timeout: 5000 });
});

test("the side panel's Feedback button sends a report about the open tab, or none if details are unticked", async ({ app }) => {
  const job = await setup(app);
  const { panel } = app;
  await panel.reload();
  await expect(panel.locator("#feedbackBtn")).toBeVisible();
  await job.bringToFront();
  await panel.locator("#feedbackBtn").click();
  await expect(panel.locator("#feedbackCard")).toBeVisible();
  await expect(panel.locator("#feedbackPreview")).toContainText(/"version"/);
  await panel.locator("#feedbackType").selectOption("idea");
  await panel.locator("#feedbackMessage").fill("Please support Workday better");
  await panel.locator("#feedbackDetails").uncheck();
  await panel.locator("#feedbackSend").click();
  await expect(panel.locator("#status")).toContainText("Thanks! Your feedback was sent.");
  await expect(panel.locator("#feedbackCard")).toBeHidden();
  const sent = app.api.feedback.at(-1);
  expect(sent.type).toBe("idea");
  expect(sent.includeDetails).toBe(false);
  expect(JSON.stringify(sent.details)).toBe("{}");
  expect(sent.contactOk).toBe(false);

  // An empty message is rejected without contacting the server.
  await panel.locator("#feedbackBtn").click();
  await panel.locator("#feedbackSend").click();
  await expect(panel.locator("#status")).toContainText("Please describe");
  expect(app.api.feedback.length).toBe(1);
});
