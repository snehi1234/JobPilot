// match-score.mjs — on-device resume ↔ job matching. No network, no AI.
//
// Scores how well each resume covers the skills a job description asks for,
// lists matched/missing skills, and picks the best resume for an application.

// Canonical skill → aliases. Short or ambiguous words (go, r, c, swift…) are
// only matched through unambiguous aliases to avoid false positives.
const SKILLS = {
  "Python": ["python"], "Java": ["java"], "JavaScript": ["javascript", "js", "ecmascript"],
  "TypeScript": ["typescript", "ts"], "Go": ["golang", "go lang"], "Rust": ["rust"],
  "C++": ["c\\+\\+", "cpp"], "C#": ["c#", "c sharp", "csharp"], ".NET": ["\\.net", "dotnet", "asp\\.net", ".net core"],
  "Ruby": ["ruby"], "Rails": ["rails", "ruby on rails"], "PHP": ["php"], "Kotlin": ["kotlin"],
  "Swift": ["swift(?= |ui|$)", "swiftui"], "Scala": ["scala"], "R": ["r programming", "rstudio", "\\br language"],
  "SQL": ["sql", "t-sql", "pl/sql"], "Bash": ["bash", "shell scripting"], "Perl": ["perl"],
  "React": ["react", "reactjs", "react\\.js"], "Angular": ["angular"], "Vue": ["vue", "vue\\.js", "vuejs"],
  "Next.js": ["next\\.js", "nextjs"], "Node.js": ["node\\.js", "nodejs", "node"], "Express": ["express\\.js", "expressjs"],
  "Django": ["django"], "Flask": ["flask"], "FastAPI": ["fastapi"], "Spring": ["spring boot", "spring framework", "spring mvc"],
  "GraphQL": ["graphql"], "APIs": ["apis", "api design", "web services?"], "Backend": ["backend", "back-end", "server-side"], "Frontend": ["frontend", "front-end"], "Full stack": ["full[- ]?stack"], "Cloud": ["cloud", "cloud-native", "saas"], "Databases": ["databases?", "data model(s|ing)?", "schema design"], "Performance": ["performance", "latency", "high[- ]throughput"], "Reliability": ["reliability", "fault[- ]toleran(t|ce)", "on-call", "incident"], "REST APIs": ["restful", "rest apis?", "rest services?"], "gRPC": ["grpc"],
  "HTML": ["html", "html5"], "CSS": ["css", "css3", "tailwind", "sass"],
  "AWS": ["aws", "amazon web services"], "Azure": ["azure"], "GCP": ["gcp", "google cloud"],
  "Kubernetes": ["kubernetes", "k8s"], "Docker": ["docker", "containers?"], "Terraform": ["terraform"],
  "CI/CD": ["ci/cd", "cicd", "continuous integration", "continuous delivery", "jenkins", "github actions"],
  "Linux": ["linux", "unix"], "Microservices": ["microservices?", "micro-services"],
  "Distributed systems": ["distributed systems?"], "System design": ["system design", "scalab(le|ility)"],
  "PostgreSQL": ["postgres", "postgresql"], "MySQL": ["mysql"], "MongoDB": ["mongodb", "mongo"],
  "Redis": ["redis"], "Cassandra": ["cassandra"], "DynamoDB": ["dynamodb"], "Elasticsearch": ["elasticsearch", "opensearch"],
  "Kafka": ["kafka"], "RabbitMQ": ["rabbitmq"], "Spark": ["spark", "pyspark"], "Hadoop": ["hadoop", "hdfs", "hive"],
  "Airflow": ["airflow"], "dbt": ["dbt"], "Snowflake": ["snowflake"], "Databricks": ["databricks"],
  "BigQuery": ["bigquery"], "Redshift": ["redshift"], "ETL": ["etl", "elt", "data pipelines?"],
  "Data warehousing": ["data warehous(e|ing)", "data lake", "lakehouse"], "Pandas": ["pandas"], "NumPy": ["numpy"],
  "Machine learning": ["machine learning", "ml"], "Deep learning": ["deep learning"], "PyTorch": ["pytorch"],
  "TensorFlow": ["tensorflow"], "scikit-learn": ["scikit-learn", "sklearn"], "NLP": ["nlp", "natural language processing"],
  "LLMs": ["llms?", "large language models?", "genai", "generative ai"], "RAG": ["rag", "retrieval[- ]augmented"],
  "Computer vision": ["computer vision"], "MLOps": ["mlops"], "Statistics": ["statistics", "statistical"],
  "Tableau": ["tableau"], "Power BI": ["power bi", "powerbi"], "Excel": ["excel"],
  "Git": ["git"], "Agile": ["agile", "scrum"], "Testing": ["unit test(s|ing)?", "test automation", "tdd", "pytest", "jest"],
  "Security": ["security", "oauth", "authentication"], "Observability": ["observability", "monitoring", "prometheus", "grafana", "datadog"],
  "iOS": ["ios"], "Android": ["android"], "Mobile": ["mobile app(s|lications?)?", "mobile development", "react native", "flutter"], "Figma": ["figma"],
  "Product management": ["product management", "product manager"], "Leadership": ["led a team", "mentor(ed|ing)?", "tech lead", "leadership"],
};

const SKILL_PATTERNS = Object.entries(SKILLS).map(([name, aliases]) => [
  name,
  new RegExp(`(^|[^a-z0-9+#])(${aliases.join("|")})(?=$|[^a-z0-9+#])`, "gi"),
]);

const STOPWORDS = new Set("a an and the of for to in on with at by from or as is are be we you our your this that will".split(" "));

// "Go" is a common word, so the language only counts when written as "Go"
// next to list punctuation or another listed item (e.g. "Java, Go", "in Go").
const GO_IN_LIST = /(?:(?:,|\/|\bor|\band|\bin|\(|:)\s*Go(?![A-Za-z]))|(?:(?<![A-Za-z])Go\s*(?:,|\/|\)|\bor\b|\band\b))/;

// Returns Map(skill → occurrence count).
export function extractSkills(text) {
  const found = new Map();
  const source = String(text || "").toLowerCase();
  for (const [name, re] of SKILL_PATTERNS) {
    re.lastIndex = 0;
    const count = (source.match(re) || []).length;
    if (count) found.set(name, count);
  }
  if (!found.has("Go") && GO_IN_LIST.test(String(text || ""))) found.set("Go", 1);
  // Specific skills imply their general category.
  for (const [general, specifics] of IMPLIES) {
    if (!found.has(general) && specifics.some((s) => found.has(s))) found.set(general, 1);
  }
  return found;
}

const IMPLIES = [
  ["Databases", ["PostgreSQL", "MySQL", "MongoDB", "Redis", "Cassandra", "DynamoDB", "SQL", "Snowflake", "BigQuery", "Redshift"]],
  ["Cloud", ["AWS", "Azure", "GCP"]],
  ["APIs", ["REST APIs", "GraphQL", "gRPC"]],
  ["Backend", ["Microservices", "Distributed systems", "Node.js", "Django", "Flask", "FastAPI", "Spring", "Rails", "Express"]],
  ["Frontend", ["React", "Angular", "Vue", "Next.js"]],
];

function titleWords(title) {
  return String(title || "").toLowerCase().split(/[^a-z0-9+#]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^(senior|junior|staff|lead|principal|ii|iii|sr|jr)$/.test(w));
}

// Words that appear in almost every job ad and say nothing about the role.
const AD_WORDS = new Set(("about across also able actively apply applicants applicant application based benefits best build building " +
  "candidate candidates company compensation culture customers description employer employees employment equal equity " +
  "every experience help hiring including information join looking location make more most must need offer opportunity " +
  "other people please position preferred qualifications range ready required requirements responsibilities role roles " +
  "salary should skills strong team teams their them they this those through using want well what when where which while " +
  "will within without work working world years your yours have has been into over such than that these were with would " +
  "highly great ideal plus bonus within ability across value values mission").split(" "));

const stem = (w) => w.replace(/(ings|ing|ies|ied|es|s|ed)$/, "");

function wordsOf(text) {
  return String(text || "").toLowerCase().split(/[^a-z0-9+#.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w.length > 3 && !STOPWORDS.has(w) && !AD_WORDS.has(w) && !/^\d+$/.test(w));
}

// Share of the description's most frequent meaningful words that the resume
// also uses. Catches domain overlap the skills list doesn't name.
function keywordOverlap(resumeText, description) {
  const counts = new Map();
  for (const w of wordsOf(description)) counts.set(stem(w), (counts.get(stem(w)) || 0) + 1);
  const top = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 30);
  if (top.length < 5) return null;
  const resume = new Set(wordsOf(resumeText).map(stem));
  let total = 0;
  let hit = 0;
  for (const [w, n] of top) {
    total += n;
    if (resume.has(w)) hit += n;
  }
  return hit / total;
}

// Score 0–100 from three signals: coverage of the skills the job names
// (weighted by how often it names them), overlap of the description's key
// words, and the job title's words. `informative` is false when the page
// gave too little job text to judge.
export function scoreResume(resumeText, job = {}) {
  const jobSkills = extractSkills(`${job.title || ""}\n${job.description || ""}`);
  const resumeSkills = extractSkills(resumeText);
  const matched = [];
  const missing = [];
  let total = 0;
  let covered = 0;
  for (const [skill, count] of [...jobSkills].sort((a, b) => b[1] - a[1])) {
    const weight = Math.min(count, 4);
    total += weight;
    if (resumeSkills.has(skill)) { covered += weight; matched.push(skill); } else missing.push(skill);
  }
  const resume = String(resumeText || "").toLowerCase();
  const words = titleWords(job.title);
  const title = words.length ? words.filter((w) => resume.includes(w)).length / words.length : 0;
  const skills = total ? covered / total : null;
  const keywords = keywordOverlap(resumeText, job.description);
  let score;
  if (skills !== null && jobSkills.size >= 3) {
    score = keywords === null ? 0.85 * skills + 0.15 * title : 0.6 * skills + 0.3 * keywords + 0.1 * title;
  } else if (keywords !== null) {
    score = 0.75 * keywords + 0.25 * title;
  } else {
    score = title;
  }
  const informative = jobSkills.size >= 3 || keywords !== null;
  return { score: Math.round(Math.min(1, score) * 100), matched, missing, jobSkillCount: jobSkills.size, informative };
}

// Pick the resume for an application.
//   resumes:   [{ id, name, text }]
//   options:   { defaultId, rememberedId, ambiguityGap }
// Returns { resumeId, reason, ambiguous, scores: [{ id, name, score, matched, missing }] }.
export function pickResume(resumes, job = {}, { defaultId, rememberedId, ambiguityGap = 5 } = {}) {
  const list = (resumes || []).filter((r) => r && r.id);
  if (!list.length) return { resumeId: null, reason: "none", ambiguous: false, scores: [] };
  const scores = list
    .map((r) => ({ id: r.id, name: r.name, ...scoreResume(r.text, job) }))
    .sort((a, b) => b.score - a.score);
  const fallback = list.find((r) => r.id === defaultId)?.id || list[0].id;
  if (list.length === 1) return { resumeId: list[0].id, reason: "only", ambiguous: false, scores };
  if (rememberedId && list.some((r) => r.id === rememberedId)) {
    return { resumeId: rememberedId, reason: "remembered", ambiguous: false, scores };
  }
  const informative = scores[0].informative && scores[0].score > 0;
  if (!informative) return { resumeId: fallback, reason: "default", ambiguous: false, scores };
  const ambiguous = scores[0].score - scores[1].score < ambiguityGap;
  return { resumeId: scores[0].id, reason: ambiguous ? "close" : "best-match", ambiguous, scores };
}

// Key for remembering the resume chosen for a company. Uses the company name
// when the page gives a real one, otherwise the site plus its first path
// segment (job boards host many companies, e.g. jobs.ashbyhq.com/openai).
export function companyKey(job = {}, host = "", url = "") {
  let company = String(job.company || "");
  if (company.includes(" @ ")) company = company.split(" @ ").pop();
  company = company.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (company && !/^(apply|application|job application|careers?|jobs?|home)$/.test(company)) return company;
  let segment = "";
  try { segment = new URL(url).pathname.split("/").filter(Boolean)[0] || ""; } catch { /* no url */ }
  return [String(host || "").toLowerCase(), segment.toLowerCase()].filter(Boolean).join("/");
}
