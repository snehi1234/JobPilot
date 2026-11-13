// answer-engine.mjs — resolves form answers WITHOUT calling the AI when possible.
//
// Order of resolution for each detected field:
//   1. Profile rules: deterministic answers from Quick Details (name, email,
//      phone, links, location, country / phone country code, visa type,
//      sponsorship), today's date, and the application source (LinkedIn etc.).
//   2. Answer memory: answers the AI gave earlier for the same question on
//      another application, as long as the profile has not changed since.
//   3. Everything else is sent to the AI in ONE request.
//
// The memory is keyed to a hash of the profile, so editing any Quick Details,
// notes, or the resume invalidates every remembered answer.

const MAX_MEMORY_ENTRIES = 500;
const MAX_REMEMBERED_LENGTH = 120;

export function normalizeLabel(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/\*/g, "")
    .replace(/\(required\)|\(optional\)/g, "")
    .replace(/[^\p{L}\p{N}+'#&/ -]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function fieldSignature(field) {
  const options = Array.isArray(field.options)
    ? field.options.map(normalizeLabel).filter(Boolean).sort().join("|").slice(0, 400)
    : "";
  return `${field.kind}|${normalizeLabel(field.label)}|${options}|#${field.occurrence ?? 0}`;
}

// Job-specific or time-sensitive questions must always be answered fresh.
// Stems (no trailing \b) also match longer forms, e.g. "referr" → "referrer".
const NOT_REUSABLE = /\b(why|interest|motivat|cover letter|tell us|describ|explain|additional|anything else|summary|today|date|month|year|signatur|salary|compensat|pay\b|expected|this (role|position|job|company|team)|refer|captcha|essay|message)/;

export function isReusable(field) {
  if (field.tag === "textarea") return false;
  if (!field.label) return false;
  return !NOT_REUSABLE.test(normalizeLabel(field.label));
}

export function todayString(date = new Date()) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${date.getFullYear()}`;
}

// Deterministic answers from the user's own Quick Details. Returns null when
// unsure so the field falls through to memory or the AI.
//
// Salary for this job: the first Answer Studio row whose keyword appears in the
// job title, else the default salary.
export function salaryFor(structured = {}, jobTitle = "") {
  const title = String(jobTitle || "").toLowerCase();
  for (const i of [1, 2, 3]) {
    const keyword = String(structured[`salaryRole${i}`] || "").trim().toLowerCase();
    const amount = String(structured[`salaryAmount${i}`] || "").trim();
    if (keyword && amount && title.includes(keyword)) return amount;
  }
  return String(structured.salary || "").trim() || null;
}

const val = (v) => String(v || "").trim() || null;

// Answer Studio: exact answers the user set for common questions.
function studioRule(L, s, context) {
  if (/preferred (first )?name|nickname|name you go by/.test(L) && val(s.preferredName)) return val(s.preferredName);
  if (/pronoun/.test(L)) return val(s.pronouns);
  if (/(salary|compensation|pay|base)( (expectation|requirement|range|request)s?)|(expected|desired|target) (annual )?(salary|compensation|pay|base)|^(salary|compensation)$|what are your (salary|compensation|pay)/.test(L) &&
      !/\b(current|previous|last|prior)\b/.test(L)) {
    return salaryFor(s, context.jobTitle);
  }
  if (/notice period|how much notice/.test(L)) return val(s.noticePeriod);
  if (/(earliest|soonest|desired|possible|preferred) (start|starting)|when (can|could|would) you (start|begin|join)|availab\w* to (start|begin|join)|date available|start availability/.test(L)) {
    return val(s.startAvailability);
  }
  if (/relocat/.test(L)) return val(s.relocation);
  if (/security clearance|(active|current) clearance|clearance level/.test(L)) return val(s.clearance);
  if (/(18|eighteen) (years|yrs)|at least 18|over (the age of )?18|legal (working )?age/.test(L)) return val(s.over18);

  const pref = val(s.workArrangement);
  if (pref && /(work|working|job) (arrangement|setting|model|style|location type)|prefer\w* (work|working)|remote,? (or )?(hybrid|on-?site|in office)/.test(L)) {
    return pref;
  }
  // "Are you willing to work on-site / in the office / hybrid?" — only when
  // the answer follows clearly from the preference, and never for questions
  // that also ask where the candidate is now.
  if (pref && /(willing|able|open|comfortable)\b.{0,40}\b(work|commut|come)\w*\b.{0,40}(on-?site|in (the |our )?office|in person|hybrid)/.test(L) &&
      !/currently (in|located|based|live|living)|based in|reside/.test(L)) {
    const target = /hybrid/.test(L) ? "Hybrid" : "On-site";
    if (pref === "Open to any" || pref === target || (pref === "On-site" && target === "Hybrid")) return "Yes";
    if (pref === "Remote") return "No";
  }
  return null;
}

export function profileRule(field, structured = {}, context = {}) {
  const s = structured || {};
  const L = normalizeLabel(field.label);
  if (!L) return null;
  const kind = field.kind;
  const isText = kind === "text";
  const first = (s.firstName || "").trim();
  const last = (s.lastName || "").trim();
  const location = (s.location || "").trim();
  const phone = (s.phone || "").trim();
  const country = (s.country || "").trim() || (/^\+1\b/.test(phone) ? "United States" : "");

  // Questions about someone else (referrer, emergency contact, manager…).
  if (/\b(refer|emergency|reference|recruiter|manager|supervisor|spouse|guardian|relative)/.test(L)) return null;

  if (/today'?s date|current date|date of (signature|acknowledg)|signature date|enter (the|today'?s) date/.test(L)) {
    return isText || kind === "combobox" ? todayString(context.today) : null;
  }
  if (/\b(country|phone|dial(ing)?|calling)( phone)? code\b/.test(L)) {
    if (isText) {
      const code = phone.match(/^\+\d{1,3}/);
      return code ? code[0] : null;
    }
    return country || null;
  }
  if (/how did you (hear|find|learn)|where did you (hear|find|see|learn)|referral source|^source$|application source/.test(L)) {
    return context.sourceHint || (s.defaultSource || "").trim() || null;
  }
  const studio = kind === "checkbox" ? null : studioRule(L, s, context);
  if (studio) return studio;
  // Sponsorship questions often say "visa status" too; answer them first.
  if (/sponsor/.test(L) && /^(yes|no)$/i.test(s.sponsorship || "") && kind !== "checkbox") {
    return s.sponsorship;
  }
  if (!/sponsor/.test(L) && /visa (type|status)|immigration status|work (permit|visa) (type|status)/.test(L)) {
    return (s.workAuth || "").trim() || null;
  }

  if (kind === "combobox" || kind === "select") {
    if (/^(country|country of residence|current country)$/.test(L)) return country || null;
    if (kind === "combobox" && /^(location|current location|city|where are you (located|based))/.test(L)) return location || null;
    return null;
  }
  if (!isText) return null;

  if (/^(full |legal |your )?name$|^candidate name$|^full legal name$/.test(L)) return first && last ? `${first} ${last}` : null;
  if (/first name|given name|preferred (first )?name/.test(L)) return first || null;
  if (/last name|surname|family name/.test(L)) return last || null;
  if (/\be-?mail\b/.test(L)) return (s.email || "").trim() || null;
  if (/\b(phone|mobile|cell)\b/.test(L) && !/\b(code|type|extension|ext)\b/.test(L)) return phone || null;
  if (/linkedin/.test(L)) return (s.linkedin || "").trim() || null;
  if (/github/.test(L)) return /github\.com/i.test(s.website || "") ? s.website.trim() : null;
  if (/portfolio|personal (web)?site|^website$|^web site$/.test(L)) return (s.website || "").trim() || null;
  if (/^city$/.test(L)) return location.split(",")[0].trim() || null;
  if (/^(state|province|state province)$/.test(L)) return location.split(",")[1]?.trim() || null;
  if (/^(location|current location|city state|where are you (located|based))/.test(L)) return location || null;
  if (/^country$/.test(L)) return country || null;
  if (/years of (professional |relevant |work )?experience/.test(L)) return (s.experience || "").replace(/\+/g, "").trim() || null;
  return null;
}

// Split detected fields into answers known locally and fields that still
// need the AI.
//   memory:      { version, entries: { [signature]: value } } (AI answers)
//   corrections: { [signature]: value } — values the user typed over ours;
//                they win over everything, including profile rules.
//   library:     [{ question, answer }] — saved long answers, offered as
//                drafts for similar long questions.
export function resolveLocally(fields, { structured, memory, context, corrections, library } = {}) {
  const suggestions = [];
  const pending = [];
  for (const field of fields) {
    const signature = fieldSignature(field);
    const corrected = isReusable(field) ? corrections?.[signature] : undefined;
    if (corrected) {
      suggestions.push({ id: field.id, label: field.label, value: corrected, confidence: "high", source: "correction" });
      continue;
    }
    const rule = profileRule(field, structured, context);
    if (rule) {
      suggestions.push({ id: field.id, label: field.label, value: rule, confidence: "high", source: "profile" });
      continue;
    }
    const remembered = isReusable(field) ? memory?.entries?.[signature] : undefined;
    if (remembered) {
      suggestions.push({ id: field.id, label: field.label, value: remembered, confidence: "high", source: "memory" });
      continue;
    }
    const saved = isLongQuestion(field) ? findLibraryAnswer(library, field.label) : null;
    if (saved) {
      suggestions.push({ id: field.id, label: field.label, value: saved.answer, confidence: "medium", source: "library" });
      continue;
    }
    pending.push(field);
  }
  return { suggestions, pending };
}

// Open-ended questions answered with a paragraph rather than a value.
// Cover letters are handled separately (the user's file or an AI letter for
// the job), never answered like an ordinary question.
export function isCoverLetterField(field) {
  return /cover(ing)? letter|motivation(al)? letter|letter of (motivation|interest)/i.test(String(field?.label || "")) &&
    (field.kind === "text" || field.tag === "textarea");
}

export function isLongQuestion(field) {
  if (field.tag === "textarea") return true;
  return field.kind === "text" &&
    /\b(why|describe|tell us|explain|cover letter|motivat|what interests|what excites|share an example|walk us through)/.test(normalizeLabel(field.label));
}

const QUESTION_STOPWORDS = new Set("a an and the of for to in on with at by from or as is are be we you our your this that what how do does did please".split(" "));
function questionWords(text) {
  return new Set(normalizeLabel(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !QUESTION_STOPWORDS.has(w)));
}

export function findLibraryAnswer(library, question) {
  const target = questionWords(question);
  if (!target.size) return null;
  let best = null;
  let bestScore = 0;
  for (const item of library || []) {
    const words = questionWords(item.question);
    if (!words.size) continue;
    const shared = [...target].filter((w) => words.has(w)).length;
    const score = shared / Math.max(target.size, words.size);
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return bestScore >= 0.6 ? best : null;
}

// Record a value the user typed over an autofilled answer.
export function recordCorrection(corrections, field, value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!field || !isReusable(field) || !text || text.length > MAX_REMEMBERED_LENGTH) return corrections || {};
  const next = { ...(corrections || {}), [fieldSignature(field)]: text };
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_MEMORY_ENTRIES))) delete next[key];
  return next;
}

// Store reusable AI answers. Low-confidence guesses are never remembered.
export function rememberAnswers(memory, fields, suggestions) {
  const byId = new Map(fields.map((f) => [String(f.id), f]));
  const entries = { ...(memory?.entries || {}) };
  for (const s of suggestions || []) {
    const field = byId.get(String(s.id));
    if (!field || !isReusable(field)) continue;
    if (String(s.confidence || "").toLowerCase() === "low") continue;
    if (typeof s.value !== "string" || !s.value.trim() || s.value.length > MAX_REMEMBERED_LENGTH) continue;
    entries[fieldSignature(field)] = s.value.trim();
  }
  const keys = Object.keys(entries);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_MEMORY_ENTRIES))) delete entries[key];
  return { version: memory?.version, entries };
}

export async function profileVersion(structured, profile) {
  const bytes = new TextEncoder().encode(JSON.stringify({ structured: structured || {}, profile: profile || "" }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
