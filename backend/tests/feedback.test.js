import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";
import feedback from "../api/feedback.js";
import adminFeedback from "../api/admin-feedback.js";
import profile from "../api/profile.js";
import { sanitizeFeedback, sanitizeDetails, cleanSite, isAdmin, toAdminView } from "../lib/feedback.js";

const CLIENT_ID = "test-client.apps.googleusercontent.com";
const DB = "https://db.example.invalid";
let signingKey;
let publicJwk;

before(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]);
  signingKey = pair.privateKey;
  publicJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };
});

const b64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function token(claims) {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-kid", typ: "JWT" })));
  const payload = b64url(Buffer.from(JSON.stringify({
    iss: "https://accounts.google.com", aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600, email_verified: true, ...claims,
  })));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

// In-memory stand-in for the database's REST API (feedback + profiles).
function fakeDb(t) {
  const rows = [];
  let nextId = 1;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const u = new URL(url);
    if (u.href === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [publicJwk] });
    assert.equal(u.origin, DB, `unexpected request to ${url}`);
    const method = options.method || "GET";
    calls.push({ method, path: u.pathname, query: u.search });
    const eq = (name) => u.searchParams.get(name)?.replace(/^eq\./, "");
    if (u.pathname === "/rest/v1/profiles") return method === "DELETE" ? new Response(null, { status: 204 }) : Response.json([]);
    assert.equal(u.pathname, "/rest/v1/feedback");
    if (method === "POST") {
      const row = { id: nextId++, created_at: new Date().toISOString(), updated_at: null, ...JSON.parse(options.body) };
      rows.push(row);
      return Response.json([row], { status: 201 });
    }
    if (method === "GET") {
      let out = rows.slice();
      if (eq("user_sub")) out = out.filter((r) => r.user_sub === eq("user_sub"));
      const since = u.searchParams.get("created_at")?.replace(/^gte\./, "");
      if (since) out = out.filter((r) => r.created_at >= since);
      return Response.json(out.sort((a, b) => b.id - a.id));
    }
    if (method === "PATCH") {
      const row = rows.find((r) => String(r.id) === eq("id"));
      if (row) Object.assign(row, JSON.parse(options.body));
      return Response.json(row ? [row] : []);
    }
    if (method === "DELETE") {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].user_sub === eq("user_sub")) rows.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${method}`);
  });
  return { rows, calls };
}

function res() {
  return {
    statusCode: 200, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

async function call(handler, { method = "GET", auth, body, query = {} } = {}) {
  const r = res();
  await handler({ method, headers: { origin: "chrome-extension://test", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body, query }, r);
  return r;
}

beforeEach((t) => {
  const settings = { GOOGLE_CLIENT_ID: CLIENT_ID, ADMIN_EMAILS: "Admin@Example.com", SUPABASE_URL: DB, SUPABASE_SERVICE_ROLE_KEY: "test-service-key" };
  const previous = Object.fromEntries(Object.keys(settings).map((k) => [k, process.env[k]]));
  Object.assign(process.env, settings);
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
});

const report = (overrides = {}) => ({
  type: "bug", message: "School field was not filled", contactOk: false, includeDetails: true,
  details: {
    site: "https://jobs.ashbyhq.com/acme/123/application?utm_source=x&email=me@x.com#top",
    version: "0.5.0", browser: "Chrome 150", lastError: "", attach: "attached",
    fields: { found: 12, filled: 9, needs: 3, missing: ["School", "Degree"] },
    resumeText: "SECRET RESUME", answers: { email: "me@x.com" },
  },
  ...overrides,
});

test("reports are cleaned: no query strings, no unknown fields, valid types only", () => {
  assert.equal(cleanSite("https://jobs.ashbyhq.com/acme/123/application?utm_source=x#top"), "jobs.ashbyhq.com/acme/123/application");
  assert.equal(cleanSite("javascript:alert(1)"), "");
  const d = sanitizeDetails(report().details);
  assert.equal(JSON.stringify(Object.keys(d).sort()), JSON.stringify(["attach", "browser", "fields", "site", "version"]));
  assert.equal(JSON.stringify(d.fields.missing), JSON.stringify(["School", "Degree"]));
  assert.equal(sanitizeFeedback({ type: "evil", message: "hello there" }).value.type, "other");
  assert.equal(sanitizeFeedback({ message: " " }).ok, false);
  assert.equal(JSON.stringify(sanitizeFeedback({ message: "hi there", includeDetails: false, details: report().details }).value.details), "{}");
  assert.equal(sanitizeFeedback({ message: "x".repeat(5000) }).value.message.length, 2000);
});

test("only verified admin emails are admins", () => {
  assert.equal(isAdmin({ email: "admin@example.com", email_verified: true }, "Admin@Example.com"), true);
  assert.equal(isAdmin({ email: "admin@example.com", email_verified: false }, "admin@example.com"), false);
  assert.equal(isAdmin({ email: "user@example.com", email_verified: true }, "admin@example.com"), false);
  assert.equal(isAdmin({ email: "admin@example.com", email_verified: true }, ""), false);
  assert.equal(isAdmin(null, "admin@example.com"), false);
  assert.equal(toAdminView({ id: 1, email: "a@b.co", contact_ok: false }).email, "");
  assert.equal(toAdminView({ id: 1, email: "a@b.co", contact_ok: true }).email, "a@b.co");
});

test("signed-in users can send feedback; it's stored without personal data", async (t) => {
  const db = fakeDb(t);
  const anon = await call(feedback, { method: "POST", body: report() });
  assert.equal(anon.statusCode, 401);

  const user = await token({ sub: "user-1", email: "user@example.com" });
  const sent = await call(feedback, { method: "POST", auth: user, body: report() });
  assert.equal(sent.statusCode, 200);
  assert.equal(db.rows.length, 1);
  const row = db.rows[0];
  assert.equal(row.user_sub, "user-1");
  assert.equal(row.status, "new");
  assert.equal(row.details.site, "jobs.ashbyhq.com/acme/123/application");
  assert.doesNotMatch(JSON.stringify(row), /SECRET RESUME|me@x\.com|utm_source/);
});

test("each user can send at most 5 reports a day", async (t) => {
  fakeDb(t);
  const user = await token({ sub: "user-limit", email: "u@example.com" });
  for (let i = 0; i < 5; i++) assert.equal((await call(feedback, { method: "POST", auth: user, body: report() })).statusCode, 200);
  const sixth = await call(feedback, { method: "POST", auth: user, body: report() });
  assert.equal(sixth.statusCode, 429);
  assert.match(sixth.body.error, /5 reports a day/);
});

test("the admin API is closed to everyone except verified admins", async (t) => {
  const db = fakeDb(t);
  const user = await token({ sub: "user-2", email: "user2@example.com" });
  await call(feedback, { method: "POST", auth: user, body: report({ contactOk: true }) });
  await call(feedback, { method: "POST", auth: user, body: report({ message: "No contact please", contactOk: false }) });

  assert.equal((await call(adminFeedback, {})).statusCode, 401, "no token");
  assert.equal((await call(adminFeedback, { auth: "not.a.token" })).statusCode, 401, "bad token");
  assert.equal((await call(adminFeedback, { auth: user })).statusCode, 403, "regular user");
  const unverified = await token({ sub: "x", email: "admin@example.com", email_verified: false });
  assert.equal((await call(adminFeedback, { auth: unverified })).statusCode, 403, "unverified email");
  const otherApp = await token({ sub: "x", email: "admin@example.com", aud: "someone-else" });
  assert.equal((await call(adminFeedback, { auth: otherApp })).statusCode, 401, "token for another app");
  assert.equal((await call(adminFeedback, { method: "PATCH", auth: user, body: { id: 1, status: "fixed" } })).statusCode, 403);
  assert.equal(db.rows[0].status, "new", "non-admins can't change status");

  const admin = await token({ sub: "admin", email: "admin@example.com" });
  const list = await call(adminFeedback, { auth: admin });
  assert.equal(list.statusCode, 200);
  assert.equal(list.headers["Cache-Control"], "no-store");
  assert.equal(list.body.reports.length, 2);
  const byMessage = Object.fromEntries(list.body.reports.map((r) => [r.message, r]));
  assert.equal(byMessage["School field was not filled"].email, "user2@example.com");
  assert.equal(byMessage["No contact please"].email, "", "email hidden unless the user agreed to contact");
  assert.equal(JSON.stringify(Object.keys(byMessage["No contact please"])).includes("user_sub"), false);

  const updated = await call(adminFeedback, { method: "PATCH", auth: admin, body: { id: 1, status: "fixed" } });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.report.status, "fixed");
  assert.equal((await call(adminFeedback, { method: "PATCH", auth: admin, body: { id: 1, status: "deleted" } })).statusCode, 400);
  assert.equal((await call(adminFeedback, { method: "PATCH", auth: admin, body: { id: 999, status: "fixed" } })).statusCode, 404);

  const config = await call(adminFeedback, { query: { config: "1" } });
  assert.equal(config.body.clientId, CLIENT_ID);
});

test("the admin API stays closed when no admin is configured", async (t) => {
  fakeDb(t);
  process.env.ADMIN_EMAILS = "";
  const admin = await token({ sub: "admin", email: "admin@example.com" });
  assert.equal((await call(adminFeedback, { auth: admin })).statusCode, 503);
});

test("deleting your data also deletes your feedback", async (t) => {
  const db = fakeDb(t);
  const user = await token({ sub: "user-3", email: "u3@example.com" });
  const other = await token({ sub: "user-4", email: "u4@example.com" });
  await call(feedback, { method: "POST", auth: user, body: report() });
  await call(feedback, { method: "POST", auth: other, body: report() });
  const deleted = await call(profile, { method: "DELETE", auth: user });
  assert.equal(deleted.statusCode, 200);
  assert.equal(JSON.stringify(db.rows.map((r) => r.user_sub)), JSON.stringify(["user-4"]));
});
