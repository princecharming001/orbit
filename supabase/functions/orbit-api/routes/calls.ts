/**
 * Zoom and Google Meet: notes from the call itself, and Zoom meetings for the calls Orbit books.
 *
 *   POST /zoom/connect/start      → {url}: Zoom's consent screen (state + PKCE S256)
 *   GET  /zoom/callback?code&state → tokens into Vault, the zoom integration row, 302 <app>/settings?zoom=connected
 *                                   (or zoom=failed)
 *   GET  /zoom/status             → {configured, status, email?, lastSyncedAt?}; configured is false (and nothing calls
 *                                   Zoom) until ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET are stored
 *   POST /zoom/disconnect         → revokes the token at Zoom, deletes it from Vault, marks the row revoked
 *   POST /zoom/notes {events}     → {notes, none}: each coffee chat's transcript and AI Companion summary
 *   POST /zoom/meetings {topic, startAt, minutes, timezone?} → {joinUrl, meetingId}
 *
 *   POST /meet/connect/start      → {connected, url?}: Meet on; `url` asks Google for the transcript permission first
 *   GET  /meet/status             → {status, email?, lastSyncedAt?}
 *   POST /meet/disconnect         → Meet off (the Google permission stays with the rest of the sign-in)
 *   POST /meet/notes {events}     → {notes, none}: each coffee chat's Meet transcript
 *
 * Without Orbit's Zoom keys the Zoom routes other than status answer 503 "Zoom is not set up". A needed sign-in or
 * permission answers 409 with code needs_reauth, needs_consent or not_connected.
 */
import type { CallEventRef } from '@orbit/core/notes/callNotes';
import type {
  CallNotesResponse,
  MeetConnectStartResponse,
  MeetStatusResponse,
  ZoomMeetingResponse,
  ZoomStatusResponse,
} from '@orbit/core/server/api';
import { randomToken } from '../../_shared/crypto.ts';
import { NeedsReauth, pkcePair } from '../../_shared/google.ts';
import { badRequest, HttpError, json, readJson, redirect } from '../../_shared/http.ts';
import {
  hasMeetScope,
  MEET_SCOPE,
  MeetNeedsConsent,
  meetConsentUrl,
  meetNotesFor,
} from '../../_shared/meet.ts';
import { providerSecret } from '../../_shared/secrets.ts';
import { sqlVault } from '../../_shared/vault.ts';
import {
  loadZoomRow,
  storeZoomTokens,
  ZOOM_NOT_SET_UP,
  ZOOM_SCOPES,
  ZoomApiError,
  type ZoomConfig,
  ZoomSignInNeeded,
  zoomAuthUrl,
  zoomCreateMeeting,
  zoomExchangeCode,
  zoomFor,
  zoomKeys,
  zoomMe,
  zoomNotesFor,
  zoomRevoke,
} from '../../_shared/zoom.ts';
import type { Ctx, Route } from '../api.ts';
import { functionsBase } from './integrations.ts';

const STATE_TTL_MS = 10 * 60_000;
/** Events one notes call may ask about. */
export const MAX_CALL_EVENTS = 10;

const zoomNotSetUp = () =>
  json(
    503,
    {
      error: {
        code: 'unconfigured',
        message: ZOOM_NOT_SET_UP,
        missing: ['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET'],
      },
    },
    { 'x-orbit-connector': 'unconfigured' },
  );

const conflict = (code: string, message: string) => new HttpError(409, code, message);

const zoomRedirect = (ctx: Ctx) =>
  ctx.env.zoom?.redirectUri ?? `${functionsBase(ctx)}/orbit-api/zoom/callback`;

async function zoomConfig(ctx: Ctx): Promise<ZoomConfig | undefined> {
  const keys = await zoomKeys(ctx.env.zoom, ctx.db);
  return keys ? { ...keys, redirectUri: zoomRedirect(ctx), fetch: ctx.fetch } : undefined;
}

/** The coffee chats a notes call asks about, checked: ids, times, an https join link, a few attendees. */
export function callEvents(b: Record<string, unknown>): CallEventRef[] {
  const raw = b.events;
  if (!Array.isArray(raw) || !raw.length) throw badRequest('events is required');
  if (raw.length > MAX_CALL_EVENTS) throw badRequest(`at most ${MAX_CALL_EVENTS} events`);
  const s = (v: unknown, max: number) =>
    typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
  return raw.map((e, i) => {
    const o = (e ?? {}) as Record<string, unknown>;
    const id = s(o.id, 200);
    const startAt = s(o.startAt, 40);
    const endAt = s(o.endAt, 40);
    if (!id || !startAt || !endAt || Number.isNaN(Date.parse(startAt)) || Number.isNaN(Date.parse(endAt)))
      throw badRequest(`events[${i}] needs an id, startAt and endAt`);
    const url = s(o.conferenceUrl, 500);
    const attendees = (Array.isArray(o.attendees) ? o.attendees : []).slice(0, 10).map((a) => {
      const x = (a ?? {}) as Record<string, unknown>;
      return { name: s(x.name, 200), email: s(x.email, 320) };
    });
    return {
      id,
      startAt,
      endAt,
      title: s(o.title, 300),
      conferenceUrl: url && /^https:\/\//i.test(url) ? url : undefined,
      attendees,
    };
  });
}

// ---- Zoom ----------------------------------------------------------------------------------------------------------

export async function zoomConnectStart(ctx: Ctx): Promise<Response> {
  const cfg = await zoomConfig(ctx);
  if (!cfg) return zoomNotSetUp();
  await readJson(ctx.req, { optional: true });
  const now = ctx.now();
  const state = randomToken(32);
  const { verifier, challenge } = await pkcePair();
  await ctx.db.sql`
    insert into orbit.oauth_states (state, code_verifier, redirect_to, user_id, scopes, created_at, expires_at)
    values (${state}, ${verifier}, ${`${ctx.env.appUrl}/settings`}, ${ctx.userId!}::uuid, ${[...ZOOM_SCOPES]}::text[],
            ${now}::timestamptz, ${new Date(now.getTime() + STATE_TTL_MS)}::timestamptz)`;
  return json(200, { url: zoomAuthUrl(cfg, { state, challenge }) });
}

const settings = (ctx: Ctx, outcome: 'connected' | 'failed') =>
  redirect(`${ctx.env.appUrl}/settings?zoom=${outcome}`);

export async function zoomCallback(ctx: Ctx): Promise<Response> {
  const cfg = await zoomConfig(ctx);
  if (!cfg) return settings(ctx, 'failed');
  const q = ctx.url.searchParams;
  const state = q.get('state');
  if (!state) return settings(ctx, 'failed');
  const [st] = await ctx.db.sql<{
    code_verifier: string;
    user_id: string | null;
    scopes: string[];
    expires_at: Date;
  }>`
    delete from orbit.oauth_states where state = ${state}
    returning code_verifier, user_id, scopes, expires_at`;
  // only a state this route made (it carries Zoom's scopes), for a signed-in student, not expired
  if (
    !st?.user_id ||
    !st.scopes.includes('meeting:write:meeting') ||
    new Date(st.expires_at).getTime() < ctx.now().getTime()
  )
    return settings(ctx, 'failed');
  const userId = st.user_id;
  const code = q.get('code');
  if (q.get('error') || !code) return settings(ctx, 'failed');
  let tokens: Awaited<ReturnType<typeof zoomExchangeCode>>;
  try {
    tokens = await zoomExchangeCode(cfg, code, st.code_verifier);
  } catch {
    return settings(ctx, 'failed');
  }
  let me: { id: string; email?: string };
  try {
    me = await zoomMe(
      { accessToken: async () => tokens.access_token, refreshed: async () => tokens.access_token },
      ctx.fetch,
    );
  } catch {
    if (tokens.refresh_token) await zoomRevoke(cfg, tokens.refresh_token);
    return settings(ctx, 'failed');
  }
  const vault = sqlVault(ctx.db);
  const stored = await storeZoomTokens(vault, userId, tokens, ctx.now());
  const scopes = (tokens.scope ?? '').split(/[\s,]+/).filter(Boolean);
  const zoom = {
    email: me.email,
    accessSecretId: stored.accessSecretId,
    accessExpiresAt: stored.accessExpiresAt,
  };
  await ctx.db.sql`
    insert into orbit.integration_accounts (user_id, provider, status, email, scopes, external_account_id,
                                            token_secret_id, sync_state, last_error)
    values (${userId}::uuid, 'zoom', 'active', ${me.email ?? null}, ${scopes}::text[], ${me.id},
            ${stored.refreshSecretId ?? null}::uuid, ${{ zoom }}::jsonb, null)
    on conflict (user_id, provider) do update set
      status = case when coalesce(excluded.token_secret_id, orbit.integration_accounts.token_secret_id) is null
                    then 'needs_reauth' else 'active' end,
      email = excluded.email,
      scopes = excluded.scopes,
      external_account_id = excluded.external_account_id,
      token_secret_id = coalesce(excluded.token_secret_id, orbit.integration_accounts.token_secret_id),
      sync_state = jsonb_set(coalesce(orbit.integration_accounts.sync_state, '{}'::jsonb), '{zoom}',
                             jsonb_strip_nulls(coalesce(orbit.integration_accounts.sync_state->'zoom', '{}'::jsonb)
                                               || ${zoom}::jsonb)),
      last_error = null`;
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, details)
    values (${userId}::uuid, 'user', 'zoom.connected', 'integration_accounts', ${{ scopes: scopes.length }}::jsonb)`;
  return settings(ctx, 'connected');
}

export async function zoomStatus(ctx: Ctx): Promise<Response> {
  const keys = await zoomKeys(ctx.env.zoom, ctx.db);
  if (!keys) return json(200, { configured: false, status: 'not_connected' } satisfies ZoomStatusResponse);
  const row = await loadZoomRow(ctx.db, ctx.userId!);
  const status: ZoomStatusResponse['status'] =
    !row || row.status === 'revoked' || row.status === 'connecting'
      ? 'not_connected'
      : row.status === 'active' || row.status === 'needs_reauth'
        ? row.status
        : 'error';
  const out: ZoomStatusResponse = {
    configured: true,
    status,
    ...(status !== 'not_connected' && row?.state.email ? { email: row.state.email } : {}),
    ...(status !== 'not_connected' && row?.lastSyncedAt ? { lastSyncedAt: row.lastSyncedAt } : {}),
  };
  return json(200, out);
}

export async function zoomDisconnect(ctx: Ctx): Promise<Response> {
  const cfg = await zoomConfig(ctx);
  if (!cfg) return zoomNotSetUp();
  await readJson(ctx.req, { optional: true });
  const userId = ctx.userId!;
  const row = await loadZoomRow(ctx.db, userId);
  if (!row) return json(200, { ok: true });
  const vault = sqlVault(ctx.db);
  let revoked = false;
  if (row.refreshSecretId) {
    const refresh = await vault.get(row.refreshSecretId);
    if (refresh) revoked = await zoomRevoke(cfg, refresh);
  }
  if (!revoked && row.state.accessSecretId) {
    const access = await vault.get(row.state.accessSecretId);
    if (access) revoked = await zoomRevoke(cfg, access);
  }
  if (row.refreshSecretId) await vault.delete(row.refreshSecretId);
  if (row.state.accessSecretId) await vault.delete(row.state.accessSecretId);
  await ctx.db.sql`
    update orbit.integration_accounts
       set status = 'revoked', token_secret_id = null, last_error = null,
           sync_state = jsonb_set(coalesce(sync_state, '{}'::jsonb), '{zoom}',
                                  coalesce(sync_state->'zoom', '{}'::jsonb) - 'accessSecretId' - 'accessExpiresAt')
     where user_id = ${userId}::uuid and provider = 'zoom'`;
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, details)
    values (${userId}::uuid, 'user', 'zoom.disconnect', 'integration_accounts', ${{ revokedAtZoom: revoked }}::jsonb)`;
  return json(200, { ok: true, revokedAtZoom: revoked });
}

/** The student's Zoom, ready to call, or a 503 / 409 saying why not. */
async function zoomReady(ctx: Ctx) {
  const z = await zoomFor(ctx.db, sqlVault(ctx.db), ctx.env.zoom, zoomRedirect(ctx), ctx.userId!, {
    fetch: ctx.fetch,
    now: ctx.now,
  });
  if (!z) return zoomNotSetUp();
  const row = await loadZoomRow(ctx.db, ctx.userId!);
  if (!row || row.status === 'revoked' || row.status === 'connecting')
    throw conflict('not_connected', 'Zoom is not connected');
  if (row.status === 'needs_reauth') throw conflict('needs_reauth', 'sign in with Zoom again');
  return z;
}

const zoomFailure = (e: unknown): never => {
  if (e instanceof ZoomSignInNeeded) throw conflict('needs_reauth', 'sign in with Zoom again');
  if (e instanceof ZoomApiError) throw new HttpError(502, 'upstream', `Zoom answered ${e.status}`);
  throw e;
};

export async function zoomNotes(ctx: Ctx): Promise<Response> {
  const z = await zoomReady(ctx);
  if (z instanceof Response) return z;
  const events = callEvents(await readJson(ctx.req));
  let out: CallNotesResponse;
  try {
    out = await zoomNotesFor(z.tokens, events, ctx.fetch);
  } catch (e) {
    return zoomFailure(e);
  }
  await ctx.db.sql`
    update orbit.integration_accounts set last_synced_at = ${ctx.now()}::timestamptz, last_error = null
     where user_id = ${ctx.userId!}::uuid and provider = 'zoom'`;
  return json(200, out);
}

export async function zoomMeetings(ctx: Ctx): Promise<Response> {
  const z = await zoomReady(ctx);
  if (z instanceof Response) return z;
  const b = await readJson(ctx.req);
  const topic = typeof b.topic === 'string' && b.topic.trim() ? b.topic.trim().slice(0, 200) : 'Coffee chat';
  const startAt = typeof b.startAt === 'string' ? b.startAt : '';
  if (Number.isNaN(Date.parse(startAt))) throw badRequest('startAt must be an ISO time');
  const minutes = Number(b.minutes ?? 30);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 600)
    throw badRequest('minutes must be 1 to 600');
  const timezone = typeof b.timezone === 'string' && b.timezone.length <= 64 ? b.timezone : undefined;
  try {
    const r: ZoomMeetingResponse = await zoomCreateMeeting(
      z.tokens,
      { topic, startAt, minutes, timezone },
      ctx.fetch,
    );
    return json(200, r);
  } catch (e) {
    return zoomFailure(e);
  }
}

// ---- Google Meet ---------------------------------------------------------------------------------------------------

async function googleRow(ctx: Ctx) {
  const [g] = await ctx.db.sql<{ scopes: string[]; status: string; email: string | null }>`
    select scopes, status, email from orbit.integration_accounts
     where user_id = ${ctx.userId!}::uuid and provider = 'google'`;
  return g;
}

async function meetRow(ctx: Ctx) {
  const [m] = await ctx.db.sql<{ status: string; last_synced_at: Date | string | null }>`
    select status, last_synced_at from orbit.integration_accounts
     where user_id = ${ctx.userId!}::uuid and provider = 'google_meet'`;
  return m;
}

/**
 * Meet transcripts are offered once the owner has added the Meet permission to Orbit's Google consent screen and
 * turned on the Meet REST API, then stored ORBIT_MEET_TRANSCRIPTS = 'on' in orbit_private.secrets. Before that a student
 * who turned Meet on would meet Google's warning screen, so the row says it is not set up and nothing asks Google.
 * Read again at most once a minute.
 */
let meetOn: { at: number; on: boolean } | undefined;
export function resetMeetOfferedForTests(): void {
  meetOn = undefined;
}
async function meetOffered(ctx: Ctx): Promise<boolean> {
  const t = Date.now();
  if (!meetOn || t - meetOn.at > 60_000)
    meetOn = {
      at: t,
      on:
        (await providerSecret(() => undefined, ctx.db, 'ORBIT_MEET_TRANSCRIPTS'))?.trim().toLowerCase() ===
        'on',
    };
  return meetOn.on;
}

const meetNotSetUp = () =>
  json(
    503,
    {
      error: {
        code: 'unconfigured',
        message: 'Google Meet is not set up',
        missing: ['ORBIT_MEET_TRANSCRIPTS'],
      },
    },
    { 'x-orbit-connector': 'unconfigured' },
  );

async function meetState(ctx: Ctx): Promise<MeetStatusResponse> {
  if (!(await meetOffered(ctx))) return { configured: false, status: 'not_connected' };
  const [m, g] = await Promise.all([meetRow(ctx), googleRow(ctx)]);
  if (!m || m.status === 'revoked') return { status: 'not_connected' };
  const base = {
    ...(g?.email ? { email: g.email } : {}),
    ...(m.last_synced_at ? { lastSyncedAt: new Date(m.last_synced_at).toISOString() } : {}),
  };
  if (!g || g.status === 'needs_reauth' || g.status === 'revoked') return { status: 'needs_reauth', ...base };
  if (!hasMeetScope(g.scopes)) return { status: 'needs_consent', ...base };
  return { status: 'active', ...base };
}

export async function meetStatus(ctx: Ctx): Promise<Response> {
  return json(200, await meetState(ctx));
}

export async function meetConnectStart(ctx: Ctx): Promise<Response> {
  await readJson(ctx.req, { optional: true });
  if (!(await meetOffered(ctx))) return meetNotSetUp();
  if (!ctx.google)
    return json(
      503,
      {
        error: { code: 'unconfigured', message: 'Google is not set up', missing: ['ORBIT_GOOGLE_CLIENT_ID'] },
      },
      { 'x-orbit-connector': 'unconfigured' },
    );
  const userId = ctx.userId!;
  await ctx.db.sql`
    insert into orbit.integration_accounts (user_id, provider, status, scopes)
    values (${userId}::uuid, 'google_meet', 'active', ${[MEET_SCOPE]}::text[])
    on conflict (user_id, provider) do update set status = 'active', last_error = null`;
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, details)
    values (${userId}::uuid, 'user', 'meet.on', 'integration_accounts', ${{}}::jsonb)`;
  const g = await googleRow(ctx);
  if (hasMeetScope(g?.scopes)) return json(200, { connected: true } satisfies MeetConnectStartResponse);
  const url = await meetConsentUrl(ctx.db, ctx.google, userId, ctx.env.appUrl, ctx.now());
  return json(200, { connected: false, url } satisfies MeetConnectStartResponse);
}

export async function meetDisconnect(ctx: Ctx): Promise<Response> {
  await readJson(ctx.req, { optional: true });
  await ctx.db.sql`
    update orbit.integration_accounts set status = 'revoked', last_error = null
     where user_id = ${ctx.userId!}::uuid and provider = 'google_meet'`;
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, details)
    values (${ctx.userId!}::uuid, 'user', 'meet.off', 'integration_accounts', ${{}}::jsonb)`;
  return json(200, { ok: true });
}

export async function meetNotes(ctx: Ctx): Promise<Response> {
  const events = callEvents(await readJson(ctx.req));
  const st = await meetState(ctx);
  if (st.configured === false) return meetNotSetUp();
  if (st.status === 'not_connected') throw conflict('not_connected', 'Google Meet is not on');
  if (st.status === 'needs_reauth') throw conflict('needs_reauth', 'reconnect Google');
  if (st.status === 'needs_consent') throw conflict('needs_consent', 'allow Google Meet transcripts');
  const tokens = ctx.services().tokens;
  if (!tokens) throw new HttpError(503, 'unconfigured', 'Google is not set up');
  let out: CallNotesResponse;
  try {
    out = await meetNotesFor(tokens, ctx.userId!, events, ctx.fetch);
  } catch (e) {
    if (e instanceof NeedsReauth) throw conflict('needs_reauth', 'reconnect Google');
    if (e instanceof MeetNeedsConsent) throw conflict('needs_consent', 'allow Google Meet transcripts');
    throw new HttpError(502, 'upstream', 'Google Meet did not answer');
  }
  await ctx.db.sql`
    update orbit.integration_accounts set last_synced_at = ${ctx.now()}::timestamptz, last_error = null
     where user_id = ${ctx.userId!}::uuid and provider = 'google_meet'`;
  return json(200, out);
}

export const callRoutes: Record<string, Route> = {
  '/zoom/connect/start': { method: 'POST', auth: true, run: zoomConnectStart },
  '/zoom/callback': { method: 'GET', auth: false, run: zoomCallback },
  '/zoom/status': { method: 'GET|POST', auth: true, run: zoomStatus },
  '/zoom/disconnect': { method: 'POST', auth: true, run: zoomDisconnect },
  '/zoom/notes': { method: 'POST', auth: true, run: zoomNotes },
  '/zoom/meetings': { method: 'POST', auth: true, run: zoomMeetings },
  '/meet/connect/start': { method: 'POST', auth: true, run: meetConnectStart },
  '/meet/status': { method: 'GET|POST', auth: true, run: meetStatus },
  '/meet/disconnect': { method: 'POST', auth: true, run: meetDisconnect },
  '/meet/notes': { method: 'POST', auth: true, run: meetNotes },
};
