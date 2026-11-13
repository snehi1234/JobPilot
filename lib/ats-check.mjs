// ats-check.mjs — on-device resume health check for applicant tracking
// systems (ATS). No network, no AI. Returns a score and a list of checks with
// concrete fixes.

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(\+?\d{1,3}[\s.-]{0,4})?\(?\d{3}\)?[\s.-]{0,4}\d{3}[\s.-]{0,4}\d{4}/;
const LINKEDIN = /linkedin\.com\/in\//i;
const SECTION = {
  experience: /^\s*(work |professional |relevant )?(experience|employment( history)?|work history|career history)\s*:?\s*$/im,
  education: /^\s*(education|academic background|academics)\s*:?\s*$/im,
  skills: /^\s*[A-Za-z&/,' ]{0,25}\b(skills|technologies|tech stack|competencies|toolkit|expertise|proficiencies)\b/im,
};
const WEAK_START = /^(responsible for|worked on|helped( to)?|assisted (with|in)|involved in|participated in|duties included|tasked with|in charge of)\b/i;
const DATE = /\b((jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|\d{4}\s*[-–—]\s*(\d{4}|present|current|now))\b/i;
const ODD_SYMBOLS = /[\uE000-\uF8FF\uFFFD]/g;

function bulletLines(text) {
  return text.split(/\n/).map((l) => l.trim())
    .filter((l) => /^[•\-–*▪◦●○■□➢►✓]\s*/.test(l) || (/^[A-Z][a-z]+(ed|ing)\b/.test(l) && l.length > 40))
    .map((l) => l.replace(/^[•\-–*▪◦●○■□➢►✓]\s*/, ""))
    .filter((l) => l.length > 25);
}

const check = (id, status, title, detail) => ({ id, status, title, detail });

// text: extracted resume text; meta: { fileName, layout: { pages, splitRowRatio } }
export function analyzeResume(text = "", meta = {}) {
  const t = String(text || "");
  const words = t.split(/\s+/).filter(Boolean);
  const checks = [];

  // 1. Machine-readable text
  const letters = (t.match(/\p{L}/gu) || []).length;
  const odd = (t.match(ODD_SYMBOLS) || []).length;
  if (words.length < 80 || letters < 400) {
    checks.push(check("readable", "fail", "Text can't be read reliably",
      "Very little text could be extracted. If this is a scanned or image-based PDF, ATS software will see a nearly blank page. Export your resume from Word or Google Docs as a text-based PDF."));
  } else if (odd > 5) {
    checks.push(check("readable", "warn", "Some symbols don't convert to text",
      `${odd} characters came out as unreadable symbols (often decorative bullets or icon fonts). Use standard bullets (•) and avoid icon fonts for contact details.`));
  } else {
    checks.push(check("readable", "pass", "Text is machine-readable", "ATS software can extract your resume's text."));
  }

  // 2. Layout
  const ratio = meta.layout?.splitRowRatio;
  if (typeof ratio === "number") {
    checks.push(ratio > 0.3
      ? check("layout", "warn", "Looks like a multi-column layout or table",
        "Side-by-side columns and tables are often read across the page, mixing sections together. A single-column layout is safest for ATS.")
      : check("layout", "pass", "Single-column layout", "Your content reads top to bottom, which ATS software handles well."));
  }

  // 3. Contact details
  const missing = [!EMAIL.test(t) && "email", !PHONE.test(t) && "phone", !LINKEDIN.test(t) && "LinkedIn URL"].filter(Boolean);
  checks.push(missing.length === 0
    ? check("contact", "pass", "Contact details found", "Email, phone, and LinkedIn are all in the text.")
    : check("contact", missing.includes("email") ? "fail" : "warn", `Missing: ${missing.join(", ")}`,
      "Put contact details in the main body as plain text (not only in a header, image, or icon), so ATS and recruiters can find them."));

  // 4. Standard section headings
  const absent = Object.entries(SECTION).filter(([, re]) => !re.test(t)).map(([name]) => name);
  checks.push(absent.length === 0
    ? check("sections", "pass", "Standard sections found", "Experience, Education, and Skills headings are present.")
    : check("sections", absent.includes("experience") ? "fail" : "warn", `No clear "${absent.map((s) => s[0].toUpperCase() + s.slice(1)).join('", "')}" heading`,
      'ATS software looks for standard headings. Use plain titles like "Experience", "Education", and "Skills" on their own line.'));

  // 5. Dates
  checks.push(DATE.test(t)
    ? check("dates", "pass", "Employment dates found", "Dates help ATS calculate your years of experience.")
    : check("dates", "warn", "No clear dates found", 'Add start and end dates to each role, e.g. "Jan 2022 – Present".'));

  // 6. Length
  const pages = meta.layout?.pages;
  if (words.length > 1300 || pages > 3) {
    checks.push(check("length", "warn", `Long resume (${words.length} words${pages ? `, ${pages} pages` : ""})`,
      "Recruiters skim. Aim for 1 page per ~5 years of experience and at most 2 pages for most roles."));
  } else if (words.length < 250) {
    checks.push(check("length", "warn", `Short resume (${words.length} words)`, "Add more detail on your impact: projects, scope, and results."));
  } else {
    checks.push(check("length", "pass", `Good length (${words.length} words${pages ? `, ${pages} page${pages === 1 ? "" : "s"}` : ""})`, "Easy to skim without leaving out impact."));
  }

  // 7. Quantified impact and strong verbs
  const bullets = bulletLines(t);
  if (bullets.length >= 4) {
    const quantified = bullets.filter((b) => /\d|%|\$/.test(b)).length;
    const share = quantified / bullets.length;
    checks.push(share >= 0.4
      ? check("impact", "pass", `${Math.round(share * 100)}% of bullets show measurable results`, "Numbers make your impact concrete.")
      : check("impact", "warn", `Only ${Math.round(share * 100)}% of bullets have numbers`,
        "Add scale or results where you can: users, requests/sec, % faster, $ saved, team size."));
    const weak = bullets.filter((b) => WEAK_START.test(b));
    checks.push(weak.length === 0
      ? check("verbs", "pass", "Bullets start with action verbs", "")
      : check("verbs", "warn", `${weak.length} bullet${weak.length === 1 ? "" : "s"} start weakly`,
        `Start with a strong verb (Built, Led, Designed, Reduced). For example: "${weak[0].slice(0, 70)}${weak[0].length > 70 ? "…" : ""}"`));
  }

  // 8. File name
  if (meta.fileName) {
    const generic = /^(resume|cv|my[ _-]?resume|document|untitled|final)[\w ()-]*\.(pdf|docx)$/i.test(meta.fileName);
    checks.push(generic
      ? check("filename", "warn", `Generic file name "${meta.fileName}"`, 'Recruiters download many files. Use "FirstName_LastName_Resume.pdf".')
      : check("filename", "pass", "Descriptive file name", ""));
  }

  const weight = { pass: 1, warn: 0.5, fail: 0 };
  const score = checks.length ? Math.round((checks.reduce((n, c) => n + weight[c.status], 0) / checks.length) * 100) : 0;
  return { score, checks };
}
