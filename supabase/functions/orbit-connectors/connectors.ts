/**
 * Orbit's connector proxy: Unipile (live LinkedIn: hosted connect, the student's connections, mutual connections,
 * unlinking) and Village (warm intro paths). Both third-party keys stay on the server here, never in the browser.
 * Only Orbit's own origins may call it, only the routes below, and each visitor (hashed IP) only so often. Kept free
 * of Deno APIs so it runs under Node tests.
 *
 * Routes (POST, JSON):
 *   /connect/start, /connect/status, /relations, /mutuals, /disconnect  -> Unipile
 *   /paths                                                              -> Village
 * A route whose provider key is not set returns 503 with x-orbit-connector: unconfigured, so the app shows the
 * CSV fallback (or its own graph) instead. Pasting the key as a function secret turns it on with no redeploy of
 * the app. The exact upstream request and response mapping lives in the adapter functions, so a live test with real
 * keys only changes this file (Village's lives in _shared/providers/village.ts, shared with the server).
 */
import {
  companyIntros,
  createVillage,
  personIntros,
  type Village,
  type VillageIntro,
  type VillageUser,
} from '../_shared/providers/village';

export interface Limits {
  perMinute: number;
  perDay: number;
}
/** A sync pages 200 connections per call, so the minute limit leaves room for a large network. */
export const DEFAULT_LIMITS: Limits = { perMinute: 120, perDay: 3000 };

export interface Bucket {
  key: string;
  limit: number;
  expires: string;
}
/** Increment every bucket and say whether all stayed within their limits (the same store orbit-claude uses). */
export type Take = (buckets: Bucket[]) => Promise<{ allowed: boolean; over?: string }>;

export interface ConnectorDeps {
  unipileKey: string | undefined;
  unipileBase: string | undefined; // e.g. https://api{dc}.unipile.com:{port}
  /** Village app secret key (VILLAGE_SECRET_KEY, or VILLAGE_API_KEY) */
  villageKey: string | undefined;
  villageBase: string | undefined;
  /** who Village provisions this deployment's paths for (VILLAGE_EXTERNAL_USER_ID, VILLAGE_USER_EMAIL) */
  villageUser?: VillageUser;
  origins: (origin: string) => boolean;
  /** the request counters; without one, an in-memory counter per function instance is used */
  take?: Take;
  limits?: Limits;
  /** salt for the visitor hash, so stored buckets never hold a raw IP */
  salt?: string;
  now?: () => Date;
  fetch?: typeof fetch;
  /** the reference for a new hosted connect (tests pin it) */
  newRef?: () => string;
}

export function defaultOrigins(origin: string): boolean {
  if (origin === 'https://princecharming001.github.io') return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function cors(origin: string | null, allowed: boolean): Record<string, string> {
  if (!origin || !allowed) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': 'x-orbit-connector, x-orbit-limit, retry-after',
    Vary: 'Origin',
  };
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const unconfigured = (h: Record<string, string>) =>
  json(503, { error: 'not configured' }, { ...h, 'x-orbit-connector': 'unconfigured' });

export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? 'unknown';
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
}

/** The per-visitor buckets for this minute and this day. Keys are prefixed so they never mix with orbit-claude's. */
export function buckets(visitor: string, now: Date, limits: Limits): Bucket[] {
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const minute = iso.slice(0, 16);
  const endOfDay = new Date(`${day}T00:00:00Z`);
  endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);
  const endOfMinute = new Date(`${minute}:00Z`);
  endOfMinute.setUTCMinutes(endOfMinute.getUTCMinutes() + 1);
  return [
    {
      key: `connectors:min:${minute}:${visitor}`,
      limit: limits.perMinute,
      expires: endOfMinute.toISOString(),
    },
    { key: `connectors:day:${day}:${visitor}`, limit: limits.perDay, expires: endOfDay.toISOString() },
  ];
}

/**
 * Counters in this function instance's memory: the fallback when no shared store is configured. Expiry reads the
 * same clock the buckets were cut with, so a pinned clock (tests) never sees its own buckets as expired.
 */
export function memoryTake(clock: () => number = Date.now): Take {
  const counts = new Map<string, { n: number; expires: number }>();
  return async (bs) => {
    const now = clock();
    for (const [k, v] of counts) if (v.expires < now) counts.delete(k);
    for (const b of bs) {
      const c = counts.get(b.key) ?? { n: 0, expires: Date.parse(b.expires) };
      c.n++;
      counts.set(b.key, c);
      if (c.n > b.limit) return { allowed: false, over: b.key };
    }
    return { allowed: true };
  };
}

const UNIPILE_ROUTES = new Set([
  '/connect/start',
  '/connect/status',
  '/relations',
  '/mutuals',
  '/disconnect',
]);

export function makeHandler(deps: ConnectorDeps): (req: Request) => Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const now = deps.now ?? (() => new Date());
  const take = deps.take ?? memoryTake(() => now().getTime());
  // one client per instance, so its token (minted per user, kept 50 minutes) is reused across requests
  const village = createVillage({
    fetch: doFetch,
    secretKey: deps.villageKey,
    baseUrl: deps.villageBase,
    clock: () => now().getTime(),
    timeoutMs: 6000,
    maxRetries: 1,
  });
  return async (req) => {
    const origin = req.headers.get('origin');
    const allowed = !!origin && deps.origins(origin);
    const h = cors(origin, allowed);
    if (req.method === 'OPTIONS') {
      if (!allowed) return new Response(null, { status: 403, headers: h });
      return new Response(null, {
        status: 204,
        headers: {
          ...h,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': req.headers.get('access-control-request-headers') ?? '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    if (!allowed) return json(403, { error: 'origin not allowed' }, h);
    if (req.method !== 'POST') return json(405, { error: 'POST only' }, h);
    const path = new URL(req.url).pathname.replace(/.*\/orbit-connectors/, '') || '/';
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const isVillage = path === '/paths';
    if (!isVillage && !UNIPILE_ROUTES.has(path)) return json(404, { error: 'no such route' }, h);
    if (isVillage && (!deps.villageKey || !deps.villageBase || !deps.villageUser?.email))
      return unconfigured(h);
    if (!isVillage && (!deps.unipileKey || !deps.unipileBase)) return unconfigured(h);

    // only calls that would reach a provider count against the visitor's limits
    const visitor = (await sha256(`${deps.salt ?? 'orbit'}:${clientIp(req)}`)).slice(0, 32);
    let verdict: { allowed: boolean; over?: string };
    try {
      verdict = await take(buckets(visitor, now(), limits));
    } catch {
      return json(503, { error: 'unavailable right now' }, h);
    }
    if (!verdict.allowed) {
      const minute = verdict.over?.includes(':min:') ?? false;
      return json(
        429,
        { error: minute ? 'too many requests, try again shortly' : "today's limit reached" },
        {
          ...h,
          'x-orbit-limit': minute ? 'minute' : 'day',
          ...(minute ? { 'retry-after': '30' } : {}),
        },
      );
    }

    try {
      if (isVillage) return json(200, await villagePaths(village, deps.villageUser!, body), h);
      if (path === '/connect/start')
        return json(200, await unipileConnectStart(deps, doFetch, deps.newRef ?? newRef), h);
      if (path === '/connect/status') return json(200, await unipileConnectStatus(deps, body, doFetch), h);
      if (path === '/relations') return json(200, await unipileRelations(deps, body, doFetch), h);
      if (path === '/mutuals') return json(200, await unipileMutuals(deps, body, doFetch), h);
      return json(200, await unipileDisconnect(deps, body, doFetch), h);
    } catch (e) {
      return json(502, { error: e instanceof Error ? e.message : 'upstream error' }, h);
    }
  };
}

function newRef(): string {
  return `orbit_${crypto.randomUUID()}`;
}

// ---- Unipile adapters (shapes per Unipile's API; corrected against a live key before launch) ----------------

function uHeaders(deps: ConnectorDeps): Record<string, string> {
  return { 'content-type': 'application/json', accept: 'application/json', 'X-API-KEY': deps.unipileKey! };
}

/**
 * A hosted sign-in link for a new LinkedIn account. The account is created with our reference as its name, so the
 * status check can find it among the accounts once the student has signed in.
 */
async function unipileConnectStart(deps: ConnectorDeps, doFetch: typeof fetch, makeRef: () => string) {
  const ref = makeRef();
  const res = await doFetch(`${deps.unipileBase}/api/v1/hosted/accounts/link`, {
    method: 'POST',
    headers: uHeaders(deps),
    body: JSON.stringify({
      type: 'create',
      providers: ['LINKEDIN'],
      api_url: deps.unipileBase,
      expiresOn: new Date(Date.now() + 60 * 60_000).toISOString(),
      name: ref,
    }),
  });
  if (!res.ok) throw new Error(`unipile ${res.status}`);
  const b = (await res.json()) as { url?: string };
  if (!b.url) throw new Error('unipile gave no link');
  return { url: b.url, ref };
}

/** Unipile's source states that mean the sign-in failed or the account stopped working. */
const FAILED_SOURCE = new Set(['ERROR', 'CREDENTIALS', 'PERMISSIONS', 'STOPPED']);

async function unipileConnectStatus(
  deps: ConnectorDeps,
  body: Record<string, unknown>,
  doFetch: typeof fetch,
) {
  const ref = String(body.ref ?? '');
  if (!ref) return { status: 'error', message: 'No connection was started.' };
  const res = await doFetch(`${deps.unipileBase}/api/v1/accounts?limit=250`, { headers: uHeaders(deps) });
  // not there yet is still waiting; anything else is Unipile failing
  if (res.status === 404) return { status: 'pending' };
  if (!res.ok) throw new Error(`unipile ${res.status}`);
  const b = (await res.json()) as {
    items?: { id?: string; name?: string; sources?: { status?: string }[] }[];
  };
  const acc = b.items?.find((a) => a.name === ref);
  if (!acc) return { status: 'pending' };
  const states = (acc.sources ?? []).map((x) => String(x.status ?? '').toUpperCase());
  if (states.includes('OK') && acc.id) return { status: 'connected', accountId: acc.id };
  if (states.some((x) => FAILED_SOURCE.has(x)))
    return {
      status: 'error',
      accountId: acc.id,
      message: states.includes('CREDENTIALS')
        ? 'LinkedIn did not accept the sign-in. Try again.'
        : 'LinkedIn could not be connected. Try again.',
    };
  return { status: 'pending' };
}

/** Unlink an account at Unipile. One that is already gone counts as unlinked. */
async function unipileDisconnect(deps: ConnectorDeps, body: Record<string, unknown>, doFetch: typeof fetch) {
  const accountId = String(body.accountId ?? '');
  if (!accountId) throw new Error('no account');
  const res = await doFetch(`${deps.unipileBase}/api/v1/accounts/${encodeURIComponent(accountId)}`, {
    method: 'DELETE',
    headers: uHeaders(deps),
  });
  if (!res.ok && res.status !== 404) throw new Error(`unipile ${res.status}`);
  return { ok: true };
}

async function unipileRelations(deps: ConnectorDeps, body: Record<string, unknown>, doFetch: typeof fetch) {
  const accountId = String(body.accountId ?? '');
  const cursor = body.cursor ? `&cursor=${encodeURIComponent(String(body.cursor))}` : '';
  const res = await doFetch(
    `${deps.unipileBase}/api/v1/users/relations?account_id=${encodeURIComponent(accountId)}&limit=200${cursor}`,
    { headers: uHeaders(deps) },
  );
  if (!res.ok) throw new Error(`unipile ${res.status}`);
  const b = (await res.json()) as {
    items?: Record<string, unknown>[];
    cursor?: string | null;
  };
  return {
    items: (b.items ?? []).map((r) => ({
      first_name: r.first_name,
      last_name: r.last_name,
      headline: r.headline,
      position: r.occupation ?? r.headline,
      company: r.company,
      public_profile_url: r.public_profile_url ?? r.profile_url,
      connected_at: r.created_at,
      member_id: r.member_id ?? r.provider_id ?? r.id,
    })),
    cursor: b.cursor ?? null,
  };
}

async function unipileMutuals(deps: ConnectorDeps, body: Record<string, unknown>, doFetch: typeof fetch) {
  const accountId = String(body.accountId ?? '');
  const target = String(body.targetMemberId ?? '');
  // LinkedIn search for the student's 1st-degree connections who are connected to the target
  const res = await doFetch(
    `${deps.unipileBase}/api/v1/linkedin/search?account_id=${encodeURIComponent(accountId)}`,
    {
      method: 'POST',
      headers: uHeaders(deps),
      body: JSON.stringify({
        api: 'classic',
        category: 'people',
        network_distance: ['DISTANCE_1'],
        connections_of: target,
      }),
    },
  );
  if (!res.ok) throw new Error(`unipile ${res.status}`);
  const b = (await res.json()) as { items?: Record<string, unknown>[] };
  return {
    mutuals: (b.items ?? []).map((m) => ({
      name: m.name ?? `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim(),
      headline: m.headline,
      url: m.public_profile_url ?? m.profile_url,
      member_id: m.member_id ?? m.id,
    })),
  };
}

// ---- Village adapter (v2: token per user, then people/companies paths; see _shared/providers/village.ts) --------

function looksLikeDomain(s: string): boolean {
  return /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(
    s
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, ''),
  );
}

/**
 * The client's `/paths` contract, answered with Village v2: a LinkedIn URL asks `/v2/people/paths`; a company
 * domain (`domain`, or a `company` that is one) asks `/v2/companies/paths`. Village has no name-only lookup, so a
 * bare name or company name gets no paths (and costs no credits).
 */
async function villagePaths(village: Village, user: VillageUser, body: Record<string, unknown>) {
  const linkedinUrl = typeof body.linkedin_url === 'string' ? body.linkedin_url.trim() : '';
  const company = typeof body.company === 'string' ? body.company.trim() : '';
  const domain =
    typeof body.domain === 'string' && body.domain.trim()
      ? body.domain.trim()
      : company && looksLikeDomain(company)
        ? company
        : '';
  let intros: VillageIntro[];
  if (linkedinUrl) {
    const r = await village.personPaths(user, { linkedin_url: linkedinUrl });
    if (!r.ok) throw new Error(r.message);
    intros = personIntros(r.value);
  } else if (domain) {
    const clean = domain
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/.*$/, '')
      .toLowerCase();
    const r = await village.companyPaths(user, { domain: clean, limit: 25 });
    if (!r.ok) throw new Error(r.message);
    intros = companyIntros(r.value);
  } else return { paths: [] };
  const fallbackTarget = typeof body.name === 'string' && body.name ? body.name : company;
  return {
    paths: intros.slice(0, 10).map((i) => ({
      introducer: {
        name: i.introducer.name,
        headline: i.introducer.headline,
        linkedin_url: i.introducer.linkedinUrl,
      },
      warmth: i.warmth,
      hops: [
        'You',
        ...(i.degree >= 3 ? ['a teammate'] : []),
        i.introducer.name,
        i.target.name ?? fallbackTarget,
      ].filter((h): h is string => !!h),
      note: i.reasons[0] ?? i.scoreLabel,
    })),
  };
}

// ---- the shared counter store ------------------------------------------------------------------------------

/**
 * The request counters over PostgREST with the service role key: the same orbit_proxy_take function orbit-claude
 * uses (supabase/migrations/20261012_orbit_claude_proxy.sql), with keys prefixed `connectors:`.
 */
export function postgrestTake(url: string, serviceKey: string, doFetch: typeof fetch = fetch): Take {
  return async (bs) => {
    const r = await doFetch(`${url}/rest/v1/rpc/orbit_proxy_take`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        p_buckets: bs.map((b) => b.key),
        p_limits: bs.map((b) => b.limit),
        p_expires: bs.map((b) => b.expires),
      }),
    });
    if (!r.ok) throw new Error(`counter store ${r.status}`);
    const rows = (await r.json()) as { allowed: boolean; over_bucket: string | null }[];
    const row = rows[0];
    if (!row) throw new Error('counter store returned nothing');
    return { allowed: row.allowed, over: row.over_bucket ?? undefined };
  };
}
