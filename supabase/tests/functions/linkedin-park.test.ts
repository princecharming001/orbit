/**
 * Plan 35 E1 and E5 on PGlite with a fake Unipile (no network): the reconciler only reads the shared account list and
 * keeps Osmo's accounts apart from Orbit's orphans; parking picks only idle students with nothing waiting and autopilot
 * off; a parked link is passed over by the poll, webhooks and sends; reconnecting reuses the row and resumes from the
 * last finished pass without doubling anything.
 */
import type { LinkedinStatusResponse } from '@orbit/core/server/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sqlQueue } from '../../functions/_shared/queue.ts';
import { memoryTake } from '../../functions/_shared/ratelimit.ts';
import { createSession } from '../../functions/_shared/session.ts';
import { makeApiHandler } from '../../functions/orbit-api/api.ts';
import { upsertGoogleUser } from '../../functions/orbit-api/auth.ts';
import { unipileAccount, unipileEvent } from '../../functions/orbit-webhooks/webhooks.ts';
import { type CostDigest, costHandlers } from '../../functions/orbit-worker/handlers/cost.ts';
import {
  classifyAccounts,
  parkDays,
  type ReconcileReport,
} from '../../functions/orbit-worker/handlers/unipile.ts';
import { defaultHandlers } from '../../functions/orbit-worker/worker.ts';
import {
  UNIPILE as AGENT_UNIPILE,
  addPerson,
  api,
  fakeNet,
  jsonRes,
  signedInUser,
} from '../helpers/agents.ts';
import { FakeUnipile, virtualTime } from '../helpers/fakeApis.ts';
import { clearQueues, drain, jobRuns } from '../helpers/ingest.ts';
import { freshDb, makeUser, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});
beforeEach(async () => {
  await clearQueues(t);
  await t.pg.exec(`
    delete from orbit.audit_log where action in ('unipile.reconcile', 'linkedin.park', 'linkedin.parked',
      'linkedin.unparked', 'linkedin.connected', 'cost.digest');
    delete from public.orbit_unipile_links;
    delete from orbit.users;
  `);
});

const BASE = 'https://api.unipile.test';
const UNIPILE = { apiKey: 'unipile-key-placeholder', baseUrl: BASE };

interface FakeAccount {
  id: string;
  type: string;
  name: string;
  created_at?: string;
}

/** Unipile's /accounts routes over an in-memory list (pages of 2, to walk the cursor), with every call recorded. */
function fakeAccounts(accounts: FakeAccount[], sync = new FakeUnipile()) {
  const calls: string[] = [];
  const list = [...accounts];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    const u = new URL(url);
    const res = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/api/v1/accounts') {
      calls.push(`${method} /api/v1/accounts${u.search}`);
      const start = Number(u.searchParams.get('cursor') ?? 0);
      const items = list.slice(start, start + 2).map((a) => ({
        object: 'Account',
        ...a,
        created_at: a.created_at ?? '2026-10-22T10:00:00.000Z',
        connection_params: { im: { id: 'x', username: 'x' } },
        sources: [{ id: `${a.id}_MESSAGING`, status: 'OK' }],
      }));
      return res(200, {
        object: 'AccountList',
        items,
        cursor: start + 2 < list.length ? String(start + 2) : null,
      });
    }
    const one = /^\/api\/v1\/accounts\/([^/]+)$/.exec(u.pathname);
    if (one) {
      const id = decodeURIComponent(one[1]!);
      calls.push(`${method} /api/v1/accounts/${id}`);
      const i = list.findIndex((a) => a.id === id);
      if (i < 0) return res(404, { title: 'Not found', status: 404 });
      if (method === 'DELETE') {
        list.splice(i, 1);
        return res(200, { object: 'AccountDeleted' });
      }
      return res(200, { object: 'Account', ...list[i], sources: [{ status: 'OK' }] });
    }
    return sync.fetch(input, init);
  }) as typeof globalThis.fetch;
  return { fetch, calls, list, sync };
}

const handlersFor = (fetch: typeof globalThis.fetch, park?: { days?: number }) =>
  defaultHandlers({ fetch, unipile: UNIPILE, park, sleep: async () => {}, random: () => 0 });

const enqueue = (kind: string) => sqlQueue(t.db).enqueue({ kind, userId: null, payload: {} });

async function linkedinUser(o: {
  account: string;
  seenDaysAgo: number;
  settings?: Record<string, unknown>;
  autonomy?: number;
  synced?: boolean;
}) {
  const u = await makeUser(t.db, { settings: o.settings ?? {} });
  await t.db.sql`
    update orbit.users set last_seen_at = now() - make_interval(days => ${o.seenDaysAgo}),
           created_at = now() - interval '200 days', autonomy_level = ${o.autonomy ?? 0}
     where id = ${u}::uuid`;
  const state =
    o.synced === false
      ? {}
      : {
          linkedin: {
            stage: 'done',
            syncedAt: '2026-10-01T00:00:00.000Z',
            recentAt: '2026-10-05T00:00:00.000Z',
          },
        };
  await t.db.sql`
    insert into orbit.integration_accounts (user_id, provider, external_account_id, status, sync_state)
    values (${u}::uuid, 'linkedin', ${o.account}, 'active', ${state}::jsonb)`;
  return u;
}

const row = async (u: string) =>
  (
    await t.db.sql<{
      id: string;
      status: string;
      external_account_id: string | null;
      sync_state: { linkedin?: Record<string, unknown> };
    }>`
      select id, status, external_account_id, sync_state from orbit.integration_accounts
       where user_id = ${u}::uuid and provider = 'linkedin'`
  )[0]!;

describe('unipile.reconcile (E1)', () => {
  it('reads the account list page by page, never deletes, and keeps other products apart from Orbit orphans', async () => {
    const live = await linkedinUser({ account: 'acc-live', seenDaysAgo: 1 });
    const gone = await linkedinUser({ account: 'acc-missing', seenDaysAgo: 1 });
    const orphanOwner = await makeUser(t.db);
    await t.db
      .sql`insert into public.orbit_unipile_links (ref, account_id) values ('orbit_ref-old', 'acc-linked')`;
    const net = fakeAccounts([
      { id: 'acc-live', type: 'LINKEDIN', name: live },
      { id: 'acc-orphan-user', type: 'LINKEDIN', name: orphanOwner, created_at: '2026-10-22T09:00:00.000Z' },
      { id: 'acc-orphan-ref', type: 'LINKEDIN', name: 'orbit_6f1c2d3e-aaaa-bbbb-cccc-1234567890ab' },
      { id: 'acc-linked', type: 'LINKEDIN', name: 'something else' },
      { id: 'acc-osmo-li', type: 'LINKEDIN', name: 'osmo-anish', created_at: '2026-07-10T09:00:00.000Z' },
      { id: 'acc-osmo-uuid', type: 'LINKEDIN', name: '0b0b0b0b-1111-2222-3333-444444444444' },
      { id: 'acc-osmo-ig', type: 'INSTAGRAM', name: 'osmo-ig' },
      { id: 'acc-osmo-wa', type: 'WHATSAPP', name: 'osmo-wa' },
    ]);
    await enqueue('unipile.reconcile');
    await drain(t, handlersFor(net.fetch), () => new Date());

    // only GETs of the list, four pages by cursor; nothing deleted, nothing read one by one
    expect(net.calls).toEqual([
      'GET /api/v1/accounts?limit=250',
      'GET /api/v1/accounts?limit=250&cursor=2',
      'GET /api/v1/accounts?limit=250&cursor=4',
      'GET /api/v1/accounts?limit=250&cursor=6',
    ]);
    expect(net.list).toHaveLength(8);
    const [audit] = await t.db.sql<{ details: ReconcileReport }>`
      select details from orbit.audit_log where action = 'unipile.reconcile'`;
    const r = audit!.details;
    expect(r.total).toBe(8);
    expect(r.byType).toEqual({ LINKEDIN: 6, INSTAGRAM: 1, WHATSAPP: 1 });
    expect(r.orbitLinked).toBe(1);
    expect(r.missingAtUnipile).toEqual(['acc-missing']);
    expect(r.orbitOrphans).toEqual([
      {
        id: 'acc-orphan-user',
        createdAt: '2026-10-22T09:00:00.000Z',
        status: 'OK',
        reason: 'user_id',
        userId: orphanOwner,
      },
      { id: 'acc-orphan-ref', createdAt: '2026-10-22T10:00:00.000Z', status: 'OK', reason: 'orbit_ref' },
      { id: 'acc-linked', createdAt: '2026-10-22T10:00:00.000Z', status: 'OK', reason: 'link_record' },
    ]);
    expect(r.orbitOrphanCount).toBe(3);
    expect(r.notOrbit.count).toBe(4);
    expect(r.notOrbit.linkedin).toEqual([
      { id: 'acc-osmo-li', createdAt: '2026-07-10T09:00:00.000Z' },
      { id: 'acc-osmo-uuid', createdAt: '2026-10-22T10:00:00.000Z', hint: 'uuid_name' },
    ]);
    // names are never stored
    expect(JSON.stringify(r)).not.toContain('osmo-anish');
    expect(gone).toBeTruthy();

    // health() and the next morning's cost digest carry it
    const [h] = await t.db.sql<{ h: { unipile_orphans: number; linkedin_parked: number } }>`
      select orbit.health() as h`;
    expect(h!.h.unipile_orphans).toBe(3);
    expect(h!.h.linkedin_parked).toBe(0);
    await enqueue('cost.digest');
    const sent: string[] = [];
    await drain(
      t,
      costHandlers({
        ownerId: live,
        mailer: {
          configured: true,
          send: async (m) => {
            sent.push(m.text);
            return { ok: true as const, id: 'm' };
          },
        },
      }),
      () => new Date(Date.now() + 3_600_000),
    );
    const [d] = await t.db.sql<{ details: CostDigest }>`
      select details from orbit.audit_log where action = 'cost.digest'`;
    expect(d!.details.unipileAccounts).toBe(8);
    expect(d!.details.unipile).toMatchObject({
      total: 8,
      orbitLinked: 1,
      notOrbitCount: 4,
      notOrbitLinkedin: ['acc-osmo-li', 'acc-osmo-uuid'],
      missingAtUnipile: ['acc-missing'],
    });
    expect(d!.details.unipile!.orbitOrphans.map((o) => o.id)).toEqual([
      'acc-orphan-user',
      'acc-orphan-ref',
      'acc-linked',
    ]);
    expect(d!.details.crossed.map((c) => c.key)).toContain('unipileOrphans');
    expect(sent[0]).toContain('acc-orphan-user (2026-10-22)');
    expect(sent[0]).toContain("LinkedIn accounts that are not Orbit's: acc-osmo-li, acc-osmo-uuid.");
    expect(sent[0]).not.toMatch(/[—!]/);
  });

  it('classifies without a user list as not Orbit, and an unconfigured key skips the job', async () => {
    const r = classifyAccounts(
      [{ id: 'a', type: 'LINKEDIN', name: '0b0b0b0b-1111-2222-3333-444444444444' }],
      {
        orbitAccountIds: new Set(),
        userIds: new Set(),
        linkAccountIds: new Set(),
      },
    );
    expect(r.orbitOrphans).toEqual([]);
    expect(r.notOrbit.linkedin).toEqual([{ id: 'a', createdAt: null, hint: 'uuid_name' }]);
    await enqueue('unipile.reconcile');
    await drain(t, defaultHandlers({ fetch: fakeAccounts([]).fetch }), () => new Date());
    expect(await jobRuns(t.db)).toEqual([
      { kind: 'unipile.reconcile', status: 'skipped', error: 'unconfigured' },
    ]);
  });
});

describe('linkedin.park (E5)', () => {
  it('ORBIT_LINKEDIN_PARK_DAYS: unset is 21, 0 is off', () => {
    expect(parkDays(undefined)).toBe(21);
    expect(parkDays('')).toBe(21);
    expect(parkDays('30')).toBe(30);
    expect(parkDays('0')).toBe(0);
    expect(parkDays('nope')).toBe(21);
  });

  it('parks only idle students with nothing waiting and autopilot off, keeping the row and the synced data', async () => {
    const idle = await linkedinUser({ account: 'acc-idle', seenDaysAgo: 30 });
    const person = (
      await t.db.sql<{ id: string }>`
        insert into orbit.people (user_id, display_name, name_norm, linkedin_member_id)
        values (${idle}::uuid, 'Lou Link', 'lou link', 'ACoLou') returning id`
    )[0]!.id;
    const recent = await linkedinUser({ account: 'acc-recent', seenDaysAgo: 3 });
    const session = await linkedinUser({ account: 'acc-session', seenDaysAgo: 30 });
    await t.db.sql`insert into orbit.sessions (user_id, refresh_hash, expires_at, last_used_at)
      values (${session}::uuid, ${`h-${Math.random()}`}, now() + interval '30 days', now() - interval '2 days')`;
    const scheduled = await linkedinUser({ account: 'acc-scheduled', seenDaysAgo: 30 });
    const p2 = (
      await t.db.sql<{ id: string }>`
        insert into orbit.people (user_id, display_name, name_norm) values (${scheduled}::uuid, 'Pat', 'pat')
        returning id`
    )[0]!.id;
    await t.db.sql`insert into orbit.drafts (user_id, person_id, channel, kind, body, status, send_at)
      values (${scheduled}::uuid, ${p2}::uuid, 'linkedin', 'bump', 'Hi Pat', 'scheduled', now() + interval '1 day')`;
    const needsYou = await linkedinUser({ account: 'acc-needs-you', seenDaysAgo: 30 });
    await t.db.sql`insert into orbit.suggestions (user_id, kind, reason_text, dedupe_key, expires_at)
      values (${needsYou}::uuid, 'needs_you', 'They asked when you are free', 'ny-1', now() + interval '7 days')`;
    const replied = await linkedinUser({ account: 'acc-replied', seenDaysAgo: 30 });
    await t.db.sql`insert into orbit.threads (user_id, provider, external_id, last_direction, last_at)
      values (${replied}::uuid, 'linkedin', 'chat-r', 'in', now() - interval '2 days')`;
    const autopilot = await linkedinUser({
      account: 'acc-autopilot',
      seenDaysAgo: 30,
      settings: { autopilot_mode: 'autopilot' },
    });
    const assist = await linkedinUser({ account: 'acc-assist', seenDaysAgo: 30, autonomy: 1 });
    const unsynced = await linkedinUser({ account: 'acc-unsynced', seenDaysAgo: 30, synced: false });
    const misnamed = await linkedinUser({ account: 'acc-misnamed', seenDaysAgo: 40 });

    const net = fakeAccounts([
      { id: 'acc-idle', type: 'LINKEDIN', name: idle },
      { id: 'acc-misnamed', type: 'LINKEDIN', name: 'osmo-someone' },
      { id: 'acc-osmo', type: 'LINKEDIN', name: 'osmo-anish' },
    ]);
    await enqueue('linkedin.park');
    await drain(t, handlersFor(net.fetch, { days: 21 }), () => new Date());

    // one account checked and unlinked; the misnamed one checked and left alone; Osmo's never touched
    expect(net.calls.filter((c) => c.startsWith('DELETE'))).toEqual(['DELETE /api/v1/accounts/acc-idle']);
    expect(net.calls.sort()).toEqual(
      [
        'GET /api/v1/accounts/acc-misnamed',
        'GET /api/v1/accounts/acc-idle',
        'DELETE /api/v1/accounts/acc-idle',
      ].sort(),
    );
    expect(net.list.map((a) => a.id)).toEqual(['acc-misnamed', 'acc-osmo']);

    const parked = await row(idle);
    expect(parked.status).toBe('parked');
    expect(parked.external_account_id).toBeNull();
    expect(parked.sync_state.linkedin).toMatchObject({
      stage: 'done',
      syncedAt: '2026-10-01T00:00:00.000Z',
      parked: { accountId: 'acc-idle', since: '2026-10-05T00:00:00.000Z' },
    });
    expect(await t.db.sql`select 1 from orbit.people where id = ${person}::uuid`).toHaveLength(1);
    for (const u of [recent, session, scheduled, needsYou, replied, autopilot, assist, unsynced, misnamed])
      expect((await row(u)).status).toBe('active');

    const [run] = await t.db.sql<{
      details: { parked: string[]; skipped: { userId: string; reason: string }[] };
    }>`
      select details from orbit.audit_log where action = 'linkedin.park'`;
    expect(run!.details.parked).toEqual([idle]);
    expect(run!.details.skipped).toEqual([{ userId: misnamed, reason: 'not_orbit_named' }]);
    const [h] = await t.db.sql<{ h: { linkedin_parked: number } }>`select orbit.health() as h`;
    expect(h!.h.linkedin_parked).toBe(1);
  });

  it('does nothing when ORBIT_LINKEDIN_PARK_DAYS is 0', async () => {
    const idle = await linkedinUser({ account: 'acc-idle', seenDaysAgo: 90 });
    const net = fakeAccounts([{ id: 'acc-idle', type: 'LINKEDIN', name: idle }]);
    await enqueue('linkedin.park');
    await drain(t, handlersFor(net.fetch, { days: 0 }), () => new Date());
    expect(net.calls).toEqual([]);
    expect((await row(idle)).status).toBe('active');
    expect(await jobRuns(t.db)).toEqual([{ kind: 'linkedin.park', status: 'skipped', error: 'off' }]);
  });
});

describe('a parked link', () => {
  const parkOne = async () => {
    const u = await linkedinUser({ account: 'acc-old', seenDaysAgo: 30 });
    const net = fakeAccounts([{ id: 'acc-old', type: 'LINKEDIN', name: u }]);
    await enqueue('linkedin.park');
    await drain(t, handlersFor(net.fetch), () => new Date());
    await clearQueues(t);
    expect((await row(u)).status).toBe('parked');
    return { u, net };
  };

  it('is passed over by the poll, a queued sync, webhooks and sends', async () => {
    const { u, net } = await parkOne();
    // the student is back but has not reconnected yet
    await t.db.sql`update orbit.users set last_seen_at = now() where id = ${u}::uuid`;
    await t.db.sql`select orbit.enqueue_incremental_syncs()`;
    const polled = await t.db.sql`
      select 1 from pgmq.q_orbit_sync where message->>'kind' = 'sync.linkedin' and message->>'userId' = ${u}`;
    expect(polled).toHaveLength(0);

    await sqlQueue(t.db).enqueue({ kind: 'sync.linkedin', userId: u, payload: { mode: 'sync' } });
    const before = net.calls.length;
    await drain(t, handlersFor(net.fetch), () => new Date());
    expect(await jobRuns(t.db, u)).toEqual([
      { kind: 'sync.linkedin', status: 'skipped', error: 'not_connected' },
    ]);
    expect(net.calls.length).toBe(before);
    expect(net.sync.calls).toEqual([]);

    // Unipile's DELETED status and a stray message for the old account change nothing
    const queueFor = () => sqlQueue(t.db);
    expect(
      (await unipileEvent(t.db, queueFor, { AccountStatus: { account_id: 'acc-old', message: 'DELETED' } }))
        .result,
    ).toBe('ignored');
    expect(
      (
        await unipileEvent(t.db, queueFor, {
          event: 'message_received',
          account_id: 'acc-old',
          chat_id: 'c1',
          message_id: 'm1',
        })
      ).result,
    ).toBe('unknown_account');
    expect((await row(u)).status).toBe('parked');
  });

  it('fails a LinkedIn send the student approved, without calling Unipile', async () => {
    const net = fakeNet((c) => (c.url.startsWith(AGENT_UNIPILE) ? jsonRes(500, {}) : undefined));
    const call = api(t, net, { env: { unipileKey: 'unipile-placeholder', unipileBase: AGENT_UNIPILE } });
    const { userId, token } = await signedInUser(t);
    await t.db
      .sql`insert into orbit.integration_accounts (user_id, provider, external_account_id, status, sync_state)
      values (${userId}::uuid, 'linkedin', null, 'parked',
              '{"linkedin":{"parked":{"accountId":"acc-old","since":"2026-10-05T00:00:00.000Z"}}}'::jsonb)`;
    const p = await addPerson(t, userId, { name: 'Lou Link', memberId: 'ACoAALou', score: 45 });
    const c = await call<{ draft: { id: string } }>('/drafts/compose', token, {
      personId: p,
      kind: 'bump',
      channel: 'linkedin',
    });
    const r = await call<{ draft: { status: string; error?: string | null } }>('/drafts/approve', token, {
      draftId: c.body.draft.id,
      body: 'Hi Lou, would love 15 minutes to hear how you got into product.',
      confirm: true,
    });
    expect(r.body.draft).toMatchObject({ status: 'failed', error: 'linkedin_not_connected' });
    expect(net.calls.filter((x) => x.url.startsWith(AGENT_UNIPILE))).toEqual([]);
  });

  it('shows as parked, and reconnecting reuses the row and resumes from the last finished pass', async () => {
    // a signed-in student whose link was parked
    const sub = `s-${Math.random()}`;
    const u = (await upsertGoogleUser(t.db, {
      sub,
      email: `${sub}@example.com`,
      name: 'Test User',
      scopes: ['openid'],
      refreshToken: 'refresh-placeholder',
    }))!;
    const SECRET = 'c2Vzc2lvbi1zZWNyZXQtcGxhY2Vob2xkZXItMzItYnl0ZXMhIQ==';
    const token = (await createSession(t.db, { secret: SECRET }, u)).accessToken;
    const SINCE = '2026-10-05T00:00:00.000Z';
    await t.db.sql`
      insert into orbit.integration_accounts (user_id, provider, external_account_id, status, sync_state)
      values (${u}::uuid, 'linkedin', null, 'parked', ${{
        linkedin: {
          stage: 'done',
          syncedAt: '2026-10-01T00:00:00.000Z',
          recentAt: SINCE,
          selfMemberId: 'ACoMaya',
          parked: { at: '2026-10-27T07:10:00.000Z', accountId: 'acc-old', since: SINCE },
        },
      }}::jsonb)`;
    const before = await row(u);
    const net = fakeAccounts([]);
    const api = makeApiHandler({
      env: {
        sessionSecret: SECRET,
        appUrl: 'https://app.test',
        unipileKey: 'unipile-placeholder',
        unipileBase: BASE,
        unipileWebhookSecret: 'unipile-hook-placeholder',
      },
      db: t.db,
      fetch: net.fetch,
      take: memoryTake(),
    });
    const post = (path: string) =>
      api(
        new Request(`https://ref.supabase.co/functions/v1/orbit-api${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: '{}',
        }),
      );
    const status = async () =>
      ((await (await post('/linkedin/status')).json()) as LinkedinStatusResponse).status;
    expect(await status()).toBe('parked');

    // Reconnect LinkedIn: a hosted sign-in into the same row, which stays parked until Unipile reports the account
    expect((await post('/linkedin/connect/start')).status).toBe(200);
    expect(await status()).toBe('parked');
    const linked = await unipileAccount(t.db, sqlQueue(t.db), {
      status: 'CREATION_SUCCESS',
      account_id: 'acc-new',
      name: u,
    });
    expect(linked.result).toBe('connected');
    const back = await row(u);
    expect(back.id).toBe(before.id);
    expect(back.status).toBe('active');
    expect(back.external_account_id).toBe('acc-new');
    expect(back.sync_state.linkedin).toMatchObject({
      stage: 'relations',
      short: true,
      resume: true,
      chatsAfter: SINCE,
      floor: SINCE,
      selfMemberId: 'ACoMaya',
    });
    expect(back.sync_state.linkedin!.parked).toBeUndefined();
    expect(await status()).toBe('active');

    // the resumed pass: relations newest first, only back to SINCE; chats only with something after SINCE, and of
    // those only the messages after it (the earlier ones are stored already, under the old account's ids)
    const sync = net.sync;
    sync.relationsPageSize = 2;
    sync.relations = [
      { member_id: 'ACoNew1', first_name: 'Nia', last_name: 'New', created_at: '2026-11-01T00:00:00.000Z' },
      { member_id: 'ACoOld1', first_name: 'Ola', last_name: 'Old', created_at: '2026-09-01T00:00:00.000Z' },
      { member_id: 'ACoOld2', first_name: 'Oz', last_name: 'Old', created_at: '2026-08-01T00:00:00.000Z' },
      { member_id: 'ACoOld3', first_name: 'Oli', last_name: 'Old', created_at: '2026-07-01T00:00:00.000Z' },
      { member_id: 'ACoOld4', first_name: 'Opal', last_name: 'Old', created_at: '2026-06-01T00:00:00.000Z' },
    ];
    const me = { id: 'att-me', provider_id: 'ACoMaya', name: 'Maya Chen', is_self: 1 };
    sync.chats = [
      {
        id: 'chat-quiet',
        attendees: [me, { id: 'att-q', provider_id: 'ACoQuiet', name: 'Quinn Quiet' }],
        messages: [
          { id: 'q1', sender_id: 'ACoQuiet', text: 'Old news', timestamp: '2026-09-15T00:00:00.000Z' },
        ],
      },
      {
        id: 'chat-busy',
        attendees: [me, { id: 'att-b', provider_id: 'ACoBusy', name: 'Bea Busy' }],
        messages: [
          { id: 'b1', sender_id: 'ACoBusy', text: 'From before', timestamp: '2026-10-01T00:00:00.000Z' },
          {
            id: 'b2',
            sender_id: 'ACoBusy',
            text: 'While you were away',
            timestamp: '2026-10-20T00:00:00.000Z',
          },
        ],
      },
    ];
    const time = virtualTime(Date.parse('2026-11-09T12:00:00Z'));
    await drain(
      t,
      defaultHandlers({
        fetch: net.fetch,
        unipile: UNIPILE,
        clock: time.clock,
        sleep: time.sleep,
        random: () => 0,
      }),
      time.now,
    );
    const calls = sync.calls.map((c) => c.slice(c.indexOf(' ') + 1 + BASE.length));
    expect(calls.filter((c) => c.startsWith('/api/v1/users/relations'))).toHaveLength(1);
    expect(calls.some((c) => c.includes('/users/me'))).toBe(false);
    const chatsCall = calls.find((c) => c.startsWith('/api/v1/chats?'))!;
    expect(new URL(`${BASE}${chatsCall}`).searchParams.get('after')).toBe(SINCE);
    expect(calls.some((c) => c.includes('chat-quiet'))).toBe(false);
    const stored = await t.db.sql<{ external_id: string }>`
      select external_id from orbit.messages where user_id = ${u}::uuid order by external_id`;
    expect(stored.map((m) => m.external_id)).toEqual(['b2']);
    const threads = await t.db.sql<{ external_id: string }>`
      select external_id from orbit.threads where user_id = ${u}::uuid`;
    expect(threads.map((r) => r.external_id)).toEqual(['chat-busy']);
    const members = await t.db.sql<{ v: string }>`
      select value_norm as v from orbit.person_identities
       where user_id = ${u}::uuid and kind = 'linkedin_member' and source = 'linkedin_relation' order by 1`;
    // one page: it reached back past SINCE, so the walk stopped there
    expect(members.map((m) => m.v.toLowerCase())).toEqual(['aconew1', 'acoold1']);
    const done = (await row(u)).sync_state.linkedin!;
    expect(done).toMatchObject({ stage: 'done', resume: false, floor: SINCE });
    // the resumed pass stands for a full one, so the next sync is short, not a walk of everything
    expect(Date.parse(String(done.syncedAt))).toBeGreaterThanOrEqual(Date.parse('2026-11-09T12:00:00Z'));
    const [audit] = await t.db.sql<{ details: { since: string } }>`
      select details from orbit.audit_log where action = 'linkedin.unparked' and user_id = ${u}::uuid`;
    expect(audit!.details.since).toBe(SINCE);
  });
});
