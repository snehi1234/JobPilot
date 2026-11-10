const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "lib", "job-description.mjs")).href);
const JD = "<h2>About the role</h2><p>Build backend services in Java &amp; Python.</p><ul><li>Kubernetes</li><li>PostgreSQL</li></ul>" + " More detail.".repeat(30);

test("application URLs map to their posting pages", async () => {
  const { postingUrlCandidates } = await load();
  assert.deepEqual(postingUrlCandidates("https://jobs.ashbyhq.com/openai/abc-123/application?utm_source=x"),
    ["https://jobs.ashbyhq.com/openai/abc-123", "https://jobs.ashbyhq.com/openai/abc-123/application?utm_source=x"]);
  assert.equal(postingUrlCandidates("https://ats.rippling.com/rippling/jobs/53ea/apply?step=application")[0],
    "https://ats.rippling.com/rippling/jobs/53ea");
  assert.deepEqual(postingUrlCandidates("https://boards.greenhouse.io/acme/jobs/1"), ["https://boards.greenhouse.io/acme/jobs/1"]);
  assert.deepEqual(postingUrlCandidates("chrome://extensions"), []);
});

test("descriptions are read from JSON-LD, Next.js data, and Ashby app data", async () => {
  const { extractJobDescription } = await load();
  const ld = `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", description: JD })}</script>`;
  assert.match(extractJobDescription(ld), /Build backend services in Java & Python\.\n• Kubernetes/);

  const next = {
    props: { pageProps: {
      _nextI18Next: { store: { aiNotice: { description: "We use AI to review applications. ".repeat(20) } } },
      apiData: { jobPost: { description: { company: "<p>About us</p>" + " x".repeat(150), role: JD }, legalNotice: "L".repeat(5000) } },
    } },
  };
  const nextHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>`;
  const fromNext = extractJobDescription(nextHtml);
  assert.match(fromNext, /Kubernetes/, "nested role description wins over translations and legal text");
  assert.doesNotMatch(fromNext, /We use AI/);

  const ashby = `<script>window.__appData = ${JSON.stringify({ posting: { title: "Engineer", descriptionHtml: JD } })};</script>`;
  assert.match(extractJobDescription(ashby), /PostgreSQL/);

  assert.equal(extractJobDescription("<html><body>Apply now</body></html>"), "");
});

test("HTML is turned into readable text", async () => {
  const { htmlToText } = await load();
  assert.equal(htmlToText("<p>A&nbsp;&amp;&#39;B&#x27;</p><script>x()</script><ul><li>one</li><li>two</li></ul>"), "A &'B'\n• one\n• two");
});
