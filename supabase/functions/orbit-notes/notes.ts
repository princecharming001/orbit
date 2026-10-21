/**
 * orbit-notes: a thin proxy for the student's own meeting-notes and scheduling apps, so the browser can reach APIs
 * that do not allow it directly.
 *
 * - POST /fathom/meetings {apiKey, createdAfter?, cursor?}: the student's recorded meetings from Fathom, each with its
 *   guest list, AI summary and action items, trimmed to what Orbit files as a note.
 * - POST /calcom/event-types {apiKey}: the student's Cal.com username and event types, each with its booking link.
 *
 * The key comes from the student's browser with each call and is only forwarded: it is never stored, logged or sent
 * anywhere else. Calls come only from Orbit's own origins and are counted per visitor (hashed IP) like the other
 * proxies. Kept free of Deno APIs so it runs under Node tests.
 */
import { clientIp, defaultOrigins } from '../_shared/origins.ts';

export { clientIp, defaultOrigins };

export const FATHOM_BASE = 'https://api.fathom.ai/external/v1';
export const CALCOM_BASE = 'https://api.cal.com/v2';
/** the Cal.com API version event types are pinned to (GET /v2/me takes none) */
export const CALCOM_EVENT_TYPES_VERSION = '2026-06-12';
/** a summary longer than this is cut: a note is for reading, not an archive of the call */
export const SUMMARY_MAX = 20_000;

export interface Limits {
  perMinute: number;
  perDay: number;
}
export const DEFAULT_LIMITS: Limits = { perMinute: 30, perDay: 400 };

export interface Bucket {
  key: string;
  limit: number;
  expires: string;
}
export type Take = (buckets: Bucket[]) => Promise<{ allowed: boolean; over?: string }>;

/** An app's OAuth client, registered by Orbit; the secret lives only in the function's settings. */
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface NotesDeps {
  origins: (origin: string) => boolean;
  take: Take;
  fetch?: typeof fetch;
  now?: () => Date;
  salt?: string;
  limits?: Limits;
  /** "Connect with Cal.com" and "Connect with Fathom": on once each app's client is set */
  oauth?: { calcom?: OAuthClient; fathom?: OAuthClient };
}

export const CALCOM_AUTHORIZE = 'https://app.cal.com/auth/oauth2/authorize';
export const CALCOM_TOKEN = 'https://api.cal.com/v2/auth/oauth2/token';
/** what Orbit asks Cal.com for: the event types and the username for their links */
export const CALCOM_SCOPES = 'EVENT_TYPE_READ PROFILE_READ';
export const FATHOM_AUTHORIZE = 'https://fathom.video/external/v1/oauth2/authorize';
export const FATHOM_TOKEN = 'https://api.fathom.ai/external/v1/oauth2/token';
export const FATHOM_SCOPES = 'public_api';

/** A Fathom meeting, as Orbit files it. */
export interface FathomMeeting {
  id: string;
  title: string;
  url?: string;
  startAt?: string;
  invitees: { name?: string; email?: string; external?: boolean }[];
  recordedBy?: string;
  summary?: string;
  actionItems: { text: string; done: boolean; assignee?: string }[];
}

export interface CalEventType {
  id: number | string;
  title: string;
  slug: string;
  minutes?: number;
  hidden: boolean;
  url: string;
}

type Result<T> =
  | ({ ok: true } & T)
  | { ok: false; reason: 'bad_key' | 'refused' | 'upstream'; message: string };

function cors(origin: string | null, allowed: boolean): Record<string, string> {
  if (!origin || !allowed) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': 'x-orbit-limit, retry-after',
    Vary: 'Origin',
  };
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
}

export function buckets(visitor: string, now: Date, limits: Limits): Bucket[] {
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const minute = iso.slice(0, 16);
  const endOfDay = new Date(`${day}T00:00:00Z`);
  endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);
  const endOfMinute = new Date(`${minute}:00Z`);
  endOfMinute.setUTCMinutes(endOfMinute.getUTCMinutes() + 1);
  return [
    { key: `notes:min:${minute}:${visitor}`, limit: limits.perMinute, expires: endOfMinute.toISOString() },
    { key: `notes:day:${day}:${visitor}`, limit: limits.perDay, expires: endOfDay.toISOString() },
  ];
}

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

/** The shared counter store (orbit_proxy_take) over PostgREST with the service role key. */
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

/** How a call reaches the app: the student's own key, or the access token from signing in. */
type AppAuth = { apiKey: string } | { accessToken: string };

function authOf(body: Record<string, unknown>): AppAuth | undefined {
  if (validKey(body.accessToken)) return { accessToken: String(body.accessToken).trim() };
  if (validKey(body.apiKey)) return { apiKey: String(body.apiKey).trim() };
  return undefined;
}

/** A key the student pasted: a plain token, no spaces, of a sane length. */
export function validKey(k: unknown): k is string {
  return typeof k === 'string' && /^[A-Za-z0-9._\-~+/=]{10,4000}$/.test(k.trim());
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** One Fathom meeting from the API, trimmed to what a note needs. */
export function mapFathomMeeting(m: Record<string, unknown>): FathomMeeting | undefined {
  const id =
    str(m.recording_id) ?? (m.recording_id != null ? String(m.recording_id) : undefined) ?? str(m.url);
  if (!id) return undefined;
  const invitees = Array.isArray(m.calendar_invitees) ? m.calendar_invitees : [];
  const summary = (m.default_summary as { markdown_formatted?: unknown } | null | undefined)
    ?.markdown_formatted;
  const items = Array.isArray(m.action_items) ? m.action_items : [];
  return {
    id,
    title: str(m.meeting_title) ?? str(m.title) ?? 'Meeting',
    url: str(m.share_url) ?? str(m.url),
    startAt: str(m.recording_start_time) ?? str(m.scheduled_start_time) ?? str(m.created_at),
    invitees: invitees
      .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
      .map((i) => ({ name: str(i.name), email: str(i.email), external: i.is_external === true }))
      .filter((i) => i.name || i.email),
    recordedBy: str((m.recorded_by as { email?: unknown } | undefined)?.email),
    summary: typeof summary === 'string' && summary.trim() ? summary.trim().slice(0, SUMMARY_MAX) : undefined,
    actionItems: items
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && !!str(a.description))
      .map((a) => ({
        text: str(a.description)!,
        done: a.completed === true,
        assignee: str((a.assignee as { name?: unknown } | undefined)?.name) ?? str(a.assignee),
      })),
  };
}

async function fathomMeetings(
  body: Record<string, unknown>,
  doFetch: typeof fetch,
): Promise<Result<{ meetings: FathomMeeting[]; nextCursor: string | null }>> {
  const auth = authOf(body)!;
  const signedIn = 'accessToken' in auth;
  const headers: Record<string, string> = signedIn
    ? { Authorization: `Bearer ${auth.accessToken}`, accept: 'application/json' }
    : { 'X-Api-Key': auth.apiKey, accept: 'application/json' };
  const q = new URL(`${FATHOM_BASE}/meetings`);
  // a signed-in app may not ask for summaries with the list: it reads each recording's summary after
  if (!signedIn) q.searchParams.set('include_summary', 'true');
  q.searchParams.set('include_action_items', 'true');
  const after = str(body.createdAfter);
  if (after && !Number.isNaN(Date.parse(after)))
    q.searchParams.set('created_after', new Date(after).toISOString());
  const cursor = str(body.cursor);
  if (cursor) q.searchParams.set('cursor', cursor);
  const res = await doFetch(q.toString(), { headers });
  if (res.status === 401 || res.status === 403)
    return {
      ok: false,
      reason: 'bad_key',
      message: signedIn ? 'Fathom needs you to connect again.' : 'Fathom did not accept that API key.',
    };
  if (res.status >= 400 && res.status < 500)
    return { ok: false, reason: 'refused', message: `Fathom refused the request (${res.status}).` };
  if (!res.ok)
    return { ok: false, reason: 'upstream', message: `Fathom is not answering right now (${res.status}).` };
  const j = (await res.json()) as { items?: unknown[]; next_cursor?: unknown };
  const meetings = (j.items ?? [])
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .map(mapFathomMeeting)
    .filter((m): m is FathomMeeting => !!m);
  if (signedIn)
    for (const m of meetings) {
      if (m.summary) continue;
      try {
        const r = await doFetch(`${FATHOM_BASE}/recordings/${encodeURIComponent(m.id)}/summary`, { headers });
        if (!r.ok) continue;
        const sj = (await r.json()) as {
          summary?: { markdown_formatted?: unknown };
          markdown_formatted?: unknown;
        };
        const md = sj.summary?.markdown_formatted ?? sj.markdown_formatted;
        if (typeof md === 'string' && md.trim()) m.summary = md.trim().slice(0, SUMMARY_MAX);
      } catch {
        // a meeting without its summary still comes in, with its guests and action items
      }
    }
  return { ok: true, meetings, nextCursor: str(j.next_cursor) ?? null };
}

/** Which "Connect with …" buttons work: the public client ids, never a secret. */
export function oauthConfig(deps: NotesDeps): { calcom: string | null; fathom: string | null } {
  return { calcom: deps.oauth?.calcom?.clientId ?? null, fathom: deps.oauth?.fathom?.clientId ?? null };
}

/**
 * Trade a sign-in code for tokens, or refresh them, with the secret only this function holds. The redirect address
 * must be one of Orbit's own, so a code sent elsewhere is never exchanged here.
 */
async function oauthToken(
  deps: NotesDeps,
  body: Record<string, unknown>,
  doFetch: typeof fetch,
): Promise<Result<{ accessToken: string; refreshToken?: string; expiresIn?: number }>> {
  const provider = body.provider === 'calcom' ? 'calcom' : body.provider === 'fathom' ? 'fathom' : undefined;
  const client = provider ? deps.oauth?.[provider] : undefined;
  if (!provider || !client)
    return { ok: false, reason: 'refused', message: 'Signing in to this app is not set up yet.' };
  const params: Record<string, string> = { client_id: client.clientId, client_secret: client.clientSecret };
  if (body.grant === 'refresh') {
    const rt = str(body.refreshToken);
    if (!rt) return { ok: false, reason: 'refused', message: 'Nothing to refresh.' };
    Object.assign(params, { grant_type: 'refresh_token', refresh_token: rt });
  } else {
    const code = str(body.code);
    const redirect = str(body.redirectUri);
    let origin = '';
    try {
      origin = redirect ? new URL(redirect).origin : '';
    } catch {}
    if (!code || !redirect || !deps.origins(origin))
      return { ok: false, reason: 'refused', message: 'That sign-in did not come back to Orbit.' };
    Object.assign(params, { grant_type: 'authorization_code', code, redirect_uri: redirect });
  }
  const res = await doFetch(provider === 'calcom' ? CALCOM_TOKEN : FATHOM_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  if (res.status === 400 || res.status === 401)
    return { ok: false, reason: 'bad_key', message: 'The app needs you to connect again.' };
  if (!res.ok)
    return { ok: false, reason: 'upstream', message: `The app is not answering right now (${res.status}).` };
  const t = (await res.json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  const accessToken = str(t.access_token);
  if (!accessToken) return { ok: false, reason: 'upstream', message: 'The app gave no access.' };
  return {
    ok: true,
    accessToken,
    refreshToken: str(t.refresh_token),
    expiresIn: typeof t.expires_in === 'number' ? t.expires_in : undefined,
  };
}

/** The booking link for an event type: Cal.com's own when it gives one, else cal.com/{username}/{slug}. */
export function bookingUrl(username: string | undefined, e: Record<string, unknown>): string | undefined {
  const given = str(e.bookingUrl) ?? str(e.link);
  if (given && /^https?:\/\//.test(given)) return given;
  const slug = str(e.slug);
  if (!username || !slug) return undefined;
  return `https://cal.com/${encodeURIComponent(username)}/${encodeURIComponent(slug)}`;
}

export function mapEventType(
  username: string | undefined,
  e: Record<string, unknown>,
): CalEventType | undefined {
  const url = bookingUrl(username, e);
  const slug = str(e.slug);
  if (!url || !slug || e.id == null) return undefined;
  const minutes = Number(e.lengthInMinutes ?? e.length);
  return {
    id: e.id as number | string,
    title: str(e.title) ?? slug,
    slug,
    minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : undefined,
    hidden: e.hidden === true,
    url,
  };
}

async function calEventTypes(
  body: Record<string, unknown>,
  doFetch: typeof fetch,
): Promise<Result<{ username?: string; eventTypes: CalEventType[] }>> {
  const cred = authOf(body)!;
  const key = 'accessToken' in cred ? cred.accessToken : cred.apiKey;
  const auth = { Authorization: `Bearer ${key}`, accept: 'application/json' };
  const me = await doFetch(`${CALCOM_BASE}/me`, { headers: auth });
  if (me.status === 401 || me.status === 403)
    return {
      ok: false,
      reason: 'bad_key',
      message:
        'accessToken' in cred
          ? 'Cal.com needs you to connect again.'
          : 'Cal.com did not accept that API key.',
    };
  if (!me.ok)
    return { ok: false, reason: 'upstream', message: `Cal.com is not answering right now (${me.status}).` };
  const meBody = (await me.json()) as { data?: { username?: unknown } };
  const username = str(meBody.data?.username);
  const q = new URL(`${CALCOM_BASE}/event-types`);
  if (username) q.searchParams.set('username', username);
  const res = await doFetch(q.toString(), {
    headers: { ...auth, 'cal-api-version': CALCOM_EVENT_TYPES_VERSION },
  });
  if (res.status === 401 || res.status === 403)
    return { ok: false, reason: 'bad_key', message: 'Cal.com did not accept that API key.' };
  if (!res.ok)
    return { ok: false, reason: 'upstream', message: `Cal.com is not answering right now (${res.status}).` };
  const j = (await res.json()) as { data?: unknown };
  // v2 answers a list; an older shape nests it under eventTypeGroups
  const raw: unknown[] = Array.isArray(j.data)
    ? j.data
    : ((
        (j.data as { eventTypeGroups?: { eventTypes?: unknown[] }[] } | undefined)?.eventTypeGroups ?? []
      ).flatMap((g) => g.eventTypes ?? []) as unknown[]);
  const eventTypes = raw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => mapEventType(username, e))
    .filter((e): e is CalEventType => !!e);
  return { ok: true, username, eventTypes };
}

export function makeHandler(deps: NotesDeps): (req: Request) => Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
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
    const path = new URL(req.url).pathname.replace(/.*\/orbit-notes/, '') || '/';
    const routes = ['/fathom/meetings', '/calcom/event-types', '/oauth/config', '/oauth/token'];
    if (!routes.includes(path)) return json(404, { error: 'no such route' }, h);
    // which sign-ins are set up: public ids only, nothing to count
    if (path === '/oauth/config') return json(200, { ok: true, ...oauthConfig(deps) }, h);
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json(400, { error: 'the body must be JSON' }, h);
    }
    if (!body || typeof body !== 'object' || (path !== '/oauth/token' && !authOf(body)))
      return json(400, { error: 'an API key or a sign-in is needed' }, h);
    const visitor = (await sha256(`${deps.salt ?? 'orbit'}:${clientIp(req)}`)).slice(0, 32);
    let verdict: { allowed: boolean; over?: string };
    try {
      verdict = await deps.take(buckets(visitor, now(), limits));
    } catch {
      return json(503, { error: 'unavailable right now' }, h);
    }
    if (!verdict.allowed) {
      const minute = verdict.over?.includes(':min:') ?? false;
      return json(
        429,
        { error: minute ? 'too many requests, try again shortly' : "today's limit reached" },
        { ...h, 'x-orbit-limit': minute ? 'minute' : 'day', ...(minute ? { 'retry-after': '30' } : {}) },
      );
    }
    try {
      const out =
        path === '/oauth/token'
          ? await oauthToken(deps, body, doFetch)
          : path === '/fathom/meetings'
            ? await fathomMeetings(body, doFetch)
            : await calEventTypes(body, doFetch);
      return json(200, out, h);
    } catch {
      // never echo an upstream error: it could carry the key back
      return json(502, { ok: false, reason: 'upstream', message: 'Could not reach the app right now.' }, h);
    }
  };
}
