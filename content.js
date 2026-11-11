// content.js — runs inside the job application page.
// Responsibilities:
//   1. DETECT_FIELDS  → scan the DOM for form fields + rich context, return them.
//   2. APPLY_ANSWERS  → write AI answers back into the matching fields.
//
// Handles: text/email/tel/url/number inputs, textareas, native <select>,
// radio-button groups, checkboxes, and custom react-select dropdowns
// (used by Greenhouse, Lever, Ashby, etc.).

var FIELD_ATTR = "data-jobpilot-id";
var GROUP_ATTR = "data-jobpilot-group";

// Registry mapping field id → metadata, so APPLY knows how to fill each one.
// Lives for the page's lifetime (same context as detection).
var fieldRegistry = {};
var fieldScanId = null;

// Global lock preventing two autofill operations (auto-run on page load, a
// manual floating-button click, or a side-panel "Fill This Form" request)
// from running concurrently in this frame. This matters because
// detectFields() WIPES and REASSIGNS field ids on every call — if a second
// run starts while the first is still in flight, its detectFields() call
// reassigns different ids to the same elements, so the first run's AI
// suggestions (built against the OLD ids) get applied to the WRONG fields
// when it finally resolves. Symptom seen in testing: answers meant for one
// field (e.g. a Yes/No question) landing in a completely different field
// (e.g. First Name) after two overlapping runs raced each other.
var jpAutofillInProgress = false;

var sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bail out early in frames that can't plausibly be a real application form —
// this matters a lot now that the content script runs in every iframe
// (all_frames: true, needed since some ATS load their form in an iframe).
// Without this guard, JobPilot would run its full detection/polling logic in
// every tiny/hidden ad, tracking, and widget iframe on every page, which can
// spike CPU/memory heavily across many open tabs. Skip frames that are too
// small to contain a real form.
//
// NOTE: we use a flag (checked at each side-effecting entry point below)
// rather than `throw`, because a top-level throw in a content script shows
// up as a real "Uncaught Error" in chrome://extensions' Errors page — and
// since this fires in EVERY small iframe on EVERY page, it would spam that
// page with errors even though this is expected, intentional behavior.
var JP_MIN_FRAME_SIZE = 200; // px — smaller than this can't hold a real form
var jpSkipFrame = false;
if (window !== window.top) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (w < JP_MIN_FRAME_SIZE || h < JP_MIN_FRAME_SIZE) {
    console.log(`[JobPilot] Skipping tiny iframe (${w}x${h}) — likely an ad/widget, not a form.`);
    jpSkipFrame = true;
  }
}

console.log(
  `[JobPilot] content script loaded — frame=${window === window.top ? "top" : "iframe"} url=${location.href}`
);

// ---------- Shadow DOM support ----------
// Many modern ATS platforms (notably Greenhouse's newer job-boards.greenhouse.io
// frontend) render their application form using Web Components with an OPEN
// shadow root. Plain document.querySelectorAll()/querySelector() cannot see
// inside shadow roots, which silently caused most fields to go undetected —
// only the handful of fields sitting in the "light" DOM (outside any shadow
// root) were ever found. These helpers walk the whole tree ONCE (iteratively,
// not recursively re-querying), recursing into open shadow roots, with a
// visited-set and a hard element cap so a pathological page can never cause
// runaway CPU/memory use.
var JP_MAX_SCAN_ELEMENTS = 15000; // safety cap for very large/complex pages

function jpQueryAll(selector, root = document) {
  const results = [];
  const stack = [root];
  const visitedRoots = new Set();
  let scanned = 0;

  while (stack.length) {
    const current = stack.pop();
    if (visitedRoots.has(current)) continue;
    visitedRoots.add(current);

    let matches, all;
    try {
      matches = current.querySelectorAll(selector);
      all = current.querySelectorAll("*");
    } catch {
      continue; // detached/invalid root
    }
    results.push(...matches);

    for (const el of all) {
      scanned++;
      if (scanned > JP_MAX_SCAN_ELEMENTS) return results; // bail out safely
      if (el.shadowRoot && !visitedRoots.has(el.shadowRoot)) stack.push(el.shadowRoot);
    }
  }
  return results;
}

function jpQueryOne(selector, root = document) {
  const direct = root.querySelector(selector);
  if (direct) return direct;

  const stack = [root];
  const visitedRoots = new Set([root]);
  let scanned = 0;

  while (stack.length) {
    const current = stack.pop();
    let all;
    try {
      all = current.querySelectorAll("*");
    } catch {
      continue;
    }
    for (const el of all) {
      scanned++;
      if (scanned > JP_MAX_SCAN_ELEMENTS) return null;
      if (el.shadowRoot && !visitedRoots.has(el.shadowRoot)) {
        const found = el.shadowRoot.querySelector(selector);
        if (found) return found;
        visitedRoots.add(el.shadowRoot);
        stack.push(el.shadowRoot);
      }
    }
  }
  return null;
}

// Resolve an id reference (e.g. from aria-labelledby) within the same
// root (document or shadow root) the element itself lives in, falling back
// to a full shadow-piercing search if not found there.
function jpResolveId(id, contextEl) {
  const root = contextEl.getRootNode();
  const local = root.getElementById ? root.getElementById(id) : null;
  if (local) return local;
  return jpQueryOne(`#${CSS.escape(id)}`);
}

function referencedLabel(el) {
  return (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
    .map(id => jpResolveId(id, el)?.textContent?.trim() || "").filter(Boolean).join(" ");
}

function ownLabelText(el) {
  if (el.labels?.length) return el.labels[0].textContent.trim();
  if (el.id) {
    const explicit = jpQueryOne(`label[for="${CSS.escape(el.id)}"]`, el.getRootNode());
    if (explicit) return explicit.textContent.trim();
  }
  return "";
}

function nearbyQuestion(el, members = [el]) {
  const own = new Set(members.map(ownLabelText).filter(Boolean));
  const isOwn = (label) =>
    members.some(m => label.contains(m) || (m.id && label.htmlFor === m.id)) ||
    own.has(label.textContent.trim());
  for (let node = el.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
    if (node.id) {
      const label = jpQueryOne(`label[for="${CSS.escape(node.id)}"]`, node.getRootNode());
      if (label && !isOwn(label)) return label.textContent.trim();
    }
    const label = Array.from(node.children).find(child =>
      child.matches("label, legend, .ashby-application-form-question-title") &&
      !isOwn(child) && !child.querySelector("input, select, textarea, button")
    );
    if (label?.textContent.trim()) return label.textContent.trim();
    // Design systems that label fields with an element id ending in "-label"
    // (e.g. Rippling: <span id="field-31-label">Phone number</span>).
    const labelled = Array.from(node.children)
      .map(child => child.matches("[id$='-label']") ? child : child.querySelector(":scope > [id$='-label']"))
      .find(child => child && !isOwn(child) && !child.querySelector("input, select, textarea, button") && child.textContent.trim());
    if (labelled) return labelled.textContent.trim();
    if (node.matches("form, body")) break;
  }
  return "";
}

// Question text for a set of radio/checkbox options. Prefers descriptive text
// inside the smallest container holding every option (e.g. an SMS-consent
// statement nested under a phone field), then the nearest question title.
function groupQuestion(members) {
  let container = members[0].parentElement;
  while (container && !members.every(m => container.contains(m))) container = container.parentElement;
  const optionTexts = members.map(m => ownLabelText(m) || getLabelForElement(m)).filter(Boolean);
  const onlyMembers = (node) =>
    Array.from(node.querySelectorAll("input, select, textarea")).every(c => members.includes(c));
  for (let node = container, depth = 0; node && depth < 4 && !node.matches("form, body") && onlyMembers(node); node = node.parentElement, depth++) {
    let text = node.innerText || "";
    for (const option of optionTexts) text = text.split(option).join(" ");
    text = text.replace(/\s+/g, " ").trim();
    if (text.length >= 8 && text.length <= 600) return text.slice(0, 200);
  }
  if (container && !container.matches("form, body")) {
    const question = nearbyQuestion(container, members);
    if (question) return question;
  }
  return getGroupLabel(members[0]);
}

// ---------- Visibility ----------

function isVisible(el) {
  if (el.disabled) return false;
  // Never treat JobPilot's own injected UI (the floating Autofill button,
  // its shadow-DOM contents, or the status toast) as a form field — the
  // shadow-DOM-piercing scanner would otherwise pick up our own button/close
  // button as if they were real fields on the page.
  const ownHost = el.getRootNode()?.host;
  if (ownHost?.id === JP_BTN_ID) return false;
  if (el.closest && el.closest(`#${JP_BTN_ID}, #jobpilot-toast`)) return false;

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    // react-select hides its input visually but it's still fillable; allow it.
    if (el.getAttribute("role") !== "combobox") return false;
  }
  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  return true;
}

// ---------- Label resolution ----------

var JP_GENERIC_LABEL = /^(search|search\.\.\.|select|select\.\.\.|select…|choose|choose one|textbox|text box|input|type here|type here\.\.\.|start typing\.\.\.|enter text|none)$/i;

function getLabelForElement(el) {
  if (el.id) {
    const explicit = jpQueryOne(`label[for="${CSS.escape(el.id)}"]`, el.getRootNode());
    if (explicit) return explicit.innerText.trim();
  }
  const parentLabel = el.closest("label");
  if (parentLabel) return parentLabel.innerText.trim();

  // Widgets often use a generic accessible name ("Search", "Select…"); the
  // real question is then in the surrounding field.
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria && !JP_GENERIC_LABEL.test(aria)) return aria;
  const referenced = referencedLabel(el);
  if (referenced && !JP_GENERIC_LABEL.test(referenced)) return referenced;
  const nearby = nearbyQuestion(el);
  if (nearby) {
    const part = el.tagName === "SELECT" ? el.options[0]?.textContent?.match(/^(month|year)\b/i)?.[1] : "";
    if (part) return `${nearby} (${part.toLowerCase()})`;
    // A dropdown inside a phone field picks the country calling code.
    if (isComboboxInput(el) && /phone|mobile/i.test(nearby)) return `${nearby} country code`;
    return nearby;
  }
  if (aria) return aria;
  if (el.placeholder) return el.placeholder.trim();

  const prev = el.previousElementSibling;
  if (prev && prev.innerText) return prev.innerText.trim().slice(0, 120);

  return el.name || el.id || "";
}

// The question text for a group of radios/checkboxes.
function getGroupLabel(el) {
  const fieldset = el.closest("fieldset");
  if (fieldset) {
    const legend = fieldset.querySelector("legend");
    if (legend && legend.innerText.trim()) return legend.innerText.trim();
  }
  const group = el.closest("[role='radiogroup'], [role='group']");
  if (group) {
    const label = referencedLabel(group);
    if (label) return label;
    if (group.getAttribute("aria-label")) return group.getAttribute("aria-label").trim();
  }
  const nearby = nearbyQuestion(el);
  if (nearby) return nearby;
  // Greenhouse wraps each question in a container; find a nearby label/heading.
  const container = el.closest("div");
  if (container) {
    const lbl = container.querySelector("label, legend, .label");
    if (lbl && lbl.innerText.trim()) return lbl.innerText.trim();
  }

  // Button-group toggles: the question is usually a label/heading in an
  // ancestor, appearing before the buttons. Walk up a few levels.
  let node = el.parentElement;
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    const heading = node.querySelector("label, legend, h1, h2, h3, h4, p, .label, [class*='label'], [class*='question']");
    if (heading && heading.innerText && heading.innerText.trim()) {
      const txt = heading.innerText.trim();
      // Skip if it's just the button text itself.
      if (txt.length > 3 && !/^(yes|no)$/i.test(txt)) return txt.slice(0, 200);
    }
  }

  return getLabelForElement(el);
}

function checkboxLabel(el) {
  const option = getLabelForElement(el);
  const question = nearbyQuestion(el);
  return question && question !== option ? `${question}: ${option}` : option;
}

// ---------- react-select detection ----------

function isComboboxInput(el) {
  // Date pickers often use role="combobox" with a dialog popup; they accept
  // typed dates, so treat them as text fields.
  return el.getAttribute("role") === "combobox" && el.getAttribute("aria-haspopup") !== "dialog";
}

function comboboxContainer(input) {
  return (
    input.closest(".select__control") ||
    input.closest("[class*='select__control']") ||
    input.closest("[class*='control']") ||
    input.parentElement
  );
}

// ---------- Job context scraping ----------

// Pull the job title, location, and company from the posting so the AI can
// estimate a market-rate salary and tailor open-ended answers.
function scrapeJobContext() {
  const pick = (selectors) => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim()) {
        return el.innerText.trim().slice(0, 200);
      }
    }
    return "";
  };

  const title = pick([
    "h1.app-title",
    ".job__title h1",
    "[class*='posting-headline'] h2",
    ".posting-headline h2",
    "h1",
  ]);

  const location = pick([
    ".location",
    "[class*='location']",
    ".job__location",
    "[class*='posting-categories'] .location",
    ".posting-categories .location",
  ]);

  const company = pick([
    "[class*='company-name']",
    ".company-name",
    "meta[property='og:site_name']",
  ]) || document.title.split(/[-|]/)[0].trim();

  const description = scrapeJobDescription();

  return {
    title,
    location,
    company,
    description,
    sourceHint: applicationSourceHint(),
    url: location ? location : window.location.hostname,
  };
}

// Where the user came from, for "How did you hear about us?" questions.
function applicationSourceHint() {
  const text = `${location.href} ${document.referrer}`.toLowerCase();
  const sources = [
    ["linkedin", "LinkedIn"], ["indeed", "Indeed"], ["glassdoor", "Glassdoor"],
    ["ziprecruiter", "ZipRecruiter"], ["handshake", "Handshake"], ["wellfound", "Wellfound"],
    ["builtin", "Built In"], ["dice.com", "Dice"],
  ];
  return sources.find(([needle]) => text.includes(needle))?.[1] || "";
}

// Grab the job description text so the AI can tailor answers to this role.
function scrapeJobDescription() {
  const candidates = [
    "[class*='job-description']",
    "[class*='jobDescription']",
    "[class*='posting-description']",
    "[class*='description']",
    "[data-testid*='description']",
    "#job-description",
    ".content .body",
    "article",
    "main",
  ];

  let best = "";
  for (const sel of candidates) {
    document.querySelectorAll(sel).forEach((el) => {
      const txt = (el.innerText || "").trim();
      if (txt.length > best.length) best = txt;
    });
    if (best.length > 400) break;
  }

  // Cap length to keep the prompt within token limits.
  return best.slice(0, 4000);
}

// ---------- Detection ----------

function detectFields() {
  fieldRegistry = {};
  fieldScanId = crypto.randomUUID();
  const fields = [];
  let index = 0;
  const claimed = new WeakSet(); // inputs already represented by a group/combobox

  // Tracks how many fields with the same (kind, label) we've already seen,
  // so a fallback re-lookup by label (used when a framework re-render wipes
  // our injected data-jobpilot-id attribute) can pick the correct Nth
  // occurrence — important since duplicate labels are common (e.g. two
  // "School"/"Degree" groups when a resume has 2 education entries).
  const labelOccurrence = new Map();
  const nextLabelIndex = (kind, label) => {
    const key = `${kind}|${(label || "").trim().toLowerCase()}`;
    const n = labelOccurrence.get(key) || 0;
    labelOccurrence.set(key, n + 1);
    return n;
  };

  // 1) Radio groups — one field per group (by name).
  const radioGroups = {};
  jpQueryAll("input[type='radio']").forEach((r) => {
    if (!isVisible(r)) return;
    const key = r.name || getGroupLabel(r) || r.id;
    (radioGroups[key] ||= []).push(r);
  });
  for (const radios of Object.values(radioGroups)) {
    const id = String(index++);
    radios.forEach((r) => {
      r.setAttribute(GROUP_ATTR, id);
      claimed.add(r);
    });
    const options = radios.map((r) => getLabelForElement(r)).filter(Boolean);
    const groupLabel = groupQuestion(radios);
    fieldRegistry[id] = { kind: "radio", label: groupLabel, name: radios[0].name, labelIndex: nextLabelIndex("radio", groupLabel) };
    fields.push({
      id,
      kind: "radio",
      label: groupLabel,
      type: "radio",
      options,
    });
  }

  // 2) Checkboxes — individual yes/no toggles.
  jpQueryAll("input[type='checkbox']").forEach((c) => {
    if (!isVisible(c) || claimed.has(c)) return;
    const id = String(index++);
    c.setAttribute(FIELD_ATTR, id);
    const label = checkboxLabel(c);
    fieldRegistry[id] = { kind: "checkbox", label, labelIndex: nextLabelIndex("checkbox", label) };
    fields.push({
      id,
      kind: "checkbox",
      label,
      type: "checkbox",
      options: ["checked", "unchecked"],
    });
  });

  // 3) react-select comboboxes.
  jpQueryAll("input[role='combobox']").forEach((cb) => {
    if (!isVisible(cb) || claimed.has(cb) || !isComboboxInput(cb)) return;
    claimed.add(cb);
    const id = String(index++);
    cb.setAttribute(FIELD_ATTR, id);
    const label = getLabelForElement(cb);
    fieldRegistry[id] = { kind: "combobox", label, labelIndex: nextLabelIndex("combobox", label) };
    fields.push({
      id,
      kind: "combobox",
      label,
      type: "select",
      options: undefined, // options only render when open
    });
  });

  // 4) Native selects.
  jpQueryAll("select").forEach((sel) => {
    if (!isVisible(sel) || claimed.has(sel)) return;
    const id = String(index++);
    sel.setAttribute(FIELD_ATTR, id);
    const label = getLabelForElement(sel);
    fieldRegistry[id] = { kind: "select", label, labelIndex: nextLabelIndex("select", label) };
    fields.push({
      id,
      kind: "select",
      label,
      type: "select",
      options: Array.from(sel.options).map((o) => o.textContent.trim()).filter(Boolean),
    });
  });

  // 5) Button-group toggles (Yes/No rendered as <button> or role="button").
  //    Common on Ashby/Lever/custom forms. We group sibling buttons that share
  //    a container and have short option-like labels.
  const buttonCandidates = Array.from(
    jpQueryAll("button, [role='button'], [role='radio'] , a[role='button']")
  ).filter((b) => {
    if (!isVisible(b) || claimed.has(b)) return false;
    // NOTE: a <button> with no type attribute defaults to type="submit" via the
    // DOM property, so we must check the ATTRIBUTE, not the property.
    const typeAttr = (b.getAttribute("type") || "").toLowerCase();
    if (typeAttr === "submit" || typeAttr === "reset") return false;
    const txt = (b.innerText || b.textContent || "").trim();
    // Only short, option-like labels (avoid real action buttons).
    return (
      txt.length > 0 &&
      txt.length <= 24 &&
      (b.tagName !== "BUTTON" || b.type !== "submit") &&
      !/^(submit|apply|next|back|attach|upload|browse|continue|save|add|remove|cancel|close)$/i.test(txt)
    );
  });

  // Group by nearest shared container that has 2–5 such buttons.
  const groupsSeen = new Set();
  buttonCandidates.forEach((btn) => {
    if (claimed.has(btn)) return;
    const container =
      btn.closest("fieldset, [role='radiogroup'], [role='group']") ||
      btn.parentElement;
    if (!container || groupsSeen.has(container)) return;

    const groupButtons = buttonCandidates.filter(
      (b) => !claimed.has(b) && (
        b.closest("fieldset, [role='radiogroup'], [role='group']") === container ||
        b.parentElement === container
      )
    );
    if (groupButtons.length < 2 || groupButtons.length > 6) return;

    groupsSeen.add(container);
    const id = String(index++);
    groupButtons.forEach((b) => {
      b.setAttribute(GROUP_ATTR, id);
      claimed.add(b);
    });
    const options = groupButtons
      .map((b) => (b.innerText || b.textContent || "").trim())
      .filter(Boolean);

    const groupLabel = getGroupLabel(groupButtons[0]);
    fieldRegistry[id] = {
      kind: "buttongroup",
      label: groupLabel,
      labelIndex: nextLabelIndex("buttongroup", groupLabel),
    };
    fields.push({
      id,
      kind: "radio",
      label: groupLabel,
      type: "buttongroup",
      options,
    });
  });

  // 6) Text-like inputs and textareas.
  //    NOTE: some ATS (e.g. Phenom) use type="Text" with a capital T. CSS
  //    attribute selectors are case-sensitive, so we select ALL inputs and
  //    filter by the DOM `type` property (which normalizes to lowercase).
  const TEXT_TYPES = new Set([
    "text",
    "email",
    "tel",
    "url",
    "number",
    "search",
    "",
  ]);
  const NON_TEXT = new Set([
    "radio",
    "checkbox",
    "file",
    "hidden",
    "submit",
    "button",
    "reset",
    "image",
    "range",
    "color",
  ]);

  const textLike = jpQueryAll("input, textarea");
  textLike.forEach((el) => {
    if (!isVisible(el) || claimed.has(el)) return;
    if (isComboboxInput(el)) return;

    if (el.tagName === "INPUT") {
      const t = (el.getAttribute("type") || el.type || "text").toLowerCase();
      if (NON_TEXT.has(t)) return;
      if (!TEXT_TYPES.has(t) && t !== "date") return; // allow date text inputs too
    }

    // Skip phantom helper inputs that sit underneath custom dropdown widgets
    // (seen on Greenhouse: readonly/typeahead <input>s whose only "label" is
    // literally their own "Select..." placeholder text, duplicating a real
    // <select>/combobox we already detected separately). These add noise to
    // what's sent to the AI without representing an actual answerable field.
    const rawLabel = getLabelForElement(el).trim();
    if (/^select\.{0,3}$/i.test(rawLabel)) return;
    if (el.readOnly && !rawLabel) return;

    const id = String(index++);
    el.setAttribute(FIELD_ATTR, id);
    const label = rawLabel;
    fieldRegistry[id] = { kind: "text", label, labelIndex: nextLabelIndex("text", label) };
    fields.push({
      id,
      kind: "text",
      label,
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute("type") || el.type || "text").toLowerCase(),
      placeholder: el.placeholder || "",
    });
  });

  // Repeated questions (e.g. two "School" fields) are numbered so remembered
  // answers map to the same position on other forms.
  fields.forEach((f) => { f.occurrence = fieldRegistry[f.id]?.labelIndex ?? 0; });
  jpFieldsById = new Map(fields.map((f) => [String(f.id), f]));
  jpSeenInputs = new WeakSet(jpQueryAll("input, textarea, select"));
  jpStepOffered = false;
  return fields;
}

// ---------- Value setting helpers ----------

function setNativeValue(el, value) {
  const proto =
    el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : el.tagName === "SELECT"
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function fireEvents(el) {
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

// ---------- Per-type fill logic ----------

// Decode HTML entities like &amp; &lt; &#39; into their real characters.
function decodeEntities(str) {
  if (!str || str.indexOf("&") === -1) return str;
  const ta = document.createElement("textarea");
  ta.innerHTML = str;
  return ta.value;
}

function fillText(el, value) {
  // preventScroll: without this, focusing each field (there can be 20-30+ in
  // a long form) makes the browser auto-scroll the page to that field, one
  // after another in rapid succession — producing a jarring "page jumping
  // up and down" effect while filling. We don't need the field visually
  // scrolled into view to set its value programmatically.
  el.focus({ preventScroll: true });
  setNativeValue(el, value);
  fireEvents(el);
  return el.value === value;
}

function jpIsPhoneField(el, label) {
  return el.type === "tel" || el.inputMode === "tel" ||
    /phone|mobile|cell/i.test(`${label || ""} ${el.placeholder || ""} ${el.name || ""} ${el.id || ""}`);
}

var jpDigits = (text) => String(text || "").replace(/\D/g, "");

// The page kept the number if its digits are the same national number.
function jpPhoneAccepted(shown, wanted) {
  const a = jpDigits(shown);
  const b = jpDigits(wanted);
  return a.length >= 7 && (b.endsWith(a) || a.endsWith(b.slice(-10)));
}

// "+1 (425) 310-5258" → "(425) 310-5258" (drops a leading +country code).
function jpNationalNumber(value) {
  const text = String(value || "").trim();
  const stripped = text.replace(/^\+\d{1,3}[\s.-]*/, "");
  return stripped === text && jpDigits(text).length === 11 && jpDigits(text)[0] === "1"
    ? jpDigits(text).slice(1)
    : stripped;
}

// Groups of interchangeable phrasings so short AI answers like "N/A" or
// "None" match verbose dropdown option text like "Not applicable/Do not
// recall" or "No active clearance" — exact/substring matching alone missed
// most of these (only 6 of 27 suggestions applied in testing, almost all
// failures were on <select> fields with mismatched wording).
var SYNONYM_GROUPS = [
  ["n/a", "na", "not applicable", "not applicable/do not recall", "none", "no", "not applicable / do not recall"],
  ["decline", "decline to answer", "decline to self-identify", "prefer not to say", "prefer not to answer", "i do not wish to answer"],
  ["yes", "y"],
  ["not sure", "unsure", "i don't know", "unknown"],
];

function normalizeForMatch(text) {
  return text
    .toLowerCase()
    .replace(/[.,()]/g, "")
    .trim();
}

function synonymGroupOf(text) {
  const t = normalizeForMatch(text);
  return SYNONYM_GROUPS.find(group => group.includes(t));
}

// Word-overlap fuzzy score: fraction of the shorter string's significant
// words that also appear in the longer string.
function wordOverlapScore(a, b) {
  const wordsOf = (s) =>
    normalizeForMatch(s)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2);
  const wa = wordsOf(a);
  const wb = wordsOf(b);
  if (!wa.length || !wb.length) return 0;
  const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  const longerSet = new Set(longer);
  const overlap = shorter.filter((w) => longerSet.has(w)).length;
  return overlap / shorter.length;
}

function fillNativeSelect(el, value) {
  const target = value.trim().toLowerCase();
  const options = Array.from(el.options).filter(option => !option.disabled && option.value !== "");

  // 1) Exact match on text or value.
  let match = options.find(
    (o) => o.textContent.trim().toLowerCase() === target || o.value.trim().toLowerCase() === target
  );

  // 2) Substring match, either direction (short AI answer inside long option
  //    text, or vice versa).
  if (!match) {
    match = options.find((o) => {
      const opt = o.textContent.trim().toLowerCase();
      return target.length > 3 && opt.length > 3 && (opt.includes(target) || target.includes(opt));
    });
  }

  // 3) Synonym-group match (e.g. "N/A" ↔ "Not applicable/Do not recall").
  if (!match) {
    const targetGroup = synonymGroupOf(target);
    if (targetGroup) {
      match = options.find((o) => synonymGroupOf(o.textContent) === targetGroup);
    }
  }

  // 4) Fuzzy word-overlap match as a last resort (skip the blank/"Select..."
  //    placeholder option).
  if (!match) {
    let best = null;
    let bestScore = 0;
    for (const o of options) {
      const text = o.textContent.trim();
      if (!text || /^select/i.test(text)) continue;
      const score = wordOverlapScore(target, text);
      if (score > bestScore) {
        best = o;
        bestScore = score;
      }
    }
    if (bestScore >= 0.5) match = best;
  }

  if (match) {
    setNativeValue(el, match.value);
    fireEvents(el);
    return el.value === match.value;
  }
  return false;
}

function fillRadio(groupId, value) {
  let radios = jpQueryAll(`[${GROUP_ATTR}="${CSS.escape(groupId)}"]`);
  if (!radios.length) {
    radios = jpQueryAll("input[type='radio']").filter(el =>
      isVisible(el) && fieldRegistry[groupId]?.name && el.name === fieldRegistry[groupId].name
    );
  }
  const target = value.trim().toLowerCase();
  let match = radios.find((r) => getLabelForElement(r).trim().toLowerCase() === target);
  if (!match) match = radios.find((r) => getLabelForElement(r).trim().toLowerCase().includes(target));
  if (!match && (target === "yes" || target === "no")) {
    match = radios.find((r) => getLabelForElement(r).trim().toLowerCase().startsWith(target));
  }
  if (match) {
    match.click();
    fireEvents(match);
    return match.checked;
  }
  return false;
}

function fillCheckbox(el, value) {
  if (!/^(yes|no|true|false|checked|unchecked|on|off|1|0)$/i.test(value.trim())) return false;
  const wantChecked = /^(yes|true|checked|on|1)$/i.test(value.trim());
  if (el.checked !== wantChecked) el.click();
  return el.checked === wantChecked;
}
function fillButtonGroup(groupId, value) {
  const buttons = jpQueryAll(`[${GROUP_ATTR}="${CSS.escape(groupId)}"]`);
  const target = value.trim().toLowerCase();
  const textOf = (b) => (b.innerText || b.textContent || "").trim().toLowerCase();

  let match = buttons.find((b) => textOf(b) === target);
  if (!match) match = buttons.find((b) => textOf(b).includes(target));
  if (!match && (target === "yes" || target === "no")) {
    match = buttons.find((b) => textOf(b).startsWith(target));
  }
  if (match) {
    match.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    match.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    match.click();
    return true;
  }
  return false;
}
// Option text in autocomplete popups often concatenates several spans
// (Ashby: name + country + domain). The first span is the display name.
function optionName(option) {
  const first = option.querySelector("span");
  return (first?.textContent || option.textContent || "").trim();
}

function matchScore(target, candidate) {
  const words = (s) => normalizeForMatch(s).split(/[^a-z0-9]+/).filter(w => w.length > 2);
  const t = normalizeForMatch(target);
  const c = normalizeForMatch(candidate);
  if (!c) return 0;
  if (c === t) return 2;
  if (t.length >= 4 && c.startsWith(t)) return 1.5; // "Seattle, Washington" → "Seattle, Washington, United States"
  const tw = words(target);
  const cw = new Set(words(candidate));
  if (!tw.length || !cw.size) return 0;
  const shared = tw.filter(w => cw.has(w)).length;
  const coverTarget = shared / tw.length;
  const coverCandidate = shared / cw.size;
  if (coverTarget < 0.6 || coverCandidate < 0.6) return 0;
  return (coverTarget + coverCandidate) / 2;
}

// Search strategies for typeahead fields: full value, then without
// parentheses/qualifiers, then the parenthetical (often an acronym).
function typeaheadQueries(value) {
  const v = value.trim();
  const noParen = v.replace(/\s*\([^)]*\)/g, "").trim();
  const paren = (v.match(/\(([^)]+)\)/) || [])[1]?.trim();
  const beforeComma = noParen.split(",")[0].trim();
  return [...new Set([v, noParen, beforeComma, paren].filter(q => q && q.length >= 2))];
}

async function fillCombobox(input, value) {
  const control = comboboxContainer(input);
  input.focus({ preventScroll: true }); // see note in fillText() — avoid page-jumping scroll
  if (control) control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  input.click();
  await sleep(150);

  for (const query of typeaheadQueries(value)) {
    setNativeValue(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(100);
    setNativeValue(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(400); // let remote search results replace any stale list

    for (let attempt = 0; attempt < 30; attempt++) {
      const controlled = input.getAttribute("aria-controls");
      const list = controlled ? jpResolveId(controlled, input) : null;
      const options = jpQueryAll("[role='option'], [class*='select__option'], [class*='option']", list || document)
        .filter(option => isVisible(option) && option.textContent.trim() && option.getAttribute("aria-disabled") !== "true");
      let best = null;
      let bestScore = 0;
      for (const option of options) {
        const score = Math.max(matchScore(value, optionName(option)), matchScore(query, optionName(option)));
        if (score > bestScore) { best = option; bestScore = score; }
      }
      if (best) {
        const chosen = normalizeForMatch(optionName(best)).slice(0, 12);
        best.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        best.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        best.click();
        // Frameworks commit the selection asynchronously; wait for it to show.
        for (let wait = 0; wait < 15; wait++) {
          await sleep(100);
          if (normalizeForMatch(`${input.value} ${control?.textContent || ""}`).includes(chosen)) return true;
        }
        return false;
      }
      if (options.length && attempt >= 10) break; // results loaded but none match this query
      await sleep(100);
    }
  }

  setNativeValue(input, "");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
  return false;
}

// ---------- Apply orchestration ----------

// Re-find an element for a field whose injected data-jobpilot-id attribute is
// no longer present in the DOM. This happens on React/web-component-based
// forms (seen on Greenhouse's newer frontend) where filling one field can
// trigger a re-render that recreates OTHER form elements too — silently
// wiping the attributes we added during detection. We fall back to
// re-querying the live DOM for an element of the same kind whose CURRENT
// label matches what we saw during detection, using the recorded
// occurrence-index to disambiguate duplicate labels (e.g. two "School"
// fields when a resume has 2 education entries).
function jpElementsForKind(kind) {
  switch (kind) {
    case "select":
      return jpQueryAll("select");
    case "combobox":
      return jpQueryAll("input[role='combobox']").filter(isComboboxInput);
    case "checkbox":
      return jpQueryAll("input[type='checkbox']");
    case "text":
      return jpQueryAll("input, textarea").filter((el) => !isComboboxInput(el));
    default:
      return [];
  }
}

function jpFindByLabelFallback(meta) {
  if (!meta?.label) return null;
  const wantLabel = meta.label.trim().toLowerCase();
  if (!wantLabel) return null;

  const candidates = jpElementsForKind(meta.kind).filter(isVisible);
  const matches = candidates.filter(
    (el) => (meta.kind === "checkbox" ? checkboxLabel(el) : getLabelForElement(el)).trim().toLowerCase() === wantLabel
  );
  if (matches.length === 0) return null;
  return matches[meta.labelIndex] ?? null;
}

// Look up a tagged field element, falling back to a label-based re-lookup
// (and re-tagging it) if the original attribute is gone.
function jpResolveField(id, meta) {
  let el = jpQueryOne(`[${FIELD_ATTR}="${CSS.escape(id)}"]`);
  if (el) return el;

  el = jpFindByLabelFallback(meta);
  if (el) {
    el.setAttribute(FIELD_ATTR, id); // re-tag so future lookups are direct
    console.log(`[JobPilot] Re-located "${meta.label}" via label fallback (attribute was lost).`);
  }
  return el;
}

async function applyAnswers(suggestions) {
  // If the registry is empty, the page was reloaded/navigated since detection,
  // so our field markers are gone. Signal the panel to re-run detection.
  const registryEmpty = Object.keys(fieldRegistry).length === 0;
  if (registryEmpty) {
    console.warn("[JobPilot] Apply called but no tagged fields — page likely reloaded.");
    return { filled: 0, stale: true };
  }

  let filled = 0;
  const failed = [];

  // Instant fields first; searchable dropdowns wait on network results.
  const ordered = [...suggestions].sort((a, b) =>
    (fieldRegistry[String(a?.id)]?.kind === "combobox") - (fieldRegistry[String(b?.id)]?.kind === "combobox"));
  for (const s of ordered) {
    if (s?.value == null || s.value === "") continue;
    const id = String(s.id);
    const meta = fieldRegistry[id];
    const label = meta?.label || s.label || `Field ${id}`;

    try {
      if (!meta) throw new Error("The answer does not match a detected field.");
      if (!["string", "number", "boolean"].includes(typeof s.value)) {
        throw new Error("The AI returned an unsupported answer type.");
      }
      const value = decodeEntities(typeof s.value === "boolean" ? (s.value ? "Yes" : "No") : String(s.value));
      let ok = false;
      let markEl = null;
      if (meta.kind === "radio") {
        const group = jpQueryAll(`[${GROUP_ATTR}="${CSS.escape(id)}"]`);
        jpSnapshot("radio", null, group);
        ok = fillRadio(id, value);
        markEl = group.find((r) => r.checked) || group[0];
      } else if (meta.kind === "buttongroup") {
        ok = fillButtonGroup(id, value);
        markEl = jpQueryOne(`[${GROUP_ATTR}="${CSS.escape(id)}"]`)?.parentElement;
      } else {
        const el = jpResolveField(id, meta);
        if (!el) throw new Error("The field was removed or changed.");
        jpSnapshot(meta.kind === "checkbox" ? "checkbox" : "value", el);
        markEl = el;
        if (meta.kind === "combobox") ok = await fillCombobox(el, value);
        else if (meta.kind === "checkbox") ok = fillCheckbox(el, value);
        else if (el.tagName === "SELECT") ok = fillNativeSelect(el, value);
        else {
          ok = fillText(el, value);
          await sleep(30);
          markEl = jpResolveField(id, meta) || el;
          if (markEl.value !== value && jpIsPhoneField(markEl, label)) {
            // Phone inputs often reformat the number, or take only the
            // national number when the country code is a separate control.
            if (!jpPhoneAccepted(markEl.value, value)) {
              fillText(markEl, jpNationalNumber(value));
              await sleep(30);
            }
            ok = jpPhoneAccepted(markEl.value, value);
          } else {
            ok = ok && markEl.value === value;
          }
        }
      }
      if (!ok) throw new Error("The page did not accept the answer or no matching option was found.");
      filled++;
      const source = s.source || "ai";
      jpFillRecords.set(id, { source, label, el: markEl, value, kind: meta.kind });
      jpMark(markEl, source);
    } catch (err) {
      failed.push({ id, label, reason: err.message });
      const el = meta && meta.kind !== "radio" && meta.kind !== "buttongroup" ? jpResolveField(id, meta) : null;
      if (el) jpMark(el, "needs");
      console.warn(`[JobPilot] Could not fill "${label}": ${err.message}`);
    }
    // Brief pause between fields so a re-render triggered by this fill
    // (common on React-based forms) settles before we look up the next
    // field — reduces (but doesn't eliminate, hence the fallback above)
    // the chance of hitting a mid-re-render DOM state.
    await sleep(20);
  }

  return { filled, stale: false, failed };
}

// ---------- Repeatable sections ----------

// Click "Add Experience / Add Education / Add Employment" style buttons to
// reveal their hidden sub-forms so we can fill them.
// `counts` = { experience: N, education: M } tells us how many rows to create.
// `parsedEntries` (optional) = { experience: [...], education: [...] } — used
// as a fallback for ATS platforms (Oracle Cloud/Taleo, seen on Uber's career
// site) where "Add Experience"/"Add Education" opens a separate MODAL DIALOG
// with its own mini-form, rather than revealing inline rows on the main page
// like Greenhouse does. In that case we fill the modal directly from the
// corresponding parsed resume entry and click its own Save button, since
// those modal fields never appear in the page-level detectFields() scan once
// the modal is committed/closed (it collapses into a summary card instead).
// Returns the number of new field-groups revealed/committed.
async function expandRepeatableSections(counts = {}, parsedEntries = null) {
  // Broadened: many ATS platforms (Greenhouse notably) use a GENERIC
  // "Add another" link with no category word in its own text — so we can't
  // rely on the button's own text alone to decide if it's an "Add" button.
  const ADD_PATTERN =
    /\b(add)\b.*\b(another|more|experience|education|employment|work|position|job|school|degree|history|certification|license|competenc|skill)\b|\+\s*add|add\s*\+/i;

  // Which category does an "Add" button belong to? First try the button's
  // own text (fast path); if that's generic ("Add another"), fall back to
  // scanning nearest preceding heading-like text in the DOM (walking up
  // ancestors and their preceding siblings, closest first) — this correctly
  // distinguishes an "Add another" link under an "Education" section from
  // one under "Experience", even though the link text itself is identical.
  const categorizeText = (txt) => {
    const t = txt.toLowerCase();
    if (/education|school|degree|university|college/.test(t)) return "education";
    if (/experience|employment|work|position|job|history|company/.test(t)) return "experience";
    return "other";
  };

  const categorizeByPosition = (el) => {
    let node = el;
    for (let depth = 0; depth < 8 && node; depth++) {
      let sib = node.previousElementSibling;
      while (sib) {
        const txt = (sib.innerText || sib.textContent || "").trim();
        if (txt && txt.length < 80) {
          const cat = categorizeText(txt);
          if (cat !== "other") return cat;
        }
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "other";
  };

  const categorize = (btn) => {
    const ownText = (btn.innerText || btn.textContent || btn.getAttribute("aria-label") || "").trim();
    const byText = categorizeText(ownText);
    return byText !== "other" ? byText : categorizeByPosition(btn);
  };

  // Robustly "click" an element the way a real user would, so React/custom
  // handlers (which often ignore a bare .click()) actually fire.
  const robustClick = (el) => {
    const opts = { bubbles: true, cancelable: true, view: window };
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
    } catch {}
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    try {
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    } catch {}
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    if (typeof el.click === "function") {
      try {
        el.click();
      } catch {}
    }
  };

  // ---- Modal-dialog fallback (Oracle Cloud/Taleo-style ATS: Uber's career
  // site is a real-world example) ----
  //
  // Find the currently-open modal/dialog on the page, if any. Tries known
  // ARIA/CSS patterns first (fast path), including Oracle JET's own dialog
  // classes (Oracle Cloud/Taleo career sites, e.g. Uber's, are built on
  // Oracle JET). Falls back to a generic "diff the DOM" approach: compare a
  // snapshot of top-level containers taken BEFORE the Add button was clicked
  // against AFTER, and treat whichever new, visible, field-containing element
  // appeared as the modal — this works regardless of the site's specific
  // class names or whether it technically uses role="dialog" at all.
  const findOpenModal = (beforeSnapshot) => {
    const known = jpQueryAll(
      "[role='dialog'], [aria-modal='true'], .modal, [class*='Modal' i], [class*='dialog' i], .oj-dialog, .oj-popup, [class*='oj-dialog' i], [class*='oj-popup' i], [class*='panel' i], [class*='drawer' i], [class*='flyout' i], [class*='slide' i]"
    ).filter((el) => isVisible(el) && el.querySelectorAll("input, textarea, select").length > 0);
    if (known.length > 0) {
      return known.reduce((best, el) => {
        const z = parseInt(window.getComputedStyle(el).zIndex, 10) || 0;
        const bestZ = best ? parseInt(window.getComputedStyle(best).zIndex, 10) || 0 : -1;
        return z >= bestZ ? el : best;
      }, null);
    }

    // Generic fallback: any visible element (not previously present) that
    // contains at least 2 form fields is our best guess at "the new modal".
    if (!beforeSnapshot) return null;
    const candidates = jpQueryAll("div, section, aside, form").filter(
      (el) =>
        !beforeSnapshot.has(el) &&
        isVisible(el) &&
        el.querySelectorAll("input, textarea, select").length >= 2
    );
    if (candidates.length === 0) return null;
    // Prefer the smallest matching container (most likely the actual dialog
    // body, not some large wrapping section that happens to contain it).
    return candidates.reduce((best, el) => {
      const size = el.querySelectorAll("input, textarea, select").length;
      const bestSize = best ? best.querySelectorAll("input, textarea, select").length : Infinity;
      return size < bestSize ? el : best;
    }, null);
  };

  // Snapshot every element currently in the DOM, so a later call to
  // findOpenModal() can tell which elements are NEW (likely the just-opened
  // modal/panel) versus pre-existing page content.
  const snapshotElements = () => new Set(jpQueryAll("*"));

  // Guess which field of a parsed resume entry a modal input corresponds to,
  // purely from its (visible) label text — these modal forms are never seen
  // by the main detectFields()/AI pass, so we map them directly ourselves.
  const guessEntryField = (label, cat) => {
    const t = (label || "").toLowerCase();
    if (cat === "experience") {
      if (/title|position|role/.test(t)) return "position";
      if (/compan(y|ies)|employer|organi[sz]ation/.test(t)) return "organization";
      if (/start/.test(t)) return "startDate";
      if (/end|until/.test(t)) return "endDate";
      if (/description|responsibilit|detail|summary/.test(t)) return "description";
    } else if (cat === "education") {
      if (/school|institution|university|college/.test(t)) return "institution";
      if (/degree/.test(t)) return "degree";
      if (/discipline|major|field of study/.test(t)) return "major";
      if (/graduat/.test(t)) return "graduationDate";
      if (/start/.test(t)) return "startDate";
    }
    return null;
  };

  // Fill a modal's own fields directly from one parsed resume entry, then
  // return how many fields were actually set (used to judge success).
  const fillModalFromEntry = async (modal, entry, cat) => {
    if (!entry) return 0;
    let filledCount = 0;
    const inputs = Array.from(modal.querySelectorAll("input, textarea, select")).filter(
      (el) => isVisible(el) && !el.disabled
    );
    for (const el of inputs) {
      const label = getLabelForElement(el);
      const key = guessEntryField(label, cat);
      const value = key ? entry[key] : null;
      if (!value) continue;
      try {
        if (el.tagName === "SELECT") {
          if (fillNativeSelect(el, String(value))) filledCount++;
        } else if (el.getAttribute("role") === "combobox") {
          if (await fillCombobox(el, String(value))) filledCount++;
        } else {
          fillText(el, String(value));
          filledCount++;
        }
      } catch {
        /* skip fields that fail to fill; best-effort */
      }
      await sleep(60);
    }
    return filledCount;
  };

  // Find the modal's own Save/Add/Done/Confirm button (distinct from the
  // page-level "Add Experience" button that opened the modal).
  const findModalSaveButton = (modal) =>
    Array.from(modal.querySelectorAll("button, [role='button'], a")).find((el) => {
      if (!isVisible(el)) return false;
      const txt = (el.innerText || el.textContent || "").trim();
      return /^(save|add|done|confirm|apply|ok)\b/i.test(txt);
    }) || null;

  const findAddButtons = () =>
    [
      ...new Set(
        Array.from(
          jpQueryAll(
            "a, button, [role='button'], [role='link'], [class*='add' i], [class*='Add']"
          )
        ).filter((el) => {
          if (!isVisible(el)) return false;
          const txt = (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim();
          // Must be short, clickable-looking, and match the Add pattern.
          if (txt.length === 0 || txt.length > 60) return false;
          if (!ADD_PATTERN.test(txt)) return false;
          // Avoid matching big containers that wrap real fields.
          if (el.querySelectorAll("input, textarea, select").length > 0) return false;
          // Prefer the outermost clickable: skip if an ancestor also matches.
          const ancestor = el.parentElement?.closest(
            "a, button, [role='button'], [role='link']"
          );
          if (ancestor && ADD_PATTERN.test((ancestor.innerText || "").trim())) return false;
          return true;
        })
      ),
    ];

  const allFound = findAddButtons();
  console.log(
    "[JobPilot] Add-buttons found:",
    allFound.map((b) => ({
      text: (b.innerText || b.textContent || "").trim(),
      category: categorize(b),
    }))
  );

  // Count how many entry-rows already exist for each category, so we only add
  // the DIFFERENCE (many ATS pre-populate 1-2 empty rows).
  const countExistingGroups = () => {
    const labels = jpQueryAll("label").map((l) =>
      (l.innerText || "").trim().toLowerCase()
    );
    return {
      // Experience rows are identified by a "Position"/"Job Title" label (one per row).
      experience: labels.filter((t) => /^(position|job title|title)\b/.test(t)).length,
      // Education rows by a "School"/"Institution"/"University" label (one per row).
      // Different ATS platforms use different wording (Greenhouse uses "School").
      education: labels.filter((t) => /^(school|institution|university|college)\b/.test(t)).length,
    };
  };

  let expanded = 0;
  // Tracks how many entries we've committed via the MODAL fallback per
  // category, since those never show up in countExistingGroups() (they
  // collapse into a summary card on the page, not labeled input rows).
  const modalCommitted = { experience: 0, education: 0 };

  const wantedTotal = {
    experience: Math.max(1, counts.experience ?? 1),
    education: Math.max(1, counts.education ?? 1),
    other: 0,
  };
  console.log(
    `[JobPilot] Expansion targets → experience: ${wantedTotal.experience}, education: ${wantedTotal.education}`,
    "(received counts:", counts, ")"
  );

  // Add rows per category until the number of existing rows reaches the target.
  const CATEGORIES = ["experience", "education"];
  for (const cat of CATEGORIES) {
    let guard = 0;
    while (guard < 20) {
      guard++;
      const existing = (countExistingGroups()[cat] || 0) + modalCommitted[cat];
      if (existing >= wantedTotal[cat]) break;

      // Find this category's Add button.
      const buttons = findAddButtons();
      const btn = buttons.find((b) => categorize(b) === cat);
      if (!btn) {
        console.log(`[JobPilot] No "Add" button for ${cat}; stopping (existing=${existing}).`);
        break;
      }

      const beforeRows = existing;
      btn.scrollIntoView({ block: "center" });
      await sleep(150);
      const beforeSnapshot = snapshotElements(); // for the generic modal-diff fallback

      // Click, then poll for a new row. Retry the click a few times if the
      // (sometimes slow) ATS hasn't rendered the row yet.
      let added = false;
      for (let attempt = 0; attempt < 3 && !added; attempt++) {
        robustClick(btn);
        for (let wait = 0; wait < 8; wait++) {
          await sleep(300);
          if ((countExistingGroups()[cat] || 0) > beforeRows) {
            added = true;
            break;
          }
        }
        if (!added) console.log(`[JobPilot] Retry ${attempt + 1} for "Add ${cat}"…`);
      }

      const nowRows = countExistingGroups()[cat] || 0;
      console.log(
        `[JobPilot] Add ${cat}: rows ${beforeRows} → ${nowRows} (target ${wantedTotal[cat]})`
      );
      if (added) {
        expanded++;
      } else {
        // Fallback: some ATS (Oracle Cloud/Taleo — e.g. Uber's career site)
        // open a MODAL DIALOG with its own mini-form instead of revealing
        // inline rows on the main page. Detect and fill it directly from the
        // corresponding parsed resume entry, then click the modal's own save
        // button, before giving up on this category entirely.
        const modal = findOpenModal(beforeSnapshot);
        const entryList = parsedEntries?.[cat] || [];
        const entryIndex = modalCommitted[cat];
        const entry = entryList[entryIndex];
        if (modal && entry) {
          console.log(
            `[JobPilot] "${cat}" Add button opened a modal dialog — filling entry #${entryIndex + 1} directly:`,
            entry
          );
          const filledInModal = await fillModalFromEntry(modal, entry, cat);
          const saveBtn = findModalSaveButton(modal);
          if (saveBtn) {
            robustClick(saveBtn);
            await sleep(700);
          }
          console.log(
            `[JobPilot] Modal fill for "${cat}" entry #${entryIndex + 1}: ${filledInModal} field(s) set, saveButton=${Boolean(saveBtn)}`
          );
          if (filledInModal > 0) {
            modalCommitted[cat] = entryIndex + 1;
            expanded++;
            continue; // re-check target on the next loop iteration
          }
        } else if (modal && !entry) {
          console.log(
            `[JobPilot] "${cat}" modal opened but no more parsed entries to fill it with (have ${entryList.length}).`
          );
        } else {
          // Diagnostic: nothing matched at all — log what candidates DID
          // exist so we can see why (e.g. new elements appeared but had <2
          // fields, or nothing new appeared, meaning the click may have
          // navigated away or done nothing).
          const newVisible = jpQueryAll("div, section, aside, form").filter(
            (el) => !beforeSnapshot.has(el) && isVisible(el)
          );
          console.warn(
            `[JobPilot] No modal detected for "${cat}". New visible elements after click: ${newVisible.length}`,
            newVisible.slice(0, 5).map((el) => ({
              tag: el.tagName,
              class: el.className,
              fieldCount: el.querySelectorAll("input, textarea, select").length,
            }))
          );
        }
        console.warn(`[JobPilot] "Add ${cat}" did not add a row after retries; stopping.`);
        break;
      }
    }
  }

  if (expanded > 0) await sleep(400); // let the last section finish rendering
  console.log("[JobPilot] Expansion done. New rows added:", expanded);
  return expanded;
}

// ---------- Message handling ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (jpSkipFrame) return false; // this frame is a tiny non-form iframe; ignore
  if (message.type === "PING") {
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "DETECT_FIELDS") {
    // Reject a detect request if an autofill (auto-run or floating button)
    // is already in progress — starting a second detectFields() here would
    // reassign field ids out from under the in-flight run, causing its
    // AI suggestions to land on the wrong fields once applied. The side
    // panel surfaces this rejection as a "please wait" message.
    if (jpAutofillInProgress) {
      console.log("[JobPilot] DETECT_FIELDS rejected — an autofill run is already in progress.");
      sendResponse({ fields: [], jobContext: {}, busy: true });
      return false;
    }
    jpAutofillInProgress = true;
    jpClearMarks();
    jpUndoStack = [];
    jpFillRecords.clear();
    jpHideChecklist();
    // Safety net: if APPLY_ANSWERS is never called to release the lock (e.g.
    // the side panel hit an error and gave up after detection), don't leave
    // autofill permanently blocked on this page — auto-release after 60s.
    setTimeout(() => {
      jpAutofillInProgress = false;
    }, 60000);

    // First expand any repeatable "Add Experience / Add Education" sections so
    // their hidden fields exist, THEN detect everything.
    expandRepeatableSections(message.counts || {}, message.parsedEntries || null).then(async (expanded) => {
      const fields = detectFields();
      const jobContext = scrapeJobContext();
      const { frameId } = await chrome.runtime.sendMessage({ type: "FRAME_INFO" });
      console.log(`[JobPilot] Expanded ${expanded} section(s).`);
      console.log(`[JobPilot] Detected ${fields.length} fields:`, fields);
      sendResponse({ fields, jobContext, scanId: fieldScanId, frameId });
    }).catch(err => {
      jpAutofillInProgress = false;
      console.error("[JobPilot] Field detection failed:", err.message);
      sendResponse({ error: `Could not read the form: ${err.message}` });
    });
    return true; // async response
  }
  if (message.type === "APPLY_ANSWERS") {
    if (message.scanId && message.scanId !== fieldScanId) {
      sendResponse({ filled: 0, stale: true });
      return false;
    }
    applyAnswers(message.suggestions || []).then(async (result) => {
      console.log(`[JobPilot] Filled ${result.filled} fields. stale=${result.stale}`);
      jpAutofillInProgress = false; // release the lock taken in DETECT_FIELDS
      if (!result.stale && message.resume) {
        jpCurrentResume = message.resume;
        jpLastJobContext = message.jobContext || scrapeJobContext();
        await jpFinishAutofill(message.resume, result.failed || []);
        result.attach = jpChecklistState?.attach;
      }
      sendResponse(result);
    }).catch(err => {
      jpAutofillInProgress = false;
      console.error("[JobPilot] Applying answers failed:", err.message);
      sendResponse({ error: err.message });
    });
    return true; // async response
  }
  if (message.type === "SHOW_FAB") {
    // Re-enable the floating Autofill button (globally, across all tabs) and
    // show it on this tab right away, without needing a page reload.
    jpFabEnabled = true;
    jpFabHiddenHere = false;
    chrome.storage.local.set({ fabEnabled: true }).catch(() => {});
    injectFab();
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "GET_JOB_CONTEXT") {
    sendResponse(looksLikeJobApplication() ? scrapeJobContext() : null);
    return false;
  }
  if (message.type === "CHECK_JOB_PAGE") {
    // Lets the side panel know whether the current tab looks like a job
    // application, so it can disable "Fill This Form" on irrelevant pages
    // (e.g. the extension's own onboarding page).
    let isJobPage = false;
    try {
      isJobPage = looksLikeJobApplication();
    } catch {
      /* ignore */
    }
    sendResponse({ isJobPage });
    return false;
  }
  return false;
});

// ================= Floating "Autofill" button (auto-detect) =================

var JP_BTN_ID = "jobpilot-fab";

// Heuristic: does this page look like a job application form?
function looksLikeJobApplication() {
  const host = location.hostname;
  const KNOWN_ATS = [
    "greenhouse.io",
    "boards.greenhouse.io",
    "lever.co",
    "jobs.lever.co",
    "ashbyhq.com",
    "myworkdayjobs.com",
    "icims.com",
    "csod.com",
    "smartrecruiters.com",
    "workable.com",
    "bamboohr.com",
    "jobvite.com",
    "taleo.net",
    "successfactors.com",
    "phenompeople.com",
    "eightfold.ai",
    "paylocity.com",
    "breezy.hr",
    "ats.rippling.com",
    "recruitee.com",
    "teamtailor.com",
  ];
  if (KNOWN_ATS.some((d) => host.endsWith(d) || host.includes(d))) return true;

  // Otherwise: look for tell-tale application fields.
  const labels = Array.from(document.querySelectorAll("label"))
    .map((l) => (l.innerText || "").toLowerCase())
    .join(" | ");
  const hasName = /first name|full name|given name/.test(labels);
  const hasContact = /email|phone/.test(labels);
  const hasResume =
    /resume|cv|curriculum/.test(labels) ||
    !!document.querySelector("input[type='file']");
  const url = location.href.toLowerCase();
  const jobUrl = /(job|career|apply|application|posting|greenhouse|lever|ashby|workday)/.test(url);

  return (hasName && hasContact) || (hasResume && (hasName || jobUrl));
}

// Position the toast right next to the FAB's current location (wherever the
// user has dragged it), instead of a fixed corner — so status messages don't
// feel disconnected from the button when it's been moved elsewhere.
function jpPositionToastNearFab(toast) {
  const fab = document.getElementById(JP_BTN_ID);
  const margin = 12;

  // Reset any previous anchor so we can recompute cleanly.
  toast.style.top = toast.style.bottom = toast.style.left = toast.style.right = "";

  if (!fab) {
    // No button on screen (shouldn't normally happen while a toast fires) —
    // fall back to a sensible default corner.
    toast.style.bottom = "20px";
    toast.style.right = "20px";
    return;
  }

  const rect = fab.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Prefer placing the toast ABOVE the button, unless there isn't enough
  // room near the top of the viewport, in which case place it BELOW.
  const spaceAbove = rect.top;
  if (spaceAbove > 60) {
    toast.style.bottom = `${vh - rect.top + margin}px`;
  } else {
    toast.style.top = `${rect.bottom + margin}px`;
  }

  // Align horizontally with the button, but keep it fully on-screen.
  const toastWidth = 300; // matches maxWidth
  let left = rect.left;
  if (left + toastWidth > vw - margin) left = vw - toastWidth - margin;
  if (left < margin) left = margin;
  toast.style.left = `${left}px`;
}

// After filling: attach the resume file, show the checklist, and remember the
// session so the next step of a multi-page form continues automatically.
async function jpFinishAutofill(pick, needs) {
  for (const item of needs) {
    const meta = fieldRegistry[String(item.id)];
    const el = meta && meta.kind !== "radio" && meta.kind !== "buttongroup" ? jpResolveField(String(item.id), meta) : null;
    if (el && !jpFillRecords.has(String(item.id))) jpMark(el, "needs");
  }
  const attach = await jpAttachResume(pick?.resumeId);
  jpSaveSession(pick);
  jpWatchForNextStep();
  const coverTargets = jpCoverTargets();
  const asksCover = coverTargets.files.length > 0 || coverTargets.texts.length > 0;
  const { coverLetterMode } = asksCover ? await chrome.storage.local.get("coverLetterMode") : {};
  jpShowChecklist({ needs, attach, cover: asksCover && coverLetterMode === "ai" ? { status: "writing" } : null });
  if (asksCover) {
    const cover = await jpHandleCoverLetter();
    if (jpChecklistState) {
      jpChecklistState.cover = cover;
      jpRenderChecklist();
    }
  }
}

// Short, friendly summary. Fields left for the user are a normal outcome
// (e.g. questions only they can answer), not an error.
function fillSummary(filled, failed) {
  return `✓ Filled ${filled} fields.` +
    (failed.length ? ` ${failed.length} need you — see the checklist.` : " Review the checklist, then submit.");
}

function jpToast(message, type = "info", action = null) {
  let toast = document.getElementById("jobpilot-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "jobpilot-toast";
    Object.assign(toast.style, {
      position: "fixed",
      zIndex: "2147483647",
      maxWidth: "300px",
      padding: "10px 14px",
      borderRadius: "8px",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      fontSize: "13px",
      lineHeight: "1.4",
      boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
      color: "#fff",
    });
    document.body.appendChild(toast);
  }
  jpPositionToastNearFab(toast);
  const colors = { info: "#4a3aff", success: "#166534", error: "#991b1b", note: "#334155" };
  toast.style.background = colors[type] || colors.info;
  toast.textContent = message;
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    Object.assign(button.style, {
      display: "block", marginTop: "8px", padding: "6px 10px", border: "none", borderRadius: "6px",
      background: "#fff", color: "#1a1a2e", fontWeight: "600", cursor: "pointer",
    });
    button.onclick = () => { toast.style.display = "none"; action.run(); };
    toast.appendChild(button);
  }
  toast.style.display = "block";
  clearTimeout(toast._hideTimer);
  const duration = action ? 30000 : type === "note" || message.length > 120 ? 10000 : 4000;
  toast._hideTimer = setTimeout(() => (toast.style.display = "none"), duration);
}

// Orchestrate the full autofill flow from the page (mirrors the side panel).
// `isAuto` is true when triggered automatically (page load), not by a click —
// in that case we must NOT try to open the side panel (requires a user
// gesture), so we just show a toast instead and let the user click manually.
async function checkAutofillConsent(isAuto) {
  if (!isAuto) return true;
  const { autoFillEnabled, fabEnabled, auth } =
    await chrome.storage.local.get(["autoFillEnabled", "fabEnabled", "auth"]);
  if (autoFillEnabled === true && fabEnabled !== false && auth?.idToken) return true;
  jpToast("Automatic filling stopped: it is disabled or you are signed out.", "info");
  return false;
}

async function runAutofillFromButton(isAuto = false) {
  if (jpAutofillInProgress) {
    console.log("[JobPilot] Autofill already in progress — ignoring duplicate trigger.");
    if (!isAuto) jpToast("Already filling — please wait…", "info");
    return;
  }
  jpAutofillInProgress = true;

  const btn = jpFabButton();
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Filling…";
  }
  const openPanelOrToast = async (message) => {
    jpToast(message, "info");
    if (!isAuto) {
      await chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" }).catch(() => {});
    }
  };
  try {
    if (!(await checkAutofillConsent(isAuto))) return;

    // Read saved data (auth + profile) from extension storage.
    const { auth, profile, structured, uploadedResumeText } =
      await chrome.storage.local.get([
        "auth",
        "profile",
        "structured",
        "uploadedResumeText",
      ]);

    const signedIn = Boolean(auth?.idToken);
    const { resumes = [] } = await chrome.storage.local.get("resumes");
    const hasResume = Boolean(uploadedResumeText) || resumes.length > 0;
    const hasStructured = structured && Object.values(structured).some((v) => v);

    // Not signed in, or no profile set up yet → open the panel to guide them,
    // instead of showing a confusing error.
    if (!signedIn || (!profile && !hasResume && !hasStructured)) {
      await openPanelOrToast(
        signedIn
          ? "Opening JobPilot — add your profile to autofill."
          : "Opening JobPilot — please sign in to autofill."
      );
      return;
    }

    // Fresh run: forget the previous step's highlights and undo history.
    jpClearMarks();
    jpUndoStack = [];
    jpFillRecords.clear();
    jpHideChecklist();

    const earlyContext = scrapeJobContext();
    const pick = await jpChooseResume(earlyContext, isAuto);
    jpCurrentResume = pick;
    const resumeText = pick?.text || uploadedResumeText || "";
    const combinedProfile = [profile, resumeText].filter(Boolean).join("\n\n").trim();

    jpToast(pick?.name && pick.count > 1 ? `📄 Using your "${pick.name}" resume…` : "📄 Reading your resume details…", "info");
    let counts = { experience: 1, education: 1 };
    let parsedEntries = null;
    if (combinedProfile) {
      const countResp = await chrome.runtime.sendMessage({
        type: "COUNT_ENTRIES",
        profile: combinedProfile,
      });
      if (countResp?.error) throw new Error(countResp.error);
      if (countResp?.counts) counts = countResp.counts;
      if (countResp?.entries) parsedEntries = countResp.entries;
    }
    console.log("[JobPilot] Resume parse — counts:", counts);

    if (!(await checkAutofillConsent(isAuto))) return;
    jpToast("🔍 Scanning the form fields…", "info");
    const expanded = await expandRepeatableSections(counts, parsedEntries);
    console.log(`[JobPilot] expandRepeatableSections added ${expanded} new row(s) for targets:`, counts);
    let fields = detectFields();
    // The form may still be rendering (the button appears as soon as a job
    // site is recognized), so wait briefly for fields before giving up.
    for (let waited = 0; fields.length === 0 && waited < 6000 && !(jpFindApplyControl() && !jpFormVisible()); waited += 500) {
      await sleep(500);
      fields = detectFields();
    }
    if (fields.length) jpOpenedApplyForm = false;
    console.log(
      `[JobPilot] Detected ${fields.length} fillable field(s):`,
      fields.map((f) => ({ id: f.id, label: f.label, type: f.type }))
    );
    const jobContext = scrapeJobContext();
    // The posting page's description (fetched when this page shows only the
    // form) gives the AI the real job requirements.
    if (pick?.jobContext?.description) jobContext.description = pick.jobContext.description;
    if (fields.length === 0) {
      // Job boards often open on an overview page with the form behind an
      // "Apply" button or "Application" tab (e.g. Ashby links from LinkedIn).
      const apply = !isAuto && !jpOpenedApplyForm ? jpFindApplyControl() : null;
      if (apply) {
        jpOpenedApplyForm = true;
        jpToast("Opening the application form…", "info");
        // If the link loads a new page, finish there (see maybeShowFab).
        try { sessionStorage.setItem(JP_PENDING_KEY, String(Date.now())); } catch { /* storage blocked */ }
        apply.click();
        for (let waited = 0; waited < 10000 && !jpFormVisible(); waited += 500) await sleep(500);
        if (jpFormVisible()) {
          try { sessionStorage.removeItem(JP_PENDING_KEY); } catch { /* storage blocked */ }
          setTimeout(() => runAutofillFromButton(false), 0); // after this run releases its lock
          return;
        }
      }
      jpToast("No application form found here. Open the job's application form, then click Autofill.", "note");
      return;
    }

    jpToast(`🤖 Found ${fields.length} fields — fetching answers…`, "info");
    // Only include each category (experience / education) if its parsed
    // count looks reliable — but evaluate them INDEPENDENTLY, so an
    // unreliable experience parse doesn't also throw away a perfectly good
    // education parse (previously this compared only experience and, if
    // that looked short, dropped the entire object including education).
    const expEntries = parsedEntries?.experience || [];
    const eduEntries = parsedEntries?.education || [];
    const reliableExp = expEntries.length >= counts.experience ? expEntries : null;
    const reliableEdu = eduEntries.length >= counts.education ? eduEntries : null;
    const reliableEntries =
      reliableExp || reliableEdu
        ? { experience: reliableExp || undefined, education: reliableEdu || undefined }
        : null;

    if (!(await checkAutofillConsent(isAuto))) return;
    const request = {
      type: "GENERATE_ANSWERS",
      resumeId: pick?.resumeId,
      fields,
      profile: combinedProfile,
      jobContext,
      structured,
      parsedEntries: reliableEntries,
    };

    // Phase 1: fill everything known from the profile or remembered answers
    // immediately, without waiting for the AI.
    const local = await chrome.runtime.sendMessage({ ...request, localOnly: true });
    if (local?.error) throw new Error(local.error);
    if (!(await checkAutofillConsent(isAuto))) return;
    let total = { filled: 0, failed: [] };
    if (local.suggestions?.length) {
      const first = await applyAnswers(local.suggestions);
      total = { filled: first.filled, failed: first.failed || [] };
    }

    // Phase 2: ask the AI about the remaining fields, plus any profile/memory
    // answers the page rejected (e.g. no matching dropdown option).
    const pendingIds = new Set([...(local.pending || []), ...total.failed.map((f) => f.id)].map(String));
    total.failed = [];
    const pending = fields.filter((f) => pendingIds.has(String(f.id)));
    if (pending.length) {
      jpToast(`✍️ Filled ${total.filled} fields · asking AI about ${pending.length} more…`, "info");
      if (!(await checkAutofillConsent(isAuto))) return;
      const aiResponse = await chrome.runtime.sendMessage({ ...request, fields: pending, skipLocal: true });
      if (aiResponse?.error) {
        // Background.js already retries once on a genuine 401 before giving up.
        if (/auth|401|sign/i.test(aiResponse.error)) {
          await openPanelOrToast("Your session expired — please sign in again.");
          return;
        }
        if (!total.filled) {
          jpToast(`Couldn't autofill: ${aiResponse.error}`, "error");
          return;
        }
        jpToast(`Filled ${total.filled} fields. The AI couldn't answer the rest: ${aiResponse.error}`, "note");
        const needs = pending.filter((f) => f.kind !== "checkbox").map((f) => ({ id: f.id, label: f.label }));
        await jpFinishAutofill(pick, needs);
        return;
      }
      if (!(await checkAutofillConsent(isAuto))) return;
      const second = await applyAnswers(aiResponse.suggestions || []);
      total.filled += second.filled;
      total.failed.push(...(second.failed || []));
      const answered = new Set((aiResponse.suggestions || []).map((s) => String(s.id)));
      for (const f of pending) {
        // Unanswered checkboxes are simply left unchecked; not a task for the user.
        if (!answered.has(String(f.id)) && f.kind !== "checkbox") {
          total.failed.push({ id: f.id, label: f.label, reason: "No answer available." });
        }
      }
    }

    console.log(`[JobPilot] Fill result — filled: ${total.filled}, needs input: ${total.failed.length}`);
    if (!total.filled) {
      throw new Error("No fields were filled. " + total.failed.map(item => `${item.label}: ${item.reason}`).join("; "));
    }
    jpToast(fillSummary(total.filled, total.failed), total.failed.length ? "note" : "success");
    await jpFinishAutofill(pick, total.failed);
  } catch (err) {
    console.error("[JobPilot] Autofill failed:", err);
    // Happens when the extension was reloaded/updated while this page was
    // already open — the old content script is disconnected from the new
    // extension instance. Refreshing the page fixes it (a fresh page load
    // gets a fresh, valid content script). We can't reconnect ourselves or
    // open the side panel here since the messaging channel itself is dead.
    if (/extension context invalidated/i.test(err?.message || "")) {
      jpToast("JobPilot was updated — please refresh this page and try again.", "error");
      return;
    }
    await openPanelOrToast(`Autofill failed: ${err.message}`);
  } finally {
    jpAutofillInProgress = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "✨ Autofill";
    }
  }
}

// The extension can no longer be reached from this page (it was updated or
// reloaded). A fresh copy of this script takes over the page.
function jpOrphaned() {
  try { return !chrome.runtime?.id; } catch { return true; }
}

// Identifies the button injected by this copy of the script.
var JP_INSTANCE = Math.random().toString(36).slice(2);

function jpFabButton() {
  return document.getElementById(JP_BTN_ID)?.shadowRoot?.getElementById("jobpilot-fab-btn") || null;
}

function injectFab() {
  if (jpOrphaned()) return;
  const existing = document.getElementById(JP_BTN_ID);
  if (existing) {
    if (existing.dataset.jpInstance === JP_INSTANCE) return;
    existing.remove(); // left behind by a previous version, no longer works
  }
  if (!jpFabEnabled || jpFabHiddenHere) return;

  // Host element attached directly to <html> (not <body>) and rendered inside
  // a Shadow DOM. This avoids two common real-world breakages on modern SPA
  // job sites (seen on Greenhouse's job-boards frontend, for example):
  //   1. A wrapping <div> inside <body> with a CSS "transform"/"filter" for
  //      page-transition animations, which silently turns "position: fixed"
  //      into "fixed relative to that ancestor" instead of the viewport —
  //      making our button render off-screen or hidden. Attaching straight to
  //      <html> sidesteps that (very few sites transform <html> itself).
  //   2. Aggressive global CSS resets on the host page (e.g. "button { all:
  //      unset }") leaking into and breaking our button's appearance. Shadow
  //      DOM fully isolates our styles from the page's CSS in both directions.
  // `host` (light DOM) is the actual positioned/draggable element; `wrap`
  // (inside the shadow root) just holds the button + close button.
  const host = document.createElement("div");
  host.id = JP_BTN_ID;
  host.dataset.jpInstance = JP_INSTANCE;
  Object.assign(host.style, {
    all: "initial",
    display: "block",
    position: "fixed",
    zIndex: "2147483647",
    touchAction: "none", // so pointer drag works smoothly on touch too
  });

  const saved = jpLoadFabPosition();
  if (saved) {
    host.style.left = saved.left + "px";
    host.style.top = saved.top + "px";
  } else {
    host.style.bottom = "20px";
    host.style.right = "20px";
  }

  const shadow = host.attachShadow({ mode: "open" });
  const wrap = document.createElement("div");
  wrap.style.position = "relative";

  const btn = document.createElement("button");
  btn.id = "jobpilot-fab-btn";
  btn.type = "button";
  btn.textContent = "✨ Autofill";
  Object.assign(btn.style, {
    display: "block",
    padding: "12px 18px",
    background: "#4a3aff",
    color: "#fff",
    border: "none",
    borderRadius: "999px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontSize: "14px",
    fontWeight: "600",
    cursor: "grab",
    boxShadow: "0 4px 14px rgba(74,58,255,0.4)",
  });
  btn.addEventListener("mouseenter", () => {
    if (!jpFabDragging) btn.style.opacity = "0.92";
  });
  btn.addEventListener("mouseleave", () => (btn.style.opacity = "1"));

  // Small "×" close button, overlapping the top-right corner.
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.title = "Hide on this page (turn it off everywhere from the JobPilot panel)";
  Object.assign(closeBtn.style, {
    position: "absolute",
    top: "-8px",
    right: "-8px",
    width: "20px",
    height: "20px",
    borderRadius: "50%",
    border: "none",
    background: "#1a1a2e",
    color: "#fff",
    fontSize: "13px",
    lineHeight: "20px",
    padding: "0",
    cursor: "pointer",
    boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
  });
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    jpFabHiddenHere = true;
    removeFab();
  });

  wrap.appendChild(btn);
  wrap.appendChild(closeBtn);
  shadow.appendChild(wrap);
  document.documentElement.appendChild(host);
  jpKeepFabOnScreen(host);
  console.log("[JobPilot] Floating Autofill button injected.");

  // ---- Drag to move (pointer events cover mouse + touch) ----
  let dragStartX = 0;
  let dragStartY = 0;
  let hostStartLeft = 0;
  let hostStartTop = 0;
  let moved = false;

  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const rect = host.getBoundingClientRect();
    // Switch to left/top positioning once drag starts (in case it was
    // anchored via bottom/right initially).
    host.style.left = rect.left + "px";
    host.style.top = rect.top + "px";
    host.style.right = "";
    host.style.bottom = "";

    dragStartX = e.clientX;
    dragStartY = e.clientY;
    hostStartLeft = rect.left;
    hostStartTop = rect.top;
    moved = false;
    jpFabDragging = true;
    btn.style.cursor = "grabbing";
    btn.setPointerCapture(e.pointerId);
  });

  btn.addEventListener("pointermove", (e) => {
    if (!jpFabDragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;

    const maxLeft = window.innerWidth - host.offsetWidth - 4;
    const maxTop = window.innerHeight - host.offsetHeight - 4;
    const newLeft = Math.min(Math.max(4, hostStartLeft + dx), maxLeft);
    const newTop = Math.min(Math.max(4, hostStartTop + dy), maxTop);
    host.style.left = newLeft + "px";
    host.style.top = newTop + "px";
  });

  const endDrag = () => {
    if (!jpFabDragging) return;
    jpFabDragging = false;
    btn.style.cursor = "grab";
    const rect = host.getBoundingClientRect();
    jpSaveFabPosition({ left: rect.left, top: rect.top });
    // If the pointer barely moved, treat it as a click, not a drag.
    if (!moved) runAutofillFromButton();
  };
  btn.addEventListener("pointerup", endDrag);
  btn.addEventListener("pointercancel", endDrag);
}

function removeFab() {
  document.getElementById(JP_BTN_ID)?.remove();
}

// A position saved on a wider window (or before a zoom change) can be off
// screen; put the button back in the default corner when it doesn't fit.
function jpKeepFabOnScreen(host = document.getElementById(JP_BTN_ID)) {
  if (!host || !host.style.left) return;
  const rect = host.getBoundingClientRect();
  const width = rect.width || 130;
  const height = rect.height || 44;
  const fits = rect.left >= 0 && rect.top >= 0 &&
    rect.left + width <= window.innerWidth && rect.top + height <= window.innerHeight;
  if (fits) return;
  host.style.left = "";
  host.style.top = "";
  host.style.right = "20px";
  host.style.bottom = "20px";
  try { window.localStorage.removeItem("jobpilot_fab_pos"); } catch { /* storage blocked */ }
}

if (!jpSkipFrame) window.addEventListener?.("resize", () => jpKeepFabOnScreen());

// Persist the button's dragged position across page loads (per-device, via
// chrome.storage.local) so it doesn't jump back to the corner every time.
function jpLoadFabPosition() {
  try {
    const raw = window.localStorage.getItem("jobpilot_fab_pos");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function jpSaveFabPosition(pos) {
  try {
    window.localStorage.setItem("jobpilot_fab_pos", JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

// Whether the floating Autofill button is globally enabled, across every
// site and tab (toggled from the side panel). Persisted in chrome.storage.local
// so it applies everywhere, not just the current page. Defaults to enabled.
var jpFabEnabled = true;
var jpFabHiddenHere = false; // closed with × on this page only
if (!jpSkipFrame) {
  chrome.storage.local.get(["fabEnabled"]).then(({ fabEnabled }) => {
    jpFabEnabled = fabEnabled !== false;
    if (!jpFabEnabled) removeFab();
  });

  // React live if the user toggles it from the side panel while this page is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("fabEnabled" in changes) {
      jpFabEnabled = changes.fabEnabled.newValue !== false;
      jpFabHiddenHere = false;
      if (jpFabEnabled) maybeShowFab();
      else removeFab();
    }
    if (changes.autoFillEnabled?.newValue === true) maybeShowFab();
  });
}

var jpFabDragging = false;

// Automatic processing requires a separate, per-device opt-in; showing the
// floating button or having a saved profile does not grant consent.
var jpAutoRunAttempted = false;

async function maybeAutoFill() {
  if (jpAutoRunAttempted || !jpFabEnabled) return;
  try {
    const { autoFillEnabled, fabEnabled, auth, profile, structured, uploadedResumeText } =
      await chrome.storage.local.get([
        "autoFillEnabled", "fabEnabled", "auth", "profile", "structured", "uploadedResumeText",
      ]);
    if (autoFillEnabled !== true || fabEnabled === false || jpAutoRunAttempted) return;
    const signedIn = Boolean(auth?.idToken);
    const combinedProfile = [profile, uploadedResumeText].filter(Boolean).join("\n\n").trim();
    const hasStructured = structured && Object.values(structured).some((v) => v);
    if (!signedIn || (!combinedProfile && !hasStructured)) return; // needs a manual click

    jpAutoRunAttempted = true;
    await runAutofillFromButton(true);
  } catch (err) {
    console.error("[JobPilot] Could not start automatic filling:", err);
  }
}

var jpPrefetchedUrl = null;
var jpOpenedApplyForm = false;
var JP_PENDING_KEY = "jobpilot_pending_autofill";

// A visible link, button, or tab that opens the application form.
function jpFindApplyControl() {
  const candidates = jpQueryAll("a, button, [role='tab'], [role='button']").filter((el) => {
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 40 || !isVisible(el)) return false;
    if (!/^(apply( now| here| online)?|apply (for|to) (this|the) (job|position|role)|application|start (your )?application|i'?m interested)$/i.test(text)) return false;
    const href = el.getAttribute("href");
    if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current")) return false;
    if (href && !href.startsWith("#")) {
      try {
        const target = new URL(href, location.href);
        // Stay on the job site; LinkedIn "Easy Apply"-style links elsewhere are out of scope.
        if (target.hostname !== location.hostname) return false;
        // A tab linking to this page (e.g. Ashby's "Application" tab on the form itself).
        if (target.pathname.replace(/\/+$/, "") === location.pathname.replace(/\/+$/, "")) return false;
      } catch { return false; }
    }
    return true;
  });
  // Prefer an explicit "Apply…" control over a generic "Application" tab.
  return candidates.find((el) => /^apply/i.test(el.textContent.trim())) || candidates[0] || null;
}

function jpFormVisible() {
  return jpQueryAll("input:not([type='hidden']):not([type='submit']):not([type='button']), textarea, select")
    .filter((el) => isVisible(el)).length >= 2;
}

// Check periodically (handles SPA job forms that render after load).
function maybeShowFab() {
  if (jpSkipFrame) return; // tiny non-form iframe — never show/poll here
  try {
    if (looksLikeJobApplication()) {
      injectFab();
      // The user clicked Autofill on an overview page whose apply link loaded
      // this page; finish the fill here.
      let pendingAt = 0;
      try { pendingAt = Number(sessionStorage.getItem(JP_PENDING_KEY)) || 0; } catch { /* storage blocked */ }
      if (pendingAt && Date.now() - pendingAt < 60000 && !jpAutofillInProgress) {
        try { sessionStorage.removeItem(JP_PENDING_KEY); } catch { /* storage blocked */ }
        jpOpenedApplyForm = true;
        setTimeout(() => runAutofillFromButton(false), 500);
      }
      if (jpPrefetchedUrl !== location.href) {
        jpPrefetchedUrl = location.href;
        chrome.runtime.sendMessage({ type: "PREFETCH_JOB", jobContext: scrapeJobContext(), url: location.href }).catch(() => {});
      }
      // Continuing a multi-page application after a full page load.
      if (jpLoadSession()) {
        const btn = jpFabButton();
        if (btn && !jpAutofillInProgress) btn.textContent = "✨ Continue autofill";
        jpWatchForNextStep();
        setTimeout(jpCheckNextStep, 1500);
      }
      maybeAutoFill();
    }
  } catch {
    /* ignore */
  }
}

if (!jpSkipFrame) {
  // Single-page job sites (e.g. Rippling, Workday) render the application
  // form after the page loads or when "Apply" is clicked without a new page
  // load, so keep watching the page (throttled) instead of checking only at
  // load.
  let jpFabCheckPending = false;
  const jpScheduleFabCheck = () => {
    if (jpFabCheckPending) return;
    jpFabCheckPending = true;
    setTimeout(() => {
      jpFabCheckPending = false;
      if (jpOrphaned()) {
        jpFabObserver?.disconnect();
        return;
      }
      const present = document.getElementById(JP_BTN_ID)?.dataset.jpInstance === JP_INSTANCE;
      if (!present) maybeShowFab();
    }, 1000);
  };
  const jpFabObserver = typeof MutationObserver === "function" ? new MutationObserver(jpScheduleFabCheck) : null;
  if (jpFabObserver && document.documentElement) {
    jpFabObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  window.addEventListener?.("popstate", jpScheduleFabCheck);
  window.addEventListener?.("hashchange", jpScheduleFabCheck);
  maybeShowFab();
}
