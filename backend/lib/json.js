// Strip markdown fences and salvage JSON from a model response.
export function extractJson(text) {
  let cleaned = (text || "").trim();
  cleaned = cleaned.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(cleaned);
  } catch {
    // Recover complete { ... } objects from a truncated array.
    const objects = [];
    const objRegex = /\{[^{}]*\}/g;
    let m;
    while ((m = objRegex.exec(cleaned)) !== null) {
      try {
        const obj = JSON.parse(m[0]);
        if (obj && typeof obj === "object" && "value" in obj) objects.push(obj);
      } catch {
        /* skip */
      }
    }
    return { suggestions: objects };
  }
}
