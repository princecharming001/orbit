/**
 * Orbit's connector proxy: Unipile (live LinkedIn: hosted connect, the student's connections, mutual connections,
 * unlinking) and Village (warm intro paths). Both third-party keys stay on the server here, never in the browser.
 * Only Orbit's own origins may call it, only the routes below, and each visitor (hashed IP) only so often. Kept free
 * of Deno APIs so it runs under Node tests.
 *
 * Routes (POST, JSON):
 *   /connect/start, /connect/status, /relations, /mutuals, /disconnect, /send,
 *   /inbox, /search, /me, /chats/history, /posts/activity                      -> Unipile
 *   /paths                                                                     -> Village
 *   /profile, /company, /photo (Unipile), /web (Exa), /providers   -> enrichment (plan 17 E, block at the end)
 *
 * A connected account's routes need the account token /connect/status handed out (an HMAC of the account id with
 * the server's signing key), so knowing someone's Unipile account id is not enough to read their connections or
 * send as them. /send sends one message the student approved: a direct message to a connection, or a connection
 * request with a note to anyone else, at most ORBIT_LINKEDIN_SENDS_PER_DAY (25) per account per day. /inbox reads
 * the account's recent LinkedIn messages (so replies reach the pipeline on their own) and /search runs a LinkedIn
 * people search beyond the student's own network, at most ORBIT_LINKEDIN_SEARCHES_PER_DAY (40) per account per day.
 * /chats/history reads the student's 1:1 LinkedIn chats (full history, or since a checkpoint) and /posts/activity the
 * comments and reactions on their recent posts and their own comments on others' posts, at most
 * ORBIT_LINKEDIN_POST_READS_PER_DAY (12) calls per account per day (LinkedIn counts those reads). Both page with a
 * signed cursor of their own until it comes back null, so nothing is skipped silently.
 * A route whose provider key is not set returns 503 with x-orbit-connector: unconfigured, so the app shows the
 * CSV fallback (or its own graph) instead. Pasting the key as a function secret turns it on with no redeploy of
 * the app. The exact upstream request and response mapping lives in the adapter functions, so a live test with real
 * keys only changes this file (Village's lives in _shared/providers/village.ts, shared with the server).
 */

import { clientIp, defaultOrigins } from '../_shared/origins.ts';
import {
  companyIntros,
  createVillage,
  personIntros,
  type Village,
  type VillageIntro,
  type VillageUser,
} from '../_shared/providers/village';

export { clientIp, defaultOrigins };

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
  /** enrichment (plan 17 E): profile and company budgets, and the optional web and people-data keys */
  enrichment?: EnrichmentDeps;
  /** the reference for a new hosted connect (tests pin it) */
  newRef?: () => string;
  /** signs account tokens (the service role key in production); without it account routes are refused */
  signingKey?: string;
  /** LinkedIn messages and requests one account may send per day */
  sendsPerDay?: number;
  /** LinkedIn people searches one account may run per day (LinkedIn throttles heavy searching) */
  searchesPerDay?: number;
  /** /posts/activity calls one account may make per day (each reads a few posts' comments and reactions) */
  postReadsPerDay?: number;
  /** where Unipile reports the account a hosted sign-in produced; without it only the older account-list match runs */
  links?: LinkStore;
  /** this function's public address, for Unipile's notify_url */
  publicUrl?: string;
}

/** Which account each hosted sign-in produced (by the reference Orbit gave the sign-in link). */
export interface LinkStore {
  put(ref: string, accountId: string, status: string): Promise<void>;
  get(ref: string): Promise<string | undefined>;
}

export function memoryLinks(): LinkStore {
  const m = new Map<string, string>();
  return {
    put: async (ref, id) => {
      m.set(ref, id);
    },
    get: async (ref) => m.get(ref),
  };
}

/** The links table (public.orbit_unipile_links) over PostgREST with the service role key. */
export function postgrestLinks(url: string, serviceKey: string, doFetch: typeof fetch = fetch): LinkStore {
  const headers = {
    'content-type': 'application/json',
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
  return {
    put: async (ref, accountId, status) => {
      const r = await doFetch(`${url}/rest/v1/orbit_unipile_links?on_conflict=ref`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ ref, account_id: accountId, status }),
      });
      if (!r.ok) throw new Error(`links store ${r.status}`);
    },
    get: async (ref) => {
      const r = await doFetch(
        `${url}/rest/v1/orbit_unipile_links?ref=eq.${encodeURIComponent(ref)}&select=account_id`,
        { headers },
      );
      if (!r.ok) throw new Error(`links store ${r.status}`);
      const rows = (await r.json()) as { account_id?: string }[];
      return rows[0]?.account_id || undefined;
    },
  };
}

/** A connected account's token: base64url HMAC-SHA256 of its id with the signing key. */
export async function accountToken(accountId: string, signingKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`unipile-account:${accountId}`)),
  );
  return btoa(String.fromCharCode(...sig))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** Constant-time check of an account token. */
async function tokenValid(
  accountId: string,
  token: unknown,
  signingKey: string | undefined,
): Promise<boolean> {
  if (!signingKey || !accountId || typeof token !== 'string' || !token) return false;
  const want = await accountToken(accountId, signingKey);
  if (want.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

/** The per-account send bucket for today. */
export function sendBucket(accountId: string, now: Date, perDay: number): Bucket {
  const day = now.toISOString().slice(0, 10);
  const end = new Date(`${day}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { key: `connectors:send:${day}:${accountId}`, limit: perDay, expires: end.toISOString() };
}

/** The per-account LinkedIn search bucket for today. */
export function searchBucket(accountId: string, now: Date, perDay: number): Bucket {
  const b = sendBucket(accountId, now, perDay);
  return { ...b, key: b.key.replace('connectors:send:', 'connectors:search:') };
}

/** The per-account bucket for reading post comments and reactions today. */
export function postReadsBucket(accountId: string, now: Date, perDay: number): Bucket {
  const b = sendBucket(accountId, now, perDay);
  return { ...b, key: b.key.replace('connectors:send:', 'connectors:posts:') };
}

/** LinkedIn caps a connection-request note at this many characters. */
export const INVITE_NOTE_MAX = 300;

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
  '/send',
  '/inbox',
  '/search',
  '/me',
  '/chats/history',
  '/posts/activity',
]);
/** Routes that act on a connected account, so need its token. */
const ACCOUNT_ROUTES = new Set([
  '/relations',
  '/mutuals',
  '/disconnect',
  '/send',
  '/inbox',
  '/search',
  '/me',
  '/chats/history',
  '/posts/activity',
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
    // Unipile's server reports a finished sign-in here: no browser origin, but the link Orbit gave it is signed
    if (new URL(req.url).pathname.endsWith('/connect/notify')) return unipileNotify(deps, req);
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
    const isEnrich = ENRICH_ROUTES.has(path);
    if (!isVillage && !isEnrich && !UNIPILE_ROUTES.has(path)) return json(404, { error: 'no such route' }, h);
    if (path === '/providers') return json(200, providerStatus(deps), h);
    if (isVillage && (!deps.villageKey || !deps.villageBase || !deps.villageUser?.email))
      return unconfigured(h);
    if (!isVillage && !isEnrich && (!deps.unipileKey || !deps.unipileBase)) return unconfigured(h);

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

    if (isEnrich) return enrichmentRoute(deps, path, body, { h, doFetch, take, now, visitor });
    if (
      ACCOUNT_ROUTES.has(path) &&
      !(await tokenValid(String(body.accountId ?? ''), body.token, deps.signingKey))
    )
      return json(403, { error: 'this LinkedIn account is not linked to this browser' }, h);
    if (path === '/send') {
      let sendVerdict: { allowed: boolean };
      try {
        sendVerdict = await take([sendBucket(String(body.accountId), now(), deps.sendsPerDay ?? 25)]);
      } catch {
        return json(503, { error: 'unavailable right now' }, h);
      }
      if (!sendVerdict.allowed)
        return json(
          200,
          {
            ok: false,
            reason: 'limit',
            message: 'You have sent as many LinkedIn messages as Orbit allows today.',
          },
          h,
        );
    }
    if (path === '/search') {
      let searchVerdict: { allowed: boolean };
      try {
        searchVerdict = await take([searchBucket(String(body.accountId), now(), deps.searchesPerDay ?? 40)]);
      } catch {
        return json(503, { error: 'unavailable right now' }, h);
      }
      if (!searchVerdict.allowed)
        return json(
          200,
          {
            ok: false,
            reason: 'limit',
            message: 'You have run as many LinkedIn searches as Orbit allows today. Try again tomorrow.',
          },
          h,
        );
    }

    if (path === '/posts/activity') {
      let postsVerdict: { allowed: boolean };
      try {
        postsVerdict = await take([
          postReadsBucket(String(body.accountId), now(), deps.postReadsPerDay ?? 12),
        ]);
      } catch {
        return json(503, { error: 'unavailable right now' }, h);
      }
      if (!postsVerdict.allowed)
        return json(
          200,
          {
            ok: false,
            reason: 'limit',
            message: 'Orbit has read as many LinkedIn posts as it allows today. It reads the rest tomorrow.',
          },
          h,
        );
    }

    try {
      if (isVillage) return json(200, await villagePaths(village, deps.villageUser!, body), h);
      if (path === '/connect/start')
        return json(200, await unipileConnectStart(deps, doFetch, deps.newRef ?? newRef), h);
      if (path === '/connect/status') {
        const st = await unipileConnectStatus(deps, body, doFetch);
        // the browser that finished signing in gets the token its later calls must carry
        if (st.status === 'connected' && st.accountId && deps.signingKey)
          return json(200, { ...st, token: await accountToken(st.accountId, deps.signingKey) }, h);
        return json(200, st, h);
      }
      if (path === '/send') return json(200, await unipileSend(deps, body, doFetch), h);
      if (path === '/relations') return json(200, await unipileRelations(deps, body, doFetch), h);
      if (path === '/mutuals') return json(200, await unipileMutuals(deps, body, doFetch), h);
      if (path === '/inbox') return json(200, await unipileInbox(deps, body, doFetch), h);
      if (path === '/search') return json(200, await unipileSearch(deps, body, doFetch), h);
      if (path === '/me') return json(200, await unipileMe(deps, body, doFetch), h);
      if (path === '/chats/history') return json(200, await unipileChatHistory(deps, body, doFetch), h);
      if (path === '/posts/activity')
        return json(200, await unipilePostActivity(deps, body, doFetch, now()), h);
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
/** The signed address Unipile calls when a sign-in finishes; only the reference it was made for can use it. */
async function notifyUrl(deps: ConnectorDeps, ref: string): Promise<string | undefined> {
  if (!deps.publicUrl || !deps.signingKey || !deps.links) return undefined;
  const sig = await accountToken(`link:${ref}`, deps.signingKey);
  return `${deps.publicUrl}/connect/notify?ref=${encodeURIComponent(ref)}&sig=${encodeURIComponent(sig)}`;
}

async function unipileConnectStart(deps: ConnectorDeps, doFetch: typeof fetch, makeRef: () => string) {
  const ref = makeRef();
  const notify_url = await notifyUrl(deps, ref);
  const res = await doFetch(`${deps.unipileBase}/api/v1/hosted/accounts/link`, {
    method: 'POST',
    headers: uHeaders(deps),
    body: JSON.stringify({
      type: 'create',
      providers: ['LINKEDIN'],
      api_url: deps.unipileBase,
      expiresOn: new Date(Date.now() + 60 * 60_000).toISOString(),
      // Unipile hands this back with the new account's id, to notify_url: that is how the two are matched
      name: ref,
      ...(notify_url ? { notify_url } : {}),
    }),
  });
  if (!res.ok) throw new Error(`unipile ${res.status}`);
  const b = (await res.json()) as { url?: string };
  if (!b.url) throw new Error('unipile gave no link');
  return { url: b.url, ref };
}

/** Unipile's source states that mean the sign-in failed or the account stopped working. */
const FAILED_SOURCE = new Set(['ERROR', 'CREDENTIALS', 'PERMISSIONS', 'STOPPED']);

/** Where a hosted LinkedIn sign-in stands. */
type ConnectStatus = { status: 'connected' | 'pending' | 'error'; accountId?: string; message?: string };

async function unipileConnectStatus(
  deps: ConnectorDeps,
  body: Record<string, unknown>,
  doFetch: typeof fetch,
): Promise<ConnectStatus> {
  const ref = String(body.ref ?? '');
  if (!ref) return { status: 'error', message: 'No connection was started.' };
  // the account Unipile reported for this sign-in (notify_url): read its state directly
  const linked = await deps.links?.get(ref).catch(() => undefined);
  if (linked) {
    const one = await doFetch(`${deps.unipileBase}/api/v1/accounts/${encodeURIComponent(linked)}`, {
      headers: uHeaders(deps),
    });
    if (one.ok) return accountState((await one.json()) as UnipileAccount, linked);
    if (one.status !== 404) throw new Error(`unipile ${one.status}`);
  }
  const res = await doFetch(`${deps.unipileBase}/api/v1/accounts?limit=250`, { headers: uHeaders(deps) });
  // not there yet is still waiting; anything else is Unipile failing
  if (res.status === 404) return { status: 'pending' };
  if (!res.ok) throw new Error(`unipile ${res.status}`);
  const b = (await res.json()) as { items?: UnipileAccount[] };
  const acc = b.items?.find((a) => a.name === ref);
  if (!acc) return { status: 'pending' };
  return accountState(acc, acc.id);
}

type UnipileAccount = { id?: string; name?: string; sources?: { status?: string }[] };

/** An account's sign-in state from its sources: connected, failed, or still finishing. */
function accountState(acc: UnipileAccount, id: string | undefined): ConnectStatus {
  const states = (acc.sources ?? []).map((x) => String(x.status ?? '').toUpperCase());
  if (states.includes('OK') && id) return { status: 'connected', accountId: id };
  if (states.some((x) => FAILED_SOURCE.has(x)))
    return {
      status: 'error',
      accountId: id,
      message: states.includes('CREDENTIALS')
        ? 'LinkedIn did not accept the sign-in. Try again.'
        : 'LinkedIn could not be connected. Try again.',
    };
  return { status: 'pending' };
}

/**
 * Unipile's report that a hosted sign-in finished: {status, account_id, name}. Kept only when the link's signature
 * matches its reference and the report names that same reference, so nobody can tie someone else's account to it.
 */
async function unipileNotify(deps: ConnectorDeps, req: Request): Promise<Response> {
  const plain = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  const no = (status: number) => new Response(JSON.stringify({ ok: false }), { status, headers: plain });
  if (req.method !== 'POST' || !deps.links || !deps.signingKey) return no(404);
  const q = new URL(req.url).searchParams;
  const ref = q.get('ref') ?? '';
  const sig = q.get('sig') ?? '';
  if (!ref || !sig || sig !== (await accountToken(`link:${ref}`, deps.signingKey))) return no(403);
  let b: { status?: unknown; account_id?: unknown; name?: unknown };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return no(400);
  }
  const status = String(b.status ?? '');
  if (b.name !== ref || typeof b.account_id !== 'string' || !b.account_id) return no(400);
  if (status !== 'CREATION_SUCCESS' && status !== 'RECONNECTED') return no(400);
  await deps.links.put(ref, b.account_id, status);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: plain });
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

/** An error Unipile explains in its body, as one plain line. */
async function unipileError(res: Response): Promise<string> {
  try {
    const b = (await res.json()) as { detail?: string; title?: string; message?: string };
    return String(b.detail ?? b.title ?? b.message ?? `LinkedIn refused it (${res.status}).`);
  } catch {
    return `LinkedIn refused it (${res.status}).`;
  }
}

/**
 * Send one message the student approved, from their own LinkedIn: a direct message when they are connected, else a
 * connection request with the text as its note (LinkedIn allows only a request to someone they are not connected
 * to). The recipient is their LinkedIn member id when Orbit has it, else their public profile name, looked up first.
 */
async function unipileSend(deps: ConnectorDeps, body: Record<string, unknown>, doFetch: typeof fetch) {
  const accountId = String(body.accountId ?? '');
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const invite = body.invite === true;
  if (!text) return { ok: false, reason: 'bad_request', message: 'The message is empty.' };
  if (invite && text.length > INVITE_NOTE_MAX)
    return {
      ok: false,
      reason: 'bad_request',
      message: `A connection note can be at most ${INVITE_NOTE_MAX} characters.`,
    };
  let providerId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  if (!providerId) {
    if (!slug)
      return { ok: false, reason: 'bad_request', message: 'Orbit has no LinkedIn profile for them.' };
    const res = await doFetch(
      `${deps.unipileBase}/api/v1/users/${encodeURIComponent(slug)}?account_id=${encodeURIComponent(accountId)}`,
      { headers: uHeaders(deps) },
    );
    if (res.status === 404 || res.status === 422)
      return { ok: false, reason: 'not_found', message: 'LinkedIn could not find that profile.' };
    if (!res.ok) throw new Error(`unipile ${res.status}`);
    const p = (await res.json()) as { provider_id?: string };
    if (!p.provider_id)
      return { ok: false, reason: 'not_found', message: 'LinkedIn could not find that profile.' };
    providerId = p.provider_id;
  }
  if (invite) {
    const res = await doFetch(`${deps.unipileBase}/api/v1/users/invite`, {
      method: 'POST',
      headers: uHeaders(deps),
      body: JSON.stringify({ account_id: accountId, provider_id: providerId, message: text }),
    });
    if (res.status >= 400 && res.status < 500)
      return { ok: false, reason: 'refused', message: await unipileError(res) };
    if (!res.ok) throw new Error(`unipile ${res.status}`);
    const b = (await res.json()) as { invitation_id?: string };
    return { ok: true, invited: true, messageId: b.invitation_id, memberId: providerId };
  }
  const form = new FormData();
  form.append('account_id', accountId);
  form.append('text', text);
  form.append('attendees_ids', providerId);
  const res = await doFetch(`${deps.unipileBase}/api/v1/chats`, {
    method: 'POST',
    // FormData sets its own multipart content type
    headers: { accept: 'application/json', 'X-API-KEY': deps.unipileKey! },
    body: form,
  });
  if (res.status >= 400 && res.status < 500)
    return { ok: false, reason: 'refused', message: await unipileError(res) };
  if (!res.ok) throw new Error(`unipile ${res.status}`);
  const b = (await res.json()) as { chat_id?: string; message_id?: string };
  return { ok: true, invited: false, chatId: b.chat_id, messageId: b.message_id, memberId: providerId };
}

/** A date Unipile gives as epoch milliseconds, epoch seconds or text, as ISO text (or nothing). */
export function isoDate(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0)
    return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return new Date(n > 1e12 ? n : n * 1000).toISOString();
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  return undefined;
}

/** One relation as Orbit reads it, whichever of Unipile's field names it came with. */
export function mapRelation(r: Record<string, unknown>) {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const full = str(r.display_name) ?? str(r.name) ?? '';
  const first = str(r.first_name) ?? full.split(/\s+/)[0];
  const last = str(r.last_name) ?? (full ? full.split(/\s+/).slice(1).join(' ') : undefined);
  const slug = str(r.public_identifier);
  const picture = [r.profile_picture_url, r.profile_picture_url_large]
    .map(str)
    .find((u): u is string => !!u && isLinkedInImage(u));
  return {
    first_name: first,
    last_name: last,
    headline: str(r.headline),
    position: str(r.occupation) ?? str(r.headline),
    company: str(r.company),
    public_profile_url:
      str(r.public_profile_url) ??
      str(r.profile_url) ??
      (slug ? `https://www.linkedin.com/in/${slug}` : undefined),
    connected_at: isoDate(r.created_at ?? r.connected_at ?? r.date),
    member_id: str(r.member_id) ?? str(r.provider_id) ?? str(r.id),
    picture_url: picture,
  };
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
    data?: Record<string, unknown>[];
    cursor?: string | null;
    next_cursor?: string | null;
  };
  return {
    items: (b.items ?? b.data ?? []).filter((r) => !!r && typeof r === 'object').map(mapRelation),
    cursor: b.cursor ?? b.next_cursor ?? null,
  };
}

/** A profile photo is at most this big: a small square, kept in the student's browser. */
export const PHOTO_MAX_BYTES = 400_000;

/** LinkedIn's image hosts: the only places a profile photo is fetched from. */
export function isLinkedInImage(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'licdn.com' || u.hostname.endsWith('.licdn.com'));
  } catch {
    return false;
  }
}

function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * The student's own LinkedIn profile: their name, headline and photo. LinkedIn's photo links expire after a few
 * weeks, so the photo comes back as the image itself (a data: URL) for the browser to keep.
 */
async function unipileMe(deps: ConnectorDeps, body: Record<string, unknown>, doFetch: typeof fetch) {
  const accountId = String(body.accountId ?? '');
  const res = await doFetch(
    `${deps.unipileBase}/api/v1/users/me?account_id=${encodeURIComponent(accountId)}`,
    {
      headers: uHeaders(deps),
    },
  );
  if (!res.ok) throw new Error(`unipile ${res.status}`);
  const me = (await res.json()) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const pictureUrl = str(me.profile_picture_url_large) ?? str(me.profile_picture_url);
  let picture: string | undefined;
  if (pictureUrl && isLinkedInImage(pictureUrl)) {
    try {
      const img = await doFetch(pictureUrl);
      const type = img.headers.get('content-type') ?? '';
      const bytes = img.ok && type.startsWith('image/') ? new Uint8Array(await img.arrayBuffer()) : undefined;
      if (bytes && bytes.length <= PHOTO_MAX_BYTES)
        picture = `data:${type.split(';')[0]};base64,${base64(bytes)}`;
    } catch {
      // no photo is fine: the initials stay
    }
  }
  return {
    firstName: str(me.first_name),
    lastName: str(me.last_name),
    headline: str(me.headline) ?? str(me.occupation),
    publicIdentifier: str(me.public_identifier),
    // the student's own LinkedIn member id: their messages and comments carry it
    providerId: str(me.provider_id),
    picture,
  };
}

/** LinkedIn gives 10 people per page of a classic search: this many pages of mutual connections are read. */
export const MUTUALS_MAX_PAGES = 5;

/** Unipile's answer when it refused, as a bounded error the proxy's 502 body and logs can show (never the key). */
async function upstreamError(res: Response): Promise<Error> {
  let detail = '';
  try {
    detail = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    detail = '';
  }
  return new Error(`unipile ${res.status}${detail ? `: ${detail}` : ''}`);
}

/**
 * How many connections the student shares with a LinkedIn member, as LinkedIn states it on that member's profile
 * (`shared_connections_count`; the plain profile, no sections, is the lightest read). Undefined when LinkedIn did not
 * say: not found, throttled, refused, or a profile without the field.
 */
async function sharedConnectionCount(
  deps: ConnectorDeps,
  accountId: string,
  target: string,
  doFetch: typeof fetch,
): Promise<number | undefined> {
  const q = new URLSearchParams({ account_id: accountId });
  const res = await doFetch(`${deps.unipileBase}/api/v1/users/${encodeURIComponent(target)}?${q}`, {
    headers: uHeaders(deps),
  });
  if (!res.ok) {
    if (res.status >= 500) throw await upstreamError(res);
    return undefined;
  }
  const p = (await res.json()) as { shared_connections_count?: unknown };
  const n = p.shared_connections_count;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * The student's 1st-degree connections who are also connected to the target: LinkedIn's "Connections of" filter
 * (`connections_of`, a list of member ids) on a search of the student's own connections. Unipile echoes the filters
 * it parsed (`config.params`) but not whether LinkedIn honoured them, so the answer is held against the target's
 * profile: LinkedIn says there how many connections the two share, and a search that finds far more than that is the
 * student's own connections, not people who know the target. Without LinkedIn's count nothing is claimed.
 */
async function unipileMutuals(deps: ConnectorDeps, body: Record<string, unknown>, doFetch: typeof fetch) {
  const accountId = String(body.accountId ?? '');
  const target = String(body.targetMemberId ?? '').trim();
  if (!target) return { mutuals: [], verified: false, reason: 'no_target' };
  const shared = await sharedConnectionCount(deps, accountId, target, doFetch);
  if (shared === undefined) return { mutuals: [], verified: false, reason: 'no_shared_count' };
  if (shared === 0) return { mutuals: [], verified: true, count: 0 };
  const mutuals: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  let total: number | undefined;
  for (let page = 0; page < MUTUALS_MAX_PAGES; page++) {
    const q = new URLSearchParams({ account_id: accountId });
    if (cursor) q.set('cursor', cursor);
    const res = await doFetch(`${deps.unipileBase}/api/v1/linkedin/search?${q}`, {
      method: 'POST',
      headers: uHeaders(deps),
      body: JSON.stringify({
        api: 'classic',
        category: 'people',
        network_distance: [1],
        connections_of: [target],
      }),
    });
    if (!res.ok) throw await upstreamError(res);
    const b = (await res.json()) as {
      items?: Record<string, unknown>[];
      cursor?: string | null;
      paging?: { total_count?: number };
      config?: { params?: Record<string, unknown> };
    };
    // the filter must be in what Unipile searched for, and the result must be about the size LinkedIn says
    const applied = b.config?.params?.connections_of;
    const kept = Array.isArray(applied)
      ? applied.map(String)
      : applied === undefined
        ? []
        : [String(applied)];
    if (!kept.includes(target)) return { mutuals: [], verified: false, reason: 'filter_dropped' };
    if (typeof b.paging?.total_count === 'number') total = b.paging.total_count;
    if (page === 0)
      console.log(`mutuals: shared=${shared} total=${total ?? '?'} page=${(b.items ?? []).length}`);
    if (total !== undefined && total > shared * 1.5 + 5)
      return { mutuals: [], verified: false, reason: 'unfiltered', count: shared };
    for (const m of b.items ?? []) {
      // never the target themself, and only people the student is connected to
      const id = m.member_id ?? m.id;
      if (id === target) continue;
      if (typeof m.network_distance === 'string' && m.network_distance !== 'DISTANCE_1') continue;
      mutuals.push(m);
    }
    cursor = typeof b.cursor === 'string' && b.cursor ? b.cursor : undefined;
    if (!cursor || !(b.items ?? []).length || mutuals.length >= shared) break;
  }
  return {
    verified: true,
    count: shared,
    mutuals: mutuals.map((m) => ({
      name: m.name ?? `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim(),
      headline: m.headline,
      url: m.public_profile_url ?? m.profile_url,
      member_id: m.member_id ?? m.id,
      // LinkedIn's own photo link, for showing (it expires after a few weeks)
      picture_url: [m.profile_picture_url, m.profile_picture_url_large].find(
        (u): u is string => typeof u === 'string' && isLinkedInImage(u),
      ),
    })),
  };
}

/** At most this many pages of 250 messages per inbox call, and this many chats looked up one by one per call. */
export const INBOX_MAX_PAGES = 4;
export const INBOX_MAX_CHATS = 40;
/** Pages of 250 chats read per inbox call to learn who each recent chat is with (one call instead of one per chat). */
const INBOX_CHAT_PAGES = 2;
/** Without an `after`, the inbox reads back this far. */
const INBOX_DEFAULT_DAYS = 30;

/** Who a 1:1 chat is with, from Unipile's chat object; undefined for a group, a channel or an ad. */
function oneToOne(c: Record<string, unknown>): { providerId: string; name?: string } | undefined {
  // 0 is a 1:1 chat (Unipile's SINGLE); groups (1) and channels (2) are not one person's messages
  const type = c.type === undefined || c.type === null ? 0 : Number(c.type);
  if (type !== 0) return undefined;
  // sponsored messages and LinkedIn's own offers are advertising, not a person writing
  if (c.content_type === 'sponsored' || c.content_type === 'linkedin_offer') return undefined;
  const providerId = typeof c.attendee_provider_id === 'string' ? c.attendee_provider_id.trim() : '';
  if (!providerId) return undefined;
  return { providerId, name: typeof c.name === 'string' && c.name.trim() ? c.name.trim() : undefined };
}

/** A message that is a person writing: not an event (a reaction, a call), not hidden or deleted. */
const isWritten = (m: Record<string, unknown>) => !m.hidden && !m.deleted && !m.is_event;

/**
 * The account's LinkedIn messages since `after`, newest first as Unipile pages them, each with the person on the
 * other side of its 1:1 chat. Group chats, events and hidden or deleted messages are left out. Who each chat is with
 * comes from the list of chats active since `after` (and a lookup per chat for any it misses).
 *
 * Nothing is dropped quietly: when there are more messages than one call reads, `cursor` continues the read (send it
 * back as `cursor`), and `complete` is false whenever a message's chat could not be looked up. `latest` is the newest
 * message time; it is the next read's `after` only once a read ends with no cursor and complete.
 */
async function unipileInbox(deps: ConnectorDeps, body: Record<string, unknown>, doFetch: typeof fetch) {
  const accountId = String(body.accountId ?? '');
  const parsed = typeof body.after === 'string' ? new Date(body.after) : undefined;
  const after =
    parsed && !Number.isNaN(parsed.getTime())
      ? parsed
      : new Date(Date.now() - INBOX_DEFAULT_DAYS * 86_400_000);
  const raw: Record<string, unknown>[] = [];
  let cursor = typeof body.cursor === 'string' && body.cursor ? body.cursor : undefined;
  for (let page = 0; page < INBOX_MAX_PAGES; page++) {
    const q = new URLSearchParams({ account_id: accountId, limit: '250' });
    if (cursor) q.set('cursor', cursor);
    else q.set('after', after.toISOString());
    const res = await doFetch(`${deps.unipileBase}/api/v1/messages?${q}`, { headers: uHeaders(deps) });
    if (!res.ok) throw new Error(`unipile ${res.status}`);
    const b = (await res.json()) as { items?: Record<string, unknown>[]; cursor?: string | null };
    raw.push(...(b.items ?? []));
    cursor = typeof b.cursor === 'string' && b.cursor ? b.cursor : undefined;
    if (!cursor) break;
  }
  const kept = raw.filter(
    (m) => isWritten(m) && typeof m.chat_id === 'string' && typeof m.text === 'string' && m.text.trim(),
  );
  // who each chat is with: the chats active since `after`, a page of 250 at a time
  const chats = new Map<string, { providerId?: string; name?: string; group: boolean }>();
  const wanted = new Set(kept.map((m) => String(m.chat_id)));
  let chatCursor: string | undefined;
  for (let page = 0; page < INBOX_CHAT_PAGES && wanted.size > 0; page++) {
    const q = new URLSearchParams({ account_id: accountId, limit: '250' });
    if (chatCursor) q.set('cursor', chatCursor);
    else q.set('after', after.toISOString());
    const res = await doFetch(`${deps.unipileBase}/api/v1/chats?${q}`, { headers: uHeaders(deps) });
    if (!res.ok) break;
    const b = (await res.json()) as { items?: Record<string, unknown>[]; cursor?: string | null };
    for (const c of b.items ?? []) {
      if (typeof c.id !== 'string') continue;
      const one = oneToOne(c);
      chats.set(c.id, one ? { ...one, group: false } : { group: true });
    }
    if ([...wanted].every((id) => chats.has(id))) break;
    chatCursor = typeof b.cursor === 'string' && b.cursor ? b.cursor : undefined;
    if (!chatCursor) break;
  }
  // any chat the list did not name: one lookup each, most recent first, up to the budget
  let unattributed = 0;
  let lookups = 0;
  for (const id of wanted) {
    if (chats.has(id)) continue;
    if (lookups >= INBOX_MAX_CHATS) {
      unattributed += kept.filter((m) => m.chat_id === id).length;
      continue;
    }
    lookups++;
    const res = await doFetch(`${deps.unipileBase}/api/v1/chats/${encodeURIComponent(id)}`, {
      headers: uHeaders(deps),
    });
    if (!res.ok) {
      // a chat that is gone (404) has nobody to attribute; anything else is LinkedIn failing, and is said
      if (res.status !== 404) unattributed += kept.filter((m) => m.chat_id === id).length;
      continue;
    }
    const c = (await res.json()) as Record<string, unknown>;
    const one = oneToOne(c);
    chats.set(id, one ? { ...one, group: false } : { group: true });
  }
  const messages = kept
    .filter((m) => {
      const c = chats.get(String(m.chat_id));
      return !!c && !c.group && !!c.providerId;
    })
    .map((m) => {
      const c = chats.get(String(m.chat_id))!;
      return {
        id: String(m.id),
        chatId: String(m.chat_id),
        text: String(m.text).trim(),
        at: isoDate(m.timestamp) ?? String(m.timestamp ?? ''),
        fromMe: m.is_sender === 1 || m.is_sender === true,
        senderId: typeof m.sender_id === 'string' ? m.sender_id : undefined,
        counterpart: { providerId: c.providerId!, name: c.name },
      };
    });
  const latest = raw
    .map((m) => isoDate(m.timestamp))
    .filter((t): t is string => !!t)
    .sort()
    .at(-1);
  return {
    messages,
    latest: latest ?? null,
    more: !!cursor,
    cursor: cursor ?? null,
    complete: unattributed === 0,
    unattributed,
  };
}

// ---- LinkedIn activity: 1:1 chat history and post engagement, with signed cursors ------------------------------

/** A cursor Orbit hands out for a multi-call read: its state, signed for this account so it cannot be forged. */
async function sealCursor(deps: ConnectorDeps, accountId: string, state: unknown): Promise<string> {
  const payload = base64(new TextEncoder().encode(JSON.stringify(state)))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const sig = await accountToken(`cursor:${accountId}:${payload}`, deps.signingKey!);
  return `${payload}.${sig}`;
}

/** The state inside a cursor this server sealed for this account, or undefined when it is not one. */
async function openCursor<T>(
  deps: ConnectorDeps,
  accountId: string,
  cursor: unknown,
): Promise<T | undefined> {
  if (typeof cursor !== 'string' || !deps.signingKey) return undefined;
  const dot = cursor.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const payload = cursor.slice(0, dot);
  if (!(await tokenValid(`cursor:${accountId}:${payload}`, cursor.slice(dot + 1), deps.signingKey)))
    return undefined;
  try {
    const bin = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)))) as T;
  } catch {
    return undefined;
  }
}

/** A short piece of a message or comment: enough to recognise it, never the whole text. */
export const SNIPPET_MAX = 140;
const snippet = (v: unknown) =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX) : '';

/** Chats per page of the chat list, and Unipile requests per /chats/history call (the rest continue by cursor). */
export const HISTORY_CHATS_PAGE = 40;
export const HISTORY_UPSTREAM_PER_CALL = 24;

interface HistoryState {
  /** only messages after this (ISO); none reads the whole history */
  a?: string;
  /** the chat list's next page: undefined before the first page, null once every page is read */
  c?: string | null;
  /** chats from the current page still to read: id, the other person's member id, their name, a message cursor */
  q: { id: string; m: string; n?: string; k?: string }[];
}

/**
 * The student's 1:1 LinkedIn chats and their messages, the whole history or since `after`: per chat the other
 * person's member id and, per message, its id, time, direction and a short snippet. Groups, channels, ads, events
 * and hidden or deleted messages are left out. One call makes at most HISTORY_UPSTREAM_PER_CALL requests to Unipile
 * (whose chats and messages are synced on its side, so reading them costs LinkedIn nothing); `cursor` continues the
 * read and is null once everything was read. A chat cut off mid-way comes back in the next call with its remaining
 * messages. `latest` is the newest message time in this call.
 */
async function unipileChatHistory(deps: ConnectorDeps, body: Record<string, unknown>, doFetch: typeof fetch) {
  const accountId = String(body.accountId ?? '');
  let st: HistoryState;
  if (body.cursor) {
    const open = await openCursor<HistoryState>(deps, accountId, body.cursor);
    if (!open || !Array.isArray(open.q))
      return { ok: false, reason: 'bad_cursor', message: 'That read cannot be continued. Start it again.' };
    st = open;
  } else {
    const parsed = typeof body.after === 'string' ? new Date(body.after) : undefined;
    st = { q: [], ...(parsed && !Number.isNaN(parsed.getTime()) ? { a: parsed.toISOString() } : {}) };
  }
  const out = new Map<
    string,
    {
      chatId: string;
      memberId: string;
      name?: string;
      messages: { id: string; at: string; out: boolean; text: string }[];
    }
  >();
  let latest: string | undefined;
  let groups = 0;
  let budget = HISTORY_UPSTREAM_PER_CALL;
  while (budget > 0) {
    if (!st.q.length) {
      if (st.c === null) break;
      const q = new URLSearchParams({
        account_id: accountId,
        account_type: 'LINKEDIN',
        limit: String(HISTORY_CHATS_PAGE),
      });
      if (st.c) q.set('cursor', st.c);
      else if (st.a) q.set('after', st.a);
      budget--;
      const res = await doFetch(`${deps.unipileBase}/api/v1/chats?${q}`, { headers: uHeaders(deps) });
      if (!res.ok) throw new Error(`unipile ${res.status}`);
      const b = (await res.json()) as { items?: Record<string, unknown>[]; cursor?: string | null };
      st.c = typeof b.cursor === 'string' && b.cursor ? b.cursor : null;
      for (const c of b.items ?? []) {
        const one = typeof c.id === 'string' ? oneToOne(c) : undefined;
        if (!one) {
          groups++;
          continue;
        }
        st.q.push({ id: c.id as string, m: one.providerId, ...(one.name ? { n: one.name } : {}) });
      }
      continue;
    }
    const chat = st.q[0]!;
    const q = new URLSearchParams({ limit: '250' });
    if (chat.k) q.set('cursor', chat.k);
    else if (st.a) q.set('after', st.a);
    budget--;
    const res = await doFetch(
      `${deps.unipileBase}/api/v1/chats/${encodeURIComponent(chat.id)}/messages?${q}`,
      { headers: uHeaders(deps) },
    );
    if (res.status === 404) {
      // the chat is gone: nothing to read
      st.q.shift();
      continue;
    }
    if (!res.ok) throw new Error(`unipile ${res.status}`);
    const b = (await res.json()) as { items?: Record<string, unknown>[]; cursor?: string | null };
    const entry = out.get(chat.id) ?? {
      chatId: chat.id,
      memberId: chat.m,
      ...(chat.n ? { name: chat.n } : {}),
      messages: [],
    };
    for (const m of b.items ?? []) {
      const at = isoDate(m.timestamp);
      if (!at || !isWritten(m) || typeof m.id !== 'string') continue;
      if (!latest || at > latest) latest = at;
      entry.messages.push({
        id: m.id,
        at,
        out: m.is_sender === 1 || m.is_sender === true,
        text: snippet(m.text),
      });
    }
    out.set(chat.id, entry);
    chat.k = typeof b.cursor === 'string' && b.cursor ? b.cursor : undefined;
    if (!chat.k) st.q.shift();
  }
  const done = !st.q.length && st.c === null;
  return {
    chats: [...out.values()].filter((c) => c.messages.length),
    latest: latest ?? null,
    groups,
    cursor: done ? null : await sealCursor(deps, accountId, st),
  };
}

/** Posts of the student's whose comments and reactions are read: the most recent ones, one page. */
export const POSTS_MAX = 20;
/** Unipile requests per /posts/activity call; each is a LinkedIn read, so few. */
export const POSTS_UPSTREAM_PER_CALL = 8;
/** Without `commentsSince`, the student's own comments are read back this far. */
export const OWN_COMMENTS_DAYS = 365;

/**
 * A comment's date as Unipile gives it: ISO text, epoch time, or LinkedIn's relative form ("3d", "2w", "5mo",
 * "1yr", "4h", "now"), read against `now`. Undefined when it is none of those.
 */
export function postDate(v: unknown, now: Date): string | undefined {
  const exact = isoDate(v);
  if (exact) return exact;
  if (typeof v !== 'string') return undefined;
  const t = v.trim().toLowerCase();
  if (t === 'now' || t === 'just now') return now.toISOString();
  const m = /^(\d+)\s*(s|sec|m|min|h|hr|d|w|wk|mo|y|yr)s?(?:\s+ago)?$/.exec(t);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = { s: 1e3, sec: 1e3, m: 6e4, min: 6e4, h: 36e5, hr: 36e5, d: 864e5, w: 6048e5, wk: 6048e5 }[
    m[2] as 's'
  ];
  const d = new Date(now);
  if (unit) d.setTime(d.getTime() - n * unit);
  else if (m[2] === 'mo') d.setUTCMonth(d.getUTCMonth() - n);
  else d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString();
}

/** A post id `GET /posts/{id}` reads: an activity URN becomes its number, other URNs stay as they are. */
function postLookupId(v: string): string {
  const m = /^urn:li:activity:(\d+)$/.exec(v);
  return m ? m[1]! : v;
}

interface PostTask {
  /** comments ('c') or reactions ('r') on one of the student's posts, or who wrote a post the student commented on ('a') */
  t: 'c' | 'r' | 'a';
  /** the post: its social id (c, r) or the id to look it up by (a) */
  s: string;
  /** the post's time (c, r), the fallback date for what is on it */
  at?: string;
  /** the post's counters when it was listed: "comments:reactions" */
  sig?: string;
  /** Unipile's cursor within the post */
  k?: string;
  /** a: the student's comments on that post */
  cm?: { id: string; at?: string; text: string }[];
}

interface PostState {
  /** the student's own member id */
  me: string;
  q: PostTask[];
  /** the student's own comments still to page through (undefined once done); `since` stops paging at older ones */
  own?: { k?: string; since?: string };
  /** the student's own posts (social ids), so a comment on one is not read as a comment on someone else's */
  mine: string[];
}

type PostItem = {
  kind: 'comment_in' | 'reaction_in' | 'comment_out';
  /** the other person's LinkedIn member id */
  memberId: string;
  at: string;
  /** stable per comment, or per post and person for a reaction */
  id: string;
  postId: string;
  text?: string;
};

/**
 * Engagement on LinkedIn posts: who commented on and reacted to the student's recent posts (POSTS_MAX, newest
 * first; a post whose counters match `seen[socialId]` was read before and is skipped), and the student's own comments
 * on other people's posts (back to `commentsSince`, else a year), each with the post author found by one lookup per
 * post.
 * Reactions carry no time on LinkedIn, so they take the post's. Replies under comments are not read. `cursor`
 * continues the read and is null once everything was read; `postsRead` are the posts finished in this call (with the
 * counters to pass as `seen` next time) and `ownDone` says the student's comments were read to the end.
 */
async function unipilePostActivity(
  deps: ConnectorDeps,
  body: Record<string, unknown>,
  doFetch: typeof fetch,
  now: Date,
) {
  const accountId = String(body.accountId ?? '');
  const acct = encodeURIComponent(accountId);
  const get = async (path: string) =>
    doFetch(`${deps.unipileBase}${path}${path.includes('?') ? '&' : '?'}account_id=${acct}`, {
      headers: uHeaders(deps),
    });
  let budget = POSTS_UPSTREAM_PER_CALL;
  let st: PostState;
  let olderPosts = false;
  /** posts whose comments and reactions were read to the end in this call, with the counters they were listed at */
  const finished = new Map<string, string>();
  if (body.cursor) {
    const open = await openCursor<PostState>(deps, accountId, body.cursor);
    if (!open || !Array.isArray(open.q) || !open.me)
      return { ok: false, reason: 'bad_cursor', message: 'That read cannot be continued. Start it again.' };
    st = open;
  } else {
    budget -= 2;
    const meRes = await get('/api/v1/users/me');
    if (!meRes.ok) throw new Error(`unipile ${meRes.status}`);
    const me = String(((await meRes.json()) as { provider_id?: unknown }).provider_id ?? '');
    if (!me) throw new Error('unipile gave no member id for the account');
    const postsRes = await get(`/api/v1/users/${encodeURIComponent(me)}/posts?limit=${POSTS_MAX}`);
    if (!postsRes.ok) throw new Error(`unipile ${postsRes.status}`);
    const pb = (await postsRes.json()) as { items?: Record<string, unknown>[]; cursor?: string | null };
    olderPosts = !!pb.cursor;
    const seen = body.seen && typeof body.seen === 'object' ? (body.seen as Record<string, unknown>) : {};
    // the student's own comments since the last read; the first read goes back a year
    const since =
      typeof body.commentsSince === 'string' && !Number.isNaN(Date.parse(body.commentsSince))
        ? new Date(body.commentsSince).toISOString()
        : new Date(now.getTime() - OWN_COMMENTS_DAYS * 86_400_000).toISOString();
    st = { me, q: [], mine: [], own: { since } };
    for (const p of pb.items ?? []) {
      const socialId = typeof p.social_id === 'string' ? p.social_id : undefined;
      if (!socialId) continue;
      st.mine.push(socialId);
      if (typeof p.id === 'string' || typeof p.id === 'number') st.mine.push(String(p.id));
      const comments = Number(p.comment_counter ?? 0) || 0;
      const reactions = Number(p.reaction_counter ?? 0) || 0;
      const sig = `${comments}:${reactions}`;
      if (seen[socialId] === sig) continue;
      const at = postDate(p.parsed_datetime, now) ?? postDate(p.date, now);
      if (comments > 0) st.q.push({ t: 'c', s: socialId, at, sig });
      if (reactions > 0) st.q.push({ t: 'r', s: socialId, at, sig });
      // nothing on it yet: read as it is
      if (!comments && !reactions) finished.set(socialId, sig);
    }
  }
  const items: PostItem[] = [];
  let ownDone = false;
  const finish = (task: PostTask) => {
    st.q.shift();
    if (task.t !== 'a' && task.sig) finished.set(task.s, task.sig);
  };
  while (budget > 0) {
    const task = st.q[0];
    if (!task) {
      if (!st.own) break;
      // the student's own comments, newest first, back to `since`
      budget--;
      const q = new URLSearchParams({ limit: '100' });
      if (st.own.k) q.set('cursor', st.own.k);
      const res = await get(`/api/v1/users/${encodeURIComponent(st.me)}/comments?${q}`);
      if (!res.ok) throw new Error(`unipile ${res.status}`);
      const b = (await res.json()) as { items?: Record<string, unknown>[]; cursor?: string | null };
      const byPost = new Map<string, PostTask>();
      let older = false;
      for (const c of b.items ?? []) {
        const at = postDate(c.date, now);
        if (st.own.since && at && at < st.own.since) {
          older = true;
          continue;
        }
        const post = [c.post_urn, c.post_id].find((x): x is string => typeof x === 'string' && !!x);
        if (
          !post ||
          typeof c.id !== 'string' ||
          st.mine.includes(post) ||
          st.mine.includes(postLookupId(post))
        )
          continue;
        const task = byPost.get(post) ?? { t: 'a' as const, s: post, cm: [] };
        task.cm!.push({ id: c.id, ...(at ? { at } : {}), text: snippet(c.text) });
        byPost.set(post, task);
      }
      st.q.push(...byPost.values());
      const next = typeof b.cursor === 'string' && b.cursor ? b.cursor : undefined;
      if (next && !older) st.own.k = next;
      else {
        st.own = undefined;
        ownDone = true;
      }
      continue;
    }
    budget--;
    if (task.t === 'a') {
      // who wrote the post the student commented on
      const res = await get(`/api/v1/posts/${encodeURIComponent(postLookupId(task.s))}`);
      st.q.shift();
      if (res.status === 404 || res.status === 422) continue;
      if (!res.ok) throw new Error(`unipile ${res.status}`);
      const p = (await res.json()) as { author?: Record<string, unknown>; parsed_datetime?: unknown };
      const author = typeof p.author?.id === 'string' ? p.author.id : '';
      if (!author || p.author?.is_company === true || author === st.me) continue;
      const postAt = postDate(p.parsed_datetime, now);
      for (const c of task.cm ?? []) {
        const at = c.at ?? postAt;
        if (!at) continue;
        items.push({ kind: 'comment_out', memberId: author, at, id: c.id, postId: task.s, text: c.text });
      }
      continue;
    }
    const q = new URLSearchParams({ limit: '100' });
    if (task.k) q.set('cursor', task.k);
    const path = `/api/v1/posts/${encodeURIComponent(task.s)}/${task.t === 'c' ? 'comments' : 'reactions'}?${q}`;
    const res = await get(path);
    if (res.status === 404) {
      finish(task);
      continue;
    }
    if (!res.ok) throw new Error(`unipile ${res.status}`);
    const b = (await res.json()) as {
      items?: Record<string, unknown>[];
      cursor?: string | null;
      paging?: { cursor?: string | null };
    };
    for (const it of b.items ?? []) {
      if (task.t === 'c') {
        const d = (it.author_details ?? {}) as Record<string, unknown>;
        const who = typeof d.id === 'string' ? d.id : '';
        if (!who || who === st.me || typeof it.id !== 'string') continue;
        const at = postDate(it.date, now) ?? task.at;
        if (!at) continue;
        items.push({
          kind: 'comment_in',
          memberId: who,
          at,
          id: it.id,
          postId: task.s,
          text: snippet(it.text),
        });
      } else {
        const a = (it.author ?? {}) as Record<string, unknown>;
        const who = typeof a.id === 'string' ? a.id : '';
        if (!who || who === st.me || String(a.type ?? '').toUpperCase() === 'COMPANY' || !task.at) continue;
        items.push({
          kind: 'reaction_in',
          memberId: who,
          at: task.at,
          id: `${task.s}:${who}`,
          postId: task.s,
        });
      }
    }
    const next = [b.paging?.cursor, b.cursor].find((x): x is string => typeof x === 'string' && !!x);
    if (next) task.k = next;
    else finish(task);
  }
  // a post is read once neither its comments nor its reactions are still waiting
  const postsRead = [...finished]
    .filter(([s]) => !st.q.some((t) => t.s === s && t.t !== 'a'))
    .map(([socialId, seen]) => ({ socialId, seen }));
  const done = !st.q.length && !st.own;
  return {
    ok: true,
    items,
    postsRead,
    ownDone,
    olderPosts,
    cursor: done ? null : await sealCursor(deps, accountId, st),
  };
}

/** The first LinkedIn search-parameter id for a name ("Goldman Sachs" -> its company id), if LinkedIn knows it. */
async function searchParameterId(
  deps: ConnectorDeps,
  accountId: string,
  type: 'COMPANY' | 'SCHOOL' | 'LOCATION',
  keywords: string,
  doFetch: typeof fetch,
): Promise<string | undefined> {
  const q = new URLSearchParams({ account_id: accountId, type, keywords, limit: '1' });
  const res = await doFetch(`${deps.unipileBase}/api/v1/linkedin/search/parameters?${q}`, {
    headers: uHeaders(deps),
  });
  if (!res.ok) return undefined;
  const b = (await res.json()) as { items?: { id?: string | number }[] };
  const id = b.items?.[0]?.id;
  return id === undefined || id === null || id === '' ? undefined : String(id);
}

const text = (v: unknown, max = 120) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

/**
 * A LinkedIn people search (classic) from the student's account: keywords and a title as written, and a company,
 * school and location by name (each turned into LinkedIn's id first; a name LinkedIn does not know becomes a
 * keyword instead). By default it looks past the student's own connections (2nd and 3rd degree).
 */
async function unipileSearch(deps: ConnectorDeps, body: Record<string, unknown>, doFetch: typeof fetch) {
  const accountId = String(body.accountId ?? '');
  const keywords = [text(body.keywords, 200)];
  const company = text(body.company);
  const school = text(body.school);
  const location = text(body.location);
  const title = text(body.title);
  const distance = Array.isArray(body.distance)
    ? [...new Set(body.distance.map(Number).filter((n) => n === 1 || n === 2 || n === 3))]
    : [];
  const search: Record<string, unknown> = {
    api: 'classic',
    category: 'people',
    network_distance: distance.length ? distance : [2, 3],
  };
  const advanced: Record<string, string> = {};
  if (title) advanced.title = title;
  if (company) {
    const id = await searchParameterId(deps, accountId, 'COMPANY', company, doFetch);
    if (id) search.company = [id];
    else advanced.company = company;
  }
  if (school) {
    const id = await searchParameterId(deps, accountId, 'SCHOOL', school, doFetch);
    if (id) search.school = [id];
    else advanced.school = school;
  }
  if (location) {
    const id = await searchParameterId(deps, accountId, 'LOCATION', location, doFetch);
    if (id) search.location = [id];
    else keywords.push(location);
  }
  const kw = keywords.filter(Boolean).join(' ');
  if (kw) search.keywords = kw;
  if (Object.keys(advanced).length) search.advanced_keywords = advanced;
  if (!kw && !Object.keys(advanced).length && !search.company && !search.school && !search.location)
    return {
      ok: false,
      reason: 'bad_request',
      message: 'Say who to look for: a role, company, school or name.',
    };
  const q = new URLSearchParams({ account_id: accountId, limit: '10' });
  if (typeof body.cursor === 'string' && body.cursor) q.set('cursor', body.cursor);
  const res = await doFetch(`${deps.unipileBase}/api/v1/linkedin/search?${q}`, {
    method: 'POST',
    headers: uHeaders(deps),
    body: JSON.stringify(search),
  });
  if (res.status >= 400 && res.status < 500)
    return { ok: false, reason: 'refused', message: await unipileError(res) };
  if (!res.ok) throw new Error(`unipile ${res.status}`);
  const b = (await res.json()) as {
    items?: Record<string, unknown>[];
    cursor?: string | null;
    paging?: { total_count?: number };
  };
  const degree = (d: unknown) => {
    const m = /(\d)/.exec(String(d ?? ''));
    return m ? Number(m[1]) : undefined;
  };
  return {
    ok: true,
    people: (b.items ?? [])
      .filter((p) => typeof p.name === 'string' && p.name.trim() && p.id)
      .map((p) => ({
        memberId: String(p.id),
        name: String(p.name).trim(),
        headline: text(p.headline, 220),
        location: text(p.location),
        profileUrl: text(p.public_profile_url, 300) ?? text(p.profile_url, 300),
        distance: degree(p.network_distance),
        // how many connections the student shares with them (LinkedIn's count, when it gives one)
        mutualCount: [p.shared_connections_count, p.mutual_connections_count].find(
          (n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0,
        ),
        // LinkedIn's own photo link (it expires after a few weeks, so it is for showing, not keeping)
        pictureUrl: [p.profile_picture_url, p.profile_picture_url_large]
          .map((u) => text(u, 1000))
          .find((u): u is string => !!u && isLinkedInImage(u)),
      })),
    cursor: b.cursor ?? null,
    total: typeof b.paging?.total_count === 'number' ? b.paging.total_count : undefined,
  };
}

// ---- Enrichment (plan 17 E): a person's full LinkedIn profile, a company's page, optional web lookups -----------
//
// Unipile shapes, checked against its API reference and its official SDK (unipile-node-sdk 1.9.3, ISC licence):
//   GET /api/v1/users/{provider_id | public_identifier}?account_id=…&linkedin_sections=experience,education,about
//     -> work_experience[] {position, company, company_id, company_url, company_picture_url, current, start, end},
//        education[] {school, school_id, school_picture_url, degree, field_of_study, start, end}, summary,
//        contact_info {emails, phones} (1st-degree connections), throttled_sections[], network_distance,
//        profile_picture_url(_large). The SDK joins several sections with commas, as here.
//   GET /api/v1/linkedin/company/{id | public_identifier | urn}?account_id=… -> {id, name, public_identifier, logo,
//     website, industry[]}
// Payloads back to the browser are trimmed to what Orbit keeps.

/** What enrichment needs from the deployment: daily budgets, and the optional web and people-data keys. */
export interface EnrichmentDeps {
  /** full profile reads per LinkedIn account per day (LinkedIn notices heavy profile viewing) */
  profilesPerDay?: number;
  /** company page reads per LinkedIn account per day */
  companiesPerDay?: number;
  /** photo link reads (the plain profile, no sections) per LinkedIn account per day */
  photosPerDay?: number;
  /** web lookups per visitor per day */
  webPerDay?: number;
  /** Exa (search plus page text); without it /web answers "unconfigured" */
  exaKey?: string;
  exaBase?: string;
  /** keys Orbit reports as set up or not (/providers); no route uses them yet */
  firecrawlKey?: string;
  apolloKey?: string;
  pdlKey?: string;
}

const ENRICH_ROUTES = new Set(['/profile', '/company', '/photo', '/web', '/providers']);

/** The sections a profile read may ask for: full ones, and the lighter previews for what matters less. */
export const PROFILE_SECTIONS = new Set([
  'experience',
  'education',
  'about',
  'skills',
  'languages',
  'certifications',
  'experience_preview',
  'education_preview',
  'skills_preview',
  'languages_preview',
  'certifications_preview',
  '*_preview',
]);

/** Which providers this deployment has keys for, so the app can say "not set up" instead of failing. */
export function providerStatus(deps: ConnectorDeps) {
  const e = deps.enrichment ?? {};
  return {
    linkedin: !!deps.unipileKey && !!deps.unipileBase,
    exa: !!e.exaKey,
    firecrawl: !!e.firecrawlKey,
    apollo: !!e.apolloKey,
    peopleDataLabs: !!e.pdlKey,
  };
}

/** Today's bucket for one kind of enrichment call, per LinkedIn account (or per visitor, for web lookups). */
export function enrichBucket(
  kind: 'profile' | 'company' | 'photo' | 'web',
  who: string,
  now: Date,
  perDay: number,
): Bucket {
  const b = sendBucket(who, now, perDay);
  return { ...b, key: b.key.replace('connectors:send:', `connectors:${kind}:`) };
}

async function enrichmentRoute(
  deps: ConnectorDeps,
  path: string,
  body: Record<string, unknown>,
  ctx: {
    h: Record<string, string>;
    doFetch: typeof fetch;
    take: Take;
    now: () => Date;
    visitor: string;
  },
): Promise<Response> {
  const { h, doFetch, take, now } = ctx;
  const e = deps.enrichment ?? {};
  const kind =
    path === '/profile' ? 'profile' : path === '/company' ? 'company' : path === '/photo' ? 'photo' : 'web';
  if (kind === 'web') {
    if (!e.exaKey) return unconfigured(h);
  } else {
    if (!deps.unipileKey || !deps.unipileBase) return unconfigured(h);
    if (!(await tokenValid(String(body.accountId ?? ''), body.token, deps.signingKey)))
      return json(403, { error: 'this LinkedIn account is not linked to this browser' }, h);
  }
  const perDay =
    kind === 'profile'
      ? (e.profilesPerDay ?? 80)
      : kind === 'company'
        ? (e.companiesPerDay ?? 80)
        : kind === 'photo'
          ? (e.photosPerDay ?? 300)
          : (e.webPerDay ?? 30);
  const who = kind === 'web' ? `visitor:${ctx.visitor}` : String(body.accountId);
  let verdict: { allowed: boolean };
  try {
    verdict = await take([enrichBucket(kind, who, now(), perDay)]);
  } catch {
    return json(503, { error: 'unavailable right now' }, h);
  }
  if (!verdict.allowed)
    return json(
      200,
      {
        ok: false,
        reason: 'limit',
        message:
          kind === 'web'
            ? 'Orbit has looked up as many people on the web as it allows today.'
            : kind === 'photo'
              ? 'Orbit has fetched as many LinkedIn photos as it allows today. It carries on tomorrow.'
              : 'Orbit has read as many LinkedIn profiles as it allows today. It carries on tomorrow.',
      },
      h,
    );
  try {
    if (kind === 'profile') return json(200, await unipileProfile(deps, body, doFetch), h);
    if (kind === 'company') return json(200, await unipileCompany(deps, body, doFetch), h);
    if (kind === 'photo') return json(200, await unipilePhoto(deps, body, doFetch), h);
    return json(200, await exaSearch(e, body, doFetch), h);
  } catch (err) {
    return json(502, { error: err instanceof Error ? err.message : 'upstream error' }, h);
  }
}

/** A LinkedIn date as text: "2021-06", "6/2021", or an object {year, month, day}. */
function dateText(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 40);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (v && typeof v === 'object') {
    const d = v as { year?: unknown; month?: unknown; day?: unknown };
    const y = Number(d.year);
    if (!Number.isFinite(y) || y < 1900) return undefined;
    const m = Number(d.month);
    const day = Number(d.day);
    const pad = (n: number) => String(n).padStart(2, '0');
    return m >= 1 && m <= 12 ? `${y}-${pad(m)}${day >= 1 && day <= 31 ? `-${pad(day)}` : ''}` : String(y);
  }
  return undefined;
}

const licdn = (v: unknown) => {
  const u = text(v, 1000);
  return u && isLinkedInImage(u) ? u : undefined;
};

/** "https://www.linkedin.com/company/enactus-berkeley/" -> "enactus-berkeley" (numeric ids are not slugs). */
export function companySlugFromUrl(url: unknown): string | undefined {
  const m = /linkedin\.com\/(?:company|school)\/([^/?#]+)/i.exec(typeof url === 'string' ? url : '');
  const slug = m?.[1] ? decodeURIComponent(m[1]).toLowerCase() : undefined;
  return slug && !/^\d+$/.test(slug) ? slug : undefined;
}

/** One LinkedIn profile, trimmed to what Orbit keeps: identity, current and past positions, schools, contact. */
export function mapProfile(p: Record<string, unknown>) {
  const str = (v: unknown, max = 200) => text(v, max);
  const degree = String(p.network_distance ?? '');
  const distance = /FIRST|DISTANCE_1/.test(degree)
    ? 1
    : /SECOND|DISTANCE_2/.test(degree)
      ? 2
      : /THIRD|DISTANCE_3/.test(degree)
        ? 3
        : undefined;
  const list = (v: unknown) =>
    (Array.isArray(v) ? v : []).filter(
      (x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x),
    );
  const contact = (p.contact_info ?? {}) as { emails?: unknown; phones?: unknown };
  const strings = (v: unknown, max: number) =>
    (Array.isArray(v) ? v : [])
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter(Boolean)
      .slice(0, max);
  const emails = strings(contact.emails, 5).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
  const phones = strings(contact.phones, 5).filter((x) => /\d{6,}/.test(x.replace(/\D/g, '')));
  return {
    providerId: str(p.provider_id),
    publicIdentifier: str(p.public_identifier),
    firstName: str(p.first_name),
    lastName: str(p.last_name),
    headline: str(p.headline, 220),
    location: str(p.location, 120),
    about: str(p.summary, 600),
    pictureUrl: licdn(p.profile_picture_url_large) ?? licdn(p.profile_picture_url),
    distance,
    experience: list(p.work_experience)
      .slice(0, 20)
      .map((x) => ({
        title: str(x.position, 160),
        company: str(x.company, 160),
        companyId: str(x.company_id, 60),
        companySlug: companySlugFromUrl(x.company_url),
        logoUrl: licdn(x.company_picture_url),
        location: str(x.location, 120),
        current: x.current === true || (x.current !== false && !dateText(x.end)),
        start: dateText(x.start),
        end: dateText(x.end),
      }))
      .filter((x) => x.company || x.title),
    education: list(p.education)
      .slice(0, 10)
      .map((x) => ({
        school: str(x.school, 160),
        schoolId: str(x.school_id, 60),
        logoUrl: licdn(x.school_picture_url),
        degree: str(x.degree, 120),
        field: str(x.field_of_study, 120),
        start: dateText(x.start),
        end: dateText(x.end),
      }))
      .filter((x) => x.school),
    contact: emails.length || phones.length ? { emails, phones } : undefined,
    throttled: strings(p.throttled_sections, 12),
  };
}

/**
 * A person's full LinkedIn profile from the student's account, by their member id or public profile name, with the
 * sections asked for (only the known ones). Not found, throttled and refused come back as reasons, not errors.
 */
async function unipileProfile(deps: ConnectorDeps, body: Record<string, unknown>, doFetch: typeof fetch) {
  const accountId = String(body.accountId ?? '');
  const identifier = text(body.identifier, 200);
  if (!identifier) return { ok: false, reason: 'bad_request', message: 'Say whose profile to read.' };
  const sections = (Array.isArray(body.sections) ? body.sections : [])
    .map(String)
    .filter((x) => PROFILE_SECTIONS.has(x));
  const q = new URLSearchParams({ account_id: accountId });
  if (sections.length) q.set('linkedin_sections', [...new Set(sections)].join(','));
  const res = await doFetch(`${deps.unipileBase}/api/v1/users/${encodeURIComponent(identifier)}?${q}`, {
    headers: uHeaders(deps),
  });
  const failed = await profileFailure(res);
  if (failed) return failed;
  return { ok: true, profile: mapProfile((await res.json()) as Record<string, unknown>) };
}

/** Why a profile read brought nothing back, as a reason the app knows; undefined when it succeeded. */
async function profileFailure(res: Response) {
  if (res.status === 404 || res.status === 422)
    return { ok: false, reason: 'not_found', message: 'LinkedIn could not find that profile.' };
  if (res.status === 429)
    return {
      ok: false,
      reason: 'throttled',
      message: 'LinkedIn asked Orbit to slow down. It carries on later.',
    };
  if (res.status >= 400 && res.status < 500)
    return { ok: false, reason: 'refused', message: await unipileError(res) };
  if (!res.ok) throw new Error(`unipile ${res.status}`);
  return undefined;
}

/**
 * Someone's LinkedIn photo link, and who they are on LinkedIn, from the plain profile with no sections: the lightest
 * read there is. It is how people added from a search, an export or a typed-in link get their picture, and how an
 * expired link gets a fresh one (engine/photoQueue.ts). The link comes back, not the image: the browser loads it.
 */
async function unipilePhoto(deps: ConnectorDeps, body: Record<string, unknown>, doFetch: typeof fetch) {
  const accountId = String(body.accountId ?? '');
  const identifier = text(body.identifier, 200);
  if (!identifier) return { ok: false, reason: 'bad_request', message: 'Say whose photo to fetch.' };
  const q = new URLSearchParams({ account_id: accountId });
  const res = await doFetch(`${deps.unipileBase}/api/v1/users/${encodeURIComponent(identifier)}?${q}`, {
    headers: uHeaders(deps),
  });
  const failed = await profileFailure(res);
  if (failed) return failed;
  const p = (await res.json()) as Record<string, unknown>;
  return {
    ok: true,
    photo: {
      pictureUrl: licdn(p.profile_picture_url_large) ?? licdn(p.profile_picture_url),
      providerId: text(p.provider_id, 200),
      publicIdentifier: text(p.public_identifier, 200),
    },
  };
}

/** A company's LinkedIn page, by LinkedIn's id or its public name: its name, public name, logo and website. */
async function unipileCompany(deps: ConnectorDeps, body: Record<string, unknown>, doFetch: typeof fetch) {
  const accountId = String(body.accountId ?? '');
  const identifier = text(body.identifier, 200);
  if (!identifier) return { ok: false, reason: 'bad_request', message: 'Say which company to read.' };
  const q = new URLSearchParams({ account_id: accountId });
  const res = await doFetch(
    `${deps.unipileBase}/api/v1/linkedin/company/${encodeURIComponent(identifier)}?${q}`,
    { headers: uHeaders(deps) },
  );
  if (res.status === 404 || res.status === 422)
    return { ok: false, reason: 'not_found', message: 'LinkedIn could not find that company.' };
  if (res.status === 429)
    return {
      ok: false,
      reason: 'throttled',
      message: 'LinkedIn asked Orbit to slow down. It carries on later.',
    };
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
 * A web search for one person (Exa: POST /search with the page text): their name in quotes plus a company or school
 * to tell namesakes apart. Results are links with a short excerpt; the browser decides what is surely them.
 */
async function exaSearch(e: EnrichmentDeps, body: Record<string, unknown>, doFetch: typeof fetch) {
  const name = text(body.name, 120);
  if (!name) return { ok: false, reason: 'bad_request', message: 'Say who to look up.' };
  const query = [`"${name.replace(/"/g, '')}"`, text(body.company), text(body.school)]
    .filter(Boolean)
    .join(' ');
  const res = await doFetch(`${(e.exaBase ?? 'https://api.exa.ai').replace(/\/+$/, '')}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': e.exaKey! },
    body: JSON.stringify({ query, type: 'auto', numResults: 6, contents: { text: { maxCharacters: 600 } } }),
  });
  if (res.status >= 400 && res.status < 500)
    return { ok: false, reason: 'refused', message: `The web search refused it (${res.status}).` };
  if (!res.ok) throw new Error(`exa ${res.status}`);
  const b = (await res.json()) as { results?: Record<string, unknown>[] };
  return {
    ok: true,
    results: (b.results ?? [])
      .filter((r) => typeof r.url === 'string' && /^https:\/\//.test(r.url))
      .slice(0, 6)
      .map((r) => ({
        url: String(r.url).slice(0, 300),
        title: text(r.title, 200),
        snippet: text(r.text, 600),
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
