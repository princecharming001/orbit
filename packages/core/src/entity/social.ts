/**
 * Is this Instagram or X account the same human as someone in People? (plan 43 §3.4)
 *
 * A wrong answer invents a path that does not exist, so the rules are strict, in the spirit of `resolveIdentity`:
 *
 * 1. Hard proof attaches on its own: the person's own links list the handle, the account links to the person's
 *    LinkedIn, the account shows an email or phone Orbit has for them, the student's address book lists the handle.
 * 2. Otherwise a score. An automatic match needs a score of at least AUTO_SOCIAL and one signal about this one person
 *    (the same personal link, the same picture, employer and role at a small employer, school and year, an exact
 *    contact). A name, a handle, an employer or a school alone only ever support.
 * 3. Two people who could fit one account: always ask, never pick. An account that reads as a public figure, a brand
 *    or nobody is never matched by score.
 * 4. Someone the student does not know is never offered as a question: the student cannot confirm a stranger.
 *
 * Pure: the browser demo and the server share it.
 */
import { linkedInSlug, normalizeCompany, normalizeEmail } from '../text/normalize';
import type { Person } from '../types';
import { compareNames } from './names';
import { isFirstNameVariant } from './nicknames';

export type SocialPlatform = 'instagram' | 'x';

/** One account on one platform, as Orbit has read it. The platform's id is the key; the handle is only a label. */
export interface SocialAccount {
  platform: SocialPlatform;
  id: string;
  username: string;
  name?: string;
  bio?: string;
  /** links on the profile and in the bio */
  links?: string[];
  /** contact details a business or creator profile shows */
  email?: string;
  phone?: string;
  followers?: number;
  following?: number;
  verified?: boolean;
  isPrivate?: boolean;
  /** a business or creator profile */
  business?: boolean;
  category?: string;
  /** a fingerprint of the profile picture file (never a face) */
  pictureHash?: string;
  /** the platform's default avatar, which says nothing */
  defaultPicture?: boolean;
}

export type AccountKind = 'person' | 'public_figure' | 'brand' | 'unknown';

/** Followers at which an unverified account reads as a public figure. */
export const PUBLIC_FIGURE_FOLLOWERS = 50_000;

const BRAND_WORDS =
  /\b(official|shop|store|studio|studios|agency|co\b|inc\b|llc|ltd|brand|boutique|restaurant|cafe|bakery|club|team|news|magazine|media|records|fitness|salon|clinic|church|foundation|university|college|school|memes?|daily|fan ?page|fanpage|updates)\b/i;

/** What an account is, before anything else: only a person can be a bridge, a target or a match (plan 43 §3.3). */
export function accountKind(a: SocialAccount): AccountKind {
  if (a.verified || (a.followers ?? 0) >= PUBLIC_FIGURE_FOLLOWERS) return 'public_figure';
  const name = (a.name ?? '').trim();
  if (a.business && (!name || BRAND_WORDS.test(name) || BRAND_WORDS.test(a.category ?? ''))) return 'brand';
  if (name && BRAND_WORDS.test(name)) return 'brand';
  const words = name
    .replace(/[^\p{L}\s'.-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
  if (words.length >= 2) return 'person';
  if (a.business) return 'brand';
  return 'unknown';
}

// ---- reading an account ------------------------------------------------------------------------------------------

const HUBS = [
  'linktr.ee',
  'linktree.com',
  'beacons.ai',
  'bio.link',
  'lnk.bio',
  'carrd.co',
  'campsite.bio',
  'hoo.be',
];

/** A link reduced to what identifies it: no scheme, no www, no trailing slash, lower case. */
export function normalizeLink(raw: string): string | undefined {
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?([^\s?#]+?)\/?(?:[?#].*)?$/);
  return m?.[1];
}

/** The handle a profile link names on a platform, or undefined ("instagram.com/maya.c" gives "maya.c"). */
export function handleFromLink(raw: string, platform: SocialPlatform): string | undefined {
  const l = normalizeLink(raw);
  if (!l) return undefined;
  const hosts =
    platform === 'instagram'
      ? ['instagram.com', 'instagr.am']
      : ['x.com', 'twitter.com', 'mobile.twitter.com'];
  for (const h of hosts) {
    if (!l.startsWith(`${h}/`)) continue;
    const seg = l.slice(h.length + 1).split('/')[0];
    if (!seg || ['p', 'reel', 'stories', 'explore', 'i', 'home', 'intent', 'share', 'search'].includes(seg))
      return undefined;
    return seg.replace(/^@/, '');
  }
  return undefined;
}

/** "@Maya.Chen" and "maya.chen" are one handle. */
export const normalizeHandle = (h: string) => h.trim().replace(/^@/, '').toLowerCase();

/** Handles written in a text ("ig: @maya.c", "x.com/maya"), for contact cards and bios. */
export function handlesIn(text: string, platform: SocialPlatform): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(
    /\b(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|instagr\.am|x\.com|twitter\.com)\/[\w.@-]+/gi,
  )) {
    const h = handleFromLink(m[0], platform);
    if (h) out.add(normalizeHandle(h));
  }
  const label =
    platform === 'instagram'
      ? /\b(?:ig|insta|instagram)\s*[:-]?\s*@([\w.]{2,30})/gi
      : /\b(?:x|twitter)\s*[:-]?\s*@(\w{2,15})/gi;
  for (const m of text.matchAll(label)) out.add(normalizeHandle(m[1]!));
  return [...out];
}

const tokensOf = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Words that name what an organisation is rather than which one ("University", "Inc."), dropped before matching. */
const GENERIC_ORG_WORDS = new Set([
  'the',
  'of',
  'at',
  'and',
  'university',
  'college',
  'inc',
  'llc',
  'ltd',
  'co',
  'corp',
  'corporation',
  'company',
  'group',
  'hq',
]);

/** Whether a bio names an organisation ("SWE @stripe", "studying CS at Stanford"). */
export function bioMentions(bio: string | undefined, org: string | undefined): boolean {
  if (!bio || !org) return false;
  const norm = normalizeCompany(org);
  const words = tokensOf(norm).filter((w) => w.length >= 2 && !GENERIC_ORG_WORDS.has(w));
  if (!words.length || (words.length === 1 && words[0]!.length < 3)) return false;
  const bioTokens = tokensOf(bio);
  const joined = ` ${bioTokens.join(' ')} `;
  if (joined.includes(` ${words.join(' ')} `)) return true;
  // "@stripe" and "stripehq" style handles of the employer
  const squashed = words.join('');
  return bioTokens.some((t) => t === squashed || t === `${squashed}hq`);
}

/** A two-digit or four-digit class year next to a school in a bio ("Stanford '25", "Penn 2026"), if any. */
export function bioYear(bio: string | undefined): number | undefined {
  if (!bio) return undefined;
  const m = bio.match(/(?:'|’|\bclass of\s*|\b)(20\d{2}|\d{2})\b/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (m[1]!.length === 2) return n >= 10 && n <= 40 ? 2000 + n : undefined;
  return n >= 2000 && n <= 2040 ? n : undefined;
}

/**
 * How well a handle spells a name, 0 to 1: "maya.chen", "mayachen", "mchen", "maya_c". A handle is chosen by its
 * owner, so this never counts for much, and a handle with digits ("jason.chen22") counts for nothing: anyone can add
 * a number to a name, as `resolveIdentity` treats numbered email addresses.
 */
export function handleSpellsName(handle: string, first: string, last: string): number {
  const h = normalizeHandle(handle);
  if (/\d/.test(h)) return 0;
  const f = tokensOf(first).join('');
  const l = tokensOf(last).join('');
  if (!f || !l) return 0;
  const bare = h.replace(/[._-]/g, '');
  if (bare === `${f}${l}` || bare === `${l}${f}`) return 1;
  if (bare === `${f[0]}${l}` || bare === `${f}${l[0]}`) return 0.7;
  if (bare.includes(f) && bare.includes(l)) return 0.8;
  if (bare === f || bare === l) return 0.3;
  return 0;
}

/** Surnames shared by so many people that a name with one says little on its own. */
const COMMON_SURNAMES = new Set(
  (
    'smith johnson williams brown jones garcia miller davis rodriguez martinez hernandez lopez gonzalez wilson anderson ' +
    'thomas taylor moore jackson martin lee perez thompson white harris sanchez clark ramirez lewis robinson walker young ' +
    'allen king wright scott torres nguyen hill flores green adams nelson baker hall rivera campbell mitchell carter ' +
    'roberts gomez phillips evans turner diaz parker cruz edwards collins reyes stewart morris morales murphy cook rogers ' +
    'gutierrez ortiz morgan cooper peterson bailey reed kelly howard ramos kim cox ward richardson watson brooks chavez ' +
    'wood james bennett gray mendoza ruiz hughes price alvarez castillo sanders patel myers long ross foster jimenez chen ' +
    'wang li zhang liu singh kumar shah khan park choi wu huang lin yang zhao zhou xu sun ma zhu hu guo he gao luo tran le ' +
    'pham kaur gupta sharma ali ahmed hassan cohen ng wong chan cheung lam ho tan lim'
  ).split(/\s+/),
);

/** A name rare enough that sharing it says something: an uncommon surname. */
export const isRareName = (last: string) => {
  const l = tokensOf(last).join('');
  return l.length >= 3 && !COMMON_SURNAMES.has(l);
};

// ---- matching ----------------------------------------------------------------------------------------------------

/** Who the account might be, with what Orbit knows about them that a profile could echo. */
export interface SocialCandidate {
  person: Pick<
    Person,
    | 'id'
    | 'displayName'
    | 'firstName'
    | 'lastName'
    | 'emails'
    | 'primaryEmail'
    | 'phones'
    | 'linkedinUrl'
    | 'linkedinSlug'
    | 'currentTitle'
    | 'currentOrganizationRaw'
    | 'school'
    | 'location'
  >;
  /** the person's own links: LinkedIn websites, pages Orbit's research confirmed are theirs */
  links?: string[];
  /** handles the student's address book lists on the person's card */
  contactHandles?: string[];
  /** the class year, when known */
  schoolYear?: number;
  /** the employer's head count, when known (employer and role only identify someone at a small employer) */
  employerSize?: number;
  /** a fingerprint of the person's photo (never a face) */
  pictureHash?: string;
  /** people already matched who are tied to both this person and the account */
  sharedNeighbours?: number;
  /** the person has a two-way tie with the student (messages both ways, a meeting, a connection, a follow back) */
  knownToStudent: boolean;
  /** other accounts already attached to the person on the same platform */
  otherHandles?: string[];
}

export type SocialProof = 'own_links' | 'links_back' | 'contact' | 'address_book';

export type SocialSignal =
  | 'name'
  | 'handle'
  | 'employer'
  | 'employer_role_small'
  | 'school'
  | 'school_year'
  | 'same_link'
  | 'same_picture'
  | 'place'
  | 'rare_name'
  | 'neighbours'
  | 'public_figure'
  | 'other_handle';

/** The signals about this one person (plan 43 §3.4): an automatic match needs one. */
export const PERSON_SPECIFIC: ReadonlySet<SocialSignal> = new Set([
  'employer_role_small',
  'school_year',
  'same_link',
  'same_picture',
]);

/**
 * Starting weights of the match score (plan 43 §3.4), set by hand and checked against the labelled set in
 * __tests__/social-match.test.ts. Supporting signals are kept low enough that no mix of them alone reaches
 * AUTO_SOCIAL; the person-specific ones carry it.
 */
export const SOCIAL_WEIGHTS: Record<SocialSignal, number> & { bias: number } = {
  bias: -3.5,
  name: 4,
  handle: 0.8,
  employer: 1,
  employer_role_small: 3,
  school: 0.8,
  school_year: 2.5,
  same_link: 4,
  same_picture: 3.5,
  place: 0.4,
  rare_name: 0.8,
  neighbours: 0.6,
  public_figure: -5,
  other_handle: -1.5,
};

export const AUTO_SOCIAL = 0.95;
export const ASK_SOCIAL = 0.6;
/** A name this far apart rules the pair out before anything else is weighed. */
const MIN_NAME = 0.5;

export type SocialMatch =
  | { kind: 'attach'; personId: string; via: 'proof'; proof: SocialProof }
  | {
      kind: 'attach';
      personId: string;
      via: 'score';
      score: number;
      signals: Partial<Record<SocialSignal, number>>;
    }
  | { kind: 'ask'; personId: string; score: number; signals: Partial<Record<SocialSignal, number>> }
  | { kind: 'none'; reason: 'not_a_person' | 'no_candidate' | 'ambiguous' | 'stranger' | 'low' };

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** The hard proof, if any, that `a` belongs to the candidate (plan 43 §3.4, the table of proofs). */
export function socialProof(a: SocialAccount, c: SocialCandidate): SocialProof | undefined {
  const handle = normalizeHandle(a.username);
  for (const l of c.links ?? []) {
    const h = handleFromLink(l, a.platform);
    if (h && normalizeHandle(h) === handle) return 'own_links';
  }
  const slug = c.person.linkedinSlug ?? linkedInSlug(c.person.linkedinUrl);
  if (slug) {
    for (const l of [
      ...(a.links ?? []),
      ...(a.bio ? (a.bio.match(/\S*linkedin\.com\/in\/[\w%-]+/gi) ?? []) : []),
    ]) {
      if (linkedInSlug(l.startsWith('http') ? l : `https://${l}`) === slug) return 'links_back';
    }
  }
  if (a.email) {
    const e = normalizeEmail(a.email);
    if ([c.person.primaryEmail, ...(c.person.emails ?? [])].some((x) => x && normalizeEmail(x) === e))
      return 'contact';
  }
  if (a.phone && c.person.phones?.length) {
    const digits = (p: string) => p.replace(/\D/g, '').slice(-10);
    if (c.person.phones.some((p) => digits(p) === digits(a.phone!) && digits(p).length >= 10))
      return 'contact';
  }
  if ((c.contactHandles ?? []).some((h) => normalizeHandle(h) === handle)) return 'address_book';
  return undefined;
}

/** The weighed signals for one account and one candidate. */
export function socialSignals(a: SocialAccount, c: SocialCandidate): Partial<Record<SocialSignal, number>> {
  const p = c.person;
  const s: Partial<Record<SocialSignal, number>> = {};
  const name = compareNames(a.name ?? '', p.displayName || `${p.firstName} ${p.lastName}`);
  s.name = name.score;
  const handle = handleSpellsName(a.username, p.firstName, p.lastName);
  if (handle) s.handle = handle;
  const employer = bioMentions(a.bio, p.currentOrganizationRaw);
  if (employer) {
    const titleWords = tokensOf(p.currentTitle ?? '').filter((w) => w.length >= 3);
    const bio = tokensOf(a.bio ?? '');
    const role = titleWords.some((w) => bio.includes(w));
    const small = typeof c.employerSize === 'number' && c.employerSize < 1000;
    if (role && small) s.employer_role_small = 1;
    else s.employer = 1;
  }
  if (bioMentions(a.bio, p.school)) {
    const y = bioYear(a.bio);
    if (y && c.schoolYear && y === c.schoolYear) s.school_year = 1;
    else s.school = 1;
  }
  const theirs = new Set(
    (c.links ?? []).map(normalizeLink).filter((l): l is string => !!l && !HUBS.some((h) => l.startsWith(h))),
  );
  if (
    (a.links ?? []).some((l) => {
      const n = normalizeLink(l);
      return !!n && theirs.has(n);
    })
  )
    s.same_link = 1;
  if (a.pictureHash && !a.defaultPicture && c.pictureHash && a.pictureHash === c.pictureHash)
    s.same_picture = 1;
  const city = (p.location ?? '').split(',')[0]?.trim();
  if (city && city.length >= 3 && a.bio && tokensOf(a.bio).join(' ').includes(tokensOf(city).join(' ')))
    s.place = 1;
  if (isRareName(p.lastName) && name.score >= 0.95) s.rare_name = 1;
  if ((c.sharedNeighbours ?? 0) > 0) s.neighbours = Math.min(2, c.sharedNeighbours!);
  if (accountKind(a) === 'public_figure') s.public_figure = 1;
  const handleNorm = normalizeHandle(a.username);
  if ((c.otherHandles ?? []).some((h) => normalizeHandle(h) !== handleNorm)) s.other_handle = 1;
  return s;
}

export function socialScore(signals: Partial<Record<SocialSignal, number>>): number {
  let z = SOCIAL_WEIGHTS.bias;
  for (const [k, v] of Object.entries(signals) as [SocialSignal, number][]) z += SOCIAL_WEIGHTS[k] * v;
  return sigmoid(z);
}

/**
 * Decide one account against the people it could be. `candidates` should already be the people whose names could
 * fit (a blocking step, as `resolveIdentity` does); `rejected` holds the person ids the student said it is not.
 */
export function matchSocialAccount(
  a: SocialAccount,
  candidates: SocialCandidate[],
  opts: { rejected?: ReadonlySet<string> } = {},
): SocialMatch {
  const pool = candidates.filter((c) => !opts.rejected?.has(c.person.id));
  // hard proof first: it attaches whatever the account looks like, unless two people claim it
  const proven = pool
    .map((c) => ({ c, proof: socialProof(a, c) }))
    .filter((x): x is { c: SocialCandidate; proof: SocialProof } => !!x.proof);
  if (proven.length === 1)
    return { kind: 'attach', personId: proven[0]!.c.person.id, via: 'proof', proof: proven[0]!.proof };
  if (proven.length > 1) return { kind: 'none', reason: 'ambiguous' };
  if (accountKind(a) !== 'person') return { kind: 'none', reason: 'not_a_person' };
  const scored = pool
    .map((c) => {
      const signals = socialSignals(a, c);
      return { c, signals, score: (signals.name ?? 0) < MIN_NAME ? 0 : socialScore(signals) };
    })
    .filter((x) => x.score >= ASK_SOCIAL)
    .sort((x, y) => y.score - x.score);
  if (!scored.length) return { kind: 'none', reason: pool.length ? 'low' : 'no_candidate' };
  if (scored.length > 1) {
    // two people could fit: ask about the best only if the student knows them, never pick on our own
    const best = scored[0]!;
    if (!best.c.knownToStudent) return { kind: 'none', reason: 'ambiguous' };
    return {
      kind: 'ask',
      personId: best.c.person.id,
      score: Math.min(best.score, AUTO_SOCIAL - 0.01),
      signals: best.signals,
    };
  }
  const best = scored[0]!;
  const specific = Object.keys(best.signals).some((k) => PERSON_SPECIFIC.has(k as SocialSignal));
  if (best.score >= AUTO_SOCIAL && specific)
    return {
      kind: 'attach',
      personId: best.c.person.id,
      via: 'score',
      score: best.score,
      signals: best.signals,
    };
  if (!best.c.knownToStudent) return { kind: 'none', reason: 'stranger' };
  return {
    kind: 'ask',
    personId: best.c.person.id,
    score: Math.min(best.score, AUTO_SOCIAL - 0.01),
    signals: best.signals,
  };
}

/**
 * For a target the student is going after: hard proof only (plan 43 §3.4), until matching by score has been measured
 * on real accounts. A student cannot confirm someone they do not know, so there is no question to ask.
 */
export function matchTargetAccount(a: SocialAccount, target: SocialCandidate): SocialMatch {
  const proof = socialProof(a, target);
  if (proof) return { kind: 'attach', personId: target.person.id, via: 'proof', proof };
  return { kind: 'none', reason: 'stranger' };
}

/** People whose names could fit an account: a cheap first pass before scoring. */
export function socialBlock<T extends SocialCandidate>(a: SocialAccount, people: readonly T[]): T[] {
  const name = (a.name ?? '').trim();
  const handle = normalizeHandle(a.username);
  return people.filter((c) => {
    const p = c.person;
    if (name && compareNames(name, p.displayName || `${p.firstName} ${p.lastName}`).score >= MIN_NAME)
      return true;
    if (handleSpellsName(handle, p.firstName, p.lastName) >= 0.7) return true;
    if (!name) {
      // an account with no display name can still be found by proof
      return !!socialProof(a, c);
    }
    return (
      isFirstNameVariant(name.split(/\s+/)[0] ?? '', p.firstName) &&
      !!p.lastName &&
      handle.includes(tokensOf(p.lastName).join(''))
    );
  });
}
