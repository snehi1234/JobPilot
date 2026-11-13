// pdf-tailor.mjs — apply accepted tailoring changes inside the user's own
// resume file, keeping its design. Only the changed bullets (and summary) are
// rewritten in place; everything else in the file stays exactly as it was.
//   PDF:  the old lines are covered and the new wording is drawn in the same
//         spot, size, and width (standard sans-serif or serif font).
//   DOCX: the paragraph's text is replaced, keeping its formatting.
import { PDFDocument, StandardFonts, rgb, PDFName, PDFArray, PDFRawStream, decodePDFRawStream } from "./pdf-lib.min.mjs";
import { reflowGroups, isHeading } from "./tailored-resume.mjs";

const BULLET_ONLY = /^[•●▪◦➢►✓\-–*\u0095\uf0b7\uf0a7]$/;
const SUMMARY_HEADING = /^(professional summary|summary|profile|about|objective)\s*:?\s*$/i;
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

// Characters the standard PDF fonts can draw.
function winAnsi(s) {
  return String(s)
    .replace(/[\u2018\u2019\u2032]/g, "'").replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2212]/g, "-").replace(/[\u2013]/g, "\u2013").replace(/\u2026/g, "...")
    .replace(/[\u00A0\u2009\u202F]/g, " ").replace(/[^\x20-\x7E\u00A1-\u00FF\u2013\u2014\u2022]/g, "");
}

// Physical text lines with their position, as pdf.js reads them (the same
// grouping the extension uses when it reads the resume's text).
async function readPdfLines(pdfjsLib, bytes) {
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    // Load the page's fonts so their real names (e.g. "TimesNewRomanPS-BoldMT") are known.
    await page.getOperatorList().catch(() => null);
    const content = await page.getTextContent();
    const fontInfo = (id) => {
      let name = "";
      try { name = page.commonObjs.get(id)?.name || ""; } catch { /* not loaded */ }
      const family = content.styles?.[id]?.fontFamily || "";
      return {
        bold: /bold|black|heavy|semibold|demi/i.test(name),
        serif: /times|georgia|garamond|cambria|minion|palatino|caslon|baskerville|bookman|century|serif/i.test(name) && !/sans|arial|helvet|calibri|verdana|segoe|roboto|lato|inter/i.test(name) ||
          (!name && /serif/i.test(family) && !/sans/i.test(family)),
      };
    };
    let cur = { page: p - 1, text: "", items: [] };
    for (const item of content.items) {
      cur.text += `${item.str || ""}${item.hasEOL ? "" : " "}`;
      if (item.str?.trim() && item.transform) {
        const f = fontInfo(item.fontName);
        cur.items.push({
          str: item.str, x: item.transform[4], y: item.transform[5], w: item.width || 0,
          size: Math.hypot(item.transform[2], item.transform[3]) || item.height || 10,
          serif: f.serif, bold: f.bold,
        });
      }
      if (item.hasEOL) { lines.push(cur); cur = { page: p - 1, text: "", items: [] }; }
    }
    if (cur.items.length) lines.push(cur);
  }
  await pdf.destroy();
  return lines;
}

function geometry(line, first) {
  const items = line.items.filter((it, i) => !(first && i === 0 && BULLET_ONLY.test(it.str.trim())));
  if (!items.length) return null;
  const left = Math.min(...items.map((it) => it.x));
  const right = Math.max(...items.map((it) => it.x + it.w));
  const sizes = items.map((it) => it.size).sort((a, b) => a - b);
  // Words in the bold lead-in at the start of the line (e.g. "Led the design of X").
  let boldWords = 0;
  for (const it of items) {
    if (!it.bold) break;
    boldWords += it.str.trim().split(/\s+/).filter(Boolean).length;
  }
  return {
    left, right, y: items[0].y, size: sizes[Math.floor(sizes.length / 2)], boldWords, allBold: boldWords > 0 && items.every((it) => it.bold),
    serif: items.filter((it) => it.serif).length > items.length / 2,
  };
}

// Greedy word wrap with per-word fonts. Returns lines of [{ word, font }].
function wrap(words, size, widths) {
  const out = [];
  let line = [];
  let width = 0;
  for (const w of words) {
    const ww = w.font.widthOfTextAtSize(w.word, size);
    const space = line.length ? w.font.widthOfTextAtSize(" ", size) : 0;
    const max = widths[Math.min(out.length, widths.length - 1)];
    if (line.length && width + space + ww > max) { out.push(line); line = [w]; width = ww; } else { line.push(w); width += space + ww; }
  }
  if (line.length) out.push(line);
  return out;
}

// The bold lead-in ends at the original's bold word count, at the latest at
// the first comma/semicolon after it, so it reads as a phrase.
function leadInWords(words, count) {
  if (!count) return 0;
  let n = Math.min(count, words.length);
  for (let i = 0; i < n; i++) if (/[,;:]$/.test(words[i])) return i + 1;
  return n;
}

// Lay out `text` in the physical lines `group` (same page). Returns null when
// the new wording doesn't fit in the same number of lines.
function planRegion(fonts, group, text) {
  if (!group.length || group.some((l) => l.page !== group[0].page)) return null;
  const geo = group.map((l, i) => geometry(l, i === 0));
  if (geo.some((g) => !g)) return null;
  const right = Math.max(...geo.map((g) => g.right));
  const widths = geo.map((g) => right - g.left);
  const family = geo[0].serif ? fonts.serif : fonts.sans;
  const raw = winAnsi(text).split(/\s+/).filter(Boolean);
  const bold = geo[0].allBold ? raw.length : leadInWords(raw, geo[0].boldWords);
  const words = raw.map((word, i) => ({ word, font: i < bold ? family.bold : family.regular }));
  const base = geo[0].size;
  let size = base;
  let lines = wrap(words, size, widths);
  while (lines.length > group.length && size > base * 0.86) {
    size -= base * 0.02;
    lines = wrap(words, size, widths);
  }
  if (lines.length > group.length) return null;
  // Slightly shorter text: spread it over all the original lines so no blank
  // line is left (only when that keeps lines nearly full).
  if (lines.length < group.length && group.length > 1) {
    let lo = 0.82, hi = 1, best = null;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      const trial = wrap(words, size, widths.map((w) => w * mid));
      if (trial.length <= group.length) { best = trial; hi = mid; } else lo = mid;
    }
    const tight = wrap(words, size, widths.map((w) => w * 0.82));
    if (tight.length >= group.length && best && best.length === group.length) lines = best;
  }
  // Justified paragraphs (every line but the last ends at the right margin).
  const justified = geo.length > 1 && geo.slice(0, -1).every((g) => Math.abs(g.right - right) < 2.5);
  return { page: group[0].page, geo, right, size, lines, justified };
}

function drawRegion(doc, plan) {
  const page = doc.getPages()[plan.page];
  const { geo, right, size, lines, justified } = plan;
  lines.forEach((line, i) => {
    let x = geo[i].left;
    const natural = line.reduce((n, w, k) => n + w.font.widthOfTextAtSize(k ? ` ${w.word}` : w.word, size), 0);
    const gap = justified && i < lines.length - 1 && line.length > 1 ? (right - geo[i].left - natural) / (line.length - 1) : 0;
    const extra = gap > 0 && gap <= size * 0.5 ? gap : 0;
    line.forEach((w, k) => {
      const t = k ? ` ${w.word}` : w.word;
      if (k) x += extra;
      page.drawText(t, { x, y: geo[i].y, size, font: w.font, color: rgb(0.08, 0.08, 0.08) });
      x += w.font.widthOfTextAtSize(t, size);
    });
  });
}

// ---------- Removing the old text from the page ----------
// The old words must be gone from the file, not just covered, or applicant
// tracking systems would read both versions. Walk the page's content stream,
// track where each text-showing operator draws, and empty the ones that draw
// inside the replaced lines. Only those operands' bytes change.

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];

function* tokens(bytes) {
  const n = bytes.length;
  let i = 0;
  while (i < n) {
    const c = bytes[i];
    if (WS.has(c)) { i++; continue; }
    const start = i;
    if (c === 37) { while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++; continue; } // % comment
    if (c === 40) { // (literal string)
      let depth = 0;
      for (; i < n; i++) {
        if (bytes[i] === 92) { i++; continue; }
        if (bytes[i] === 40) depth++;
        else if (bytes[i] === 41 && --depth === 0) { i++; break; }
      }
      yield { type: "str", start, end: i };
      continue;
    }
    if (c === 60 && bytes[i + 1] === 60) { i += 2; yield { type: "dict<", start, end: i }; continue; }
    if (c === 62 && bytes[i + 1] === 62) { i += 2; yield { type: "dict>", start, end: i }; continue; }
    if (c === 60) { while (i < n && bytes[i] !== 62) i++; i++; yield { type: "str", start, end: i }; continue; } // <hex>
    if (c === 91) { i++; yield { type: "[", start, end: i }; continue; }
    if (c === 93) { i++; yield { type: "]", start, end: i }; continue; }
    if (c === 123 || c === 125) { i++; continue; }
    if (c === 47) { i++; while (i < n && !WS.has(bytes[i]) && !DELIM.has(bytes[i])) i++; yield { type: "name", start, end: i }; continue; }
    while (i < n && !WS.has(bytes[i]) && !DELIM.has(bytes[i])) i++;
    if (i === start) { i++; continue; }
    const word = String.fromCharCode(...bytes.subarray(start, i));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { yield { type: "num", start, end: i, value: Number(word) }; continue; }
    if (word === "BI") { // inline image: skip its binary data up to "EI"
      while (i < n && !(bytes[i - 1] === 73 && bytes[i] === 68 && WS.has(bytes[i + 1] ?? 32) && WS.has(bytes[i - 2] ?? 32))) i++;
      i += 2;
      while (i < n && !(bytes[i] === 69 && bytes[i + 1] === 73 && WS.has(bytes[i - 1]) && (i + 2 >= n || WS.has(bytes[i + 2])))) i++;
      i += 2;
      continue;
    }
    yield { type: "op", start, end: i, value: word };
  }
}

function stripText(bytes, regionLines) {
  const edits = [];
  let operands = [];
  const arrays = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let tm = [1, 0, 0, 1, 0, 0], tlm = tm, leading = 0, known = true, lastX = 0;
  const nextLine = () => { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; known = true; };
  const show = (operand) => {
    if (!operand) return;
    const m = mul(tm, ctm);
    const x = m[4], y = m[5];
    const line = regionLines.find((r) => Math.abs(r.y - y) <= Math.max(1.5, r.size * 0.3));
    if (line) {
      const inside = known ? x >= line.left - 1 && x <= line.right + 1 : lastX >= line.left - line.size * 2.5 && lastX <= line.right + 1;
      if (inside) edits.push({ start: operand.start, end: operand.end, text: operand.type === "array" ? "[]" : "()" });
    }
    if (known) lastX = x;
    known = false;
  };
  for (const tok of tokens(bytes)) {
    if (tok.type === "[") { arrays.push(tok.start); continue; }
    if (tok.type === "]") { operands.push({ type: "array", start: arrays.pop() ?? tok.start, end: tok.end }); continue; }
    if (arrays.length) continue; // inside an array
    if (tok.type !== "op") { operands.push(tok); continue; }
    const nums = operands.filter((o) => o.type === "num").map((o) => o.value);
    switch (tok.value) {
      case "q": stack.push(ctm); break;
      case "Q": ctm = stack.pop() || ctm; break;
      case "cm": if (nums.length >= 6) ctm = mul(nums.slice(-6), ctm); break;
      case "BT": tm = tlm = [1, 0, 0, 1, 0, 0]; known = true; break;
      case "Tm": if (nums.length >= 6) { tm = tlm = nums.slice(-6); known = true; } break;
      case "Td": if (nums.length >= 2) { tlm = mul([1, 0, 0, 1, nums.at(-2), nums.at(-1)], tlm); tm = tlm; known = true; } break;
      case "TD": if (nums.length >= 2) { leading = -nums.at(-1); tlm = mul([1, 0, 0, 1, nums.at(-2), nums.at(-1)], tlm); tm = tlm; known = true; } break;
      case "TL": if (nums.length) leading = nums.at(-1); break;
      case "T*": nextLine(); break;
      case "Tj": case "TJ": show(operands.at(-1)); break;
      case "'": nextLine(); show(operands.at(-1)); break;
      case "\"": nextLine(); show(operands.at(-1)); break;
      default: break;
    }
    operands = [];
  }
  if (!edits.length) return null;
  const enc = new TextEncoder();
  const parts = [];
  let pos = 0;
  for (const e of edits.sort((a, b) => a.start - b.start)) {
    parts.push(bytes.subarray(pos, e.start), enc.encode(e.text));
    pos = e.end;
  }
  parts.push(bytes.subarray(pos));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function pageContent(doc, page) {
  const contents = page.node.Contents();
  if (!contents) return null;
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  const chunks = streams.map((s) => (s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents?.()));
  if (chunks.some((c) => !c)) return null;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length + 1, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; out[o++] = 10; }
  return out;
}

// accepted: { summary?: string, bullets?: [{ line, improved }] }
// Returns { bytes, applied, skipped }; bytes is null when the file couldn't be
// edited safely (the old wording would still be readable).
export async function tailorPdfInPlace(pdfjsLib, bytes, accepted = {}) {
  const lines = await readPdfLines(pdfjsLib, bytes);
  const groups = reflowGroups(lines.map((l) => l.text));
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const fonts = {
    sans: { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) },
    serif: { regular: await doc.embedFont(StandardFonts.TimesRoman), bold: await doc.embedFont(StandardFonts.TimesRomanBold) },
  };
  const plans = [];
  let skipped = 0;
  for (const b of accepted.bullets || []) {
    const g = groups.find((x) => norm(x.text) === norm(b.line));
    const group = g ? g.indices.map((i) => lines[i]) : [];
    const plan = g && planRegion(fonts, group, String(b.improved || ""));
    if (plan) plans.push({ plan, old: norm(g.text).replace(/^[•●▪◦➢►✓\-–*]\s*/, ""), group }); else skipped++;
  }
  const summary = norm(accepted.summary);
  if (summary) {
    const h = lines.findIndex((l) => SUMMARY_HEADING.test(norm(l.text)));
    let end = h + 1;
    while (h >= 0 && end < lines.length && !isHeading(norm(lines[end].text))) end++;
    const group = h >= 0 ? lines.slice(h + 1, end) : [];
    const plan = group.length && planRegion(fonts, group, summary);
    if (plan) plans.push({ plan, old: norm(group.map((l) => l.text).join(" ")), group }); else skipped++;
  }
  if (!plans.length) return { bytes: null, applied: 0, skipped, reason: "nothing-fits" };

  // Remove the old text, page by page.
  const pages = doc.getPages();
  for (const pageIndex of new Set(plans.map((p) => p.plan.page))) {
    const regionLines = plans.filter((p) => p.plan.page === pageIndex).flatMap((p) => p.plan.geo);
    const content = pageContent(doc, pages[pageIndex]);
    const stripped = content && stripText(content, regionLines);
    if (!stripped) return { bytes: null, applied: 0, skipped: skipped + plans.length, reason: content ? "no-text-found" : "no-content" };
    pages[pageIndex].node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(stripped)));
  }
  for (const p of plans) drawRegion(doc, p.plan);
  const out = await doc.save();

  // Verify: the old wording is gone and the new wording is readable.
  const check = norm((await readPdfLines(pdfjsLib, out)).map((l) => l.text).join(" "));
  const squash = (s) => s.replace(/\s+/g, "").toLowerCase();
  const all = squash(check);
  const newAll = plans.map((p) => squash(p.plan.lines.flat().map((w) => w.word).join(" "))).join("|");
  const count = (hay, needle) => { let n = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; } return n; };
  for (const p of plans) {
    const oldKey = squash(p.old).slice(0, 60);
    const newKey = squash(p.plan.lines[0].map((w) => w.word).join(" ")).slice(0, 30);
    if ((oldKey.length >= 20 && count(all, oldKey) > count(newAll, oldKey)) || !all.includes(newKey)) {
      return { bytes: null, applied: 0, skipped: skipped + plans.length, reason: all.includes(newKey) ? `old-text-left:${oldKey}` : `new-text-missing:${newKey}` };
    }
  }
  return { bytes: out, applied: plans.length, skipped };
}
// ---------- DOCX ----------

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export async function tailorDocxInPlace(JSZip, bytes, accepted = {}) {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml").async("string");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const paras = Array.from(doc.getElementsByTagNameNS(W_NS, "p"));
  const textOf = (p) => Array.from(p.getElementsByTagNameNS(W_NS, "t")).map((t) => t.textContent || "").join("");
  const groups = reflowGroups(paras.map(textOf));
  const setText = (p, text) => {
    const ts = Array.from(p.getElementsByTagNameNS(W_NS, "t"));
    if (!ts.length) return false;
    const prefix = (textOf(p).match(/^\s*[•●▪◦➢►✓\-–*]\s*/) || [""])[0];
    ts[0].textContent = prefix + text;
    ts[0].setAttribute("xml:space", "preserve");
    ts.slice(1).forEach((t) => (t.textContent = ""));
    return true;
  };
  let applied = 0;
  let skipped = 0;
  for (const b of accepted.bullets || []) {
    const g = groups.find((x) => norm(x.text) === norm(b.line));
    if (!g || !setText(paras[g.indices[0]], String(b.improved || ""))) { skipped++; continue; }
    g.indices.slice(1).forEach((i) => paras[i].parentNode?.removeChild(paras[i]));
    applied++;
  }
  const summary = norm(accepted.summary);
  if (summary) {
    const h = paras.findIndex((p) => SUMMARY_HEADING.test(norm(textOf(p))));
    let end = h + 1;
    while (h >= 0 && end < paras.length && !norm(textOf(paras[end]))) end++;
    if (h >= 0 && end < paras.length && !isHeading(norm(textOf(paras[end]))) && setText(paras[end], summary)) {
      let k = end + 1;
      while (k < paras.length && !isHeading(norm(textOf(paras[k])))) {
        if (norm(textOf(paras[k]))) paras[k].parentNode?.removeChild(paras[k]);
        k++;
      }
      applied++;
    } else skipped++;
  }
  zip.file("word/document.xml", new XMLSerializer().serializeToString(doc));
  return { bytes: await zip.generateAsync({ type: "uint8array" }), applied, skipped };
}
