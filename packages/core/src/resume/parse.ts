import type { ResumeFacet } from '../types';

const SKILL_SPLIT = /[,;•|·]/;
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const SEASON = '(?:spring|summer|fall|autumn|winter)';
const DATE_TOKEN = `(?:${MONTH}\\s*'?\\d{2,4}|${SEASON}\\s+\\d{4}|\\d{1,2}\\/\\d{2,4}|\\d{4})`;
const DATE_RANGE = new RegExp(
  `(${DATE_TOKEN})\\s*(?:-|–|—|to|until)\\s*(${DATE_TOKEN}|present|current|now|ongoing)`,
  'i',
);
/** A single date ("May 2027", "Expected May 2027", "Summer 2025") standing in for a range. */
const DATE_SINGLE = new RegExp(
  `(?:expected\\s+|anticipated\\s+|graduat\\w*\\s+)?(${MONTH}\\s+\\d{4}|${SEASON}\\s+\\d{4})`,
  'i',
);
const US_STATE =
  'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY';
/** "San Francisco, CA", "London, UK", "Remote" at the end of a header line */
const LOCATION_TAIL = new RegExp(
  `(?:^|[,|–—-]\\s*|\\s{2,})((?:[A-Z][A-Za-z.'’]+(?:\\s[A-Z][A-Za-z.'’]+){0,2}),\\s*(?:${US_STATE}|USA|U\\.S\\.|UK|United Kingdom|Canada|India|China|Singapore|Germany|France|Japan|Remote)|Remote|Hybrid)\\s*$`,
);
const CONTACT =
  /@|\b(?:linkedin\.com|github\.com|https?:\/\/|www\.)|\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|\+\d[\d\s().-]{7,}/i;
const TITLE_WORDS =
  /\b(intern(ship)?|analyst|engineer(ing)?|developer|associate|president|vice president|vp|founder|co-founder|cofounder|manager|director|consultant|assistant|researcher|research|teaching|ta|fellow|member|lead|leader|chair|chairperson|officer|treasurer|secretary|captain|coordinator|designer|scientist|specialist|representative|tutor|mentor|volunteer|head|owner|contractor|trader|banker|advisor|ambassador|organizer|editor|writer|counselor|instructor)\b/i;
const SCHOOL_WORDS = /\b(university|college|institute|school|academy|polytechnic|conservatory)\b/i;
const DEGREE_WORDS =
  /(^|\s)(b\.?\s?s\.?(e\.?)?|b\.?\s?a\.?|a\.?\s?b\.?|s\.?\s?b\.?|b\.?\s?sc\.?|b\.?\s?eng\.?|b\.?\s?f\.?\s?a\.?|bba|bsba|m\.?\s?s\.?|m\.?\s?a\.?|m\.?\s?eng\.?|mba|mfa|ph\.?\s?d\.?|bachelor|master|minor|major|degree|concentration|candidate)(?=\s|,|$)/i;

const STOP = new Set([
  'the',
  'and',
  'with',
  'for',
  'that',
  'this',
  'from',
  'into',
  'using',
  'used',
  'across',
  'over',
  'under',
  'while',
  'where',
  'which',
  'their',
  'them',
  'they',
  'have',
  'has',
  'had',
  'was',
  'were',
  'our',
  'your',
  'you',
  'are',
  'but',
  'not',
  'all',
  'any',
  'can',
  'will',
  'per',
  'via',
  'led',
  'built',
  'worked',
  'team',
  'university',
  'school',
  'college',
  'student',
  // dates are not skills
  'january',
  'february',
  'march',
  'april',
  'june',
  'july',
  'august',
  'september',
  'sept',
  'october',
  'november',
  'december',
  'present',
  'current',
  'ongoing',
  'spring',
  'summer',
  'fall',
  'autumn',
  'winter',
  'expected',
]);

export function extractKeywords(text: string, max = 12): string[] {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().match(/[a-z][a-z+#.]{2,}/g) ?? []) {
    // "acquisition." ends a sentence; "node.js" keeps its inner dot
    const w = raw.replace(/\.+$/, '');
    if (STOP.has(w) || w.length < 4) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
}

function toIsoMonth(s: string): string | undefined {
  const t = s.toLowerCase();
  if (/present|current|now|ongoing/.test(t)) return undefined;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const seasons: Record<string, string> = { spr: '03', sum: '06', fal: '09', aut: '09', win: '12' };
  const m = t.match(/([a-z]{3})[a-z]*\.?\s*'?(\d{4}|\d{2})\b/);
  if (m) {
    const year = m[2]!.length === 2 ? `20${m[2]}` : m[2]!;
    const mo = months.indexOf(m[1]!);
    if (mo >= 0) return `${year}-${String(mo + 1).padStart(2, '0')}-01`;
    if (seasons[m[1]!]) return `${year}-${seasons[m[1]!]}-01`;
    return `${year}-01-01`;
  }
  const mm = t.match(/(\d{1,2})\/(\d{2,4})/);
  if (mm) return `${mm[2]!.length === 2 ? `20${mm[2]}` : mm[2]}-${mm[1]!.padStart(2, '0')}-01`;
  const y = t.match(/(\d{4})/);
  return y ? `${y[1]}-01-01` : undefined;
}

const HEADING_WORDS = new Set(
  (
    'experience experiences employment work history internship internships leadership activities involvement ' +
    'extracurricular extracurriculars volunteer volunteering service organizations organization education academic ' +
    'academics projects project portfolio skills skill technologies technical tools languages competencies interests ' +
    'hobbies summary objective profile about me honors honor awards award achievements certifications certification ' +
    'publications coursework additional information references scholarships patents presentations relevant ' +
    'professional research selected other related industry teaching consulting campus community key core computer ' +
    'programming software personal career qualifications and of the for in & a'
  ).split(' '),
);
const STRONG_HEADING =
  /\b(experience|education|projects?|skills|leadership|activities|involvement|honors|awards|summary|objective|interests|certifications?|publications|coursework)\b/;

type Section =
  | 'header'
  | 'summary'
  | 'experience'
  | 'education'
  | 'project'
  | 'skills'
  | 'interests'
  | 'other';

/**
 * Recognise a section heading, including headings with extra words ("RELEVANT EXPERIENCE",
 * "LEADERSHIP & ACTIVITIES", "EDUCATION & HONORS"). Honors, awards, certifications, coursework and
 * "additional information" map to 'other', whose lines are not turned into facets.
 */
export function resumeSectionOf(rawLine: string): Section | undefined {
  const line = rawLine.replace(/^#+\s*/, '').trim();
  if (!line || /^[-•*▪◦●]/.test(line)) return undefined;
  const bare = line.replace(/[:\s]+$/, '');
  // "Languages: Go, Python" is a labelled line inside a section, not a heading
  if (bare.includes(':')) return undefined;
  if (bare.length > 45 || /\d/.test(bare) || /[.!?]$/.test(bare)) return undefined;
  if (/\s{3,}|\t/.test(bare)) return undefined;
  const words = bare.split(/\s+/);
  if (words.length > 5) return undefined;
  const letters = bare.replace(/[^A-Za-z]/g, '');
  const upper = letters.length > 0 && letters === letters.toUpperCase();
  const titled = words.every((w) => /^[A-Z&/,]|^(and|of|the|for|in)$/.test(w));
  if (!upper && !titled && !line.endsWith(':')) return undefined;
  const l = bare.toLowerCase();
  // every word must be heading vocabulary ("Relevant Experience"), so "Dell Technologies" is not a heading;
  // a line in capitals may carry up to two other words when it has a strong section keyword
  const unknown = l.split(/[\s&/,]+/).filter((w) => w && !HEADING_WORDS.has(w)).length;
  if (unknown > (upper && STRONG_HEADING.test(l) ? 2 : 0)) return undefined;
  if (/\b(projects?|portfolio)\b/.test(l)) return 'project';
  if (/\b(education|academics?)\b/.test(l)) return 'education';
  if (
    /\b(experience|employment|work history|internships?|leadership|activities|involvement|extracurriculars?|volunteer(ing)?|service|organizations)\b/.test(
      l,
    )
  )
    return 'experience';
  if (/\b(skills|technologies|technical|tools|languages|competencies)\b/.test(l)) return 'skills';
  if (/\b(interests|hobbies)\b/.test(l)) return 'interests';
  if (/\b(summary|objective|profile|about me|about)\b/.test(l)) return 'summary';
  if (
    /\b(honors|awards|achievements|certifications?|publications|coursework|additional|information|references|scholarships|patents|presentations)\b/.test(
      l,
    )
  )
    return 'other';
  return undefined;
}

// the glyphs resumes and PDF-to-text use for a bullet, including the middle dot and the private-use dot from Word
const BULLET = /^(?:[-•*▪◦●➢►–·∙‣⁃○■□✓✔➤→\uF0B7\uF0A7\uF076\uF0D8]|o(?=\s))\s*/;
/** Employer, a dash, the role, the dates in brackets, then optionally what they did, all on one line. */
const INLINE_ENTRY = /^([^—–]+?)\s+[—–-]\s+([^().]+?)\s*\(([^)]*\d{4}[^)]*)\)[.,;:]?\s*(.*)$/;
/**
 * Role, employer and place, a dash, the dates, then what they did, all on one line: "Summer Analyst Intern, Comerica
 * Bank, Detroit, MI — June 2026 to August 2026. Built a DCF model for a mid-market client". Returns the header (with
 * the dates), and the description after them.
 */
function datedInline(line: string): { header: string; desc: string } | undefined {
  const dm = line.match(DATE_RANGE) ?? line.match(DATE_SINGLE);
  if (!dm || dm.index === undefined || dm.index === 0) return undefined;
  const before = line.slice(0, dm.index);
  const after = line.slice(dm.index + dm[0].length);
  if (!/\s[—–-]\s*$/.test(before) && !/\(\s*$/.test(before)) return undefined;
  const rest = after.replace(/^\s*\)/, '').match(/^\s*(?:[.;:,]\s+(.*)|\.?\s*)$/);
  if (!rest) return undefined;
  const header = before.replace(/[\s,(—–-]+$/, '');
  if (!header || header.split(/\s+/).length > 14) return undefined;
  return { header: `${header}   ${dm[0]}`, desc: rest[1]?.trim() ?? '' };
}
const stripBullet = (l: string) => l.replace(BULLET, '').trim();
const isRule = (l: string) => /^[\W_]+$/.test(l);

/** Title-case words typed in capitals ("GOLDMAN SACHS" -> "Goldman Sachs"), keeping short acronyms (BU, IBM). */
function fixCaps(s: string): string {
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (!letters || letters !== letters.toUpperCase()) return s;
  return s.replace(/[A-Za-z][A-Za-z'’]*/g, (w) => (w.length <= 3 ? w : w[0]! + w.slice(1).toLowerCase()));
}

interface Entry {
  section: Section;
  headers: number;
  title?: string;
  org?: string;
  location?: string;
  range?: RegExpMatchArray;
  single?: string;
  details: string[];
  /** header parts that are neither role nor employer (a project's stack) */
  extra: string[];
  body: string[];
  /** the entry opened with a role line and no employer (a second role under the same employer) */
  titleOnlyFirst: boolean;
}

const newEntry = (section: Section): Entry => ({
  section,
  headers: 0,
  details: [],
  extra: [],
  body: [],
  titleOnlyFirst: false,
});

/** A line that only carries dates and/or a location belongs to the entry above it. */
function isMetaLine(line: string): boolean {
  const rest = line.replace(DATE_RANGE, '').replace(DATE_SINGLE, '').trim();
  if (!rest.replace(/[\s,|–—-]+/g, '')) return true;
  if (/\s{3,}|\t/.test(rest)) return false;
  return new RegExp(`^${LOCATION_TAIL.source}`).test(rest) || /^(remote|hybrid)$/i.test(rest);
}

/** Pull dates and a trailing location off a header line; return what is left, split into parts. */
function headerParts(line: string, e: Entry): string[] {
  let s = line.replace(/\t/g, '   ');
  const dr = s.match(DATE_RANGE);
  if (dr) {
    e.range ??= dr;
    s = s.replace(DATE_RANGE, '   ');
  } else {
    const ds = s.match(DATE_SINGLE);
    if (ds) {
      e.single ??= ds[1];
      s = s.replace(ds[0], '   ');
    }
  }
  s = s.replace(/[\s,|–—-]+$/, '').replace(/^[\s,|–—-]+/, '');
  const loc = s.match(LOCATION_TAIL);
  if (loc && loc.index !== undefined) {
    e.location ??= loc[1];
    s = s.slice(0, loc.index);
  }
  return s
    .split(/\s{3,}|\s+[|–—@·•]\s+|\s+-\s+|,\s+/)
    .map((p) =>
      p
        .replace(/^[\s,|–—·•.-]+|[\s,|–—·•-]+$/g, '')
        // a stray full stop after a name ("Ross School of Business .") is not part of it
        .replace(/\s+\.$/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((p) => p.length > 1 && !/^(present|current)$/i.test(p));
}

/** "Detroit MI" or "New York, NY" on its own: a place, not part of the title. */
const CITY_STATE = new RegExp(`^[A-Z][A-Za-z.'’]+(?:\\s[A-Z][A-Za-z.'’]+){0,2},?\\s(?:${US_STATE})$`);

/** A two-letter state code or a state's name, the second half of "Detroit, MI" once a header is split on commas. */
const STATE_PART = new RegExp(
  `^(?:${US_STATE}|Michigan|California|New York|Illinois|Massachusetts|Texas|Pennsylvania|Ohio|Georgia|Washington|Virginia|North Carolina|New Jersey|Florida|Colorado|Indiana|Wisconsin|Minnesota|Maryland|Connecticut)$`,
);

function assignParts(rawParts: string[], e: Entry): void {
  // "Detroit", "MI" split apart by the comma between them: one place, never part of the role
  const parts: string[] = [];
  for (const p of rawParts) {
    const prev = parts[parts.length - 1];
    if (prev && STATE_PART.test(p.trim()) && /^[A-Z][A-Za-z.'’]+(?:\s[A-Z][A-Za-z.'’]+){0,2}$/.test(prev)) {
      parts.pop();
      if (e.section !== 'education') e.location ??= `${prev}, ${p.trim()}`;
      continue;
    }
    parts.push(p);
  }
  for (const raw of parts) {
    const p = fixCaps(raw);
    if (e.section !== 'education' && CITY_STATE.test(p)) {
      e.location ??= p;
      continue;
    }
    if (e.section === 'education') {
      const degree = DEGREE_WORDS.test(p);
      if (SCHOOL_WORDS.test(p) && !e.org && !degree) e.org = p;
      else if (degree && (!e.title || !DEGREE_WORDS.test(e.title))) e.title = p;
      // "University of California, Berkeley" / "Boston University, Questrom School of Business"
      else if (e.org && !e.title && !degree) e.org = `${e.org}, ${p}`;
      else if (!e.title) e.title = p;
      else if (!e.org) e.org = p;
      continue;
    }
    if (e.section === 'project') {
      // "Campus Marketplace | React, Node": the name, then the stack
      if (!e.title) e.title = p;
      else e.extra.push(p);
      continue;
    }
    const isTitle = TITLE_WORDS.test(p) && !SCHOOL_WORDS.test(p);
    if (isTitle && !e.title) e.title = p;
    else if (!e.org) e.org = p;
    else if (!e.title) e.title = p;
    // "Product Management Intern, Payments Onboarding": the team stays with the role
    else if (e.title.length + p.length < 70) e.title = `${e.title}, ${p}`;
  }
}

const PUFFERY =
  /^((highly|very|extremely|self-motivated|motivated|detail-oriented|driven|dedicated|hard-?working|enthusiastic|ambitious|dynamic|goal-oriented|passionate|creative|energetic|diligent|organized)[,\s]+(and\s+)?)+/i;

/** First sentence of a resume summary, rewritten as "<Name> is ..." so it can describe the student, or undefined. */
export function summarySentence(text: string, name?: string): string | undefined {
  let s = (
    text
      .replace(/\s+/g, ' ')
      .trim()
      .split(/(?<=[.!?])\s+/)[0] ?? ''
  )
    .replace(/[.!?]+$/, '')
    .trim();
  if (!s || CONTACT.test(s) || /[|·•]/.test(s)) return undefined;
  // "Objective: To obtain ..." / "Summary - ..."
  s = s.replace(
    /^(?:professional\s+)?(?:summary|objective|profile|about me|career objective)\s*[:\-–—]\s*/i,
    '',
  );
  if (!s) return undefined;
  const subject = name?.trim() || 'The candidate';
  s = s
    .replace(/\bpassionate about\b/gi, 'interested in')
    .replace(/\bleverag(e|ing)\b/gi, (_, x: string) => (x === 'e' ? 'use' : 'using'))
    .replace(/\bresults[- ]driven\b,?\s*/gi, '');
  const first = (s.split(/\s+/)[0] ?? '').toLowerCase();
  let rest: string;
  const iam = s.match(/^(?:i am|i'm)\s+(.*)$/i);
  // already in the third person (a summary written by a model, or "This candidate is ...")
  const generic = s.match(/^(?:this|the)\s+(?:candidate|student|applicant|individual)\s+is\s+(.*)$/i);
  const pronoun = s.match(/^(?:he|she|they)\s+(?:is|are)\s+(.*)$/i);
  const named = s.match(/^((?:[A-Z][\p{L}'’.-]+\s+){1,3})is\s+(.*)$/u);
  // "A junior at Cornell studying CS, Alex Rivera is interested in payments"
  const appositive = s.match(/^((?:[Aa]|[Aa]n)\s+[^,]{3,90}),\s+(?:[A-Z][\p{L}'’.-]+\s+){1,3}is\s+(.*)$/u);
  if (iam) rest = iam[1]!;
  else if (generic) rest = generic[1]!;
  else if (pronoun) rest = pronoun[1]!;
  else if (appositive)
    rest = `${appositive[1]![0]!.toLowerCase()}${appositive[1]!.slice(1)} who is ${appositive[2]}`;
  else if (named && !/^(I|My|We|Our)\s/.test(named[1]!)) rest = named[2]!;
  else if (/^to\s+(obtain|secure|gain|find|land|pursue)\s+/i.test(s))
    rest = `seeking ${s.replace(/^to\s+(obtain|secure|gain|find|land|pursue)\s+/i, '')}`;
  else if (/^(seeking|pursuing|looking|aspiring|interested|currently|studying)$/.test(first))
    rest = s[0]!.toLowerCase() + s.slice(1);
  else if (/^(a|an)$/.test(first)) rest = s[0]!.toLowerCase() + s.slice(1);
  else if (/^(i|my|we|our)$/.test(first)) return undefined;
  else {
    // "Motivated, detail-oriented junior studying ..." -> "a junior studying ..."
    const np = s.replace(PUFFERY, '');
    if (!np) return undefined;
    const lowered =
      /^[A-Z][a-z]+\b/.test(np) && !/^[A-Z][a-z]+\s+[A-Z]/.test(np) ? np[0]!.toLowerCase() + np.slice(1) : np;
    rest = `${/^[aeiou]/i.test(lowered) ? 'an' : 'a'} ${lowered}`;
  }
  rest = rest
    .replace(PUFFERY, '')
    .replace(
      /^(a|an)\s+(?:(?:highly|very)\s+)?(?:self-motivated|motivated|detail-oriented|driven|dedicated|hard-?working|enthusiastic|ambitious|dynamic|goal-oriented|creative|energetic|diligent)[,\s]+(?:and\s+)?/i,
      (_, a: string) => `${a} `,
    )
    .trim();
  // "an motivated junior" after the puffery is gone: fix the article
  rest = rest.replace(
    /^(a|an)\s+(\S)/i,
    (_, _a: string, c: string) => `${/[aeiou]/i.test(c) ? 'an' : 'a'} ${c}`,
  );
  // the student is the subject now: drop a trailing clause written in the first person ("where I can ...")
  // or one that switches to a pronoun ("and he is interested in ...")
  const firstPerson = rest.search(/\b(I|my|me|I'm|I've|he|she|his|her|him|they|their)\b/);
  if (firstPerson >= 0) {
    const head = rest.slice(0, firstPerson);
    const cut = Math.max(
      ...[/,\s/g, /\swhere\s/g, /\swhich\s/g, /\sthat\s/g, /\sso\s/g, /\sto\s/g, /\sand\s/g].map((re) => {
        let last = -1;
        for (const m of head.matchAll(re)) last = m.index ?? last;
        return last;
      }),
    );
    if (cut <= 0) return undefined;
    rest = rest.slice(0, cut).trim();
  }
  const words = rest.split(/\s+/).length;
  if (words < 3 || words > 32) return undefined;
  return `${subject} is ${rest}.`;
}

/**
 * The clause that completes "I'm ..." in an opener, from a summary facet ("Ravi Jain is a junior at
 * Michigan studying CS." -> "a junior at Michigan studying CS"), or undefined when the summary does not
 * describe the student as "a/an ..." in one short sentence. Contact details never pass.
 */
export function resumeOneLiner(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const sentence = summarySentence(summary, 'Student');
  if (!sentence) return undefined;
  const m = sentence.match(/^Student is ((?:a|an)\s.+?)\.?$/);
  if (!m) return undefined;
  const clause = m[1]!.trim();
  if (CONTACT.test(clause) || /[|·•@]/.test(clause)) return undefined;
  if (clause.split(/\s+/).length > 18) return undefined;
  return clause;
}

/**
 * Heuristic resume parser over plain text. Good enough to seed facets the student then confirms.
 * - The contact header (name, email, phone, links, address) never becomes a facet.
 * - A summary facet comes only from a SUMMARY/OBJECTIVE/PROFILE section (or prose in the header) and is
 *   phrased "<Name> is ..."; otherwise there is none.
 * - Employer, role, dates and location are gathered across the header lines of an entry, so the
 *   chronological ("Stripe   San Francisco, CA" / "PM Intern   Jun 2025 – Aug 2025"), two-column
 *   ("Role" / "Company" / "Dates") and pipe ("Google | SWE Intern | May 2024 – Aug 2024") layouts all
 *   give one facet with both title and organization.
 */
export function heuristicResumeParse(
  text: string,
  resumeId: string,
  opts: { name?: string } = {},
): ResumeFacet[] {
  const lines = text.replace(/\r/g, '').replace(/ /g, ' ').split('\n');
  let section: Section = 'header';
  const facets: ResumeFacet[] = [];
  let id = 0;
  let name = opts.name;
  const summaryLines: string[] = [];
  const headerProse: string[] = [];
  let e: Entry | undefined;
  let lastOrg: string | undefined;

  const finish = () => {
    if (!e) return;
    const cur = e;
    e = undefined;
    if (!cur.title && !cur.org && !cur.body.length) return;
    // a role line straight after another role's bullets, with no employer of its own: same employer
    if (!cur.org && cur.title && cur.titleOnlyFirst && cur.section === 'experience' && lastOrg)
      cur.org = lastOrg;
    if (cur.org && cur.section === 'experience') lastOrg = cur.org;
    const kind: ResumeFacet['kind'] =
      cur.section === 'education' ? 'education' : cur.section === 'project' ? 'project' : 'experience';
    const sentence = (b: string) => (/[.!?]$/.test(b) ? b : `${b}.`);
    // a line that is only punctuation (a stray "." left by a PDF) adds nothing
    cur.body = cur.body.map((b) => b.replace(/\s+([.,;:])/g, '$1').trim()).filter((b) => /\w{2}/.test(b));
    cur.details = cur.details
      .map((b) => b.replace(/\s+([.,;:])/g, '$1').trim())
      .filter((b) => /\w{2}/.test(b));
    const head = [cur.title, cur.org].filter(Boolean).join(', ');
    const when = cur.range ? cur.range[0] : cur.single;
    // bullets describe the work; entries without bullets (education) read as their header plus details
    const body = cur.body.length
      ? [...cur.body, ...cur.details].map(sentence).join(' ')
      : cur.details.length
        ? [`${head}${when ? ` (${when})` : ''}`, ...cur.details].map(sentence).join(' ')
        : '';
    facets.push({
      id: `${resumeId}-f${id++}`,
      resumeId,
      kind,
      title: cur.title,
      organizationName: cur.org,
      startDate: cur.range ? toIsoMonth(cur.range[1]!) : undefined,
      endDate: cur.range ? toIsoMonth(cur.range[2]!) : cur.single ? toIsoMonth(cur.single) : undefined,
      text: (body || `${head}${when ? ` (${when})` : ''}.`).slice(0, 1200),
      keywords: extractKeywords(`${head} ${cur.extra.join(' ')} ${body}`),
      confirmed: false,
    });
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || isRule(line)) continue;
    const sec = resumeSectionOf(line);
    if (sec) {
      finish();
      section = sec;
      lastOrg = undefined;
      continue;
    }
    if (section === 'header') {
      if (CONTACT.test(line) || /[|·•]/.test(line)) continue;
      const words = line.split(/\s+/);
      if (
        !name &&
        words.length >= 2 &&
        words.length <= 4 &&
        !/\d/.test(line) &&
        words.every((w) => /^\p{Lu}[\p{L}'’.-]*$/u.test(w))
      ) {
        name = fixCaps(line);
        continue;
      }
      if (words.length >= 8) headerProse.push(line);
      continue;
    }
    if (section === 'other') continue;
    if (section === 'summary') {
      if (!CONTACT.test(line)) summaryLines.push(stripBullet(line));
      continue;
    }
    if (section === 'skills' || section === 'interests') {
      const content = stripBullet(line);
      const label = content.match(/^([A-Za-z &/]+):\s*/)?.[1]?.toLowerCase() ?? '';
      const items = content.replace(/^[A-Za-z &/]+:\s*/, '');
      if (section === 'interests' || /\b(interests|hobbies|activities)\b/.test(label)) {
        facets.push({
          id: `${resumeId}-f${id++}`,
          resumeId,
          kind: 'interest',
          text: items,
          keywords: extractKeywords(items, 6),
          confirmed: false,
        });
        continue;
      }
      const list = items
        .split(SKILL_SPLIT)
        .map((s) => s.replace(/\(.*?\)/g, '').trim())
        .filter((s) => s.length > 1 && s.length < 40 && !isRule(s));
      if (list.length)
        facets.push({
          id: `${resumeId}-f${id++}`,
          resumeId,
          kind: 'skill_group',
          text: list.join(', '),
          keywords: list.map((i) => i.toLowerCase()),
          confirmed: false,
        });
      continue;
    }
    // experience / education / projects
    if (BULLET.test(line)) {
      e ??= newEntry(section);
      e.body.push(stripBullet(line));
      continue;
    }
    // a whole entry on one line: "Michigan Finance Club — VP Education (2025-present). Led weekly training."
    const inline = section !== 'education' ? line.match(INLINE_ENTRY) : null;
    if (inline) {
      finish();
      e = newEntry(section);
      let parts = headerParts(`${inline[1]}   ${inline[2]}   ${inline[3]}`, e);
      // "(2025)": a bare year in brackets is the date, not part of the role
      const year = inline[3]!.trim();
      if (!e.range && !e.single && /^\d{4}$/.test(year)) {
        e.single = year;
        parts = parts.filter((p) => p !== year);
      }
      e.headers++;
      assignParts(parts, e);
      if (inline[4]?.trim()) e.body.push(inline[4].trim());
      continue;
    }
    const dated = section !== 'education' ? datedInline(line) : undefined;
    if (dated) {
      finish();
      e = newEntry(section);
      const parts = headerParts(dated.header, e);
      e.headers++;
      assignParts(parts, e);
      if (dated.desc) e.body.push(dated.desc);
      continue;
    }
    if (e?.body.length && /^[a-z(&]/.test(line)) {
      // a wrapped bullet continues in lowercase
      e.body[e.body.length - 1] = `${e.body[e.body.length - 1]} ${line}`;
      continue;
    }
    if (e && (e.title || e.org) && /[.!?]$/.test(line) && line.split(/\s+/).length >= 6) {
      // prose without bullet glyphs (some PDF exports drop them)
      e.body.push(line);
      continue;
    }
    if (e && !e.body.length && isMetaLine(line)) {
      headerParts(line, e);
      continue;
    }
    if (
      e &&
      section === 'education' &&
      e.org &&
      !e.body.length &&
      /\b(gpa|coursework|honors|dean|minor|thesis)\b/i.test(line)
    ) {
      e.details.push(line);
      continue;
    }
    // a role and an employer already, and this line brings no dates: it starts the next entry ("Treasurer, Club
    // soccer" then "Black Business Students Association"), it does not rename the one above
    const complete =
      !!e &&
      !!e.title &&
      !!e.org &&
      (!!e.range ||
        !!e.single ||
        (section !== 'education' && !DATE_RANGE.test(line) && !DATE_SINGLE.test(line)));
    if (!e || e.body.length > 0 || e.details.length > 0 || complete) {
      finish();
      e = newEntry(section);
    }
    const cur: Entry = e;
    const parts = headerParts(line, cur);
    if (!cur.headers) cur.titleOnlyFirst = parts.length === 1 && TITLE_WORDS.test(parts[0]!);
    cur.headers++;
    assignParts(parts, cur);
  }
  finish();
  const summarySource = summaryLines.length ? summaryLines.join(' ') : headerProse.join(' ');
  const sentence = summarySource ? summarySentence(summarySource, name) : undefined;
  if (sentence)
    facets.unshift({
      id: `${resumeId}-f${id++}`,
      resumeId,
      kind: 'summary',
      text: sentence,
      keywords: extractKeywords(sentence.replace(/^.*? is /, ''), 8),
      confirmed: false,
    });
  return facets.filter((f) => f.text.length > 8);
}
