/**
 * LinkedIn companies by name, through Unipile, kept for every student in orbit_private.linkedin_companies with their
 * logos copied into the public bucket company-logos (LinkedIn's own links expire after a few weeks). Shared by
 * orbit-connectors /companies (a browser asking for the tiles on its screen) and orbit-worker logos.sweep (plan 35
 * B4: the weekly pass over companies 3 or more people work at across all students).
 *
 * A name is looked up at its own page first ("SpaceX" at /company/spacex, kept only when that page's name is exactly
 * the one asked for), then by LinkedIn's company search, kept only when exactly one result has the same name (or one
 * has by far the most followers). A name LinkedIn cannot pin down is kept as such, so nobody searches it again for a
 * month.
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

/** Where a company's LinkedIn page would be if it is at its own name ("SpaceX" -> spacex), for names of 3+ letters. */
export const pageAddress = (name: string): string | undefined => {
  const slug = companyNameKey(name).replace(/[^a-z0-9]+/g, '');
  return slug.length >= 3 ? slug : undefined;
};

export const answerOf = (r: CompanyRow): CompanyAnswer => ({
  status: r.status,
  companyId: r.companyId,
  publicIdentifier: r.publicIdentifier,
  name: r.name,
  logoUrl: r.logoUrl,
});

/**
 * A company found on LinkedIn by its name: LinkedIn's company search, kept only when exactly one result has the same
 * name (two "Nova"s are two companies, so neither is guessed), or when one has by far the most followers.
 */
export async function companyByName(
  u: UnipileAuth,
  accountId: string,
  name: string,
  doFetch: typeof fetch,
): Promise<{ id: string; item: Record<string, unknown> } | CompanyFailure> {
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
  const key = companyNameKey(name);
  const same = items.filter(
    (c) => companyNameKey(c.name) === key && (typeof c.id === 'string' || typeof c.id === 'number'),
  );
  if (same.length === 1) return { id: String(same[0]!.id), item: same[0]! };
  // several of the same name ("SpaceX" and its fan pages, a regional office): the real company when one has by far
  // the most followers (ten times the next, and thousands of them); otherwise a namesake's logo is never taken
  const followers = (c: Record<string, unknown>) =>
    [c.followers_count, c.followerCount, c.followers].find((n): n is number => typeof n === 'number') ?? 0;
  const ranked = [...same].sort((a, b) => followers(b) - followers(a));
  if (
    ranked.length > 1 &&
    followers(ranked[0]!) >= 5000 &&
    followers(ranked[0]!) >= 10 * followers(ranked[1]!)
  )
    return { id: String(ranked[0]!.id), item: ranked[0]! };
  return same.length
    ? { ok: false, reason: 'ambiguous', message: 'LinkedIn has more than one company of that name.' }
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
 * The company whose LinkedIn page is at the asked name itself ("SpaceX" at /company/spacex), when that page's name is
 * exactly the one asked for; nothing otherwise.
 */
export async function companyAtOwnName(
  u: UnipileAuth,
  accountId: string,
  name: string,
  doFetch: typeof fetch,
): Promise<FoundCompany | undefined> {
  const key = companyNameKey(name);
  const slug = pageAddress(name);
  if (!slug) return undefined;
  const page = await companyPage(u, accountId, slug, doFetch);
  if (!('company' in page) || !page.company?.id) return undefined;
  if (companyNameKey(page.company.name) !== key) return undefined;
  return {
    id: page.company.id,
    name: page.company.name,
    publicIdentifier: page.company.publicIdentifier,
    logo: page.company.logoUrl,
  };
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
  if (kept) await cache?.put(row).catch(() => undefined);
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
 * account's ledger (false: the day's reads are used, nothing more is asked).
 */
export async function lookupCompany(
  u: UnipileAuth,
  o: {
    accountId: string;
    key: string;
    name: string;
    cache: CompanyCache | undefined;
    doFetch: typeof fetch;
    now: Date;
    spend: () => Promise<boolean>;
  },
): Promise<LookupOutcome> {
  const { accountId, key, name, cache, doFetch, now, spend } = o;
  if (!(await spend())) return { looked: false, stopped: 'limit' };
  // a well-known company's page is usually at its own name (linkedin.com/company/spacex), while a search for it can
  // list only its namesakes: that page first, kept only when its name is exactly the one asked for
  if (pageAddress(name)) {
    const atName = await companyAtOwnName(u, accountId, name, doFetch).catch(() => undefined);
    if (atName) return { looked: true, answer: await keepCompany(cache, key, atName, doFetch, now) };
    if (!(await spend())) return { looked: true, stopped: 'limit' };
  }
  const found = await companyByName(u, accountId, name, doFetch);
  if (!('id' in found)) {
    if (found.reason === 'throttled') return { looked: true, stopped: 'throttled' };
    if (found.reason !== 'ambiguous' && found.reason !== 'not_found') return { looked: true };
    const row: CompanyRow = { key, status: found.reason, checkedAt: now.toISOString() };
    await cache?.put(row).catch(() => undefined);
    return { looked: true, answer: answerOf(row) };
  }
  // the search result names the company and carries its logo; its page is read only when it does not
  let c: FoundCompany = {
    id: found.id,
    name: text(found.item.name, 160),
    publicIdentifier: text(found.item.public_identifier, 160),
    logo: licdn(found.item.logo),
  };
  if (!c.logo && (await spend())) {
    const page = await companyPage(u, accountId, found.id, doFetch).catch(() => undefined);
    if (page && 'company' in page && page.company)
      c = {
        id: found.id,
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
