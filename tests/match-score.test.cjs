const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "lib", "match-score.mjs")).href);

const SOFTWARE = `Software Engineer. Built microservices in Java and Python on Azure with Kubernetes and Docker.
Designed REST APIs, distributed systems, CI/CD with GitHub Actions, PostgreSQL and Redis. Mobile: +1 202 555 0142.`;
const DATA = `Data Engineer. Built ETL data pipelines with Spark, Airflow, dbt and Snowflake. SQL, Python, Kafka, data warehouse.
Indiana University, Spring 2022.`;
const BACKEND_JOB = {
  title: "Senior Software Engineer, Backend",
  description: "Design distributed systems and microservices in Java or Go. Kubernetes, Docker, PostgreSQL, Redis, REST APIs, CI/CD. The rest of the team uses Python.",
};
const DATA_JOB = {
  title: "Data Engineer",
  description: "Own ETL pipelines using Spark, Airflow and dbt on Snowflake. Strong SQL and Python. Kafka streaming a plus.",
};

test("skills are found through aliases without common-word false positives", async () => {
  const { extractSkills } = await load();
  const skills = extractSkills(SOFTWARE + "\n" + DATA);
  for (const s of ["Java", "Python", "Azure", "Kubernetes", "Docker", "REST APIs", "CI/CD", "PostgreSQL", "Spark", "Airflow", "dbt", "ETL"]) {
    assert.ok(skills.has(s), s);
  }
  assert.ok(!skills.has("Spring"), "Spring 2022 is a semester, not the framework");
  assert.ok(!skills.has("Mobile"), "a Mobile phone label is not a skill");
  assert.ok(!extractSkills("the rest of the team").has("REST APIs"));
  assert.ok(!extractSkills("going to the store").has("Go"));
  assert.ok(!extractSkills("Go to the careers page. We go and build.").has("Go"));
  assert.ok(extractSkills("Java, Go, or Rust").has("Go"));
  assert.ok(extractSkills("services written in Go").has("Go"));
  assert.ok(extractSkills("C++ and C# with .NET").has("C++"));
});

test("scores reflect coverage and list matched and missing skills", async () => {
  const { scoreResume } = await load();
  const good = scoreResume(SOFTWARE, BACKEND_JOB);
  const poor = scoreResume(DATA, BACKEND_JOB);
  assert.ok(good.score > poor.score, `${good.score} > ${poor.score}`);
  assert.ok(good.score >= 70, String(good.score));
  assert.ok(good.matched.includes("Kubernetes"));
  assert.ok(good.missing.includes("Go"));
  assert.ok(good.score <= 100 && poor.score >= 0);
});

test("pickResume picks the best match per job and falls back sensibly", async () => {
  const { pickResume } = await load();
  const resumes = [
    { id: "sw", name: "Software", text: SOFTWARE },
    { id: "de", name: "Data", text: DATA },
  ];
  assert.equal(pickResume(resumes, BACKEND_JOB, { defaultId: "de" }).resumeId, "sw");
  const data = pickResume(resumes, DATA_JOB, { defaultId: "sw" });
  assert.equal(data.resumeId, "de");
  assert.equal(data.reason, "best-match");
  assert.equal(data.ambiguous, false);

  const vague = pickResume(resumes, { title: "Associate", description: "Great culture." }, { defaultId: "de" });
  assert.equal(vague.resumeId, "de");
  assert.equal(vague.reason, "default");

  const remembered = pickResume(resumes, BACKEND_JOB, { defaultId: "sw", rememberedId: "de" });
  assert.equal(remembered.resumeId, "de");
  assert.equal(remembered.reason, "remembered");
  assert.equal(pickResume(resumes, BACKEND_JOB, { rememberedId: "deleted" }).reason, "best-match");

  assert.equal(pickResume([resumes[0]], DATA_JOB).reason, "only");
  assert.equal(pickResume([], DATA_JOB).resumeId, null);
});

test("close scores are flagged so the user is asked", async () => {
  const { pickResume } = await load();
  const twins = [
    { id: "a", name: "A", text: SOFTWARE },
    { id: "b", name: "B", text: SOFTWARE + " Leadership." },
  ];
  const pick = pickResume(twins, BACKEND_JOB);
  assert.equal(pick.ambiguous, true);
  assert.equal(pick.reason, "close");
});

test("company keys group applications by company, else by job board and company slug", async () => {
  const { companyKey } = await load();
  assert.equal(companyKey({ company: "Plaid, Inc." }, "jobs.ashbyhq.com"), "plaid inc");
  assert.equal(companyKey({ company: "Software Engineer, Backend @ Wisdom AI" }, "jobs.ashbyhq.com"), "wisdom ai");
  assert.equal(companyKey({ company: "Apply" }, "ats.rippling.com", "https://ats.rippling.com/rippling/jobs/1/apply"), "ats.rippling.com/rippling");
  assert.equal(companyKey({}, "Jobs.Lever.co"), "jobs.lever.co");
});

test("a page without a job description is not scored as a real match", async () => {
  const { scoreResume, pickResume } = await load();
  const form = { title: "Software Engineer, Backend", description: "Upload your resume here to autofill key application fields." };
  assert.equal(scoreResume(SOFTWARE, form).informative, false);
  const pick = pickResume([{ id: "sw", name: "S", text: SOFTWARE }, { id: "de", name: "D", text: DATA }], form, { defaultId: "de" });
  assert.equal(pick.reason, "default");
  assert.equal(pick.resumeId, "de");
});

test("specific skills count toward their category, and description words add signal", async () => {
  const { extractSkills, scoreResume } = await load();
  const skills = extractSkills("PostgreSQL and Azure");
  assert.ok(skills.has("Databases") && skills.has("Cloud"));
  const job = { title: "Backend Engineer", description: "Design databases and cloud services for payment ledgers. Payment ledgers reconcile merchant settlement. Merchant settlement and payment reconciliation at scale; ledgers and reconciliation tooling for merchant payouts and payouts reporting." };
  const withDomain = scoreResume(SOFTWARE + " Built payment ledgers, merchant settlement, payouts and reconciliation.", job);
  const without = scoreResume(SOFTWARE, job);
  assert.ok(withDomain.score > without.score, `${withDomain.score} > ${without.score}`);
  assert.equal(without.informative, true);
});
