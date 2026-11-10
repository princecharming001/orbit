/**
 * LinkedIn companies by name, through Unipile, kept for every student in orbit_private.linkedin_companies with their
 * logos copied into the public bucket company-logos (LinkedIn's own links expire after a few weeks). Shared by
 * orbit-connectors /companies (a browser asking for the tiles on its screen) and orbit-worker logos.user / logos.sweep.
 *
 * Accuracy before coverage (the student's rule: a logo is LinkedIn's own, for that exact company, or none):
 * - A company a LinkedIn position names is read by its id: nothing guessed. The positions on the profiles of the
 *   student's own people settle their companies for that student (orbit_private.linkedin_company_picks).
 * - A name is taken only when LinkedIn's search answers it plainly (`chooseCompany`): its first result is that
 *   company (the same name, the name LinkedIn writes it under, or its initials), and no other page in the results has
 *   the same name, unless that first page is the long-established one and the rest are far newer (a fan page beside
 *   Tesla's). "Triumph", "Nova" or "Smith", with several pages of that name, are left ambiguous: a person's position
 *   or the student's own pick settles them.
 * - Follower counts are never used: LinkedIn's search gives them cut down to three digits ("579" for NASA's millions).
 * A name LinkedIn cannot pin down is kept as such, so nobody searches it again for a month.
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
  /** the lookup rules that made it (LOOKUP_RULES now; 1 before 2026-11-10) */
  rules?: number;
}

export interface CompanyCache {
  getMany(keys: string[]): Promise<Record<string, CompanyRow>>;
  put(row: CompanyRow): Promise<void>;
  /** keep a logo's bytes; answers the address it is served from */
  storeLogo(companyId: string, bytes: ArrayBuffer, contentType: string): Promise<string | undefined>;
  /** the companies settled exactly for one account (orbit_private.linkedin_company_picks), by name key */
  getPicks?(accountId: string, keys: string[]): Promise<Record<string, CompanyPick>>;
  putPick?(accountId: string, pick: CompanyPick): Promise<void>;
}

/** A company settled exactly for one account: a LinkedIn position named it, or the student picked it. */
export interface CompanyPick {
  key: string;
  companyId: string;
  publicIdentifier?: string;
  name?: string;
  logoUrl?: string;
  source: 'position' | 'student';
  /** when it was last kept (a pick without a logo has its page read again only after a while) */
  pickedAt?: string;
}

/** A pick as the student is told it. */
export const pickAnswer = (p: CompanyPick): CompanyAnswer => ({
  status: 'found',
  companyId: p.companyId,
  publicIdentifier: p.publicIdentifier,
  name: p.name,
  logoUrl: p.logoUrl,
  exact: true,
});

/** What a student is told about one company: found (with its id and a logo that does not expire), or why not. */
export interface CompanyAnswer {
  status: CompanyRow['status'];
  companyId?: string;
  publicIdentifier?: string;
  name?: string;
  logoUrl?: string;
  /** settled by a position on the profile of someone in this student's network, or by the student's own pick */
  exact?: boolean;
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

/**
 * The lookup rules a row is made under now. Rows of older rules are answered with until logos.user checks them again
 * (a name not pinned down then is asked again at once). 2: since 2026-11-10, follower counts and the page at a
 * company's own name no longer decide (`chooseCompany`).
 */
export const LOOKUP_RULES = 2;

/** Whether the shared list's row answers for now: found, or not pinned down within the month under today's rules. */
export function rowSettled(
  r: Pick<CompanyRow, 'status' | 'checkedAt' | 'logoUrl' | 'rules'> | undefined,
  now: Date,
): boolean {
  if (!r) return false;
  if (r.status === 'found' && r.logoUrl) return true;
  // not pinned down, or found without a logo (a namesake's page, or one with none yet): again after a month
  const at = Date.parse(r.checkedAt);
  return (r.rules ?? 1) >= LOOKUP_RULES && now.getTime() - at < COMPANY_RETRY_MS;
}

export const answerOf = (r: CompanyRow): CompanyAnswer => ({
  status: r.status,
  companyId: r.companyId,
  publicIdentifier: r.publicIdentifier,
  name: r.name,
  logoUrl: r.logoUrl,
});

/** A company name with its words and initials, as `chooseCompany` compares them. */
function words(v: unknown): string[] {
  return String(v ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}
const SMALL_WORDS = new Set(['of', 'the', 'and', 'at', 'for', 'in', 'de', 'la']);

/**
 * Whether a LinkedIn page's name is the name asked for, or the name LinkedIn writes that company under: the same name
 * (`sameCompanyName`), the asked name followed by a dash, a colon or a bracket ("NASA - National Aeronautics and Space
 * Administration"), or the initials of its words ("SJSU" for San José State University). Two letters are never
 * initials enough.
 */
export function namesCompany(theirs: unknown, asked: string): boolean {
  if (sameCompanyName(theirs, asked)) return true;
  const t = String(theirs ?? '');
  const head = /^(.+?)\s*(?:\s[-–—|:]\s|\()/.exec(t)?.[1];
  if (head && sameCompanyName(head, asked)) return true;
  const want = words(asked).join('');
  if (want.length < 3 || want.length > 8 || words(asked).length !== 1) return false;
  const all = words(t);
  const initials = (ws: string[]) => ws.map((w) => w[0]).join('');
  return initials(all) === want || initials(all.filter((w) => !SMALL_WORDS.has(w))) === want;
}

/**
 * How much older the first page must be than every other page of the same name for the name to be its: LinkedIn's
 * ids count up, so Tesla's 15564 beside fan pages in the tens of millions (thousands of times newer) is the company
 * people mean, while "Triumph" at 74900938 beside TRIUMPH at 50454, or "Smith" at 17700 beside another Smith at
 * 2715458 (150 times), is not settled.
 */
export const ESTABLISHED_RATIO = 2000;

/** One company search result as `chooseCompany` reads it. */
export interface SearchItem {
  id?: unknown;
  name?: unknown;
  public_identifier?: unknown;
  profile_url?: unknown;
  logo?: unknown;
}

/**
 * Which result of LinkedIn's company search a name means, or why none can be taken. LinkedIn's own first result is
 * the candidate: it must name the company asked for (`namesCompany`), and every other page in the results with the
 * same name must be far newer (`ESTABLISHED_RATIO`). When the first result is about something else, the one page that
 * has exactly the name is taken, if there is exactly one. Anything else is `ambiguous` (several pages could be it,
 * listed in `sameIds`) or `not_found`.
 */
export function chooseCompany(
  items: SearchItem[],
  asked: string,
): { id: string; item: SearchItem } | { reason: 'ambiguous' | 'not_found'; sameIds: string[] } {
  const listed = items.filter(
    (c) => (typeof c.id === 'string' && /^\d+$/.test(c.id)) || (typeof c.id === 'number' && c.id > 0),
  );
  const idOf = (c: SearchItem) => Number(c.id);
  const same = listed.filter((c) => sameCompanyName(c.name, asked) || namesCompany(c.name, asked));
  const first = listed[0];
  if (first && namesCompany(first.name, asked)) {
    const rivals = listed
      .slice(1)
      .filter((c) => sameCompanyName(c.name, asked) || sameCompanyName(bare(c.name), asked));
    if (rivals.every((r) => idOf(r) >= ESTABLISHED_RATIO * idOf(first)))
      return { id: String(first.id), item: first };
    return { reason: 'ambiguous', sameIds: [first, ...rivals].map((c) => String(c.id)) };
  }
  const exact = listed.filter((c) => sameCompanyName(c.name, asked));
  if (exact.length === 1) return { id: String(exact[0]!.id), item: exact[0]! };
  if (exact.length > 1) return { reason: 'ambiguous', sameIds: exact.map((c) => String(c.id)) };
  return same.length > 1
    ? { reason: 'ambiguous', sameIds: same.map((c) => String(c.id)) }
    : { reason: 'not_found', sameIds: [] };
}

/** A page's name without what LinkedIn put in brackets after it ("Moonshot (YC S26)" is Moonshot). */
const bare = (v: unknown) => String(v ?? '').replace(/\s*\([^)]*\)\s*$/, '');

/**
 * A company found on LinkedIn by its name: LinkedIn's company search, read by `chooseCompany`. Otherwise
 * `ambiguous`, with the same-name results' ids, or `not_found`; a namesake's logo is never taken on a guess.
 */
export async function companyByName(
  u: UnipileAuth,
  accountId: string,
  name: string,
  doFetch: typeof fetch,
): Promise<{ id: string; item: Record<string, unknown> } | (CompanyFailure & { sameIds?: string[] })> {
  const items = await searchCompanies(u, accountId, name, doFetch);
  if (!Array.isArray(items)) return items;
  const c = chooseCompany(items, name);
  if ('id' in c) return { id: c.id, item: c.item as Record<string, unknown> };
  return c.reason === 'ambiguous'
    ? {
        ok: false,
        reason: 'ambiguous',
        message: 'LinkedIn has more than one company of that name.',
        sameIds: c.sameIds,
      }
    : { ok: false, reason: 'not_found', message: 'LinkedIn could not find that company.' };
}

/** LinkedIn's company search for a name: its results in LinkedIn's own order, or why it could not answer. */
export async function searchCompanies(
  u: UnipileAuth,
  accountId: string,
  keywords: string,
  doFetch: typeof fetch,
): Promise<Record<string, unknown>[] | CompanyFailure> {
  const q = new URLSearchParams({ account_id: accountId, limit: '10' });
  const res = await doFetch(`${u.base}/api/v1/linkedin/search?${q}`, {
    method: 'POST',
    headers: headers(u),
    body: JSON.stringify({ api: 'classic', category: 'companies', keywords }),
  });
  if (res.status === 429) return THROTTLED;
  if (res.status >= 400 && res.status < 500)
    return { ok: false, reason: 'refused', message: await unipileError(res) };
  if (!res.ok) throw new Error(`unipile ${res.status}`);
  return ((await res.json()) as { items?: Record<string, unknown>[] }).items ?? [];
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
    rules: LOOKUP_RULES,
  };
  // kept with its logo, or kept without one when LinkedIn has none (so it is not looked up again); a logo that did not
  // copy leaves the company to be looked up again later
  if (kept || !c.logo) await cache?.put(row).catch(() => undefined);
  return { ...answerOf(row), logoUrl: kept ?? c.logo };
}

/** A logo's bytes into Orbit's storage under its LinkedIn id; the address it is served from, or nothing. */
export async function copyLogo(
  cache: CompanyCache,
  id: string,
  url: string,
  doFetch: typeof fetch,
): Promise<string | undefined> {
  try {
    const res = await doFetch(url);
    const type = res.headers.get('content-type') ?? 'image/jpeg';
    const bytes = await res.arrayBuffer();
    if (!res.ok || !type.startsWith('image/') || !bytes.byteLength || bytes.byteLength > LOGO_MAX_BYTES)
      return undefined;
    return await cache.storeLogo(id, bytes, type);
  } catch {
    return undefined;
  }
}

/** A position or a school on a profile, as orbit-connectors maps it. */
export interface ProfileOrg {
  company?: string;
  companyId?: string;
  companySlug?: string;
  school?: string;
  schoolId?: string;
  logoUrl?: string;
}

/**
 * A profile read names every company and school on it by LinkedIn's id, with LinkedIn's logo: the logos LinkedIn shows
 * on that profile, for no extra read. Each is copied into Orbit's storage (LinkedIn's links expire after a few weeks)
 * and the profile is answered with the copies, so a profile's logos show the first time it is opened and keep showing.
 *
 * With the reading account (`accountId`), each company becomes that account's pick under its own name: for this
 * student, that name means this company. The shared list is only ever filled in, never decided, by a profile: a row
 * already found as this same company gets its logo, nothing else (one student's "Nova" is not everyone's).
 */
export async function keepProfileLogos(
  cache: CompanyCache | undefined,
  orgs: ProfileOrg[],
  doFetch: typeof fetch,
  now: Date,
  opts: { accountId?: string } = {},
): Promise<number> {
  if (!cache) return 0;
  const linked = orgs.filter(
    (o) => o.logoUrl && isLinkedInImage(o.logoUrl) && /^\d+$/.test(o.companyId ?? o.schoolId ?? ''),
  );
  if (!linked.length) return 0;
  const keyOf = (o: ProfileOrg) => companyNameKey(o.company ?? o.school ?? '');
  const keys = [...new Set(linked.map(keyOf).filter(Boolean))];
  const rows = keys.length ? await cache.getMany(keys).catch(() => ({}) as Record<string, CompanyRow>) : {};
  const copies = new Map<string, Promise<string | undefined>>();
  let kept = 0;
  await Promise.all(
    linked.map(async (o) => {
      const id = (o.companyId ?? o.schoolId)!;
      const key = keyOf(o);
      const row = key ? rows[key] : undefined;
      let url: string | undefined;
      // this company's own copy is kept already: answer with it
      if (row?.companyId === id && row.logoUrl) url = row.logoUrl;
      else {
        let copy = copies.get(id);
        if (!copy) {
          copy = copyLogo(cache, id, o.logoUrl!, doFetch);
          copies.set(id, copy);
        }
        url = await copy;
        if (!url) return;
        kept++;
        // the shared list's row for this very company, without a logo yet: it gets this one
        if (row?.status === 'found' && row.companyId === id && !row.logoUrl)
          await cache.put({ ...row, logoUrl: url, checkedAt: now.toISOString() }).catch(() => undefined);
      }
      o.logoUrl = url;
      if (opts.accountId && key && cache.putPick)
        await cache
          .putPick(opts.accountId, {
            key,
            companyId: id,
            publicIdentifier: o.companySlug,
            name: o.company ?? o.school,
            logoUrl: url,
            source: 'position',
          })
          .catch(() => undefined);
    }),
  );
  return kept;
}

/** Where a logo copied from a profile is served, when one was: the copy is kept under the company's LinkedIn id. */
export async function keptLogoFor(
  id: string,
  doFetch: typeof fetch,
  publicBase: string | undefined,
): Promise<string | undefined> {
  if (!publicBase) return undefined;
  for (const ext of ['png', 'jpg', 'webp']) {
    const url = `${publicBase.replace(/\/+$/, '')}/${id}.${ext}`;
    const r = await doFetch(url, { method: 'HEAD' }).catch(() => undefined);
    if (r?.ok) return url;
  }
  return undefined;
}

/** What one lookup did: the answer, whether it spent anything, and why it stopped when it could not go on. */
export interface LookupOutcome {
  answer?: CompanyAnswer;
  /** a LinkedIn read was taken for it */
  looked: boolean;
  stopped?: 'limit' | 'throttled';
}

/**
 * Look one company up on LinkedIn. `spend` takes one company read from the account's ledger (false: the day's reads
 * are used, nothing more is asked).
 *
 * With LinkedIn's id for it (a position on a profile of the student's people named it) the company's page is read by
 * that id and kept as this account's pick: exact, and never put in the shared list under the name (another student's
 * "Nova" may be another Nova). By name, LinkedIn's search is read by `chooseCompany` (with the name cleaned of what was
 * typed after the company, `searchName`) and the answer kept for everyone.
 *
 * `recheck`: a row the shared list found under older rules. When LinkedIn's first result for the name is still that
 * company it stays; when the name now turns out to be ambiguous or another company, the row says so and its logo goes.
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
    recheck?: CompanyRow;
    /** only the page at `companyId` (a settled company's logo): never a search by name when it does not answer */
    idOnly?: boolean;
  },
): Promise<LookupOutcome> {
  const { accountId, key, cache, doFetch, now, spend } = o;
  if (!(await spend())) return { looked: false, stopped: 'limit' };
  if (o.companyId && /^\d+$/.test(o.companyId)) {
    const page = await companyPage(u, accountId, o.companyId, doFetch).catch(() => undefined);
    if (page && 'company' in page && page.company) {
      const c = page.company;
      const logoUrl =
        c.logoUrl && cache ? await copyLogo(cache, c.id ?? o.companyId, c.logoUrl, doFetch) : undefined;
      const pick: CompanyPick = {
        key,
        companyId: c.id ?? o.companyId,
        publicIdentifier: c.publicIdentifier,
        name: c.name,
        logoUrl,
        source: 'position',
      };
      await cache?.putPick?.(accountId, pick).catch(() => undefined);
      return { looked: true, answer: { ...pickAnswer(pick), logoUrl: logoUrl ?? c.logoUrl } };
    }
    if (page && !('company' in page) && page.reason === 'throttled')
      return { looked: true, stopped: 'throttled' };
    if (o.idOnly) return { looked: true };
    // the id did not answer: by name, from the next read
    if (!(await spend())) return { looked: true, stopped: 'limit' };
  }
  const name = searchName(o.name);
  const items = await searchCompanies(u, accountId, name, doFetch);
  if (!Array.isArray(items)) {
    if (items.reason === 'throttled') return { looked: true, stopped: 'throttled' };
    return { looked: true };
  }
  const chosen = chooseCompany(items, name);
  if (!('id' in chosen)) {
    const first = items[0];
    // an older row LinkedIn still lists first for the name: it stays (Dell's page is "Dell Technologies" now, and
    // LinkedIn still answers "Dell" with it)
    if (
      o.recheck?.status === 'found' &&
      o.recheck.companyId &&
      first &&
      String(first.id) === o.recheck.companyId
    ) {
      const row = { ...o.recheck, checkedAt: now.toISOString(), rules: LOOKUP_RULES };
      await cache?.put(row).catch(() => undefined);
      return { looked: true, answer: answerOf(row) };
    }
    // not pinned down: kept as such (a page at the company's own name is never taken instead, it was often a
    // namesake's: /company/aden for ADEN (YC W20), /company/smith for someone's Smith)
    const row: CompanyRow = { key, status: chosen.reason, checkedAt: now.toISOString(), rules: LOOKUP_RULES };
    await cache?.put(row).catch(() => undefined);
    return { looked: true, answer: answerOf(row) };
  }
  let c: FoundCompany = {
    id: chosen.id,
    name: text(chosen.item.name, 160),
    publicIdentifier: text(chosen.item.public_identifier, 160),
    logo: licdn(chosen.item.logo),
  };
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

/** Where the bucket's logos are served from (keptLogoFor). */
export const logosPublicBase = (url: string) =>
  `${url.replace(/\/+$/, '')}/storage/v1/object/public/company-logos`;

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
