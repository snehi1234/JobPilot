export const RESUME_DETAIL_KEYS = [
  "firstName", "lastName", "email", "phone", "location", "country",
  "linkedin", "website", "experience",
];

export function extractResumeDetails(text) {
  const details = {};
  const header = text.split(/\b(?:summary|professional experience|work experience|education|skills)\b/i)[0].slice(0, 1800);
  const email = header.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (email) details.email = email[0];
  const phone = header.match(/(?:\+\d{1,3}[\s.-]*)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/);
  if (phone) details.phone = phone[0];
  const linkedin = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[a-z0-9_%.-]+\/?/i);
  const github = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[a-z0-9_-]+\/?/i);
  if (linkedin) details.linkedin = /^https?:/i.test(linkedin[0]) ? linkedin[0] : `https://${linkedin[0]}`;
  if (github) details.website = /^https?:/i.test(github[0]) ? github[0] : `https://${github[0]}`;

  const name = header.split(/\r?\n/).map(line => line.trim()).find(line =>
    /^[\p{L}][\p{L}'’.-]+(?:\s+[\p{L}][\p{L}'’.-]*){1,4}$/u.test(line) &&
    !/\b(resume|curriculum|vitae|engineer|developer|manager|scientist|experience|summary)\b/i.test(line)
  );
  if (name) {
    const [first, ...rest] = name.split(/\s+/);
    details.firstName = first;
    details.lastName = rest.join(" ");
  }
  const years = text.match(/\b(\d{1,2}\+?)\s+years?\s+(?:of\s+)?experience\b/i);
  if (years) details.experience = years[1];
  return details;
}

export function mergeResumeDetails(current, extracted) {
  const merged = { ...current };
  for (const key of RESUME_DETAIL_KEYS) {
    if (!String(merged[key] ?? "").trim() && typeof extracted?.[key] === "string") {
      merged[key] = extracted[key].trim();
    }
  }
  return merged;
}
