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
 * keys only changes this file.
 */

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
  villageKey: string | undefined;
  villageBase: string | undefined;
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

/** Counters in this function instance's memory: the fallback when no shared store is configured. */
export function memoryTake(): Take {
  const counts = new Map<string, { n: number; expires: number }>();
  return async (bs) => {
    const now = Date.now();
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
  const take = deps.take ?? memoryTake();
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const now = deps.now ?? (() => new Date());
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

    const village = path === '/paths';
    if (!village && !UNIPILE_ROUTES.has(path)) return json(404, { error: 'no such route' }, h);
    if (village && (!deps.villageKey || !deps.villageBase)) return unconfigured(h);
    if (!village && (!deps.unipileKey || !deps.unipileBase)) return unconfigured(h);

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
      if (village) return json(200, await villagePaths(deps, body, doFetch), h);
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

// ---- Village adapter --------------------------------------------------------------------------------------

async function villagePaths(deps: ConnectorDeps, body: Record<string, unknown>, doFetch: typeof fetch) {
  const res = await doFetch(`${deps.villageBase}/v1/paths`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.villageKey}` },
    body: JSON.stringify({
      target: { name: body.name, company: body.company, linkedin_url: body.linkedin_url },
      limit: 5,
    }),
  });
  if (!res.ok) throw new Error(`village ${res.status}`);
  const b = (await res.json()) as {
    paths?: {
      introducer?: { name?: string; headline?: string; linkedin_url?: string };
      warmth_score?: number;
      warmth?: number;
      path?: string[];
      hops?: string[];
      reason?: string;
    }[];
  };
  return {
    paths: (b.paths ?? []).map((p) => ({
      introducer: p.introducer,
      warmth: p.warmth ?? p.warmth_score,
      hops: p.hops ?? p.path,
      note: p.reason,
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
