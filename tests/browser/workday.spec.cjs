const { test, expect, profile } = require("./extension.cjs");

// A two-step application that copies Workday's widgets: dropdowns are buttons
// that open a pop-up list, "How did you hear about us?" and "School" are
// search prompts, and dates are split month/year spin boxes.
const WD_URL = "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Seattle/Data-Engineer_R123/apply/applyManually";

const PAGE = `<!doctype html><html><head><title>Data Engineer - Acme Careers</title></head><body>
<div data-automation-id="applyFlowPage" id="flow"></div><div id="popups"></div>
<script>
const STEP1 = \`<h2>My Information</h2>
<div data-automation-id="formField-sourcePrompt"><label>How Did You Hear About Us?<abbr>*</abbr></label>
  <div data-automation-id="multiSelectContainer" data-options="Company Website|LinkedIn|Indeed|Referral"><div data-automation-id="selectedItemList"></div><input data-automation-id="searchBox" placeholder="Search"></div></div>
<div data-automation-id="formField-countryDropdown"><label>Country*</label><button type="button" aria-haspopup="listbox" data-options="Canada|India|United States of America">Select One</button></div>
<div data-automation-id="formField-legalNameSection_firstName"><label for="fn">Given Name(s)*</label><input id="fn"></div>
<div data-automation-id="formField-legalNameSection_lastName"><label for="ln">Family Name*</label><input id="ln"></div>
<div data-automation-id="formField-email"><label for="em">Email Address*</label><input id="em"></div>
<div data-automation-id="formField-phoneType"><label>Phone Device Type*</label><button type="button" aria-haspopup="listbox" data-options="Home|Mobile|Work">Select One</button></div>
<div data-automation-id="formField-phone-number"><label for="ph">Phone Number*</label><input id="ph"></div>
<fieldset data-automation-id="formField-previousWorker"><legend>Have you previously worked for Acme?*</legend>
  <label><input type="radio" name="prev" value="yes">Yes</label><label><input type="radio" name="prev" value="no">No</label></fieldset>
<button type="button" id="next" data-automation-id="bottom-navigation-next-button">Save and Continue</button>\`;
const STEP2 = \`<h2>My Experience</h2>
<div data-automation-id="workExperienceSection"><h3>Work Experience 1</h3>
  <div data-automation-id="formField-jobTitle"><label for="jt">Job Title*</label><input id="jt"></div>
  <div data-automation-id="formField-company"><label for="co">Company*</label><input id="co"></div>
  <div data-automation-id="formField-startDate"><label>From*</label><div data-automation-id="dateInputWrapper" id="from">
    <input data-automation-id="dateSectionMonth-input" role="spinbutton" aria-label="Month"><input data-automation-id="dateSectionYear-input" role="spinbutton" aria-label="Year"></div></div></div>
<div data-automation-id="educationSection"><h3>Education 1</h3>
  <div data-automation-id="formField-school"><label>School or University*</label>
    <div data-automation-id="multiSelectContainer" data-options="Example University|Example State College|Other"><div data-automation-id="selectedItemList"></div><input data-automation-id="searchBox" placeholder="Search"></div></div>
  <div data-automation-id="formField-degree"><label>Degree*</label><button type="button" aria-haspopup="listbox" data-options="Associate's Degree|Bachelor's Degree|Master's Degree|Doctorate">Select One</button></div></div>
<div data-automation-id="formField-resume"><label>Resume/CV</label><input type="file" data-automation-id="file-upload-input-ref"></div>\`;
const flow = document.getElementById("flow");
const popups = document.getElementById("popups");
function closePopups() { popups.innerHTML = ""; document.querySelectorAll("[aria-expanded=true]").forEach((b) => b.setAttribute("aria-expanded", "false")); }
function list(items, onPick) {
  closePopups();
  const ul = document.createElement("ul"); ul.setAttribute("role", "listbox");
  for (const text of items) {
    const li = document.createElement("li"); li.setAttribute("role", "option"); li.setAttribute("data-automation-id", "promptOption"); li.textContent = text;
    li.addEventListener("click", () => { onPick(text); closePopups(); });
    ul.appendChild(li);
  }
  popups.appendChild(ul);
}
document.addEventListener("click", (e) => {
  const button = e.target.closest("button[aria-haspopup=listbox]");
  if (!button) return;
  button.setAttribute("aria-expanded", "true");
  list(button.dataset.options.split("|"), (text) => { button.textContent = text; });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") return closePopups();
  const box = e.target.closest && e.target.closest("[data-automation-id=searchBox]");
  if (!box || e.key !== "Enter") return;
  const container = box.closest("[data-automation-id=multiSelectContainer]");
  const q = box.value.toLowerCase();
  list(container.dataset.options.split("|").filter((o) => o.toLowerCase().includes(q)), (text) => {
    container.querySelector("[data-automation-id=selectedItemList]").innerHTML = '<div data-automation-id="selectedItem">' + text + '</div>';
    box.value = "";
  });
}, true);
flow.innerHTML = STEP1;
flow.addEventListener("click", (e) => { if (e.target.id === "next") flow.innerHTML = STEP2; });
</script></body></html>`;

const ANSWERS = {
  "Phone Device Type": "Mobile",
  "Have you previously worked for Acme?": "No",
  "Job Title": "Engineer",
  Company: "Example Inc",
  From: "09/2024",
  "School or University": "Example University",
  Degree: "Master's Degree",
};

async function openWorkday(app, body = PAGE, url = WD_URL) {
  const { context, worker, api } = app;
  await worker.evaluate(async (details) => {
    const pdf = btoa("%PDF-1.4 synthetic");
    await chrome.storage.local.set({
      structured: { ...details, defaultSource: "LinkedIn" },
      uploadedResumeText: "Engineer at Example Inc since 09/2024. M.S., Example University.",
      resumes: [{ id: "r1", name: "Resume", text: "Engineer at Example Inc since 09/2024. M.S., Example University." }],
      defaultResumeId: "r1",
      resumeFiles: { r1: { name: "alex.pdf", type: "application/pdf", data: pdf } },
    });
  }, profile);
  api.suggestions = (fields) => fields.flatMap((f) => { const v = ANSWERS[f.label.replace(/\*/g, "").trim()]; return v ? [{ id: f.id, label: f.label, value: v, confidence: "high" }] : []; });
  await context.route("https://acme.wd5.myworkdayjobs.com/**", (route) => route.fulfill({ contentType: "text/html", body }));
  const page = await context.newPage();
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

test("Workday: dropdowns, search prompts, radios, and text fill on step 1; dates, school, degree, and resume on step 2", async ({ app }) => {
  const page = await openWorkday(app);
  await autofill(page);
  await expect(page.locator("#fn")).toHaveValue("Alex", { timeout: 10000 });
  await expect(page.locator("#em")).toHaveValue(profile.email);
  await expect(page.locator("[data-automation-id='formField-countryDropdown'] button")).toHaveText("United States of America", { timeout: 10000 });
  await expect(page.locator("[data-automation-id='formField-phoneType'] button")).toHaveText("Mobile", { timeout: 10000 });
  await expect(page.locator("[data-automation-id='formField-sourcePrompt'] [data-automation-id='selectedItem']")).toHaveText("LinkedIn");
  await expect(page.locator("input[name=prev][value=no]")).toBeChecked();
  await expect(page.locator("#popups li")).toHaveCount(0, { timeout: 5000 });

  // The AI saw the dropdowns' real options (read by opening each one).
  const sent = app.api.calls.filter((c) => c.endpoint === "/api/generate").flatMap((c) => c.body.fields);
  const phoneType = sent.find((f) => f.label.replace(/\*/g, "").trim() === "Phone Device Type");
  expect(phoneType.options).toEqual(["Home", "Mobile", "Work"]);
  expect(sent.some((f) => /hear about/i.test(f.label))).toBe(false); // answered from Answer Studio

  // Step 2 (same page, new fields).
  await page.locator("#next").click();
  const action = page.locator("#jobpilot-toast").getByRole("button", { name: "Fill this step" });
  await expect(action).toBeVisible({ timeout: 10000 });
  await action.click();
  await expect(page.locator("#jt")).toHaveValue("Engineer", { timeout: 10000 });
  await expect(page.locator("#co")).toHaveValue("Example Inc");
  await expect(page.locator("#from input[data-automation-id='dateSectionMonth-input']")).toHaveValue("09", { timeout: 10000 });
  await expect(page.locator("#from input[data-automation-id='dateSectionYear-input']")).toHaveValue("2024");
  await expect(page.locator("[data-automation-id='formField-school'] [data-automation-id='selectedItem']")).toHaveText("Example University", { timeout: 10000 });
  await expect(page.locator("[data-automation-id='formField-degree'] button")).toHaveText("Master's Degree");
  await expect.poll(() => page.locator("input[data-automation-id='file-upload-input-ref']").evaluate((el) => el.files[0]?.name || ""), { timeout: 10000 }).toBe("alex.pdf");
});

test("Workday: pages before the form explain what to do next", async ({ app }) => {
  const chooser = `<!doctype html><html><body><div data-automation-id="applyFlowPage"><h2>Start Your Application</h2>
    <a data-automation-id="autofillWithResume" href="#">Autofill with Resume</a>
    <a data-automation-id="applyManually" href="#">Apply Manually</a></div></body></html>`;
  const page = await openWorkday(app, chooser);
  await autofill(page);
  await expect(page.locator("#jobpilot-toast")).toContainText("choose “Apply Manually”", { timeout: 10000 });
});
