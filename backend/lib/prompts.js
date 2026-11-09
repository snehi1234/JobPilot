// lib/prompts.js — prompt builders shared by the API endpoints.

// Large dropdowns (e.g. a 252-country <select>) would blow up the prompt token
// count. For big option lists we omit the options and instead tell the AI to
// return a plain value; the extension matches it against the real options when
// filling. Only small lists are sent verbatim so the AI picks an exact match.
const MAX_OPTIONS = 25;

export function buildFillPrompt(fields, profile, jobContext = {}, structured = {}, parsedEntries = null) {
  const fieldList = fields.map((f) => {
    const base = { id: f.id, label: f.label, kind: f.kind, type: f.type };
    if (Array.isArray(f.options)) {
      if (f.options.length <= MAX_OPTIONS) {
        base.options = f.options;
      } else {
        // Too many options — omit them; extension fuzzy-matches on apply.
        base.note = `has ${f.options.length} options; return the plain value (e.g. a country/state name) and it will be matched`;
      }
    }
    return base;
  });

  const jobInfo = `Job title: ${jobContext.title || "unknown"}
Job location: ${jobContext.location || "unknown"}
Company: ${jobContext.company || "unknown"}
Today's date: ${new Date().toISOString().slice(0, 10)} (use MM/DD/YYYY when a field asks for today's date)${
    jobContext.sourceHint ? `\nThe candidate found this job via: ${jobContext.sourceHint}` : ""
  }`;

  // Cap the job description to keep the prompt within provider token limits.
  const desc = (jobContext.description || "").slice(0, 1500);
  const jobDescription = desc
    ? `\nHere is the job description (use it to TAILOR open-ended answers to this specific role):\n"""\n${desc}\n"""\n`
    : "";

  const structuredEntries = Object.entries(structured || {}).filter(([, v]) => v);
  const structuredBlock = structuredEntries.length
    ? `\nThese are the user's VERIFIED exact details. Use them VERBATIM and with HIGH confidence for matching fields (do not paraphrase names/emails/phone):\n${structuredEntries
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n")}\n`
    : "";

  const entriesBlock =
    parsedEntries && (parsedEntries.experience?.length || parsedEntries.education?.length)
      ? `\nThe user's work experiences and education have already been parsed into this ordered list (MOST RECENT FIRST). Map these ONE-TO-ONE onto the repeated form groups in the same order. Fill ALL of them:\n${JSON.stringify(
          parsedEntries
        )}\n`
      : "";

  // Trim the resume to a sane size (keeps well under provider TPM limits).
  const trimmedProfile = (profile || "").slice(0, 6000);

  return `You are helping a user fill out a job application form.

Here is the user's profile / resume:
"""
${trimmedProfile || "(none provided — rely on the verified details below)"}
"""
${structuredBlock}${entriesBlock}
Here is the job posting context:
"""
${jobInfo}
"""
${jobDescription}
Here are the form fields detected on the page (as JSON).
Each field has a "kind": text, select, combobox, radio, or checkbox.
${JSON.stringify(fieldList, null, 2)}

For each field, decide the best value to fill.
Rules:
- COMPLETENESS: You MUST return a suggestion for EVERY field you can fill, especially basic ones (First Name, Last Name, Email, Phone, Address, City, State). Keep answers SHORT so the full response fits.
- COMPLETENESS IS MANDATORY, NOT OPTIONAL: return a suggestion for EVERY SINGLE field listed above, with no exceptions, INCLUDING optional/voluntary ones — do not silently drop any field just because it lacks direct resume data. Use these fallbacks instead of omitting:
  - Voluntary self-identification fields (Gender, Race/Ethnicity, Disability status, Veteran status, Sexual orientation, Transgender, etc.): use the matching VERIFIED demographic detail above verbatim if provided (even if it's "Decline to answer"); if none is provided, pick the field's own "Decline to answer"/"Prefer not to say" option.
  - GPA / SAT / ACT / GRE / test-score fields with no data in the resume: select the option meaning "Not applicable" / "Do not recall" if one exists in the field's options; otherwise answer "N/A".
  - Any other field you're unsure about: still make your best reasonable guess rather than omitting it — a "low" confidence guess is better than no answer at all.
- Prefer the VERIFIED exact details for name, email, phone, location, LinkedIn, website, work authorization, sponsorship, and years of experience.
- Match fields semantically (e.g. "Given name" = first name).
- kind "select" or "radio": the "value" MUST be exactly one of the provided "options".
- kind "radio" yes/no questions: answer "Yes" or "No" based on the profile/details.
- kind "combobox": no options given; return the best short value. For School / University / Institution fields, return the FULL OFFICIAL institution name exactly as it is commonly listed (expand abbreviations, e.g. "NIT Bhopal (MANIT)" → "Maulana Azad National Institute of Technology"; "IU Bloomington" → "Indiana University Bloomington"). For Location fields return "City, State".
- EDUCATION GROUPS: The FIRST education group on the form gets the MOST RECENT degree. Education Start/End dates must come from that SAME education entry's startDate/graduationDate — NEVER use work-experience dates for education. If the entry has no start date, leave Start Date empty.
- SPLIT DATE FIELDS: A field labelled "... (month)" takes the month NAME (e.g. "July"); a field labelled "... (year)" takes the 4-digit year.
- kind "checkbox": value must be "Yes" (to check) or "No" (to leave unchecked).
- DATE FIELDS: For any Start Date / End Date / Graduation Date, output the date as "MM/YYYY" (e.g. "09/2024"). Keep each job's OWN dates — do NOT mix up or reuse dates across different jobs. If a date is unknown, leave it empty.
- CURRENT JOB / END DATE: For the user's CURRENT job (end date "Present"/"Now"), set "Current Job" to "Yes" and leave that job's "End Date" EMPTY. Never put "Present"/"Now" into a date field.
- ADDRESS FIELDS: Only put a real street address in "Address Line 1"; if none exists, leave it empty. Put city in "City", state in "State".
- WORK/PROJECT DESCRIPTIONS: For "Details"/"Description"/"Responsibilities" fields, write 2-3 short bullet points ("• " each on its own line) with key responsibilities and one measurable impact for THAT job. Keep it under ~300 characters.
- REPEATED SECTIONS: Fill EVERY repeated group with a DIFFERENT entry, most recent first. Map ALL experiences to available groups.
- SALARY EXPECTATIONS: If the user provided a target, use it. Otherwise estimate a realistic annual range from experience + role + location. Never write "Negotiable".
- For each suggestion, include a "confidence" of "high", "medium", or "low".
- Only leave a field out if it is truly impossible to answer AND has no sensible "not applicable"/"decline" option — this should be rare.

Return ONLY valid JSON:
{
  "suggestions": [
    { "id": "<field id>", "label": "<field label>", "value": "<value>", "confidence": "high|medium|low" }
  ]
}`;
}

export function buildParsePrompt(profile) {
  return `You are a precise resume parser. From the resume below, extract the candidate's contact details, and list EVERY job and EVERY school.
"""
${profile || "(no resume text)"}
"""
Rules:
- Copy contact details exactly as written. Use "" for anything not present in the resume — never guess.
- "location" is the candidate's own "City, State" (not an employer's location). "website" is a GitHub or personal site URL.
- "experience" is total years of professional experience only if the resume states it; otherwise "".
- Create ONE experience item per distinct employer/role. Capture them ALL. Never merge or skip.
- Order most-recent-first.
- Create one education item per school/degree.
- Keep values short.

Respond with ONLY this JSON:
{"contact":{"firstName":"","lastName":"","email":"","phone":"","location":"","country":"","linkedin":"","website":"","experience":""},"experience":[{"position":"","organization":"","startDate":"","endDate":""}],"education":[{"degree":"","major":"","institution":"","startDate":"","graduationDate":""}]}`;
}

export const FILL_GEN_CONFIG = {
  temperature: 0.2,
  maxOutputTokens: 4096,
  responseMimeType: "application/json",
};

export const PARSE_GEN_CONFIG = {
  temperature: 0,
  maxOutputTokens: 3072,
  responseMimeType: "application/json",
};
