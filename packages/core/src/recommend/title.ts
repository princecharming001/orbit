/**
 * Job titles as Discover and the job-change check read them: one normal form for the many ways a title is written
 * ("Sr. SWE", "Senior Software Engineer"; "Analyst, Investment Banking", "IB Analyst"), the level it sits at, whether
 * the person is actually in the role (an "Aspiring Investment Banker" is not a banker), a continuous similarity
 * between two titles, and whether a change of title is news.
 *
 * No library does this for job titles (we looked for one: npm has none for titles, and a general stemmer such as
 * `stemmer` (MIT) would have to be added to every server function's import map, since core is bundled into them), so
 * this is a small table of abbreviations and word forms on top of core's own Jaro-Winkler.
 */
import { jaroWinkler } from '../text/jaro';
import { stripDiacritics } from '../text/normalize';

/** Words in a title that say a function, by the student's target function codes (labels.ts). */
export const FUNCTION_TITLE: Record<string, RegExp> = {
  swe: /\b(software|engineer|developer|swe|sde|backend|frontend|full[- ]?stack|ml engineer|infrastructure|platform)\b/i,
  pm: /\b(product manager|product lead|\bpm\b|head of product|product owner|associate product)\b/i,
  ib: /\b(investment bank(ing|er)?|m&a|mergers|capital markets|leveraged finance|ecm|dcm|restructuring)\b/i,
  consulting:
    /\b(consult(ant|ing)?|strategy|bain|mckinsey|bcg|boston consulting|deloitte|accenture|oliver wyman|kearney|engagement manager)\b/i,
  data: /\b(data (scientist|analyst|engineer)|analytics|machine learning|ml|ai research|quant)\b/i,
  design: /\b(designer|design lead|ux|product design|ui)\b/i,
  finance:
    /\b(finance|fp&a|treasury|controller|accounting|private equity|hedge fund|asset management|wealth|credit|lending|underwriting)\b/i,
  marketing: /\b(marketing|growth|brand|content|communications|demand gen)\b/i,
  research: /\b(research|scientist|lab|phd|postdoc)\b/i,
  vc: /\b(venture|vc|investor|principal|partner)\b/i,
  ops: /\b(operations|ops|chief of staff|bizops|strategy & operations)\b/i,
};

/** A plain title for each target function: what a LinkedIn search asks for, and what a title is compared with. */
export const FUNCTION_SEARCH_TITLE: Record<string, string> = {
  swe: 'Software Engineer',
  pm: 'Product Manager',
  ib: 'Investment Banking Analyst',
  consulting: 'Consultant',
  data: 'Data Scientist',
  design: 'Product Designer',
  finance: 'Financial Analyst',
  marketing: 'Marketing Manager',
  research: 'Research Scientist',
  vc: 'Venture Capital Investor',
  ops: 'Operations Associate',
};

export type TitleLevel = 'student' | 'entry' | 'mid' | 'senior' | 'lead' | 'director' | 'vp' | 'exec';

export const LEVEL_RANK: Record<TitleLevel, number> = {
  student: 0,
  entry: 1,
  mid: 2,
  senior: 3,
  lead: 4,
  director: 5,
  vp: 6,
  exec: 7,
};

/** Abbreviations written out, before the title is cut into words. */
const PHRASES: [RegExp, string][] = [
  [/\bsr\b\.?/g, 'senior'],
  [/\bjr\b\.?/g, 'junior'],
  [/\b(swe|sde)\b/g, 'software engineer'],
  [/\bapm\b/g, 'associate product manager'],
  [/\btpm\b/g, 'technical program manager'],
  [/\bpm\b/g, 'product manager'],
  [/\bib\b/g, 'investment banking'],
  [/\bsvp\b/g, 'senior vice president'],
  [/\bevp\b/g, 'executive vice president'],
  [/\bvp\b/g, 'vice president'],
  [/\bmd\b/g, 'managing director'],
  [/\bmgr\b\.?/g, 'manager'],
  [/\bengr?\b\.?/g, 'engineer'],
  [/\bassoc\b\.?/g, 'associate'],
  [/\bmktg\b|\bmkt\b/g, 'marketing'],
  [/\bbiz ?dev\b|\bbd\b/g, 'business development'],
  [/\bm&a\b/g, 'mergers acquisitions'],
  [/\bfp&a\b/g, 'financial planning analysis'],
  [/\bs&t\b/g, 'sales trading'],
  [/\bpe\b/g, 'private equity'],
  [/\bvc\b/g, 'venture capital'],
  [/\bhr\b/g, 'people'],
  [/\bceo\b/g, 'chief executive officer'],
  [/\bcto\b/g, 'chief technology officer'],
  [/\bcoo\b/g, 'chief operating officer'],
  [/\bcfo\b/g, 'chief financial officer'],
  [/\bcpo\b/g, 'chief product officer'],
  [/\bcmo\b/g, 'chief marketing officer'],
  [/\bco-?founder\b/g, 'founder'],
  [/\bfull[- ]?stack\b/g, 'fullstack'],
  [/\bfront[- ]?end\b/g, 'frontend'],
  [/\bback[- ]?end\b/g, 'backend'],
  [/\bmachine learning\b/g, 'ml'],
  [/\bartificial intelligence\b/g, 'ai'],
  [/\buser experience\b/g, 'ux'],
  [/\bnew grad(uate)?\b/g, 'entry'],
];

/** One form per word: "engineering" and "engineer", "consulting" and "consultant" are the same role. */
const WORD_FORM: Record<string, string> = {
  engineering: 'engineer',
  engineers: 'engineer',
  consulting: 'consultant',
  consultants: 'consultant',
  banking: 'banker',
  bank: 'banker',
  bankers: 'banker',
  management: 'manager',
  managers: 'manager',
  managing: 'managing',
  science: 'scientist',
  sciences: 'scientist',
  analytics: 'analyst',
  analysis: 'analyst',
  analysts: 'analyst',
  designer: 'design',
  designers: 'design',
  designing: 'design',
  marketer: 'marketing',
  researcher: 'research',
  researchers: 'research',
  strategist: 'strategy',
  strategic: 'strategy',
  financial: 'finance',
  trader: 'trading',
  traders: 'trading',
  products: 'product',
  developers: 'developer',
  development: 'development',
  investments: 'investment',
  investing: 'investment',
  operation: 'operations',
  internship: 'intern',
  interns: 'intern',
  programs: 'program',
  programme: 'program',
  technologies: 'technology',
  technical: 'technology',
  sales: 'sales',
};

/** Words that say the level, not the role: they decide seniority and are left out of the comparison. */
const LEVEL_WORDS = new Set([
  'intern',
  'summer',
  'coop',
  'co',
  'op',
  'junior',
  'senior',
  'staff',
  'principal',
  'lead',
  'head',
  'chief',
  'vice',
  'president',
  'director',
  'managing',
  'executive',
  'entry',
  'level',
  'incoming',
  'aspiring',
  'founder',
  'owner',
  'partner',
  'officer',
  'apprentice',
  'trainee',
]);

/** Level words whose arrival or departure is a new role (a ladder step and "entry level" are not). */
const LEVEL_CHANGE = new Set([
  'intern',
  'summer',
  'junior',
  'senior',
  'staff',
  'principal',
  'lead',
  'head',
  'chief',
  'vice',
  'president',
  'director',
  'managing',
  'executive',
  'founder',
  'owner',
  'partner',
]);

/** Role nouns that say little alone ("Analyst" is a banker at a bank and a consultant at McKinsey): half weight. */
const GENERIC = new Set([
  'analyst',
  'associate',
  'manager',
  'engineer',
  'consultant',
  'specialist',
  'member',
  'representative',
  'coordinator',
  'assistant',
  'scientist',
  'developer',
  'advisor',
  'fellow',
  'generalist',
]);

const STOP = new Set([
  'a',
  'an',
  'and',
  'at',
  'for',
  'in',
  'of',
  'on',
  'the',
  'to',
  'with',
  'team',
  'group',
  'global',
  'i',
  'ii',
  'iii',
  'iv',
  'v',
  'l1',
  'l2',
  'l3',
  'l4',
  'l5',
  'l6',
  'l7',
  'l8',
  'l9',
]);

/** Words that are near enough to count most of the way (an "ML Engineer" and an "AI Engineer"). */
const NEAR: Record<string, string[]> = {
  ml: ['ai', 'data'],
  ai: ['ml'],
  ux: ['design', 'ui'],
  ui: ['design', 'ux'],
  design: ['ux', 'ui'],
  developer: ['engineer'],
  engineer: ['developer'],
  frontend: ['fullstack'],
  backend: ['fullstack', 'infrastructure', 'platform'],
  fullstack: ['frontend', 'backend'],
  investment: ['banker', 'investor'],
  investor: ['investment', 'venture'],
  venture: ['investor'],
  strategy: ['consultant', 'operations'],
  operations: ['strategy'],
};

/** Lowercase, accents gone, abbreviations written out, separators as spaces. */
export function normalizeTitle(title: string | undefined): string {
  if (!title) return '';
  let s = ` ${stripDiacritics(title).toLowerCase()} `;
  // "(Contract)", "[Remote]": what the role is, not part of its name
  s = s.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  for (const [re, to] of PHRASES) s = s.replace(re, ` ${to} `);
  return s
    .replace(/[^a-z0-9&+#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordForm(w: string): string {
  const f = WORD_FORM[w];
  if (f) return f;
  // plurals: "Products" and "Product"; not "sales", "operations", "analytics" (mapped above) or short words
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}

/** The words of a title that say what the role is (level words and filler left out), one form each. */
export function titleWords(title: string | undefined): string[] {
  const out: string[] = [];
  for (const raw of normalizeTitle(title).split(' ')) {
    if (!raw || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    const w = wordForm(raw);
    if (LEVEL_WORDS.has(w) || STOP.has(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** The target functions a title names (codes from labels.ts). */
export function titleFunctions(title: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!title) return out;
  const t = `${title} ${normalizeTitle(title)}`;
  for (const [code, re] of Object.entries(FUNCTION_TITLE)) if (re.test(t)) out.add(code);
  return out;
}

const weight = (w: string) => (GENERIC.has(w) ? 0.5 : 1);

function wordMatch(w: string, others: string[]): number {
  let best = 0;
  for (const o of others) {
    if (o === w) return 1;
    if (NEAR[w]?.includes(o) || NEAR[o]?.includes(w)) best = Math.max(best, 0.7);
    else if (w.length >= 5 && o.length >= 5) {
      // a spelling variant ("analytic" and "analytics"), never two different words that share a prefix
      const jw = jaroWinkler(w, o);
      if (jw >= 0.94) best = Math.max(best, 0.85 * jw);
    }
  }
  return best;
}

/** Weighted soft Dice of two word lists, 0..1. */
function wordOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  let num = 0;
  let den = 0;
  for (const w of a) {
    num += weight(w) * wordMatch(w, b);
    den += weight(w);
  }
  for (const w of b) {
    num += weight(w) * wordMatch(w, a);
    den += weight(w);
  }
  return den ? num / den : 0;
}

/**
 * How alike two titles are, 0..1 and continuous: the same role written two ways is 1 ("IB Analyst", "Analyst,
 * Investment Banking"), a level apart is still the same role ("Senior Software Engineer" and "Software Engineer"), a
 * role in the same function is half way, and two functions that differ pull it down.
 */
export function titleSimilarity(a: string | undefined, b: string | undefined): number {
  const A = titleWords(a);
  const B = titleWords(b);
  let s = wordOverlap(A, B);
  const fa = titleFunctions(a);
  const fb = titleFunctions(b);
  if (fa.size && fb.size) {
    const shared = [...fa].some((f) => fb.has(f));
    s = shared ? 0.5 + 0.5 * s : s * 0.6;
  }
  return Math.round(Math.max(0, Math.min(1, s)) * 1000) / 1000;
}

/** Strips the trailing level a ladder adds ("Engineer II", "Analyst 2", "L5"): a step on a ladder is not news. */
function withoutLadder(t: string): string {
  return t.replace(/\s+\b(i{1,3}|iv|v|[1-5]|l[1-9])\s*$/i, '').trim();
}

/** The level a title sits at, from its words; undefined for an empty title. */
export function titleLevel(title: string | undefined): TitleLevel | undefined {
  const t = ` ${withoutLadder(normalizeTitle(title))} `;
  if (!t.trim()) return undefined;
  if (
    /\b(intern|internship|summer analyst|summer associate|co ?op|student|undergraduate|incoming|aspiring|candidate|trainee)\b/.test(
      t,
    )
  )
    return 'student';
  if (/\bchief of staff\b/.test(t)) return 'senior';
  if (/\bvice president\b/.test(t)) return 'vp';
  if (
    /\b(chief|founder|owner|president|managing director|general partner|managing partner|partner|executive director)\b/.test(
      t,
    )
  )
    return 'exec';
  if (/\b(director|head of|head)\b/.test(t)) return 'director';
  if (
    /\b(principal|staff|tech lead|team lead|lead|engineering manager|general manager|senior manager|people manager|manager of)\b/.test(
      t,
    )
  )
    return 'lead';
  if (/\b(senior|engagement manager)\b/.test(t)) return 'senior';
  if (/\b(junior|associate|analyst|entry|apprentice|fellow|assistant|graduate)\b/.test(t)) return 'entry';
  return 'mid';
}

/**
 * How good a level is for a student's coffee chat: someone one to five years out (an analyst, an associate, an
 * engineer) remembers recruiting and answers; a director rarely has the time, a fellow student has no inside view.
 */
export const LEVEL_FIT: Record<TitleLevel, number> = {
  student: 0.35,
  entry: 1,
  mid: 0.9,
  senior: 0.72,
  lead: 0.52,
  director: 0.32,
  vp: 0.24,
  exec: 0.14,
};

/** How likely someone at this level answers a student they do not know, 0..1 (juniors answer most). */
export const LEVEL_ANSWERS: Record<TitleLevel, number> = {
  student: 0.85,
  entry: 0.95,
  mid: 0.85,
  senior: 0.75,
  lead: 0.62,
  director: 0.48,
  vp: 0.4,
  exec: 0.3,
};

export type TitleStatus = 'working' | 'student' | 'aspiring' | 'incoming';

/**
 * Whether a title or headline says the person holds the role: "Aspiring Investment Banker", "Seeking SWE roles" and
 * "CS student at Michigan" do not, "Incoming Analyst at Evercore" will (but does not yet).
 */
export function titleStatus(text: string | undefined): TitleStatus {
  const t = ` ${(text ?? '').toLowerCase()} `;
  if (/\b(aspiring|seeking|looking for|open to (work|opportunities|roles)|future|hopeful|wannabe)\b/.test(t))
    return 'aspiring';
  if (/\bincoming\b/.test(t)) return 'incoming';
  if (
    /\b(student|undergrad(uate)?|candidate|class of|studying|major(ing)?|freshman|sophomore|junior at|senior at)\b|'\d{2}\b/.test(
      t,
    )
  )
    return 'student';
  return 'working';
}

/**
 * Whether a new title is news worth a congratulation: a new level ("Senior", "Staff", "Associate" after "Analyst"),
 * a new function, or a different role. Not news: case, spacing, punctuation, a ladder step ("II"), an abbreviation
 * written out, or a team added or dropped ("Software Engineer, Payments").
 */
export function titleChangedMeaningfully(before: string | undefined, after: string | undefined): boolean {
  if (!before?.trim() || !after?.trim()) return false;
  const la = titleLevel(before);
  const lb = titleLevel(after);
  if (la && lb && la !== lb) return true;
  // a level word added or dropped ("Staff Design Lead" after "Design Lead", "Software Engineer" after its intern role)
  const levels = (t: string) =>
    new Set(
      withoutLadder(normalizeTitle(t))
        .split(' ')
        .map(wordForm)
        .filter((w) => LEVEL_CHANGE.has(w)),
    );
  const ka = levels(before);
  const kb = levels(after);
  if (ka.size !== kb.size || [...ka].some((w) => !kb.has(w))) return true;
  const fa = titleFunctions(before);
  const fb = titleFunctions(after);
  if (fa.size && fb.size && ![...fa].some((f) => fb.has(f))) return true;
  const a = titleWords(withoutLadder(normalizeTitle(before)));
  const b = titleWords(withoutLadder(normalizeTitle(after)));
  if (!a.length && !b.length) return normalizeTitle(before) !== normalizeTitle(after);
  // a team or product added to (or dropped from) the same role
  const within = (x: string[], y: string[]) => x.length > 0 && x.every((w) => y.includes(w));
  if (within(a, b) || within(b, a)) return false;
  return wordOverlap(a, b) < 0.6;
}

/** A role the student targets ("Software Engineering Intern") as the title of people in it ("Software Engineer"). */
export function searchTitleFor(role: string): string {
  const t = role
    .replace(
      /\b(summer|intern(ship)?|co-?op|new grad(uate)?|entry[- ]level|full[- ]time|part[- ]time)\b/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return role.trim();
  return t
    .replace(/\bengineering\b(?=\s*$)/i, 'Engineer')
    .replace(/\bmanagement\b(?=\s*$)/i, 'Manager')
    .replace(/\bdesign\b(?=\s*$)/i, 'Designer')
    .replace(/\bconsulting\b(?=\s*$)/i, 'Consultant')
    .replace(/\bbanking\b(?=\s*$)/i, 'Banking Analyst')
    .replace(/^(\w)/, (c) => c.toUpperCase());
}
