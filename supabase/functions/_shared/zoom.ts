/**
 * Zoom (a user-level "General app" on the Zoom App Marketplace): the student signs in with Zoom, and Orbit then reads
 * the transcript of a coffee chat held on Zoom (and Zoom's AI Companion summary, when the account has it) and makes
 * Zoom meetings for the calls it books.
 *
 * Keys: ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET (a function secret, else orbit_private.secrets through
 * public.orbit_secret), ZOOM_WEBHOOK_SECRET_TOKEN for the webhook. Until they exist every route says "not set up" and
 * nothing calls Zoom.
 *
 * Tokens: OAuth 2.0 with state and PKCE; the access and refresh tokens live in Vault (`zoom_access:<user>`,
 * `zoom_refresh:<user>`), the integration row keeps the refresh token's id in token_secret_id and the access token's
 * id and expiry in sync_state.zoom. Zoom hands out a new refresh token with every refresh, so it is written back each
 * time. A refused refresh (revoked, expired) marks the row needs_reauth and throws ZoomSignInNeeded.
 *
 * fetch and the clock are injectable for tests; nothing here runs against Zoom in tests.
 */
import {
  type CallEventRef,
  type CallNote,
  matchCallToEvent,
  vttToText,
  zoomSummaryText,
} from '@orbit/core/notes/callNotes';
import { timingSafeEqual } from './crypto.ts';
import type { Db } from './db.ts';
import { providerSecret } from './secrets.ts';
import type { Vault } from './vault.ts';

export const ZOOM_AUTHORIZE_URL = 'https://zoom.us/oauth/authorize';
export const ZOOM_TOKEN_URL = 'https://zoom.us/oauth/token';
export const ZOOM_REVOKE_URL = 'https://zoom.us/oauth/revoke';
export const ZOOM_API = 'https://api.zoom.us/v2';

/**
 * The granular scopes Orbit's Zoom app asks for (set on the app in the Marketplace; Zoom takes them from there):
 * who the student is, their cloud recordings and the files in them (the transcript), the AI Companion summary, and
 * making a meeting for a booked chat.
 */
export const ZOOM_SCOPES = [
  'user:read:user',
  'cloud_recording:read:list_user_recordings',
  'cloud_recording:read:list_recording_files',
  'cloud_recording:read:meeting_transcript',
  'meeting:read:summary',
  'meeting:write:meeting',
] as const;

/** What the student sees when Orbit's Zoom app keys are not stored yet. */
export const ZOOM_NOT_SET_UP = 'Zoom is not set up';

export const zoomAccessName = (userId: string) => `zoom_access:${userId}`;
export const zoomRefreshName = (userId: string) => `zoom_refresh:${userId}`;

export interface ZoomConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
}

/** The keys as the environment gave them at cold start (any of them may be missing). */
export interface ZoomEnv {
  clientId?: string;
  clientSecret?: string;
  /** where Zoom sends the student back; <functions>/orbit-api/zoom/callback when not set */
  redirectUri?: string;
}

/** The student must sign in with Zoom again (or never did). */
export class ZoomSignInNeeded extends Error {
  constructor() {
    super('zoom_sign_in_needed');
  }
}

export class ZoomTokenError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`zoom token ${status} ${code}`);
  }
}

// ---- keys ----------------------------------------------------------------------------------------------------------

let stored: { at: number; id?: string; secret?: string } | undefined;
const STORED_TTL_MS = 60_000;

/** Test hook: forget the keys read from orbit_private.secrets. */
export function resetZoomKeysForTests(): void {
  stored = undefined;
}

/**
 * Orbit's Zoom app keys: the environment's, else the copy in orbit_private.secrets (read at most once a minute, so a
 * key stored later is picked up without a redeploy). Undefined while either is missing.
 */
export async function zoomKeys(
  env: ZoomEnv | undefined,
  db: Db | undefined,
  now = Date.now(),
): Promise<{ clientId: string; clientSecret: string } | undefined> {
  if (env?.clientId && env.clientSecret) return { clientId: env.clientId, clientSecret: env.clientSecret };
  if (!stored || now - stored.at > STORED_TTL_MS) {
    const none = () => undefined;
    const [id, secret] = await Promise.all([
      providerSecret(none, db, 'ZOOM_CLIENT_ID'),
      providerSecret(none, db, 'ZOOM_CLIENT_SECRET'),
    ]);
    stored = { at: now, id, secret };
  }
  const clientId = env?.clientId || stored.id;
  const clientSecret = env?.clientSecret || stored.secret;
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

// ---- OAuth ---------------------------------------------------------------------------------------------------------

export function zoomAuthUrl(
  cfg: Pick<ZoomConfig, 'clientId' | 'redirectUri'>,
  p: { state: string; challenge: string },
): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
  });
  return `${ZOOM_AUTHORIZE_URL}?${q}`;
}

export interface ZoomTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

const basic = (cfg: Pick<ZoomConfig, 'clientId' | 'clientSecret'>) =>
  `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`;

async function tokenCall(cfg: ZoomConfig, form: Record<string, string>): Promise<ZoomTokenResponse> {
  const res = await (cfg.fetch ?? fetch)(ZOOM_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      authorization: basic(cfg),
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!res.ok) throw new ZoomTokenError(res.status, String(body.error ?? 'token_error'));
  if (typeof body.access_token !== 'string') throw new ZoomTokenError(502, 'no_access_token');
  return body as unknown as ZoomTokenResponse;
}

export function zoomExchangeCode(
  cfg: ZoomConfig,
  code: string,
  verifier: string,
): Promise<ZoomTokenResponse> {
  return tokenCall(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
  });
}

export function zoomRefreshToken(cfg: ZoomConfig, refreshToken: string): Promise<ZoomTokenResponse> {
  return tokenCall(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

/** Revokes a token at Zoom. True when Zoom accepted it; a failure is not fatal to disconnecting. */
export async function zoomRevoke(cfg: ZoomConfig, token: string): Promise<boolean> {
  try {
    const res = await (cfg.fetch ?? fetch)(ZOOM_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic(cfg) },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

export interface ZoomSyncState {
  email?: string;
  accessSecretId?: string;
  accessExpiresAt?: string;
  /** recordings Zoom said have a transcript ready (the webhook), newest last */
  ready?: { meetingId: string; uuid?: string; at: string }[];
}

export interface ZoomRow {
  status: string;
  zoomUserId: string | null;
  refreshSecretId: string | null;
  lastSyncedAt: string | null;
  state: ZoomSyncState;
}

export async function loadZoomRow(db: Db, userId: string): Promise<ZoomRow | undefined> {
  const [a] = await db.sql<{
    status: string;
    external_account_id: string | null;
    token_secret_id: string | null;
    last_synced_at: Date | string | null;
    zoom: ZoomSyncState | null;
  }>`
    select status, external_account_id, token_secret_id, last_synced_at, sync_state->'zoom' as zoom
      from orbit.integration_accounts where user_id = ${userId}::uuid and provider = 'zoom'`;
  if (!a) return undefined;
  return {
    status: a.status,
    zoomUserId: a.external_account_id,
    refreshSecretId: a.token_secret_id,
    lastSyncedAt: a.last_synced_at ? new Date(a.last_synced_at).toISOString() : null,
    state: a.zoom ?? {},
  };
}

export async function saveZoomState(db: Db, userId: string, patch: Partial<ZoomSyncState>): Promise<void> {
  await db.sql`
    update orbit.integration_accounts
       set sync_state = jsonb_set(coalesce(sync_state, '{}'::jsonb), '{zoom}',
                                  coalesce(sync_state->'zoom', '{}'::jsonb) || ${patch}::jsonb)
     where user_id = ${userId}::uuid and provider = 'zoom'`;
}

export async function storeZoomTokens(
  vault: Vault,
  userId: string,
  t: ZoomTokenResponse,
  now: Date,
): Promise<{ accessSecretId: string; refreshSecretId?: string; accessExpiresAt: string }> {
  const accessSecretId = await vault.put(zoomAccessName(userId), t.access_token);
  const refreshSecretId = t.refresh_token
    ? await vault.put(zoomRefreshName(userId), t.refresh_token)
    : undefined;
  const accessExpiresAt = new Date(now.getTime() + Math.max(60, t.expires_in ?? 3600) * 1000).toISOString();
  return { accessSecretId, refreshSecretId, accessExpiresAt };
}

export interface ZoomTokens {
  accessToken(): Promise<string>;
  /** after a 401: refresh now; a refused refresh marks the row needs_reauth and throws ZoomSignInNeeded */
  refreshed(): Promise<string>;
}

/** Access tokens for one student's Zoom account, from Vault, refreshed when they run out or Zoom says 401. */
export function zoomTokens(
  db: Db,
  vault: Vault,
  cfg: ZoomConfig,
  userId: string,
  now: () => Date = () => new Date(),
): ZoomTokens {
  let cached: string | undefined;
  const needsReauth = async (why: string) => {
    await db.sql`
      update orbit.integration_accounts set status = 'needs_reauth', last_error = ${why}
       where user_id = ${userId}::uuid and provider = 'zoom'`;
    return new ZoomSignInNeeded();
  };
  async function refresh(): Promise<string> {
    const row = await loadZoomRow(db, userId);
    if (!row?.refreshSecretId || row.status === 'revoked') throw new ZoomSignInNeeded();
    const refreshToken = await vault.get(row.refreshSecretId);
    if (!refreshToken) throw await needsReauth('no_refresh_token');
    let t: ZoomTokenResponse;
    try {
      t = await zoomRefreshToken(cfg, refreshToken);
    } catch (e) {
      // Zoom said no (invalid_grant: revoked, expired, used twice): only signing in again helps. A 5xx is passing.
      if (e instanceof ZoomTokenError && e.status >= 400 && e.status < 500)
        throw await needsReauth(`refresh_${e.code}`.slice(0, 80));
      throw e;
    }
    const s = await storeZoomTokens(vault, userId, t, now());
    if (s.refreshSecretId && s.refreshSecretId !== row.refreshSecretId)
      await db.sql`update orbit.integration_accounts set token_secret_id = ${s.refreshSecretId}::uuid
                    where user_id = ${userId}::uuid and provider = 'zoom'`;
    await saveZoomState(db, userId, { accessSecretId: s.accessSecretId, accessExpiresAt: s.accessExpiresAt });
    cached = t.access_token;
    return t.access_token;
  }
  return {
    async accessToken() {
      if (cached) return cached;
      const row = await loadZoomRow(db, userId);
      if (!row || row.status === 'revoked' || row.status === 'needs_reauth') throw new ZoomSignInNeeded();
      const s = row.state;
      const fresh = s.accessExpiresAt && Date.parse(s.accessExpiresAt) - 60_000 > now().getTime();
      if (s.accessSecretId && fresh) {
        const token = await vault.get(s.accessSecretId);
        if (token) return (cached = token);
      }
      return refresh();
    },
    refreshed: () => {
      cached = undefined;
      return refresh();
    },
  };
}

// ---- the API -------------------------------------------------------------------------------------------------------

export class ZoomApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`zoom ${status} ${path}`);
  }
}

/** Files Orbit downloads only from Zoom's own hosts. */
const zoomFileHost = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'zoom.us' || u.hostname.endsWith('.zoom.us'));
  } catch {
    return false;
  }
};

/** One call to Zoom with the student's token: a 401 refreshes once and tries again. */
export async function zoomCall(
  tokens: ZoomTokens,
  url: string,
  init: { method?: string; body?: unknown; raw?: boolean; fetch?: typeof fetch } = {},
): Promise<{ status: number; json?: Record<string, unknown>; text?: string }> {
  const doFetch = init.fetch ?? fetch;
  let token = await tokens.accessToken();
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await doFetch(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: init.raw ? 'text/vtt, text/plain, */*' : 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 && attempt === 0) {
      await res.body?.cancel();
      token = await tokens.refreshed();
      continue;
    }
    if (init.raw) {
      if (res.ok) return { status: res.status, text: await res.text() };
      await res.body?.cancel();
      return { status: res.status, text: '' };
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: res.status, json };
  }
  throw new ZoomSignInNeeded();
}

/** Zoom asks for a meeting uuid that starts with "/" or holds "//" to be encoded twice. */
export const zoomUuidPath = (uuid: string) =>
  uuid.startsWith('/') || uuid.includes('//')
    ? encodeURIComponent(encodeURIComponent(uuid))
    : encodeURIComponent(uuid);

export async function zoomMe(tokens: ZoomTokens, f?: typeof fetch): Promise<{ id: string; email?: string }> {
  const r = await zoomCall(tokens, `${ZOOM_API}/users/me`, { fetch: f });
  if (r.status !== 200 || typeof r.json?.id !== 'string') throw new ZoomApiError(r.status, '/users/me');
  return { id: r.json.id, email: typeof r.json.email === 'string' ? r.json.email : undefined };
}

interface ZoomRecordingFile {
  file_type?: string;
  file_extension?: string;
  download_url?: string;
  status?: string;
  recording_type?: string;
}
interface ZoomRecordedMeeting {
  uuid?: string;
  id?: number | string;
  topic?: string;
  start_time?: string;
  share_url?: string;
  recording_files?: ZoomRecordingFile[];
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The student's cloud recordings between two days (at most three pages of 100). */
export async function zoomRecordings(
  tokens: ZoomTokens,
  from: number,
  to: number,
  f?: typeof fetch,
): Promise<ZoomRecordedMeeting[]> {
  const out: ZoomRecordedMeeting[] = [];
  let next = '';
  for (let page = 0; page < 3; page++) {
    const q = new URLSearchParams({ from: day(from), to: day(to), page_size: '100' });
    if (next) q.set('next_page_token', next);
    const r = await zoomCall(tokens, `${ZOOM_API}/users/me/recordings?${q}`, { fetch: f });
    if (r.status !== 200) throw new ZoomApiError(r.status, '/users/me/recordings');
    out.push(...((r.json?.meetings as ZoomRecordedMeeting[] | undefined) ?? []));
    next = typeof r.json?.next_page_token === 'string' ? r.json.next_page_token : '';
    if (!next) break;
  }
  return out;
}

/**
 * Notes from the student's Zoom calls for these coffee chats: for each event, the recorded meeting that is it (its
 * meeting id in the join link, else the time and who was on it), its transcript as speaker-labelled text and the AI
 * Companion summary when there is one. An event with nothing recorded yet is in `none`. One recordings list covers
 * every event.
 */
export async function zoomNotesFor(
  tokens: ZoomTokens,
  events: CallEventRef[],
  f?: typeof fetch,
): Promise<{ notes: CallNote[]; none: string[] }> {
  if (!events.length) return { notes: [], none: [] };
  const starts = events.map((e) => Date.parse(e.startAt));
  const ends = events.map((e) => Date.parse(e.endAt));
  const listed = await zoomRecordings(
    tokens,
    Math.min(...starts) - 86_400_000,
    Math.max(...ends) + 86_400_000,
    f,
  );
  const meetings = listed.map((m) => ({
    ...m,
    joinId: m.id === undefined ? undefined : String(m.id),
    startAt: m.start_time,
  }));
  const notes: CallNote[] = [];
  const none: string[] = [];
  for (const ev of events) {
    const m = matchCallToEvent(meetings, ev, 'zoom');
    if (!m?.uuid) {
      none.push(ev.id);
      continue;
    }
    const file = (m.recording_files ?? []).find(
      (x) =>
        (x.file_type === 'TRANSCRIPT' || x.recording_type === 'audio_transcript') &&
        (x.status ?? 'completed') === 'completed' &&
        !!x.download_url &&
        zoomFileHost(x.download_url),
    );
    let transcript: string | undefined;
    if (file?.download_url) {
      const r = await zoomCall(tokens, file.download_url, { raw: true, fetch: f });
      if (r.status === 200) transcript = vttToText(r.text) || undefined;
    }
    // the AI Companion summary only exists on plans that have it; any refusal is quiet
    let summary: string | undefined;
    const s = await zoomCall(tokens, `${ZOOM_API}/meetings/${zoomUuidPath(m.uuid)}/meeting_summary`, {
      fetch: f,
    }).catch((e) => {
      if (e instanceof ZoomSignInNeeded) throw e;
      return { status: 0, json: undefined };
    });
    if (s.status === 200) summary = zoomSummaryText(s.json);
    if (!transcript && !summary) {
      none.push(ev.id);
      continue;
    }
    notes.push({
      app: 'zoom',
      eventId: ev.id,
      meetingId: m.uuid,
      title: m.topic?.trim() || ev.title || 'Zoom call',
      startAt: m.start_time ?? ev.startAt,
      url: m.share_url,
      summary,
      transcript,
    });
  }
  return { notes, none };
}

/** A scheduled Zoom meeting for a booked chat (POST /users/me/meetings); its join link goes on the invite. */
export async function zoomCreateMeeting(
  tokens: ZoomTokens,
  m: { topic: string; startAt: string; minutes: number; timezone?: string },
  f?: typeof fetch,
): Promise<{ joinUrl: string; meetingId: string }> {
  const r = await zoomCall(tokens, `${ZOOM_API}/users/me/meetings`, {
    method: 'POST',
    fetch: f,
    body: {
      topic: m.topic.slice(0, 200),
      // a scheduled meeting
      type: 2,
      start_time: new Date(m.startAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      duration: Math.max(5, Math.min(600, Math.round(m.minutes))),
      ...(m.timezone ? { timezone: m.timezone } : {}),
      settings: { join_before_host: true },
    },
  });
  const joinUrl = r.json?.join_url;
  if (r.status !== 201 && r.status !== 200) throw new ZoomApiError(r.status, '/users/me/meetings');
  if (typeof joinUrl !== 'string' || !/^https:\/\//.test(joinUrl)) throw new ZoomApiError(502, 'no_join_url');
  return { joinUrl, meetingId: String(r.json?.id ?? '') };
}

/** Everything a route needs to act for one student, or undefined when Zoom is not set up. */
export async function zoomFor(
  db: Db,
  vault: Vault,
  env: ZoomEnv | undefined,
  redirectUri: string,
  userId: string,
  opts: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<{ cfg: ZoomConfig; tokens: ZoomTokens } | undefined> {
  const keys = await zoomKeys(env, db);
  if (!keys) return undefined;
  const cfg: ZoomConfig = { ...keys, redirectUri: env?.redirectUri ?? redirectUri, fetch: opts.fetch };
  return { cfg, tokens: zoomTokens(db, vault, cfg, userId, opts.now) };
}

// ---- the webhook ---------------------------------------------------------------------------------------------------

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** A Zoom webhook older than this is refused (a replay). */
export const ZOOM_WEBHOOK_MAX_AGE_MS = 5 * 60_000;
/** The transcripts-ready list kept per student. */
const READY_KEEP = 20;

/**
 * One Zoom webhook (orbit-webhooks POST /zoom), its signature checked first: `x-zm-signature` is
 * "v0=" + HMAC-SHA256(secret, "v0:{x-zm-request-timestamp}:{body}") in hex, and the timestamp is recent.
 *
 *   endpoint.url_validation         → {plainToken, encryptedToken}: HMAC-SHA256(secret, plainToken) in hex
 *   recording.transcript_completed  → the meeting is noted on the host's zoom row (sync_state.zoom.ready), so the
 *                                     student's next notes check knows a transcript is there; nothing is fetched here
 *   anything else                   → acknowledged
 */
export async function zoomWebhook(
  db: Db,
  secret: string,
  raw: string,
  headers: { signature: string | null; timestamp: string | null },
  now: Date,
): Promise<{ status: number; body?: unknown; userId?: string }> {
  const ts = Number(headers.timestamp);
  if (!headers.signature || !Number.isFinite(ts)) return { status: 401 };
  // Zoom sends seconds; a value in milliseconds is read as such
  const at = ts > 1e12 ? ts : ts * 1000;
  if (Math.abs(now.getTime() - at) > ZOOM_WEBHOOK_MAX_AGE_MS) return { status: 401 };
  const expected = `v0=${await hmacSha256Hex(secret, `v0:${headers.timestamp}:${raw}`)}`;
  if (!(await timingSafeEqual(headers.signature, expected))) return { status: 401 };
  let body: { event?: unknown; payload?: Record<string, unknown> } = {};
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return { status: 200, body: { ok: true } };
  }
  if (body.event === 'endpoint.url_validation') {
    const plainToken = body.payload?.plainToken;
    if (typeof plainToken !== 'string' || !plainToken || plainToken.length > 200) return { status: 400 };
    return { status: 200, body: { plainToken, encryptedToken: await hmacSha256Hex(secret, plainToken) } };
  }
  if (body.event !== 'recording.transcript_completed') return { status: 200, body: { ok: true } };
  const obj = (body.payload?.object ?? {}) as { host_id?: unknown; id?: unknown; uuid?: unknown };
  if (typeof obj.host_id !== 'string' || obj.id === undefined) return { status: 200, body: { ok: true } };
  // one Zoom account can be signed in to more than one Orbit account: each is told
  const rows = await db.sql<{ user_id: string; ready: ZoomSyncState['ready'] | null }>`
    select user_id, sync_state->'zoom'->'ready' as ready from orbit.integration_accounts
     where provider = 'zoom' and external_account_id = ${obj.host_id} and status = 'active'
     limit 5`;
  const entry = {
    meetingId: String(obj.id),
    ...(typeof obj.uuid === 'string' ? { uuid: obj.uuid } : {}),
    at: now.toISOString(),
  };
  for (const row of rows) {
    const ready = [...(row.ready ?? []).filter((r) => r.meetingId !== entry.meetingId), entry].slice(
      -READY_KEEP,
    );
    await saveZoomState(db, row.user_id, { ready });
  }
  return { status: 200, body: { ok: true }, userId: rows[0]?.user_id };
}
