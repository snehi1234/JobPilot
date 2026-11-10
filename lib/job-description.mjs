// job-description.mjs — find the job description for an application page.
//
// Application pages (".../application", ".../apply") usually show only the
// form, so the description is read from the job posting page instead. Most
// job sites embed it in the posting HTML as JSON-LD (JobPosting), Next.js
// data (__NEXT_DATA__), or app state (e.g. Ashby's window.__appData).

const MAX_LENGTH = 6000;

// Candidate posting URLs for an application URL, most likely first.
export function postingUrlCandidates(pageUrl) {
  let url;
  try { url = new URL(pageUrl); } catch { return []; }
  if (!/^https?:$/.test(url.protocol)) return [];
  const path = url.pathname.replace(/\/+$/, "");
  const stripped = path.replace(/\/(application|apply|applications?\/new|apply-now)(\/.*)?$/i, "");
  const out = [];
  if (stripped && stripped !== path) out.push(`${url.origin}${stripped}`);
  out.push(`${url.origin}${path}${url.search}`);
  return [...new Set(out)];
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|ul|ol|tr)>|<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, code) => {
      if (code[0] === "#") {
        const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Longest string under a key (or a parent key) that looks like a job
// description, skipping translation tables and legal boilerplate.
function longestDescription(value, depth = 0, key = "", underDescription = false) {
  if (depth > 14 || value == null) return "";
  const isDescription = underDescription || /description|jobdescription|^content$|^body$/i.test(key);
  if (typeof value === "string") return isDescription && value.length > 200 ? value : "";
  let best = "";
  const entries = Array.isArray(value) ? value.map((v) => [key, v]) : Object.entries(value);
  for (const [k, v] of entries) {
    if (/i18n|translation|locale|^eeo|legal|disclaimer|footer|^seo|^meta|notice/i.test(k)) continue;
    const found = longestDescription(v, depth + 1, k, isDescription);
    if (found.length > best.length) best = found;
  }
  return best;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Extract the job description text from a posting page's HTML.
export function extractJobDescription(html) {
  const source = String(html || "");
  for (const match of source.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    const data = parseJson(match[1]);
    const items = [].concat(data?.["@graph"] || data || []);
    const posting = items.find((item) => /JobPosting/i.test(String(item?.["@type"] || "")));
    if (posting?.description) return htmlToText(posting.description).slice(0, MAX_LENGTH);
  }
  const embedded = [
    source.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1],
    source.match(/window\.__appData\s*=\s*(\{[\s\S]*?\});\s*(?:window\.|<\/script>)/)?.[1],
  ];
  for (const json of embedded) {
    const found = json ? longestDescription(parseJson(json)) : "";
    if (found) return htmlToText(found).slice(0, MAX_LENGTH);
  }
  const meta = source.match(/<meta[^>]+(?:property|name)=["'](?:og:)?description["'][^>]+content=["']([^"']{80,})["']/i)?.[1];
  return meta ? htmlToText(meta).slice(0, MAX_LENGTH) : "";
}
