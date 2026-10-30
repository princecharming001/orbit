/** The integration routes of orbit-api (§12.3): Google sync, LinkedIn hosted auth, status and sync. */
import type { LinkedinStatusResponse, QueuedResponse } from '@orbit/core/server/api';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { accountToken as sharedAccountToken } from '../../functions/_shared/accountToken.ts';
import { memoryTake } from '../../functions/_shared/ratelimit.ts';
import { createSession } from '../../functions/_shared/session.ts';
import { type ApiDeps, makeApiHandler } from '../../functions/orbit-api/api.ts';
import { upsertGoogleUser } from '../../functions/orbit-api/auth.ts';
import { accountToken as connectorsAccountToken } from '../../functions/orbit-connectors/connectors.ts';
import { FakeUnipile } from '../helpers/fakeApis.ts';
import { CLIENT_ID } from '../helpers/google.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

const BASE = 'https://ref.supabase.co/functions/v1/orbit-api';
const APP = 'https://princecharming001.github.io/orbit';
const SECRET = 'c2Vzc2lvbi1zZWNyZXQtcGxhY2Vob2xkZXItMzItYnl0ZXMhIQ==';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

function api(over: Partial<ApiDeps['env']> = {}) {
  const unipile = new FakeUnipile();
  const handler = makeApiHandler({
    env: {
      googleClientId: CLIENT_ID,
      googleClientSecret: 'client-secret-placeholder',
      googleRedirectUri: `${BASE}/auth/google/callback`,
      sessionSecret: SECRET,
      appUrl: APP,
      unipileKey: 'unipile-placeholder',
      unipileBase: 'https://api.unipile.test',
      unipileWebhookSecret: 'unipile-hook-placeholder',
      ...over,
    },
    db: t.db,
    fetch: unipile.fetch,
    take: memoryTake(),
  });
  return { handler, unipile };
}

async function signedIn(scopes: string[]) {
  const sub = `s-${Math.random()}`;
  const userId = (await upsertGoogleUser(t.db, {
    sub,
    email: `${sub}@example.com`,
    name: 'Test User',
    scopes,
    refreshToken: 'refresh-placeholder',
  }))!;
  const tokens = await createSession(t.db, { secret: SECRET }, userId);
  return { userId, token: tokens.accessToken };
}

const post = (path: string, token: string, body: unknown = {}) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const queued = (userId: string) =>
  t.db.sql<{ kind: string; payload: Record<string, unknown> }>`
    select message->>'kind' as kind, message->'payload' as payload from pgmq.q_orbit_sync
     where message->>'userId' = ${userId} order by msg_id`;

describe('/google/sync', () => {
  it('queues an incremental sync (and the calendar), once per window', async () => {
    const { handler } = api();
    const { userId, token } = await signedIn([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ]);
    await t.db.sql`delete from pgmq.q_orbit_sync`;
    const r = await handler(post('/google/sync', token, { mode: 'incremental' }));
    expect(await r.json()).toEqual({ queued: true } satisfies QueuedResponse);
    expect((await queued(userId)).map((j) => j.kind)).toEqual(['sync.gmail.incremental', 'sync.calendar']);
    const again = await handler(post('/google/sync', token, { mode: 'incremental' }));
    expect(await again.json()).toEqual({ queued: false, reason: 'already_running' });
  });

  it('a backfill is refused while one runs and restarts one that completed', async () => {
    const { handler } = api();
    const { userId, token } = await signedIn(['https://www.googleapis.com/auth/gmail.readonly']);
    await t.db
      .sql`update orbit.integration_accounts set sync_state = '{"gmail":{"backfill":{"phase":"deep"}}}'::jsonb
      where user_id = ${userId}::uuid and provider = 'google'`;
    expect(await (await handler(post('/google/sync', token, { mode: 'backfill' }))).json()).toEqual({
      queued: false,
      reason: 'already_running',
    });
    await t.db
      .sql`update orbit.integration_accounts set sync_state = '{"gmail":{"backfill":{"phase":"complete"}}}'::jsonb
      where user_id = ${userId}::uuid and provider = 'google'`;
    expect(await (await handler(post('/google/sync', token, { mode: 'backfill' }))).json()).toEqual({
      queued: true,
    });
    const jobs = (await queued(userId)).filter((j) => j.kind === 'sync.gmail.backfill');
    expect(jobs.at(-1)!.payload).toEqual({ phase: 'recent', restart: true });
    expect((await handler(post('/google/sync', token, { mode: 'everything' }))).status).toBe(400);
  });

  it('says not_connected without Gmail access', async () => {
    const { handler } = api();
    const { token } = await signedIn(['openid']);
    expect(await (await handler(post('/google/sync', token, {}))).json()).toEqual({
      queued: false,
      reason: 'not_connected',
    });
  });
});

describe('/linkedin/*', () => {
  it('connect/start asks Unipile for a hosted link named after the user, notifying orbit-webhooks', async () => {
    const { handler, unipile } = api();
    const { userId, token } = await signedIn(['openid']);
    const r = await handler(post('/linkedin/connect/start', token));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ url: 'https://account.unipile.test/hosted/abc' });
    expect(unipile.calls).toEqual(['POST https://api.unipile.test/api/v1/hosted/accounts/link']);
    const status = await handler(post('/linkedin/status', token));
    expect(await status.json()).toEqual({
      status: 'connecting',
      accountId: null,
      lastSyncedAt: null,
      relations: 0,
    } satisfies LinkedinStatusResponse);
    // the request body (read back through a recording fetch)
    let body: Record<string, unknown> = {};
    const h2 = makeApiHandler({
      env: {
        sessionSecret: SECRET,
        appUrl: APP,
        unipileKey: 'k',
        unipileBase: 'https://api.unipile.test/',
        unipileWebhookSecret: 'unipile-hook-placeholder',
        functionsUrl: 'https://ref.supabase.co/functions/v1',
      },
      db: t.db,
      take: memoryTake(),
      fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ url: 'https://u.test/x' }), { status: 201 });
      }) as typeof fetch,
    });
    await h2(post('/linkedin/connect/start', token));
    expect(body).toMatchObject({
      type: 'create',
      providers: ['LINKEDIN'],
      api_url: 'https://api.unipile.test',
      name: userId,
      notify_url:
        'https://ref.supabase.co/functions/v1/orbit-webhooks/unipile/account?token=unipile-hook-placeholder',
      success_redirect_url: `${APP}/settings?linkedin=connected`,
    });
    expect(Date.parse(String(body.expiresOn))).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it('answers unconfigured without Unipile', async () => {
    const { handler } = api({ unipileKey: undefined });
    const { token } = await signedIn(['openid']);
    const r = await handler(post('/linkedin/connect/start', token));
    expect(r.status).toBe(503);
    expect(r.headers.get('x-orbit-connector')).toBe('unconfigured');
    expect(((await r.json()) as { error: { missing: string[] } }).error.missing).toEqual(['UNIPILE_API_KEY']);
    expect((await handler(post('/linkedin/sync', token))).status).toBe(503);
  });

  it('picks up a Unipile key stored after the function started, without a new isolate', async () => {
    const unipile = new FakeUnipile();
    let stored: string | undefined;
    const handler = makeApiHandler({
      env: {
        sessionSecret: SECRET,
        appUrl: APP,
        unipileBase: 'https://api.unipile.test',
        unipileWebhookSecret: 'unipile-hook-placeholder',
      },
      db: t.db,
      fetch: unipile.fetch,
      take: memoryTake(),
      refreshProviderSecrets: async () => ({ unipileKey: stored, unipileBase: undefined }),
    });
    const { token } = await signedIn(['openid']);
    expect((await handler(post('/linkedin/sync', token))).status).toBe(503);
    // stored now; the next lookup is at most a minute later
    stored = 'unipile-placeholder';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    try {
      expect((await handler(post('/linkedin/sync', token))).status).not.toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });

  it('status counts relations; sync queues the LinkedIn job once connected', async () => {
    const { handler } = api();
    const { userId, token } = await signedIn(['openid']);
    expect(await (await handler(post('/linkedin/sync', token))).json()).toEqual({
      queued: false,
      reason: 'not_connected',
    });
    await t.db
      .sql`insert into orbit.integration_accounts (user_id, provider, external_account_id, status, last_synced_at)
      values (${userId}::uuid, 'linkedin', 'acc-1', 'active', now())`;
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm) values (${userId}::uuid, 'Jo Park', 'jo park') returning id`;
    await t.db.sql`insert into orbit.person_identities (user_id, person_id, kind, value_norm, source)
      values (${userId}::uuid, ${p!.id}::uuid, 'linkedin_member', 'ACoJo', 'linkedin_relation')`;
    const s = (await (await handler(post('/linkedin/status', token))).json()) as LinkedinStatusResponse;
    expect(s).toMatchObject({ status: 'active', accountId: 'acc-1', relations: 1 });
    expect(s.lastSyncedAt).not.toBeNull();
    expect(await (await handler(post('/linkedin/sync', token))).json()).toEqual({ queued: true });
    expect((await queued(userId)).map((j) => j.kind)).toEqual(['sync.linkedin']);
  });
});

describe('/linkedin/search', () => {
  it("finds people on the student's LinkedIn with photo and headline, and stops at the day's cap", async () => {
    const { userId, token } = await signedIn(['https://www.googleapis.com/auth/gmail.readonly']);
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const handler = makeApiHandler({
      env: { sessionSecret: SECRET, appUrl: APP, unipileKey: 'k', unipileBase: 'https://api.unipile.test' },
      db: t.db,
      take: memoryTake(),
      fetch: (async (u: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(u), body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'ACo1',
                name: 'Priya Shah',
                headline: 'Analyst at Evercore',
                profile_picture_url: 'https://media.licdn.com/p.jpg',
                public_profile_url: 'https://www.linkedin.com/in/priya-shah',
                network_distance: 'DISTANCE_2',
              },
              { id: 'ACo2', name: '' },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    const search = async (q: string) =>
      (await (await handler(post('/linkedin/search', token, { q }))).json()) as {
        ok: boolean;
        reason?: string;
        people?: unknown[];
      };
    expect(await search('Priya')).toEqual({ ok: false, reason: 'not_connected' });
    await t.db.sql`
      insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
      values (${userId}::uuid, 'linkedin', 'acc-9', 'active')`;
    expect(await search('Priya Shah')).toEqual({
      ok: true,
      people: [
        {
          memberId: 'ACo1',
          name: 'Priya Shah',
          headline: 'Analyst at Evercore',
          profileUrl: 'https://www.linkedin.com/in/priya-shah',
          pictureUrl: 'https://media.licdn.com/p.jpg',
          distance: 2,
        },
      ],
    });
    expect(calls[0]!.url).toContain('/api/v1/linkedin/search?account_id=acc-9');
    expect(calls[0]!.body).toMatchObject({ api: 'classic', category: 'people', keywords: 'Priya Shah' });
    // a day's searches are capped: a typed name settles into one, never one per key
    await t.db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table)
      select ${userId}::uuid, 'user', 'linkedin.search', 'people' from generate_series(1, 80)`;
    expect(await search('Priya')).toEqual({ ok: false, reason: 'limit' });
  });
});

describe('/linkedin/reader', () => {
  it('hands the student their own LinkedIn account and the token orbit-connectors checks', async () => {
    const { userId, token } = await signedIn(['https://www.googleapis.com/auth/gmail.readonly']);
    const handler = makeApiHandler({
      env: { sessionSecret: SECRET, appUrl: APP, connectorsSigningKey: 'signing-placeholder' },
      db: t.db,
      take: memoryTake(),
    });
    const reader = async () =>
      (await (await handler(post('/linkedin/reader', token, { accountId: 'someone-else' }))).json()) as {
        ok: boolean;
        reason?: string;
        accountId?: string;
        token?: string;
      };
    expect(await reader()).toEqual({ ok: false, reason: 'not_connected' });
    await t.db.sql`
      insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
      values (${userId}::uuid, 'linkedin', 'acc-reader', 'active')`;
    // their own account only, whatever the request names, signed exactly as orbit-connectors signs it
    expect(await reader()).toEqual({
      ok: true,
      accountId: 'acc-reader',
      token: await connectorsAccountToken('acc-reader', 'signing-placeholder'),
    });
    expect(await sharedAccountToken('acc-reader', 'signing-placeholder')).toBe(
      await connectorsAccountToken('acc-reader', 'signing-placeholder'),
    );
  });

  it('says so when the signing key is not set', async () => {
    const { userId, token } = await signedIn(['https://www.googleapis.com/auth/gmail.readonly']);
    await t.db.sql`
      insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
      values (${userId}::uuid, 'linkedin', 'acc-x', 'active')`;
    const handler = makeApiHandler({
      env: { sessionSecret: SECRET, appUrl: APP },
      db: t.db,
      take: memoryTake(),
    });
    expect(await (await handler(post('/linkedin/reader', token))).json()).toEqual({
      ok: false,
      reason: 'unconfigured',
    });
  });
});

describe('/sync/status', () => {
  it('reports backfill progress', async () => {
    const { handler } = api();
    const { userId, token } = await signedIn(['https://www.googleapis.com/auth/gmail.readonly']);
    await t.db.sql`update orbit.integration_accounts
      set sync_state = '{"gmail":{"backfill":{"phase":"deep","done":250,"total":4000}}}'::jsonb
      where user_id = ${userId}::uuid and provider = 'google'`;
    const r = (await (await handler(post('/sync/status', token))).json()) as {
      integrations: { provider: string; backfill: unknown }[];
    };
    expect(r.integrations.find((i) => i.provider === 'google')!.backfill).toEqual({
      phase: 'deep',
      done: 250,
      total: 4000,
    });
  });

  it("says when LinkedIn's first pass is still bringing connections in", async () => {
    const { handler } = api();
    const { userId, token } = await signedIn(['https://www.googleapis.com/auth/gmail.readonly']);
    const status = async (state: Record<string, unknown>) => {
      await t.db.sql`
        insert into orbit.integration_accounts (user_id, provider, external_account_id, status, sync_state)
        values (${userId}::uuid, 'linkedin', 'acc-1', 'active', ${{ linkedin: state }}::jsonb)
        on conflict (user_id, provider) do update set sync_state = excluded.sync_state`;
      const r = (await (await handler(post('/sync/status', token))).json()) as {
        integrations: { provider: string; importing?: boolean }[];
      };
      return r.integrations.find((i) => i.provider === 'linkedin')!.importing;
    };
    expect(await status({ stage: 'relations', cursor: 'c2' })).toBe(true);
    expect(await status({ stage: 'chats', chatIndex: 3 })).toBe(true);
    // a later refresh walks known people again: that is not people arriving
    expect(await status({ stage: 'relations', syncedAt: '2026-10-29T10:00:00Z' })).toBe(false);
    expect(await status({ stage: 'done', syncedAt: '2026-10-29T10:00:00Z' })).toBe(false);
  });
});
