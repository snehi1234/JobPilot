const { test, expect, profile } = require("./extension.cjs");

const BACKEND = "https://backend-alpha-seven-87.vercel.app";
const PRACTICE_URL = `${BACKEND}/practice.html`;
const JOB_URL = "https://careers.acme.test/jobs/77/apply";
const SOFTWARE = "Software Engineer. Python, Go, Kubernetes, Docker, microservices, PostgreSQL, Redis, REST APIs, AWS, Terraform.";
const PAGE = `<!doctype html><html><head><title>Acme - Backend Engineer</title></head><body>
<h1>Backend Engineer</h1>
<div class="job-description">Build Python and Go microservices on Kubernetes with PostgreSQL and Redis.</div>
<form onsubmit="event.preventDefault()">
  <label for="fn">First name</label><input id="fn">
  <label for="ln">Last name</label><input id="ln">
  <label for="em">Email</label><input id="em" type="email">
  <label for="ph">Phone</label><input id="ph">
  <label for="cv">Resume/CV</label><input id="cv" type="file">
</form></body></html>`;

async function seed(app, extra = {}) {
  await app.worker.evaluate(async ({ details, software, extra }) => {
    await chrome.storage.local.set({
      structured: details,
      uploadedResumeText: software,
      resumes: [{ id: "sw", name: "Software", text: software, fileName: "software.pdf" }],
      defaultResumeId: "sw",
      resumeFiles: { sw: { name: "software.pdf", type: "application/pdf", data: btoa("%PDF-1.4 synthetic") } },
      ...extra,
    });
  }, { details: profile, software: SOFTWARE, extra });
}

async function open(app, url) {
  const page = await app.context.newPage();
  await page.goto(url);
  await expect(page.locator("#jobpilot-fab")).toBeVisible({ timeout: 15000 });
  return page;
}

async function autofill(page) {
  await expect(async () => {
    await page.locator("#jobpilot-fab").getByRole("button", { name: /autofill/i }).click({ timeout: 2000 });
    await expect(page.locator("#jobpilot-toast")).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
}

const checklistText = (page) => page.locator("#jobpilot-checklist").evaluate((host) => host.shadowRoot.textContent);
const storage = (app, key) => app.worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
const sentEvents = (app) => (app.api.events || []).flatMap((batch) => batch.events.map((e) => ({ ...e, installId: batch.installId })));

test("the practice form autofills, completes its getting-started step, and usage events carry no page or profile data", async ({ app }) => {
  await seed(app);
  const page = await open(app, PRACTICE_URL);
  await autofill(page);
  await expect(page.locator("#first_name")).toHaveValue(profile.firstName);
  await expect(page.locator("#last_name")).toHaveValue(profile.lastName);
  await expect(page.locator("#email")).toHaveValue(profile.email);
  await expect(page.locator("#jobpilot-checklist")).toBeAttached({ timeout: 15000 });
  await expect.poll(() => storage(app, "onboardingProgress").then((p) => Boolean(p?.practice)), { timeout: 10000 }).toBe(true);

  // Practice runs never trigger the rating request.
  expect(await checklistText(page)).not.toContain("saving you time");

  // The practice form is never sent anywhere.
  await page.locator("button[type=submit]").click();
  await expect(page.locator("#doneMsg")).toBeVisible();

  await expect.poll(() => sentEvents(app).some((e) => e.name === "autofill"), { timeout: 25000 }).toBe(true);
  const fill = sentEvents(app).find((e) => e.name === "autofill");
  expect(fill.props.platform).toBe("practice");
  expect(fill.props.fields).toBeGreaterThanOrEqual(3);
  expect(fill.installId).toMatch(/^[0-9a-f-]{36}$/);
  expect(app.api.events[0].authorization).toMatch(/^Bearer /);
  const raw = JSON.stringify(app.api.events);
  for (const secret of ["practice.html", profile.email, profile.firstName, profile.phone, "Northwind"]) expect(raw).not.toContain(secret);
  expect(app.api.errors).toEqual([]);
});

test("after three good autofills the checklist and panel ask for a rating; Later snoozes it", async ({ app }) => {
  await seed(app, { ratingState: { successfulFills: 2 } });
  await app.context.route("https://careers.acme.test/**", (route) => route.fulfill({ status: 404, body: "Not found" }));
  await app.context.route(JOB_URL, (route) => route.fulfill({ contentType: "text/html", body: PAGE }));
  const page = await open(app, JOB_URL);
  await autofill(page);
  await expect(page.locator("#fn")).toHaveValue(profile.firstName);
  await expect.poll(() => checklistText(page).catch(() => ""), { timeout: 15000 }).toContain("Is Hiresprint saving you time?");
  expect((await storage(app, "ratingState")).successfulFills).toBe(3);
  await expect.poll(() => storage(app, "onboardingProgress").then((p) => Boolean(p?.real))).toBe(true);

  await app.panel.reload();
  await expect(app.panel.locator("#rateCard")).toBeVisible({ timeout: 10000 });

  await page.locator("#jobpilot-checklist").evaluate((host) => host.shadowRoot.querySelector('[data-rate="later"]').click());
  await expect.poll(() => storage(app, "ratingState").then((s) => Boolean(s?.snoozedAt))).toBe(true);
  await expect.poll(() => checklistText(page)).not.toContain("saving you time");
  await expect(app.panel.locator("#rateCard")).toBeHidden({ timeout: 10000 });
  expect(app.api.errors).toEqual([]);
});

test("the getting-started card shows progress and stays hidden once dismissed", async ({ app }) => {
  const card = app.panel.locator("#startCard");
  await expect(card).toBeVisible();
  await expect(card.locator('li[data-step="signin"]')).toHaveClass(/done/);
  await expect(card.locator('li[data-step="resume"]')).not.toHaveClass(/done/);
  await seed(app);
  await expect(card.locator('li[data-step="resume"]')).toHaveClass(/done/, { timeout: 10000 });
  await expect(card.locator('li[data-step="details"]')).toHaveClass(/done/);
  await expect(card.locator("#startProgress")).toContainText("3 of 5 done");

  const opened = app.context.waitForEvent("page");
  await card.locator("#practiceBtn").click();
  expect((await opened).url()).toBe(PRACTICE_URL);

  await card.locator("#startHide").click();
  await expect(card).toBeHidden();
  await app.panel.reload();
  await expect(app.panel.locator("#appContent")).toBeVisible();
  await expect(app.panel.locator("#startCard")).toBeHidden();
});

test("turning off usage stats stops all usage events", async ({ app }) => {
  const toggle = app.panel.locator("#usageStatsToggle");
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect.poll(() => storage(app, "usageStatsEnabled")).toBe(false);
  const before = sentEvents(app).length;
  await seed(app);
  const page = await open(app, PRACTICE_URL);
  await autofill(page);
  await expect(page.locator("#first_name")).toHaveValue(profile.firstName);
  await page.waitForTimeout(13000);
  expect(sentEvents(app).length).toBe(before);
  expect(await storage(app, "telemetryQueue")).toEqual([]);
});
