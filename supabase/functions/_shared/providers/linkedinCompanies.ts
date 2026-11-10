/**
 * LinkedIn companies by name, through Unipile, kept for every student in orbit_private.linkedin_companies with their
 * logos copied into the public bucket company-logos (LinkedIn's own links expire after a few weeks). Shared by
 * orbit-connectors /companies (a browser asking for the tiles on its screen) and orbit-worker logos.sweep (plan 35
 * B4: the weekly pass over companies 3 or more people work at across all students).
 *
 * A company is read at its page by LinkedIn's id when a position named it. A name is cleaned of what was typed after
 * the company ("Deel (YC 19)" is Deel) and searched, kept when exactly one result has the same name or one has by far
 * the most followers; when the search cannot choose, or finds none, the page at the company's own name settles it
 * ("SpaceX" at /company/spacex, kept only when that page has the name, or is one of the namesakes found). A name
 * LinkedIn cannot pin down is kept as such, so nobody searches it again for a month.
 */

/** One company as the shared list keeps it. */
export interface CompanyRow {
  key: string;
  status: 'found' | 'ambiguous' | 'not_found';
  companyId?: string;
  publicIdentifier?: string;
  name?: string;
  logoUrl?: string;
  checkedAt: string;
}

export interface CompanyCache {
  getMany(keys: string[]): Promise<Record<string, CompanyRow>>;
  put(row: CompanyRow): Promise<void>;
  /** keep a logo's bytes; answers the address it is served from */
  storeLogo(companyId: string, bytes: ArrayBuffer, contentType: string): Promise<string | undefined>;
}

/** What a student is told about one company: found (with its id and a logo that does not expire), or why not. */
export interface CompanyAnswer {
  status: CompanyRow['status'];
  companyId?: string;
  publicIdentifier?: string;
  name?: string;
  logoUrl?: string;
}

/** A company found on LinkedIn, before its logo is kept. */
export interface FoundCompany {
  id: string;
  name?: string;
  publicIdentifier?: string;
  /** LinkedIn's own logo link (it expires) */
  logo?: string;
}

/** Unipile's address and key. */
export interface UnipileAuth {
  base: string;
  key: string;
}

/** A company found by its name is looked up again after this long when LinkedIn could not pin it down. */
export const COMPANY_RETRY_MS = 30 * 86_400_000;
/** The biggest logo kept (LinkedIn's are a few kilobytes). */
export const LOGO_MAX_BYTES = 300_000;

export type CompanyFailure = { ok: false; reason: string; message: string };

const text = (v: unknown, max = 120) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

/** LinkedIn's image hosts: the only places a logo is fetched from. */
export function isLinkedInImage(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'licdn.com' || u.hostname.endsWith('.licdn.com'));
  } catch {
    return false;
  }
}

const licdn = (v: unknown) => {
  const u = text(v, 1000);
  return u && isLinkedInImage(u) ? u : undefined;
};

const headers = (u: UnipileAuth): Record<string, string> => ({
  'content-type': 'application/json',
  accept: 'application/json',
  'X-API-KEY': u.key,
});

async function unipileError(res: Response): Promise<string> {
  try {
    const b = (await res.json()) as { detail?: string; title?: string; message?: string };
    return String(b.detail ?? b.title ?? b.message ?? `LinkedIn refused it (${res.status}).`);
  } catch {
    return `LinkedIn refused it (${res.status}).`;
  }
}

const THROTTLED: CompanyFailure = {
  ok: false,
  reason: 'throttled',
  message: 'LinkedIn asked Orbit to slow down. It carries on later.',
};

/** A company name as LinkedIn and Orbit both write it: case, punctuation and legal suffixes set aside. */
export function companyNameKey(name: unknown): string {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(
      /\b(the|inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|sa|ag|bv|lp|llp)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The company a messy name means, for searching LinkedIn: what a student's contacts typed after the company goes ("Deel
 * (YC 19)", "Intuit - ex PayPal", "Weave YC W25", "Acme | Growth"), so the search asks for the company alone. The
 * shared list still keeps the answer under the name as written.
 */
export function searchName(name: string): string {
  let n = String(name ?? '')
    .replace(/\s*[([{][^)\]}]*[)\]}]?/g, ' ')
    .replace(/\b(?:yc|y combinator)\s*[-']?\s*[wsfx]?\s*'?\d{2,4}\b/gi, ' ')
    .replace(/\b(?:yc|y combinator)\b\s*$/i, ' ');
  n = n.split(/\s+[-–—|·•/]\s+|\s*[|·•]\s*|,\s+|\s+@\s+/)[0] ?? n;
  n = n.replace(/\s+/g, ' ').trim();
  return n.length >= 2 ? n.slice(0, 120) : String(name ?? '').trim();
}

/**
 * Whether a LinkedIn company's name is the name asked for: the same once case, punctuation and legal suffixes are set
 * aside, keeping letters of every script ("AWS" is not "AWS بالعربي", a fan page), or the short name LinkedIn writes in
 * brackets after the full one ("AWS" is "Amazon Web Services (AWS)").
 */
export function sameCompanyName(theirs: unknown, asked: string): boolean {
  const wide = (v: unknown) =>
    String(v ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(
        /(^| )(the|inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|sa|ag|bv|lp|llp)(?= |$)/g,
        ' ',
      )
      .replace(/\s+/g, ' ')
      .trim();
  const want = wide(asked);
  if (!want) return false;
  if (wide(theirs) === want) return true;
  const short = /\(([^)]{2,40})\)\s*$/.exec(String(theirs ?? ''))?.[1];
  return !!short && wide(short) === want;
}

/** Where a company's LinkedIn page would be if it is at its own name ("SpaceX" -> spacex), for names of 3+ letters. */
export const pageAddress = (name: string): string | undefined => {
  const slug = companyNameKey(name).replace(/[^a-z0-9]+/g, '');
  return slug.length >= 3 ? slug : undefined;
};

/** The addresses a company's own page may be at: "Capital One" at capitalone and at capital-one. */
export const pageAddresses = (name: string): string[] => {
  const key = companyNameKey(name);
  const joined = key.replace(/[^a-z0-9]+/g, '');
  if (joined.length < 3) return [];
  const hyphened = key.replace(/[^a-z0-9]+/g, '-');
  return hyphened === joined ? [joined] : [joined, hyphened];
};

/**
 * A non-found answer kept before this moment is asked again (plan 37 follow-up: names were then searched as written,
 * "Deel (YC 19)", and a common name with a namesake page, "Tesla", was never taken).
 */
export const LOOKUP_RULES_SINCE = Date.parse('2026-11-10T00:00:00Z');

/** Whether the shared list's row answers for now: found, or not pinned down within the month under today's rules. */
export function rowSettled(r: Pick<CompanyRow, 'status' | 'checkedAt'> | undefined, now: Date): boolean {
  if (!r) return false;
  if (r.status === 'found') return true;
  const at = Date.parse(r.checkedAt);
  return at >= LOOKUP_RULES_SINCE && now.getTime() - at < COMPANY_RETRY_MS;
}

export const answerOf = (r: CompanyRow): CompanyAnswer => ({
  status: r.status,
  companyId: r.companyId,
  publicIdentifier: r.publicIdentifier,
  name: r.name,
  logoUrl: r.logoUrl,
});

/** A search result's followers, under any of the names Unipile has used for them. */
const followersOf = (c: Record<string, unknown>) =>
  [c.followers_count, c.followerCount, c.followers].find((n): n is number => typeof n === 'number') ?? 0;

/**
 * A company found on LinkedIn by its name: LinkedIn's company search, kept when exactly one result has the same name,
 * or when one of several has by far the most followers (three times the next, and at least FOLLOWERS_CLEAR: "Tesla"
 * beside its fan pages). Otherwise `ambiguous`, with the same-name results' ids, so the company's own page can settle
 * it; a namesake's logo is never taken on a guess.
 */
export const FOLLOWERS_CLEAR = 500;
export async function companyByName(
  u: UnipileAuth,
  accountId: string,
  name: string,
  doFetch: typeof fetch,
): Promise<{ id: string; item: Record<string, unknown> } | (CompanyFailure & { sameIds?: string[] })> {
  const q = new URLSearchParams({ account_id: accountId, limit: '10' });
  const res = await doFetch(`${u.base}/api/v1/linkedin/search?${q}`, {
    method: 'POST',
    headers: headers(u),
    body: JSON.stringify({ api: 'classic', category: 'companies', keywords: name }),
  });
  if (res.status === 429) return THROTTLED;
  if (res.status >= 400 && res.status < 500)
    return { ok: false, reason: 'refused', message: await unipileError(res) };
  if (!res.ok) throw new Error(`unipile ${res.status}`);
  const items = ((await res.json()) as { items?: Record<string, unknown>[] }).items ?? [];
  const same = items.filter(
    (c) => sameCompanyName(c.name, name) && (typeof c.id === 'string' || typeof c.id === 'number'),
  );
  if (same.length === 1) return { id: String(same[0]!.id), item: same[0]! };
  const ranked = [...same].sort((a, b) => followersOf(b) - followersOf(a));
  if (
    ranked.length > 1 &&
    followersOf(ranked[0]!) >= FOLLOWERS_CLEAR &&
    followersOf(ranked[0]!) >= 3 * followersOf(ranked[1]!)
  )
    return { id: String(ranked[0]!.id), item: ranked[0]! };
  return same.length
    ? {
        ok: false,
        reason: 'ambiguous',
        message: 'LinkedIn has more than one company of that name.',
        sameIds: same.map((c) => String(c.id)),
      }
    : { ok: false, reason: 'not_found', message: 'LinkedIn could not find that company.' };
}

/** A company's LinkedIn page by LinkedIn's id or its public name: its name, public name, logo and website. */
export async function companyPage(
  u: UnipileAuth,
  accountId: string,
  identifier: string,
  doFetch: typeof fetch,
): Promise<
  | {
      ok: true;
      company: {
        id?: string;
        name?: string;
        publicIdentifier?: string;
        logoUrl?: string;
        website?: string;
        industry?: string;
      };
    }
  | CompanyFailure
> {
  const q = new URLSearchParams({ account_id: accountId });
  const res = await doFetch(`${u.base}/api/v1/linkedin/company/${encodeURIComponent(identifier)}?${q}`, {
    headers: headers(u),
  });
  if (res.status === 404 || res.status === 422)
    return { ok: false, reason: 'not_found', message: 'LinkedIn could not find that company.' };
  if (res.status === 429) return THROTTLED;
  if (res.status >= 400 && res.status < 500)
    return { ok: false, reason: 'refused', message: await unipileError(res) };
  if (!res.ok) throw new Error(`unipile ${res.status}`);
  const c = (await res.json()) as Record<string, unknown>;
  const industry = Array.isArray(c.industry) ? c.industry.find((x) => typeof x === 'string') : c.industry;
  return {
    ok: true,
    company: {
      id: text(c.id, 60),
      name: text(c.name, 160),
      publicIdentifier: text(c.public_identifier, 160),
      logoUrl: licdn(c.logo),
      website: text(c.website, 300),
      industry: text(industry, 120),
    },
  };
}

/**
 * The company whose LinkedIn page is at the asked name itself ("SpaceX" at /company/spacex, "Capital One" at
 * /company/capital-one), when that page's name is exactly the one asked for, or when it is one of `among` (the
 * same-name results a search could not choose between); nothing otherwise. Each address tried takes `spend` first.
 */
export async function companyAtOwnName(
  u: UnipileAuth,
  accountId: string,
  name: string,
  doFetch: typeof fetch,
  opts: { among?: string[]; spend?: () => Promise<boolean> } = {},
): Promise<FoundCompany | undefined> {
  for (const slug of pageAddresses(name)) {
    if (opts.spend && !(await opts.spend())) return undefined;
    const page = await companyPage(u, accountId, slug, doFetch).catch(() => undefined);
    if (!page || !('company' in page) || !page.company?.id) continue;
    const c = page.company;
    if (!sameCompanyName(c.name, name) && !opts.among?.includes(c.id!)) continue;
    return { id: c.id!, name: c.name, publicIdentifier: c.publicIdentifier, logo: c.logoUrl };
  }
  return undefined;
}

/** Copy a found company's logo into Orbit's storage and keep the company for everyone; the answer for the student. */
export async function keepCompany(
  cache: CompanyCache | undefined,
  key: string,
  c: FoundCompany,
  doFetch: typeof fetch,
  now: Date,
): Promise<CompanyAnswer> {
  let kept: string | undefined;
  if (c.logo && cache) {
    try {
      const res = await doFetch(c.logo);
      const type = res.headers.get('content-type') ?? 'image/jpeg';
      const bytes = await res.arrayBuffer();
      if (res.ok && type.startsWith('image/') && bytes.byteLength && bytes.byteLength <= LOGO_MAX_BYTES)
        kept = await cache.storeLogo(c.id, bytes, type);
    } catch {
      // the logo did not copy: the student gets LinkedIn's link for now, and the company is looked up again later
    }
  }
  const row: CompanyRow = {
    key,
    status: 'found',
    companyId: c.id,
    publicIdentifier: c.publicIdentifier,
    name: c.name,
    logoUrl: kept,
    checkedAt: now.toISOString(),
  };
  // kept with its logo, or kept without one when LinkedIn has none (so it is not looked up again); a logo that did not
  // copy leaves the company to be looked up again later
  if (kept || !c.logo) await cache?.put(row).catch(() => undefined);
  return { ...answerOf(row), logoUrl: kept ?? c.logo };
}

/** What one lookup did: the answer, whether it spent anything, and why it stopped when it could not go on. */
export interface LookupOutcome {
  answer?: CompanyAnswer;
  /** a LinkedIn read was taken for it */
  looked: boolean;
  stopped?: 'limit' | 'throttled';
}

/**
 * Look one company up on LinkedIn and keep what is found for everyone. `spend` takes one company read from the
 * account's ledger (false: the day's reads are used, nothing more is asked). With LinkedIn's id for it (a profile's
 * position names it) the company's page is read straight away, and nothing is guessed. By name, the search goes first
 * (with the name cleaned of what was typed after the company, `searchName`); when it cannot choose, or finds none, the
 * page at the company's own name settles it.
 */
export async function lookupCompany(
  u: UnipileAuth,
  o: {
    accountId: string;
    key: string;
    name: string;
    /** LinkedIn's id for the company, when a position named it */
    companyId?: string;
    cache: CompanyCache | undefined;
    doFetch: typeof fetch;
    now: Date;
    spend: () => Promise<boolean>;
  },
): Promise<LookupOutcome> {
  const { accountId, key, cache, doFetch, now, spend } = o;
  if (!(await spend())) return { looked: false, stopped: 'limit' };
  if (o.companyId && /^\d+$/.test(o.companyId)) {
    const page = await companyPage(u, accountId, o.companyId, doFetch).catch(() => undefined);
    if (page && 'company' in page && page.company) {
      const c = page.company;
      return {
        looked: true,
        answer: await keepCompany(
          cache,
          key,
          { id: c.id ?? o.companyId, name: c.name, publicIdentifier: c.publicIdentifier, logo: c.logoUrl },
          doFetch,
          now,
        ),
      };
    }
    if (page && !('company' in page) && page.reason === 'throttled')
      return { looked: true, stopped: 'throttled' };
    // the id did not answer: by name, from the next read
    if (!(await spend())) return { looked: true, stopped: 'limit' };
  }
  const name = searchName(o.name);
  const found = await companyByName(u, accountId, name, doFetch);
  let c: FoundCompany | undefined;
  if ('id' in found)
    c = {
      id: found.id,
      name: text(found.item.name, 160),
      publicIdentifier: text(found.item.public_identifier, 160),
      logo: licdn(found.item.logo),
    };
  else {
    if (found.reason === 'throttled') return { looked: true, stopped: 'throttled' };
    if (found.reason !== 'ambiguous' && found.reason !== 'not_found') return { looked: true };
    // the company's own page: it settles a search with namesakes, and finds one a search lists under another name
    c = await companyAtOwnName(u, accountId, name, doFetch, { among: found.sameIds, spend });
    if (!c) {
      const row: CompanyRow = { key, status: found.reason, checkedAt: now.toISOString() };
      await cache?.put(row).catch(() => undefined);
      return { looked: true, answer: answerOf(row) };
    }
  }
  // the search result names the company and carries its logo; its page is read only when it does not
  if (!c.logo && (await spend())) {
    const page = await companyPage(u, accountId, c.id, doFetch).catch(() => undefined);
    if (page && 'company' in page && page.company)
      c = {
        id: c.id,
        name: page.company.name ?? c.name,
        publicIdentifier: page.company.publicIdentifier ?? c.publicIdentifier,
        logo: page.company.logoUrl,
      };
  }
  return { looked: true, answer: await keepCompany(cache, key, c, doFetch, now) };
}

/** Logos into the public bucket company-logos over Supabase Storage (service role). */
export function storageLogoWriter(
  url: string,
  serviceKey: string,
  doFetch: typeof fetch = fetch,
): CompanyCache['storeLogo'] {
  return async (companyId, bytes, contentType) => {
    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
    const path = `${companyId.replace(/[^\w-]/g, '')}.${ext}`;
    const r = await doFetch(`${url}/storage/v1/object/company-logos/${path}`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'content-type': contentType,
        'x-upsert': 'true',
        'cache-control': '31536000',
      },
      body: bytes,
    });
    return r.ok ? `${url}/storage/v1/object/public/company-logos/${path}` : undefined;
  };
}
