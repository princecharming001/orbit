const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'prof', 'professor', 'sir']);
const CREDENTIALS = new Set([
  'phd',
  'mba',
  'cfa',
  'cpa',
  'md',
  'jd',
  'pmp',
  'msc',
  'bsc',
  'ba',
  'bs',
  'ms',
  'mfa',
  'esq',
  'pe',
  'rn',
  'mph',
  'cfp',
  'frm',
  'caia',
  'dds',
  'dvm',
]);
/** Two-letter credentials that are also surnames when written in title case (Ma, Pe). */
const isCredentialToken = (t: string, k: string) =>
  CREDENTIALS.has(k) && !(k.length <= 2 && /^\p{Lu}\p{Ll}+$/u.test(t));
const LEGAL_SUFFIXES = new Set([
  'inc',
  'incorporated',
  'llc',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'plc',
  'gmbh',
  'llp',
  'lp',
  'sa',
  'ag',
  'pbc',
]);

export function stripDiacritics(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

export function normalizeEmail(raw: string): string {
  let e = raw.trim().toLowerCase();
  const m = e.match(/<([^>]+)>/);
  if (m?.[1]) e = m[1].trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 0) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') {
    local = local.split('+')[0]!.replace(/\./g, '');
  }
  return `${local}@${domain}`;
}

export function emailDomain(email: string): string {
  const e = normalizeEmail(email);
  return e.slice(e.lastIndexOf('@') + 1);
}

export function emailLocalPart(email: string): string {
  const e = normalizeEmail(email);
  return e.slice(0, e.lastIndexOf('@'));
}

export interface NameParts {
  first: string;
  last: string;
  full: string;
  /** lowercase "first last" without diacritics or apostrophes; the matching key */
  normalized: string;
}

const GENERATIONAL = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);
const PARTICLES = new Set([
  'de',
  'da',
  'del',
  'della',
  'der',
  'den',
  'di',
  'du',
  'la',
  'le',
  'van',
  'von',
  'ter',
  'bin',
  'binti',
  'al',
  'st',
]);

const tokenKey = (t: string) => stripDiacritics(t).toLowerCase().replace(/[.,]/g, '');

/** A comma part like "Jr.", "PhD", "MBA, CFA" or "she/her" carries no name. */
function isTagPart(part: string): boolean {
  const toks = part.split(/\s+/).filter(Boolean);
  return (
    toks.length > 0 &&
    toks.every((t) => {
      const k = tokenKey(t);
      return !k || GENERATIONAL.has(k) || isCredentialToken(t, k) || HONORIFICS.has(k);
    })
  );
}

function capitalizeToken(t: string, isFirst: boolean): string {
  const lower = t.toLowerCase();
  if (!isFirst && PARTICLES.has(lower)) return lower;
  return lower.replace(/(^|[-'’])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
}

/** Fix the case of names typed all-lowercase or all-uppercase; mixed case ("McKinsey", "DeShawn") is kept. */
function fixCase(tokens: string[], offset = 0): string[] {
  const letters = tokens.join('');
  const allUpper = letters === letters.toUpperCase() && letters !== letters.toLowerCase();
  return tokens.map((t, i) => {
    if (t === t.toLowerCase() && t !== t.toUpperCase()) return capitalizeToken(t, i + offset === 0);
    if (allUpper && t.length > 1) return capitalizeToken(t, i + offset === 0);
    return t;
  });
}

function cleanTokens(s: string): string[] {
  return s
    .split(/\s+/)
    .map((t) => t.replace(/^['‘’]+|['‘’]+$/g, '').replace(/[.,]+$/g, ''))
    .filter((t) => {
      const k = tokenKey(t);
      return (
        !!k && !HONORIFICS.has(k) && !isCredentialToken(t, k) && !GENERATIONAL.has(k) && /\p{L}/u.test(t)
      );
    });
}

function partsFromTokens(tokens: string[]): NameParts {
  const fixed = fixCase(tokens);
  const first = fixed[0] ?? '';
  let lastStart = fixed.length - 1;
  // keep particles with the surname: "Ana de la Cruz" -> last "de la Cruz"
  while (lastStart > 1 && PARTICLES.has(fixed[lastStart - 1]!.toLowerCase())) lastStart--;
  const last = fixed.length > 1 ? fixed.slice(lastStart).join(' ') : '';
  const full = fixed.join(' ');
  return { first, last, full, normalized: nameKey(first, last) };
}

/** The matching key for a name: lowercase, no diacritics, no apostrophes. */
export function nameKey(first: string, last: string): string {
  return stripDiacritics([first, last].filter(Boolean).join(' ')).toLowerCase().replace(/['‘’]/g, '');
}

function cleanRaw(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu, ' ')
    .replace(/["“”]/g, '')
    .replace(/\s[|•·/].*$/, '')
    .replace(/[|•·].*$/, '')
    .replace(/\s+[-–—]\s+.*$/, '') // "Priya Patel - Figma"
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a display name from any source (email header, CSV, calendar). Strips honorifics, credentials,
 * generational suffixes, pronouns, emoji and " - Company" / ", Company" tails; flips "Last, First";
 * keeps diacritics in the display parts (only `normalized` drops them).
 */
export function parseName(raw: string | undefined | null): NameParts {
  if (!raw) return { first: '', last: '', full: '', normalized: '' };
  const s = cleanRaw(raw);
  const parts = s
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && !isTagPart(p));
  let tokens: string[];
  if (parts.length >= 2) {
    const head = cleanTokens(parts[0]!);
    const tail = cleanTokens(parts[1]!);
    const headIsSurname =
      head.length === 1 ||
      (head.length > 1 && head.slice(0, -1).every((t) => PARTICLES.has(t.toLowerCase())));
    // "Patel, Priya" -> "Priya Patel"; "Priya Patel, Figma" -> "Priya Patel" (the tail is not a name part)
    tokens = headIsSurname && tail.length >= 1 && tail.length <= 2 ? [...tail, ...head] : head;
  } else tokens = cleanTokens(parts[0] ?? '');
  return partsFromTokens(tokens);
}

/** Build name parts from separate first/last fields (LinkedIn CSV), cleaning each field on its own. */
export function nameFromParts(firstRaw: string | undefined, lastRaw: string | undefined): NameParts {
  const f = (firstRaw ?? '').trim();
  const l = (lastRaw ?? '').trim();
  if (!l) return parseName(f);
  if (!f) return parseName(l);
  const clean = (x: string) => {
    const parts = cleanRaw(x)
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p && !isTagPart(p));
    return cleanTokens(parts[0] ?? '');
  };
  const ft = clean(f);
  const lt = clean(l);
  if (!lt.length) return partsFromTokens(ft);
  if (!ft.length) return partsFromTokens(lt);
  const fixedFirst = fixCase(ft);
  const fixedLast = fixCase(lt, ft.length);
  const first = fixedFirst[0]!;
  const last = fixedLast.join(' ');
  return { first, last, full: [...fixedFirst, ...fixedLast].join(' '), normalized: nameKey(first, last) };
}

/**
 * A readable placeholder name from an email address when no name was given: "tom.wu@x" -> "Tom Wu",
 * "erodriguez@x" -> "erodriguez" (kept as is; it is replaced as soon as a real name arrives).
 */
export function nameFromEmailLocal(email: string): string {
  const local = email.slice(0, Math.max(0, email.lastIndexOf('@'))) || email;
  const parts = local
    .replace(/\+.*$/, '')
    .split(/[._-]+/)
    .filter((t) => /^\p{L}{2,}$/u.test(t));
  if (parts.length >= 2 && parts.length <= 3) return fixCase(parts.map((p) => p.toLowerCase())).join(' ');
  return local;
}

/**
 * Nickname -> formal name, one direction only, for nicknames that almost always mean that one name.
 * Distinct given names (John/Jonathan, Liam/William, Stephen/Steven) are not merged here.
 */
const NICKNAMES: Record<string, string> = {
  bill: 'william',
  billy: 'william',
  will: 'william',
  willy: 'william',
  bob: 'robert',
  bobby: 'robert',
  rob: 'robert',
  robbie: 'robert',
  bert: 'robert',
  mike: 'michael',
  mikey: 'michael',
  mick: 'michael',
  jim: 'james',
  jimmy: 'james',
  dave: 'david',
  davey: 'david',
  dan: 'daniel',
  danny: 'daniel',
  matt: 'matthew',
  matty: 'matthew',
  topher: 'christopher',
  tom: 'thomas',
  tommy: 'thomas',
  joe: 'joseph',
  joey: 'joseph',
  jon: 'jonathan',
  johnny: 'john',
  nick: 'nicholas',
  nicky: 'nicholas',
  tony: 'anthony',
  ben: 'benjamin',
  benny: 'benjamin',
  andy: 'andrew',
  drew: 'andrew',
  ed: 'edward',
  eddie: 'edward',
  steve: 'steven',
  ken: 'kenneth',
  kenny: 'kenneth',
  josh: 'joshua',
  zach: 'zachary',
  zack: 'zachary',
  jeff: 'jeffrey',
  charlie: 'charles',
  chuck: 'charles',
  greg: 'gregory',
  jake: 'jacob',
  rick: 'richard',
  ricky: 'richard',
  rich: 'richard',
  tim: 'timothy',
  timmy: 'timothy',
  ron: 'ronald',
  don: 'donald',
  larry: 'lawrence',
  liz: 'elizabeth',
  lizzie: 'elizabeth',
  beth: 'elizabeth',
  betty: 'elizabeth',
  kate: 'katherine',
  katie: 'katherine',
  kathy: 'katherine',
  jen: 'jennifer',
  jenny: 'jennifer',
  jess: 'jessica',
  jessie: 'jessica',
  maggie: 'margaret',
  meg: 'margaret',
  peggy: 'margaret',
  sue: 'susan',
  susie: 'susan',
  abby: 'abigail',
  becky: 'rebecca',
  becca: 'rebecca',
  vicky: 'victoria',
  tori: 'victoria',
  mandy: 'amanda',
  patty: 'patricia',
};

/**
 * Short forms that are shared by several formal names (Alex: Alexander or Alexandra) or are often given
 * names in their own right. They count as a weaker name match and never auto-merge on their own.
 */
const AMBIGUOUS_NICKNAMES: Record<string, string[]> = {
  alex: ['alexander', 'alexandra', 'alexis'],
  sam: ['samuel', 'samantha'],
  chris: ['christopher', 'christine', 'christina'],
  pat: ['patrick', 'patricia'],
  jamie: ['james'],
  nat: ['natalie', 'nathan', 'nathaniel'],
  nate: ['nathan', 'nathaniel'],
  ted: ['edward', 'theodore'],
  sasha: ['alexander', 'alexandra'],
  liam: ['william'],
  john: ['jonathan'],
  gail: ['abigail'],
  eliza: ['elizabeth'],
  max: ['maxwell', 'maximilian'],
  kat: ['katherine', 'kathryn'],
  lexi: ['alexandra', 'alexis'],
  frankie: ['frank', 'francis', 'francesca'],
};

export function canonicalFirstName(first: string): string {
  const f = stripDiacritics(first).toLowerCase();
  return NICKNAMES[f] ?? f;
}

/**
 * How two given names relate: 'same' (identical after diacritics), 'nickname' (a safe one-way nickname),
 * 'ambiguous' (a shared short form such as Alex/Alexandra), or 'different'.
 */
export function firstNameRelation(a: string, b: string): 'same' | 'nickname' | 'ambiguous' | 'different' {
  const x = stripDiacritics(a).toLowerCase();
  const y = stripDiacritics(b).toLowerCase();
  if (!x || !y) return 'different';
  if (x === y) return 'same';
  if (canonicalFirstName(x) === canonicalFirstName(y)) return 'nickname';
  const amb = (s: string, t: string) =>
    (AMBIGUOUS_NICKNAMES[s] ?? []).some((n) => n === t || n === canonicalFirstName(t));
  if (amb(x, y) || amb(y, x)) return 'ambiguous';
  return 'different';
}

export function normalizeLinkedInUrl(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim();
  if (!s) return undefined;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return undefined;
    const m = u.pathname.match(/\/in\/([^/?#]+)/i);
    if (!m?.[1]) return undefined;
    const slug = decodeURIComponent(m[1]).toLowerCase().replace(/\/+$/, '');
    return `https://www.linkedin.com/in/${slug}`;
  } catch {
    return undefined;
  }
}

export function linkedInSlug(url: string | undefined | null): string | undefined {
  const n = normalizeLinkedInUrl(url);
  return n ? n.slice(n.lastIndexOf('/') + 1) : undefined;
}

/** Trailing words that do not distinguish one employer from another ("McKinsey & Company", "Blackstone Group"). */
const GENERIC_ORG_TAIL = new Set([
  '&',
  'and',
  'company',
  'co',
  'group',
  'consulting',
  'partners',
  'holdings',
]);
/** Well-known short forms and spellings, keyed by the normalized form, mapped to one canonical key. */
const ORG_ALIASES: Record<string, string> = {
  bcg: 'boston consulting group',
  'boston consulting group': 'boston consulting group',
  jpmorgan: 'jpmorgan chase',
  'jp morgan': 'jpmorgan chase',
  'j p morgan': 'jpmorgan chase',
  'jpmorgan chase': 'jpmorgan chase',
  'jp morgan chase': 'jpmorgan chase',
  'j p morgan chase': 'jpmorgan chase',
  jpmc: 'jpmorgan chase',
  chase: 'jpmorgan chase',
  pwc: 'pwc',
  pricewaterhousecoopers: 'pwc',
  'price waterhouse coopers': 'pwc',
  'pricewaterhouse coopers': 'pwc',
  ey: 'ey',
  'ernst & young': 'ey',
  'ernst and young': 'ey',
  aws: 'amazon web services',
  'amazon web services': 'amazon web services',
  gs: 'goldman sachs',
  goldman: 'goldman sachs',
  'goldman sachs': 'goldman sachs',
  facebook: 'meta',
  'meta platforms': 'meta',
  meta: 'meta',
  bofa: 'bank of america',
  'bank of america merrill lynch': 'bank of america',
  'bank of america': 'bank of america',
  citi: 'citi',
  citigroup: 'citi',
  citibank: 'citi',
  'morgan stanley': 'morgan stanley',
};

export function normalizeCompany(raw: string | undefined | null): string {
  if (!raw) return '';
  let s = stripDiacritics(raw)
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ');
  s = s
    .replace(/\band\b/g, '&')
    .replace(/[^a-z0-9&\s]/g, ' ')
    .replace(/\s*&\s*/g, ' & ');
  const tokens = s.split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  if (tokens[0] === 'the' && tokens.length > 1) tokens.shift();
  const legal = tokens.join(' ');
  if (ORG_ALIASES[legal]) return ORG_ALIASES[legal]!;
  while (
    tokens.length > 1 &&
    (GENERIC_ORG_TAIL.has(tokens[tokens.length - 1]!) || LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!))
  )
    tokens.pop();
  const core = tokens.join(' ');
  return ORG_ALIASES[core] ?? (core.replace(/[\s&]/g, '') ? core : legal);
}

export function initials(name: string): string {
  const p = parseName(name);
  const a = p.first[0] ?? '';
  const b = p.last[0] ?? '';
  return (a + b).toUpperCase() || '?';
}

export function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function hueFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}
