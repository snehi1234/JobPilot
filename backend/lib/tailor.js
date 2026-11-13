// lib/tailor.js — prompt and guardrails for tailoring a resume to a job.
// The AI suggests rewrites of existing bullets; anything that isn't grounded
// in the resume is dropped here before it reaches the user.

const norm = (s) => String(s || "").toLowerCase().replace(/[•\-–—*▪◦●]/g, " ").replace(/[^\p{L}\p{N}%$.+#/]+/gu, " ").replace(/\s+/g, " ").trim();
const numbers = (s) => (String(s || "").match(/\d[\d,.]*\s*(%|k|m|b|x)?/gi) || []).map((n) => n.replace(/[,\s]/g, "").toLowerCase().replace(/\.$/, ""));

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
${String(resume || "").slice(0, 12000)}
"""
Tasks:
1. Pick the 4–8 resume bullets most relevant to this job and rewrite each to lead with the impact and use the job description's terminology where the bullet already supports it.
2. Write a 2-sentence professional summary for the top of the resume, aimed at this job.
3. List the resume's skills most relevant to this job, most relevant first (only skills that appear in the resume).
4. List up to 5 important job requirements the resume does not show.
Rules:
- "original" must be copied EXACTLY from the resume (one bullet, without the bullet symbol).
- Never add employers, titles, technologies, numbers, or results that are not in that bullet. Keep every number as written.
- Keep each improved bullet to one sentence, under 220 characters, starting with a strong past-tense verb.
Respond with ONLY this JSON:
{"summary":"","bullets":[{"original":"","improved":"","keywords":[""]}],"skills":[""],"gaps":[""]}`;
}

export const TAILOR_GEN_CONFIG = { temperature: 0.3, maxOutputTokens: 2200, responseMimeType: "application/json" };

// Keep only suggestions grounded in the resume.
export function sanitizeTailoring(raw, resume) {
  const resumeNorm = norm(resume);
  const resumeLines = String(resume || "").split(/\n/).map((l) => l.trim()).filter(Boolean);
  const resumeNumbers = new Set(numbers(resume));
  const bullets = [];
  for (const b of Array.isArray(raw?.bullets) ? raw.bullets : []) {
    const original = String(b?.original || "").trim().slice(0, 600);
    const improved = String(b?.improved || "").trim().replace(/^[•\-–*]\s*/, "").slice(0, 400);
    if (original.length < 15 || improved.length < 15 || norm(original) === norm(improved)) continue;
    // The original must really be on the resume; use the resume's exact line.
    const target = norm(original);
    const line = resumeLines.find((l) => norm(l).includes(target) || (target.length > 40 && target.includes(norm(l)) && norm(l).length > 30));
    if (!line || !resumeNorm.includes(target.slice(0, 60))) continue;
    // No new numbers.
    const allowed = new Set([...numbers(line), ...numbers(original)]);
    if (numbers(improved).some((n) => !allowed.has(n) && !resumeNumbers.has(n))) continue;
    if (bullets.some((x) => x.line === line)) continue;
    bullets.push({
      original: line.replace(/^[•\-–*▪◦●]\s*/, ""),
      line,
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
