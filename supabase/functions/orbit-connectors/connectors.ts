/**
 * Orbit's connector proxy: Unipile (live LinkedIn: hosted connect, the student's connections, mutual connections,
 * unlinking) and Village (warm intro paths). Both third-party keys stay on the server here, never in the browser.
 * Only Orbit's own origins may call it, only the routes below, and each visitor (hashed IP) only so often. Kept free
 * of Deno APIs so it runs under Node tests.
 *
 * Routes (POST, JSON):
 *   /connect/start, /connect/status, /relations, /mutuals, /disconnect, /send,
 *   /inbox, /search                                                            -> Unipile
 *   /paths                                                                     -> Village
 *
 * A connected account's routes need the account token /connect/status handed out (an HMAC of the account id with
 * the server's signing key), so knowing someone's Unipile account id is not enough to read their connections or
 * send as them. /send sends one message the student approved: a direct message to a connection, or a connection
 * request with a note to anyone else, at most ORBIT_LINKEDIN_SENDS_PER_DAY (25) per account per day. /inbox reads
 * the account's recent LinkedIn messages (so replies reach the pipeline on their own) and /search runs a LinkedIn
 * people search beyond the student's own network, at most ORBIT_LINKEDIN_SEARCHES_PER_DAY (40) per account per day.
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
  /** the reference for a new hosted connect (tests pin it) */
  newRef?: () => string;
  /** signs account tokens (the service role key in production); without it account routes are refused */
  signingKey?: string;
  /** LinkedIn messages and requests one account may send per day */
  sendsPerDay?: number;
  /** LinkedIn people searches one account may run per day (LinkedIn throttles heavy searching) */
  searchesPerDay?: number;
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
    picture,
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
        network_distance: [1],
        connections_of: [target],
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
      // LinkedIn's own photo link, for showing (it expires after a few weeks)
      picture_url: [m.profile_picture_url, m.profile_picture_url_large].find(
        (u): u is string => typeof u === 'string' && isLinkedInImage(u),
      ),
    })),
  };
}

/** At most this many pages of 250 messages per inbox read, and this many chats looked up for who they are with. */
export const INBOX_MAX_PAGES = 4;
export const INBOX_MAX_CHATS = 40;
/** Without an `after`, the inbox reads back this far. */
const INBOX_DEFAULT_DAYS = 30;

/**
 * The account's LinkedIn messages since `after`, newest first as Unipile pages them, each with the person on the
 * other side of its 1:1 chat (looked up once per chat). Group chats, events and hidden or deleted messages are left
 * out. `latest` is the newest message time, the next read's `after`.
 */
async function unipileInbox(deps: ConnectorDeps, body: Record<string, unknown>, doFetch: typeof fetch) {
  const accountId = String(body.accountId ?? '');
  const parsed = typeof body.after === 'string' ? new Date(body.after) : undefined;
  const after =
    parsed && !Number.isNaN(parsed.getTime())
      ? parsed
      : new Date(Date.now() - INBOX_DEFAULT_DAYS * 86_400_000);
  const raw: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < INBOX_MAX_PAGES; page++) {
    const q = new URLSearchParams({ account_id: accountId, after: after.toISOString(), limit: '250' });
    if (cursor) q.set('cursor', cursor);
    const res = await doFetch(`${deps.unipileBase}/api/v1/messages?${q}`, { headers: uHeaders(deps) });
    if (!res.ok) throw new Error(`unipile ${res.status}`);
    const b = (await res.json()) as { items?: Record<string, unknown>[]; cursor?: string | null };
    raw.push(...(b.items ?? []));
    cursor = typeof b.cursor === 'string' && b.cursor ? b.cursor : undefined;
    if (!cursor) break;
  }
  const kept = raw.filter(
    (m) =>
      !m.hidden &&
      !m.deleted &&
      !m.is_event &&
      typeof m.chat_id === 'string' &&
      typeof m.text === 'string' &&
      m.text.trim(),
  );
  // who each chat is with: one lookup per chat, most recent chats first
  const chatIds = [...new Set(kept.map((m) => String(m.chat_id)))].slice(0, INBOX_MAX_CHATS);
  const chats = new Map<string, { providerId?: string; name?: string; group: boolean }>();
  for (const id of chatIds) {
    const res = await doFetch(`${deps.unipileBase}/api/v1/chats/${encodeURIComponent(id)}`, {
      headers: uHeaders(deps),
    });
    if (!res.ok) continue;
    const c = (await res.json()) as { attendee_provider_id?: string; name?: string; type?: number };
    chats.set(id, {
      providerId: c.attendee_provider_id || undefined,
      name: c.name || undefined,
      // 0 is a 1:1 chat; groups and channels are not one person's reply
      group: typeof c.type === 'number' && c.type !== 0,
    });
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
        at: String(m.timestamp ?? ''),
        fromMe: m.is_sender === 1 || m.is_sender === true,
        senderId: typeof m.sender_id === 'string' ? m.sender_id : undefined,
        counterpart: { providerId: c.providerId!, name: c.name },
      };
    });
  const latest = raw
    .map((m) => String(m.timestamp ?? ''))
    .filter((t) => !Number.isNaN(Date.parse(t)))
    .sort()
    .at(-1);
  return { messages, latest: latest ?? null, more: !!cursor };
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
