/**
 * Research guards that run in code, not only in the prompt (§5.4, §5.5, §14.6): identity matching for web results,
 * the "appears to be in high school" stop, and removal of anything touching a sensitive category.
 */

/** Lowercase, accents stripped, whitespace collapsed. */
export function norm(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const ORG_SUFFIX = /[,.]?\s+(inc|inc\.|llc|ltd|ltd\.|corp|corporation|co|gmbh|plc|sa|ag)\.?$/i;

/** An org name for matching: normalized, legal suffix removed. */
export function normOrg(s: string | null | undefined): string {
  return norm(s).replace(ORG_SUFFIX, '').trim();
}

const PUBLIC_MAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
]);

/** Work email domains from the person's addresses (public mail providers prove nothing about identity). */
export function workDomains(emails: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const e of emails ?? []) {
    const d = norm(e.split('@')[1]);
    if (d && !PUBLIC_MAIL.has(d)) out.add(d);
  }
  return [...out];
}

export interface IdentityAnchors {
  fullName: string;
  /** any one of these must also appear */
  anchors: string[];
}

/** §5.2 step 4: the page text contains the full name and (the org, the LinkedIn slug, or a known email domain). */
export function passesIdentity(text: string, a: IdentityAnchors): boolean {
  const t = norm(text);
  if (!a.fullName || !t.includes(norm(a.fullName))) return false;
  return a.anchors.some((x) => x.length >= 2 && t.includes(x));
}

/** The org a people-search page title names, e.g. "Jane Doe - Partner at Acme | LinkedIn" → "Acme". */
export function orgFromTitle(title: string | null | undefined, name: string): string | undefined {
  if (!title) return undefined;
  const cleaned = title.replace(/\s*[|·]\s*linkedin.*$/i, '').trim();
  const parts = cleaned
    .split(/\s+[-–—|·]\s+/)
    .map((p) => p.trim())
    .filter((p) => p && norm(p) !== norm(name));
  for (const p of parts) {
    const at = p.match(/\b(?:at|@)\s+(.+)$/i);
    if (at) return at[1]!.trim();
  }
  return parts.length >= 2 ? parts[parts.length - 1] : parts[0];
}

const HS_PHRASE =
  /\b(high[- ]school|secondary school)\s+(student|junior|senior|sophomore|freshman)\b|\b(student|junior|senior|sophomore|freshman)\s+(at|in)\s+[\w .'-]{0,40}\bhigh[- ]school\b|\b(9th|10th|11th|12th)[- ]grader?\b/i;

/** §5.5 minors: the person appears to be in high school (headline, title, current schooling or a profile page). */
export function appearsMinor(input: {
  title?: string;
  headline?: string | null;
  education?: { school?: string | null; end?: unknown }[] | null;
  profileTexts?: string[];
  year: number;
}): boolean {
  if (HS_PHRASE.test(input.title ?? '') || HS_PHRASE.test(input.headline ?? '')) return true;
  for (const e of input.education ?? []) {
    if (!/\bhigh[- ]school\b|\bsecondary school\b/i.test(e.school ?? '')) continue;
    const end = yearOf(e.end);
    if (end === undefined || end >= input.year) return true;
  }
  return (input.profileTexts ?? []).some((t) => HS_PHRASE.test(t));
}

function yearOf(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return v > 3000 ? new Date(v).getUTCFullYear() : v;
  if (typeof v === 'string') {
    const m = v.match(/(19|20)\d\d/);
    return m ? Number(m[0]) : undefined;
  }
  if (typeof v === 'object') {
    const y = (v as { year?: unknown }).year;
    return typeof y === 'number' ? y : undefined;
  }
  return undefined;
}

/**
 * Sensitive categories the brief must never include (§5.4): age, ethnicity, religion, health, family, sexuality,
 * politics. Deliberately narrow phrases, so a person who works at a health or civic organization is not erased.
 */
export const SENSITIVE: { category: string; re: RegExp }[] = [
  {
    category: 'age',
    re: /\b\d{1,3}[- ]years?[- ]old\b|\baged \d{1,3}\b|\bborn in (19|20)\d\d\b|\bage \d{1,3}\b/i,
  },
  {
    category: 'ethnicity',
    re: /\b(ethnicity|ethnic background|racial|race is|caucasian|african[- ]american|asian[- ]american|hispanic|latino|latina|latinx)\b/i,
  },
  {
    category: 'religion',
    re: /\b(christian|muslim|jewish|hindu|buddhist|sikh|atheist|catholic|protestant|mormon|religious|religion|his faith|her faith|their faith|attends church)\b/i,
  },
  {
    category: 'health',
    re: /\b(diagnos(ed|is)|illness|cancer survivor|chronic (illness|condition)|disabilit(y|ies)|pregnan(t|cy)|surgery|mental illness|in recovery)\b/i,
  },
  {
    category: 'family',
    re: /\b(married|divorced|widow(ed|er)?|spouse|wedding|(his|her|their|your) (wife|husband|kids|children|daughter|son|family)|(father|mother|parent) of (two|three|four|\d))\b/i,
  },
  { category: 'sexuality', re: /\b(gay|lesbian|bisexual|transgender|queer|lgbtq?\+?|sexual orientation)\b/i },
  {
    category: 'politics',
    re: /\b(democrat(ic)? (voter|supporter)|republican (voter|supporter)|political views?|voted for|votes for|campaigned for|donated to (the )?(campaign|party))\b/i,
  },
];

export function sensitiveCategory(text: string): string | undefined {
  return SENSITIVE.find((s) => s.re.test(text))?.category;
}

/** Drop the sentences of a paragraph that touch a sensitive category. */
export function stripSensitiveSentences(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !sensitiveCategory(s))
    .join(' ')
    .trim();
}
