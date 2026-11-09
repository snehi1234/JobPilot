# JobPilot — Chrome Web Store Listing (Draft)

Use this content when filling out the Chrome Web Store Developer Dashboard
listing form. Copy/paste each section into its matching field.

---

## Store listing

### Extension name
JobPilot — AI Job Application Autofill

### Short description (max 132 characters)
AI-assisted job application autofill from your profile and resume, with review tools and optional automatic filling.

### Category
Productivity > Workflow & Planning

### Language
English (United States)

---

## Detailed description

JobPilot uses AI to suggest and fill answers on job application forms from
your saved profile and resume. Review every completed application: AI can
make mistakes.

**How it works:**
1. Sign in with Google and set up your profile once (contact details, work
   authorization, optional demographics) and upload your resume (PDF or Word).
2. Open a job application. JobPilot detects common application pages, including
   Greenhouse, Lever, Ashby, Workday, and others. Compatibility varies by site;
   some custom fields and multi-step forms may need manual entry.
3. Use "Fill This Form" in the side panel to generate suggestions, edit them,
   and choose "Apply to Page". The floating "Autofill" button instead fills
   directly; review its answers on the application page.
4. Optionally enable automatic filling in the side panel after reading its
   disclosure. It is OFF by default. When enabled, recognized job pages can
   be processed and filled on load without another click or prior review.
5. Review the filled application, attach your resume file manually, and submit
   it yourself.

**Why JobPilot:**
• Uses profile and job context to suggest answers
• Handles common text fields, dropdowns, and repeated work/education sections
• Offers editable suggestions in the side panel
• Lets you disable automatic filling and delete your saved profile
• Free to use, with a fair monthly usage limit

**Your privacy:**
JobPilot checks page structure on your device to recognize job applications.
Your saved details and resume are stored securely in your JobPilot account.
When you autofill, the relevant details and the form's questions are processed
by our AI service to generate answers. Automatic filling is off by default and
can be turned off anytime. You can delete your saved profile from the side panel.

Read our Privacy Policy: https://backend-alpha-seven-87.vercel.app/privacy.html
Read our Terms of Service: https://backend-alpha-seven-87.vercel.app/terms.html

Support and privacy requests: snehithbootla1@gmail.com

---

## Privacy practices / permission justifications
(Required in the "Privacy practices" tab of the dashboard)

### Single purpose description
JobPilot's single purpose is to help users autofill online job application
forms using AI, based on a profile and resume the user provides.

### Permission justifications

**Host permission: `<all_urls>`**
JobPilot needs to read form fields and job details on whatever career site
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

**sidePanel**
Used to show JobPilot's main UI (profile setup, resume upload, sign-in,
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
content, site hostname or job location, and per-user monthly usage counters.

Purpose: provide profile sync, account authentication, job application
autofill, and quota enforcement. Data is not sold or used for advertising.
Automatic processing is off by default and requires the separate in-product
opt-in described above.

Data is transmitted over HTTPS to JobPilot's servers and to a third-party AI
service provider that generates answers on JobPilot's behalf.

---

## Screenshots to capture (1280x800 recommended)

1. **Side panel — Quick Details view** (signed in, some fields filled) —
   shows the profile setup UI.
2. **A real job application page with the floating Autofill button visible**
   (e.g. the Greenhouse/SpaceX page used for testing) — shows the button
   in context.
3. **The "Review Suggestions" screen** in the side panel after a fill,
   showing AI-generated answers ready for review.
4. **Before/after of a filled form** — optional but effective, shows the
   value proposition clearly.
5. **Onboarding welcome screen** — clean, on-brand, shows the 3-step flow.

Take these directly from your browser (Windows+Shift+S or a screenshot tool),
crop/resize to exactly 1280x800, and save as PNG or JPEG.

---

## Promotional images (optional but recommended)
- Small tile: 440x280
- Marquee: 1400x560
(Can be created later — not required for initial submission, only for
featured placement opportunities.)
