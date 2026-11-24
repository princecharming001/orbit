/**
 * Plan 44 §3: skills by name, not by spelling. A small table folds the common ways one skill is written (JS and
 * JavaScript, Postgres and PostgreSQL, ML and machine learning) into one key, and matching in text is on whole words:
 * "Java" is not found inside "JavaScript", and the one and two letter skills (C, R, Go) count only as a standalone word
 * with their capital letter, so "a go-getter" and "R&D" are not skills. C++ and C# are skills of their own.
 */

/** canonical key → the ways it is written (the first is how Orbit shows it). Keys are lowercase. */
const TABLE: Record<string, string[]> = {
  javascript: ['JavaScript', 'JS', 'ECMAScript', 'ES6'],
  typescript: ['TypeScript', 'TS'],
  python: ['Python', 'Python3', 'Python 3'],
  java: ['Java'],
  'c++': ['C++', 'CPP'],
  'c#': ['C#', 'C Sharp', 'CSharp'],
  c: ['C'],
  r: ['R'],
  go: ['Go', 'Golang'],
  rust: ['Rust'],
  ruby: ['Ruby'],
  'ruby on rails': ['Ruby on Rails', 'Rails', 'RoR'],
  php: ['PHP'],
  swift: ['Swift'],
  kotlin: ['Kotlin'],
  scala: ['Scala'],
  matlab: ['MATLAB'],
  sql: ['SQL'],
  postgresql: ['PostgreSQL', 'Postgres', 'psql'],
  mysql: ['MySQL'],
  mongodb: ['MongoDB', 'Mongo'],
  redis: ['Redis'],
  'node.js': ['Node.js', 'NodeJS', 'Node'],
  react: ['React', 'React.js', 'ReactJS'],
  'react native': ['React Native'],
  'vue.js': ['Vue', 'Vue.js', 'VueJS'],
  angular: ['Angular', 'AngularJS'],
  'next.js': ['Next.js', 'NextJS'],
  django: ['Django'],
  flask: ['Flask'],
  fastapi: ['FastAPI'],
  spring: ['Spring', 'Spring Boot'],
  graphql: ['GraphQL'],
  'rest apis': ['REST', 'REST API', 'REST APIs', 'RESTful'],
  html: ['HTML', 'HTML5'],
  css: ['CSS', 'CSS3'],
  'machine learning': ['Machine learning', 'ML'],
  'deep learning': ['Deep learning'],
  'artificial intelligence': ['Artificial intelligence', 'AI'],
  'natural language processing': ['Natural language processing', 'NLP'],
  'computer vision': ['Computer vision'],
  'large language models': ['Large language models', 'LLM', 'LLMs'],
  pytorch: ['PyTorch'],
  tensorflow: ['TensorFlow'],
  'scikit-learn': ['scikit-learn', 'sklearn', 'scikit learn'],
  pandas: ['pandas'],
  numpy: ['NumPy'],
  spark: ['Spark', 'Apache Spark', 'PySpark'],
  hadoop: ['Hadoop'],
  kafka: ['Kafka', 'Apache Kafka'],
  airflow: ['Airflow', 'Apache Airflow'],
  dbt: ['dbt'],
  snowflake: ['Snowflake'],
  tableau: ['Tableau'],
  'power bi': ['Power BI', 'PowerBI'],
  excel: ['Excel', 'Microsoft Excel', 'MS Excel'],
  'google sheets': ['Google Sheets', 'Sheets'],
  powerpoint: ['PowerPoint', 'Microsoft PowerPoint', 'MS PowerPoint'],
  kubernetes: ['Kubernetes', 'k8s'],
  docker: ['Docker'],
  terraform: ['Terraform'],
  aws: ['AWS', 'Amazon Web Services'],
  'google cloud': ['Google Cloud', 'GCP', 'Google Cloud Platform'],
  azure: ['Azure', 'Microsoft Azure'],
  linux: ['Linux'],
  git: ['Git', 'GitHub', 'GitLab'],
  'ci/cd': ['CI/CD', 'CICD', 'continuous integration'],
  figma: ['Figma'],
  sketch: ['Sketch'],
  'adobe creative suite': ['Adobe Creative Suite', 'Adobe CC', 'Creative Cloud'],
  photoshop: ['Photoshop'],
  illustrator: ['Illustrator'],
  'financial modeling': ['Financial modeling', 'Financial modelling', 'financial models'],
  'discounted cash flow': ['DCF', 'Discounted cash flow'],
  'a/b testing': ['A/B testing', 'AB testing', 'A/B tests', 'split testing'],
  statistics: ['Statistics', 'statistical analysis'],
  'data analysis': ['Data analysis', 'data analytics'],
  'data visualization': ['Data visualization', 'data visualisation', 'dataviz'],
  salesforce: ['Salesforce', 'SFDC'],
  jira: ['Jira'],
  'product management': ['Product management'],
  'user research': ['User research', 'UX research'],
  'ux design': ['UX design', 'UX', 'user experience design'],
  'ui design': ['UI design', 'UI'],
  stata: ['Stata'],
  sas: ['SAS'],
  spss: ['SPSS'],
  bash: ['Bash', 'shell scripting'],
  'objective-c': ['Objective-C', 'ObjC'],
  solidity: ['Solidity'],
  unity: ['Unity'],
  'unreal engine': ['Unreal Engine', 'Unreal'],
  verilog: ['Verilog'],
  vhdl: ['VHDL'],
  'embedded systems': ['Embedded systems'],
  cad: ['CAD'],
  solidworks: ['SolidWorks'],
  autocad: ['AutoCAD'],
  labview: ['LabVIEW'],
};

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const ALIAS = new Map<string, string>();
for (const [key, names] of Object.entries(TABLE)) {
  ALIAS.set(fold(key), key);
  for (const n of names) ALIAS.set(fold(n), key);
}

/** The skill's key: "JS" → "javascript", "Postgres" → "postgresql"; an unknown skill is its folded name. */
export function canonicalSkill(name: string): string {
  const f = fold(name).replace(/[.,;:]+$/, '');
  return ALIAS.get(f) ?? ALIAS.get(f.replace(/\.js$/, '')) ?? f;
}

/**
 * Whether the name is one specific tool, language or framework Orbit knows by name (Python, Figma, Excel). Such a
 * skill counts only when the student's words name it; a kind of work ("spreadsheets", "user research") is shown by a
 * line that does it.
 */
export function knownSkill(name: string): boolean {
  return Object.hasOwn(TABLE, canonicalSkill(name));
}

/**
 * Split a written list of skills ("Python, SQL; Figma/Sketch and R") into its names. Names written with a slash or
 * an ampersand of their own stay whole: A/B testing, CI/CD, UI/UX, TCP/IP, I/O, R&D, P&L.
 */
export function splitSkillList(text: string): string[] {
  const kept: string[] = [];
  const held = text.replace(WHOLE_TERMS, (m) => {
    kept.push(m);
    return `orbitwholeterm${kept.length - 1}x`;
  });
  return held
    .split(/[,;|•·/]|\s+and\s+|\s+or\s+/i)
    .map((p) => p.replace(/orbitwholeterm(\d+)x/g, (_m, i) => kept[Number(i)]!).trim())
    .filter(Boolean);
}
const WHOLE_TERMS = /\b(?:A\/B|CI\/CD|UI\/UX|UX\/UI|TCP\/IP|I\/O|R&D|P&L|PL\/SQL|AR\/VR|AI\/ML|ML\/AI)\b/gi;

/** How Orbit shows a skill: "js" → "JavaScript"; an unknown skill as written. */
export function skillName(name: string): string {
  const key = canonicalSkill(name);
  return TABLE[key]?.[0] ?? name.trim();
}

/** The same skill however it is written. */
export function sameSkill(a: string, b: string): boolean {
  const x = canonicalSkill(a);
  return !!x && x === canonicalSkill(b);
}

/** Every way a skill is written, the name given first. */
export function spellingsOf(name: string): string[] {
  const key = canonicalSkill(name);
  const known = TABLE[key];
  const out = [name.trim(), ...(known ?? [])];
  return [...new Set(out.filter(Boolean))];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One spelling as a pattern over raw text, on whole words. */
function patternOf(spelling: string): RegExp {
  const s = spelling.trim();
  const short = s.replace(/[^A-Za-z0-9]/g, '').length <= 2 && /^[A-Za-z]{1,2}$/.test(s);
  // nothing that continues a word before it: a letter, a digit, a dot (".js" in "Node.js"), "+", "#" or "&"
  const before = short ? '(?<![A-Za-z0-9+#.&-])' : '(?<![A-Za-z0-9+#.&])';
  // nor after: "C" is not "C++" or "C#", "Java" is not "JavaScript", "R" is not "R&D"; a short one is not "go-getter"
  const after = short ? '(?![A-Za-z0-9+#&-])' : '(?![A-Za-z0-9+#])';
  const body = escapeRe(s).replace(/\\ |\s+/g, '\\s+');
  // short skills keep their capital letter ("Go", "R", "C"); longer ones match in any case
  return new RegExp(`${before}${body}${after}`, short ? 'u' : 'iu');
}

const patterns = new Map<string, RegExp>();
function cached(spelling: string): RegExp {
  let re = patterns.get(spelling);
  if (!re) {
    re = patternOf(spelling);
    if (patterns.size > 5000) patterns.clear();
    patterns.set(spelling, re);
  }
  return re;
}

/** Whether `text` names the skill (any of its spellings) as a whole word. */
export function skillIn(text: string | undefined | null, skill: string): boolean {
  if (!text || !skill.trim()) return false;
  for (const sp of spellingsOf(skill)) {
    // a short spelling is matched with its capital: an alias written in lowercase ("k8s") keeps its own case rule
    if (cached(sp).test(text)) return true;
  }
  return false;
}

/** The skills of `skills` that `text` names, as given. */
export function skillsIn(text: string | undefined | null, skills: string[]): string[] {
  return skills.filter((s) => skillIn(text, s));
}

/** Skills with the same key kept once, the first spelling kept. */
export function uniqueSkills<T extends { name: string }>(skills: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of skills) {
    const k = canonicalSkill(s.name);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * Skills that plainly include another: a resume that names PostgreSQL shows SQL, pandas shows Python, React shows
 * JavaScript. One direction only (SQL does not show PostgreSQL).
 */
const IMPLIES: [string[], string[]][] = [
  [
    [
      'PostgreSQL',
      'MySQL',
      'SQLite',
      'SQL Server',
      'BigQuery',
      'Snowflake',
      'Redshift',
      'Oracle SQL',
      'T-SQL',
    ],
    ['SQL'],
  ],
  [
    ['pandas', 'NumPy', 'Django', 'Flask', 'FastAPI', 'PyTorch', 'TensorFlow', 'scikit-learn', 'Jupyter'],
    ['Python'],
  ],
  [['React', 'Vue', 'Angular', 'Node.js', 'Next.js', 'TypeScript', 'Svelte', 'Express'], ['JavaScript']],
  [['Next.js', 'React Native'], ['React']],
  [['Spring', 'Spring Boot'], ['Java']],
  [['PyTorch', 'TensorFlow', 'scikit-learn', 'XGBoost', 'Keras'], ['Machine learning']],
  [['Tableau', 'Power BI', 'Looker'], ['Data visualization']],
  [['AWS', 'GCP', 'Azure'], ['Cloud']],
  [['Kubernetes', 'Docker'], ['Containers']],
  [['Figma', 'Sketch', 'Adobe XD'], ['Prototyping']],
  [['Excel', 'Google Sheets'], ['Spreadsheets']],
  [['PowerPoint', 'Google Slides', 'Keynote'], ['Presentations']],
  [['Stata', 'SAS', 'SPSS', 'MATLAB'], ['Statistical software']],
];
const IMPLIED = new Map<string, Set<string>>();
for (const [from, to] of IMPLIES)
  for (const f of from) {
    const k = canonicalSkill(f);
    const set = IMPLIED.get(k) ?? new Set<string>();
    for (const t of to) set.add(canonicalSkill(t));
    IMPLIED.set(k, set);
  }

/** Whether having `have` shows `want`: the same skill, or one that plainly includes it. */
export function showsSkill(have: string, want: string): boolean {
  if (sameSkill(have, want)) return true;
  return IMPLIED.get(canonicalSkill(have))?.has(canonicalSkill(want)) ?? false;
}

/** Whether `text` names the skill, or a skill that plainly includes it ("PostgreSQL" for SQL). */
export function skillShownIn(text: string | undefined | null, skill: string): boolean {
  if (skillIn(text, skill)) return true;
  const want = canonicalSkill(skill);
  for (const [k, set] of IMPLIED) if (set.has(want) && skillIn(text, TABLE[k]?.[0] ?? k)) return true;
  return false;
}
