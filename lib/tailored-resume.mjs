// tailored-resume.mjs — apply tailoring suggestions to resume text and render
// a clean, single-column, ATS-friendly PDF in the browser (no network).

const HEADING = /^(summary|professional summary|profile|about|objective|experience|work experience|professional experience|employment( history)?|work history|education|skills|technical skills|core skills|key skills|projects|selected projects|certifications?|awards|honors|publications|leadership|volunteer(ing)?|activities|languages|interests|achievements)\s*:?\s*$/i;
const BULLET = /^[•\-–*▪◦●➢►✓]\s*/;
const DATE = /\b((jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|(19|20)\d{2})\s*([-–—]|to)\s*((jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|(19|20)\d{2}|present|current|now)\b/i;

export function isHeading(line) {
  const t = line.trim();
  if (HEADING.test(t)) return true;
  const letters = t.replace(/[^A-Za-z]/g, "");
  return t.length >= 4 && t.length <= 40 && letters.length >= 4 && letters === letters.toUpperCase() && !/[@|]/.test(t) && !BULLET.test(t);
}

// PDF text puts each wrapped line of a bullet on its own line. Join the
// continuation lines so every bullet is one line (the backend does the same).
export function reflowBullets(text) {
  const out = [];
  let inBullet = false;
  for (const raw of String(text || "").split("\n")) {
    const t = raw.trim();
    const prev = out.length ? out[out.length - 1].trim() : "";
    const continues = inBullet && t && prev && !BULLET.test(t) && !isHeading(t) && !DATE.test(t) &&
      (/^[a-z0-9(&,;:/–-]/.test(t) || (!/[.!?;:]$/.test(prev) && prev.length >= 60));
    if (continues) {
      out[out.length - 1] = `${out[out.length - 1].replace(/\s+$/, "")} ${t}`;
      continue;
    }
    out.push(raw);
    inBullet = BULLET.test(t);
  }
  return out.join("\n");
}

// accepted: { summary?: string, bullets?: [{ line, improved }] }
export function applyTailoring(text, accepted = {}) {
  let lines = reflowBullets(text).split("\n");
  for (const b of accepted.bullets || []) {
    const i = lines.findIndex((l) => l.trim() === String(b.line || "").trim());
    if (i < 0) continue;
    const prefix = (lines[i].match(/^\s*([•\-–*▪◦●➢►✓]\s*)?/) || [""])[0];
    lines[i] = `${prefix || "• "}${b.improved}`;
  }
  const summary = String(accepted.summary || "").trim();
  if (summary) {
    const h = lines.findIndex((l) => /^(professional summary|summary|profile|about|objective)\s*:?\s*$/i.test(l.trim()));
    if (h >= 0) {
      // Replace the existing summary paragraph (up to the next heading).
      let end = h + 1;
      while (end < lines.length && !isHeading(lines[end])) end++;
      lines.splice(h + 1, end - h - 1, summary, "");
    } else {
      // Insert after the name/contact block, before the first heading.
      const first = lines.findIndex((l, i) => i > 0 && isHeading(l));
      const at = first > 0 ? first : Math.min(3, lines.length);
      lines.splice(at, 0, "Summary", summary, "");
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- PDF ----------

// Helvetica glyph widths (1/1000 em) for ASCII 32–126.
const W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];

function toWinAnsi(s) {
  return String(s)
    .replace(/[\u2018\u2019\u2032]/g, "'").replace(/[\u201C\u201D\u2033]/g, '"').replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u2026/g, "...").replace(/[\u00A0\u2009\u202F]/g, " ").replace(/[\u2022\u25AA\u25E6\u25CF\u27A2\u25BA\u2713]/g, "\u0095")
    .replace(/[^\x20-\x7E\u0095\u00A1-\u00FF]/g, "");
}

function widthOf(s, size, bold) {
  let w = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? W[c - 32] : c === 0x95 ? 350 : 556;
  }
  return (w / 1000) * size * (bold ? 1.07 : 1);
}

function wrap(text, size, bold, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const out = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && widthOf(next, size, bold) > maxWidth) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

const pdfString = (s) => `(${[...s].map((ch) => {
  const c = ch.charCodeAt(0);
  if (ch === "(" || ch === ")" || ch === "\\") return `\\${ch}`;
  return c > 126 ? `\\${c.toString(8).padStart(3, "0")}` : ch;
}).join("")})`;

// Returns the PDF as a Uint8Array.
export function renderResumePdf(text) {
  const PAGE_W = 612, PAGE_H = 792, M = 54, MAX = PAGE_W - M * 2;
  const pages = [[]];
  let y = PAGE_H - M;
  const ensure = (h) => { if (y - h < M) { pages.push([]); y = PAGE_H - M; } };
  const draw = (str, x, size, bold, gray = 0) => {
    pages[pages.length - 1].push(`${gray ? `${gray} g ` : ""}BT /${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)} Tm ${pdfString(str)} Tj ET${gray ? " 0 g" : ""}`);
  };

  const lines = String(text || "").split("\n").map((l) => toWinAnsi(l).trim());
  let seenName = false;
  let inHeader = true;
  for (const raw of lines) {
    if (!raw) { y -= 4; continue; }
    if (!seenName) {
      seenName = true;
      ensure(24); draw(raw.slice(0, 80), M, 18, true); y -= 22;
      continue;
    }
    if (isHeading(raw)) {
      inHeader = false;
      y -= 6; ensure(22);
      draw(raw.replace(/:$/, "").toUpperCase(), M, 11, true);
      pages[pages.length - 1].push(`0.6 G 0.6 w ${M} ${(y - 4).toFixed(1)} m ${PAGE_W - M} ${(y - 4).toFixed(1)} l S`);
      y -= 18;
      continue;
    }
    if (inHeader) {
      for (const part of wrap(raw, 9.5, false, MAX)) { ensure(13); draw(part, M, 9.5, false, 0.25); y -= 12.5; }
      continue;
    }
    if (BULLET.test(raw) || raw.startsWith("\u0095")) {
      const body = raw.replace(/^(\u0095|[-*])\s*/, "");
      wrap(body, 10, false, MAX - 14).forEach((part, i) => {
        ensure(13.5);
        if (i === 0) draw("\u0095", M + 2, 10, false);
        draw(part, M + 14, 10, false);
        y -= 13.5;
      });
      continue;
    }
    const bold = DATE.test(raw) && raw.length < 140;
    for (const part of wrap(raw, 10, bold, MAX)) { ensure(14); draw(part, M, 10, bold); y -= 13.5; }
    if (bold) y -= 1;
  }

  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"];
  const kids = [];
  for (const ops of pages) {
    const stream = ops.join("\n");
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${objects.length} 0 R >>`);
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}
