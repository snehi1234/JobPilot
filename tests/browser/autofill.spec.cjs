const { test, expect, profile } = require("./extension.cjs");

test("uploading a resume populates empty Quick Details", async ({ app }) => {
  const { panel, api } = app;
  const resume = process.env.JOBPILOT_TEST_RESUME;
  test.skip(!resume, "Set JOBPILOT_TEST_RESUME to a local PDF; it is never sent to a remote API.");
  // The backend returns no contact details, so these values must come from the
  // in-browser PDF extraction alone.
  api.parseStructured = {};
  await panel.locator("#resumeFile").setInputFiles(resume);
  try {
    await expect.poll(() => api.calls.filter(call => call.method === "PUT").length, { timeout: 20000 }).toBeGreaterThan(0);
  } catch (error) {
    console.log(JSON.stringify({ status: await panel.locator("#status").textContent(), endpoints: api.calls.map(c => c.endpoint), errors: api.errors }));
    throw error;
  }
  const filled = await panel.evaluate(() => ["firstName","lastName","email","phone","location","linkedin","website","experience"]
    .map(k => `${k}:${document.getElementById("sf_" + k).value ? "filled" : "EMPTY"}`).join(" "));
  console.log("Quick Details from local extraction ->", filled);
  if (process.env.JOBPILOT_PHONE_SHAPE) {
    const shapes = await app.worker.evaluate(async () => {
      const { uploadedResumeText: t = "" } = await chrome.storage.local.get("uploadedResumeText");
      return [...t.slice(0, 1500).matchAll(/[+(\d][\d\s().+\-]{8,22}\d/g)].map(m => m[0].replace(/\d/g, "d"));
    });
    console.log("Phone-like shapes:", JSON.stringify(shapes));
  }
  await expect(panel.locator("#sf_firstName")).not.toHaveValue("");
  await expect(panel.locator("#sf_email")).not.toHaveValue("");
  await expect(panel.locator("#sf_phone")).not.toHaveValue("");
});

test("Plaid: floating autofill writes and retains contact fields without submitting", async ({ app }) => {
  test.skip(!process.env.JOBPILOT_LIVE_TEST, "Opt in to the live public Plaid page.");
  const { context, worker, api } = app;
  await worker.evaluate(async (details) => {
    await chrome.storage.local.set({ structured: details, uploadedResumeText: "Synthetic profile for a browser regression test." });
  }, profile);
  const job = await context.newPage();
  await job.goto("https://jobs.ashbyhq.com/plaid/664df3be-6be0-432f-8a35-ec7af986fd0d/application");
  await expect(job.locator("#_systemfield_name")).toBeVisible({ timeout: 30000 });
  const cookies = job.getByRole("button", { name: "Necessary Only", exact: true });
  if (await cookies.count()) await cookies.click();
  let submissions = 0;
  // Allow read-only lookups (Ashby's location/school search are POSTs) but
  // block anything that could submit or upload an application.
  await job.route("**/*", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      const body = request.postData() || "";
      const lookup = /ashbyhq\.com/.test(request.url()) && /(search|autocomplete|location|school|lookup)/i.test(body + request.url())
        && !/submit|apply|upload|createApplication/i.test(body + request.url());
      if (!lookup) {
        submissions++;
        await route.abort();
        return;
      }
    }
    await route.continue();
  });
  await job.evaluate(() => document.addEventListener("submit", event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true));
  await job.locator("#jobpilot-fab").getByRole("button", { name: "Autofill" }).click();
  const progress = async () => ({
    generated: api.calls.filter(call => call.endpoint === "/api/generate").length,
    endpoints: api.calls.map(call => call.endpoint),
    errors: api.errors,
    notice: await job.locator("#jobpilot-toast").textContent().catch(() => ""),
  });
  try {
    await expect.poll(async () => (await progress()).generated, { timeout: 15000 }).toBe(1);
  } catch (error) {
    console.log(JSON.stringify(await progress()));
    throw error;
  }
  if (process.env.JOBPILOT_FIELD_OUTPUT) {
    require("node:fs").writeFileSync(process.env.JOBPILOT_FIELD_OUTPUT,
      JSON.stringify(api.calls.find(call => call.endpoint === "/api/generate").body.fields));
  }
  await expect(job.locator("#_systemfield_name")).toHaveValue("Alex Example");
  const fields = api.calls.find(call => call.endpoint === "/api/generate").body.fields;
  const radios = fields.filter(field => field.kind === "radio").map(field => field.label);
  expect(radios.some(label => /rate Plaid/i.test(label))).toBe(true);
  expect(radios).not.toContain("Phone Number");
  expect(radios.every(label => !/^\d+ - /.test(label))).toBe(true);
  const checkboxLabels = fields.filter(field => field.kind === "checkbox").map(field => field.label);
  expect(new Set(checkboxLabels).size).toBe(checkboxLabels.length);
  await expect(job.locator("#_systemfield_email")).toHaveValue(profile.email);
  await expect(job.getByPlaceholder("Search schools...")).toHaveValue(/Maulana Azad National Institute of Technology/, { timeout: 20000 });
  await expect.poll(async () => (await job.locator("#jobpilot-toast").textContent().catch(() => "")) || "", { timeout: 30000 }).toMatch(/Filled|failed/);
  console.log("Toast:", await job.locator("#jobpilot-toast").textContent(), "| warnings:", JSON.stringify(api.errors));
  await expect(job.getByPlaceholder("Start typing...")).toHaveValue(/Seattle/, { timeout: 20000 });
  await expect(job.getByLabel("Phone Number", { exact: false })).toHaveValue(profile.phone);
  await expect(job.getByLabel("Current/Last Company", { exact: false })).toHaveValue("Example Inc");
  await job.locator("#_systemfield_email").focus();
  await job.locator("#_systemfield_email").blur();
  await expect(job.locator("#_systemfield_name")).toHaveValue("Alex Example");
  console.log(JSON.stringify({
    detectedFields: api.calls.find(call => call.endpoint === "/api/generate").body.fields.map(field => ({
      id: field.id, label: field.label, kind: field.kind,
    })),
    contactFieldsRetained: true,
    blockedNonGetRequests: submissions,
  }));
});
