# Hiresprint — Chrome Web Store Listing (Draft)

Use this content when filling out the Chrome Web Store Developer Dashboard
listing form. Copy/paste each section into its matching field.

---

## Store listing

### Extension name
Hiresprint — AI Job Application Autofill, Resume Match & Tailor

### Short description (max 132 characters)
Autofill job applications on Workday, Greenhouse, Lever & more. See your resume match, tailor it to each job, and add cover letters.

### Category
Productivity > Workflow & Planning

### Language
English (United States)

---

## Detailed description

Hiresprint uses AI to suggest and fill answers on job application forms from
your saved profile and resume. Review every completed application: AI can
make mistakes.

**How it works:**
1. Sign in with Google and set up your profile once (contact details, work
   authorization, optional demographics) and upload up to five resumes (PDF or
   Word), e.g. one for software roles and one for data roles.
2. Open a job application. Hiresprint detects common application pages, including
   Greenhouse, Lever, Ashby, Workday, and others. Compatibility varies by site;
   some custom fields and multi-step forms may need manual entry.
3. Use "Fill This Form" in the side panel to generate suggestions, edit them,
   and choose "Apply to Page". The floating "Autofill" button instead fills
   directly; review its answers on the application page.
4. Optionally enable automatic filling in the side panel after reading its
   disclosure. It is OFF by default. When enabled, recognized job pages can
   be processed and filled on load without another click or prior review.
5. Hiresprint picks the resume that best matches the job, attaches it, and
   shows a checklist: green fields came from your profile, blue fields are AI
   answers to review, amber fields need you. Undo everything with one click.
6. On multi-step applications, Hiresprint offers to fill each new step.
7. Review the filled application and submit it yourself.

**Why Hiresprint:**
• Uses profile and job context to suggest answers
• Handles common text fields, dropdowns, and repeated work/education sections
• Match score for each of your resumes — right on LinkedIn, Indeed, Workday, and company job pages
• Tailor your resume to a job in one click — rewrites your own bullets, never invents experience, keeps your resume's design, and only suggests changes that raise your match
• ATS check: see how applicant tracking systems read your resume, with fixes
• Answer Studio: set salary, notice period, relocation and other common answers once
• Workday support: dropdowns, searches, dates, and multi-step pages
• Colour-coded fills, a review checklist, and one-click undo
• Learns from your corrections and reuses answers you save
• Drafts long answers you can shorten or expand
• Cover letters: AI-written for each job, or your own file — pasted or attached as PDF
• Offers editable suggestions in the side panel
• Practice application: try Autofill risk-free before your first real application
• Built-in feedback: report a problem in two clicks from the panel or any application page
• Lets you disable automatic filling and delete your saved profile
• Free to use, with a fair monthly usage limit

**Your privacy:**
Hiresprint checks page structure on your device to recognize job applications.
Your saved details and resume are stored securely in your Hiresprint account.
When you autofill, the relevant details and the form's questions are processed
by our AI service to generate answers. Automatic filling is off by default and
can be turned off anytime. You can delete your saved profile from the side panel.

Read our Privacy Policy: https://backend-alpha-seven-87.vercel.app/privacy.html
Read our Terms of Service: https://backend-alpha-seven-87.vercel.app/terms.html

Support and privacy requests: hiresprint.support@gmail.com

---

## Privacy practices / permission justifications
(Required in the "Privacy practices" tab of the dashboard)

### Single purpose description
Hiresprint's single purpose is to help users autofill online job application
forms using AI, based on a profile and resume the user provides.

### Permission justifications

**Host permission: `<all_urls>`**
Hiresprint needs to read form fields and job details on whatever career site
page the user is currently applying on, and write the AI-generated answers
back into that page. Since job applications are hosted on thousands of
different company domains and ATS platforms (Greenhouse, Lever, Workday,
etc.), a single fixed list of domains would miss most real job postings, so
broad host access is required for the extension's core functionality. Page
structure is checked locally to recognize application pages. Data is sent for
AI processing, and fields are filled, after a manual request or when the user
has explicitly enabled automatic filling in the side panel.

**activeTab**
Used together with host permissions to interact with the currently active tab
when the user clicks the floating Autofill button or the "Fill This Form"
button in the side panel.

**scripting**
Used to inject the content script that detects form fields and applies
answers, and as a fallback for tabs that were open before the extension was
installed or reloaded.

**storage**
Used to store the user's profile data, resume text, authentication state, and
extension preferences (e.g. whether the floating button is enabled) locally
in the browser.

**unlimitedStorage**
Users can keep up to five resumes. The original PDF/Word files are kept only
in the browser so Hiresprint can attach the matching file to applications;
together they can exceed the default local storage quota.

**sidePanel**
Used to show Hiresprint's main UI (profile setup, resume upload, sign-in,
review of suggested answers) in Chrome's side panel.

**identity**
Used to implement "Sign in with Google" via Chrome's identity API, so a
user's profile can be securely tied to their Google account and synced
across devices.

### Are you using remote code?
No (all code is bundled in the extension package; it calls a backend API over
HTTPS for AI processing, which does not count as "remote code" under Chrome's
definition, but disclose the backend API calls under "data usage" below).

### Data usage disclosure
Data handled: name and contact details, Google account identifier and local
authentication token, resume text, work authorization, optional demographics
and disability information, optional salary target, form fields and job
content, site hostname or job location, per-user monthly usage counters, and
anonymous usage events (feature names, counts, durations, coarse job-site type,
extension version, random install ID; never page addresses or form contents).

Purpose: provide profile sync, account authentication, job application
autofill, quota enforcement, and product analytics (which features are used;
users can turn this off in the side panel). Data is not sold or used for advertising.
Automatic processing is off by default and requires the separate in-product
opt-in described above.

Data is transmitted over HTTPS to Hiresprint's servers and to a third-party AI
service provider that generates answers on Hiresprint's behalf.

---

## Screenshots (store-assets/, 1280x800)

Generated from the real extension UI with `STORE_SHOTS=1 npx playwright test tests/browser/store-shots.spec.cjs`:

1. `hiresprint-1-autofill-1280x800.png` — Fill job applications in one click
2. `hiresprint-2-match-1280x800.png` — See your match on every job posting
3. `hiresprint-3-tailor-1280x800.png` — Tailor your resume to the job
4. `hiresprint-4-ats-1280x800.png` — Pass the ATS check
5. `hiresprint-5-studio-1280x800.png` — Answer once, reuse everywhere

---

## Promotional images (store-assets/)
- Small tile: `hiresprint-promo-small-440x280.png`
- Marquee: `hiresprint-promo-marquee-1400x560.png`