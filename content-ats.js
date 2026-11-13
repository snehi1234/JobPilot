// content-ats.js — iCIMS, SmartRecruiters, Taleo and SAP SuccessFactors
// support. Loaded after content-workday.js and before content.js (same
// isolated world). content.js calls into this file only through
// `typeof … === "function"` guards, like the Workday hooks.
//
// What each platform needs (observed on live postings):
//   • iCIMS: the posting and the application live in a same-origin
//     "icims_content_iframe" (?in_iframe=1). The top frame reads and fills that
//     frame directly, and the frame's own copy of the script stands down. The
//     application starts with an email step (plus a security check).
//   • SmartRecruiters: the One Click form is built from `spl-*` web components
//     (open shadow roots); labels sit on the component (`label="First name"`)
//     and screening questions in `[data-test=question-container]` blocks.
//   • Taleo: legacy forms; the posting text is in #requisitionDescriptionInterface
//     and applying requires signing in to a Taleo account first.
//   • SuccessFactors: Career Site Builder postings (often on the employer's
//     own domain) and an application behind a sign-in / account page; some
//     pick lists are role="combobox" widgets rather than <select>s.

var JP_ATS_FRAME_SELECTOR = "iframe#icims_content_iframe, iframe[name='icims_content_iframe']";
var JP_ATS_DROPDOWN_SELECTOR = "[role='combobox'][aria-haspopup='listbox']:not(input), .sapMSlt[role='combobox'], .sapMComboBox[role='combobox']:not(input)";
var JP_ATS_IGNORE_SELECTOR = "#onetrust-consent-sdk, #onetrust-banner-sdk, #onetrust-pc-sdk, #truste-consent-track, #consent_blackbar, #CybotCookiebotDialog, [data-test^='footer-'], .subscribe-frequency, [id*='jobAlert' i], [class*='jobAlert' i]";

function jpAtsHostMatch(re) {
  return re.test(location.hostname || "");
}

// "icims" | "smartrecruiters" | "taleo" | "successfactors" | ""
function jpAtsPlatform() {
  const doc = document;
  if (jpAtsHostMatch(/(^|\.)icims\.com$/) || doc.querySelector?.(`${JP_ATS_FRAME_SELECTOR}, .iCIMS_MainWrapper, .iCIMS_JobContent`)) return "icims";
  if (jpAtsHostMatch(/(^|\.)(smartrecruiters\.com|smartr\.me)$/)) return "smartrecruiters";
  if (jpAtsHostMatch(/(^|\.)taleo\.net$/) || doc.querySelector?.("#requisitionDescriptionInterface")) return "taleo";
  if (jpAtsHostMatch(/(^|\.)(successfactors\.(com|eu|cn)|sapsf\.(com|eu|cn))$/) ||
      doc.querySelector?.("a.dialogApplyBtn, span.jobdescription, #rmkContent, [data-careersite-propertyid='description']")) return "successfactors";
  return "";
}

// ---------- Same-origin iCIMS frame ----------

// This frame is the iCIMS content frame of a same-origin page; the top frame
// handles it (one button, one scan), so this copy stays idle.
function jpAtsAdoptedFrame() {
  try {
    return window !== window.top && !!window.frameElement?.matches?.(JP_ATS_FRAME_SELECTOR);
  } catch {
    return false;
  }
}

// Documents to read: this one plus same-origin iCIMS content frames.
function jpAtsDocs() {
  const docs = [document];
  for (const frame of document.querySelectorAll?.(JP_ATS_FRAME_SELECTOR) || []) {
    try {
      if (frame.contentDocument?.documentElement) docs.push(frame.contentDocument);
    } catch { /* cross-origin */ }
  }
  return docs;
}

// Elements never treated as application fields: cookie banners and
// SmartRecruiters' footer navigation (Next / Submit).
function jpAtsIgnore(el) {
  try {
    return !!el.closest?.(JP_ATS_IGNORE_SELECTOR);
  } catch {
    return false;
  }
}

// ---------- Labels (web components) ----------

// Parent element, crossing out of a shadow root to its host.
function jpAtsUp(node) {
  return node.parentElement || node.getRootNode?.()?.host || null;
}

function jpAtsClean(text) {
  return String(text || "").replace(/\*/g, "").replace(/\s+/g, " ").trim();
}

// The question shown for a SmartRecruiters screening question.
function jpAtsQuestionLabel(el) {
  let node = el;
  for (let depth = 0; node && depth < 10; depth++, node = jpAtsUp(node)) {
    if (node.matches?.("[data-test='question-container']")) {
      const own = node.querySelector("[data-test='question-label'], [data-test='question-title'], legend, label, [class*='question-label' i], [class*='label' i]");
      const text = jpAtsClean(own?.innerText || own?.textContent);
      if (text) return text.slice(0, 200);
      const first = String(node.innerText || "").split("\n").map(jpAtsClean).find(Boolean);
      return first ? first.slice(0, 200) : "";
    }
  }
  return "";
}

// Label of a control inside a spl-* / ui5-* component, from the component's
// own `label` / `accessible-name` attribute (or its text for a check box or
// radio), then the screening question around it.
function jpAtsLabel(el) {
  let node = jpAtsUp(el);
  for (let depth = 0; node && depth < 6; depth++, node = jpAtsUp(node)) {
    const tag = node.tagName?.toLowerCase() || "";
    if (!/^(spl|ui5)-/.test(tag)) continue;
    const attr = node.getAttribute("label") || node.getAttribute("accessible-name") || node.getAttribute("aria-label");
    if (attr && jpAtsClean(attr)) return jpAtsClean(attr);
    if (/^(spl-checkbox|spl-radio|ui5-checkbox|ui5-radio-button)$/.test(tag)) {
      const text = jpAtsClean(node.textContent);
      if (text) return text.slice(0, 200);
    }
  }
  return el.type === "radio" ? "" : jpAtsQuestionLabel(el);
}

// ---------- Job posting text ----------

function jpAtsText(docs, selectors, { meta = false } = {}) {
  for (const sel of selectors) {
    for (const doc of docs) {
      let el;
      try { el = doc.querySelector(sel); } catch { continue; }
      if (!el) continue;
      const text = jpAtsClean(meta || el.tagName === "META" ? el.getAttribute("content") : el.innerText || el.textContent);
      if (text) return text;
    }
  }
  return "";
}

function jpAtsLongest(docs, selectors) {
  let best = "";
  for (const sel of selectors) {
    for (const doc of docs) {
      let els = [];
      try { els = doc.querySelectorAll(sel); } catch { continue; }
      for (const el of els) {
        const text = String(el.innerText || el.textContent || "").trim();
        if (text.length > best.length) best = text;
      }
    }
    if (best.length > 300) break;
  }
  return best;
}

var JP_ATS_POSTING = {
  icims: {
    title: [".iCIMS_Header", ".iCIMS_JobHeaderGroup h1", "h1"],
    description: [".iCIMS_JobContent", ".iCIMS_InfoMsg_Job"],
  },
  smartrecruiters: {
    title: ["h1.job-title", "[itemprop='title']", ".job-title"],
    company: ["[itemprop='hiringOrganization'] [itemprop='name']", "meta[property='og:site_name']"],
    description: ["[itemprop='description']", ".job-sections", ".jobad-main"],
  },
  taleo: {
    title: ["[id^='requisitionDescriptionInterface.reqTitleLinkAction']", ".titlepage"],
    description: ["#requisitionDescriptionInterface .editablesection", ".editablesection", "#requisitionDescriptionInterface"],
  },
  successfactors: {
    title: ["[data-careersite-propertyid='title']", "#job-title", "h1 [itemprop='title']", "[itemprop='title']", "h1"],
    company: ["meta[property='og:site_name']"],
    description: ["span.jobdescription", ".jobdescription", "[data-careersite-propertyid='description']", "[itemprop='description']", ".job .joblayouttoken"],
  },
};

// The posting on this page (title / company / description), for the AI and
// the match badge. Empty fields are left out.
function jpAtsJobContext() {
  const platform = jpAtsPlatform();
  const conf = JP_ATS_POSTING[platform];
  if (!conf) return null;
  const docs = jpAtsDocs();
  const ctx = {};
  const title = jpAtsText(docs, conf.title).split("\n")[0].slice(0, 200);
  if (title) ctx.title = title;
  const company = conf.company ? jpAtsText(docs, conf.company).slice(0, 120) : "";
  if (company) ctx.company = company;
  // Career Site Builder titles end with the employer: "… Job Details | SAP".
  else if (platform === "successfactors") {
    const suffix = (document.title.match(/\|\s*([^|]+)$/) || [])[1]?.trim();
    if (suffix) ctx.company = suffix.slice(0, 120);
  }
  const description = jpAtsLongest(docs, conf.description).slice(0, 6000);
  if (description.length >= 100) ctx.description = description;
  return ctx;
}

// A job posting (not a form) is showing.
function jpAtsIsPosting() {
  const platform = jpAtsPlatform();
  const conf = JP_ATS_POSTING[platform];
  return !!conf && jpAtsLongest(jpAtsDocs(), conf.description).length >= 300;
}

// ---------- Pages before the form ----------

function jpAtsVisible(el) {
  if (!el || el.disabled) return false;
  const rect = el.getBoundingClientRect();
  if (!rect.width && !rect.height) return false;
  const style = (el.ownerDocument?.defaultView || window).getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

var JP_ATS_SIGN_IN = {
  taleo: "This Taleo career site needs you to sign in (or create an account) before the application form. Sign in, then click ⚡ Autofill on each step of the form.",
  successfactors: "This career site needs you to sign in first — choose “Create an account” if you're new. After signing in, click ⚡ Autofill on the application form.",
  icims: "Sign in to this career site first, then click ⚡ Autofill on the application form.",
  smartrecruiters: "Sign in to this career site first, then click ⚡ Autofill on the application form.",
};

// Guidance when the page is a sign-in / email / security-check step rather
// than the application form. Returns { hint, emailInput } or null.
function jpAtsGate() {
  const platform = jpAtsPlatform();
  if (!platform) return null;
  const docs = jpAtsDocs();
  const visible = (sel) => docs.flatMap((doc) => Array.from(doc.querySelectorAll(sel))).filter(jpAtsVisible);

  if (/confirm you are human|just a moment|security check|are you a robot|you have been blocked/i.test(document.title) ||
      visible("iframe[src*='captcha-delivery.com'], iframe[src*='challenges.cloudflare.com']").length) {
    return { hint: "This site is showing a security check. Complete it, then click ⚡ Autofill once the application form appears.", emailInput: null };
  }

  if (platform === "icims") {
    const email = visible("input[name='css_loginName'], #enterEmailSubmitButton ~ input[type='email'], form input#email[type='email']")[0];
    if (email || visible("#enterEmailSubmitButton").length) {
      return {
        hint: "iCIMS asks for your email before the application: check your email address, accept the privacy notice and continue (complete the security check if shown). Then click ⚡ Autofill on the application form.",
        emailInput: email || null,
      };
    }
  }

  const passwords = visible("input[type='password']");
  if (!passwords.length) return null;
  const others = visible("input:not([type]), input[type='text'], input[type='email'], input[type='tel'], textarea, select")
    .filter((el) => !jpAtsIgnore(el) && !/search/i.test(`${el.name || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""}`));
  // Account-creation forms (name, country, …) are filled normally; only a
  // bare sign-in (user name + password) is a gate.
  if (others.length > 2) return null;
  const emailInput = others.find((el) => el.type === "email" ||
    /e-?mail/i.test(`${el.name || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""} ${el.labels?.[0]?.textContent || ""}`)) || null;
  return { hint: JP_ATS_SIGN_IN[platform], emailInput };
}

// ---------- Apply buttons ----------

// The posting's own Apply control, whatever language it is labelled in.
function jpAtsApplyControl() {
  const selector = {
    icims: "a.iCIMS_ApplyOnlineButton",
    smartrecruiters: "a#st-apply[href], a[href*='/oneclick-ui/']",
    taleo: "input[type='button'][id*='APPLY_ON_REQ'], a[id*='APPLY_ON_REQ']",
    successfactors: "a.dialogApplyBtn[href]",
  }[jpAtsPlatform()];
  if (!selector) return null;
  return jpQueryAll(selector).find((el) => isVisible(el)) || null;
}

// ---------- Pick lists (SuccessFactors / SAP UI5) ----------

// Called from detectFields(): role="combobox" widgets that are not text
// inputs. Filled like Workday's list buttons (open, pick an option).
function jpAtsDetect(fields, claimed, index, nextLabelIndex) {
  if (jpAtsPlatform() !== "successfactors") return index;
  for (const el of jpQueryAll(JP_ATS_DROPDOWN_SELECTOR)) {
    if (!isVisible(el) || claimed.has(el) || jpAtsIgnore(el)) continue;
    claimed.add(el);
    for (const inner of el.querySelectorAll("input, button")) claimed.add(inner);
    const id = String(index++);
    el.setAttribute(FIELD_ATTR, id);
    const label = getLabelForElement(el);
    fieldRegistry[id] = { kind: "ats-dropdown", label, labelIndex: nextLabelIndex("ats-dropdown", label) };
    fields.push({ id, kind: "select", label, type: "select", options: undefined });
  }
  return index;
}

// Open each pick list once to read its options, so answers can match one.
async function jpAtsReadOptions(fields) {
  if (typeof jpWdOpenList !== "function") return;
  for (const field of fields) {
    if (fieldRegistry[field.id]?.kind !== "ats-dropdown") continue;
    const el = jpQueryOne(`[${FIELD_ATTR}="${CSS.escape(field.id)}"]`);
    if (!el) continue;
    const options = await jpWdOpenList(el);
    if (options.length) field.options = options.map((o) => o.textContent.trim()).filter((t) => t && !/^(select|choose|any)\b/i.test(t)).slice(0, 60);
    await jpWdClose(el);
  }
}

async function jpFillAtsDropdown(el, value) {
  return typeof jpFillWorkdayDropdown === "function" ? jpFillWorkdayDropdown(el, value) : false;
}
