import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";
import events from "../api/events.js";
import adminFeedback from "../api/admin-feedback.js";
import { sanitizeEvents, cleanProps, cleanInstallId } from "../lib/events.js";

const CLIENT_ID = "test-client.apps.googleusercontent.com";
const DB = "https://db.example.invalid";
const INSTALL = "3f2b8c1e-1111-4222-8333-444455556666";
let signingKey;
let publicJwk;

before(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]);
  signingKey = pair.privateKey;
  publicJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };
});

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.SUPABASE_URL = DB;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  process.env.ADMIN_EMAILS = "admin@example.com";
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

function fakeDb(t) {
  const inserted = [];
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const u = new URL(url);
    if (u.href === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [publicJwk] });
    assert.equal(u.origin, DB, `unexpected request to ${url}`);
    const method = options.method || "GET";
    calls.push({ method, path: u.pathname, body: options.body ? JSON.parse(options.body) : undefined });
    if (u.pathname === "/rest/v1/events" && method === "POST") {
      inserted.push(...JSON.parse(options.body));
      return new Response(null, { status: 201 });
    }
    if (u.pathname === "/rest/v1/events" && method === "DELETE") return new Response(null, { status: 204 });
    if (u.pathname === "/rest/v1/rpc/admin_metrics") return Response.json({ totals: { accounts: 3 }, days: JSON.parse(options.body).p_days });
    throw new Error(`unexpected ${method} ${u.pathname}`);
  });
  return { inserted, calls };
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

async function call(handler, { method = "POST", auth, body, query = {} } = {}) {
  const r = res();
  await handler({ method, headers: { origin: "chrome-extension://test", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body, query }, r);
  return r;
}

test("cleanProps keeps only allowed, small, non-identifying values", () => {
  const out = cleanProps({ fields: 12.6, seconds: -5, score: 400, platform: "Workday", source: "Page!", url: "https://x.com/jobs/1", answer: "secret" });
  assert.deepEqual(out, { fields: 13, seconds: 0, score: 100, source: "page", platform: "workday" });
  assert.equal(cleanProps({ platform: "evil.example.com" }).platform, "other");
});

test("sanitizeEvents drops unknown events and clamps timestamps", () => {
  const now = Date.parse("2026-11-13T00:00:00Z");
  const { ok, rows } = sanitizeEvents({
    installId: INSTALL, version: "0.7.0",
    events: [
      { name: "autofill", ts: now - 1000, props: { fields: 9 } },
      { name: "keystroke", ts: now },
      { name: "sign_in", ts: now - 30 * 86400_000 },
      { name: "tailor", ts: now + 3600_000 },
    ],
  }, { now, userSub: "u1" });
  assert.ok(ok);
  assert.deepEqual(rows.map((r) => r.name), ["autofill", "sign_in", "tailor"]);
  assert.equal(rows[0].created_at, new Date(now - 1000).toISOString());
  assert.equal(rows[1].created_at, new Date(now).toISOString(), "too old → server time");
  assert.equal(rows[2].created_at, new Date(now).toISOString(), "future → server time");
  assert.ok(rows.every((r) => r.user_sub === "u1" && r.version === "0.7.0" && r.install_id === INSTALL));
  assert.equal(sanitizeEvents({ installId: "bad id!", events: [] }).ok, false);
  assert.equal(cleanInstallId("x".repeat(65)), "");
});

test("POST /api/events stores events without sign-in", async (t) => {
  const db = fakeDb(t);
  const r = await call(events, { body: { installId: INSTALL, version: "0.7.0", events: [{ name: "install" }, { name: "autofill", props: { fields: 7, platform: "greenhouse" } }] } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.stored, 2);
  assert.equal(db.inserted.length, 2);
  assert.equal(db.inserted[0].user_sub, null);
  assert.deepEqual(db.inserted[1].props, { fields: 7, platform: "greenhouse" });
});

test("POST /api/events links signed-in users and ignores bad tokens", async (t) => {
  const db = fakeDb(t);
  const good = await call(events, { auth: await token({ sub: "user-9", email: "a@b.c" }), body: { installId: "aaaaaaaa-0000-4000-8000-000000000001", events: [{ name: "sign_in" }] } });
  assert.equal(good.statusCode, 200);
  assert.equal(db.inserted[0].user_sub, "user-9");
  const bad = await call(events, { auth: "not-a-token", body: { installId: "aaaaaaaa-0000-4000-8000-000000000002", events: [{ name: "autofill" }] } });
  assert.equal(bad.statusCode, 200, "a bad token never blocks usage events");
  assert.equal(db.inserted[1].user_sub, null);
});

test("POST /api/events rejects a missing install id", async (t) => {
  fakeDb(t);
  const r = await call(events, { body: { events: [{ name: "install" }] } });
  assert.equal(r.statusCode, 400);
});

test("GET /api/events?uninstall records the uninstall and redirects to the goodbye page", async (t) => {
  const db = fakeDb(t);
  const r = await call(events, { method: "GET", query: { uninstall: "1", i: "bbbbbbbb-0000-4000-8000-000000000003", v: "0.7.0" } });
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.Location, "/goodbye.html?i=bbbbbbbb-0000-4000-8000-000000000003");
  assert.equal(db.inserted[0].name, "uninstall");
  assert.equal(db.inserted[0].version, "0.7.0");
});

test("admin metrics are admin-only and pass the period through", async (t) => {
  const db = fakeDb(t);
  const denied = await call(adminFeedback, { method: "GET", auth: await token({ sub: "u2", email: "someone@example.com" }), query: { view: "metrics" } });
  assert.equal(denied.statusCode, 403);
  const ok = await call(adminFeedback, { method: "GET", auth: await token({ sub: "u3", email: "admin@example.com" }), query: { view: "metrics", days: "7" } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.metrics.totals.accounts, 3);
  assert.equal(db.calls.at(-1).body.p_days, 7);
  const clamped = await call(adminFeedback, { method: "GET", auth: await token({ sub: "u3", email: "admin@example.com" }), query: { view: "metrics", days: "999" } });
  assert.equal(clamped.body.metrics.days, 90);
});
