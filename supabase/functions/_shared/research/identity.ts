/**
 * Is this web page about the right person? Research builds an identity card from the LinkedIn profile (the anchor) and
 * scores every page against it, instead of passing a page that merely contains a word ("Meta" inside "metadata").
 *
 * A page is **strong** when it names the person (full name, or a nickname with the last name) and carries at least one
 * more signal: an employer they have worked at (current or one of the two before, as a whole word, through the alias
 * table so Meta counts as Facebook), a school they went to, a link to their LinkedIn profile, or their work email
 * domain. Their city, and a site whose address is their name, count only beside one of those: the live check found
 * five namesakes' sites for "David Kim" (davidkim.tech, davidc.kim…), none of them his. A page that names a different employer
 * for them in its title ("Dana Liu - Engineer at Acme" when Dana never worked at Acme) is marked as conflicting.
 * LinkedIn's own pages and the people-search sites that copy LinkedIn are never strong: the profile itself comes from
 * the student's connected account, and a copy adds nothing but risk.
 *
 * Only strong pages are read and cited. Kept free of imports beyond guards.ts so the browser and the tests share it.
 */
import { isBlockedSource, isLinkedInCopy, norm, normOrg, workDomains } from './guards';

export interface IdentityProfile {
  headline?: string | null;
  location?: string | null;
  publicIdentifier?: string | null;
  experience?: {
    title?: string | null;
    company?: string | null;
    current?: boolean | null;
    start?: unknown;
  }[];
  education?: { school?: string | null }[];
}

export interface IdentityInput {
  name: string;
  firstName?: string;
  lastName?: string;
  org?: string;
  title?: string;
  school?: string;
  location?: string;
  linkedinUrl?: string;
  emails?: string[];
  profile?: IdentityProfile | null;
}

/** Who the person is, as research matches pages against. */
export interface IdentityCard {
  fullName: string;
  /** whole-word name forms that count as naming them: "dana liu", "danielle liu", "dana m. liu" */
  names: string[];
  last: string;
  /** current employer first, then up to two before it; each with its aliases */
  employers: { name: string; aliases: string[]; current: boolean }[];
  schools: { name: string; aliases: string[] }[];
  city?: string;
  slug?: string;
  domains: string[];
  /** true when there is something besides the name to tell them apart: a LinkedIn profile or an employer */
  anchored: boolean;
}

/**
 * Companies known by more than one name. Each row is one company; any name in it matches any other. Kept to the
 * employers students write to most, plus the renames that trip simple matching.
 */
export const COMPANY_ALIASES: string[][] = [
  ['Meta', 'Meta Platforms', 'Facebook'],
  ['Google', 'Alphabet', 'Google LLC', 'Google DeepMind', 'DeepMind'],
  ['X Corp', 'Twitter'],
  ['Amazon', 'Amazon Web Services', 'AWS', 'Amazon.com'],
  ['Microsoft', 'MSFT', 'Microsoft Research', 'LinkedIn Corporation'],
  ['Block', 'Square', 'Block, Inc.', 'Cash App'],
  ['JPMorgan Chase', 'JPMorgan', 'J.P. Morgan', 'JP Morgan', 'JPMorgan Chase & Co.', 'Chase'],
  ['Goldman Sachs', 'Goldman'],
  ['Morgan Stanley'],
  ['Bank of America', 'BofA', 'Bank of America Merrill Lynch', 'BofA Securities', 'Merrill Lynch', 'Merrill'],
  ['Citi', 'Citigroup', 'Citibank'],
  ['McKinsey & Company', 'McKinsey'],
  ['Boston Consulting Group', 'BCG'],
  ['Bain & Company', 'Bain'],
  ['Deloitte', 'Deloitte Consulting'],
  ['PwC', 'PricewaterhouseCoopers'],
  ['EY', 'Ernst & Young'],
  ['KPMG'],
  ['Accenture'],
  ['IBM', 'International Business Machines'],
  ['Apple', 'Apple Inc.'],
  ['Netflix'],
  ['Salesforce', 'Slack'],
  ['ByteDance', 'TikTok'],
  ['Snap', 'Snap Inc.', 'Snapchat'],
  ['Instagram'],
  ['WhatsApp'],
  ['OpenAI'],
  ['Anthropic'],
  ['Stripe'],
  ['Airbnb'],
  ['Uber', 'Uber Technologies'],
  ['Lyft'],
  ['Nvidia', 'NVIDIA'],
  ['Intel'],
  ['Oracle'],
  ['Adobe'],
  ['Palantir', 'Palantir Technologies'],
  ['Databricks'],
  ['Figma'],
  ['Notion', 'Notion Labs'],
  ['Ramp'],
  ['Brex'],
  ['Robinhood'],
  ['Coinbase'],
  ['Shopify'],
  ['Spotify'],
  ['Pinterest'],
  ['Reddit'],
  ['Dropbox'],
  ['Atlassian'],
  ['Blackstone'],
  ['KKR', 'Kohlberg Kravis Roberts'],
  ['Evercore'],
  ['Lazard'],
  ['Jane Street'],
  ['Citadel', 'Citadel Securities'],
  ['Two Sigma'],
  ['D. E. Shaw', 'D.E. Shaw', 'DE Shaw'],
  ['Andreessen Horowitz', 'a16z'],
  ['Sequoia Capital', 'Sequoia'],
  ['Y Combinator', 'YC'],
  ['Tesla'],
  ['SpaceX'],
  ['Boeing'],
  ['Lockheed Martin'],
  ['Johnson & Johnson', 'J&J'],
  ['Procter & Gamble', 'P&G'],
];

/**
 * Employer names that are also everyday words (or so short a word-match proves little): matched only as written,
 * capitalized, so "a block of time" is not Block and "meta description" is not Meta.
 */
const COMMON_WORD_ORGS = new Set(
  [
    'meta',
    'block',
    'square',
    'apple',
    'amazon',
    'ramp',
    'notion',
    'target',
    'visa',
    'oracle',
    'box',
    'chase',
    'merrill',
    'bain',
    'snap',
    'slack',
    'shell',
    'intel',
    'citadel',
    'sequoia',
    'goldman',
    'plaid',
    'scale',
    'mercury',
    'figure',
    'gap',
    'ford',
    'discord',
    'zoom',
    'uber',
    'lyft',
    'ey',
    'yc',
    'x',
  ].map((s) => s.toLowerCase()),
);

const SCHOOL_ALIASES: string[][] = [
  ['Massachusetts Institute of Technology', 'MIT'],
  ['University of California, Berkeley', 'UC Berkeley', 'Berkeley', 'Cal'],
  ['University of California, Los Angeles', 'UCLA'],
  ['University of California, San Diego', 'UC San Diego', 'UCSD'],
  ['University of Southern California', 'USC'],
  ['Carnegie Mellon University', 'Carnegie Mellon', 'CMU'],
  ['Georgia Institute of Technology', 'Georgia Tech'],
  ['University of Pennsylvania', 'Penn', 'UPenn', 'Wharton'],
  ['New York University', 'NYU'],
  ['University of Michigan', 'Michigan', 'UMich'],
  ['University of Texas at Austin', 'UT Austin'],
  ['University of Illinois Urbana-Champaign', 'UIUC', 'University of Illinois'],
  ['Stanford University', 'Stanford'],
  ['Harvard University', 'Harvard', 'Harvard Business School', 'HBS'],
  ['Yale University', 'Yale'],
  ['Princeton University', 'Princeton'],
  ['Columbia University', 'Columbia'],
  ['Cornell University', 'Cornell'],
  ['Brown University', 'Brown'],
  ['Duke University', 'Duke'],
  ['University of Chicago', 'UChicago'],
  ['Northwestern University', 'Northwestern'],
  ['University of Waterloo', 'Waterloo'],
  ['University of Toronto', 'U of T', 'UofT'],
];

/** School short forms that are also names or places: matched only as written. */
const COMMON_WORD_SCHOOLS = new Set([
  'berkeley',
  'cal',
  'penn',
  'brown',
  'duke',
  'columbia',
  'michigan',
  'mit',
]);

/** Short forms of given names, both ways: "Dan" names Daniel and "Daniel" names Dan. */
const NICKNAMES: string[][] = [
  ['alexander', 'alex', 'xander'],
  ['alexandra', 'alex', 'alexa', 'sasha'],
  ['andrew', 'andy', 'drew'],
  ['anthony', 'tony'],
  ['benjamin', 'ben'],
  ['catherine', 'katherine', 'kathryn', 'kate', 'katie', 'cathy', 'kathy'],
  ['christopher', 'chris'],
  ['christine', 'christina', 'chris', 'tina'],
  ['daniel', 'dan', 'danny'],
  ['danielle', 'dani'],
  ['david', 'dave'],
  ['elizabeth', 'liz', 'beth', 'lizzie', 'eliza'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['jennifer', 'jen', 'jenny'],
  ['jessica', 'jess'],
  ['jonathan', 'jon'],
  ['john', 'jack', 'johnny'],
  ['joseph', 'joe', 'joey'],
  ['joshua', 'josh'],
  ['katherine', 'kate', 'katie', 'kat'],
  ['margaret', 'maggie', 'meg', 'peggy'],
  ['matthew', 'matt'],
  ['michael', 'mike', 'mikey'],
  ['nicholas', 'nick'],
  ['patricia', 'pat', 'trish'],
  ['patrick', 'pat'],
  ['rebecca', 'becky', 'becca'],
  ['richard', 'rick', 'rich', 'dick'],
  ['robert', 'rob', 'bob', 'bobby', 'robbie'],
  ['samuel', 'sam'],
  ['samantha', 'sam'],
  ['stephen', 'steven', 'steve'],
  ['susan', 'sue', 'suzy'],
  ['thomas', 'tom', 'tommy'],
  ['timothy', 'tim'],
  ['victoria', 'vicky', 'tori'],
  ['william', 'will', 'bill', 'billy', 'liam'],
  ['zachary', 'zach', 'zack'],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word (or whole-phrase) search in normalized text. */
function hasPhrase(text: string, phrase: string): boolean {
  const p = norm(phrase);
  if (!p) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(p)}($|[^\\p{L}\\p{N}])`, 'u').test(text);
}

/** Whole-word search as written (case kept), for names that are also everyday words. */
function hasExact(raw: string, phrase: string): boolean {
  const p = phrase.trim();
  if (!p) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(p)}($|[^\\p{L}\\p{N}])`, 'u').test(raw);
}

/** Every name a company goes by, from the alias table (the name itself first). */
export function companyAliases(name: string): string[] {
  const k = normOrg(name);
  if (!k) return [];
  const row = COMPANY_ALIASES.find((r) => r.some((a) => normOrg(a) === k));
  const out = [name.trim(), ...(row ?? [])];
  return [...new Map(out.map((a) => [normOrg(a), a.trim()])).values()].filter((a) => normOrg(a).length >= 2);
}

function schoolAliases(name: string): string[] {
  const k = norm(name);
  const row = SCHOOL_ALIASES.find((r) => r.some((a) => norm(a) === k));
  const out = [name.trim(), ...(row ?? [])];
  return [...new Map(out.map((a) => [norm(a), a.trim()])).values()].filter((a) => norm(a).length >= 2);
}

/**
 * Words that, right after a company's name, make it the company's product rather than an employer: a namesake who
 * "built a budgeting app on the Plaid API" never worked at Plaid (the live check found exactly that).
 */
const PRODUCT_AFTER =
  /^[\s-]*(api|apis|sdk|sdks|plugin|plugins|integration|integrations|cloud|docs|checkout|connect|elements|ads|analytics|maps|sheets|drive|workspace|app store|play store|pay|wallet|webhooks?|dashboard|link|graph api|marketplace|certified|certification|partner program)\b/i;

/** Words just before a company's name that make it a tool someone used: "integrated Plaid, Yodlee and Finicity". */
const PRODUCT_BEFORE =
  /\b(integrat\w*|using|uses|used|built (?:on|with)|powered by|via|connect(?:s|ed|ing)? (?:to|with)|migrat\w* (?:to|from)|deployed (?:on|to)|hosted on)\s+(?:the\s+)?$/i;

/** Every whole-word place the phrase appears, case kept or not. */
function placesOf(raw: string, phrase: string, exact: boolean): number[] {
  const p = exact ? phrase.trim() : phrase.trim().toLowerCase();
  const hay = exact ? raw : raw.toLowerCase();
  const out: number[] = [];
  if (!p) return out;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(p)}(?=$|[^\\p{L}\\p{N}])`, 'gu');
  for (let m = re.exec(hay); m; m = re.exec(hay)) out.push(m.index + m[1]!.length);
  return out;
}

/**
 * True when the employer name (or one of its aliases) appears in the page as a whole word, as the company and not
 * its product (see PRODUCT_AFTER).
 */
export function mentionsOrg(raw: string, aliases: string[]): boolean {
  const flat = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return aliases.some((a) => {
    const n = normOrg(a);
    if (n.length < 2) return false;
    // an everyday word, or two letters, counts only as written: "Meta", never "meta" or "metadata"
    const exact = COMMON_WORD_ORGS.has(n) || n.length <= 3;
    const name = exact ? a.replace(ORG_TAIL, '').trim() : n;
    const hay = exact ? flat : norm(flat);
    const len = (exact ? name : name.toLowerCase()).length;
    return placesOf(hay, name, exact).some((start) => {
      const after = hay.slice(start + len, start + len + 30);
      const before = hay.slice(Math.max(0, start - 40), start);
      return !PRODUCT_AFTER.test(after) && !PRODUCT_BEFORE.test(before);
    });
  });
}

const ORG_TAIL = /[,.]?\s+(inc|inc\.|llc|ltd|ltd\.|corp|corporation|co|gmbh|plc|sa|ag)\.?$/i;

function mentionsSchool(raw: string, aliases: string[]): boolean {
  const t = norm(raw);
  return aliases.some((a) => {
    const n = norm(a);
    if (COMMON_WORD_SCHOOLS.has(n) || n.length <= 4) return hasExact(raw, a);
    return hasPhrase(t, n);
  });
}

function givenNames(first: string): string[] {
  const f = norm(first);
  const out = new Set([f]);
  for (const row of NICKNAMES) if (row.includes(f)) for (const x of row) out.add(x);
  return [...out];
}

/** The city of a LinkedIn location: "San Francisco Bay Area" → "San Francisco", "London, England" → "London". */
export function cityOf(location: string | null | undefined): string | undefined {
  const first = (location ?? '').split(',')[0]?.trim() ?? '';
  const c = first
    .replace(/\b(greater|metropolitan|metro)\b/gi, '')
    .replace(/\b(bay area|area|region)\b/gi, '')
    .trim();
  return c.length >= 3 ? c : undefined;
}

/** "https://www.linkedin.com/in/dana-liu-12ab/" → "dana-liu-12ab". */
export function slugOf(url: string | null | undefined): string | undefined {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url ?? '');
  return m?.[1] ? decodeURIComponent(m[1]).toLowerCase() : undefined;
}

/** The identity card for one person, from what Orbit and their LinkedIn profile say. */
export function identityCard(p: IdentityInput): IdentityCard {
  const fullName = p.name.trim().replace(/\s+/g, ' ');
  const parts = fullName.split(' ').filter((x) => !/^(jr\.?|sr\.?|ii|iii|iv|phd|md|mba)$/i.test(x));
  const first = p.firstName?.trim() || parts[0] || '';
  const last = p.lastName?.trim() || (parts.length > 1 ? parts[parts.length - 1]! : '');
  const names = new Set<string>([norm(fullName)]);
  if (first && last) {
    for (const g of givenNames(first)) names.add(`${g} ${norm(last)}`);
    names.add(`${norm(first)} ${norm(last)}`);
  }
  const exp = (p.profile?.experience ?? []).filter((e) => e.company?.trim());
  const current = exp.find((e) => e.current) ?? exp[0];
  const ordered = [
    ...(current ? [current] : []),
    ...exp.filter((e) => e !== current && normOrg(e.company) !== normOrg(current?.company)),
  ];
  const employerNames: { name: string; current: boolean }[] = [];
  if (p.org?.trim()) employerNames.push({ name: p.org.trim(), current: true });
  for (const e of ordered) {
    const n = e.company!.trim();
    if (employerNames.some((x) => normOrg(x.name) === normOrg(n))) continue;
    employerNames.push({ name: n, current: e === current });
    if (employerNames.length >= 3) break;
  }
  const schoolNames = [
    ...(p.profile?.education ?? []).map((e) => e.school?.trim() ?? ''),
    p.school?.trim() ?? '',
  ].filter((s) => s && !/high school|secondary school/i.test(s));
  const slug = slugOf(p.linkedinUrl) ?? p.profile?.publicIdentifier?.toLowerCase() ?? undefined;
  const employers = employerNames.slice(0, 3).map((e) => ({ ...e, aliases: companyAliases(e.name) }));
  return {
    fullName,
    names: [...names].filter((n) => n.includes(' ')),
    last: norm(last),
    employers,
    schools: [...new Map(schoolNames.map((s) => [norm(s), s])).values()]
      .slice(0, 4)
      .map((s) => ({ name: s, aliases: schoolAliases(s) })),
    city: cityOf(p.profile?.location ?? p.location),
    slug,
    domains: workDomains(p.emails),
    anchored: !!slug || !!p.profile || employers.length > 0,
  };
}

export type Signal = 'name' | 'employer' | 'school' | 'slug' | 'domain' | 'personal_site' | 'city';

export interface PageScore {
  /** strong: name plus one more signal, no conflict, not LinkedIn or a copy of it */
  strength: 'strong' | 'weak' | 'none';
  signals: Signal[];
  /** the employer the page's title gives them, when it is none of theirs */
  conflict?: string;
  /** a LinkedIn page or a people-search copy of one */
  linkedinCopy: boolean;
  blocked: boolean;
}

export interface PageLike {
  url: string;
  title?: string | null;
  text?: string | null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** The employer a title like "Dana Liu - Senior Engineer at Acme | Speaker" gives the person. */
export function employerInTitle(title: string | null | undefined, card: IdentityCard): string | undefined {
  if (!title) return undefined;
  const t = title.replace(/\s*[|·]\s*(linkedin|crunchbase|twitter|x)\b.*$/i, '');
  if (!card.names.some((n) => hasPhrase(norm(t), n))) return undefined;
  const m = /\b(?:at|@)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/.exec(t);
  return m?.[1]?.trim();
}

/** Score one page against the card. */
export function scorePage(page: PageLike, card: IdentityCard): PageScore {
  const raw = [page.title ?? '', page.text ?? ''].join(' \n ');
  const text = norm(raw);
  const host = hostOf(page.url);
  const linkedinCopy = isLinkedInCopy(page.url);
  const blocked = isBlockedSource(page.url);
  const signals: Signal[] = [];
  if (card.names.some((n) => hasPhrase(text, n))) signals.push('name');
  if (card.employers.some((e) => mentionsOrg(raw, e.aliases))) signals.push('employer');
  if (card.schools.some((s) => mentionsSchool(raw, s.aliases))) signals.push('school');
  // a page that links their LinkedIn profile: never the address alone, since a plain slug ("dana-liu") is also in the
  // addresses of pages about namesakes
  if (card.slug && text.includes(`linkedin.com/in/${card.slug}`)) signals.push('slug');
  if (card.domains.some((d) => host === d || host.endsWith(`.${d}`) || text.includes(`@${d}`)))
    signals.push('domain');
  // their own site: the address is their name ("danaliu.com", "dana-liu.dev"), not a page on a big site
  const compactHost = host.replace(/[^a-z0-9]/g, '');
  if (
    card.last.length >= 3 &&
    card.names.some((n) => compactHost.startsWith(n.replace(/[^a-z0-9]/g, ''))) &&
    host.split('.').length <= 3
  )
    signals.push('personal_site');
  if (card.city && hasPhrase(text, card.city)) signals.push('city');
  const inTitle = employerInTitle(page.title, card);
  const conflict =
    inTitle &&
    !card.employers.some((e) => mentionsOrg(inTitle, e.aliases)) &&
    !card.schools.some((s) => mentionsSchool(inTitle, s.aliases))
      ? inTitle
      : undefined;
  const named = signals.includes('name');
  // the city and an address shaped like the name (davidkim.tech) only back up another signal: a common name has
  // many namesakes in every city and many sites named after them
  const others = signals.filter((s) => s !== 'name' && s !== 'city' && s !== 'personal_site');
  let strength: PageScore['strength'] = 'none';
  if (named) strength = 'weak';
  if (named && others.length >= 1 && !conflict && !linkedinCopy && !blocked) strength = 'strong';
  return { strength, signals, conflict, linkedinCopy, blocked };
}

/** Pages about a company (team news, hiring): they need its name as a whole word, never a person's. */
export function aboutCompany(page: PageLike, org: string): boolean {
  if (isBlockedSource(page.url) || isLinkedInCopy(page.url)) return false;
  return mentionsOrg([page.title ?? '', page.text ?? ''].join(' \n '), companyAliases(org));
}
