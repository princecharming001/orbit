/**
 * Plan 44: sample roles, made up but shaped like the boards Orbit reads (Greenhouse, Lever, Ashby, LinkedIn). The demo
 * student's Roles tab and the tests' fake orbit-api both read these through `rolesSim.ts`, so every part of the tab
 * (a strong fit, a stretch, a cap, a posting that says little, a company with no one yet) can be tried without a
 * server. Companies are the demo network's where it has people there, and a few it does not.
 *
 * Pure data: nothing here touches the browser's database, so the end-to-end tests' Node side can load it too.
 */
import type { FitCapFact, Job, JobLevel, Remote } from '@orbit/core';
import type { TitleFamily } from '@orbit/core/search';

/** One requirement as the sample posting writes it: a skill, with the posting's own words. */
export interface SampleReq {
  name: string;
  need: 'must' | 'nice';
  quote: string;
}

export interface SampleJob {
  id: string;
  company: string;
  domain?: string;
  title: string;
  team?: string;
  family: TitleFamily;
  level?: JobLevel;
  places: string[];
  remote?: Remote;
  term?: string;
  url: string;
  source: Job['source'];
  postedDaysAgo: number;
  sponsorship?: 'offers' | 'none';
  /** the skills the posting asks for */
  skills: SampleReq[];
  /** what the posting says about school, when it says anything */
  education?: { field: string; quote: string };
  /** what the posting says about the work, for the experience question */
  experienceQuote?: string;
  /** facts that hold a score down whatever else fits (citizenship, a PhD) */
  caps?: (FitCapFact & { needs?: 'citizen' | 'phd' })[];
  pay?: Job['pay'];
}

const gh = (board: string, id: number) => `https://boards.greenhouse.io/${board}/jobs/${id}`;
const lever = (board: string, id: string) => `https://jobs.lever.co/${board}/${id}`;
const ashby = (board: string, id: string) => `https://jobs.ashbyhq.com/${board}/${id}`;

/** The coverage line's numbers for sample data (what was searched). */
export const SAMPLE_COVERAGE = { boards: 1240, roles: 8170, linkedin: true, simplify: true } as const;

export const SAMPLE_JOBS: SampleJob[] = [
  {
    id: 'j_stripe_swe_intern',
    company: 'Stripe',
    domain: 'stripe.com',
    title: 'Software Engineer Intern',
    team: 'Payments infrastructure',
    family: 'engineering',
    level: 'intern',
    places: ['New York, NY', 'San Francisco, CA'],
    remote: 'on_site',
    term: 'Summer 2027',
    // the demo's own sample posting link (integrations/postings DEMO_POSTING_URL): a pasted link scores this one
    url: gh('stripe', 6120000),
    source: 'greenhouse',
    postedDaysAgo: 3,
    sponsorship: 'offers',
    skills: [
      { name: 'Go', need: 'must', quote: 'Experience with Go, Java or Ruby' },
      { name: 'SQL', need: 'must', quote: 'Comfortable writing SQL' },
      { name: 'Distributed systems', need: 'nice', quote: 'Coursework in distributed systems is a plus' },
      { name: 'Payments', need: 'nice', quote: 'Interest in payments and financial infrastructure' },
    ],
    education: {
      field: 'Computer Science',
      quote: 'Pursuing a BS in Computer Science or a related field, graduating 2027 or 2028',
    },
    experienceQuote: 'You have built and shipped software in a team before, in an internship or a project',
    pay: { min: 52, max: 58, currency: 'USD', per: 'hour' },
  },
  {
    id: 'j_ramp_swe_intern',
    company: 'Ramp',
    domain: 'ramp.com',
    title: 'Software Engineer Intern, Backend',
    team: 'Card platform',
    family: 'engineering',
    level: 'intern',
    places: ['New York, NY'],
    remote: 'on_site',
    term: 'Summer 2027',
    url: ashby('ramp', '7c1e2a40-intern-backend'),
    source: 'ashby',
    postedDaysAgo: 1,
    sponsorship: 'offers',
    skills: [
      { name: 'Python', need: 'must', quote: 'Strong in Python or Go' },
      { name: 'Postgres', need: 'must', quote: 'Experience with Postgres or another relational database' },
      { name: 'TypeScript', need: 'nice', quote: 'TypeScript is a bonus' },
    ],
    experienceQuote: 'A previous software engineering internship',
    pay: { min: 55, max: 60, currency: 'USD', per: 'hour' },
  },
  {
    id: 'j_figma_swe_intern',
    company: 'Figma',
    domain: 'figma.com',
    title: 'Software Engineer Intern',
    team: 'Editor',
    family: 'engineering',
    level: 'intern',
    places: ['San Francisco, CA'],
    remote: 'hybrid',
    term: 'Summer 2027',
    url: gh('figma', 5501231),
    source: 'greenhouse',
    postedDaysAgo: 6,
    skills: [
      { name: 'TypeScript', need: 'must', quote: 'Fluent in TypeScript or C++' },
      { name: 'React', need: 'nice', quote: 'Experience with React' },
      { name: 'C++', need: 'nice', quote: 'C++ and WebAssembly a plus' },
    ],
    education: { field: 'Computer Science', quote: 'Currently pursuing a degree in Computer Science' },
    experienceQuote: 'Shipped a product or a project other people used',
  },
  {
    id: 'j_linear_product_eng',
    company: 'Linear',
    domain: 'linear.app',
    title: 'Product Engineer Intern',
    family: 'engineering',
    level: 'intern',
    places: ['Remote'],
    remote: 'remote',
    term: 'Summer 2027',
    url: ashby('linear', 'a83f-product-engineer-intern'),
    source: 'ashby',
    postedDaysAgo: 12,
    skills: [
      { name: 'TypeScript', need: 'must', quote: 'Write TypeScript every day' },
      { name: 'React', need: 'must', quote: 'Build interfaces in React' },
      { name: 'GraphQL', need: 'nice', quote: 'GraphQL experience helps' },
    ],
    experienceQuote: 'You have built something end to end that people use',
  },
  {
    id: 'j_vercel_swe_intern',
    company: 'Vercel',
    domain: 'vercel.com',
    title: 'Software Engineer Intern',
    team: 'Developer experience',
    family: 'engineering',
    level: 'intern',
    places: ['Remote', 'San Francisco, CA'],
    remote: 'remote',
    term: 'Summer 2027',
    url: ashby('vercel', '19bd-swe-intern'),
    source: 'ashby',
    postedDaysAgo: 4,
    skills: [
      { name: 'TypeScript', need: 'must', quote: 'Strong TypeScript and Node.js' },
      { name: 'React', need: 'must', quote: 'Experience building with React' },
      { name: 'AWS', need: 'nice', quote: 'Familiar with AWS or another cloud' },
    ],
    experienceQuote: 'Open source or side projects you can show',
  },
  {
    id: 'j_datadog_swe_intern',
    company: 'Datadog',
    domain: 'datadoghq.com',
    title: 'Software Engineering Intern',
    team: 'Metrics',
    family: 'engineering',
    level: 'intern',
    places: ['New York, NY', 'Boston, MA'],
    remote: 'on_site',
    term: 'Summer 2027',
    url: gh('datadog', 7012345),
    source: 'greenhouse',
    postedDaysAgo: 9,
    sponsorship: 'offers',
    skills: [
      { name: 'Go', need: 'must', quote: 'Go, Python or Java' },
      { name: 'Distributed systems', need: 'nice', quote: 'Interest in distributed systems' },
      { name: 'Kubernetes', need: 'nice', quote: 'Kubernetes experience is a plus' },
    ],
    education: { field: 'Computer Science', quote: 'Pursuing a BS or MS in Computer Science' },
    experienceQuote: 'Prior internship experience in software engineering',
  },
  {
    id: 'j_notion_pm_intern',
    company: 'Notion',
    domain: 'notion.so',
    title: 'Product Manager Intern',
    family: 'product',
    level: 'intern',
    places: ['San Francisco, CA', 'New York, NY'],
    remote: 'on_site',
    term: 'Summer 2027',
    url: gh('notion', 6400012),
    source: 'greenhouse',
    postedDaysAgo: 2,
    skills: [
      { name: 'SQL', need: 'nice', quote: 'Comfortable pulling your own data with SQL' },
      { name: 'User research', need: 'must', quote: 'Talk to users and turn what you hear into specs' },
      { name: 'Figma', need: 'nice', quote: 'Can sketch flows in Figma' },
    ],
    experienceQuote: 'Product, engineering or design experience in an internship or a club',
  },
  {
    id: 'j_anthropic_swe_intern',
    company: 'Anthropic',
    domain: 'anthropic.com',
    title: 'Software Engineer Intern',
    team: 'Inference',
    family: 'engineering',
    level: 'intern',
    places: ['San Francisco, CA'],
    remote: 'on_site',
    term: 'Summer 2027',
    url: gh('anthropic', 4400221),
    source: 'greenhouse',
    postedDaysAgo: 15,
    skills: [
      { name: 'Python', need: 'must', quote: 'Proficient in Python' },
      { name: 'Distributed systems', need: 'must', quote: 'Experience with distributed systems' },
      { name: 'Kubernetes', need: 'nice', quote: 'Kubernetes or similar' },
      { name: 'Machine learning', need: 'nice', quote: 'Some exposure to machine learning' },
    ],
    education: {
      field: 'Computer Science',
      quote: 'Pursuing a degree in Computer Science or a related field',
    },
    experienceQuote: 'You have shipped production code',
  },
  {
    id: 'j_jane_street_swe_intern',
    company: 'Jane Street',
    domain: 'janestreet.com',
    title: 'Software Engineer Intern',
    family: 'engineering',
    level: 'intern',
    places: ['New York, NY'],
    remote: 'on_site',
    term: 'Summer 2027',
    url: gh('janestreet', 3300112),
    source: 'greenhouse',
    postedDaysAgo: 20,
    skills: [{ name: 'OCaml', need: 'nice', quote: 'No OCaml needed, though functional programming helps' }],
    experienceQuote: 'Curiosity about how markets work',
  },
  {
    id: 'j_plaid_swe_intern',
    company: 'Plaid',
    domain: 'plaid.com',
    title: 'Software Engineer Intern',
    team: 'Payments',
    family: 'engineering',
    level: 'intern',
    places: ['San Francisco, CA', 'New York, NY'],
    remote: 'hybrid',
    term: 'Summer 2027',
    url: lever('plaid', 'f2c1-swe-intern'),
    source: 'lever',
    postedDaysAgo: 5,
    skills: [
      { name: 'Go', need: 'must', quote: 'Go or Python in production' },
      { name: 'Payments', need: 'nice', quote: 'Interest in payments' },
      { name: 'SQL', need: 'must', quote: 'Working knowledge of SQL' },
    ],
    experienceQuote: 'Built backend services in an internship or project',
  },
  {
    id: 'j_mercury_backend_intern',
    company: 'Mercury',
    domain: 'mercury.com',
    title: 'Backend Engineering Intern',
    family: 'engineering',
    level: 'intern',
    places: ['Remote'],
    remote: 'remote',
    term: 'Summer 2027',
    url: ashby('mercury', '3e0d-backend-intern'),
    source: 'ashby',
    postedDaysAgo: 8,
    sponsorship: 'none',
    skills: [
      { name: 'Haskell', need: 'nice', quote: 'Haskell experience is a plus, not required' },
      { name: 'Postgres', need: 'must', quote: 'Experience with Postgres' },
      { name: 'TypeScript', need: 'nice', quote: 'TypeScript on the front end' },
    ],
    caps: [
      {
        kind: 'sponsorship',
        quote: 'We are unable to sponsor visas for this role',
        label: 'Does not sponsor visas',
      },
    ],
    experienceQuote: 'A software internship or real projects',
  },
  {
    id: 'j_brex_data_intern',
    company: 'Retool',
    domain: 'retool.com',
    title: 'Data Analyst Intern',
    family: 'data_ml',
    level: 'intern',
    places: ['San Francisco, CA'],
    remote: 'on_site',
    term: 'Summer 2027',
    url: gh('retool', 6011220),
    source: 'greenhouse',
    postedDaysAgo: 11,
    skills: [
      { name: 'SQL', need: 'must', quote: 'Strong SQL' },
      { name: 'Python', need: 'must', quote: 'Python for analysis' },
      { name: 'Tableau', need: 'nice', quote: 'Tableau or Looker' },
    ],
    experienceQuote: 'Analytics work in a class, a club or an internship',
  },
  {
    id: 'j_palantir_fde_intern',
    company: 'Palantir',
    domain: 'palantir.com',
    title: 'Forward Deployed Engineer Intern',
    family: 'engineering',
    level: 'intern',
    places: ['Washington, DC', 'New York, NY'],
    remote: 'on_site',
    term: 'Summer 2027',
    url: lever('palantir', '8a1f-fde-intern'),
    source: 'lever',
    postedDaysAgo: 7,
    skills: [
      { name: 'Python', need: 'must', quote: 'Python or Java' },
      { name: 'SQL', need: 'nice', quote: 'Data modeling and SQL' },
    ],
    caps: [
      {
        kind: 'citizenship_ask',
        quote: 'Must be a US citizen to be considered for this role',
        label: 'Asks for US citizenship',
        needs: 'citizen',
      },
    ],
    experienceQuote: 'Comfortable working with customers',
  },
  {
    id: 'j_airtable_short',
    company: 'Airtable',
    domain: 'airtable.com',
    title: 'Software Engineer Intern',
    family: 'engineering',
    level: 'intern',
    places: ['San Francisco, CA'],
    remote: 'on_site',
    term: 'Summer 2027',
    url: gh('airtable', 7712004),
    source: 'greenhouse',
    postedDaysAgo: 1,
    // a posting that says little: held at 6 whatever else fits
    skills: [{ name: 'TypeScript', need: 'nice', quote: 'TypeScript a plus' }],
    caps: [{ kind: 'thin', label: 'The posting says little' }],
  },
  {
    id: 'j_openai_research',
    company: 'Scale AI',
    domain: 'scale.com',
    title: 'Research Scientist Intern',
    family: 'research',
    level: 'intern',
    places: ['San Francisco, CA'],
    remote: 'on_site',
    term: 'Summer 2027',
    url: gh('scaleai', 4901122),
    source: 'greenhouse',
    postedDaysAgo: 18,
    skills: [
      { name: 'Machine learning', need: 'must', quote: 'Publications in machine learning' },
      { name: 'PyTorch', need: 'must', quote: 'Deep experience with PyTorch' },
    ],
    caps: [
      { kind: 'degree', quote: 'Currently enrolled in a PhD program', label: 'Asks for a PhD', needs: 'phd' },
    ],
    experienceQuote: 'Research experience in machine learning',
  },
  {
    id: 'j_stripe_new_grad',
    company: 'Stripe',
    domain: 'stripe.com',
    title: 'Software Engineer, New Grad',
    family: 'engineering',
    level: 'entry',
    places: ['Seattle, WA', 'San Francisco, CA'],
    remote: 'on_site',
    url: gh('stripe', 6120044),
    source: 'greenhouse',
    postedDaysAgo: 4,
    sponsorship: 'offers',
    skills: [
      { name: 'Go', need: 'must', quote: 'Experience in Go, Java or Ruby' },
      { name: 'SQL', need: 'must', quote: 'SQL' },
      { name: 'Distributed systems', need: 'nice', quote: 'Distributed systems a plus' },
    ],
    education: { field: 'Computer Science', quote: 'BS in Computer Science, graduating by June 2027' },
    experienceQuote: 'One or more software engineering internships',
  },
  {
    id: 'j_ramp_new_grad',
    company: 'Ramp',
    domain: 'ramp.com',
    title: 'Software Engineer, New Grad',
    family: 'engineering',
    level: 'entry',
    places: ['New York, NY'],
    remote: 'on_site',
    url: ashby('ramp', '2d11-new-grad'),
    source: 'ashby',
    postedDaysAgo: 10,
    skills: [
      { name: 'Python', need: 'must', quote: 'Python or TypeScript' },
      { name: 'Postgres', need: 'nice', quote: 'Relational databases' },
    ],
    experienceQuote: 'Internships building real products',
  },
  {
    id: 'j_figma_senior',
    company: 'Figma',
    domain: 'figma.com',
    title: 'Senior Software Engineer, Infrastructure',
    family: 'engineering',
    level: 'senior',
    places: ['San Francisco, CA', 'Remote'],
    remote: 'remote',
    url: gh('figma', 5501990),
    source: 'greenhouse',
    postedDaysAgo: 3,
    skills: [
      { name: 'Go', need: 'must', quote: 'Go or Rust in production' },
      { name: 'Kubernetes', need: 'must', quote: 'Run services on Kubernetes' },
    ],
    caps: [{ kind: 'years', quote: '6+ years of experience', label: 'Asks for 6 years' }],
    experienceQuote: 'Six or more years building infrastructure',
  },
  {
    id: 'j_linkedin_coinbase',
    company: 'Coinbase',
    domain: 'coinbase.com',
    title: 'Software Engineer Intern',
    family: 'engineering',
    level: 'intern',
    places: ['Remote'],
    remote: 'remote',
    term: 'Summer 2027',
    url: 'https://www.linkedin.com/jobs/view/4012345678',
    source: 'linkedin',
    postedDaysAgo: 2,
    skills: [
      { name: 'Go', need: 'must', quote: 'Go or Python' },
      { name: 'Payments', need: 'nice', quote: 'Interest in crypto and payments' },
    ],
    experienceQuote: 'A software internship',
  },
  {
    id: 'j_goldman_analyst',
    company: 'Goldman Sachs',
    domain: 'goldmansachs.com',
    title: 'Investment Banking Summer Analyst',
    family: 'finance',
    level: 'intern',
    places: ['New York, NY'],
    remote: 'on_site',
    term: 'Summer 2027',
    url: 'https://higher.gs.com/roles/112233',
    source: 'workday',
    postedDaysAgo: 30,
    skills: [
      { name: 'Excel', need: 'must', quote: 'Advanced Excel and financial modeling' },
      { name: 'Financial modeling', need: 'must', quote: 'Financial modeling' },
    ],
    experienceQuote: 'Prior finance internship preferred',
  },
];

/** Plain words for a requirement name the sample text has ("Go" in "built the API in Go"). */
export const SKILL_WORDS = [
  'Go',
  'Python',
  'TypeScript',
  'JavaScript',
  'React',
  'SQL',
  'Postgres',
  'AWS',
  'Kubernetes',
  'Java',
  'C++',
  'Rust',
  'GraphQL',
  'Node.js',
  'Machine learning',
  'PyTorch',
  'Distributed systems',
  'Payments',
  'Figma',
  'Excel',
  'Tableau',
  'User research',
];

/** "Go" and "go", "Postgres" and "PostgreSQL", "JS" and "JavaScript": the same skill. */
const SAME: Record<string, string> = {
  postgresql: 'postgres',
  js: 'javascript',
  ts: 'typescript',
  ml: 'machine learning',
  'node.js': 'node',
  nodejs: 'node',
  golang: 'go',
};
export function skillKey(name: string): string {
  const k = name.trim().toLowerCase();
  return SAME[k] ?? k;
}

/**
 * Whether `text` names the skill as a whole word: "Java" is not inside "JavaScript"; one- and two-letter skills (Go,
 * R, C) are matched with their capital letter only, so "go to class" is not Go.
 */
export function mentions(text: string, skill: string): boolean {
  const names = [
    skill,
    ...Object.entries(SAME)
      .filter(([, v]) => v === skillKey(skill))
      .map(([k]) => k),
  ];
  return names.some((n) => {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const short = n.replace(/[^a-z0-9]/gi, '').length <= 2;
    const re = new RegExp(`(^|[^A-Za-z0-9+#])${esc}(?![A-Za-z0-9+#])`, short ? '' : 'i');
    return re.test(text);
  });
}
