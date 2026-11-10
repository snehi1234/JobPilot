// lib/resumes.js — validation for the saved resume list (text only; the
// original files never leave the user's device).

export const MAX_RESUMES = 5;
const MAX_NAME = 60;
const MAX_TEXT = 60000;
const MAX_FILE_NAME = 200;

const str = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

export function sanitizeResumes(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = str(item.id, 40).replace(/[^\w-]/g, "");
    const text = str(item.text, MAX_TEXT);
    if (!id || !text.trim() || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: str(item.name, MAX_NAME).trim() || "Resume",
      text,
      fileName: str(item.fileName, MAX_FILE_NAME),
      fileType: str(item.fileType, 100),
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
      isDefault: item.isDefault === true,
    });
    if (out.length === MAX_RESUMES) break;
  }
  if (out.length && !out.some((r) => r.isDefault)) out[0].isDefault = true;
  return out;
}
