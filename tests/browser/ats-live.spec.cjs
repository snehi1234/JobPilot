const { test, expect, profile } = require("./extension.cjs");

// Live checks against real public postings on iCIMS, SmartRecruiters, Taleo
// and SAP SuccessFactors. Opt in with JOBPILOT_LIVE_TEST=1. These tests only
// read postings and open the application's first step; they never press a
// submit / next / sign-in button, and once the application step is reached
// every non-GET request from the page is blocked.
//
// Bot protection (CAPTCHA / "confirm you are human" pages) sometimes blocks
// automated browsers. When that happens the test asserts Hiresprint shows its
// security-check hint instead, and records an annotation.

test.skip(!process.env.JOBPILOT_LIVE_TEST, "Opt in to live ATS pages with JOBPILOT_LIVE_TEST=1.");
// Real sites have transient network errors; retry once.
test.describe.configure({ timeout: 240000, retries: 1 });

async function seed(app) {
  await app.worker.evaluate(async (details) => {
    await chrome.storage.local.set({
      structured: details,
      uploadedResumeText: "Data engineer at Example Inc since 09/2024. Spark, Airflow, Python, SQL. M.S. Computer Science, Example University.",
      resumes: [{ id: "r1", name: "Resume", text: "Data engineer at Example Inc since 09/2024. Spark, Airflow, Python, SQL." }],
      defaultResumeId: "r1",
    });
  }, profile);
}

async function jobContext(app, page) {
  return app.worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url) || tabs.find((t) => t.url && url.startsWith(t.url.split("#")[0]));
    return chrome.tabs.sendMessage(tab.id, { type: "GET_JOB_CONTEXT" }, { frameId: 0 });
  }, page.url());
}

async function clickAutofill(page) {
  await expect(async () => {
    await page.locator("#jobpilot-fab").getByRole("button", { name: /autofill/i }).click({ timeout: 3000 });
    await expect(page.locator("#jobpilot-toast")).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30000 });
}

async function dismissCookies(page) {
  for (const sel of ["#onetrust-reject-all-handler", "#truste-consent-required", "#truste-consent-button", "button:has-text('Reject All')", "button:has-text('Necessary Only')"]) {
    const button = page.locator(sel).first();
    if (await button.isVisible().catch(() => false)) await button.click({ timeout: 3000 }).catch(() => {});
  }
}

// From here on the page may hold an application step: block anything that
// could submit or create something.
async function lockDown(page, blocked) {
  await page.route("**/*", async (route) => {
    if (route.request().method() !== "GET") {
      blocked.push(`${route.request().method()} ${route.request().url()}`);
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.evaluate(() => document.addEventListener("submit", (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true)).catch(() => {});
}

const SECURITY = /security check/i;
const toastText = (page) => page.locator("#jobpilot-toast").textContent({ timeout: 1000 }).catch(() => "");

test("live iCIMS: posting text is read from the content frame; Autofill reaches the email step", async ({ app }) => {
  await seed(app);
  const page = await app.context.newPage();
  await page.goto("https://careers-customer0.icims.com/jobs/6585/job", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#jobpilot-fab")).toBeVisible({ timeout: 30000 });
  if (/confirm you are human/i.test(await page.title())) {
    test.info().annotations.push({ type: "blocked", description: "iCIMS showed its bot check to the automated browser." });
    await clickAutofill(page);
    await expect.poll(() => toastText(page), { timeout: 30000 }).toMatch(SECURITY);
    return;
  }
  const frame = page.frameLocator("#icims_content_iframe");
  await expect(frame.locator(".iCIMS_JobContent")).toBeVisible({ timeout: 30000 });
  await expect(frame.locator("#jobpilot-fab")).toHaveCount(0);
  await dismissCookies(page);
  const ctx = await jobContext(app, page);
  console.log("iCIMS context:", ctx.title, "|", ctx.description.length, "chars");
  expect(ctx.title.length).toBeGreaterThan(3);
  expect(ctx.description.length).toBeGreaterThan(300);

  await clickAutofill(page);
  await expect.poll(() => toastText(page), { timeout: 60000 }).toMatch(/iCIMS asks for your email|security check/i);
  const blocked = [];
  await lockDown(page, blocked);
  const text = await toastText(page);
  console.log("iCIMS toast:", text);
  if (/iCIMS asks/i.test(text)) await expect(frame.locator("input[name='css_loginName']")).toHaveValue(profile.email);
  else test.info().annotations.push({ type: "blocked", description: "iCIMS showed a security check at the email step." });
  expect(app.api.calls.filter((c) => c.endpoint === "/api/generate")).toHaveLength(0);
  console.log("iCIMS blocked non-GET requests:", blocked.length);
});

async function livePostingSmartRecruiters() {
  for (const company of ["Ubisoft2", "CERN", "BoschGroup"]) {
    try {
      const res = await fetch(`https://api.smartrecruiters.com/v1/companies/${company}/postings?limit=20&country=us`);
      let data = await res.json();
      if (!data.content?.length) data = await (await fetch(`https://api.smartrecruiters.com/v1/companies/${company}/postings?limit=20`)).json();
      const posting = data.content?.find((p) => /^en/i.test(p.language?.code || "")) || data.content?.[0];
      if (posting) return { url: `https://jobs.smartrecruiters.com/${company}/${posting.id}`, name: posting.name };
    } catch { /* try the next company */ }
  }
  return null;
}

test("live SmartRecruiters: posting context, then I'm interested opens One Click (or a security check)", async ({ app }) => {
  await seed(app);
  const posting = await livePostingSmartRecruiters();
  test.skip(!posting, "No public SmartRecruiters posting found.");
  const page = await app.context.newPage();
  await page.goto(posting.url, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#jobpilot-fab")).toBeVisible({ timeout: 30000 });
  await dismissCookies(page);
  await expect(page.locator("[itemprop='description']")).toBeVisible({ timeout: 30000 });
  const ctx = await jobContext(app, page);
  console.log("SmartRecruiters context:", ctx.title, "|", ctx.company, "|", ctx.description.length, "chars");
  expect(ctx.title.trim()).toBe(posting.name.trim());
  expect(ctx.description.length).toBeGreaterThan(300);

  await clickAutofill(page);
  await page.waitForURL(/oneclick-ui|smartr\.me/, { timeout: 60000 });
  const blocked = [];
  await lockDown(page, blocked);
  await expect.poll(() => toastText(page), { timeout: 90000 }).toMatch(/security check|Found \d+ fields|Filled \d+ fields|fetching answers|asking AI/i);
  const text = await toastText(page);
  console.log("SmartRecruiters toast:", text);
  if (SECURITY.test(text)) {
    test.info().annotations.push({ type: "blocked", description: "SmartRecruiters' One Click form showed a CAPTCHA to the automated browser." });
  } else {
    const fields = app.api.calls.filter((c) => c.endpoint === "/api/generate").flatMap((c) => c.body.fields);
    console.log("SmartRecruiters fields:", JSON.stringify(fields.map((f) => f.label)));
    expect(await page.locator("#first-name-input").locator("css=input").first().inputValue()).toBe("Alex");
  }
  console.log("SmartRecruiters blocked non-GET requests:", blocked.length);
});

test("live Taleo: posting context, then Apply Online leads to sign-in with a hint", async ({ app }) => {
  await seed(app);
  const page = await app.context.newPage();
  await page.goto("https://chicago.taleo.net/careersection/100/jobdetail.ftl?job=209131", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#jobpilot-fab")).toBeVisible({ timeout: 30000 });
  const posting = page.locator("[id^='requisitionDescriptionInterface.reqTitleLinkAction']");
  test.skip(!(await posting.first().isVisible({ timeout: 20000 }).catch(() => false)), "The Taleo posting is no longer listed.");
  const ctx = await jobContext(app, page);
  console.log("Taleo context:", ctx.title, "|", ctx.description.length, "chars");
  expect(ctx.title).toBe((await posting.first().innerText()).trim());
  expect(ctx.description.length).toBeGreaterThan(300);

  await clickAutofill(page);
  await page.waitForURL(/login|accessmanagement/i, { timeout: 60000 });
  const blocked = [];
  await lockDown(page, blocked);
  await expect.poll(async () => `${await toastText(page)} @ ${page.url()}`, { timeout: 60000 }).toMatch(/Taleo career site needs you to sign in|security check/i);
  console.log("Taleo toast:", await toastText(page));
  await expect(page.locator("input[type='password']").first()).toHaveValue("");
  expect(app.api.calls.filter((c) => c.endpoint === "/api/generate")).toHaveLength(0);
});

test("live SuccessFactors: employer career site is recognized; Apply now reaches sign-in with a hint", async ({ app }) => {
  await seed(app);
  const page = await app.context.newPage();
  await page.goto("https://careers.sap.com/search/?q=&sortColumn=referencedate&sortDirection=desc", { waitUntil: "domcontentloaded" });
  await dismissCookies(page);
  const link = page.locator("a.jobTitle-link, a[href*='/job/']").first();
  test.skip(!(await link.isVisible({ timeout: 30000 }).catch(() => false)), "No SuccessFactors job listing reachable.");
  await page.goto(new URL(await link.getAttribute("href"), page.url()).href, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#jobpilot-fab")).toBeVisible({ timeout: 30000 });
  await dismissCookies(page);
  const ctx = await jobContext(app, page);
  console.log("SuccessFactors context:", ctx.title, "|", ctx.company, "|", ctx.description.length, "chars");
  expect(ctx.title.length).toBeGreaterThan(3);
  expect(ctx.description.length).toBeGreaterThan(300);

  await clickAutofill(page);
  // The career site's bot manager may only honor a person's own click on
  // "Apply now"; Hiresprint then asks for that click. Make it, as a user would.
  const reached = await page.waitForURL(/successfactors\.(com|eu)/, { timeout: 30000 }).then(() => true, () => false);
  if (!reached) {
    await expect.poll(() => toastText(page), { timeout: 30000 }).toMatch(/Click “Apply/);
    console.log("SuccessFactors toast on posting:", await toastText(page));
    test.info().annotations.push({ type: "note", description: "Synthetic Apply click was bounced back; used a real click." });
    await dismissCookies(page);
    await page.locator("a.dialogApplyBtn").first().click();
    await page.waitForURL(/successfactors\.(com|eu)/, { timeout: 60000 });
  }
  const blocked = [];
  await lockDown(page, blocked);
  await dismissCookies(page);
  await expect(page.locator("#jobpilot-fab")).toBeVisible({ timeout: 30000 });
  await clickAutofill(page);
  await expect.poll(() => toastText(page), { timeout: 60000 }).toMatch(/Create an account|security check/i);
  console.log("SuccessFactors toast:", await toastText(page));
  const username = page.locator("#username");
  if (await username.isVisible().catch(() => false)) await expect(username).toHaveValue(profile.email);
  await expect(page.locator("input[type='password']").first()).toHaveValue("");
  expect(app.api.calls.filter((c) => c.endpoint === "/api/generate")).toHaveLength(0);
  console.log("SuccessFactors blocked non-GET requests:", blocked.length);
});
