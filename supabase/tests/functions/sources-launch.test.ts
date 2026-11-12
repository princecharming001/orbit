/**
 * Plan 43, launching a source "like pressing a button": the owner's launch switches (orbit_private.source_launch,
 * 20261204_orbit_launch.sql) joined to ORBIT_EXTRA_SOURCES by `offeredNow`, the owner's API (GET and PUT
 * /admin/sources), `isOwner`, everything Instagram and X gated on what is offered, the text_days pull in the browser's
 * field names, and a draft moved to Messages kept on the server and never sent by it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../functions/_shared/db.ts';
import { sqlQueue } from '../../functions/_shared/queue.ts';
import { memoryTake } from '../../functions/_shared/ratelimit.ts';
import { sendDraft } from '../../functions/_shared/sending/send.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import { attachAccount } from '../../functions/_shared/social/links.ts';
import type { XConfig } from '../../functions/_shared/social/x/config.ts';
import {
  forgetOffered,
  OFFERED_TTL_MS,
  offeredNow,
  sourceIsOn,
  sourcesFor,
} from '../../functions/_shared/sources/states.ts';
import { switchSource } from '../../functions/_shared/sources/switch.ts';
import { type ApiEnv, makeApiHandler } from '../../functions/orbit-api/api.ts';
import { makeWebhookHandler } from '../../functions/orbit-webhooks/webhooks.ts';
import { JobSkipped } from '../../functions/orbit-worker/handlers/deps.ts';
import { socialHandlers } from '../../functions/orbit-worker/handlers/social.ts';
import { sourceHandlers } from '../../functions/orbit-worker/handlers/sources.ts';
import type { Job, JobContext } from '../../functions/orbit-worker/worker.ts';
import { APP, agentConfig, BASE, fakeNet, SECRET, signedInUser } from '../helpers/agents.ts';
import { FakeInstagram } from '../helpers/fakeInstagram.ts';
import { FAKE_X_CLIENT_ID, FAKE_X_CLIENT_SECRET } from '../helpers/fakeX.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});
// every test starts with nothing launched (the shipped default) and nothing cached
beforeEach(async () => {
  await t.db.sql`delete from orbit_private.source_launch`;
  forgetOffered(t.db);
});

const HOOK = 'unipile-hook-placeholder';
const WEBHOOKS = 'https://ref.supabase.co/functions/v1/orbit-webhooks';

const launch = async (source: string, offered = true) => {
  await t.db.sql`
    insert into orbit_private.source_launch (source, offered, changed_at) values (${source}, ${offered}, now())
    on conflict (source) do update set offered = excluded.offered`;
  forgetOffered(t.db);
};

const xCfg = (over: Partial<XConfig> = {}): XConfig => ({
  clientId: FAKE_X_CLIENT_ID,
  clientSecret: FAKE_X_CLIENT_SECRET,
  studentMonthlyUsd: 15,
  orbitMonthlyUsd: 50,
  listLimit: 600,
  offered: false,
  ...over,
});

function apiWith(env: Partial<ApiEnv> = {}, fetchFn: typeof fetch = fakeNet().fetch) {
  const handler = makeApiHandler({
    env: {
      googleClientId: 'client-id-placeholder.apps.googleusercontent.com',
      googleClientSecret: 'client-secret-placeholder',
      googleRedirectUri: `${BASE}/auth/google/callback`,
      sessionSecret: SECRET,
      appUrl: APP,
      ...env,
    },
    db: t.db,
    fetch: fetchFn,
    take: memoryTake(),
    agent: agentConfig({ fetch: fetchFn, calls: [] } as never, {
      unipileKey: env.unipileKey,
      unipileBase: env.unipileBase,
    }),
  });
  return (method: string, path: string, token: string, body?: unknown) =>
    handler(
      new Request(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, any> }));
}

function webhook(path: string, body: unknown) {
  const h = makeWebhookHandler({ db: t.db, pubsubToken: 'p', unipileSecret: HOOK });
  return h(
    new Request(`${WEBHOOKS}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orbit-webhook': HOOK },
      body: JSON.stringify(body),
    }),
  ).then(async (r) => ({ status: r.status, body: (await r.json()) as { ok: boolean; result: string } }));
}

let accSeq = 0;
/** A student with Instagram connected and switched on (their own switch; the owner's is separate). */
async function instagramStudent() {
  const s = await signedInUser(t);
  const account = `acc-launch-${++accSeq}`;
  await t.db.sql`
    insert into orbit.integration_accounts (user_id, provider, external_account_id, social_account_id, status)
    values (${s.userId}::uuid, 'instagram', ${account}, 'ig-me', 'active')`;
  await t.db
    .sql`insert into orbit.source_states (user_id, source, state) values (${s.userId}::uuid, 'instagram', 'on')`;
  return { ...s, account };
}

const job = (kind: string, userId: string | null, payload: Record<string, unknown> = {}): Job => ({
  queue: 'orbit_sync',
  msgId: 1,
  readCt: 1,
  kind,
  userId,
  payload,
});
const ctx = (): JobContext => ({ db: t.db, queue: sqlQueue(t.db), now: () => new Date() });

// ---- offeredNow --------------------------------------------------------------------------------------------------

describe('offeredNow', () => {
  it('is the env list alone when nothing is launched, and nothing at all by default', async () => {
    expect(await offeredNow(t.db, [])).toEqual([]);
    expect(await offeredNow(t.db, ['imessage'])).toEqual(['imessage']);
  });

  it('is the launched sources alone with the env list empty; a row that is not offered counts for nothing', async () => {
    await launch('x');
    await launch('instagram', false);
    expect(await offeredNow(t.db, [])).toEqual(['x']);
  });

  it('is the env list and the launched sources together, each once', async () => {
    await launch('x');
    await launch('imessage');
    expect(await offeredNow(t.db, ['imessage', 'instagram'])).toEqual(['imessage', 'instagram', 'x']);
  });

  it('keeps what it read about a minute per database handle', async () => {
    let at = 1_000_000;
    const clock = () => at;
    expect(await offeredNow(t.db, [], clock)).toEqual([]);
    await t.db.sql`insert into orbit_private.source_launch (source, offered) values ('imessage', true)`;
    at += OFFERED_TTL_MS - 1;
    expect(await offeredNow(t.db, [], clock)).toEqual([]);
    at += 2;
    expect(await offeredNow(t.db, [], clock)).toEqual(['imessage']);
    // and forgetting reads it again at once
    await t.db.sql`update orbit_private.source_launch set offered = false`;
    forgetOffered(t.db);
    expect(await offeredNow(t.db, [], clock)).toEqual([]);
  });

  it('falls back to the env list when the switches cannot be read', async () => {
    const broken = {
      sql: () => Promise.reject(new Error('the database is away')),
      query: () => Promise.reject(new Error('the database is away')),
      begin: () => Promise.reject(new Error('the database is away')),
    } as unknown as Db;
    expect(await offeredNow(broken, ['instagram'])).toEqual(['instagram']);
    const throws = {
      sql: () => {
        throw new Error('no connection');
      },
    } as unknown as Db;
    expect(await offeredNow(throws, [])).toEqual([]);
  });

  it('reaches sourcesFor and sourceIsOn: a launched source counts for a student who has it on', async () => {
    const s = await instagramStudent();
    expect(await sourceIsOn(t.db, s.userId, 'instagram', [])).toBe(false);
    expect((await sourcesFor(t.db, s.userId, [])).inUse.has('instagram')).toBe(false);
    await launch('instagram');
    expect(await sourceIsOn(t.db, s.userId, 'instagram', [])).toBe(true);
    const src = await sourcesFor(t.db, s.userId, []);
    expect(src.offered).toEqual(['instagram']);
    expect(src.inUse.has('instagram')).toBe(true);
    expect(src.hidden).toEqual(['x', 'imessage']);
  });

  it('only the service role may call the read and write functions', async () => {
    const grants = await t.db.sql<{ fn: string; anon: boolean; service: boolean }>`
      select p.proname as fn,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('service_role', p.oid, 'execute') as service
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('orbit_sources_offered', 'orbit_source_launch_set')
       order by p.proname`;
    expect(grants).toEqual([
      { fn: 'orbit_source_launch_set', anon: false, service: true },
      { fn: 'orbit_sources_offered', anon: false, service: true },
    ]);
    await expect(
      t.db.sql`insert into orbit_private.source_launch (source, offered) values ('linkedin', true)`,
    ).rejects.toThrow();
  });
});

// ---- the owner's API ---------------------------------------------------------------------------------------------

describe('/admin/sources', () => {
  it('is for the owner only: everyone else gets 403, and isOwner says which one is the owner', async () => {
    const owner = await signedInUser(t);
    const student = await signedInUser(t);
    const call = apiWith({ ownerId: owner.userId });
    expect((await call('GET', '/admin/sources', student.token)).status).toBe(403);
    expect((await call('PUT', '/admin/sources/imessage', student.token, { offered: true })).status).toBe(403);
    expect(await t.db.sql`select 1 from orbit_private.source_launch`).toHaveLength(0);
    expect((await call('GET', '/admin/sources', owner.token)).status).toBe(200);
    // no owner set: no one is the owner
    expect((await apiWith({})('GET', '/admin/sources', owner.token)).status).toBe(403);

    const me = await call('GET', '/auth/me', owner.token);
    expect(me.body.isOwner).toBe(true);
    expect(me.body.user.id).toBe(owner.userId);
    expect((await call('GET', '/auth/me', student.token)).body.isOwner).toBe(false);
  });

  it('says in plain words what each source needs, and never returns a key', async () => {
    const owner = await signedInUser(t);
    const bare = await apiWith({ ownerId: owner.userId })('GET', '/admin/sources', owner.token);
    const by = (b: Record<string, any>, s: string) =>
      (b.sources as { source: string }[]).find((x) => x.source === s) as Record<string, any>;
    expect(bare.body.sources.map((s: { source: string }) => s.source)).toEqual([
      'instagram',
      'x',
      'imessage',
    ]);
    expect(by(bare.body, 'instagram')).toMatchObject({
      offered: false,
      env: false,
      ready: false,
      // the webhook secret is made inside the database (20261014_orbit_secrets.sql), so it is never missing here
      missing: ['The Unipile API key (UNIPILE_API_KEY)', 'The Unipile base URL (UNIPILE_BASE_URL)'],
    });
    expect(by(bare.body, 'x')).toMatchObject({
      ready: false,
      missing: [
        'The X app client ID (ORBIT_X_CLIENT_ID)',
        'The X app client secret (ORBIT_X_CLIENT_SECRET)',
        'A monthly X spending limit above 0 dollars (ORBIT_X_MONTHLY_USD)',
      ],
    });
    expect(by(bare.body, 'imessage')).toMatchObject({ ready: true, missing: [] });

    const set = await apiWith({
      ownerId: owner.userId,
      unipileKey: 'unipile-key-placeholder',
      unipileBase: 'https://unipile.test',
      unipileWebhookSecret: HOOK,
      x: xCfg({ orbitMonthlyUsd: 0 }),
    })('GET', '/admin/sources', owner.token);
    expect(by(set.body, 'instagram')).toMatchObject({ ready: true, missing: [] });
    expect(by(set.body, 'x')).toMatchObject({
      ready: false,
      missing: ['A monthly X spending limit above 0 dollars (ORBIT_X_MONTHLY_USD)'],
    });
    const text = JSON.stringify(set.body);
    for (const secret of ['unipile-key-placeholder', HOOK, FAKE_X_CLIENT_SECRET, FAKE_X_CLIENT_ID])
      expect(text).not.toContain(secret);
    expect(text).not.toMatch(/[!—]/);
  });

  it('counts the students who have each source on and connected', async () => {
    const owner = await signedInUser(t);
    const call = apiWith({ ownerId: owner.userId });
    const before = await call('GET', '/admin/sources', owner.token);
    const count = (b: Record<string, any>, s: string) =>
      (b.sources as { source: string; students: { on: number; connected: number } }[]).find(
        (x) => x.source === s,
      )!.students;
    const ig0 = count(before.body, 'instagram');
    const tx0 = count(before.body, 'imessage');
    await instagramStudent();
    const off = await instagramStudent();
    await t.db.sql`update orbit.source_states set state = 'off' where user_id = ${off.userId}::uuid`;
    const texter = await signedInUser(t);
    await t.db.sql`
      insert into orbit.source_states (user_id, source, state) values (${texter.userId}::uuid, 'imessage', 'on')`;
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm) values (${texter.userId}::uuid, 'Tia', 'tia') returning id`;
    await t.db.sql`
      insert into orbit.text_days (user_id, person_id, day, in_count, out_count, group_size, words)
      values (${texter.userId}::uuid, ${p!.id}::uuid, '2026-11-01', 2, 1, 2, true),
             (${texter.userId}::uuid, ${p!.id}::uuid, '2026-11-02', 1, 1, 2, true)`;
    const after = await call('GET', '/admin/sources', owner.token);
    expect(count(after.body, 'instagram')).toEqual({ on: ig0.on + 1, connected: ig0.connected + 2 });
    expect(count(after.body, 'imessage')).toEqual({ on: tx0.on + 1, connected: tx0.connected + 1 });
  });

  it('launches a source with one PUT, audit-logged, in effect for students at once', async () => {
    const owner = await signedInUser(t);
    const student = await signedInUser(t);
    const call = apiWith({ ownerId: owner.userId });
    expect((await call('GET', '/sources', student.token)).body.offered).toEqual([]);
    const r = await call('PUT', '/admin/sources/imessage', owner.token, { offered: true });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect((await call('GET', '/sources', student.token)).body.offered).toEqual(['imessage']);
    const listed = await call('GET', '/admin/sources', owner.token);
    expect(listed.body.sources.find((s: { source: string }) => s.source === 'imessage').offered).toBe(true);
    const [row] = await t.db.sql<{ offered: boolean; changed_by: string }>`
      select offered, changed_by from orbit_private.source_launch where source = 'imessage'`;
    expect(row).toEqual({ offered: true, changed_by: owner.userId });
    const [audit] = await t.db.sql<{ action: string; target_id: string; details: Record<string, unknown> }>`
      select action, target_id, details from orbit.audit_log
       where user_id = ${owner.userId}::uuid and target_table = 'source_launch' order by id desc limit 1`;
    expect(audit).toEqual({
      action: 'source.launch',
      target_id: 'imessage',
      details: { offered: true, was: false },
    });
    // bad input and unknown sources
    expect((await call('PUT', '/admin/sources/imessage', owner.token, { offered: 'yes' })).status).toBe(400);
    expect((await call('PUT', '/admin/sources/linkedin', owner.token, { offered: true })).status).toBe(404);
  });

  it('refuses to launch a source before what it needs is set, and to turn off one the env list names', async () => {
    const owner = await signedInUser(t);
    const notReady = await apiWith({ ownerId: owner.userId })('PUT', '/admin/sources/x', owner.token, {
      offered: true,
    });
    expect(notReady.status).toBe(409);
    expect(notReady.body.error.code).toBe('not_ready');
    expect(notReady.body.missing).toHaveLength(3);
    const listed = await apiWith({ ownerId: owner.userId, extraSources: ['imessage'] })(
      'PUT',
      '/admin/sources/imessage',
      owner.token,
      { offered: false },
    );
    expect(listed.status).toBe(409);
    expect(listed.body.error.message).toBe(
      'It is listed in ORBIT_EXTRA_SOURCES, so it stays on until that setting is changed.',
    );
    expect(await t.db.sql`select 1 from orbit_private.source_launch`).toHaveLength(0);
  });

  it('turning a source off keeps what students took, pauses their drafts on it and queues their switch job', async () => {
    const owner = await signedInUser(t);
    const call = apiWith({
      ownerId: owner.userId,
      unipileKey: 'unipile-key-placeholder',
      unipileBase: 'https://unipile.test',
      unipileWebhookSecret: HOOK,
    });
    await call('PUT', '/admin/sources/instagram', owner.token, { offered: true });
    await t.db.sql`delete from pgmq.q_orbit_score`;
    const s = await instagramStudent();
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm) values (${s.userId}::uuid, 'Rin', 'rin') returning id`;
    await attachAccount(t.db, s.userId, {
      platform: 'instagram',
      accountId: 'ig-rin',
      personId: p!.id,
      via: 'student',
      now: new Date(),
    });
    const [d] = await t.db.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, channel, kind, body, status, send_at)
      values (${s.userId}::uuid, ${p!.id}::uuid, 'instagram', 'bump', 'Still on for Friday?', 'approved', now())
      returning id`;
    expect(await sourceIsOn(t.db, s.userId, 'instagram', [])).toBe(true);

    expect((await call('PUT', '/admin/sources/instagram', owner.token, { offered: false })).body).toEqual({
      ok: true,
    });
    // reading stops: nothing is offered, so nothing is on
    expect(await sourceIsOn(t.db, s.userId, 'instagram', [])).toBe(false);
    // the student's own switch and what was taken stay
    const [st] = await t.db.sql<{ state: string }>`
      select state from orbit.source_states where user_id = ${s.userId}::uuid and source = 'instagram'`;
    expect(st!.state).toBe('on');
    expect(
      await t.db
        .sql`select 1 from orbit.social_links where user_id = ${s.userId}::uuid and platform = 'instagram'`,
    ).toHaveLength(1);
    const [draft] = await t.db.sql<{ status: string; error: string }>`
      select status, error from orbit.drafts where id = ${d!.id}::uuid`;
    expect(draft).toEqual({ status: 'draft', error: 'source_off:instagram' });
    const jobs = await t.db.sql<{ kind: string; user_id: string; payload: Record<string, unknown> }>`
      select message->>'kind' as kind, message->>'userId' as user_id, message->'payload' as payload
        from pgmq.q_orbit_score where message->>'kind' = 'sources.switch'`;
    const mine = jobs.filter((j) => j.user_id === s.userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.payload).toMatchObject({ source: 'instagram', state: 'off', by: 'owner' });

    // the switch job runs with the source out
    await sourceHandlers({})['sources.switch']!(
      { ...job('sources.switch', s.userId, mine[0]!.payload), queue: 'orbit_score' },
      ctx(),
    );
    const [audit] = await t.db.sql<{ details: Record<string, unknown> }>`
      select details from orbit.audit_log
       where user_id = ${owner.userId}::uuid and action = 'source.unlaunch' order by id desc limit 1`;
    expect(audit!.details).toEqual({ offered: false, was: true });
  });
});

// ---- gated on what is offered --------------------------------------------------------------------------------------

describe('Instagram and X not offered', () => {
  it('Instagram: connect is 404, the webhook stores nothing, the jobs skip and /sources does not list it', async () => {
    const fake = new FakeInstagram('ig-me');
    const env = {
      unipileKey: 'unipile-key-placeholder',
      unipileBase: fake.base,
      unipileWebhookSecret: HOOK,
    };
    const call = apiWith(env, fake.fetch);
    const s = await instagramStudent();
    expect((await call('POST', '/instagram/connect/start', s.token, {})).status).toBe(404);
    expect((await call('GET', '/instagram/status', s.token)).status).toBe(404);
    expect(fake.calls).toHaveLength(0);
    expect((await call('GET', '/sources', s.token)).body).toEqual({ offered: [], states: {} });
    expect(
      (
        await call('POST', '/social/lookups', s.token, {
          platform: 'instagram',
          personId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(404);
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm) values (${s.userId}::uuid, 'Ola', 'ola') returning id`;
    expect(
      (
        await call('POST', '/drafts/compose', s.token, {
          personId: p!.id,
          kind: 'bump',
          channel: 'instagram',
        })
      ).status,
    ).toBe(404);

    const msg = {
      event: 'message_received',
      account_id: s.account,
      account_type: 'INSTAGRAM',
      account_info: { type: 'INSTAGRAM', user_id: 'ig-me' },
      chat_id: 'chat-launch-1',
      message_id: 'm-launch-1',
      message: 'hello',
      timestamp: new Date().toISOString(),
      sender: { attendee_provider_id: 'ig-friend' },
      attendees: [{ attendee_provider_id: 'ig-friend' }],
    };
    expect((await webhook('/unipile', msg)).body.result).toBe('source_off');
    expect(
      await t.db
        .sql`select 1 from orbit.messages where user_id = ${s.userId}::uuid and provider = 'instagram'`,
    ).toHaveLength(0);
    const other = await signedInUser(t);
    const notify = await webhook(`/unipile/account?token=${HOOK}&provider=instagram`, {
      status: 'CREATION_SUCCESS',
      account_id: 'acc-stray',
      name: other.userId,
    });
    expect(notify.body.result).toBe('not_offered');
    expect(
      await t.db.sql`select 1 from orbit.integration_accounts
                      where user_id = ${other.userId}::uuid and provider = 'instagram'`,
    ).toHaveLength(0);

    const handlers = socialHandlers({ fetch: fake.fetch, unipile: { apiKey: 'k', baseUrl: fake.base } });
    for (const [kind, payload] of [
      ['sync.instagram', {}],
      ['social.match', { platform: 'instagram', accountIds: ['ig-friend'] }],
      ['social.words', { platform: 'instagram', personId: p!.id }],
    ] as const) {
      const err = await handlers[kind]!(job(kind, s.userId, payload), ctx()).catch((e) => e);
      expect(err).toBeInstanceOf(JobSkipped);
      expect((err as JobSkipped).reason).toBe('source_off');
    }
    expect(fake.calls).toHaveLength(0);

    // the owner launches it: the same message is stored, and /sources lists it
    await launch('instagram');
    expect((await webhook('/unipile', { ...msg, message_id: 'm-launch-2' })).body.result).toBe('stored');
    expect((await call('GET', '/sources', s.token)).body.offered).toEqual(['instagram']);
    expect((await call('POST', '/instagram/connect/start', s.token, {})).status).toBe(200);
  });

  it('X: every route is 503 until X is offered, by the env list or the launch switch', async () => {
    const s = await signedInUser(t);
    const call = apiWith({ x: xCfg() });
    for (const [method, path] of [
      ['POST', '/x/connect/start'],
      ['GET', '/x/status'],
      ['POST', '/x/disconnect'],
    ] as const) {
      const r = await call(method, path, s.token, method === 'POST' ? { consent: true } : undefined);
      expect(r.status).toBe(503);
      expect(r.body.error.missing).toEqual(['ORBIT_EXTRA_SOURCES']);
    }
    expect(
      (await call('POST', '/social/lookups', s.token, { platform: 'x', personId: crypto.randomUUID() }))
        .status,
    ).toBe(404);
    await launch('x');
    expect((await call('POST', '/x/connect/start', s.token, { consent: true })).status).toBe(200);
    expect((await call('GET', '/x/status', s.token)).status).toBe(200);
    // the env list alone does it too
    await launch('x', false);
    expect((await apiWith({ x: xCfg({ offered: true }) })('GET', '/x/status', s.token)).status).toBe(200);
    expect((await call('GET', '/x/status', s.token)).status).toBe(503);
  });
});

// ---- the text_days pull --------------------------------------------------------------------------------------------

describe('/sync/pull text_days', () => {
  it('sends each day in the browser’s field names, and a removed day as personId:day', async () => {
    const s = await signedInUser(t);
    const call = apiWith({ extraSources: ['imessage'] });
    await t.db.sql`
      insert into orbit.source_states (user_id, source, state) values (${s.userId}::uuid, 'imessage', 'on')`;
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm, sources)
      values (${s.userId}::uuid, 'Tia Park', 'tia park', array['gmail']) returning id`;
    await t.db.sql`
      insert into orbit.text_days (user_id, person_id, day, in_count, out_count, group_size, words)
      values (${s.userId}::uuid, ${p!.id}::uuid, '2026-11-03', 4, 2, 2, true)`;
    const pull = async (cursor?: string) =>
      (await call('POST', '/sync/pull', s.token, { tables: ['text_days'], ...(cursor ? { cursor } : {}) }))
        .body;
    await new Promise((r) => setTimeout(r, 2100)); // past the pull's lag behind now
    const first = await pull();
    const [day] = first.changes.text_days as Record<string, unknown>[];
    expect(Object.keys(day!).sort()).toEqual(
      ['day', 'groupSize', 'inCount', 'outCount', 'personId', 'updatedAt', 'words'].sort(),
    );
    expect(day).toMatchObject({
      personId: p!.id,
      day: '2026-11-03',
      inCount: 4,
      outCount: 2,
      groupSize: 2,
      words: true,
    });
    await switchSource(t.db, sqlQueue(t.db), s.userId, 'imessage', { state: 'removed' }, new Date());
    const second = await pull(first.cursor as string);
    expect(second.deleted.text_days).toEqual([`${p!.id}:2026-11-03`]);
  });
});

// ---- a draft moved to Messages --------------------------------------------------------------------------------------

describe('a draft moved to Messages', () => {
  it('is saved on the server and never sent by it', async () => {
    const net = fakeNet();
    const s = await signedInUser(t);
    const call = apiWith({ extraSources: ['imessage'] }, net.fetch);
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm, primary_email)
      values (${s.userId}::uuid, 'Remy Ode', 'remy ode', 'remy@example.com') returning id`;
    const [d] = await t.db.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, channel, kind, subject, body, status)
      values (${s.userId}::uuid, ${p!.id}::uuid, 'gmail', 'bump', 'Coffee', 'Free for coffee this week?', 'draft')
      returning id`;
    const pushed = await call('POST', '/sync/push', s.token, {
      changes: [{ table: 'drafts', op: 'upsert', id: d!.id, row: { channel: 'imessage' } }],
    });
    expect(pushed.body.results[0]).toMatchObject({ ok: true });
    const [row] = await t.db.sql<{ channel: string; status: string }>`
      select channel, status from orbit.drafts where id = ${d!.id}::uuid`;
    expect(row).toEqual({ channel: 'imessage', status: 'draft' });
    // a channel that is not one
    const bad = await call('POST', '/sync/push', s.token, {
      changes: [{ table: 'drafts', op: 'upsert', id: d!.id, row: { channel: 'fax' } }],
    });
    expect(bad.body.results[0]).toMatchObject({ ok: false });

    const approve = await call('POST', '/drafts/approve', s.token, { draftId: d!.id, confirm: true });
    expect(approve.status).toBe(409);
    expect(approve.body.error.code).toBe('handoff_only');
    expect(approve.body.error.message).not.toMatch(/[!—]/);

    // even one marked approved some other way is held by the send job, not sent
    await t.db.sql`update orbit.drafts set status = 'approved', send_at = now() where id = ${d!.id}::uuid`;
    const services = makeServices(agentConfig(net, { extraSources: ['imessage'] }), {
      db: t.db,
      now: () => new Date(),
      queue: sqlQueue(t.db),
    });
    expect(await sendDraft(services, d!.id)).toEqual({ status: 'held', reason: 'imessage_handoff' });
    const [after] = await t.db.sql<{ status: string; sent_at: Date | null }>`
      select status, sent_at from orbit.drafts where id = ${d!.id}::uuid`;
    expect(after).toEqual({ status: 'draft', sent_at: null });
    expect(net.calls.filter((c) => /gmail|googleapis/.test(c.url))).toHaveLength(0);
  });

  it('an Instagram draft is not sent while Instagram is not offered', async () => {
    const fake = new FakeInstagram('ig-me');
    const s = await instagramStudent();
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm) values (${s.userId}::uuid, 'Jo', 'jo') returning id`;
    await attachAccount(t.db, s.userId, {
      platform: 'instagram',
      accountId: 'ig-jo',
      personId: p!.id,
      via: 'student',
      now: new Date(),
    });
    const [d] = await t.db.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, channel, kind, body, status, send_at)
      values (${s.userId}::uuid, ${p!.id}::uuid, 'instagram', 'bump', 'See you there', 'approved', now()) returning id`;
    const services = makeServices(
      agentConfig({ fetch: fake.fetch, calls: [] } as never, { unipileKey: 'k', unipileBase: fake.base }),
      { db: t.db, now: () => new Date(), queue: sqlQueue(t.db) },
    );
    expect(await sendDraft(services, d!.id)).toEqual({ status: 'held', reason: 'source_off' });
    expect(fake.sent).toHaveLength(0);
  });
});
