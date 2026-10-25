/**
 * "Who do you most want to meet?" (plan 24), read for what Discover and recommendations can match: the roles named
 * ("PMs", "founders"), how far into a career ("a year or two in", "senior"), alumni of the student's school, and the
 * topic or company words left over ("payments", "Stripe"). Matching is on what a person's own record says: their
 * title, company and headline.
 */
import { stripDiacritics } from '../text/normalize';
import { type TitleLevel, titleLevel, titleSimilarity } from './title';

export interface WantToMeet {
  /** the roles named, as people in them write their titles */
  titles: string[];
  /** the career levels that fit; empty when the answer does not say */
  levels: TitleLevel[];
  /** alumni of the student's school */
  alumni: boolean;
  /** topic and company words ("payments", "stripe"), lower case */
  words: string[];
}

const ROLES: [RegExp, string][] = [
  [/\b(co-?)?founders?\b/, 'Founder'],
  [/\brecruit(er|ers|ing)\b|\btalent (team|acquisition)\b/, 'Recruiter'],
  [/\b(pms|pm|apms?|product managers?|product people|product folks)\b/, 'Product Manager'],
  [/\b(software )?engineers?\b|\bswes?\b|\bdevelopers?\b/, 'Software Engineer'],
  [/\bdesigners?\b/, 'Product Designer'],
  [/\bdata scientists?\b/, 'Data Scientist'],
  [/\b(investment )?bankers?\b|\bib analysts?\b/, 'Investment Banking Analyst'],
  [/\bconsultants?\b/, 'Consultant'],
  [/\b(vcs?|venture capitalists?|investors?)\b/, 'Investor'],
  [/\btraders?\b/, 'Trader'],
  [/\bresearchers?\b|\bresearch scientists?\b/, 'Research Scientist'],
  [/\bmarketers?\b|\bmarketing (people|folks|managers?)\b/, 'Marketing Manager'],
  [/\banalysts?\b/, 'Analyst'],
  [/\bassociates?\b/, 'Associate'],
  [/\bpartners?\b/, 'Partner'],
];

/** A role's own words, to match a title that names it ("Founder & CEO" is a founder). */
const ROLE_RE = new Map(ROLES.map(([re, title]) => [title, re]));

const EARLY =
  /\b(junior|early[- ]career|entry[- ]level|new grads?|recent grads?|young alumni|first[- ]years? (analysts?|associates?|engineers?|out)|(a|one|1|two|2) (or (two|2|three|3) )?years? (in|out|into|ahead)|(a|one|1) years? or (two|2|three|3)( years?)? (in|out|into|ahead))\b/;
const SENIOR =
  /\b(senior|leaders?|leadership|executives?|execs?|vps?|directors?|heads? of|managing directors?)\b/;
const ALUMNI =
  /\balum(ni|nus|na|nae|s)?\b|\b(from|at|went to) my (school|college|university)\b|\bsame school\b/;

/** Words that carry no topic or company. */
const STOP = new Set(
  `about above after again alumni also anyone anything area areas around because been being best better between both
  career careers company companies could currently doing each early especially even ever every everyone field fields
  folks from have help hope into just know learn like love maybe meet meeting more most much people person really
  role roles same school some someone something space than that their them then there these they thing things this
  those through want wants were what when where which while who whom with work working works would year years your
  ahead team teams there here other others well folks firm firms industry industries kind kinds type types start
  started starting someday likely talk talking chat chats coffee least ideally anybody`
    .split(/\s+/)
    .filter(Boolean),
);

/** What an answer to "who do you most want to meet" asks for; empty when it names nothing Orbit can match. */
export function parseWantToMeet(text: string | undefined): WantToMeet {
  const out: WantToMeet = { titles: [], levels: [], alumni: false, words: [] };
  if (!text?.trim()) return out;
  let t = ` ${stripDiacritics(text).toLowerCase().replace(/[’']/g, "'")} `;
  if (ALUMNI.test(t)) out.alumni = true;
  if (EARLY.test(t)) out.levels.push('entry', 'mid');
  if (SENIOR.test(t)) out.levels.push('senior', 'lead', 'director', 'vp', 'exec');
  for (const [re, title] of ROLES)
    if (re.test(t)) {
      if (!out.titles.includes(title)) out.titles.push(title);
      t = t.replace(new RegExp(re.source, 'g'), ' ');
    }
  t = t.replace(new RegExp(EARLY.source, 'g'), ' ').replace(new RegExp(SENIOR.source, 'g'), ' ');
  t = t.replace(new RegExp(ALUMNI.source, 'g'), ' ');
  const words = t.split(/[^a-z0-9&+]+/).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
  out.words = [...new Set(words)].slice(0, 8);
  return out;
}

/** Whether the answer names anything a person can be matched on. */
export function wantsAnything(w: WantToMeet | undefined): w is WantToMeet {
  return !!w && (w.titles.length > 0 || w.levels.length > 0 || w.alumni || w.words.length > 0);
}

export interface WantFit {
  /** 0..1: how well this person is who the student said they want to meet */
  score: number;
  /** the role they hold matched a role the student named */
  roleHit: boolean;
}

/** How well someone fits who the student wants to meet, from their title, company, headline and school. */
export function wantFit(
  c: { title?: string; company?: string; headline?: string; alum?: boolean },
  w: WantToMeet | undefined,
): WantFit {
  if (!wantsAnything(w)) return { score: 0, roleHit: false };
  let role = 0;
  const own = ` ${stripDiacritics(c.title ?? '').toLowerCase()} `;
  for (const t of w.titles)
    role = Math.max(role, c.title && ROLE_RE.get(t)?.test(own) ? 1 : titleSimilarity(c.title, t));
  const roleHit = role >= 0.6;
  const text = ` ${stripDiacritics(`${c.title ?? ''} ${c.company ?? ''} ${c.headline ?? ''}`).toLowerCase()} `;
  const wordHit = w.words.some((word) => new RegExp(`[^a-z0-9]${word}`).test(text));
  const alumHit = w.alumni && !!c.alum;
  const level = titleLevel(c.title);
  const levelOk = !w.levels.length || (!!level && w.levels.includes(level));
  let score = Math.max(roleHit ? 0.6 + 0.25 * role : 0, alumHit ? 0.7 : 0, wordHit ? 0.65 : 0);
  // two things the student named, both true, fit better than one
  const hits = [roleHit, alumHit, wordHit].filter(Boolean).length;
  if (hits >= 2) score = Math.min(1, score + 0.15);
  if (w.levels.length) {
    if (!score) score = levelOk && level ? 0.45 : 0;
    else score = levelOk ? Math.min(1, score + 0.1) : score * 0.6;
  }
  return { score: Math.round(score * 1000) / 1000, roleHit };
}
