/**
 * Skill names: normalization, aliases and a vocabulary of common technologies
 * used to spot what job descriptions ask for. Pure; shared by main and renderer.
 */

/** Alias (normalized) → canonical display name. */
const ALIASES: Record<string, string> = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  ecmascript: 'JavaScript',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  k8s: 'Kubernetes',
  kubernetes: 'Kubernetes',
  postgres: 'PostgreSQL',
  postgresql: 'PostgreSQL',
  psql: 'PostgreSQL',
  golang: 'Go',
  go: 'Go',
  node: 'Node.js',
  nodejs: 'Node.js',
  'node.js': 'Node.js',
  react: 'React',
  reactjs: 'React',
  'react.js': 'React',
  'react native': 'React Native',
  vue: 'Vue',
  vuejs: 'Vue',
  'vue.js': 'Vue',
  'next.js': 'Next.js',
  nextjs: 'Next.js',
  py: 'Python',
  python: 'Python',
  python3: 'Python',
  aws: 'AWS',
  'amazon web services': 'AWS',
  gcp: 'Google Cloud',
  'google cloud': 'Google Cloud',
  'google cloud platform': 'Google Cloud',
  azure: 'Azure',
  'microsoft azure': 'Azure',
  ml: 'Machine Learning',
  'machine learning': 'Machine Learning',
  llm: 'LLMs',
  llms: 'LLMs',
  'large language models': 'LLMs',
  rag: 'RAG',
  'retrieval augmented generation': 'RAG',
  'retrieval-augmented generation': 'RAG',
  ci: 'CI/CD',
  'ci/cd': 'CI/CD',
  cicd: 'CI/CD',
  'github actions': 'GitHub Actions',
  tf: 'Terraform',
  terraform: 'Terraform',
  mongo: 'MongoDB',
  mongodb: 'MongoDB',
  'c#': 'C#',
  csharp: 'C#',
  'c++': 'C++',
  cpp: 'C++',
  '.net': '.NET',
  dotnet: '.NET',
  sql: 'SQL',
  nosql: 'NoSQL',
  graphql: 'GraphQL',
  rest: 'REST',
  'rest api': 'REST',
  'restful apis': 'REST',
  grpc: 'gRPC',
  kafka: 'Kafka',
  'apache kafka': 'Kafka',
  spark: 'Spark',
  'apache spark': 'Spark',
  pyspark: 'Spark',
  airflow: 'Airflow',
  'apache airflow': 'Airflow',
  docker: 'Docker',
  redis: 'Redis',
  mysql: 'MySQL',
  elasticsearch: 'Elasticsearch',
  'elastic search': 'Elasticsearch',
  pytorch: 'PyTorch',
  tensorflow: 'TensorFlow',
  'scikit-learn': 'scikit-learn',
  sklearn: 'scikit-learn',
  fastapi: 'FastAPI',
  django: 'Django',
  flask: 'Flask',
  'spring boot': 'Spring Boot',
  spring: 'Spring',
  java: 'Java',
  kotlin: 'Kotlin',
  swift: 'Swift',
  rust: 'Rust',
  ruby: 'Ruby',
  rails: 'Ruby on Rails',
  'ruby on rails': 'Ruby on Rails',
  php: 'PHP',
  scala: 'Scala',
  linux: 'Linux',
  bash: 'Bash',
  git: 'Git',
  prometheus: 'Prometheus',
  grafana: 'Grafana',
  datadog: 'Datadog',
  opentelemetry: 'OpenTelemetry',
  otel: 'OpenTelemetry',
  snowflake: 'Snowflake',
  dbt: 'dbt',
  bigquery: 'BigQuery',
  langchain: 'LangChain',
  langgraph: 'LangGraph',
  'hugging face': 'Hugging Face',
  huggingface: 'Hugging Face'
}

/**
 * Technologies looked for in job descriptions, beyond the ones in the profile,
 * so the app can report what a posting asks for that the profile lacks.
 * Canonical names; matching goes through `normalizeSkill`.
 */
export const TECH_VOCABULARY: readonly string[] = [
  ...new Set(Object.values(ALIASES)),
  'Ansible',
  'Helm',
  'Jenkins',
  'CircleCI',
  'Argo CD',
  'Istio',
  'Nginx',
  'RabbitMQ',
  'DynamoDB',
  'Cassandra',
  'ClickHouse',
  'Flink',
  'Hadoop',
  'Databricks',
  'Tableau',
  'Looker',
  'Pandas',
  'NumPy',
  'Jupyter',
  'MLflow',
  'Kubeflow',
  'Ray',
  'Vector databases',
  'Pinecone',
  'OpenAI',
  'Microservices',
  'Serverless',
  'Lambda',
  'EKS',
  'ECS',
  'S3',
  'CloudFormation',
  'Pulumi',
  'Vault',
  'OAuth',
  'Webpack',
  'Vite',
  'Tailwind',
  'HTML',
  'CSS',
  'Figma',
  'Jest',
  'Playwright',
  'Cypress',
  'Selenium',
  'On-call',
  'Observability',
  'Data pipelines',
  'ETL',
  'Distributed systems'
]

/** Lowercase, collapse spaces, trim punctuation that is not part of a name (`+`, `#`, `.`, `/` stay). */
export function normalizeSkill(name: string): string {
  return name
    .toLowerCase()
    .replace(/[()[\]{}"'`*_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.,;:!?-]+|[,;:!?-]+$/g, '')
    .replace(/\.$/, '')
}

/** Canonical key for grouping: the alias target when known, else the normalized name. */
export function skillKey(name: string): string {
  const n = normalizeSkill(name)
  return ALIASES[n] ? normalizeSkill(ALIASES[n]) : n
}

/** Display name: the alias target when known, else the name as first written. */
export function displaySkill(name: string): string {
  const n = normalizeSkill(name)
  return ALIASES[n] ?? name.replace(/\s+/g, ' ').trim()
}

/** Splits a technologies field (`Python, Go / Kafka; AWS`) into names. */
/** Names that contain a slash and must survive splitting on `/`. */
const SLASH_NAMES = ['CI/CD', 'TCP/IP', 'PL/SQL', 'UI/UX', 'A/B testing', 'I/O']

export function splitSkills(field: string): string[] {
  // Drop annotations first ("AWS (EKS/EC2)"), so their slashes and commas do not split.
  // Then shield known slash names with a placeholder, split, and restore them.
  let shielded = field.replace(/\([^()]*\)/g, ' ')
  SLASH_NAMES.forEach((name, i) => {
    shielded = shielded.replace(
      new RegExp(escapeRegExp(name), 'gi'),
      (m) => `\u0000${i}:${m.replace('/', '\u0001')}\u0000`
    )
  })
  return shielded
    .split(/[,;|/•·]|\s+and\s+/i)
    .map((s) => s.replace(/\u0000\d+:([^\u0000]*)\u0000/g, (_m, name: string) => name.replace('\u0001', '/')))
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 40)
}

/**
 * Names that are also ordinary English words; they only count when written
 * with their capitalization ("Go", "Ray", "Spring"), so "go live" or "a ray of"
 * are not mentions. Everything else matches case-insensitively ("aws", "sql").
 */
const CASE_SENSITIVE = new Set(['Go', 'Ray', 'Spring', 'Vault', 'Lambda', 'Helm', 'Swift', 'Ruby', 'Rust', 'Flask'])

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every spelling of a skill that should count as a mention in free text:
 * the display name plus its aliases. Very short names (`Go`, `R`, `C`) are
 * matched case-sensitively so ordinary words ("go live") do not count.
 */
export function mentionPatterns(display: string): RegExp[] {
  const key = skillKey(display)
  const spellings = new Set([
    display,
    ...Object.entries(ALIASES)
      .filter(([, v]) => skillKey(v) === key)
      .map(([k]) => k)
  ])
  const patterns: RegExp[] = []
  for (const s of spellings) {
    // Ambiguous short aliases (`ts`, `tf`, `ml`, `ci`, `go`, `py`, `js`) only count when written as the display name.
    if (s.length <= 2 && s !== display) continue
    const body = escapeRegExp(s)
    // Word boundaries that also work for names ending in symbols (C++, C#, .NET, Node.js).
    const re = `(?<![A-Za-z0-9+#.])${body}(?![A-Za-z0-9+#]|\\.[A-Za-z0-9])`
    patterns.push(new RegExp(re, s.length <= 2 || CASE_SENSITIVE.has(s) ? 'g' : 'gi'))
  }
  return patterns
}

/** Words that turn a mention around: "no production Rust", "without Kafka", "limited Go". */
const NEGATION = /\b(no|not|never|without|lacks?|lacking|limited|little|none|zero|haven't|hasn't|don't|didn't)\b/i

/** Where one clause ends and the next begins, so a negation does not reach past it. */
const CLAUSE_BOUNDARY = /[,;:()]|\b(?:but|however|while|although|though|whereas|yet)\b/i

/**
 * Whether `text` mentions the skill affirmatively: at least one mention is not
 * negated. A mention is negated when a negation appears in the few words
 * before it within the same clause, so "No production Rust experience" is not
 * evidence of Rust, while "Used Python but not Rust" still is evidence of Python.
 */
export function mentionsAffirmatively(text: string, display: string): boolean {
  for (const re of mentionPatterns(display)) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      const before =
        text
          .slice(0, m.index)
          .split(/(?<=[.!?])\s+|\n+/)
          .pop() ?? ''
      const clause = before.split(CLAUSE_BOUNDARY).pop() ?? ''
      const nearby = clause.trim().split(/\s+/).slice(-5).join(' ')
      if (!NEGATION.test(nearby)) return true
    }
  }
  return false
}

/** Whether `text` mentions the skill (any spelling). */
export function mentions(text: string, display: string): boolean {
  return mentionPatterns(display).some((re) => {
    re.lastIndex = 0
    return re.test(text)
  })
}
