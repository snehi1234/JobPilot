const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const readSource = (name) => readFileSync(path.join(root, name), "utf8");
const flush = () => new Promise(setImmediate);

function makeStorage(initial) {
  const state = { ...initial };
  const listeners = [];
  const storage = {
    local: {
      async get(keys) {
        if (storage.failReads) throw new Error("Storage unavailable");
        return Object.fromEntries([].concat(keys).map((key) => [key, state[key]]));
      },
      async set(values) {
        if (storage.failWrites) throw new Error("Storage unavailable");
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: state[key], newValue: value };
          state[key] = value;
        }
        listeners.forEach((listener) => listener(changes, "local"));
      },
      async remove(keys) {
        const changes = {};
        for (const key of [].concat(keys)) {
          changes[key] = { oldValue: state[key] };
          delete state[key];
        }
        listeners.forEach((listener) => listener(changes, "local"));
      },
    },
    onChanged: { addListener: (listener) => listeners.push(listener) },
  };
  return { storage, state };
}

async function contentHarness(initial = {}) {
  const store = makeStorage({
    auth: { idToken: "test-token", user: { sub: "test-user" } },
    profile: "Synthetic test profile",
    ...initial,
  });
  const messages = [];
  const applied = [];
  const errors = [];
  const toasts = [];
  const harness = { ...store, messages, applied, errors, toasts, expansions: 0 };
  const window = { innerWidth: 1280, innerHeight: 800 };
  window.top = window;
  const context = vm.createContext({
    window,
    location: { hostname: "example.invalid", href: "https://example.invalid/" },
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      addEventListener() {},
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console: { log() {}, warn() {}, error: (...args) => errors.push(args) },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    chrome: {
      storage: store.storage,
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage(message) {
          messages.push(message);
          if (message.type === "COUNT_ENTRIES") {
            return harness.onParse ? harness.onParse() : { counts: {}, entries: {} };
          }
          if (message.type === "GENERATE_ANSWERS") {
            return harness.onGenerate
              ? harness.onGenerate()
              : { suggestions: [{ id: "name", value: "Test Person" }] };
          }
          return {};
        },
      },
    },
  });
  vm.runInContext(readSource("content-ui.js"), context);
  vm.runInContext(readSource("content-match.js"), context);
  vm.runInContext(readSource("content.js"), context);
  await flush();
  context.jpToast = (...args) => toasts.push(args);
  context.jpChooseResume = async () => ({ resumeId: "default", name: "Resume", text: "", reason: "only" });
  context.jpFinishAutofill = async () => {};
  context.jpShowChecklist = () => {};
  context.expandRepeatableSections = async () => { harness.expansions++; return 0; };
  context.detectFields = () => [{ id: "name", kind: "text", label: "Name" }];
  context.scrapeJobContext = () => ({ title: "Test role" });
  context.applyAnswers = async (suggestions) => {
    applied.push(suggestions);
    return { filled: suggestions.length, stale: false };
  };
  harness.context = context;
  return harness;
}

for (const consent of [undefined, false, null, "true"]) {
  test(`no automatic AI requests without explicit boolean consent: ${consent}`, async () => {
    const h = await contentHarness({ autoFillEnabled: consent });
    await h.context.maybeAutoFill();
    await h.context.runAutofillFromButton(true);
    assert.equal(h.messages.length, 0);
    assert.equal(h.expansions, 0);
    assert.equal(h.applied.length, 0);
  });
}

test("manual autofill still works with automatic filling disabled", async () => {
  const h = await contentHarness({ autoFillEnabled: false });
  await h.context.runAutofillFromButton(false);
  assert.deepEqual(h.messages.map((message) => message.type), ["COUNT_ENTRIES", "GENERATE_ANSWERS"]);
  assert.equal(h.applied.length, 1);
});

test("explicit opt-in permits just one automatic run per page, including concurrent checks", async () => {
  const h = await contentHarness({ autoFillEnabled: true });
  await Promise.all([h.context.maybeAutoFill(), h.context.maybeAutoFill()]);
  await h.context.maybeAutoFill();
  assert.equal(h.messages.length, 2);
  assert.equal(h.applied.length, 1);
});

for (const initial of [
  { fabEnabled: false },
  { auth: null },
  { profile: "", structured: {}, uploadedResumeText: "" },
]) {
  test(`automatic filling respects prerequisites: ${JSON.stringify(initial)}`, async () => {
    const h = await contentHarness({ autoFillEnabled: true, ...initial });
    await h.context.maybeAutoFill();
    assert.equal(h.messages.length, 0);
    assert.equal(h.applied.length, 0);
  });
}

test("revoking consent while parsing prevents form expansion and generation", async () => {
  const h = await contentHarness({ autoFillEnabled: true });
  let finish;
  h.onParse = () => new Promise((resolve) => { finish = resolve; });
  const running = h.context.maybeAutoFill();
  await flush();
  assert.equal(typeof finish, "function");
  await h.storage.local.set({ autoFillEnabled: false });
  finish({ counts: {}, entries: {} });
  await running;
  assert.equal(h.messages.length, 1);
  assert.equal(h.expansions, 0);
  assert.equal(h.applied.length, 0);
});

test("revoking consent while generating prevents applying returned answers", async () => {
  const h = await contentHarness({ autoFillEnabled: true });
  let finish;
  h.onGenerate = () => new Promise((resolve) => { finish = resolve; });
  const running = h.context.maybeAutoFill();
  await flush();
  assert.equal(typeof finish, "function");
  await h.storage.local.set({ autoFillEnabled: false });
  finish({ suggestions: [{ id: "name", value: "Test Person" }] });
  await running;
  assert.equal(h.applied.length, 0);
});

test("a preference-read failure blocks automatic requests and is logged", async () => {
  const h = await contentHarness({ autoFillEnabled: true });
  h.storage.failReads = true;
  await h.context.maybeAutoFill();
  assert.equal(h.messages.length, 0);
  assert.equal(h.errors.length, 1);
});

test("a resume-parsing quota error stops before expansion or another AI request", async () => {
  const h = await contentHarness({ autoFillEnabled: true });
  h.onParse = () => ({ error: "Groq quota reached (429)." });
  await h.context.maybeAutoFill();
  assert.equal(h.messages.length, 1);
  assert.equal(h.expansions, 0);
  assert.equal(h.applied.length, 0);
  assert.ok(h.toasts.some(([message]) => message.includes("Groq quota reached")));
});

function authHarness(previousSub, nextSub) {
  const store = makeStorage({
    auth: { user: { sub: previousSub }, idToken: "old-test-token" },
    autoFillEnabled: true,
  });
  const claims = { sub: nextSub, nonce: "test-nonce", exp: 9999999999 };
  const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const context = vm.createContext({
    GOOGLE_CLIENT_ID: "test-client",
    atob: (text) => Buffer.from(text, "base64").toString("binary"),
    URL,
    URLSearchParams,
    crypto: { randomUUID: () => "test-nonce" },
    chrome: {
      storage: store.storage,
      identity: {
        getRedirectURL: () => "https://test.chromiumapp.org/",
        launchWebAuthFlow: async () => `https://test.chromiumapp.org/#id_token=${token}`,
      },
    },
  });
  vm.runInContext(readSource("auth.js").replace(/^import .*;\r?$/gm, "").replace(/^export /gm, ""), context);
  return { ...store, context };
}

test("sign-out removes automatic-filling consent", async () => {
  const h = authHarness("same-user", "same-user");
  await h.context.signOut();
  assert.equal(h.state.auth, undefined);
  assert.equal(h.state.autoFillEnabled, undefined);
});

test("account change resets consent; same-account token refresh preserves it", async () => {
  const changed = authHarness("old-user", "new-user");
  await changed.context.signIn();
  assert.equal(changed.state.autoFillEnabled, false);
  const unchanged = authHarness("same-user", "same-user");
  await unchanged.context.signIn({ interactive: false });
  assert.equal(unchanged.state.autoFillEnabled, true);
});

test("the opt-in control is unchecked and disabled until preferences load", () => {
  const html = readSource("sidepanel.html");
  const input = html.match(/<input\b[^>]*\bid="autoFillToggle"[^>]*>/)[0];
  assert.doesNotMatch(input, /\bchecked\b/);
  assert.match(input, /\bdisabled\b/);
  assert.match(input, /aria-describedby="autoFillDisclosure"/);
  assert.match(html, /Off by default/);
  assert.match(html, /AI service/);
  assert.match(html, /review answers before you submit/);
});

test("the real side-panel toggle persists consent and reports storage errors", async () => {
  const store = makeStorage({});
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: "", checked: false, disabled: false, listeners: {},
        classList: { add() {}, remove() {}, toggle() {} },
        removeAttribute() {},
        addEventListener(name, handler) { this.listeners[name] = handler; },
      });
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [] },
    pdfjsLib: { GlobalWorkerOptions: {} },
    isAuthConfigured: () => true,
    getCurrentUser: async () => null,
    console: { log() {}, error() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    chrome: {
      storage: store.storage,
      runtime: { getURL: (name) => name },
      tabs: {
        query: async () => [],
        onActivated: { addListener() {} },
        onUpdated: { addListener() {} },
      },
    },
  });
  vm.runInContext(readSource("sidepanel.js").replace(/^import .*;\r?$/gm, ""), context);
  await flush();
  const toggle = element("autoFillToggle");
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, false);
  toggle.checked = true;
  await toggle.listeners.change();
  assert.equal(store.state.autoFillEnabled, true);
  toggle.checked = false;
  store.storage.failWrites = true;
  await toggle.listeners.change();
  assert.equal(store.state.autoFillEnabled, true);
  assert.equal(toggle.checked, true);
  assert.match(element("status").textContent, /Could not save/);
  store.storage.failWrites = false;
  await store.storage.local.remove("autoFillEnabled");
  assert.equal(toggle.checked, false);
});
