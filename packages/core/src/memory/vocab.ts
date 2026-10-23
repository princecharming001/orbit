/**
 * The words a student uses for kinds of work, industries and places, mapped to the names Orbit stores (the codes in
 * `RecruitingGoals.targetFunctions`, and the same industry and location names the Settings suggestions offer). Used to
 * read "I'm targeting PM internships at fintech startups in New York" without a model, and to check that whatever a
 * model read is something the student actually said.
 */

/** A function code, the words that mean it, and the role the Goals page shows for it. */
export const FUNCTION_VOCAB: { code: string; re: RegExp; role: string }[] = [
  // the specific kinds of "product" work first, so "product design" is design and "product marketing" marketing
  {
    code: 'design',
    re: /\b(product design(?:ers?)?|ux\/ui|ui\/ux|ux|user experience|designers?|design)\b/i,
    role: 'Product Designer',
  },
  {
    code: 'marketing',
    re: /\b(product marketing|growth marketing|marketing|growth|brand)\b/i,
    role: 'Product Marketing Manager',
  },
  {
    code: 'pm',
    re: /\b(product manag(?:ers?|ement)|associate product managers?|apms?|(?<![\d:])pms?|product)\b/i,
    role: 'Product Manager',
  },
  {
    code: 'data',
    re: /\b(data scien(?:ce|tists?)|data analy(?:tics|sts?)|machine learning(?: engineer(?:ing|s)?)?|ml(?: engineer(?:ing|s)?)?|data engineer(?:ing|s)?|data)\b/i,
    role: 'Data Scientist',
  },
  {
    code: 'swe',
    re: /\b(software engineer(?:ing|s)?|software development|software developers?|swes?|sdes?|developers?|back-?end|front-?end|full[- ]?stack|(?<!(?:mechanical|electrical|civil|chemical|biomedical|aerospace|hardware|industrial) )engineering|software)\b/i,
    role: 'Software Engineer',
  },
  {
    code: 'ib',
    re: /\b(investment bank(?:ing|ers?)?|ib|m&a|banking)\b/i,
    role: 'Investment Banking Analyst',
  },
  {
    code: 'consulting',
    re: /\b((?:management |strategy )?consult(?:ing|ants?)|mbb)\b/i,
    role: 'Management Consultant',
  },
  {
    code: 'vc',
    re: /\b(venture capital|vcs?|venture(?![- ]backed))\b/i,
    role: 'Venture Capital Analyst',
  },
  {
    code: 'finance',
    re: /\b(private equity|hedge funds?|asset management|quant(?:itative)?(?: trading| research)?|sales (?:and|&) trading|trading|corporate finance|equity research|fp&a|finance)\b/i,
    role: 'Financial Analyst',
  },
  {
    code: 'ops',
    re: /\b(strategy (?:&|and) operations|biz ?ops|chief of staff|operations|ops)\b/i,
    role: 'Operations Analyst',
  },
  {
    code: 'research',
    re: /\b(research(?:ers?)?|phd)\b/i,
    role: 'Research Assistant',
  },
];

/** Industry names (as the Settings suggestions spell them) and the words that mean each. */
export const INDUSTRY_VOCAB: { name: string; re: RegExp }[] = [
  { name: 'Fintech', re: /\b(fin-?tech|financial technology|payments)\b/i },
  {
    name: 'Climate and energy',
    re: /\b(climate(?: ?tech)?|clean ?tech|clean energy|renewables?|energy|sustainability)\b/i,
  },
  {
    name: 'Healthcare and biotech',
    re: /\b(health ?tech|health ?care|digital health|biotech|med ?tech|life sciences|healthcare)\b/i,
  },
  {
    name: 'Artificial intelligence',
    re: /\b(ai|a\.i\.|artificial intelligence|gen ?ai|generative ai|llms?)\b/i,
  },
  { name: 'Crypto', re: /\b(crypto(?:currency)?|web3|blockchain|defi)\b/i },
  { name: 'Enterprise software', re: /\b(saas|b2b software|enterprise software|b2b)\b/i },
  {
    name: 'Developer tools and infrastructure',
    re: /\b(dev ?tools|developer tools|infrastructure|cloud)\b/i,
  },
  { name: 'Cybersecurity', re: /\b(cyber ?security|security)\b/i },
  { name: 'Consumer products', re: /\b(consumer(?: tech| products| apps?)?)\b/i },
  { name: 'E-commerce and retail', re: /\b(e-?commerce|retail)\b/i },
  { name: 'Media and entertainment', re: /\b(media|entertainment|music|film)\b/i },
  { name: 'Gaming', re: /\b(gaming|video games?|game studios?)\b/i },
  { name: 'Education', re: /\b(ed ?tech|education)\b/i },
  { name: 'Real estate', re: /\b(real estate|prop ?tech)\b/i },
  { name: 'Robotics', re: /\b(robotics)\b/i },
  { name: 'Semiconductors', re: /\b(semiconductors?|chips?)\b/i },
  { name: 'Aerospace and defense', re: /\b(aerospace|defense|space ?tech)\b/i },
  {
    name: 'Automotive and mobility',
    re: /\b(automotive|mobility|autonomous vehicles?|self-driving|electric vehicles?)\b/i,
  },
  { name: 'Government and public policy', re: /\b(government|public policy|gov ?tech)\b/i },
  { name: 'Nonprofit and social impact', re: /\b(non-?profits?|social impact)\b/i },
  { name: 'Sports', re: /\b(sports)\b/i },
  { name: 'Fashion', re: /\b(fashion)\b/i },
  { name: 'Technology', re: /\b(big tech|tech|technology)\b/i },
];

/**
 * Places, as the Settings suggestions name them. Two-letter abbreviations (NY, SF, LA, DC) count only in capitals, so
 * "la" in a sentence is not Los Angeles.
 */
export const LOCATION_VOCAB: { name: string; re: RegExp; caps?: RegExp }[] = [
  {
    name: 'New York City',
    re: /\b(new york(?: city)?|nyc|manhattan|brooklyn)\b(?! (?:university|life|times|state))/i,
    caps: /\bNY\b/,
  },
  {
    name: 'San Francisco Bay Area',
    re: /\b(san francisco|bay area|silicon valley|palo alto|mountain view|menlo park)\b/i,
    caps: /\bSF\b/,
  },
  { name: 'Seattle', re: /\bseattle\b/i },
  { name: 'Los Angeles', re: /\blos angeles\b/i, caps: /\bLA\b/ },
  { name: 'Boston', re: /\bboston\b(?! (?:university|college|consulting))/i },
  { name: 'Chicago', re: /\bchicago\b(?! booth)/i },
  { name: 'Austin', re: /\baustin\b/i },
  { name: 'Washington, DC', re: /\bwashington,? d\.?c\.?/i, caps: /\bD\.?C\.?\b/ },
  { name: 'Denver', re: /\bdenver\b/i },
  { name: 'Atlanta', re: /\batlanta\b/i },
  { name: 'Dallas', re: /\bdallas\b/i },
  { name: 'Houston', re: /\bhouston\b/i },
  { name: 'Miami', re: /\bmiami\b/i },
  { name: 'Philadelphia', re: /\b(philadelphia|philly)\b/i },
  { name: 'San Diego', re: /\bsan diego\b/i },
  { name: 'Pittsburgh', re: /\bpittsburgh\b/i },
  { name: 'Raleigh-Durham', re: /\b(raleigh|durham|research triangle)\b/i },
  { name: 'Toronto', re: /\btoronto\b/i },
  { name: 'London', re: /\blondon\b(?! school)/i },
  { name: 'Singapore', re: /\bsingapore\b/i },
  { name: 'Hong Kong', re: /\bhong kong\b/i },
  { name: 'Remote', re: /\b(remote(?:ly)?)\b/i },
];

/** Every match of a vocabulary in a phrase, earlier entries first, without two entries claiming the same words. */
function matchVocab<T extends { re: RegExp; caps?: RegExp }>(
  phrase: string,
  vocab: T[],
): { entry: T; start: number; end: number }[] {
  const taken: [number, number][] = [];
  const out: { entry: T; start: number; end: number }[] = [];
  for (const entry of vocab) {
    for (const re of [entry.re, entry.caps].filter((r): r is RegExp => !!r)) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      for (const m of phrase.matchAll(g)) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        if (taken.some(([a, b]) => start < b && end > a)) continue;
        taken.push([start, end]);
        out.push({ entry, start, end });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** Function codes in a phrase ("PM internships" → pm). */
export function functionsIn(phrase: string): string[] {
  return uniq(matchVocab(phrase, FUNCTION_VOCAB).map((m) => m.entry.code));
}

/** The role the Goals page shows for a function code ("pm" → "Product Manager"). */
export function roleForFunction(code: string): string | undefined {
  return FUNCTION_VOCAB.find((f) => f.code === code)?.role;
}

export function industriesIn(phrase: string): string[] {
  const hits = matchVocab(phrase, INDUSTRY_VOCAB).map((m) => m.entry.name);
  // "climate tech" is Climate, not also Technology
  const specific = hits.filter((h) => h !== 'Technology');
  return uniq(specific.length ? specific : hits);
}

export function locationsIn(phrase: string): string[] {
  return uniq(matchVocab(phrase, LOCATION_VOCAB).map((m) => m.entry.name));
}

/** Whether a name Orbit stores (a location, an industry, a function code) is in what the student wrote. */
export function vocabSaid(said: string, kind: 'function' | 'industry' | 'location', value: string): boolean {
  if (kind === 'function') return functionsIn(said).includes(value);
  if (kind === 'industry') return industriesIn(said).includes(value);
  return locationsIn(said).includes(value);
}
