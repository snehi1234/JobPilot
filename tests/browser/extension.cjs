const { test: base, chromium, expect } = require("@playwright/test");
const path = require("node:path");

const root = process.env.JOBPILOT_EXTENSION_DIR || path.resolve(__dirname, "..", "..");
const backend = "https://backend-alpha-seven-87.vercel.app";
const profile = {
  firstName: "Alex",
  lastName: "Example",
  email: "alex@example.com",
  phone: "+1 202-555-0142",
  location: "Seattle, Washington",
  linkedin: "https://www.linkedin.com/in/example",
  website: "https://example.com",
};
const entries = {
  experience: [{ position: "Engineer", organization: "Example Inc", startDate: "09/2024", endDate: "Present" }],
  education: [{ institution: "Example University", degree: "Master of Science", major: "Computer Science", graduationDate: "05/2023" }],
};

const test = base.extend({
  app: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
      ...(process.env.JOBPILOT_RECORD_DIR ? { recordVideo: { dir: process.env.JOBPILOT_RECORD_DIR, size: { width: 1280, height: 720 } } } : {}),
    });
    const api = { calls: [], profile: null, suggestions: null, profileStatus: 200, errors: [] };
    context.on("page", page => {
      page.on("pageerror", error => api.errors.push(error.message));
      page.on("console", message => {
        if (["error", "warning"].includes(message.type()) && message.text().includes("[Hiresprint]")) api.errors.push(message.text());
      });
    });
    await context.route(`${backend}/**`, async (route) => {
      const request = route.request();
      const endpoint = new URL(request.url()).pathname;
      const body = request.postDataJSON();
      api.calls.push({ endpoint, method: request.method(), body });
      let response;
      if (endpoint === "/api/profile") {
        if (api.profileStatus !== 200) {
          await route.fulfill({ status: api.profileStatus, json: { error: "Synthetic profile-service failure" } });
          return;
        }
        if (request.method() === "PUT") api.profile = body;
        if (request.method() === "DELETE") api.profile = null;
        response = request.method() === "GET" ? { profile: api.profile } : { ok: true };
      } else if (endpoint === "/api/parse-resume") {
        response = { counts: { experience: 1, education: 1 }, entries, structured: api.parseStructured === undefined ? profile : api.parseStructured };
      } else if (endpoint === "/api/tailor") {
        api.tailorCalls = (api.tailorCalls || 0) + 1;
        const line = String(body.resume || "").split("\n").find((l) => /pipelines|microservices/.test(l)) || "";
        response = {
          summary: `Engineer focused on ${body.jobContext?.title || "this role"}.`,
          bullets: line ? [{ original: line, line, improved: `Designed and operated ${line.replace(/^.*?(ETL|Java)/, "$1")} for production analytics (${line})`, keywords: ["ETL"] }] : [],
          skills: ["Spark", "Airflow"],
          gaps: ["Go"],
        };
      } else if (endpoint === "/api/feedback") {
        api.feedback = [...(api.feedback || []), body];
        response = { ok: true, id: api.feedback.length };
      } else if (endpoint === "/api/events") {
        api.events = [...(api.events || []), { ...body, authorization: request.headers().authorization || "" }];
        response = { ok: true, stored: body?.events?.length || 0 };
      } else if (/^\/(practice|goodbye)\.(html|js)$/.test(endpoint) || endpoint === "/icon128.png") {
        const file = path.join(__dirname, "..", "..", "backend", "public", endpoint.slice(1));
        const type = endpoint.endsWith(".html") ? "text/html" : endpoint.endsWith(".js") ? "text/javascript" : "image/png";
        await route.fulfill({ path: file, contentType: type });
        return;
      } else if (endpoint === "/api/cover-letter") {
        api.coverLetters = (api.coverLetters || 0) + 1;
        response = { letter: `Dear Hiring Team,\n\nI am applying for the ${body.jobContext?.title || "open"} role. ${"I built reliable data pipelines with Spark and Airflow. ".repeat(12)}\n\nSincerely,\nAlex Example` };
      } else if (endpoint === "/api/generate") {
        if (api.generateDelayMs) await new Promise((r) => setTimeout(r, api.generateDelayMs));
        const values = {
          name: `${profile.firstName} ${profile.lastName}`,
          email: profile.email,
          "phone number": profile.phone,
          linkedin: profile.linkedin,
          github: "https://github.com/example",
          portfolio: profile.website,
          "current/last company": "Example Inc",
          degree: "Master of Science",
          "field of study": "Computer Science",
          school: "Maulana Azad National Institute of Technology (MANIT)",
          location: "Seattle, Washington",
        };
        response = {
          suggestions: (typeof api.suggestions === "function" ? api.suggestions(body.fields) : api.suggestions) ?? body.fields.flatMap((field) => {
            const value = values[field.label.replace(/\*/g, "").trim().toLowerCase()];
            return value ? [{ id: field.id, label: field.label, value, confidence: "high" }] : [];
          }),
        };
      } else {
        throw new Error(`Unexpected backend endpoint during browser test: ${endpoint}`);
      }
      await route.fulfill({ json: response });
    });
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    await worker.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({
        auth: {
          idToken: "synthetic-browser-test-token",
          user: { sub: "browser-test-user", email: "alex@example.com" },
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        fabEnabled: true,
        autoFillEnabled: false,
      });
    });
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    await expect(panel.locator("#appContent")).toBeVisible();
    // The panel's first load writes the loaded profile back to storage; wait
    // for it so it can't overwrite data a test seeds afterwards.
    await expect.poll(() => worker.evaluate(async () => "structured" in await chrome.storage.local.get("structured")), { timeout: 15000 }).toBe(true);
    try {
      await use({ context, worker, panel, api, id });
    } finally {
      await context.close();
    }
  },
});

module.exports = { test, expect, root, profile, entries };
