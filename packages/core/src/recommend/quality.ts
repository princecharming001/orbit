/**
 * Who is worth suggesting at all, and how likely they are to answer: the rules Discover applies before it ranks.
 *
 *  - names as a person writes them: "CHAYA MENDELSOHN" reads "Chaya Mendelsohn"; "Chaya M." keeps its initial (and
 *    ranks a little lower); "J. S.", "LinkedIn Member" or a handle is not a name to suggest;
 *  - a role, never a self-description: "Experienced and versatile Product Manager" is a Product Manager, and
 *    "Passionate about building products" is no role at all;
 *  - junk: no real name, a money or all-caps headline, or neither a title nor a company;
 *  - reply odds: how likely this person is to answer a student, from what Orbit holds about them and the student;
 *  - the verdict: a card is shown only for a specific reason (its company is on the target list, an alum in the
 *    student's field, a warm path through someone named, a real tie, an employer on both resumes). A count of mutual
 *    connections, a LinkedIn connection, or a role true of thousands of people is never enough on its own.
 */
import { type TitleLevel, type TitleStatus, titleLevel } from './title';
import type { WhyReason } from './why';

// ---- names --------------------------------------------------------------------------------------------------------

export type NameQuality = 'full' | 'initial' | 'junk';

const INITIAL = /^\p{L}\.?$/u;
const CREDENTIAL = /^(mba|cfa|cpa|phd|ph\.d\.?|md|pmp|jd|msc|ms|ma|bs|ba|cfp|pe|rn|pmp®?)$/i;
const PICTO = /\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu;

/** One word of a name with its first letter up: "O'NEIL" is "O'Neil", "MARY-JANE" is "Mary-Jane". */
function titleWord(w: string): string {
  return w.toLowerCase().replace(/(^|[-'’])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
}

/**
 * A name as it should read on a card, and how much of a name it is. Capitals and all-lowercase are put in title case
 * (a name written with care, "McKenzie" or "de la Cruz", is left alone); emoji, pronouns in brackets and credentials
 * after a comma go.
 */
export function cleanName(raw: string | undefined): { name: string; first: string; quality: NameQuality } {
  let s = (raw ?? '').replace(PICTO, ' ').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  // "Jordan Lee, MBA, PMP": the letters after the comma are not part of the name
  const parts = s.split(',');
  if (
    parts.length > 1 &&
    parts.slice(1).every((p) =>
      p
        .trim()
        .split(/\s+/)
        .every((w) => CREDENTIAL.test(w)),
    )
  )
    s = parts[0]!;
  s = s.replace(/\s+/g, ' ').trim();
  const words = s.split(' ').filter(Boolean);
  const letters = s.replace(/[^\p{L}]/gu, '');
  const shouting =
    letters.length > 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
  const whispering =
    letters.length > 3 && letters === letters.toLowerCase() && letters !== letters.toUpperCase();
  const fixed = words.map((w) =>
    INITIAL.test(w)
      ? `${w[0]!.toUpperCase()}${w.length > 1 ? '.' : ''}`
      : /^(II|III|IV|Jr\.?|Sr\.?)$/i.test(w)
        ? w
        : shouting || whispering || (w.length > 2 && w === w.toUpperCase() && /\p{L}{3}/u.test(w))
          ? titleWord(w)
          : w,
  );
  const name = fixed.join(' ');
  const first = fixed.find((w) => !INITIAL.test(w)) ?? fixed[0] ?? '';
  const named = fixed.filter((w) => !INITIAL.test(w));
  let quality: NameQuality = 'full';
  if (
    fixed.length < 2 ||
    !named.length ||
    /[\d@_]/.test(s) ||
    /^linkedin member$/i.test(s) ||
    fixed.some((w) => !/\p{L}/u.test(w))
  )
    quality = 'junk';
  else if (fixed.some((w) => INITIAL.test(w))) quality = 'initial';
  return { name, first, quality };
}

// ---- roles --------------------------------------------------------------------------------------------------------

/** Words people open a description of themselves with: never the first word of a job title. */
const SELF = new Set([
  'experienced',
  'versatile',
  'passionate',
  'results-driven',
  'results-oriented',
  'seasoned',
  'dynamic',
  'driven',
  'motivated',
  'enthusiastic',
  'innovative',
  'accomplished',
  'curious',
  'detail-oriented',
  'highly',
  'proven',
  'visionary',
  'hands-on',
  'award-winning',
]);
/** Words that go on describing once a description has begun ("Dynamic and creative"), not before. */
const SELF_AFTER = new Set(['creative', 'strategic', 'and', '&']);
/** Words that open a sentence about what they do, not a role. */
const SENTENCE =
  /\b(about|helping|help|helps|building|build|love|loves|i|i'm|my|who|that|turning|making|empowering|obsessed|dedicated)\b/i;
/** A role noun: what is left after the self-description must name one. */
const ROLE_NOUN =
  /\b(manager|engineer|developer|designer|analyst|associate|consultant|scientist|researcher|banker|director|president|vp|lead|head|founder|officer|recruiter|partner|specialist|intern|architect|marketer|writer|editor|coordinator|representative|executive|advisor|investor|trader|accountant|nurse|teacher|professor|apm|pm|swe|sde|owner|strategist|fellow)\b/i;

/**
 * The role a title or a headline's first part names, or nothing when it describes the person instead: "Experienced
 * and versatile Product Manager" is "Product Manager"; "Passionate about building products people love" and
 * "Results-driven leader" are no role.
 */
export function cleanRole(text: string | undefined): string | undefined {
  const t = text?.replace(PICTO, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  const words = t.split(' ');
  const word = (j: number) => words[j]!.toLowerCase().replace(/[,;]$/, '');
  let i = 0;
  // "Creative Director" is a title; "Dynamic and creative Product Designer" is a description of one
  if (SELF.has(word(0))) while (i < words.length - 1 && (SELF.has(word(i)) || SELF_AFTER.has(word(i)))) i++;
  const stripped = i > 0;
  const rest = words
    .slice(i)
    .join(' ')
    .replace(/^[,;&\s]+/, '');
  if (!rest || SENTENCE.test(rest) || /[|•]/.test(rest) || rest.split(' ').length > 7) return undefined;
  if (stripped && !ROLE_NOUN.test(rest)) return undefined;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

// ---- junk ---------------------------------------------------------------------------------------------------------

const SPAM =
  /\b(crypto|forex|passive income|dm me|link in bio|make money|financial freedom|mlm|onlyfans|giveaway)\b|\$\s?\d+k/i;

/** Why this profile is not one to suggest (no real name, spam, nothing to go on), or undefined when it is fine. */
export function junkProfile(c: {
  name: string;
  title?: string;
  company?: string;
  headline?: string;
}): string | undefined {
  if (cleanName(c.name).quality === 'junk') return 'no real name';
  const h = c.headline ?? '';
  const letters = h.replace(/[^\p{L}]/gu, '');
  if (SPAM.test(h) || (h.match(PICTO) ?? []).length >= 2) return 'spam';
  if (letters.length >= 10 && letters === letters.toUpperCase()) return 'spam';
  if (!c.title?.trim() && !c.company?.trim()) return 'no title or company';
  return undefined;
}

// ---- reply odds ---------------------------------------------------------------------------------------------------

/** What Orbit knows that bears on whether someone answers a student. A field left out is not known. */
export interface ReplySignals {
  title?: string;
  status?: TitleStatus;
  /** recruiters answer students as part of the job */
  recruiter?: boolean;
  /** an alum of the student's school (education evidence) */
  alum?: boolean;
  /** an employer or club on both resumes, now or before */
  sharedOrg?: 'now' | 'past';
  /** someone the student knows can introduce them, or pointed the student to them */
  warmPath?: 'referred' | 'introducer' | 'colleague';
  /** how close the student is to them already, 0..1 */
  strength?: number;
  /** they answered the student before, or met them */
  replied?: boolean;
  /** LinkedIn degree for someone new: 2 a friend of a friend, 3 further out */
  distance?: number;
  mutualCount?: number;
  /** a LinkedIn connection of the student's */
  connected?: boolean;
  /** people in a role like theirs answered the student */
  likeReplied?: boolean;
}

/** How much more (or less) likely each level is to answer a student than someone mid-career, in log-odds. */
const LEVEL_LOGIT: Record<TitleLevel, number> = {
  student: 0.2,
  entry: 0.55,
  mid: 0.3,
  senior: 0,
  lead: -0.3,
  director: -0.75,
  vp: -1.05,
  exec: -1.45,
};

const logistic = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (p: number) => Math.log(p / (1 - p));
const clampP = (p: number) => Math.max(0.03, Math.min(0.95, p));

/**
 * Reply odds, 0..1: how likely this person is to answer a first message from the student. A cold note to a stranger
 * mid-career is answered about one time in five; an alum, a shared employer, someone in an early-career role, a
 * friend of a friend with many mutuals, people like the ones who already answered, and above all a warm path or a
 * real tie raise it; a director or a VP, or someone far out on LinkedIn, lowers it.
 */
export function replyOdds(s: ReplySignals): number {
  let z = -1.35;
  const level = s.status === 'student' || s.status === 'aspiring' ? 'student' : titleLevel(s.title);
  if (level) z += LEVEL_LOGIT[level];
  if (s.recruiter) z += 0.5;
  if (s.alum) z += 0.75;
  if (s.sharedOrg === 'now') z += 1.1;
  else if (s.sharedOrg === 'past') z += 0.7;
  if (s.warmPath === 'referred') z += 1.5;
  else if (s.warmPath === 'introducer') z += 1.0;
  else if (s.warmPath === 'colleague') z += 0.85;
  if (s.strength) z += 2.6 * Math.min(1, s.strength);
  if (s.replied) z += 1.1;
  if (s.distance === 2) z += 0.2 + Math.min(0.4, 0.03 * (s.mutualCount ?? 0));
  else if (s.distance === 3) z -= 0.35;
  if (s.connected) z += 0.35;
  if (s.likeReplied) z += 0.45;
  return Math.round(clampP(logistic(z)) * 1000) / 1000;
}

/** Odds raised by a signal learned later (a warm path found after ranking), in log-odds. */
export function liftOdds(p: number, by: number): number {
  return Math.round(clampP(logistic(logit(clampP(p)) + by)) * 1000) / 1000;
}

/**
 * The one number Discover ranks by: Match most, then Reply odds, then Reach; a name with only an initial a little
 * lower. Every list on the page is in this order.
 */
export function rankScore(m: { match: number; reach: number; odds: number; initialName?: boolean }): number {
  const s = Math.max(m.match, 0.02) ** 0.55 * Math.max(m.reach, 0.05) ** 0.2 * Math.max(m.odds, 0.03) ** 0.25;
  return Math.round(s * (m.initialName ? 0.85 : 1) * 1000) / 1000;
}

// ---- the verdict --------------------------------------------------------------------------------------------------

/**
 * Whether a card has a reason to be on Discover: a goal anchor (a target company, an alum in the field, an employer
 * on both resumes, the role in an industry on the list), or a tie anchor (a warm path through someone named, people
 * the student knows, a reply) with something tying them to the student's goals.
 */
export function worthSuggesting(why: WhyReason[], goalLink: boolean): boolean {
  if (why.some((w) => w.anchor === 'goal')) return true;
  return goalLink && why.some((w) => w.anchor === 'tie');
}

/**
 * The least Match and rank a card needs to be shown at all: below these the feed ends instead of padding. Match is
 * the real floor; the rank floor only drops the hopeless (a stranger far out who would not answer), since a weak path
 * orders a list but is no reason to hide someone at a company the student is aiming for.
 */
export const DISCOVER_MIN_MATCH = 0.25;
export const DISCOVER_MIN_SCORE = 0.15;

/** Director and up: busy people a student should reach through someone, not cold. */
export const directorOrAbove = (title: string | undefined) => {
  const l = titleLevel(title);
  return l === 'director' || l === 'vp' || l === 'exec';
};
