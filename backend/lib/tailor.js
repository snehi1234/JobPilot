// lib/tailor.js — prompt and guardrails for tailoring a resume to a job.
// The AI suggests rewrites of existing bullets; anything that isn't grounded
// in the resume is dropped here before it reaches the user.

const norm = (s) => String(s || "").toLowerCase().replace(/[•\-–—*▪◦●]/g, " ").replace(/[^\p{L}\p{N}%$.+#/]+/gu, " ").replace(/\s+/g, " ").trim();
const numbers = (s) => (String(s || "").match(/\d[\d,.]*\s*(%|k|m|b|x)?/gi) || []).map((n) => n.replace(/[,\s]/g, "").toLowerCase().replace(/\.$/, ""));

// Keep in sync with reflowBullets in the extension's lib/tailored-resume.mjs:
// PDF text splits each wrapped bullet over several lines; join them.
const BULLET = /^[•\-–*▪◦●➢►✓]\s*/;
const HEADING = /^(summary|professional summary|profile|about|objective|experience|work experience|professional experience|employment( history)?|work history|education|skills|technical skills|core skills|key skills|projects|selected projects|certifications?|awards|honors|publications|leadership|volunteer(ing)?|activities|languages|interests|achievements)\s*:?\s*$/i;
const DATE = /\b((jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|(19|20)\d{2})\s*([-–—]|to)\s*((jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|(19|20)\d{2}|present|current|now)\b/i;
function isHeading(line) {
  const t = line.trim();
  if (HEADING.test(t)) return true;
  const letters = t.replace(/[^A-Za-z]/g, "");
  return t.length >= 4 && t.length <= 40 && letters.length >= 4 && letters === letters.toUpperCase() && !/[@|]/.test(t) && !BULLET.test(t);
}
export function reflowBullets(text) {
  const out = [];
  let inBullet = false;
  for (const raw of String(text || "").split("\n")) {
    const t = raw.trim();
    const prev = out.length ? out[out.length - 1].trim() : "";
    const plain = t && prev && !BULLET.test(t) && !isHeading(t) && !DATE.test(t);
    // Bulleted lines: continuations start lowercase or follow a long unfinished
    // line. Without bullet symbols (bullets drawn as graphics) only the strict
    // rule applies, so separate bullets never merge.
    const continues = plain && (inBullet
      ? /^[a-z0-9(&,;:/–-]/.test(t) || (!/[.!?;:]$/.test(prev) && prev.length >= 60)
      : /^[a-z0-9(&,;:/–-]/.test(t) && !/[.!?;:]$/.test(prev) && prev.length >= 50);
    if (continues) {
      out[out.length - 1] = `${out[out.length - 1].replace(/\s+$/, "")} ${t}`;
      continue;
    }
    out.push(raw);
    inBullet = BULLET.test(t);
  }
  return out.join("\n");
}

// Technologies a bullet names (tech lists in parentheses, acronyms, CamelCase,
// C#, .NET, Vue.js…). A rewrite must keep all of them.
const squash = (s) => String(s || "").toLowerCase().replace(/\s*([-/.])\s*/g, "$1").replace(/\s+/g, " ");
export function namedTech(text) {
  const t = String(text || "");
  const found = new Set();
  for (const group of t.match(/\(([^)]{2,160})\)/g) || []) {
    for (const item of group.slice(1, -1).split(/,|;/)) {
      const v = item.trim().replace(/^(and|or)\s+/i, "");
      if (v && v.split(/\s+/).length <= 3 && /[A-Z#+.]/.test(v)) found.add(v);
    }
  }
  for (const m of t.match(/C#|C\+\+|\.NET\b|\b[A-Za-z]+\.(?:js|io)\b|\b[A-Z]{2,}[A-Za-z0-9]*\b|\b[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*\b/g) || []) found.add(m);
  return [...found];
}
export function droppedTech(original, improved) {
  const after = squash(improved);
  return namedTech(original).filter((tech) => !after.includes(squash(tech)));
}

export function buildTailorPrompt({ resume, jobContext = {} }) {
  return `You tailor a candidate's resume to a specific job. You may only rephrase what the resume already says.
Job title: ${String(jobContext.title || "(unknown)").slice(0, 200)}
Company: ${String(jobContext.company || "(unknown)").replace(/^.* @ /, "").slice(0, 120)}
Job description:
"""
${String(jobContext.description || "").slice(0, 5000)}
"""
Resume:
"""
${reflowBullets(resume).slice(0, 12000)}
"""
Tasks:
1. Pick the 4–8 resume bullets most relevant to this job and rewrite each to lead with the impact and use the job description's terminology where the bullet already supports it.
2. Write a 2-sentence professional summary for the top of the resume, aimed at this job.
3. List the resume's skills most relevant to this job, most relevant first (only skills that appear in the resume).
4. List up to 5 important job requirements the resume does not show.
Rules:
- "original" must be copied EXACTLY from the resume (one bullet, without the bullet symbol).
- Never add employers, titles, technologies, numbers, or results that are not in that bullet. Keep every number as written.
- Keep EVERY technology, language, tool, and product named in the original bullet (e.g. "C#, .NET Core 6, Vue.js", "Kafka", "RabbitMQ"). Removing them hurts the candidate's match.
- Keep each improved bullet about the same length as the original (within 10%, never more than 15% longer) so it fits the resume's layout, starting with a strong past-tense verb. If the original starts with a bold-style lead-in phrase, start the rewrite with a similar short phrase followed by a comma.
Respond with ONLY this JSON:
{"summary":"","bullets":[{"original":"","improved":"","keywords":[""]}],"skills":[""],"gaps":[""]}`;
}

export const TAILOR_GEN_CONFIG = { temperature: 0.3, maxOutputTokens: 2200, responseMimeType: "application/json" };

// Keep only suggestions grounded in the resume. Clients that join wrapped
// bullets themselves send wholeBullets; older ones get the bullet's first line.
export function sanitizeTailoring(raw, rawResume, { wholeBullets = false } = {}) {
  const physical = String(rawResume || "").split(/\n/).map((l) => l.trim()).filter(Boolean);
  const resume = reflowBullets(rawResume);
  const resumeNorm = norm(resume);
  const resumeLines = String(resume || "").split(/\n/).map((l) => l.trim()).filter(Boolean);
  const resumeNumbers = new Set(numbers(resume));
  const bullets = [];
  for (const b of Array.isArray(raw?.bullets) ? raw.bullets : []) {
    const original = String(b?.original || "").trim().slice(0, 900);
    const improved = String(b?.improved || "").trim().replace(/^[•\-–*]\s*/, "").slice(0, 450);
    if (original.length < 15 || improved.length < 15 || norm(original) === norm(improved)) continue;
    // The original must really be on the resume; use the resume's exact line.
    const target = norm(original);
    const line = resumeLines.find((l) => norm(l).includes(target) || (target.length > 40 && target.includes(norm(l)) && norm(l).length > 30));
    if (!line || !resumeNorm.includes(target.slice(0, 60))) continue;
    // No new numbers.
    const allowed = new Set([...numbers(line), ...numbers(original)]);
    if (numbers(improved).some((n) => !allowed.has(n) && !resumeNumbers.has(n))) continue;
    // Never drop the technologies the bullet names.
    if (droppedTech(line, improved).length) continue;
    if (bullets.some((x) => x.line === line)) continue;
    bullets.push({
      original: line.replace(/^[•\-–*▪◦●]\s*/, ""),
      line: wholeBullets ? line : (physical.find((l) => line.startsWith(l)) || line),
      improved,
      keywords: (Array.isArray(b.keywords) ? b.keywords : []).map((k) => String(k).slice(0, 40)).filter(Boolean).slice(0, 6),
    });
    if (bullets.length === 8) break;
  }
  const skills = (Array.isArray(raw?.skills) ? raw.skills : []).map((s) => String(s).trim().slice(0, 40))
    .filter((s) => s && resumeNorm.includes(norm(s))).slice(0, 20);
  const summary = String(raw?.summary || "").trim().slice(0, 600);
  const summaryNumbersOk = numbers(summary).every((n) => resumeNumbers.has(n));
  return {
    summary: summaryNumbersOk ? summary : "",
    bullets,
    skills,
    gaps: (Array.isArray(raw?.gaps) ? raw.gaps : []).map((g) => String(g).trim().slice(0, 120)).filter(Boolean).slice(0, 5),
  };
}
