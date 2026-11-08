/**
 * An email for a person sourced outside the student's network, with how sure Orbit is of it, best first:
 *   page     written on a public page about them (the web pass reads it exactly as written)
 *   verified a 1st-degree connection's own contact email on LinkedIn, an address Hunter found and confirmed, Apollo's
 *            verified address (lookup.ts), or a built address the verifier confirmed
 *   pattern  built from the address pattern the company really uses, learned from two or more people at the same
 *            domain (88% right when tested against real inboxes)
 *   guess    a single example of the pattern, or a lookup's unconfirmed answer; shown as unconfirmed
 * A blind first.last address is never used: tested on 144 real company addresses it was right one time in five, and a
 * verifier cannot catch it at a server that takes any address (one wrong first.last came back "valid" in testing).
 * With no pattern from the student's inbox, the company's pattern comes from Hunter's domain search instead (it got
 * three of three right where first.last got none), and never for a university. Mail servers are checked over
 * DNS-over-HTTPS (an MX record) before a credit is spent; nothing here sends anything.
 */
import { norm, normOrg } from '../research/guards';
import type { Candidate } from './search';
import { orgsOf, siteDomain, workDomain } from './warmth';

export type EmailConfidence = 'verified' | 'page' | 'pattern' | 'guess';

/** What a lookup (lookup.ts) found for one person. */
export interface LookedUp {
  email: string;
  source: 'linkedin' | 'hunter' | 'apollo';
  status: 'verified' | 'guess';
}
export type EmailLookup = (c: Candidate) => Promise<LookedUp | undefined>;
/** verified lookups in one run at most (each may spend a credit); the best-fitting candidates get them */
export const MAX_LOOKUPS = 10;
/** Whether an address is deliverable, from a verifier (lookup.ts); undefined when it could not say. */
export type Verify = (email: string) => Promise<'valid' | 'invalid' | 'risky' | undefined>;
/** The address pattern a company uses, as Hunter writes it ("{first}", "{f}{last}"); undefined when unknown. */
export type DomainTemplate = (domain: string) => Promise<string | undefined>;

/** An address from a Hunter pattern and a name; undefined when the pattern has a part Orbit cannot fill. */
export function fromTemplate(template: string, f: string, l: string): string | undefined {
  const local = template
    .toLowerCase()
    .replace(/\{first\}/g, f)
    .replace(/\{last\}/g, l)
    .replace(/\{f\}/g, f[0] ?? '')
    .replace(/\{l\}/g, l[0] ?? '');
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(local) ? local : undefined;
}

/** built addresses checked in one run at most (each may spend half a credit) */
export const MAX_VERIFIES = 10;

type Make = (f: string, l: string) => string;

/** The patterns companies use, most common first. */
export const PATTERNS: Record<string, Make> = {
  'first.last': (f, l) => `${f}.${l}`,
  first: (f) => f,
  flast: (f, l) => `${f[0]}${l}`,
  firstlast: (f, l) => `${f}${l}`,
  first_last: (f, l) => `${f}_${l}`,
  'f.last': (f, l) => `${f[0]}.${l}`,
  firstl: (f, l) => `${f}${l[0]}`,
  last: (_f, l) => l,
  'last.first': (f, l) => `${l}.${f}`,
};

/** A name part as it appears in an address: lowercase ASCII letters only. */
const part = (s: string | undefined) =>
  norm(s)
    .replace(/[^a-z]/g, '')
    .slice(0, 40);

/** First and last name, without middle names, titles or suffixes; undefined when either is missing. */
export function nameParts(name: string, first?: string, last?: string): { f: string; l: string } | undefined {
  const words = norm(name)
    .replace(/\b(dr|prof|professor|mr|ms|mrs|phd|md|jr|sr|ii|iii|iv)\b\.?/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean);
  const f = part(first ?? words[0]);
  const l = part(last ?? words.at(-1));
  if (!f || !l || f === l || l.length < 2) return undefined;
  return { f, l };
}

/** Which pattern made this local part from this name, if any. */
export function patternOf(local: string, f: string, l: string): string | undefined {
  const lp = local.toLowerCase();
  return Object.entries(PATTERNS).find(([, make]) => make(f, l) === lp)?.[0];
}

export interface KnownAddress {
  name: string;
  email: string;
}

/** A shared inbox, not a person: founders@, info@, housing@ teach nothing about how people's addresses are made. */
const ROLE_LOCAL =
  /^(info|hello|hi|team|founders?|support|admin|contact|office|admissions|housing|careers|jobs|hr|sales|press|media|noreply|no-reply|help|events|marketing|billing|accounts?|ops|legal|security|partners?|investors?|community|reshall|mailroom)\b/;
const ROLE_NAME =
  /\b(team|founders|office|services|housing|support|admissions|corps|mailroom|invitational|department|committee|club|association|council|center|centre|newsletter|notifications?)\b/i;

export interface DomainPattern {
  pattern: string;
  /** at least two people's addresses agree and they are most of the people seen there */
  sure: boolean;
}

/**
 * How this domain makes addresses, from the people the student has emailed there. Sure when two or more agree and
 * they are 60% or more of the people seen there (three for a university, whose addresses rarely follow one rule);
 * a single example is used but is only a guess; a tie or a mixed domain gives nothing.
 */
export function domainPattern(known: KnownAddress[], domain: string): DomainPattern | undefined {
  const counts = new Map<string, number>();
  let people = 0;
  let ids = 0;
  for (const k of known) {
    const [local, d] = k.email.toLowerCase().split('@');
    if (!local || d !== domain || ROLE_LOCAL.test(local) || ROLE_NAME.test(k.name)) continue;
    const n = nameParts(k.name);
    if (!n) continue;
    people++;
    // an ID-number address ("anipol984") means some people there are assigned addresses, not given a pattern
    if (/\d{3,}/.test(local)) ids++;
    const p = patternOf(local, n.f, n.l);
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (!top) return undefined;
  if (second && second[1] === top[1]) return undefined;
  if (ids / people >= 0.25) return undefined;
  const share = top[1] / people;
  const need = isUniversity(domain) ? 3 : 2;
  if (top[1] >= need && share >= 0.6) return { pattern: top[0], sure: true };
  // one person's address at a small company: likely the pattern, said as a guess
  if (people === 1 && !isUniversity(domain)) return { pattern: top[0], sure: false };
  return undefined;
}

/** The domain's pattern when Orbit is sure of it, else undefined. */
export function learnPattern(known: KnownAddress[], domain: string): string | undefined {
  const p = domainPattern(known, domain);
  return p?.sure ? p.pattern : undefined;
}

export type MxCheck = (domain: string) => Promise<boolean>;

/** Whether a domain accepts mail (has an MX record), through Cloudflare's DNS-over-HTTPS; cached per run. */
export function dnsMx(doFetch: typeof fetch, timeoutMs = 4000): MxCheck {
  const cache = new Map<string, Promise<boolean>>();
  return (domain) => {
    let hit = cache.get(domain);
    if (!hit) {
      hit = (async () => {
        try {
          const res = await doFetch(
            `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
            { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(timeoutMs) },
          );
          if (!res.ok) return false;
          const b = (await res.json()) as { Status?: number; Answer?: { type?: number }[] };
          return b.Status === 0 && (b.Answer ?? []).some((a) => a.type === 15);
        } catch {
          return false;
        }
      })();
      cache.set(domain, hit);
    }
    return hit;
  };
}

/** The domains the candidate's org names are known by ("Stripe | Berkeley Haas" asks for both), in order. */
export function orgDomainsOf(c: Candidate, orgDomains: Map<string, string>): string[] {
  const out: string[] = [];
  for (const o of [...(c.org ? [c.org] : []), ...orgsOf(c)]) {
    const d = orgDomains.get(norm(o)) ?? orgDomains.get(normOrg(o));
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/** The company domains to try for a candidate: their own address, their org's domains, then their page. */
export function domainsOf(c: Candidate, orgDomains: Map<string, string>): string[] {
  const out: string[] = [];
  const add = (d: string | undefined) => {
    if (d && !out.includes(d)) out.push(d);
  };
  add(workDomain(c.email));
  for (const d of orgDomainsOf(c, orgDomains)) add(d);
  add(siteDomain(c.url));
  return out;
}

export const isUniversity = (d: string) => /\.(edu|ac\.[a-z]{2})$/.test(d);

/**
 * Fill in emails for person candidates who have none, and mark how each was found. Mutates the candidates.
 * `known` is every name and address the student has (their contacts) plus the addresses pages gave in this search.
 */
export async function fillEmails(
  cands: Candidate[],
  opts: {
    known: KnownAddress[];
    orgDomains: Map<string, string>;
    /** whether a domain takes mail; checked before a credit is spent on its pattern */
    mx?: MxCheck;
    verify?: Verify;
    /** the company's own pattern from Hunter, for a domain the student's inbox teaches nothing about */
    template?: DomainTemplate;
    max?: number;
    lookup?: EmailLookup;
    maxLookups?: number;
    maxVerifies?: number;
  },
): Promise<void> {
  // 1. looked-up addresses first, for the best-fitting people who have none (the list arrives best fit first)
  if (opts.lookup) {
    const want = cands
      .filter((c) => c.entity === 'person' && !c.email && !c.lastNameObfuscated)
      .slice(0, opts.maxLookups ?? MAX_LOOKUPS);
    const got = await Promise.all(want.map((c) => opts.lookup!(c).catch(() => undefined)));
    want.forEach((c, i) => {
      const g = got[i];
      if (!g) return;
      c.email = g.email;
      c.emailConfidence = g.status === 'verified' ? 'verified' : 'guess';
    });
  }
  // 2. the rest from the patterns the found addresses teach (a verified one teaches its domain too)
  const known = [
    ...opts.known,
    ...cands.filter((c) => c.email).map((c) => ({ name: c.name, email: c.email! })),
  ];
  const patterns = new Map<string, DomainPattern | undefined>();
  const patternAt = (d: string) => {
    if (!patterns.has(d)) patterns.set(d, domainPattern(known, d));
    return patterns.get(d);
  };
  let verifies = 0;
  const maxVerifies = opts.maxVerifies ?? MAX_VERIFIES;
  // the count is taken before the call, so the people asked first (best fit) get the verifications
  const check = (email: string) =>
    opts.verify && verifies++ < maxVerifies
      ? opts.verify(email).catch(() => undefined)
      : Promise.resolve(undefined);

  const todo: { c: Candidate; n: { f: string; l: string } }[] = [];
  for (const c of cands) {
    if (c.entity !== 'person') continue;
    if (c.email) {
      c.emailConfidence ??= 'page';
      continue;
    }
    const n = c.lastNameObfuscated ? undefined : nameParts(c.name, c.firstName, c.lastName);
    if (n && todo.length < (opts.max ?? 40)) todo.push({ c, n });
  }
  await Promise.all(
    todo.map(async ({ c, n }) => {
      for (const d of domainsOf(c, opts.orgDomains)) {
        const p = patternAt(d);
        if (p) {
          const email = `${PATTERNS[p.pattern]!(n.f, n.l)}@${d}`;
          const v = await check(email);
          if (v === 'invalid') continue;
          c.email = email;
          c.emailConfidence = v === 'valid' ? 'verified' : p.sure ? 'pattern' : 'guess';
          return;
        }
        // nothing learned from the inbox: the pattern Hunter has seen the company use, never at a university
        if (!opts.template || isUniversity(d)) continue;
        if (opts.mx && !(await opts.mx(d))) continue;
        const t = await opts.template(d).catch(() => undefined);
        const local = t ? fromTemplate(t, n.f, n.l) : undefined;
        if (!local) continue;
        const email = `${local}@${d}`;
        const v = await check(email);
        if (v === 'invalid') continue;
        c.email = email;
        c.emailConfidence = v === 'valid' ? 'verified' : 'pattern';
        return;
      }
    }),
  );
}

/**
 * The email step's share of a search: lookups, patterns and verifications run in parallel, and whatever they found by
 * then is kept (candidates are filled in place); the rest of the list goes out without an email rather than late.
 */
export const EMAIL_DEADLINE_MS = 12_000;

export function withDeadline(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([work.catch(() => undefined), stop]).finally(() => clearTimeout(timer));
}
