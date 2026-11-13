const { test, expect, profile } = require("./extension.cjs");

// Modelled on careers.roblox.com: the posting is on the company's site, and
// "Apply Now" loads Greenhouse's application in a cross-origin iframe that is
// resized to the form's full height (the outer page scrolls, not the frame).
const POSTING = "https://careers.example-games.test/jobs/8350727?gh_jid=8350727";
const EMBED = "https://job-boards.greenhouse.io/embed/job_app?for=examplegames&token=8350727";
const SOFTWARE = "Software Engineer. Python, Go, Java, Kubernetes, Docker, distributed systems, machine learning, backend services, AWS, SQL.";

const DESCRIPTION = "As a Senior Software Engineer on Content Understanding you will build machine learning systems and distributed backend services in Python and Go. "
  + "Responsibilities include designing scalable pipelines on Kubernetes and AWS. Qualifications: 5+ years of experience with distributed systems, SQL, and Docker. ".repeat(3);

const OUTER = `<!doctype html><html><head><meta charset="utf-8"><title>Senior Software Engineer, Content Understanding | Example Games</title></head>
<body style="margin:0;font-family:sans-serif">
<header style="height:80px;background:#111;color:#fff">Example Games Careers</header>
<main id="main" style="padding:20px 40px">
  <h1>Senior Software Engineer, Content Understanding</h1>
  <button id="apply" type="button">Apply Now</button>
  <section id="desc"><h2>About the role</h2><p>${DESCRIPTION}</p></section>
</main>
<div style="height:600px;background:#eee">Footer</div>
<script>
  document.getElementById("apply").onclick = () => {
    document.getElementById("desc").remove();
    document.getElementById("apply").remove();
    const f = document.createElement("iframe");
    f.id = "grnhse_iframe"; f.setAttribute("scrolling", "no"); f.title = "Greenhouse Job Board";
    f.style.cssText = "width:100%;border:0;height:150px;display:block";
    f.src = ${JSON.stringify(EMBED)};
    window.addEventListener("message", (e) => { if (e.data && e.data.h) f.style.height = e.data.h + "px"; });
    document.getElementById("main").appendChild(f);
  };
</script></body></html>`;

const FIELDS = ["First Name", "Last Name", "Email", "Phone", "LinkedIn Profile", "Website"]
  .map((l, i) => `<div style="margin:0 0 340px"><label for="f${i}">${l}</label><input id="f${i}" name="f${i}"></div>`).join("");
const FORM = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;font-family:sans-serif">
<form id="application_form" onsubmit="event.preventDefault()"><h2>Apply for this job</h2>${FIELDS}
<label for="cv">Resume/CV</label><input id="cv" type="file"><button type="submit">Submit application</button></form>
<script>
  const send = () => parent.postMessage({ h: document.documentElement.scrollHeight }, "*");
  send(); setTimeout(send, 300);
</script></body></html>`;

async function setup(app) {
  await app.worker.evaluate(async ({ details, software }) => {
    await chrome.storage.local.set({
      structured: details, uploadedResumeText: software,
      resumes: [{ id: "sw", name: "Software", text: software, fileName: "software.pdf" }], defaultResumeId: "sw",
    });
  }, { details: profile, software: SOFTWARE });
  await app.context.route("https://careers.example-games.test/**", (r) => r.fulfill({ contentType: "text/html", body: OUTER }));
  await app.context.route("https://job-boards.greenhouse.io/embed/**", (r) => r.fulfill({ contentType: "text/html", body: FORM }));
  const page = await app.context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(POSTING);
  return page;
}

// The button's position in the browser window (iframe offset + position in the frame).
async function fabOnScreen(page) {
  const frame = page.frameLocator("#grnhse_iframe");
  const inner = await frame.locator("#jobpilot-fab").boundingBox();
  return inner; // Playwright reports frame elements in main-page viewport coordinates.
}

test("a company careers posting shows the resume match badge before applying", async ({ app }) => {
  const page = await setup(app);
  const badge = page.locator("#hiresprint-match");
  await expect(badge).toBeAttached({ timeout: 15000 });
  const text = await badge.evaluate((host) => host.shadowRoot.querySelector(".pill").innerText.replace(/\s+/g, " "));
  expect(text).toMatch(/\d+% match/);
});

test("in an embedded application frame, the Autofill button stays on screen while the page scrolls", async ({ app }) => {
  const page = await setup(app);
  await page.locator("#apply").click();
  const frame = page.frameLocator("#grnhse_iframe");
  await expect(frame.locator("#jobpilot-fab")).toBeAttached({ timeout: 15000 });
  await expect.poll(() => page.locator("#grnhse_iframe").evaluate((f) => f.getBoundingClientRect().height)).toBeGreaterThan(2000);

  const inView = (box) => box && box.y >= 0 && box.y + box.height <= 800 && box.x >= 0 && box.x + box.width <= 1280;
  await expect.poll(async () => inView(await fabOnScreen(page)), { timeout: 5000 }).toBe(true);
  const first = await fabOnScreen(page);
  expect(first.y).toBeGreaterThan(400); // bottom-right, not stuck at the end of the form

  for (const y of [900, 1800, 2400]) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await expect.poll(async () => inView(await fabOnScreen(page)), { timeout: 5000 }).toBe(true);
    const box = await fabOnScreen(page);
    // Bottom-right of the window, or of the form once its end scrolls into view.
    const frameBottom = await page.locator("#grnhse_iframe").evaluate((f) => f.getBoundingClientRect().bottom);
    expect(box.y + box.height).toBeGreaterThan(Math.min(800, frameBottom) - 90);
  }

  // Filling works from there, and the checklist opens where the user can see it.
  await frame.locator("#jobpilot-fab").getByRole("button", { name: /autofill/i }).click();
  await expect(frame.locator("#f0")).toHaveValue(profile.firstName, { timeout: 15000 });
  await expect(frame.locator("#jobpilot-checklist")).toBeAttached({ timeout: 15000 });
  await expect.poll(async () => inView(await frame.locator("#jobpilot-checklist").boundingBox()), { timeout: 5000 }).toBe(true);
});
