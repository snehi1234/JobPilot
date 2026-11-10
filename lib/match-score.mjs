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
  "GraphQL": ["graphql"], "REST APIs": ["restful", "rest apis?", "rest services?"], "gRPC": ["grpc"],
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
  "Product management": ["product management", "roadmap"], "Leadership": ["led a team", "mentor(ed|ing)?", "tech lead", "leadership"],
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
  return found;
}

function titleWords(title) {
  return String(title || "").toLowerCase().split(/[^a-z0-9+#]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^(senior|junior|staff|lead|principal|ii|iii|sr|jr)$/.test(w));
}

// Score 0–100: weighted share of the job's skills found in the resume, plus a
// small bonus when the resume mentions the job title's key words.
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
  const titleHit = words.length ? words.filter((w) => resume.includes(w)).length / words.length : 0;
  const base = total ? (covered / total) * 90 : 0;
  const score = Math.round(Math.min(100, base + titleHit * 10));
  return { score, matched, missing, jobSkillCount: jobSkills.size };
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
  const informative = (scores[0].jobSkillCount || 0) >= 3 && scores[0].score > 0;
  if (!informative) return { resumeId: fallback, reason: "default", ambiguous: false, scores };
  const ambiguous = scores[0].score - scores[1].score < ambiguityGap;
  return { resumeId: scores[0].id, reason: ambiguous ? "close" : "best-match", ambiguous, scores };
}

export function companyKey(job = {}, host = "") {
  const company = String(job.company || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return company || String(host || "").toLowerCase();
}
