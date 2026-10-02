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
]);
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
  normalized: string;
}

export function parseName(raw: string | undefined | null): NameParts {
  if (!raw) return { first: '', last: '', full: '', normalized: '' };
  let s = stripDiacritics(raw)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[\p{Extended_Pictographic}]/gu, ' ')
    .replace(/["'“”‘’]/g, '')
    .replace(/[|•·].*$/, '')
    .trim();
  // "Last, First" -> "First Last"
  if (/^[^,]+,\s*[^,]+$/.test(s)) {
    const [a, b] = s.split(',');
    s = `${b!.trim()} ${a!.trim()}`;
  }
  const tokens = s
    .split(/\s+/)
    .map((t) => t.replace(/[.,]/g, ''))
    .filter((t) => t && !HONORIFICS.has(t.toLowerCase()) && !CREDENTIALS.has(t.toLowerCase()));
  const first = tokens[0] ?? '';
  const last = tokens.length > 1 ? tokens[tokens.length - 1]! : '';
  const full = tokens.join(' ');
  const normalized = [first, last].filter(Boolean).join(' ').toLowerCase();
  return { first, last, full, normalized };
}

const NICKNAMES: Record<string, string> = {
  bill: 'william',
  will: 'william',
  billy: 'william',
  liam: 'william',
  bob: 'robert',
  rob: 'robert',
  bobby: 'robert',
  robbie: 'robert',
  mike: 'michael',
  mikey: 'michael',
  mick: 'michael',
  jim: 'james',
  jimmy: 'james',
  jamie: 'james',
  dave: 'david',
  davey: 'david',
  dan: 'daniel',
  danny: 'daniel',
  matt: 'matthew',
  matty: 'matthew',
  chris: 'christopher',
  topher: 'christopher',
  alex: 'alexander',
  sasha: 'alexander',
  tom: 'thomas',
  tommy: 'thomas',
  joe: 'joseph',
  joey: 'joseph',
  jon: 'jonathan',
  john: 'jonathan',
  johnny: 'jonathan',
  nick: 'nicholas',
  nicky: 'nicholas',
  tony: 'anthony',
  ben: 'benjamin',
  benny: 'benjamin',
  sam: 'samuel',
  sammy: 'samuel',
  andy: 'andrew',
  drew: 'andrew',
  ed: 'edward',
  eddie: 'edward',
  ted: 'edward',
  steve: 'steven',
  stephen: 'steven',
  liz: 'elizabeth',
  beth: 'elizabeth',
  lizzie: 'elizabeth',
  eliza: 'elizabeth',
  betty: 'elizabeth',
  kate: 'katherine',
  katie: 'katherine',
  kathy: 'katherine',
  catherine: 'katherine',
  kat: 'katherine',
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
  gail: 'abigail',
  nat: 'natalie',
  alexandra: 'alexandra',
  lexi: 'alexandra',
  becky: 'rebecca',
  becca: 'rebecca',
  vicky: 'victoria',
  tori: 'victoria',
  mandy: 'amanda',
  pat: 'patrick',
  patty: 'patricia',
  priya: 'priya',
};

export function canonicalFirstName(first: string): string {
  const f = first.toLowerCase();
  return NICKNAMES[f] ?? f;
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

export function normalizeCompany(raw: string | undefined | null): string {
  if (!raw) return '';
  let s = stripDiacritics(raw).toLowerCase();
  s = s.replace(/[^a-z0-9&\s]/g, ' ');
  const tokens = s.split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  if (tokens[0] === 'the' && tokens.length > 1) tokens.shift();
  return tokens.join(' ');
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
