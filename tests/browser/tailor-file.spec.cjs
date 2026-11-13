const { test, expect } = require("./extension.cjs");

// Tailoring edits the user's own file: changed bullets are rewritten in place,
// the old wording is removed (not just covered), and everything else stays.

const RESUME_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:11pt "Times New Roman",serif;margin:48px 56px;color:#111}h1{text-align:center;margin:0 0 4px}
h2{font-size:12pt;border-bottom:1px solid #000;margin:14px 0 6px}ul{margin:0;padding-left:22px}li{margin:2px 0;text-align:justify}</style></head><body>
<h1>Sam Sample</h1><p style="text-align:center">sam@example.com | Seattle, WA</p>
<h2>Summary</h2><p>Software engineer with six years of experience building distributed systems and backend platforms for large partner networks and internal tools.</p>
<h2>Experience</h2><p><b>Example Corp</b> — Software Engineer, Sep 2022 – Present</p><ul>
<li><b>Led the File Exchange platform,</b> a secure portal that extended partner integration beyond B2B APIs to UI-driven file upload and download, adopted by 30+ partners processing 8,600+ files a day.</li>
<li><b>Built the notifications service</b> with templating, delivery, and retry handling, integrated with the orchestrator without adding any cross-service coupling.</li>
</ul><h2>Skills</h2><p>Python, C#, Kubernetes, Kafka, Azure</p></body></html>`;

test("a PDF resume keeps its design: only the changed bullet is rewritten, and the old words are gone", async ({ app }) => {
  const maker = await app.context.newPage();
  await maker.setContent(RESUME_HTML);
  const pdf = await maker.pdf({ format: "Letter" });
  await maker.close();
  const result = await app.panel.evaluate(async (b64) => {
    const { reflowBullets } = await import("./lib/tailored-resume.mjs");
    const { tailorPdfInPlace } = await import("./lib/pdf-tailor.mjs");
    const pdfjs = await import("./lib/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "./lib/pdf.worker.min.mjs";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const read = async (data) => {
      const d = await pdfjs.getDocument({ data: data.slice(0) }).promise;
      let text = "";
      for (let p = 1; p <= d.numPages; p++) {
        const c = await (await d.getPage(p)).getTextContent();
        text += c.items.map((it) => `${it.str}${it.hasEOL ? "\n" : " "}`).join("");
      }
      return { text, pages: d.numPages };
    };
    const before = await read(bytes);
    const line = reflowBullets(before.text).split("\n").find((l) => l.includes("File Exchange"));
    const out = await tailorPdfInPlace(pdfjs, bytes, { bullets: [{ line: line.trim(),
      improved: "Led the File Exchange platform, a secure portal extending partner integration past B2B APIs to UI-driven file upload and download, used by 30+ partners processing 8,600+ files a day." }] });
    const after = out.bytes ? await read(out.bytes) : null;
    return { line, applied: out.applied, reason: out.reason || "", before: before.pages, after: after?.pages, text: after?.text.replace(/\s+/g, " ") || "" };
  }, pdf.toString("base64"));
  expect(result.line).toMatch(/files a day\.$/); // the whole wrapped bullet was found
  expect(result.reason).toBe("");
  expect(result.applied).toBe(1);
  expect(result.after).toBe(result.before);
  expect(result.text).toMatch(/extending partner integration past B2B/);
  expect(result.text).not.toMatch(/extended partner integration beyond/);
  expect(result.text).toMatch(/Built the notifications service with templating/); // untouched bullet
  expect(result.text).toMatch(/Python, C#, Kubernetes/);
});

test("a Word resume keeps its formatting: the paragraph's text is replaced, its bold lead-in style stays", async ({ app }) => {
  const result = await app.panel.evaluate(async () => {
    const { tailorDocxInPlace } = await import("./lib/pdf-tailor.mjs");
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const p = (runs) => `<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr>${runs}</w:p>`;
    const r = (t, bold) => `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${t}</w:t></w:r>`;
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>
      <w:p>${r("Sam Sample")}</w:p><w:p>${r("Experience")}</w:p>
      ${p(r("Led the File Exchange platform,", true) + r(" a secure portal adopted by 30+ partners."))}
      ${p(r("Built the notifications service", true) + r(" with retries."))}
      </w:body></w:document>`;
    const zip = new window.JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", xml);
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const out = await tailorDocxInPlace(window.JSZip, bytes, { bullets: [{ line: "Led the File Exchange platform, a secure portal adopted by 30+ partners.", improved: "Led the File Exchange platform, a secure partner portal used by 30+ partners." }] });
    const doc = await (await window.JSZip.loadAsync(out.bytes)).file("word/document.xml").async("string");
    return { applied: out.applied, doc };
  });
  expect(result.applied).toBe(1);
  expect(result.doc).toContain("Led the File Exchange platform, a secure partner portal used by 30+ partners.");
  expect(result.doc).not.toContain("adopted by 30+ partners");
  expect(result.doc).toContain('<w:pStyle w:val="ListBullet"/>');
  expect(result.doc).toMatch(/<w:b\/><\/w:rPr><w:t xml:space="preserve">Led the File Exchange platform, a secure partner portal/);
  expect(result.doc).toContain("Built the notifications service");
});
