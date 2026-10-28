import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryTake } from '../../functions/_shared/ratelimit.ts';
import { createSession } from '../../functions/_shared/session.ts';
import { type ApiDeps, makeApiHandler } from '../../functions/orbit-api/api.ts';
import { safeRedirect, upsertGoogleUser } from '../../functions/orbit-api/auth.ts';
import { decodeCursor, encodeCursor, pull } from '../../functions/orbit-api/sync.ts';
import { PULL_TABLES } from '../../functions/orbit-api/tables.ts';
import { CLIENT_ID, type FakeGoogle, fakeGoogle, jsonRes, recordingFetch } from '../helpers/google.ts';
import { freshDb, makeUser, type TestDb } from '../helpers/pglite.ts';

const BASE = 'https://ref.supabase.co/functions/v1/orbit-api';
const APP = 'https://princecharming001.github.io/orbit';
const ORIGIN = 'https://princecharming001.github.io';
const SECRET = 'c2Vzc2lvbi1zZWNyZXQtcGxhY2Vob2xkZXItMzItYnl0ZXMhIQ==';

let t: TestDb;
let g: FakeGoogle;
beforeAll(async () => {
  t = await freshDb();
  g = await fakeGoogle();
});
afterAll(async () => {
  await t.pg.close();
});

function harness(over: Partial<ApiDeps> = {}, google?: (call: { url: string; body: string }) => Response) {
  const rec = recordingFetch(async (c) => {
    if (google) return google(c);
    if (c.url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(c.body);
      if (form.get('grant_type') === 'refresh_token')
        return jsonRes(200, { access_token: 'at', expires_in: 3600 });
      return jsonRes(200, {
        access_token: 'access-placeholder',
        expires_in: 3599,
        refresh_token: 'refresh-placeholder',
        scope:
          'openid https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly',
        id_token: await g.idToken({
          sub: `sub-${form.get('code')}`,
          email: `${form.get('code')}@example.com`,
        }),
      });
    }
    return jsonRes(200, {});
  });
  const handler = makeApiHandler({
    env: {
      googleClientId: CLIENT_ID,
      googleClientSecret: 'client-secret-placeholder',
      googleRedirectUri: `${BASE}/auth/google/callback`,
      sessionSecret: SECRET,
      appUrl: APP,
      unipileKey: 'unipile-placeholder',
      unipileBase: 'https://unipile.test',
    },
    db: t.db,
    fetch: rec.fetch,
    jwks: g.jwks,
    take: memoryTake(),
    pullLagMs: 0,
    ...over,
  });
  return { handler, calls: rec.calls };
}

const req = (path: string, init: Omit<RequestInit, 'body'> & { token?: string; body?: unknown } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
};

async function signedIn(over: { email?: string } = {}) {
  const sub = `s-${Math.random()}`;
  const userId = (await upsertGoogleUser(t.db, {
    sub,
    email: over.email ?? `${sub}@example.com`,
    name: 'Test User',
    scopes: ['openid'],
    refreshToken: 'refresh-placeholder',
  }))!;
  const tokens = await createSession(t.db, { secret: SECRET }, userId);
  return { userId, token: tokens.accessToken, refreshToken: tokens.refreshToken };
}

/** Runs the whole Google sign-in against the fakes and returns the login code. */
async function signInThroughGoogle(handler: (r: Request) => Promise<Response>, code: string, redirect = APP) {
  const start = await handler(req(`/auth/google/start?redirect=${encodeURIComponent(redirect)}`));
  const google = new URL(start.headers.get('location')!);
  const state = google.searchParams.get('state')!;
  const cb = await handler(req(`/auth/google/callback?code=${code}&state=${state}`));
  return {
    start,
    google,
    cb,
    fragment: new URLSearchParams(new URL(cb.headers.get('location')!).hash.slice(1)),
  };
}

describe('configuration', () => {
  it('answers 503 unconfigured without the session secret, the Google client, or a database', async () => {
    const none = makeApiHandler({ env: {}, db: t.db, take: memoryTake() });
    for (const path of ['/auth/google/start', '/auth/me']) {
      const r = await none(req(path));
      expect(r.status).toBe(503);
      expect(r.headers.get('x-orbit-connector')).toBe('unconfigured');
    }
    const noGoogle = makeApiHandler({ env: { sessionSecret: SECRET }, db: t.db, take: memoryTake() });
    expect((await noGoogle(req('/auth/google/start'))).status).toBe(503);
    expect((await noGoogle(req('/auth/session', { body: { code: 'x' } }))).status).toBe(401);
    const noDb = makeApiHandler({ env: { sessionSecret: SECRET }, db: undefined, take: memoryTake() });
    const r = await noDb(req('/sync/status', { body: {} }));
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { missing: string[] } }).error.missing).toContain('SUPABASE_DB_URL');
  });

  it('treats a session secret shorter than 32 characters as missing', async () => {
    const weak = makeApiHandler({ env: { sessionSecret: 'short' }, db: t.db, take: memoryTake() });
    expect((await weak(req('/auth/me'))).headers.get('x-orbit-connector')).toBe('unconfigured');
  });
});

describe('CORS, routing and limits', () => {
  it('answers preflight for Orbit origins and refuses others', async () => {
    const { handler } = harness();
    const ok = await handler(req('/sync/pull', { method: 'OPTIONS', headers: { origin: ORIGIN } }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const bad = await handler(
      req('/sync/pull', { method: 'OPTIONS', headers: { origin: 'https://evil.test' } }),
    );
    expect(bad.status).toBe(403);
    const badPost = await handler(req('/auth/me', { headers: { origin: 'https://evil.test' } }));
    expect(badPost.status).toBe(403);
  });

  it('404s unknown routes and 405s wrong methods', async () => {
    const { handler } = harness();
    expect((await handler(req('/nope'))).status).toBe(404);
    expect((await handler(req('/sync/pull'))).status).toBe(405);
  });

  it('limits requests per IP per minute', async () => {
    const { handler } = harness({ limits: { ipPerMinute: 2, userPerMinute: 100, userPerDay: 100 } });
    const r = () =>
      handler(
        req('/auth/session', {
          body: { code: 'nope-nope-nope-nope-nope' },
          headers: { 'x-forwarded-for': '9.9.9.9' },
        }),
      );
    expect((await r()).status).toBe(401);
    expect((await r()).status).toBe(401);
    const third = await r();
    expect(third.status).toBe(429);
    expect(third.headers.get('x-orbit-limit')).toBe('minute');
  });

  it('limits requests per signed-in user', async () => {
    const { handler } = harness({ limits: { ipPerMinute: 100, userPerMinute: 1, userPerDay: 100 } });
    const { token } = await signedIn();
    expect((await handler(req('/auth/me', { token }))).status).toBe(200);
    expect((await handler(req('/auth/me', { token }))).status).toBe(429);
  });

  it('sets a request id on every answer', async () => {
    const { handler } = harness();
    const r = await handler(req('/auth/me', { headers: { 'x-request-id': 'req-12345678' } }));
    expect(r.headers.get('x-request-id')).toBe('req-12345678');
  });
});

describe('Google sign-in (§12.1)', () => {
  it('validates the return address', () => {
    expect(safeRedirect(null, APP)).toBe(APP);
    expect(safeRedirect(`${APP}/chat?x=1#y`, APP)).toBe(`${APP}/chat`);
    expect(safeRedirect('http://localhost:5173/', APP)).toBe('http://localhost:5173');
    expect(safeRedirect('https://evil.test/orbit', APP)).toBeUndefined();
    expect(safeRedirect('https://user:pw@princecharming001.github.io/', APP)).toBeUndefined();
    expect(safeRedirect('javascript:alert(1)', APP)).toBeUndefined();
  });

  it('start sends the browser to Google with PKCE and the phase-1 scopes, and refuses foreign redirects', async () => {
    const { handler } = harness();
    const r = await handler(req(`/auth/google/start?redirect=${encodeURIComponent(APP)}`));
    expect(r.status).toBe(302);
    const u = new URL(r.headers.get('location')!);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = u.searchParams;
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe(`${BASE}/auth/google/callback`);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('include_granted_scopes')).toBe('true');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const scopes = p.get('scope')!.split(' ');
    for (const s of [
      'openid',
      'email',
      'profile',
      'gmail.readonly',
      'gmail.send',
      'calendar.readonly',
      'contacts.other.readonly',
    ])
      expect(scopes.some((x) => x === s || x.endsWith(`/${s}`))).toBe(true);
    const [st] = await t.db.sql<{
      redirect_to: string;
    }>`select redirect_to from orbit.oauth_states where state = ${p.get('state')}`;
    expect(st!.redirect_to).toBe(APP);

    const bad = await handler(req(`/auth/google/start?redirect=${encodeURIComponent('https://evil.test/')}`));
    expect(bad.headers.get('location')).toBe(`${APP}/auth/done#error=bad_redirect`);
  });

  it('the callback creates the user, self person, identity, Vault token and Google account, then a one-time code', async () => {
    const { handler, calls } = harness();
    const { cb, fragment } = await signInThroughGoogle(handler, 'maya', 'http://localhost:5173');
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')!.startsWith('http://localhost:5173/auth/done#code=')).toBe(true);
    const tokenCall = calls.find((c) => c.url === 'https://oauth2.googleapis.com/token')!;
    const form = new URLSearchParams(tokenCall.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [user] = await t.db.sql<{ id: string; email: string; full_name: string }>`
      select id, email, full_name from orbit.users where google_sub = 'sub-maya'`;
    expect(user).toMatchObject({ email: 'maya@example.com', full_name: 'Maya Chen' });
    const people = await t.db.sql<{ is_self: boolean; display_name: string; name_norm: string }>`
      select is_self, display_name, name_norm from orbit.people where user_id = ${user!.id}::uuid`;
    expect(people).toEqual([{ is_self: true, display_name: 'Maya Chen', name_norm: 'maya chen' }]);
    const ids = await t.db.sql<{ kind: string; value_norm: string }>`
      select kind, value_norm from orbit.person_identities where user_id = ${user!.id}::uuid`;
    expect(ids).toEqual([{ kind: 'email', value_norm: 'maya@example.com' }]);
    const [acct] = await t.db.sql<{ scopes: string[]; status: string; token_secret_id: string }>`
      select scopes, status, token_secret_id from orbit.integration_accounts where user_id = ${user!.id}::uuid`;
    expect(acct!.status).toBe('active');
    expect(acct!.scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    const [secret] = await t.db.sql<{ name: string; v: string }>`
      select name, orbit.vault_get(id) as v from vault.secrets where id = ${acct!.token_secret_id}::uuid`;
    expect(secret).toEqual({ name: `google_refresh:${user!.id}`, v: 'refresh-placeholder' });
    const jobs = await t.db.sql<{ kind: string }>`
      select message->>'kind' as kind from pgmq.q_orbit_sync where message->>'userId' = ${user!.id}`;
    expect(jobs.map((j) => j.kind)).toContain('sync.gmail.backfill');

    // the code is good once
    const s = await handler(req('/auth/session', { body: { code: fragment.get('code') } }));
    expect(s.status).toBe(200);
    const body = (await s.json()) as {
      accessToken: string;
      refreshToken: string;
      expiresAt: string;
      user: { id: string };
    };
    expect(body.user.id).toBe(user!.id);
    expect(body.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const again = await handler(req('/auth/session', { body: { code: fragment.get('code') } }));
    expect(again.status).toBe(401);

    // signing in again keeps one user, one self person and one identity
    await signInThroughGoogle(handler, 'maya');
    const [{ n }] = (await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.people where user_id = ${user!.id}::uuid`) as [{ n: number }];
    expect(n).toBe(1);
  });

  it('sends errors back to the app: Google refusal, unknown or expired state, bad id_token', async () => {
    const { handler } = harness();
    const start = await handler(req('/auth/google/start'));
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const denied = await handler(req(`/auth/google/callback?error=access_denied&state=${state}`));
    expect(denied.headers.get('location')).toBe(`${APP}/auth/done#error=access_denied`);
    const unknown = await handler(req('/auth/google/callback?code=x&state=nope'));
    expect(unknown.headers.get('location')).toBe(`${APP}/auth/done#error=invalid_state`);

    const wrongAud = harness({}, () => jsonRes(200, { access_token: 'a', expires_in: 1 }));
    const s2 = await wrongAud.handler(req('/auth/google/start'));
    const st2 = new URL(s2.headers.get('location')!).searchParams.get('state')!;
    const cb2 = await wrongAud.handler(req(`/auth/google/callback?code=c&state=${st2}`));
    expect(cb2.headers.get('location')).toBe(`${APP}/auth/done#error=no_id_token`);

    const badToken = await g.idToken({}, { aud: 'someone-else' });
    const forged = harness({}, () => jsonRes(200, { access_token: 'a', expires_in: 1, id_token: badToken }));
    const s3 = await forged.handler(req('/auth/google/start'));
    const st3 = new URL(s3.headers.get('location')!).searchParams.get('state')!;
    const cb3 = await forged.handler(req(`/auth/google/callback?code=c&state=${st3}`));
    expect(cb3.headers.get('location')).toBe(`${APP}/auth/done#error=sign_in_failed`);

    const expired = harness({ now: () => new Date(Date.now() + 11 * 60_000) });
    const s4 = await handler(req('/auth/google/start'));
    const st4 = new URL(s4.headers.get('location')!).searchParams.get('state')!;
    const cb4 = await expired.handler(req(`/auth/google/callback?code=c&state=${st4}`));
    expect(cb4.headers.get('location')).toBe(`${APP}/auth/done#error=invalid_state`);
  });
});

describe('sessions (§11.2)', () => {
  it('me needs a valid token', async () => {
    const { handler } = harness();
    expect((await handler(req('/auth/me'))).status).toBe(401);
    expect((await handler(req('/auth/me', { token: 'not-a-jwt' }))).status).toBe(401);
    const { token, userId } = await signedIn();
    const r = await handler(req('/auth/me', { token }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { user: { id: string } }).user.id).toBe(userId);
  });

  it('refresh rotates the token: the old one stops working', async () => {
    const { handler } = harness();
    const { refreshToken } = await signedIn();
    const r1 = await handler(req('/auth/refresh', { body: { refreshToken } }));
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { accessToken: string; refreshToken: string };
    expect(b1.refreshToken).not.toBe(refreshToken);
    expect((await handler(req('/auth/refresh', { body: { refreshToken } }))).status).toBe(401);
    expect((await handler(req('/auth/me', { token: b1.accessToken }))).status).toBe(200);
  });

  it('logout ends the session for both tokens', async () => {
    const { handler } = harness();
    const { token, refreshToken } = await signedIn();
    expect((await handler(req('/auth/logout', { token, body: { refreshToken } }))).status).toBe(200);
    expect((await handler(req('/auth/me', { token }))).status).toBe(401);
    expect((await handler(req('/auth/refresh', { body: { refreshToken } }))).status).toBe(401);
  });

  it('an expired access token is refused', async () => {
    const later = harness({ now: () => new Date(Date.now() + 2 * 3600_000) });
    const { token } = await signedIn();
    expect((await later.handler(req('/auth/me', { token }))).status).toBe(401);
  });
});

describe('/sync/status', () => {
  it('reports counts, integrations with backfill progress, and pending jobs', async () => {
    const { handler } = harness();
    const { token, userId } = await signedIn();
    await t.db
      .sql`insert into orbit.people (user_id, display_name, name_norm) values (${userId}::uuid, 'Ann', 'ann')`;
    await t.db
      .sql`update orbit.integration_accounts set sync_state = ${{ gmail: { backfill: { phase: 'recent', done: 120, total: 1240, pageToken: 'p' } } }}::jsonb
      where user_id = ${userId}::uuid`;
    await t.db
      .sql`select orbit.enqueue('orbit_score', ${{ kind: 'score.user', userId, payload: {} }}::jsonb)`;
    const r = await handler(req('/sync/status', { token, body: {} }));
    const b = (await r.json()) as {
      counts: Record<string, number>;
      integrations: { provider: string; backfill: unknown }[];
      jobs: { pending: number };
    };
    expect(b.counts.people).toBe(1);
    expect(b.integrations[0]).toMatchObject({
      provider: 'google',
      backfill: { phase: 'recent', done: 120, total: 1240 },
    });
    expect(b.jobs.pending).toBe(1);
  });
});

describe('/sync/pull', () => {
  it('returns changed rows as camelCase, then nothing, then only what changed', async () => {
    const { handler } = harness();
    const { token, userId } = await signedIn();
    const [ann] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm, tags) values (${userId}::uuid, 'Ann Lee', 'ann lee', '{vc}')
      returning id`;
    await t.db
      .sql`insert into orbit.goals (user_id, kind, title) values (${userId}::uuid, 'fundraising', 'Pre-seed')`;

    const r1 = (await (await handler(req('/sync/pull', { token, body: {} }))).json()) as {
      changes: Record<string, Record<string, unknown>[]>;
      deleted: Record<string, string[]>;
      cursor: string;
      hasMore: boolean;
    };
    const annRow = r1.changes.people!.find((p) => p.id === ann!.id)!;
    expect(annRow).toMatchObject({
      displayName: 'Ann Lee',
      nameNorm: 'ann lee',
      tags: ['vc'],
      isSelf: false,
      userId,
    });
    expect(r1.changes.goals![0]).toMatchObject({
      kind: 'fundraising',
      title: 'Pre-seed',
      successMetric: null,
    });
    expect(r1.hasMore).toBe(false);

    const r2 = (await (
      await handler(req('/sync/pull', { token, body: { cursor: r1.cursor } }))
    ).json()) as typeof r1;
    expect(r2.changes).toEqual({});

    await t.db.sql`update orbit.people set title = 'Partner' where id = ${ann!.id}::uuid`;
    await t.db.sql`update orbit.goals set deleted_at = now() where user_id = ${userId}::uuid`;
    const r3 = (await (
      await handler(req('/sync/pull', { token, body: { cursor: r2.cursor } }))
    ).json()) as typeof r1;
    expect(r3.changes.people!.map((p) => p.title)).toEqual(['Partner']);
    expect(r3.deleted.goals).toHaveLength(1);
    expect(r3.changes.goals).toBeUndefined();
  });

  it('pages with limit and hasMore without skipping or repeating rows', async () => {
    const { handler } = harness();
    const { token, userId } = await signedIn();
    for (let i = 0; i < 7; i++)
      await t.db
        .sql`insert into orbit.organizations (user_id, name, name_norm) values (${userId}::uuid, ${`Org ${i}`}, ${`org ${i}`})`;
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = (await (
        await handler(req('/sync/pull', { token, body: { cursor, tables: ['organizations'], limit: 3 } }))
      ).json()) as { changes: { organizations?: { name: string }[] }; cursor: string; hasMore: boolean };
      seen.push(...(r.changes.organizations ?? []).map((o) => o.name));
      cursor = r.cursor;
      if (!r.hasMore) break;
    }
    expect(seen.sort()).toEqual(Array.from({ length: 7 }, (_, i) => `Org ${i}`));
  });

  it('shapes messages, ties and chats for the client, and keeps only recent networking mail', async () => {
    const { handler } = harness();
    const { token, userId } = await signedIn();
    const [a, b] = (
      await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm)
      values (${userId}::uuid, 'A', 'a'), (${userId}::uuid, 'B', 'b') returning id`
    )
      .map((r) => r.id)
      .sort();
    const [net] = await t.db.sql<{ id: string }>`
      insert into orbit.threads (user_id, provider, external_id, is_networking, last_at)
      values (${userId}::uuid, 'gmail', 'n1', true, now()) returning id`;
    const [noise] = await t.db.sql<{ id: string }>`
      insert into orbit.threads (user_id, provider, external_id, is_networking, last_at)
      values (${userId}::uuid, 'gmail', 'x1', false, now()) returning id`;
    await t.db
      .sql`insert into orbit.messages (user_id, thread_id, provider, external_id, direction, sent_at, from_addr, body_text)
      values (${userId}::uuid, ${net!.id}::uuid, 'gmail', 'm1', 'out', now(), 'me@example.com', 'hi'),
             (${userId}::uuid, ${net!.id}::uuid, 'gmail', 'm-old', 'in', now() - interval '200 days', 'a@example.com', 'old'),
             (${userId}::uuid, ${noise!.id}::uuid, 'gmail', 'm2', 'in', now(), 'promo@example.com', 'sale')`;
    await t.db.sql`insert into orbit.ties (user_id, a_person_id, b_person_id, kind, weight, confidence)
      values (${userId}::uuid, ${a}::uuid, ${b}::uuid, 'email_exchange', 0.6, 0.5)`;
    await t.db.sql`insert into orbit.chats (user_id, person_id, stage, data)
      values (${userId}::uuid, ${a}::uuid, 'warming', ${{ nextStep: 'send note', stage: 'ignored' }}::jsonb)`;
    const r = (await (await handler(req('/sync/pull', { token, body: {} }))).json()) as {
      changes: Record<string, Record<string, unknown>[]>;
    };
    expect(r.changes.threads!.map((x) => x.externalId)).toEqual(['n1']);
    expect(r.changes.messages!.map((m) => m.externalMessageId)).toEqual(['m1']);
    expect(r.changes.messages![0]).toMatchObject({
      direction: 'outbound',
      fromEmail: 'me@example.com',
      bodyText: 'hi',
    });
    expect(r.changes.messages![0]).not.toHaveProperty('embedding');
    expect(r.changes.ties![0]).toMatchObject({
      type: 'email_exchange',
      personAId: a,
      personBId: b,
      rawWeight: 0.6,
    });
    expect(r.changes.ties![0]!.weight).toBeCloseTo(0.3);
    expect(r.changes.chats![0]).toMatchObject({ nextStep: 'send note', stage: 'warming', personId: a });
  });

  it('never returns another user’s rows, and rejects a bad cursor or table', async () => {
    const { handler } = harness();
    const me = await signedIn();
    const other = await makeUser(t.db);
    await t.db
      .sql`insert into orbit.people (user_id, display_name, name_norm) values (${other}::uuid, 'Secret', 'secret')`;
    const r = (await (await handler(req('/sync/pull', { token: me.token, body: {} }))).json()) as {
      changes: Record<string, { displayName?: string }[]>;
    };
    expect((r.changes.people ?? []).map((p) => p.displayName)).not.toContain('Secret');
    expect((await handler(req('/sync/pull', { token: me.token, body: { cursor: 'zzz' } }))).status).toBe(400);
    expect((await handler(req('/sync/pull', { token: me.token, body: { tables: ['users'] } }))).status).toBe(
      400,
    );
    const forged = encodeCursor({ users: { t: '2020-01-01T00:00:00Z', k: '' } } as never);
    expect(() => decodeCursor(forged)).toThrow();
  });
});

describe('/sync/push', () => {
  const push = async (handler: (r: Request) => Promise<Response>, token: string, changes: unknown[]) =>
    (await (await handler(req('/sync/push', { token, body: { changes } }))).json()) as {
      results: {
        table: string;
        id: string;
        ok: boolean;
        row?: Record<string, unknown>;
        error?: { code: string };
      }[];
    };

  it('creates, edits and soft-deletes goals, auditing each change', async () => {
    const { handler } = harness();
    const { token, userId } = await signedIn();
    const id = crypto.randomUUID();
    const r1 = await push(handler, token, [
      {
        table: 'goals',
        op: 'upsert',
        id,
        row: { kind: 'recruiting', title: 'PM internship', priority: 1, junk: 'x' },
      },
    ]);
    expect(r1.results[0]).toMatchObject({
      ok: true,
      row: { id, kind: 'recruiting', title: 'PM internship', priority: 1 },
    });
    const r2 = await push(handler, token, [{ table: 'goals', op: 'upsert', id, row: { status: 'paused' } }]);
    expect(r2.results[0]!.row).toMatchObject({ status: 'paused', title: 'PM internship' });
    const bad = await push(handler, token, [
      {
        table: 'goals',
        op: 'upsert',
        id: crypto.randomUUID(),
        row: { kind: 'world-domination', title: 'x' },
      },
      { table: 'goals', op: 'upsert', id: crypto.randomUUID(), row: { kind: 'sales' } },
    ]);
    expect(bad.results.map((x) => x.error?.code)).toEqual(['invalid', 'invalid']);
    await push(handler, token, [{ table: 'goals', op: 'delete', id }]);
    const [g1] = await t.db.sql<{
      deleted_at: Date | null;
    }>`select deleted_at from orbit.goals where id = ${id}::uuid`;
    expect(g1!.deleted_at).not.toBeNull();
    const audit = await t.db.sql<{ action: string }>`
      select action from orbit.audit_log where user_id = ${userId}::uuid and target_id = ${id} order by id`;
    expect(audit.map((a) => a.action)).toEqual(['sync.insert', 'sync.update', 'sync.delete']);
  });

  it('checks ownership: another user’s rows and references are not found', async () => {
    const { handler } = harness();
    const me = await signedIn();
    const other = await signedIn();
    const [theirs] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm) values (${other.userId}::uuid, 'X', 'x') returning id`;
    const [theirGoal] = await t.db.sql<{ id: string }>`
      insert into orbit.goals (user_id, kind, title) values (${other.userId}::uuid, 'sales', 'Theirs') returning id`;
    const r = await push(handler, me.token, [
      {
        table: 'chats',
        op: 'upsert',
        id: crypto.randomUUID(),
        row: { personId: theirs!.id, stage: 'identified' },
      },
      { table: 'goals', op: 'upsert', id: theirGoal!.id, row: { title: 'Mine now' } },
      { table: 'goals', op: 'delete', id: theirGoal!.id },
      { table: 'people', op: 'upsert', id: theirs!.id, row: { displayName: 'Hijack' } },
    ]);
    expect(r.results.map((x) => x.error?.code)).toEqual(['not_found', 'not_found', 'not_found', 'not_found']);
    const [still] = await t.db.sql<{
      title: string;
    }>`select title from orbit.goals where id = ${theirGoal!.id}::uuid`;
    expect(still!.title).toBe('Theirs');
  });

  it('edits only the manual fields of people, and ignores insert-only fields on update', async () => {
    const { handler } = harness();
    const { token, userId } = await signedIn();
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm, strength, title) values (${userId}::uuid, 'Ann', 'ann', 0.4, 'PM') returning id`;
    const r = await push(handler, token, [
      {
        table: 'people',
        op: 'upsert',
        id: p!.id,
        row: {
          displayName: 'Ann Lee',
          tags: ['mentor'],
          doNotContact: true,
          strength: 1,
          summary: 'x',
          title: 'CEO',
          primaryEmail: 'ann@example.com',
        },
      },
    ]);
    expect(r.results[0]!.row).toMatchObject({
      displayName: 'Ann Lee',
      nameNorm: 'ann lee',
      tags: ['mentor'],
      doNotContact: true,
      strength: 0.4,
      title: 'PM',
      currentTitle: 'PM',
      primaryEmail: null,
    });
    expect(r.results[0]!.row!.summary).toBeNull();
    const ids = await t.db.sql`select 1 from orbit.person_identities where person_id = ${p!.id}::uuid`;
    expect(ids).toHaveLength(0);
    // only insert-only fields: nothing changes, nothing is refused
    const only = await push(handler, token, [
      { table: 'people', op: 'upsert', id: p!.id, row: { title: 'CEO' } },
    ]);
    expect(only.results[0]).toMatchObject({ ok: true, row: { title: 'PM' } });
  });

  it('creates a person added in the app, with derived name_norm and sources and their identities', async () => {
    const { handler } = harness();
    const { token, userId } = await signedIn();
    const id = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const r = await push(handler, token, [
      {
        table: 'people',
        op: 'upsert',
        id,
        row: {
          displayName: 'Liz Chen',
          primaryEmail: 'Liz.Chen@Example.com',
          title: 'Product Lead',
          orgRaw: 'Stripe',
          linkedinUrl: 'https://www.linkedin.com/in/liz-chen-42/',
          location: 'San Francisco',
          tags: ['fintech'],
          sources: ['gmail'],
          strength: 1,
        },
      },
      // a chat that points at the new person, in the same push
      { table: 'chats', op: 'upsert', id: chatId, row: { personId: id, stage: 'identified' } },
    ]);
    expect(r.results.map((x) => x.ok)).toEqual([true, true]);
    expect(r.results[0]!.row).toMatchObject({
      id,
      displayName: 'Liz Chen',
      firstName: 'Liz',
      lastName: 'Chen',
      nameNorm: 'liz chen',
      nameNormalized: 'liz chen',
      primaryEmail: 'liz.chen@example.com',
      title: 'Product Lead',
      currentTitle: 'Product Lead',
      orgRaw: 'Stripe',
      currentOrganizationRaw: 'Stripe',
      linkedinUrl: 'https://www.linkedin.com/in/liz-chen-42/',
      linkedinSlug: 'liz-chen-42',
      location: 'San Francisco',
      sources: ['manual'],
      tags: ['fintech'],
      strength: 0,
      isSelf: false,
    });
    const ids = await t.db.sql<{ kind: string; value_norm: string; source: string }>`
      select kind, value_norm, source from orbit.person_identities where person_id = ${id}::uuid order by kind`;
    expect(ids).toEqual([
      { kind: 'email', value_norm: 'liz.chen@example.com', source: 'manual' },
      { kind: 'linkedin_slug', value_norm: 'liz-chen-42', source: 'manual' },
    ]);
    // a rename re-derives name_norm and leaves the rest alone
    const renamed = await push(handler, token, [
      { table: 'people', op: 'upsert', id, row: { displayName: 'Elizabeth Chen', title: 'CEO' } },
    ]);
    expect(renamed.results[0]!.row).toMatchObject({
      nameNorm: 'elizabeth chen',
      firstName: 'Liz',
      title: 'Product Lead',
      sources: ['manual'],
    });
    const audit = await t.db.sql<{ action: string }>`
      select action from orbit.audit_log where user_id = ${userId}::uuid and target_id = ${id} order by id`;
    expect(audit.map((a) => a.action)).toEqual(['sync.insert', 'sync.update']);
  });

  it('keeps identities unique: a second person with a known email is created without taking it', async () => {
    const { handler } = harness();
    const { token } = await signedIn();
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const r = await push(handler, token, [
      { table: 'people', op: 'upsert', id: a, row: { displayName: 'Sam Lee', primaryEmail: 'sam@ramp.com' } },
      {
        table: 'people',
        op: 'upsert',
        id: b,
        row: { displayName: 'Samuel Lee', primaryEmail: 'sam@ramp.com' },
      },
      { table: 'people', op: 'upsert', id: crypto.randomUUID(), row: { tags: ['x'] } },
      {
        table: 'people',
        op: 'upsert',
        id: crypto.randomUUID(),
        row: { displayName: 'Bad Email', primaryEmail: 'not an email' },
      },
    ]);
    expect(r.results.map((x) => x.ok)).toEqual([true, true, false, false]);
    expect(r.results.map((x) => x.error?.code ?? null)).toEqual([null, null, 'invalid', 'invalid']);
    const owners = await t.db.sql<{ person_id: string }>`
      select person_id from orbit.person_identities where kind = 'email' and value_norm = 'sam@ramp.com'`;
    expect(owners.map((o) => o.person_id)).toEqual([a]);
  });

  it('pushes uploads (a resume with its parsed facets) and hard-deletes them', async () => {
    const { handler } = harness();
    const { token, userId } = await signedIn();
    const id = crypto.randomUUID();
    const r = await push(handler, token, [
      {
        table: 'uploads',
        op: 'upsert',
        id,
        row: {
          kind: 'resume',
          filename: 'resume.pdf',
          text: 'Maya Lin\nCornell University, BS Computer Science',
          parsed: { facets: [{ kind: 'education', organizationName: 'Cornell University' }] },
          isCurrent: true,
        },
      },
      { table: 'uploads', op: 'upsert', id: crypto.randomUUID(), row: { kind: 'resume' } },
      {
        table: 'uploads',
        op: 'upsert',
        id: crypto.randomUUID(),
        row: { kind: 'photo', text: 'x' },
      },
      {
        table: 'uploads',
        op: 'upsert',
        id: crypto.randomUUID(),
        row: { kind: 'note', text: 'x'.repeat(500_001) },
      },
      {
        table: 'uploads',
        op: 'upsert',
        id: crypto.randomUUID(),
        row: { kind: 'note', text: 'x', parsed: { big: 'y'.repeat(200_001) } },
      },
    ]);
    expect(r.results.map((x) => x.error?.code ?? 'ok')).toEqual([
      'ok',
      'invalid',
      'invalid',
      'invalid',
      'invalid',
    ]);
    expect(r.results[0]!.row).toMatchObject({ id, kind: 'resume', filename: 'resume.pdf', isCurrent: true });
    const later = await push(handler, token, [
      { table: 'uploads', op: 'upsert', id, row: { isCurrent: false } },
    ]);
    expect(later.results[0]!.row).toMatchObject({ isCurrent: false, kind: 'resume' });
    const first = (await (
      await handler(req('/sync/pull', { token, body: { tables: ['uploads'] } }))
    ).json()) as {
      changes: Record<string, Record<string, unknown>[]>;
      cursor: string;
    };
    expect(first.changes.uploads?.map((u) => u.id)).toEqual([id]);
    const del = await push(handler, token, [{ table: 'uploads', op: 'delete', id }]);
    expect(del.results[0]!.ok).toBe(true);
    expect(await t.db.sql`select 1 from orbit.uploads where user_id = ${userId}::uuid`).toHaveLength(0);
    const next = (await (
      await handler(req('/sync/pull', { token, body: { cursor: first.cursor, tables: ['uploads'] } }))
    ).json()) as { deleted: Record<string, string[]> };
    expect(next.deleted.uploads).toEqual([id]);
  });

  it('moves drafts only out of draft, and edits them only while they are drafts', async () => {
    const { handler } = harness();
    const { token, userId } = await signedIn();
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm) values (${userId}::uuid, 'Ann', 'ann') returning id`;
    const [d] = await t.db.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, channel, kind, subject, body)
      values (${userId}::uuid, ${p!.id}::uuid, 'gmail', 'first_touch', 'hi', 'Hello Ann') returning id`;
    const edit = await push(handler, token, [
      { table: 'drafts', op: 'upsert', id: d!.id, row: { body: 'Hi Ann, quick note', subject: 'coffee?' } },
    ]);
    expect(edit.results[0]!.row).toMatchObject({
      body: 'Hi Ann, quick note',
      subject: 'coffee?',
      status: 'draft',
    });
    const sent = await push(handler, token, [
      { table: 'drafts', op: 'upsert', id: d!.id, row: { status: 'sent' } },
    ]);
    expect(sent.results[0]!.error?.code).toBe('invalid');
    const ok = await push(handler, token, [
      { table: 'drafts', op: 'upsert', id: d!.id, row: { status: 'approved' } },
    ]);
    expect(ok.results[0]!.row).toMatchObject({ status: 'approved' });
    const late = await push(handler, token, [
      { table: 'drafts', op: 'upsert', id: d!.id, row: { body: 'changed' } },
    ]);
    expect(late.results[0]!.error?.code).toBe('conflict');
    const del = await push(handler, token, [{ table: 'drafts', op: 'delete', id: d!.id }]);
    expect(del.results[0]!.error?.code).toBe('not_allowed');
  });

  it('labels, notes and memories: hard deletes reach the next pull as deleted ids', async () => {
    const { handler } = harness();
    const { token, userId } = await signedIn();
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm) values (${userId}::uuid, 'Ann', 'ann') returning id`;
    const [m] = await t.db.sql<{ id: string }>`
      insert into orbit.memories (user_id, kind, text, source) values (${userId}::uuid, 'preference', 'Likes mornings', 'chat')
      returning id`;
    const noteId = crypto.randomUUID();
    const r = await push(handler, token, [
      { table: 'tie_labels', op: 'upsert', id: p!.id, row: { closeness: 4 } },
      { table: 'tie_labels', op: 'upsert', id: p!.id, row: { closeness: 9 } },
      {
        table: 'notes',
        op: 'upsert',
        id: noteId,
        row: {
          source: 'chat',
          occurredAt: new Date().toISOString(),
          rawText: 'Met at the fair',
          personIds: [p!.id],
        },
      },
      { table: 'memories', op: 'upsert', id: m!.id, row: { text: 'x' } },
    ]);
    expect(r.results.map((x) => x.ok)).toEqual([true, false, true, false]);
    const first = (await (await handler(req('/sync/pull', { token, body: {} }))).json()) as {
      changes: Record<string, unknown[]>;
      cursor: string;
    };
    expect(first.changes.tie_labels).toHaveLength(1);
    const d = await push(handler, token, [
      { table: 'tie_labels', op: 'delete', id: p!.id },
      { table: 'notes', op: 'delete', id: noteId },
      { table: 'memories', op: 'delete', id: m!.id },
    ]);
    expect(d.results.every((x) => x.ok)).toBe(true);
    expect(await t.db.sql`select 1 from orbit.memories where id = ${m!.id}::uuid`).toHaveLength(0);
    const next = (await (
      await handler(req('/sync/pull', { token, body: { cursor: first.cursor } }))
    ).json()) as {
      deleted: Record<string, string[]>;
    };
    expect(next.deleted).toMatchObject({ tie_labels: [p!.id], notes: [noteId] });
  });

  it('refuses tables the app may not write and malformed changes', async () => {
    const { handler } = harness();
    const { token } = await signedIn();
    const r = await push(handler, token, [
      { table: 'messages', op: 'upsert', id: crypto.randomUUID(), row: {} },
      { table: 'goals', op: 'upsert', id: 'not-a-uuid', row: {} },
    ]);
    expect(r.results.map((x) => x.error?.code)).toEqual(['not_allowed', 'invalid']);
    const tooMany = await handler(
      req('/sync/push', { token, body: { changes: Array.from({ length: 501 }, () => ({})) } }),
    );
    expect(tooMany.status).toBe(400);
  });
});

describe('/account', () => {
  it('exports the user’s rows without secrets', async () => {
    const { handler } = harness();
    const { token, userId } = await signedIn();
    const r = await handler(req('/account/export', { token, body: {} }));
    expect(r.status).toBe(200);
    const b = (await r.json()) as { data: Record<string, Record<string, unknown>[]> };
    expect(b.data.users![0]!.id).toBe(userId);
    expect(b.data.people).toHaveLength(1);
    expect(b.data.sessions![0]).not.toHaveProperty('refresh_hash');
    expect(b.data.integration_accounts![0]).not.toHaveProperty('token_secret_id');
    expect(b.data).not.toHaveProperty('login_codes');
    expect(JSON.stringify(b)).not.toContain('refresh-placeholder');
  });

  it('deletes only with confirmation, cleans up at the providers, and leaves nothing behind', async () => {
    const { handler, calls } = harness();
    const { token, userId } = await signedIn();
    await t.db.sql`insert into orbit.integration_accounts (user_id, provider, external_account_id)
      values (${userId}::uuid, 'linkedin', 'acc_123')`;
    expect((await handler(req('/account/delete', { token, body: {} }))).status).toBe(400);
    const r = await handler(req('/account/delete', { token, body: { confirm: 'DELETE' } }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { cleanup: unknown }).cleanup).toEqual({
      gmailStop: 'done',
      googleRevoke: 'done',
      unipile: 'done',
    });
    const urls = calls.map((c) => `${c.method} ${c.url}`);
    expect(urls).toContain('POST https://gmail.googleapis.com/gmail/v1/users/me/stop');
    expect(urls).toContain('POST https://oauth2.googleapis.com/revoke');
    expect(urls).toContain('DELETE https://unipile.test/api/v1/accounts/acc_123');
    expect(await t.db.sql`select 1 from orbit.users where id = ${userId}::uuid`).toHaveLength(0);
    expect(
      await t.db.sql`select 1 from vault.secrets where name = ${`google_refresh:${userId}`}`,
    ).toHaveLength(0);
    expect((await handler(req('/auth/me', { token }))).status).toBe(401);
  });
});

describe('/sync/pull parameters', () => {
  it('sends only real dates for timestamptz, as postgres.js needs (a table never pulled starts in 1970)', async () => {
    const seen: unknown[][] = [];
    const db = {
      query: async (_text: string, params: unknown[] = []) => {
        seen.push(params);
        return [];
      },
      sql: async () => [],
      begin: async () => {
        throw new Error('unused');
      },
    };
    await pull(db as never, '00000000-0000-4000-8000-000000000001', {
      cursor: {},
      tables: PULL_TABLES,
      limit: 10,
      upTo: new Date(),
    });
    expect(seen).toHaveLength(PULL_TABLES.length);
    // postgres.js serializes a timestamptz parameter with new Date(x).toISOString(), which throws on '-infinity'
    for (const p of seen)
      for (const i of [1, 3]) expect(() => new Date(p[i] as string).toISOString()).not.toThrow();
  });
});
