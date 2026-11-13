// content-workday.js — Workday application support. Loaded before content.js
// (same isolated world). Workday uses custom widgets instead of form
// controls:
//   • dropdowns: <button aria-haspopup="listbox"> that open a pop-up list
//   • "prompt" fields (school, source, skills): a search box whose results
//     appear in a pop-up, sometimes in categories ("Job Board" → "LinkedIn")
//   • dates: separate month / day / year spin boxes
// Fields are found through Workday's data-automation-id attributes.

function jpIsWorkday() {
  return /(^|\.)(myworkdayjobs|myworkdaysite|workday)\.com$/.test(location.hostname) ||
    !!document.querySelector("[data-automation-id='applyFlowPage'], [data-automation-id='jobPostingHeader'], [data-automation-id^='formField-']");
}

function jpWdLabel(el) {
  const field = el.closest("[data-automation-id^='formField'], fieldset");
  const label = field?.querySelector("label, legend, [data-automation-id='formLabel']");
  const text = (label?.innerText || label?.textContent || "").replace(/\*/g, "").replace(/\s+/g, " ").trim();
  return text || getLabelForElement(el);
}

// Called from detectFields(). Adds Workday widgets to `fields` and returns the
// next free field index.
function jpWorkdayDetect(fields, claimed, index, nextLabelIndex) {
  const add = (el, kind, extra = {}) => {
    const id = String(index++);
    el.setAttribute(FIELD_ATTR, id);
    const label = jpWdLabel(el);
    fieldRegistry[id] = { kind, label, labelIndex: nextLabelIndex(kind, label) };
    fields.push({ id, kind, label, type: kind === "wd-date" ? "date" : "select", ...extra });
  };

  // Dates first: claim the month/day/year inputs.
  for (const month of jpQueryAll("input[data-automation-id$='dateSectionMonth-input']")) {
    if (!isVisible(month)) continue;
    const wrapper = month.closest("[data-automation-id='dateInputWrapper'], [data-automation-id^='formField'], div") || month.parentElement;
    if (claimed.has(wrapper)) continue;
    claimed.add(wrapper);
    for (const input of wrapper.querySelectorAll("input")) claimed.add(input);
    add(wrapper, "wd-date", { kind: "text", placeholder: "MM/YYYY" });
    fields[fields.length - 1].kind = "text"; // answered like a text field ("09/2024")
    fieldRegistry[fields[fields.length - 1].id].kind = "wd-date";
  }

  // Prompt (search) fields.
  for (const box of jpQueryAll("[data-automation-id='multiSelectContainer'] input, input[data-automation-id='searchBox']")) {
    if (!isVisible(box) || claimed.has(box)) continue;
    claimed.add(box);
    add(box, "wd-prompt", { kind: "combobox", options: undefined });
    fields[fields.length - 1].kind = "combobox";
  }

  // Dropdown buttons.
  for (const button of jpQueryAll("button[aria-haspopup='listbox']")) {
    if (!isVisible(button) || claimed.has(button)) continue;
    claimed.add(button);
    add(button, "wd-dropdown", { kind: "select", options: undefined });
    fields[fields.length - 1].kind = "select";
  }
  return index;
}

// Workday renders dropdown options only while open: open each once to read
// them, so answers can pick an exact option.
async function jpWorkdayReadOptions(fields) {
  for (const field of fields) {
    if (fieldRegistry[field.id]?.kind !== "wd-dropdown") continue;
    const button = jpQueryOne(`[${FIELD_ATTR}="${CSS.escape(field.id)}"]`);
    if (!button) continue;
    const options = await jpWdOpenList(button);
    if (options.length) field.options = options.map((o) => o.textContent.trim()).filter((t) => t && !/^select one$/i.test(t)).slice(0, 60);
    await jpWdClose(button);
  }
}

function jpWdVisibleOptions() {
  return jpQueryAll("[role='listbox'] [role='option'], [data-automation-id='promptOption'], [data-automation-id='menuItem']")
    .filter((o) => isVisible(o) && o.textContent.trim());
}

async function jpWdOpenList(button) {
  button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  button.click();
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    const options = jpWdVisibleOptions();
    if (options.length) return options;
  }
  return [];
}

async function jpWdClose(button) {
  (document.activeElement || button).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(80);
  if (jpWdVisibleOptions().length && button.getAttribute("aria-expanded") === "true") button.click();
  await sleep(60);
}

function jpWdBestOption(options, value) {
  let best = null;
  let bestScore = 0;
  const target = String(value).trim().toLowerCase();
  for (const option of options) {
    const text = option.textContent.replace(/\s+/g, " ").trim();
    const lower = text.toLowerCase();
    let score = matchScore(value, text);
    if (lower === target) score = 3;
    else if (target.length > 2 && (lower.startsWith(target) || (lower.includes(target) && target.length > 3))) score = Math.max(score, 1.2);
    const group = synonymGroupOf(target);
    if (!score && group && synonymGroupOf(text) === group) score = 1;
    if (score > bestScore) { best = option; bestScore = score; }
  }
  return bestScore >= 0.6 ? best : null;
}

function jpWdClick(el) {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
}

async function jpFillWorkdayDropdown(button, value) {
  const options = await jpWdOpenList(button);
  const match = jpWdBestOption(options, value);
  if (!match) { await jpWdClose(button); return false; }
  const chosen = match.textContent.replace(/\s+/g, " ").trim();
  jpWdClick(match);
  for (let i = 0; i < 15; i++) {
    await sleep(100);
    if ((button.innerText || button.textContent || button.value || "").replace(/\s+/g, " ").includes(chosen)) return true;
  }
  return false;
}

async function jpFillWorkdayPrompt(input, value) {
  const container = input.closest("[data-automation-id='multiSelectContainer'], [data-automation-id^='formField']") || input.parentElement;
  const selected = () => (container.querySelector("[data-automation-id='selectedItem'], [data-automation-id='selectedItemList']")?.textContent || "").replace(/\s+/g, " ");
  for (const query of typeaheadQueries(value)) {
    input.focus({ preventScroll: true });
    setNativeValue(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    // Results may be categories: pick the best entry, and repeat inside it.
    for (let depth = 0; depth < 3; depth++) {
      let options = [];
      for (let i = 0; i < 25 && !options.length; i++) { await sleep(100); options = jpWdVisibleOptions(); }
      const match = jpWdBestOption(options, value) || jpWdBestOption(options, query);
      if (!match) break;
      const chosen = match.textContent.replace(/\s+/g, " ").trim();
      jpWdClick(match);
      for (let i = 0; i < 10; i++) {
        await sleep(100);
        if (selected().includes(chosen)) {
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          return true;
        }
      }
    }
  }
  setNativeValue(input, "");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return false;
}

const JP_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// "09/2024", "Sep 2024", "2024-09", "09/15/2024", "2024" → { month, day, year }
function jpParseDate(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v || /present|current|now/.test(v)) return null;
  let m;
  if ((m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return { month: +m[1], day: +m[2], year: +m[3] };
  if ((m = v.match(/^(\d{1,2})[/-](\d{4})$/))) return { month: +m[1], year: +m[2] };
  if ((m = v.match(/^(\d{4})-(\d{1,2})(-(\d{1,2}))?$/))) return { month: +m[2], day: m[4] ? +m[4] : undefined, year: +m[1] };
  if ((m = v.match(/^([a-z]{3})[a-z]*\.?\s+(\d{4})$/)) && JP_MONTHS.includes(m[1])) return { month: JP_MONTHS.indexOf(m[1]) + 1, year: +m[2] };
  if ((m = v.match(/^(\d{4})$/))) return { year: +m[1] };
  return null;
}

async function jpFillWorkdayDate(wrapper, value) {
  const date = jpParseDate(value);
  if (!date) return false;
  const part = (name) => wrapper.querySelector(`input[data-automation-id$='dateSection${name}-input']`);
  const set = async (input, text) => {
    if (!input) return true;
    input.focus({ preventScroll: true });
    setNativeValue(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    await sleep(40);
    return input.value.replace(/^0+/, "") === String(text).replace(/^0+/, "");
  };
  const okMonth = date.month ? await set(part("Month"), String(date.month).padStart(2, "0")) : !part("Month");
  const okDay = date.day ? await set(part("Day"), String(date.day).padStart(2, "0")) : true;
  const okYear = await set(part("Year"), String(date.year));
  return okMonth && okDay && okYear;
}

// Guidance for Workday pages without a form (sign-in, "how do you want to
// apply?").
function jpWorkdayHint() {
  if (!jpIsWorkday()) return "";
  if (document.querySelector("[data-automation-id='applyManually'], [data-automation-id='autofillWithResume']")) {
    return "On Workday, choose “Apply Manually” (or “Autofill with Resume”), sign in, then click ⚡ Autofill on each step.";
  }
  if (document.querySelector("[data-automation-id='signInSubmitButton'], [data-automation-id='createAccountSubmitButton'], input[type='password']")) {
    return "Sign in or create your Workday account for this company first, then click ⚡ Autofill on each step.";
  }
  return "";
}
