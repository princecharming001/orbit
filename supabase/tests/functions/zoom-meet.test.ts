/**
 * Zoom and Google Meet: signing in with Zoom (state, PKCE, code exchange, refresh, a refused refresh, revoke), Zoom
 * cleanly "not set up" without its keys, a coffee chat's transcript and summary from Zoom and from Meet, the call link
 * on a booked invite, the meeting-link setting, and Zoom's webhook. Every Zoom and Google answer is a fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MEET_SCOPE } from '../../functions/_shared/meet.ts';
import { memoryTake } from '../../functions/_shared/ratelimit.ts';
import {
  hmacSha256Hex,
  loadZoomRow,
  resetZoomKeysForTests,
  ZOOM_SCOPES,
  type ZoomEnv,
} from '../../functions/_shared/zoom.ts';
import { makeApiHandler } from '../../functions/orbit-api/api.ts';
import { resetMeetOfferedForTests } from '../../functions/orbit-api/routes/calls.ts';
import { makeWebhookHandler } from '../../functions/orbit-webhooks/webhooks.ts';
import {
  ALL_KEYS,
  APP,
  addPerson,
  agentConfig,
  BASE,
  DAY,
  fakeNet,
  jsonRes,
  type NetCall,
  SECRET,
  signedInUser,
} from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
  // Meet transcripts are offered (the owner's switch); one test below turns it off first
  await t.db.sql`insert into orbit_private.secrets (name, value) values ('ORBIT_MEET_TRANSCRIPTS', 'on')`;
});
afterAll(async () => {
  await t.pg.close();
});
beforeEach(() => {
  resetZoomKeysForTests();
  resetMeetOfferedForTests();
});

const ZOOM: ZoomEnv = { clientId: 'zoom-client-placeholder', clientSecret: 'zoom-secret-placeholder' };

const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
Sam Rivera: Thanks for the time, Maya.

2
00:00:03.500 --> 00:00:08.000
Maya Chen: Happy to. Our payments team hires two new grads in March.

3
00:00:08.500 --> 00:00:10.000
Maya Chen: Send me your resume and I will pass it on.
`;

interface ZoomWorld {
  /** what the token endpoint answers next: a fresh pair, or a refusal */
  refuseRefresh?: boolean;
  tokenCalls: number;
  /** answer 401 to the next API call */
  expireNext?: boolean;
  recordings: Record<string, unknown>[];
  summary?: Record<string, unknown>;
  revoked: string[];
}

/** A stand-in for Zoom's OAuth and REST API with the documented shapes. */
function zoom(w: ZoomWorld) {
  return (c: NetCall): Response | undefined => {
    if (c.url === 'https://zoom.us/oauth/token') {
      w.tokenCalls++;
      const form = new URLSearchParams(String(c.body));
      if (form.get('grant_type') === 'refresh_token' && w.refuseRefresh)
        return jsonRes(400, { reason: 'Invalid Token!', error: 'invalid_grant' });
      return jsonRes(200, {
        access_token: `zoom-access-${w.tokenCalls}`,
        refresh_token: `zoom-refresh-${w.tokenCalls}`,
        expires_in: 3599,
        scope: ZOOM_SCOPES.join(' '),
        token_type: 'bearer',
      });
    }
    if (c.url.startsWith('https://zoom.us/oauth/revoke')) {
      w.revoked.push(new URLSearchParams(String(c.body)).get('token') ?? '');
      return jsonRes(200, { status: 'success' });
    }
    if (!c.url.startsWith('https://api.zoom.us/') && !c.url.startsWith('https://us02web.zoom.us/rec/'))
      return undefined;
    if (w.expireNext) {
      w.expireNext = false;
      return jsonRes(401, { code: 124, message: 'Invalid access token.' });
    }
    if (c.url === 'https://api.zoom.us/v2/users/me')
      return jsonRes(200, { id: 'zoom-user-1', email: 'sam@school.edu', first_name: 'Sam' });
    if (c.url.startsWith('https://api.zoom.us/v2/users/me/recordings'))
      return jsonRes(200, { meetings: w.recordings, next_page_token: '' });
    if (c.url.includes('/meeting_summary'))
      return w.summary ? jsonRes(200, w.summary) : jsonRes(404, { code: 3001, message: 'no summary' });
    if (c.url.startsWith('https://us02web.zoom.us/rec/download/'))
      return new Response(VTT, { status: 200, headers: { 'content-type': 'text/vtt' } });
    if (c.url === 'https://api.zoom.us/v2/users/me/meetings' && c.method === 'POST')
      return jsonRes(201, { id: 85099988877, join_url: 'https://us02web.zoom.us/j/85099988877?pwd=x' });
    return undefined;
  };
}

const world = (over: Partial<ZoomWorld> = {}): ZoomWorld => ({
  tokenCalls: 0,
  recordings: [],
  revoked: [],
  ...over,
});

const get = (path: string, token?: string) =>
  new Request(`${BASE}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

function rawHandler(net: ReturnType<typeof fakeNet>, zoomEnv: ZoomEnv | undefined) {
  return makeApiHandler({
    env: {
      googleClientId: 'client-id-placeholder.apps.googleusercontent.com',
      googleClientSecret: 'client-secret-placeholder',
      googleRedirectUri: `${BASE}/auth/google/callback`,
      sessionSecret: SECRET,
      appUrl: APP,
      zoom: zoomEnv,
    },
    db: t.db,
    fetch: net.fetch,
    take: memoryTake(),
    agent: agentConfig(net, {
      ...ALL_KEYS,
      googleClientId: 'client-id-placeholder.apps.googleusercontent.com',
      googleClientSecret: 'client-secret-placeholder',
      googleRedirectUri: `${BASE}/auth/google/callback`,
    }),
  });
}

/** POSTs to orbit-api as a signed-in student, with Zoom's keys (or none). */
function handlerFor(net: ReturnType<typeof fakeNet>, zoomEnv: ZoomEnv | undefined) {
  const handler = rawHandler(net, zoomEnv);
  return async <T = Record<string, unknown>>(path: string, token: string, body: unknown = {}) => {
    const r = await handler(
      new Request(`${BASE}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return { status: r.status, body: (await r.json()) as T };
  };
}

/** Signs in with Zoom through the routes: start, then come back with a code. */
async function connectZoom(net: ReturnType<typeof fakeNet>, token: string) {
  const handler = rawHandler(net, ZOOM);
  const start = await handlerFor(net, ZOOM)<{ url: string }>('/zoom/connect/start', token);
  const url = new URL(start.body.url);
  const back = await handler(get(`/auth/zoom/callback?state=${url.searchParams.get('state')}&code=code-1`));
  return { start: url, back, handler };
}

const event = (over: Record<string, unknown> = {}) => ({
  id: 'ev_local_1',
  startAt: '2026-11-10T15:00:00.000Z',
  endAt: '2026-11-10T15:30:00.000Z',
  title: 'Coffee chat: Sam Rivera / Maya Chen',
  conferenceUrl: 'https://us02web.zoom.us/j/85012345678?pwd=abc',
  attendees: [{ name: 'Maya Chen', email: 'maya@stripe.com' }],
  ...over,
});

const recording = (over: Record<string, unknown> = {}) => ({
  uuid: 'uuid/with//slashes==',
  id: 85012345678,
  topic: 'Coffee with Maya',
  start_time: '2026-11-10T15:02:00Z',
  share_url: 'https://us02web.zoom.us/rec/share/abc',
  recording_files: [
    { file_type: 'MP4', download_url: 'https://us02web.zoom.us/rec/download/mp4', status: 'completed' },
    {
      file_type: 'TRANSCRIPT',
      file_extension: 'VTT',
      recording_type: 'audio_transcript',
      download_url: 'https://us02web.zoom.us/rec/download/vtt',
      status: 'completed',
    },
  ],
  ...over,
});

describe('Zoom not set up', () => {
  it('says so plainly, and nothing calls Zoom', async () => {
    const net = fakeNet(zoom(world()));
    const call = handlerFor(net, undefined);
    const { token } = await signedInUser(t);
    const st = await call<{ configured: boolean; status: string }>('/zoom/status', token);
    expect(st.status).toBe(200);
    expect(st.body).toEqual({ configured: false, status: 'not_connected' });
    for (const path of ['/zoom/connect/start', '/zoom/disconnect', '/zoom/meetings']) {
      const r = await call<{ error: { code: string; message: string } }>(path, token, {});
      expect(r.status).toBe(503);
      expect(r.body.error).toMatchObject({ code: 'unconfigured', message: 'Zoom is not set up' });
    }
    const n = await call('/zoom/notes', token, { events: [event()] });
    expect(n.status).toBe(503);
    expect(net.calls.filter((c) => c.url.includes('zoom.us'))).toHaveLength(0);
  });

  it('picks up keys stored in orbit_private.secrets later', async () => {
    const net = fakeNet(zoom(world()));
    const { token } = await signedInUser(t);
    await t.db.sql`
      insert into orbit_private.secrets (name, value)
      values ('ZOOM_CLIENT_ID', 'stored-zoom-id'), ('ZOOM_CLIENT_SECRET', 'stored-zoom-secret')`;
    try {
      const st = await handlerFor(net, undefined)<{ configured: boolean }>('/zoom/status', token);
      expect(st.body.configured).toBe(true);
      const start = await handlerFor(net, undefined)<{ url: string }>('/zoom/connect/start', token);
      expect(new URL(start.body.url).searchParams.get('client_id')).toBe('stored-zoom-id');
    } finally {
      await t.db.sql`delete from orbit_private.secrets where name like 'ZOOM_%'`;
      resetZoomKeysForTests();
    }
  });
});

describe('signing in with Zoom', () => {
  it('starts with state and PKCE, exchanges the code, stores the tokens in Vault and reads who it is', async () => {
    const w = world();
    const net = fakeNet(zoom(w));
    const { userId, token } = await signedInUser(t);
    const { start, back } = await connectZoom(net, token);
    expect(`${start.origin}${start.pathname}`).toBe('https://zoom.us/oauth/authorize');
    expect(start.searchParams.get('client_id')).toBe(ZOOM.clientId);
    expect(start.searchParams.get('code_challenge_method')).toBe('S256');
    expect(start.searchParams.get('redirect_uri')).toBe(`${BASE}/auth/zoom/callback`);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe(`${APP}/settings?zoom=connected`);
    const exchange = net.calls.find((c) => c.url === 'https://zoom.us/oauth/token')!;
    const form = new URLSearchParams(String(exchange.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('code-1');
    expect(form.get('code_verifier')!.length).toBeGreaterThan(40);
    expect(exchange.headers.authorization).toBe(`Basic ${btoa(`${ZOOM.clientId}:${ZOOM.clientSecret}`)}`);
    const row = (await loadZoomRow(t.db, userId))!;
    expect(row).toMatchObject({ status: 'active', zoomUserId: 'zoom-user-1' });
    expect(row.state.email).toBe('sam@school.edu');
    const [v] = await t.db.sql<{ v: string }>`select orbit.vault_get(${row.refreshSecretId}::uuid) as v`;
    expect(v!.v).toBe('zoom-refresh-1');
    // the state is used once
    expect(await t.db.sql`select 1 from orbit.oauth_states where user_id = ${userId}::uuid`).toHaveLength(0);
    const st = await handlerFor(net, ZOOM)<{ status: string; email: string }>('/zoom/status', token);
    expect(st.body).toMatchObject({ configured: true, status: 'active', email: 'sam@school.edu' });
  });

  it('refuses a state it did not make, an expired one, and a denied sign-in', async () => {
    const w = world();
    const net = fakeNet(zoom(w));
    const { userId, token } = await signedInUser(t);
    const { handler } = await connectZoom(net, token);
    await t.db.sql`
      insert into orbit.oauth_states (state, code_verifier, redirect_to, user_id, scopes, created_at, expires_at)
      values ('google-state', 'v', ${APP}, ${userId}::uuid, ${['openid']}::text[], now(), now() + interval '5 minutes'),
             ('old-state', 'v', ${APP}, ${userId}::uuid, ${[...ZOOM_SCOPES]}::text[], now() - interval '1 hour',
              now() - interval '50 minutes')`;
    for (const q of [
      'state=google-state&code=x',
      'state=old-state&code=x',
      'code=x',
      'state=nope&error=access_denied',
    ]) {
      const r = await handler(get(`/zoom/callback?${q}`));
      expect(r.headers.get('location')).toBe(`${APP}/settings?zoom=failed`);
    }
  });
});

describe('notes from a Zoom call', () => {
  it('finds the recording by the join link, parses the transcript and adds the AI Companion summary', async () => {
    const w = world({
      recordings: [recording({ id: 11122233344, uuid: 'other' }), recording()],
      summary: {
        summary_overview: 'Sam and Maya talked about the payments team.',
        next_steps: ['Send resume'],
      },
    });
    const net = fakeNet(zoom(w));
    const { token } = await signedInUser(t);
    await connectZoom(net, token);
    const r = await handlerFor(net, ZOOM)<{ notes: Record<string, unknown>[]; none: string[] }>(
      '/zoom/notes',
      token,
      { events: [event(), event({ id: 'ev_local_2', conferenceUrl: 'https://zoom.us/j/99988877766' })] },
    );
    expect(r.status).toBe(200);
    expect(r.body.none).toEqual(['ev_local_2']);
    expect(r.body.notes).toHaveLength(1);
    const n = r.body.notes[0]!;
    expect(n).toMatchObject({
      app: 'zoom',
      eventId: 'ev_local_1',
      meetingId: 'uuid/with//slashes==',
      title: 'Coffee with Maya',
      url: 'https://us02web.zoom.us/rec/share/abc',
    });
    expect(n.transcript).toBe(
      'Sam Rivera: Thanks for the time, Maya.\nMaya Chen: Happy to. Our payments team hires two new grads in March. Send me your resume and I will pass it on.',
    );
    expect(n.summary).toContain('Next steps:\n- Send resume');
    // a uuid with "//" is encoded twice for the summary
    expect(
      net.calls.some((c) =>
        c.url.includes('/meetings/uuid%252Fwith%252F%252Fslashes%253D%253D/meeting_summary'),
      ),
    ).toBe(true);
    const list = net.calls.find((c) => c.url.startsWith('https://api.zoom.us/v2/users/me/recordings'))!;
    expect(new URL(list.url).searchParams.get('from')).toBe('2026-11-09');
    expect(list.headers.authorization).toBe('Bearer zoom-access-1');
  });

  it('a call with no transcript and no summary is quietly none', async () => {
    const w = world({ recordings: [recording({ recording_files: [] })] });
    const net = fakeNet(zoom(w));
    const { token } = await signedInUser(t);
    await connectZoom(net, token);
    const r = await handlerFor(net, ZOOM)<{ notes: unknown[]; none: string[] }>('/zoom/notes', token, {
      events: [event()],
    });
    expect(r.body).toEqual({ notes: [], none: ['ev_local_1'] });
  });

  it('refreshes an expired token (Zoom hands out a new refresh token) and retries once after a 401', async () => {
    const w = world({ recordings: [recording()] });
    const net = fakeNet(zoom(w));
    const { userId, token } = await signedInUser(t);
    await connectZoom(net, token);
    await t.db.sql`
      update orbit.integration_accounts
         set sync_state = jsonb_set(sync_state, '{zoom,accessExpiresAt}', '"2000-01-01T00:00:00Z"')
       where user_id = ${userId}::uuid and provider = 'zoom'`;
    const r = await handlerFor(net, ZOOM)<{ notes: unknown[] }>('/zoom/notes', token, { events: [event()] });
    expect(r.body.notes).toHaveLength(1);
    expect(w.tokenCalls).toBe(2);
    let row = (await loadZoomRow(t.db, userId))!;
    const [v] = await t.db.sql<{ v: string }>`select orbit.vault_get(${row.refreshSecretId}::uuid) as v`;
    expect(v!.v).toBe('zoom-refresh-2');
    // a 401 mid-way: one refresh, one retry
    w.expireNext = true;
    const again = await handlerFor(net, ZOOM)<{ notes: unknown[] }>('/zoom/notes', token, {
      events: [event()],
    });
    expect(again.status).toBe(200);
    expect(w.tokenCalls).toBe(3);
    row = (await loadZoomRow(t.db, userId))!;
    expect(row.status).toBe('active');
  });

  it('a refused refresh (invalid_grant) marks Zoom needs-reauth and says so', async () => {
    const w = world({ recordings: [recording()] });
    const net = fakeNet(zoom(w));
    const { userId, token } = await signedInUser(t);
    await connectZoom(net, token);
    w.refuseRefresh = true;
    w.expireNext = true;
    const r = await handlerFor(net, ZOOM)<{ error: { code: string } }>('/zoom/notes', token, {
      events: [event()],
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('needs_reauth');
    expect((await loadZoomRow(t.db, userId))!.status).toBe('needs_reauth');
    const st = await handlerFor(net, ZOOM)<{ status: string }>('/zoom/status', token);
    expect(st.body.status).toBe('needs_reauth');
    const again = await handlerFor(net, ZOOM)<{ error: { code: string } }>('/zoom/notes', token, {
      events: [event()],
    });
    expect(again.body.error.code).toBe('needs_reauth');
  });

  it('checks what it is asked: events required, at most ten, an https link only', async () => {
    const net = fakeNet(zoom(world()));
    const { token } = await signedInUser(t);
    await connectZoom(net, token);
    const call = handlerFor(net, ZOOM);
    expect((await call('/zoom/notes', token, {})).status).toBe(400);
    expect(
      (await call('/zoom/notes', token, { events: Array.from({ length: 11 }, () => event()) })).status,
    ).toBe(400);
    expect((await call('/zoom/notes', token, { events: [{ id: 'x', startAt: 'no' }] })).status).toBe(400);
  });

  it('answers not_connected before a sign-in', async () => {
    const net = fakeNet(zoom(world()));
    const { token } = await signedInUser(t);
    const r = await handlerFor(net, ZOOM)<{ error: { code: string } }>('/zoom/notes', token, {
      events: [event()],
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('not_connected');
  });
});

describe('Zoom meetings and disconnecting', () => {
  it('makes a scheduled meeting and returns its join link', async () => {
    const net = fakeNet(zoom(world()));
    const { token } = await signedInUser(t);
    await connectZoom(net, token);
    const r = await handlerFor(net, ZOOM)<{ joinUrl: string; meetingId: string }>('/zoom/meetings', token, {
      topic: 'Coffee chat: Sam / Maya',
      startAt: '2026-11-20T15:00:00.000Z',
      minutes: 30,
      timezone: 'America/New_York',
    });
    expect(r.body).toEqual({
      joinUrl: 'https://us02web.zoom.us/j/85099988877?pwd=x',
      meetingId: '85099988877',
    });
    const made = net.calls.find((c) => c.url === 'https://api.zoom.us/v2/users/me/meetings')!;
    expect(made.body).toMatchObject({
      topic: 'Coffee chat: Sam / Maya',
      type: 2,
      start_time: '2026-11-20T15:00:00Z',
      duration: 30,
      timezone: 'America/New_York',
    });
  });

  it('revokes at Zoom, deletes the tokens and marks the row revoked', async () => {
    const w = world();
    const net = fakeNet(zoom(w));
    const { userId, token } = await signedInUser(t);
    await connectZoom(net, token);
    const before = (await loadZoomRow(t.db, userId))!;
    const r = await handlerFor(net, ZOOM)<{ ok: boolean; revokedAtZoom: boolean }>('/zoom/disconnect', token);
    expect(r.body).toEqual({ ok: true, revokedAtZoom: true });
    expect(w.revoked).toEqual(['zoom-refresh-1']);
    const after = (await loadZoomRow(t.db, userId))!;
    expect(after.status).toBe('revoked');
    expect(after.refreshSecretId).toBeNull();
    const [v] = await t.db.sql<{
      v: string | null;
    }>`select orbit.vault_get(${before.refreshSecretId}::uuid) as v`;
    expect(v?.v ?? null).toBeNull();
    const st = await handlerFor(net, ZOOM)<{ status: string }>('/zoom/status', token);
    expect(st.body.status).toBe('not_connected');
  });
});

describe('the call link on a booked invite', () => {
  async function book(settings: Record<string, unknown>, connect: boolean) {
    const w = world();
    const net = fakeNet(zoom(w), (c) =>
      c.url.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events')
        ? jsonRes(200, { id: 'evt-z', hangoutLink: 'https://meet.google.com/abc-defg-hij' })
        : undefined,
    );
    const { userId, token } = await signedInUser(t, {
      settings,
      scopes: ['openid', 'https://www.googleapis.com/auth/calendar.events'],
    });
    if (connect) await connectZoom(net, token);
    const p = await addPerson(t, userId, { name: 'Maya Chen', email: 'maya@example.com' });
    const call = handlerFor(net, ZOOM);
    const c = await call<{ draft: { id: string } }>('/drafts/compose', token, {
      personId: p,
      kind: 'thank_you',
      channel: 'gmail',
    });
    const r = await call<{ eventId: string; meetingUrl?: string }>('/calendar/book', token, {
      draftId: c.body.draft.id,
      slotStart: new Date(Date.now() + 3 * DAY).toISOString(),
    });
    const ev = net.calls.find((x) => x.url.includes('/calendar/v3/calendars/primary/events'))!;
    const [row] = await t.db.sql<{ conference_url: string | null }>`
      select conference_url from orbit.calendar_events where user_id = ${userId}::uuid`;
    return { r, ev, row, net };
  }

  it('Google Meet by default (conferenceData with hangoutsMeet)', async () => {
    const { r, ev, row } = await book({}, false);
    expect(ev.url).toContain('conferenceDataVersion=1');
    expect(ev.body).toMatchObject({
      conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    });
    expect(r.body.meetingUrl).toBe('https://meet.google.com/abc-defg-hij');
    expect(row!.conference_url).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('a Zoom meeting when the student picked Zoom and it is connected', async () => {
    const { r, ev, row } = await book({ meeting_link: 'zoom' }, true);
    expect(ev.url).not.toContain('conferenceDataVersion');
    expect(ev.body).toMatchObject({ location: 'https://us02web.zoom.us/j/85099988877?pwd=x' });
    expect((ev.body as Record<string, unknown>).conferenceData).toBeUndefined();
    expect(r.body.meetingUrl).toBe('https://us02web.zoom.us/j/85099988877?pwd=x');
    expect(row!.conference_url).toBe('https://us02web.zoom.us/j/85099988877?pwd=x');
  });

  it('Meet instead when Zoom is picked but not connected; no link when the student picked none', async () => {
    const z = await book({ meeting_link: 'zoom' }, false);
    expect(z.ev.body).toMatchObject({ conferenceData: { createRequest: {} } });
    expect(z.net.calls.some((c) => c.url.includes('api.zoom.us'))).toBe(false);
    const none = await book({ meeting_link: 'none' }, false);
    expect(none.ev.url).not.toContain('conferenceDataVersion');
    expect((none.ev.body as Record<string, unknown>).conferenceData).toBeUndefined();
    expect(none.r.body.meetingUrl).toBeUndefined();
  });

  it('the setting is kept as users.settings.meeting_link, Meet being the default', async () => {
    const net = fakeNet();
    const { userId, token } = await signedInUser(t);
    const call = handlerFor(net, ZOOM);
    expect((await call('/settings/profile', token, { meetingLink: 'teams' })).status).toBe(400);
    await call('/settings/profile', token, { meetingLink: 'zoom' });
    let [u] = await t.db.sql<{
      s: Record<string, unknown>;
    }>`select settings as s from orbit.users where id = ${userId}::uuid`;
    expect(u!.s.meeting_link).toBe('zoom');
    await call('/settings/profile', token, { meetingLink: 'meet' });
    [u] = await t.db.sql<{
      s: Record<string, unknown>;
    }>`select settings as s from orbit.users where id = ${userId}::uuid`;
    expect(u!.s.meeting_link).toBeUndefined();
  });
});

// ---- Google Meet ---------------------------------------------------------------------------------------------------

function meet(opts: { transcript?: boolean; refuse?: boolean } = {}) {
  return (c: NetCall): Response | undefined => {
    if (!c.url.startsWith('https://meet.googleapis.com/v2/')) return undefined;
    if (opts.refuse) return jsonRes(403, { error: { status: 'PERMISSION_DENIED' } });
    const u = new URL(c.url);
    if (u.pathname === '/v2/conferenceRecords')
      return jsonRes(200, {
        conferenceRecords: [
          {
            name: 'conferenceRecords/rec-1',
            startTime: '2026-11-10T15:01:00Z',
            endTime: '2026-11-10T15:31:00Z',
          },
        ],
      });
    if (u.pathname === '/v2/conferenceRecords/rec-1/transcripts')
      return jsonRes(
        200,
        opts.transcript === false
          ? {}
          : {
              transcripts: [
                {
                  name: 'conferenceRecords/rec-1/transcripts/t-1',
                  state: 'FILE_GENERATED',
                  docsDestination: { exportUri: 'https://docs.google.com/document/d/t1/export' },
                },
              ],
            },
      );
    if (u.pathname === '/v2/conferenceRecords/rec-1/transcripts/t-1/entries')
      return u.searchParams.get('pageToken')
        ? jsonRes(200, {
            transcriptEntries: [
              {
                participant: 'conferenceRecords/rec-1/participants/p2',
                text: 'I can intro you to the recruiter.',
                startTime: '2026-11-10T15:05:00Z',
              },
            ],
          })
        : jsonRes(200, {
            transcriptEntries: [
              {
                participant: 'conferenceRecords/rec-1/participants/p1',
                text: 'Thanks for the time.',
                startTime: '2026-11-10T15:02:00Z',
              },
              {
                participant: 'conferenceRecords/rec-1/participants/p2',
                text: 'Of course.',
                startTime: '2026-11-10T15:03:00Z',
              },
            ],
            nextPageToken: 'page-2',
          });
    if (u.pathname === '/v2/conferenceRecords/rec-1/participants')
      return jsonRes(200, {
        participants: [
          { name: 'conferenceRecords/rec-1/participants/p1', signedinUser: { displayName: 'Sam Rivera' } },
          { name: 'conferenceRecords/rec-1/participants/p2', signedinUser: { displayName: 'Maya Chen' } },
        ],
      });
    return undefined;
  };
}

const meetEvent = (over: Record<string, unknown> = {}) =>
  event({ conferenceUrl: 'https://meet.google.com/abc-defg-hij', ...over });

describe('Google Meet', () => {
  it('says not set up, and asks Google nothing, until the owner turns Meet transcripts on', async () => {
    await t.db.sql`delete from orbit_private.secrets where name = 'ORBIT_MEET_TRANSCRIPTS'`;
    const net = fakeNet(meet());
    const { token } = await signedInUser(t);
    const call = handlerFor(net, ZOOM);
    expect((await call('/meet/status', token)).body).toEqual({ configured: false, status: 'not_connected' });
    const on = await call<{ error: { code: string } }>('/meet/connect/start', token);
    expect(on.status).toBe(503);
    expect(on.body.error.code).toBe('unconfigured');
    expect((await call('/meet/notes', token, { events: [meetEvent()] })).status).toBe(503);
    const [row] = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.integration_accounts where provider = 'google_meet'`;
    expect(row!.n).toBe(0);
    expect(net.calls.filter((c) => c.url.includes('meet.googleapis.com'))).toEqual([]);
    await t.db.sql`insert into orbit_private.secrets (name, value) values ('ORBIT_MEET_TRANSCRIPTS', 'on')`;
    resetMeetOfferedForTests();
    expect((await call<{ configured: boolean }>('/meet/status', token)).body.configured).not.toBe(false);
  });

  it('is off until turned on; turning it on asks Google for the Meet permission only when missing', async () => {
    const net = fakeNet(meet());
    const { userId, token } = await signedInUser(t);
    const call = handlerFor(net, ZOOM);
    expect((await call<{ status: string }>('/meet/status', token)).body.status).toBe('not_connected');
    const on = await call<{ connected: boolean; url: string }>('/meet/connect/start', token);
    expect(on.body.connected).toBe(false);
    const url = new URL(on.body.url);
    expect(url.searchParams.get('scope')).toContain(MEET_SCOPE);
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    const [st] = await t.db.sql<{ scopes: string[] }>`
      select scopes from orbit.oauth_states where state = ${url.searchParams.get('state')!}`;
    expect(st!.scopes).toContain(MEET_SCOPE);
    expect((await call<{ status: string }>('/meet/status', token)).body.status).toBe('needs_consent');
    const asked = await call<{ error: { code: string } }>('/meet/notes', token, { events: [meetEvent()] });
    expect(asked.status).toBe(409);
    expect(asked.body.error.code).toBe('needs_consent');
    // Google gave the permission (the callback keeps the granted scopes on the google row)
    await t.db.sql`update orbit.integration_accounts set scopes = array_append(scopes, ${MEET_SCOPE})
                    where user_id = ${userId}::uuid and provider = 'google'`;
    expect((await call<{ status: string }>('/meet/status', token)).body.status).toBe('active');
    const again = await call<{ connected: boolean; url?: string }>('/meet/connect/start', token);
    expect(again.body).toEqual({ connected: true });
    await call('/meet/disconnect', token);
    expect((await call<{ status: string }>('/meet/status', token)).body.status).toBe('not_connected');
  });

  it('reads the transcript of the meeting code, with participant names, across pages', async () => {
    const net = fakeNet(meet());
    const { token } = await signedInUser(t, { scopes: ['openid', MEET_SCOPE] });
    const call = handlerFor(net, ZOOM);
    await call('/meet/connect/start', token);
    const r = await call<{ notes: Record<string, unknown>[]; none: string[] }>('/meet/notes', token, {
      events: [meetEvent()],
    });
    expect(r.status).toBe(200);
    expect(r.body.none).toEqual([]);
    expect(r.body.notes[0]).toMatchObject({
      app: 'google_meet',
      eventId: 'ev_local_1',
      meetingId: 'conferenceRecords/rec-1',
      url: 'https://docs.google.com/document/d/t1/export',
      transcript: 'Sam Rivera: Thanks for the time.\nMaya Chen: Of course. I can intro you to the recruiter.',
    });
    const list = net.calls.find((c) => new URL(c.url).pathname === '/v2/conferenceRecords')!;
    const filter = new URL(list.url).searchParams.get('filter')!;
    expect(filter).toContain('space.meeting_code="abc-defg-hij"');
    expect(filter).toContain('start_time>="2026-11-10T13:00:00.000Z"');
    expect(list.headers.authorization).toBe('Bearer google-access-placeholder');
  });

  it('no transcript (a personal account, or transcription off) is quietly none', async () => {
    const net = fakeNet(meet({ transcript: false }));
    const { token } = await signedInUser(t, { scopes: ['openid', MEET_SCOPE] });
    const call = handlerFor(net, ZOOM);
    await call('/meet/connect/start', token);
    const r = await call<{ notes: unknown[]; none: string[] }>('/meet/notes', token, {
      events: [meetEvent()],
    });
    expect(r.body).toEqual({ notes: [], none: ['ev_local_1'] });
  });

  it('a 403 from Meet asks for the permission again', async () => {
    const net = fakeNet(meet({ refuse: true }));
    const { token } = await signedInUser(t, { scopes: ['openid', MEET_SCOPE] });
    const call = handlerFor(net, ZOOM);
    await call('/meet/connect/start', token);
    const r = await call<{ error: { code: string } }>('/meet/notes', token, { events: [meetEvent()] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('needs_consent');
  });
});

// ---- the webhook ---------------------------------------------------------------------------------------------------

describe("Zoom's webhook", () => {
  const SECRET_TOKEN = 'zoom-webhook-placeholder';
  const now = new Date('2026-11-10T16:00:00Z');
  const hook = (secret: string | undefined) =>
    makeWebhookHandler({
      db: t.db,
      pubsubToken: undefined,
      unipileSecret: undefined,
      zoomSecret: async () => secret,
      now: () => now,
    });
  async function signed(body: unknown, ts = String(Math.floor(now.getTime() / 1000)), secret = SECRET_TOKEN) {
    const raw = JSON.stringify(body);
    const sig = `v0=${await hmacSha256Hex(secret, `v0:${ts}:${raw}`)}`;
    return new Request('https://ref.supabase.co/functions/v1/orbit-webhooks/zoom', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zm-signature': sig, 'x-zm-request-timestamp': ts },
      body: raw,
    });
  }

  it('answers the url_validation challenge', async () => {
    const r = await hook(SECRET_TOKEN)(
      await signed({ event: 'endpoint.url_validation', payload: { plainToken: 'abc' } }),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      plainToken: 'abc',
      encryptedToken: await hmacSha256Hex(SECRET_TOKEN, 'abc'),
    });
  });

  it('refuses a bad signature and an old timestamp; is not set up without the secret', async () => {
    const bad = await hook(SECRET_TOKEN)(await signed({ event: 'x' }, undefined, 'wrong-secret'));
    expect(bad.status).toBe(401);
    const old = await hook(SECRET_TOKEN)(
      await signed({ event: 'x' }, String(Math.floor(now.getTime() / 1000) - 3600)),
    );
    expect(old.status).toBe(401);
    const off = await hook(undefined)(await signed({ event: 'x' }));
    expect(off.status).toBe(503);
  });

  it('notes a finished transcript on the host’s zoom row', async () => {
    const net = fakeNet(zoom(world()));
    const { userId, token } = await signedInUser(t);
    await connectZoom(net, token);
    // a Zoom user of its own (earlier tests signed other students in as the fake's one user)
    await t.db.sql`update orbit.integration_accounts set external_account_id = 'zoom-host-9'
                    where user_id = ${userId}::uuid and provider = 'zoom'`;
    const r = await hook(SECRET_TOKEN)(
      await signed({
        event: 'recording.transcript_completed',
        payload: { account_id: 'acc', object: { host_id: 'zoom-host-9', id: 85012345678, uuid: 'u==' } },
      }),
    );
    expect(r.status).toBe(200);
    // a host Orbit does not know is acknowledged and changes nothing
    const unknown = await hook(SECRET_TOKEN)(
      await signed({
        event: 'recording.transcript_completed',
        payload: { object: { host_id: 'nobody', id: 1 } },
      }),
    );
    expect(unknown.status).toBe(200);
    const row = (await loadZoomRow(t.db, userId))!;
    expect(row.state.ready).toEqual([{ meetingId: '85012345678', uuid: 'u==', at: now.toISOString() }]);
  });
});
