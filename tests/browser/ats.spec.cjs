const { test, expect, profile } = require("./extension.cjs");

// Fixture pages mirroring markup observed on live iCIMS, SmartRecruiters,
// Taleo and SAP SuccessFactors postings and application steps. Nothing here
// ever presses a submit / next button: tests assert it was never clicked.

const clean = (label) => String(label || "").replace(/[*:]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

async function seed(app, answers = {}) {
  const { worker, api } = app;
  await worker.evaluate(async (details) => {
    const pdf = btoa("%PDF-1.4 synthetic");
    await chrome.storage.local.set({
      structured: details,
      uploadedResumeText: "Engineer at Example Inc since 09/2024. M.S., Example University.",
      resumes: [{ id: "r1", name: "Resume", text: "Engineer at Example Inc since 09/2024. M.S., Example University." }],
      defaultResumeId: "r1",
      resumeFiles: { r1: { name: "alex.pdf", type: "application/pdf", data: pdf } },
    });
  }, profile);
  const wanted = Object.fromEntries(Object.entries(answers).map(([k, v]) => [clean(k), v]));
  api.suggestions = (fields) => fields.flatMap((f) => {
    const value = wanted[clean(f.label)];
    return value ? [{ id: f.id, label: f.label, value, confidence: "high" }] : [];
  });
}

async function serve(app, routes) {
  for (const [pattern, body] of Object.entries(routes)) {
    // Exact URLs (which may contain "?") match literally; "**" patterns are globs.
    const matcher = pattern.includes("**") ? pattern : (url) => url.href === pattern;
    await app.context.route(matcher, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: typeof body === "function" ? body(route.request().url()) : body }));
  }
}

async function open(app, url) {
  const page = await app.context.newPage();
  await page.goto(url);
  await expect(page.locator("#jobpilot-fab")).toBeVisible({ timeout: 15000 });
  return page;
}

async function clickAutofill(page) {
  await expect(async () => {
    await page.locator("#jobpilot-fab").getByRole("button", { name: /autofill/i }).click({ timeout: 2000 });
    await expect(page.locator("#jobpilot-toast")).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
}

async function jobContext(app, urlPattern) {
  return app.worker.evaluate(async (pattern) => {
    const [tab] = await chrome.tabs.query({ url: pattern });
    return chrome.tabs.sendMessage(tab.id, { type: "GET_JOB_CONTEXT" }, { frameId: 0 });
  }, urlPattern);
}

const LONG = "You will design and operate data pipelines with Spark and Airflow, partner with analysts, and own data quality. ".repeat(6);

// ---------------------------------------------------------------- iCIMS

const IC = "https://careers-acme.icims.com/jobs/1234";
const icimsTop = (inner) => `<!doctype html><html><head><title>Data Engineer in Seattle, WA | Careers at Acme</title>
<meta property="og:site_name" content="Careers | Acme"></head><body>
<div id="icims_header">Acme careers
  <div class="search-container"><input type="text" id="keyword-search" role="combobox" aria-label="Keyword Search" class="mat-input-element"><input type="text" id="location-search" role="combobox" aria-label="Location Search" class="mat-input-element"></div></div>
<iframe id="icims_content_iframe" name="icims_content_iframe" src="${inner}" style="width:100%;height:1400px;border:0" scrolling="no"></iframe>
</body></html>`;
const ICIMS_POSTING = `<!doctype html><html><head><title>Data Engineer</title></head><body class="iCIMS_MainWrapper">
<div class="iCIMS_TopHeader">Returning Candidate? <a href="${IC}/login?in_iframe=1">Log back in!</a></div>
<h1 class="iCIMS_Header">Data Engineer</h1>
<dl class="iCIMS_JobHeaderGroup"><dt class="iCIMS_JobHeaderField">ID</dt><dd class="iCIMS_JobHeaderData">2026-1234</dd></dl>
<div class="iCIMS_JobContent"><h2 class="iCIMS_InfoMsg iCIMS_InfoField_Job">Overview</h2>
<div class="iCIMS_InfoMsg iCIMS_InfoMsg_Job"><div class="iCIMS_Expandable_Text">${LONG}</div></div></div>
<a class="iCIMS_Anchor iCIMS_Action_Button iCIMS_ApplyOnlineButton iCIMS_PrimaryButton" title="Apply for this job online"
  href="${IC}/data-engineer/login?in_iframe=1">Apply for this job online</a>
</body></html>`;
const ICIMS_EMAIL = `<!doctype html><html><head><title>Login</title></head><body class="iCIMS_MainWrapper">
<form method="post" action="${IC}/data-engineer/login" onsubmit="window.top.__submitted = true; return false;">
  <label for="email">Email</label><input type="email" id="email" name="css_loginName">
  <input type="checkbox" id="accept_privacy" name="accept_privacy"><label for="accept_privacy">I consent to the processing of my personal data</label>
  <input type="submit" id="enterEmailSubmitButton" value="Next" onclick="window.top.__submitted = true; return false;">
</form>
<div id="onetrust-consent-sdk"><div id="onetrust-pc-sdk"><input type="text" id="vendor-search-handler" placeholder="Search…"><input type="checkbox" id="ot-group-id-C0003"><label for="ot-group-id-C0003">Functional Cookies</label></div></div>
</body></html>`;
const ICIMS_PROFILE = `<!doctype html><html><head><title>Candidate Profile</title></head><body class="iCIMS_MainWrapper">
<form method="post" onsubmit="window.top.__submitted = true; return false;">
  <div class="iCIMS_TableRow"><label for="PersonProfileFields.FirstName">First Name <span class="iCIMS_RequiredField">*</span></label><input id="PersonProfileFields.FirstName" name="PersonProfileFields.FirstName" type="text"></div>
  <div class="iCIMS_TableRow"><label for="PersonProfileFields.LastName">Last Name <span>*</span></label><input id="PersonProfileFields.LastName" name="PersonProfileFields.LastName" type="text"></div>
  <div class="iCIMS_TableRow"><label for="PersonProfileFields.Email">Email</label><input id="PersonProfileFields.Email" name="PersonProfileFields.Email" type="email"></div>
  <div class="iCIMS_TableRow"><label for="PersonProfileFields.PhoneNumber">Phone Number</label><input id="PersonProfileFields.PhoneNumber" type="tel"></div>
  <div class="iCIMS_TableRow"><label for="PersonProfileFields.Country">Country</label><select id="PersonProfileFields.Country"><option value="">(Choose One)</option><option value="CA">Canada</option><option value="US">United States</option></select></div>
  <fieldset><legend>Are you legally authorized to work in the United States?</legend>
    <label><input type="radio" name="rcf3048" value="Yes">Yes</label><label><input type="radio" name="rcf3048" value="No">No</label></fieldset>
  <div class="iCIMS_TableRow"><label for="resume_upload">Resume</label><input type="file" id="resume_upload" name="resume_upload"></div>
  <input type="submit" id="profileSubmit" value="Submit Profile" onclick="window.top.__submitted = true; return false;">
</form></body></html>`;

test("iCIMS: the posting inside the content frame feeds the match badge context", async ({ app }) => {
  await seed(app);
  await serve(app, { [`${IC}/data-engineer`]: icimsTop(`${IC}/data-engineer?in_iframe=1`), [`${IC}/data-engineer?in_iframe=1`]: ICIMS_POSTING });
  const page = await open(app, `${IC}/data-engineer`);
  // One button: the content frame is handled by the top frame.
  await expect(page.frameLocator("#icims_content_iframe").locator("#jobpilot-fab")).toHaveCount(0);
  const ctx = await jobContext(app, `${IC}/*`);
  expect(ctx.title).toBe("Data Engineer");
  expect(ctx.description).toContain("data pipelines with Spark");
});

test("iCIMS: Autofill opens the application, fills the email step and explains it", async ({ app }) => {
  await seed(app);
  await serve(app, {
    [`${IC}/data-engineer`]: icimsTop(`${IC}/data-engineer?in_iframe=1`),
    [`${IC}/data-engineer?in_iframe=1`]: ICIMS_POSTING,
    [`${IC}/data-engineer/login?in_iframe=1`]: ICIMS_EMAIL,
  });
  const page = await open(app, `${IC}/data-engineer`);
  await clickAutofill(page);
  const frame = page.frameLocator("#icims_content_iframe");
  await expect(frame.locator("#email")).toHaveValue(profile.email, { timeout: 15000 });
  await expect(page.locator("#jobpilot-toast")).toContainText("iCIMS asks for your email", { timeout: 10000 });
  await expect(frame.locator("#accept_privacy")).not.toBeChecked();
  expect(await page.evaluate(() => window.__submitted || false)).toBe(false);
  expect(app.api.calls.filter((c) => c.endpoint === "/api/generate")).toHaveLength(0);
});

test("iCIMS: the application form inside the frame is detected and filled from the top frame", async ({ app }) => {
  await seed(app, { "Are you legally authorized to work in the United States?": "Yes" });
  await serve(app, { [`${IC}/data-engineer/candidate`]: icimsTop(`${IC}/data-engineer/candidate?in_iframe=1`), [`${IC}/data-engineer/candidate?in_iframe=1`]: ICIMS_PROFILE });
  const page = await open(app, `${IC}/data-engineer/candidate`);
  await clickAutofill(page);
  const frame = page.frameLocator("#icims_content_iframe");
  await expect(frame.locator("[id='PersonProfileFields.FirstName']")).toHaveValue("Alex", { timeout: 15000 });
  await expect(frame.locator("[id='PersonProfileFields.LastName']")).toHaveValue("Example");
  await expect(frame.locator("[id='PersonProfileFields.Email']")).toHaveValue(profile.email);
  await expect(frame.locator("[id='PersonProfileFields.PhoneNumber']")).toHaveValue(/202/);
  await expect(frame.locator("input[name=rcf3048][value=Yes]")).toBeChecked({ timeout: 15000 });
  await expect.poll(() => frame.locator("#resume_upload").evaluate((el) => el.files[0]?.name || ""), { timeout: 10000 }).toBe("alex.pdf");
  const sent = app.api.calls.filter((c) => c.endpoint === "/api/generate").flatMap((c) => c.body.fields).map((f) => f.label);
  expect(sent.some((l) => /authorized/i.test(l))).toBe(true);
  expect(sent.some((l) => /cookie|search/i.test(l))).toBe(false);
  expect(await page.evaluate(() => window.__submitted || false)).toBe(false);
});

// ---------------------------------------------------------- SmartRecruiters

const SR_POSTING_URL = "https://jobs.smartrecruiters.com/Acme/744000000000001-data-engineer";
const SR_FORM_URL = "https://jobs.smartrecruiters.com/oneclick-ui/company/Acme/publication/0f3a5c1e-1111-2222-3333-444455556666?dcr_ci=Acme";
const SR_POSTING = `<!doctype html><html><head><title>Acme Data Engineer | SmartRecruiters</title>
<meta property="og:site_name" content="Acme"></head><body>
<div class="ie-notice" style="display:none"><h1>Sorry, Internet Explorer 11 is no longer supported by SmartRecruiters</h1></div>
<main class="jobad-main job"><h1 class="job-title spl-text-h3">Data Engineer</h1>
<spl-job-location formattedaddress="Seattle, WA, United States"></spl-job-location>
<div itemprop="hiringOrganization"><meta itemprop="name" content="Acme"></div>
<div class="job-sections"><div itemprop="description"><h2>Job Description</h2><p>${LONG}</p></div></div>
<a id="st-apply" class="button button--primary" href="${SR_FORM_URL}">I'm interested</a></main>
</body></html>`;
// The One Click form: spl-* components with open shadow roots, labels on the
// component, screening questions in a shadow root, footer navigation.
const SR_FORM = `<!doctype html><html><head><title>Easy apply - Data Engineer - Acme</title>
<style>spl-select-option { display: block; } .hidden { display: none; }</style></head><body>
<main id="profile"><h1>Data Engineer</h1>
  <oc-personal-information>
    <spl-input id="first-name-input" label="First name" required></spl-input>
    <spl-input id="last-name-input" label="Last name" required></spl-input>
    <spl-input id="email-input" label="Email" type="email" required></spl-input>
    <spl-input id="confirm-email-input" label="Confirm your email" type="email" required></spl-input>
    <oc-location-autocomplete><spl-autocomplete id="location-input" label="City"></spl-autocomplete></oc-location-autocomplete>
    <oc-phone-number><spl-phone-field id="phone-number-input" label="Phone number"></spl-phone-field></oc-phone-number>
  </oc-personal-information>
  <spl-input id="linkedin-input" label="LinkedIn"></spl-input>
  <oc-resume-upload><span data-test="section-title">Resume</span><spl-dropzone><input type="file" accept=".doc,.pdf"></spl-dropzone></oc-resume-upload>
  <spl-textarea id="hiring-manager-message-input" label="Message to the Hiring Team"></spl-textarea>
  <sr-screening-questions-form></sr-screening-questions-form>
  <oc-consent><spl-checkbox data-test="consent-box">I have read the privacy notice of Acme.</spl-checkbox></oc-consent>
  <oc-button data-test="footer-next"><button type="button" onclick="window.__next = true">Next</button></oc-button>
  <oc-button data-test="footer-submit"><button type="button" onclick="window.__submitted = true">Submit</button></oc-button>
</main>
<script>
let n = 0;
customElements.define("spl-input", class extends HTMLElement { connectedCallback() { if (this.shadowRoot) return;
  this.attachShadow({ mode: "open" }).innerHTML = '<div class="c-spl-input"><span class="c-spl-label">' + this.getAttribute("label") + '</span><input class="c-spl-input-field" id="spl-form-element_' + (++n) + '" type="' + (this.getAttribute("type") || "text") + '"></div>'; } });
customElements.define("spl-textarea", class extends HTMLElement { connectedCallback() { if (this.shadowRoot) return;
  this.attachShadow({ mode: "open" }).innerHTML = '<span class="c-spl-label">' + this.getAttribute("label") + '</span><textarea id="spl-form-element_' + (++n) + '"></textarea>'; } });
customElements.define("spl-phone-field", class extends HTMLElement { connectedCallback() { if (this.shadowRoot) return;
  this.attachShadow({ mode: "open" }).innerHTML = '<span class="c-spl-label">' + this.getAttribute("label") + '</span><input type="tel" id="spl-form-element_' + (++n) + '">'; } });
customElements.define("spl-checkbox", class extends HTMLElement { connectedCallback() { if (this.shadowRoot) return;
  this.attachShadow({ mode: "open" }).innerHTML = '<input type="checkbox" id="spl-form-element_' + (++n) + '"><slot></slot>'; } });
customElements.define("spl-select-option", class extends HTMLElement {});
const PLACES = ["Seattle, WA, United States", "Seaside, OR, United States"];
customElements.define("spl-autocomplete", class extends HTMLElement { connectedCallback() { if (this.shadowRoot) return;
  const root = this.attachShadow({ mode: "open" });
  root.innerHTML = '<span class="c-spl-label">' + this.getAttribute("label") + '</span><div class="c-spl-autocomplete"><input type="text" role="combobox" aria-expanded="false" autocomplete="off"></div><div class="menu"></div>';
  const input = root.querySelector("input"), menu = root.querySelector(".menu");
  input.addEventListener("input", () => {
    menu.innerHTML = "";
    for (const place of PLACES.filter((p) => input.value && p.toLowerCase().startsWith(input.value.toLowerCase()))) {
      const option = document.createElement("spl-select-option");
      option.textContent = place;
      option.addEventListener("click", () => { input.value = place; menu.innerHTML = ""; });
      menu.append(option);
    }
  }); } });
customElements.define("sr-screening-questions-form", class extends HTMLElement { connectedCallback() { if (this.shadowRoot) return;
  const root = this.attachShadow({ mode: "open" });
  root.innerHTML = '<div data-test="question-container"><p class="question-label">Are you legally authorized to work in the United States?</p>' +
    '<spl-radio-group><spl-radio role="radio" aria-checked="false" tabindex="0">Yes</spl-radio><spl-radio role="radio" aria-checked="false" tabindex="0">No</spl-radio></spl-radio-group></div>' +
    '<div data-test="question-container"><p class="question-label">Years of experience with Spark</p><spl-input id="question_q-years"></spl-input></div>';
  for (const radio of root.querySelectorAll("spl-radio")) radio.addEventListener("click", () => {
    for (const r of radio.parentElement.children) r.setAttribute("aria-checked", String(r === radio));
  }); } });
</script></body></html>`;

test("SmartRecruiters: posting context skips the hidden browser notice", async ({ app }) => {
  await seed(app);
  await serve(app, { [SR_POSTING_URL]: SR_POSTING });
  await open(app, SR_POSTING_URL);
  const ctx = await jobContext(app, "https://jobs.smartrecruiters.com/*");
  expect(ctx.title).toBe("Data Engineer");
  expect(ctx.company).toBe("Acme");
  expect(ctx.description).toContain("data pipelines with Spark");
});

test("SmartRecruiters: I'm interested opens One Click, and shadow-DOM fields and questions are filled", async ({ app }) => {
  await seed(app, {
    "Confirm your email": profile.email,
    "Are you legally authorized to work in the United States?": "Yes",
    "Years of experience with Spark": "3",
    "City": "Seattle, Washington",
  });
  await serve(app, { [SR_POSTING_URL]: SR_POSTING, [SR_FORM_URL]: SR_FORM });
  const page = await open(app, SR_POSTING_URL);
  await clickAutofill(page);
  await page.waitForURL(/oneclick-ui/, { timeout: 15000 });
  const inner = (host) => page.locator(`${host} >> css=input, textarea`).first();
  await expect(inner("#first-name-input")).toHaveValue("Alex", { timeout: 20000 });
  await expect(inner("#last-name-input")).toHaveValue("Example");
  await expect(inner("#email-input")).toHaveValue(profile.email);
  await expect(inner("#confirm-email-input")).toHaveValue(profile.email, { timeout: 15000 });
  await expect(inner("#phone-number-input")).toHaveValue(/202/);
  await expect(inner("#location-input")).toHaveValue("Seattle, WA, United States", { timeout: 15000 });
  await expect(page.locator("sr-screening-questions-form spl-radio").first()).toHaveAttribute("aria-checked", "true", { timeout: 15000 });
  await expect(page.locator("sr-screening-questions-form #question_q-years input")).toHaveValue("3");
  const sent = app.api.calls.filter((c) => c.endpoint === "/api/generate").flatMap((c) => c.body.fields).map((f) => f.label);
  expect(sent).toContain("Are you legally authorized to work in the United States?");
  expect(sent.some((l) => /^(next|submit)$/i.test(l))).toBe(false);
  expect(await page.evaluate(() => ({ next: window.__next || false, submitted: window.__submitted || false }))).toEqual({ next: false, submitted: false });
});

test("SmartRecruiters: a posting in another language still opens One Click", async ({ app }) => {
  await seed(app);
  const fr = SR_POSTING.replace(">I'm interested<", ">Je suis intéressé(e)<");
  await serve(app, { [SR_POSTING_URL]: fr, [SR_FORM_URL]: SR_FORM });
  const page = await open(app, SR_POSTING_URL);
  await clickAutofill(page);
  await page.waitForURL(/oneclick-ui/, { timeout: 15000 });
  await expect(page.locator("#first-name-input").locator("css=input").first()).toHaveValue("Alex", { timeout: 20000 });
});

// ------------------------------------------------------------------- Taleo

const TALEO = "https://acme.taleo.net/careersection";
const TALEO_POSTING_URL = `${TALEO}/2/jobdetail.ftl?job=2600123&lang=en`;
const TALEO_LOGIN_URL = `${TALEO}/iam/accessmanagement/login.jsf?lang=en&redirectionURI=x`;
const TALEO_POSTING = `<!doctype html><html><head><title>Job Description - Data Engineer (2600123)</title></head><body>
<form id="requisitionDescriptionInterface" name="requisitionDescriptionInterface" method="post">
<input type="hidden" id="ftlpageid" name="ftlpageid" value="reqListBasicPage">
<h1>Job Description</h1>
<div class="editablesection">
  <div id="requisitionDescriptionInterface.ID1507.row1" class="contentlinepanel"><span id="requisitionDescriptionInterface.reqTitleLinkAction.row1" class="titlepage">Data Engineer</span> Job Number: 2600123</div>
  <div id="requisitionDescriptionInterface.ID1577.row1" class="contentlinepanel"><h2>Description</h2>${LONG}</div>
</div>
<input type="button" value="Apply Online" id="requisitionDescriptionInterface.UP_APPLY_ON_REQ.row1" class="inputbutton" onclick="location.href = '${TALEO_LOGIN_URL}'">
<input type="button" value="Add to My Job Cart" id="requisitionDescriptionInterface.UP_ADD_TO_JOB_CART.row1" class="inputbutton">
</form></body></html>`;
const TALEO_LOGIN = `<!doctype html><html><head><title>Login</title></head><body><h1>Login</h1>
<form id="dialogTemplate-dialogForm" method="post" onsubmit="window.__submitted = true; return false;">
  <label for="dialogTemplate-dialogForm-login-name1">User Name</label><input type="text" id="dialogTemplate-dialogForm-login-name1" name="dialogTemplate-dialogForm-login-name1">
  <label for="dialogTemplate-dialogForm-login-password">Password</label><input type="password" id="dialogTemplate-dialogForm-login-password" name="dialogTemplate-dialogForm-login-password">
  <input type="button" id="dialogTemplate-dialogForm-login-defaultCmd" value="Login" onclick="window.__submitted = true">
  <input type="button" id="dialogTemplate-dialogForm-login-register" value="New User">
</form></body></html>`;
const TALEO_APP_URL = `${TALEO}/2/application.jss?type=1&lang=en&reqNo=2600123`;
const P = "et-ef-content-ftf-gp-j_id_id16pc9-page_0-cpi-cfrmsub-frm-dv_cs_candidate_personal_info";
const TALEO_APP = `<!doctype html><html><head><title>Personal Information - Acme</title></head><body>
<form id="et-ef" name="et-ef" method="post" onsubmit="window.__submitted = true; return false;">
<div class="editablesection"><h2>Personal Information</h2>
  <div><label for="${P}_FirstName">First Name</label><span class="requiredicon">*</span><input type="text" id="${P}_FirstName" name="${P}_FirstName"></div>
  <div><label for="${P}_LastName">Last Name</label><span class="requiredicon">*</span><input type="text" id="${P}_LastName" name="${P}_LastName"></div>
  <div><label for="${P}_EmailAddress">Email Address</label><input type="text" id="${P}_EmailAddress" name="${P}_EmailAddress"></div>
  <div><label for="${P}_MobilePhone">Cellular Number</label><input type="text" id="${P}_MobilePhone" name="${P}_MobilePhone"></div>
  <div><label for="${P}_ResidenceLocation-0">Place of Residence</label><select id="${P}_ResidenceLocation-0" name="${P}_ResidenceLocation-0"><option value="-1">Select a country</option><option value="1">Canada</option><option value="2">United States</option></select></div>
  <div><label for="et-ef-content-ftf-gp-q1">Have you previously worked for Acme?</label><select id="et-ef-content-ftf-gp-q1"><option value="-1">Select...</option><option value="Y">Yes</option><option value="N">No</option></select></div>
</div>
<input type="button" id="et-ef-content-ftf-saveContinueCmdBottom" value="Save and Continue" onclick="window.__submitted = true">
</form></body></html>`;

test("Taleo: posting context comes from the requisition description", async ({ app }) => {
  await seed(app);
  await serve(app, { [TALEO_POSTING_URL]: TALEO_POSTING });
  await open(app, TALEO_POSTING_URL);
  const ctx = await jobContext(app, "https://acme.taleo.net/*");
  expect(ctx.title).toBe("Data Engineer");
  expect(ctx.description).toContain("data pipelines with Spark");
});

test("Taleo: Apply Online leads to the sign-in page, where a hint replaces filling", async ({ app }) => {
  await seed(app);
  await serve(app, { [TALEO_POSTING_URL]: TALEO_POSTING, [`${TALEO}/iam/**`]: TALEO_LOGIN });
  const page = await open(app, TALEO_POSTING_URL);
  await clickAutofill(page);
  await page.waitForURL(/login\.jsf/, { timeout: 15000 });
  await expect(page.locator("#jobpilot-toast")).toContainText("Taleo career site needs you to sign in", { timeout: 15000 });
  await expect(page.locator("#dialogTemplate-dialogForm-login-name1")).toHaveValue("");
  await expect(page.locator("#dialogTemplate-dialogForm-login-password")).toHaveValue("");
  expect(await page.evaluate(() => window.__submitted || false)).toBe(false);
  expect(app.api.calls.filter((c) => c.endpoint === "/api/generate")).toHaveLength(0);
});

test("Taleo: the legacy application form is filled without saving", async ({ app }) => {
  await seed(app, { "Have you previously worked for Acme?": "No", "Place of Residence": "United States", "Cellular Number": profile.phone });
  await serve(app, { [TALEO_APP_URL]: TALEO_APP });
  const page = await open(app, TALEO_APP_URL);
  await clickAutofill(page);
  await expect(page.locator(`[id='${P}_FirstName']`)).toHaveValue("Alex", { timeout: 15000 });
  await expect(page.locator(`[id='${P}_LastName']`)).toHaveValue("Example");
  await expect(page.locator(`[id='${P}_EmailAddress']`)).toHaveValue(profile.email);
  await expect(page.locator(`[id='${P}_MobilePhone']`)).toHaveValue(/202/);
  await expect(page.locator("#et-ef-content-ftf-gp-q1")).toHaveValue("N", { timeout: 15000 });
  await expect(page.locator(`[id='${P}_ResidenceLocation-0']`)).toHaveValue("2");
  expect(await page.evaluate(() => window.__submitted || false)).toBe(false);
});

// ---------------------------------------------------------- SuccessFactors

const SF_POSTING_URL = "https://careers.acme-corp.test/job/Seattle-Data-Engineer-WA-98101/1100000001/";
const SF_HOST = "https://career4.successfactors.com";
const SF_LOGIN_URL = `${SF_HOST}/careers?company=AcmeCorp&career_job_req_id=42&career_ns=job_application`;
const SF_REGISTER_URL = `${SF_HOST}/career?company=AcmeCorp&login_ns=register&career_ns=job_application&career_job_req_id=42`;
const SF_APP_URL = `${SF_HOST}/careers?company=AcmeCorp&career_ns=job_application&career_job_req_id=42&step=1`;
const SF_POSTING = `<!doctype html><html><head><title>Data Engineer Job Details | Acme Corp</title>
<meta property="og:site_name" content="Acme Corp"></head><body class="coreCSB job-page">
<div id="content"><div class="jobDisplayShell" itemscope itemtype="http://schema.org/JobPosting">
<h1><span itemprop="title" data-careersite-propertyid="title">Data Engineer</span></h1>
<div id="apply-CTA-container"><a id="heroButton" class="btn btn-primary apply dialogApplyBtn" href="${SF_LOGIN_URL}">Apply now »</a></div>
<div id="jobAlertForm" class="jobAlertsSearchForm"><label id="labelFrequencySpinBtn" for="j_idt197">Send me alerts every</label><input id="j_idt197" type="number" class="form-control subscribe-frequency frequencySpinBtn" name="frequency" value="7"> days</div>
<div class="job"><span class="jobdescription" itemprop="description" data-careersite-propertyid="description">${LONG}</span></div>
</div></div></body></html>`;
const SF_LOGIN = `<!doctype html><html><head><title>Career Opportunities: Sign In</title></head><body>
<div id="rmkContent"><h1>Career Opportunities: Sign In</h1>
<form method="post" onsubmit="window.__submitted = true; return false;">
  <label for="username">Email Address:</label><input type="text" id="username" name="username" aria-label="Email Address:">
  <label for="password">Password:</label><input type="password" id="password" name="password" aria-label="Password:">
  <input type="button" id="show_button" value="Show">
  <button type="submit" onclick="window.__submitted = true; return false;">Sign In</button>
</form>
<a href="${SF_REGISTER_URL}">Create an account</a></div></body></html>`;
const SF_REGISTER = `<!doctype html><html><head><title>Career Opportunities: Create an Account</title></head><body>
<form method="post" onsubmit="window.__submitted = true; return false;">
  <label for="fbclc_userName" title="Required">Email Address:</label><input class="form-control" type="text" id="fbclc_userName" name="fbclc_userName">
  <label for="fbclc_emailConf" title="Required">Retype Email Address:</label><input class="form-control" type="text" id="fbclc_emailConf" name="fbclc_emailConf">
  <label for="fbclc_pwd" title="Required">Choose Password:</label><input class="form-control" id="fbclc_pwd" type="password" name="fbclc_pwd">
  <label for="fbclc_pwdConf" title="Required">Retype Password:</label><input class="form-control" type="password" id="fbclc_pwdConf" name="fbclc_pwdConf">
  <label for="fbclc_fName" title="Required">First Name:</label><input class="form-control" type="text" id="fbclc_fName" name="fbclc_fName">
  <label for="fbclc_lName" title="Required">Last Name:</label><input class="form-control" type="text" id="fbclc_lName" name="fbclc_lName">
  <label for="fbclc_country">Country/Region of Residence</label><select id="fbclc_country" name="fbclc_country" aria-label="Country/Region of Residence"><option value="">Please select</option><option value="CA">Canada</option><option value="US">United States</option></select>
  <button type="submit" onclick="window.__submitted = true; return false;">Create Account</button>
</form></body></html>`;
// The application step: a SuccessFactors pick list (role=combobox span with a
// pop-up list), plus ordinary inputs.
const SF_APP = `<!doctype html><html><head><title>Career Opportunities: Application</title>
<style>.sfOverlay ul { list-style: none; border: 1px solid #ccc; }</style></head><body>
<div id="rmkContent"><form method="post" onsubmit="window.__submitted = true; return false;">
  <div><label for="firstName">First Name</label><input type="text" id="firstName" name="firstName"></div>
  <div><label for="lastName">Last Name</label><input type="text" id="lastName" name="lastName"></div>
  <div><label for="cellPhone">Cell Phone</label><input type="text" id="cellPhone" name="cellPhone"></div>
  <div><span id="degreeLabel">Highest Degree</span>
    <span class="rcmmultiselect fd-input-group" id="degree_select" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="degreeLabel" tabindex="0" data-options="Bachelor's Degree|Master's Degree|Doctorate"><span class="value">Please select</span><input tabindex="-1" type="text" class="rcmmultiselectinput" aria-label="Select an option" readonly></span></div>
  <div><span id="relocLabel">Willing to relocate?</span>
    <span class="rcmmultiselect fd-input-group" id="reloc_select" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="relocLabel" tabindex="0" data-options="Yes|No"><span class="value">Please select</span></span></div>
  <button type="button" onclick="window.__submitted = true">Apply</button>
</form></div><div class="sfOverlay" id="overlay"></div>
<script>
const overlay = document.getElementById("overlay");
function close() { overlay.innerHTML = ""; document.querySelectorAll("[aria-expanded=true]").forEach((b) => b.setAttribute("aria-expanded", "false")); }
document.addEventListener("click", (e) => {
  const box = e.target.closest("[role=combobox][data-options]");
  if (!box) return;
  close(); box.setAttribute("aria-expanded", "true");
  const ul = document.createElement("ul"); ul.setAttribute("role", "listbox");
  for (const text of box.dataset.options.split("|")) {
    const li = document.createElement("li"); li.setAttribute("role", "option"); li.textContent = text;
    li.addEventListener("click", (ev) => { ev.stopPropagation(); box.querySelector(".value").textContent = text; close(); });
    ul.append(li);
  }
  overlay.append(ul);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
</script></body></html>`;

test("SuccessFactors: a career site on the employer's domain is recognized, with posting context", async ({ app }) => {
  await seed(app);
  await serve(app, { [SF_POSTING_URL]: SF_POSTING });
  await open(app, SF_POSTING_URL);
  const ctx = await jobContext(app, "https://careers.acme-corp.test/*");
  expect(ctx.title).toBe("Data Engineer");
  expect(ctx.company).toBe("Acme Corp");
  expect(ctx.description).toContain("data pipelines with Spark");
});

test("SuccessFactors: Apply now leads to sign-in, where the email is entered and a hint explains the account step", async ({ app }) => {
  await seed(app);
  await serve(app, { [SF_POSTING_URL]: SF_POSTING, [SF_LOGIN_URL]: SF_LOGIN });
  const page = await open(app, SF_POSTING_URL);
  await clickAutofill(page);
  await page.waitForURL(/successfactors\.com\/careers/, { timeout: 15000 });
  await expect(page.locator("#jobpilot-fab")).toBeVisible({ timeout: 15000 });
  await clickAutofill(page);
  await expect(page.locator("#jobpilot-toast")).toContainText("Create an account", { timeout: 15000 });
  await expect(page.locator("#username")).toHaveValue(profile.email);
  await expect(page.locator("#password")).toHaveValue("");
  expect(await page.evaluate(() => window.__submitted || false)).toBe(false);
});

test("SuccessFactors: the account form fills names and email but never the password", async ({ app }) => {
  await seed(app, { "Retype Email Address": profile.email, "Country/Region of Residence": "United States" });
  await serve(app, { [SF_REGISTER_URL]: SF_REGISTER });
  const page = await open(app, SF_REGISTER_URL);
  await clickAutofill(page);
  await expect(page.locator("#fbclc_fName")).toHaveValue("Alex", { timeout: 15000 });
  await expect(page.locator("#fbclc_lName")).toHaveValue("Example");
  await expect(page.locator("#fbclc_userName")).toHaveValue(profile.email);
  await expect(page.locator("#fbclc_country")).toHaveValue("US", { timeout: 15000 });
  await expect(page.locator("#fbclc_pwd")).toHaveValue("");
  await expect(page.locator("#fbclc_pwdConf")).toHaveValue("");
  expect(await page.evaluate(() => window.__submitted || false)).toBe(false);
});

test("SuccessFactors: pick lists are opened, read, and set like a person would", async ({ app }) => {
  await seed(app, { "Highest Degree": "Master's Degree", "Willing to relocate?": "No" });
  await serve(app, { [SF_APP_URL]: SF_APP });
  const page = await open(app, SF_APP_URL);
  await clickAutofill(page);
  await expect(page.locator("#firstName")).toHaveValue("Alex", { timeout: 15000 });
  await expect(page.locator("#degree_select .value")).toHaveText("Master's Degree", { timeout: 15000 });
  await expect(page.locator("#reloc_select .value")).toHaveText("No");
  await expect(page.locator("#overlay li")).toHaveCount(0);
  const sent = app.api.calls.filter((c) => c.endpoint === "/api/generate").flatMap((c) => c.body.fields);
  const degree = sent.find((f) => f.label === "Highest Degree");
  expect(degree.options).toEqual(["Bachelor's Degree", "Master's Degree", "Doctorate"]);
  expect(sent.some((f) => /select an option/i.test(f.label))).toBe(false);
  expect(await page.evaluate(() => window.__submitted || false)).toBe(false);
});
