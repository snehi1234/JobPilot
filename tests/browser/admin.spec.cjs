const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const ORIGIN = "https://admin.hiresprint.test";
const publicDir = path.resolve(__dirname, "..", "..", "backend", "public");

function fakeToken(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;
}

const now = Date.now();
const REPORTS = [
  { id: 3, createdAt: new Date(now - 3600e3).toISOString(), type: "bug", status: "new", email: "jane@example.com",
    message: '<img src=x onerror="window.__xss=1">School field not filled', reporter: "abc123",
    details: { site: "jobs.ashbyhq.com/plaid/1/application", version: "0.5.0", browser: "Chrome/150",
      fields: { found: 12, filled: 9, needs: 3, missing: ["School", "Degree"] }, lastError: "Couldn't autofill" } },
  { id: 2, createdAt: new Date(now - 2 * 86400e3).toISOString(), type: "idea", status: "new", email: "",
    message: "Support Workday better", reporter: "def456", details: { version: "0.5.0" } },
  { id: 1, createdAt: new Date(now - 3 * 86400e3).toISOString(), type: "site", status: "fixed", email: "",
    message: "Greenhouse dropdowns", reporter: "ghi789", details: { site: "boards.greenhouse.io/acme/jobs/9", version: "0.4.0" } },
];

async function openAdmin(page, { status = 200 } = {}) {
  const patches = [];
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/admin") return route.fulfill({ contentType: "text/html", body: fs.readFileSync(path.join(publicDir, "admin.html")) });
    if (url.pathname === "/admin.js") return route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(path.join(publicDir, "admin.js")) });
    if (url.pathname === "/icon128.png") return route.fulfill({ contentType: "image/png", body: fs.readFileSync(path.join(publicDir, "icon128.png")) });
    if (url.pathname === "/api/admin-feedback") {
      if (url.searchParams.has("config")) return route.fulfill({ json: { clientId: "test-client" } });
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      if (status !== 200) return route.fulfill({ status, json: { error: "This account is not an admin." } });
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON();
        patches.push(body);
        const report = REPORTS.find((r) => r.id === body.id);
        return route.fulfill({ json: { report: { ...report, status: body.status } } });
      }
      return route.fulfill({ json: { admin: "owner@example.com", reports: REPORTS } });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.route("https://accounts.google.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.goto(`${ORIGIN}/admin`);
  await page.evaluate((t) => sessionStorage.setItem("hs_admin_token", t), fakeToken({ email: "owner@example.com" }));
  await page.reload();
  return patches;
}

test("admin page lists reports safely, filters them, and updates status", async ({ page }) => {
  const patches = await openAdmin(page);
  await expect(page.locator("#who")).toHaveText("owner@example.com");
  // Opens on "New"; counts per status.
  await expect(page.locator("#stats .stat.active")).toContainText("2New");
  await expect(page.locator(".card")).toHaveCount(2);

  // Report text is shown literally, never run as HTML.
  const first = page.locator(".card").first();
  await expect(first.locator(".msg")).toHaveText('<img src=x onerror="window.__xss=1">School field not filled');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await expect(first).toContainText("Not filled: School · Degree");
  await expect(first).toContainText("Last error: Couldn't autofill");
  await expect(first.locator("a[href^='mailto:jane@example.com']")).toBeVisible();
  await expect(page.locator(".card").nth(1).locator("a[href^='mailto:']")).toHaveCount(0);

  // Sidebar summaries.
  await expect(page.locator("#topSites")).toContainText("jobs.ashbyhq.com — 1");
  await expect(page.locator("#versions")).toContainText("v0.5.0 — 2");

  // Filters and search.
  await page.locator("#typeFilter").selectOption("idea");
  await expect(page.locator(".card")).toHaveCount(1);
  await page.locator("#typeFilter").selectOption("");
  await page.locator("#stats .stat", { hasText: "All" }).click();
  await expect(page.locator(".card")).toHaveCount(3);
  await page.locator("#search").fill("greenhouse");
  await expect(page.locator(".card")).toHaveCount(1);
  await page.locator("#search").fill("");

  // Changing status saves it and moves the counts.
  await page.locator(".card", { hasText: "Support Workday" }).getByRole("button", { name: "In progress" }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ id: 2, status: "in-progress" });
  await expect(page.locator("#stats .stat", { hasText: "In progress" })).toContainText("1");
});

test("a non-admin account sees a clear message and no reports", async ({ page }) => {
  await openAdmin(page, { status: 403 });
  await expect(page.locator("#gateError")).toHaveText("This Google account isn't an admin of Hiresprint.");
  await expect(page.locator("#app")).toBeHidden();
  expect(await page.evaluate(() => sessionStorage.getItem("hs_admin_token"))).toBeNull();
});
