/**
 * Plan 43 §3.1, §8.1: the student's switch per optional source. GET and PUT /sources, each source through its four
 * states, the switch job (two passes, the friend projection, the graph mark the browser drops its cache on), Off
 * pausing drafts and stopping writers (`sourceIsOn`), Removed deleting exactly the plan's rows, delete_user taking the
 * student's own accounts out of the shared graph, and a student with no optional source keeping today's scores.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scorePeople } from '../../functions/_shared/ingest/score.ts';
import { sqlQueue } from '../../functions/_shared/queue.ts';
import { memoryTake } from '../../functions/_shared/ratelimit.ts';
import { createSession } from '../../functions/_shared/session.ts';
import { NO_SOURCES, sourceIsOn, sourcesFor } from '../../functions/_shared/sources/states.ts';
import { switchSource } from '../../functions/_shared/sources/switch.ts';
import { makeApiHandler } from '../../functions/orbit-api/api.ts';
import { defaultHandlers } from '../../functions/orbit-worker/worker.ts';
import { ALL_KEYS, APP, agentConfig, BASE, fakeNet, SECRET } from '../helpers/agents.ts';
import { clearQueues, drain } from '../helpers/ingest.ts';
import { freshDb, makeUser, type TestDb } from '../helpers/pglite.ts';
import { NOW, type Optional, type Seeded, seedStudent } from '../helpers/sourcesFixture.ts';

const ALL: Optional[] = ['instagram', 'x', 'imessage'];
const handlers = defaultHandlers({ offered: ALL });

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});
beforeEach(async () => {
  await clearQueues(t);
});

function client(offered: Optional[]) {
  const net = fakeNet();
  const handler = makeApiHandler({
    env: {
      googleClientId: 'client-id-placeholder.apps.googleusercontent.com',
      googleClientSecret: 'client-secret-placeholder',
      googleRedirectUri: `${BASE}/auth/google/callback`,
      sessionSecret: SECRET,
      appUrl: APP,
      extraSources: offered,
    },
    db: t.db,
    fetch: net.fetch,
    take: memoryTake(),
    // rows written a moment ago are pulled at once
    pullLagMs: -60_000,
    agent: agentConfig(net, { ...ALL_KEYS, anthropicKey: undefined }),
  });
  return async <T = Record<string, unknown>>(method: string, path: string, token: string, body?: unknown) => {
    const r = await handler(
      new Request(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: r.status, body: (await r.json()) as T };
  };
}

const tokenFor = async (userId: string) =>
  (await createSession(t.db, { secret: SECRET }, userId)).accessToken;
const n = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
const queued = (userId: string) =>
  n(t.db.sql<{ n: number }>`
    select count(*)::int as n from pgmq.q_orbit_score
     where message->>'userId' = ${userId} and message->>'kind' = 'sources.switch'`);
const pulledPeople = async (s: Seeded) => {
  const src = await sourcesFor(t.db, s.userId, ALL);
  const rows = await t.db.sql<{ display_name: string }>`
    select display_name from orbit.people p
     where p.user_id = ${s.userId}::uuid and not p.is_self and p.listed
       and orbit.person_in_use(p.sources, p.source_account, ${src.hidden}::text[]) order by display_name`;
  return rows.map((r) => r.display_name);
};

describe('GET and PUT /sources', () => {
  it('lists nothing while the owner offers nothing, and refuses every source', async () => {
    const s = await seedStudent(t, { base: true, rows: [] });
    const call = client([]);
    const token = await tokenFor(s.userId);
    expect((await call('GET', '/sources', token)).body).toEqual({ offered: [], states: {} });
    const r = await call('PUT', '/sources/instagram', token, { state: 'on' });
    expect(r.status).toBe(404);
    expect(
      await n(t.db.sql`select count(*)::int as n from orbit.source_states where user_id = ${s.userId}::uuid`),
    ).toBe(0);
  });

  it('lists each offered source with its state, sets one, logs it and queues the switch job', async () => {
    const s = await seedStudent(t, { base: true, rows: ['instagram'] });
    const call = client(['instagram', 'x']);
    const token = await tokenFor(s.userId);
    expect((await call('GET', '/sources', token)).body).toEqual({
      offered: ['instagram', 'x'],
      states: {
        instagram: { state: 'not_connected', shareFollows: false },
        x: { state: 'not_connected', shareFollows: false },
      },
    });
    expect((await call('PUT', '/sources/imessage', token, { state: 'on' })).status).toBe(404);
    expect((await call('PUT', '/sources/instagram', token, { state: 'maybe' })).status).toBe(400);
    expect((await call('PUT', '/sources/x', token, { state: 'on', shareFollows: true })).status).toBe(400);
    expect(
      (await call('PUT', '/sources/instagram', token, { state: 'on', shareFollows: true })).body,
    ).toEqual({
      ok: true,
      state: 'on',
    });
    expect(await queued(s.userId)).toBe(1);
    const off = await call('PUT', '/sources/instagram', token, { state: 'off' });
    expect(off.body).toEqual({ ok: true, state: 'off' });
    const got = (await call<{ states: Record<string, unknown> }>('GET', '/sources', token)).body.states;
    expect(got.instagram).toEqual({ state: 'off', offSince: expect.any(String), shareFollows: true });
    const audit = await t.db.sql<{ action: string }>`
      select action from orbit.audit_log where user_id = ${s.userId}::uuid and target_table = 'source_states'
       order by id`;
    expect(audit.map((a) => a.action)).toEqual(['source.on', 'source.off']);
    // the browser sees the switch in its next pull
    const pull = await call<{ changes: Record<string, unknown[]> }>('POST', '/sync/pull', token, {
      tables: ['source_states'],
    });
    expect(pull.body.changes.source_states).toEqual([
      expect.objectContaining({ source: 'instagram', state: 'off', shareFollows: true }),
    ]);
  });
});

describe('each source through its four states', () => {
  for (const source of ALL)
    it(`${source}: not connected, on, off, on, removed`, async () => {
      const s = await seedStudent(t, { base: true, rows: ALL, states: {} });
      const only = { instagram: 'Ivy Park', x: 'Xan Wu', imessage: 'Tia Moss' }[source];
      const inUse = async () => (await sourcesFor(t.db, s.userId, ALL)).inUse.has(source);
      expect(await inUse()).toBe(false);
      expect(await pulledPeople(s)).not.toContain(only);
      expect(await sourceIsOn(t.db, s.userId, source, ALL)).toBe(false);

      await switchSource(t.db, sqlQueue(t.db), s.userId, source, { state: 'on' }, NOW);
      expect(await inUse()).toBe(true);
      expect(await pulledPeople(s)).toContain(only);
      expect(await sourceIsOn(t.db, s.userId, source, ALL)).toBe(true);
      // the owner's list decides first
      expect(await sourceIsOn(t.db, s.userId, source, [])).toBe(false);

      await switchSource(t.db, sqlQueue(t.db), s.userId, source, { state: 'off' }, NOW);
      expect(await inUse()).toBe(false);
      expect(await pulledPeople(s)).not.toContain(only);
      expect(await sourceIsOn(t.db, s.userId, source, ALL)).toBe(false);
      const [st] = await t.db.sql<{ off_since: Date | null }>`
        select off_since from orbit.source_states where user_id = ${s.userId}::uuid and source = ${source}`;
      expect(st?.off_since?.toISOString()).toBe(NOW.toISOString());
      // kept while off
      expect(
        await n(t.db.sql`select count(*)::int as n from orbit.people where user_id = ${s.userId}::uuid
                               and display_name = ${only}`),
      ).toBe(1);

      await switchSource(t.db, sqlQueue(t.db), s.userId, source, { state: 'on' }, NOW);
      expect(await pulledPeople(s)).toContain(only);

      await switchSource(t.db, sqlQueue(t.db), s.userId, source, { state: 'removed' }, NOW);
      expect(await inUse()).toBe(false);
      expect(
        await n(t.db.sql`select count(*)::int as n from orbit.people where user_id = ${s.userId}::uuid
                               and display_name = ${only}`),
      ).toBe(0);
      await drain(t, handlers, () => NOW);
    });
});

describe('the switch job', () => {
  it('rescores twice, rebuilds the friend projection and moves the graph mark', async () => {
    const s = await seedStudent(t, {
      base: true,
      rows: ALL,
      states: { instagram: 'on', x: 'on', imessage: 'on' },
    });
    const friend = await makeUser(t.db);
    const [a, b] = [s.userId, friend].sort();
    const [f] = await t.db.sql<{ id: string }>`
      insert into orbit.friendships (a, b, status, requested_by, accepted_at)
      values (${a}::uuid, ${b}::uuid, 'active', ${s.userId}::uuid, now()) returning id`;
    await t.db.sql`insert into orbit.friend_share_settings (friendship_id, owner_user_id, mode)
                   values (${f!.id}::uuid, ${s.userId}::uuid, 'all')`;
    const call = client(ALL);
    const token = await tokenFor(s.userId);
    const graph = async () =>
      (await call<{ marks: { graph: number } }>('POST', '/sync/status', token)).body.marks.graph;
    expect(await graph()).toBe(0);

    await switchSource(t.db, sqlQueue(t.db), s.userId, 'instagram', { state: 'on' }, NOW);
    const ticks = await drain(t, handlers, () => NOW);
    // two passes of one page each
    expect(ticks.reduce((x, k) => x + k.processed, 0)).toBe(2);
    expect(await graph()).toBe(1);
    const scored = await t.db.sql<{ display_name: string; score: number }>`
      select p.display_name, ts.score from orbit.tie_scores ts join orbit.people p on p.id = ts.person_id
       where ts.user_id = ${s.userId}::uuid order by p.display_name`;
    expect(scored.map((r) => r.display_name)).toContain('Ivy Park');
    const shared = await t.db.sql<{ display_name: string }>`
      select display_name from orbit.friend_shares where owner_user_id = ${s.userId}::uuid order by display_name`;
    // friends see listed people with something to join on; Uma is not listed, and the Instagram-only people have no
    // join key
    expect(shared.map((r) => r.display_name)).toEqual(['Ana Lopez', 'Ben Ortiz', 'Cara Diaz', 'Dev Shah']);

    // a person who becomes unlisted leaves the projection at once, and the guard refuses them
    await t.db.sql`update orbit.people set listed = false where id = ${s.people.ana!}::uuid`;
    expect(
      await n(
        t.db.sql`select count(*)::int as n from orbit.friend_shares where person_id = ${s.people.ana!}::uuid`,
      ),
    ).toBe(0);
    await expect(
      t.db
        .sql`insert into orbit.friend_shares (owner_user_id, person_id, display_name, linkedin_slug, closeness)
               values (${s.userId}::uuid, ${s.people.ana!}::uuid, 'Ana Lopez', 'ana', 1)`,
    ).rejects.toThrow(/not listed/);

    // a second switch before the first job ran: only the last one's job runs to the end
    await switchSource(t.db, sqlQueue(t.db), s.userId, 'x', { state: 'off' }, NOW);
    await switchSource(t.db, sqlQueue(t.db), s.userId, 'x', { state: 'on' }, NOW);
    await drain(t, handlers, () => NOW);
    expect(await graph()).toBe(2);
  });
});

describe('Off', () => {
  it('pauses drafts waiting to go out on that channel, with a note, and leaves the others', async () => {
    const s = await seedStudent(t, {
      base: true,
      rows: ALL,
      states: { instagram: 'on', x: 'on', imessage: 'on' },
    });
    const draft = async (personId: string, channel: string, status: string) =>
      (
        await t.db.sql<{ id: string }>`
          insert into orbit.drafts (user_id, person_id, channel, kind, body, status, send_at)
          values (${s.userId}::uuid, ${personId}::uuid, ${channel}, 'outreach', 'Hi there', ${status},
                  ${NOW.toISOString()}::timestamptz)
          returning id`
      )[0]!.id;
    const ig = await draft(s.people.ivy!, 'instagram', 'approved');
    const igDraft = await draft(s.people.ivy!, 'instagram', 'draft');
    const mail = await draft(s.people.ana!, 'gmail', 'approved');
    const r = await switchSource(t.db, sqlQueue(t.db), s.userId, 'instagram', { state: 'off' }, NOW);
    expect(r.paused).toBe(1);
    const rows = await t.db.sql<{ id: string; status: string; error: string | null; send_at: Date | null }>`
      select id, status, error, send_at from orbit.drafts where user_id = ${s.userId}::uuid`;
    const by = new Map(rows.map((x) => [x.id, x]));
    expect(by.get(ig)).toMatchObject({ status: 'draft', error: 'source_off:instagram', send_at: null });
    expect(by.get(igDraft)).toMatchObject({ status: 'draft', error: null });
    expect(by.get(mail)).toMatchObject({ status: 'approved', error: null });
    const [note] = await t.db.sql<{ details: { note: string } }>`
      select details from orbit.audit_log where user_id = ${s.userId}::uuid and action = 'draft.paused'`;
    expect(note?.details.note).toBe('Instagram is off, so this was not sent. Pick another way to send it.');
  });
});

describe('Removed', () => {
  it('deletes exactly what the source brought, keeps people with a chat or a note without the handle', async () => {
    const s = await seedStudent(t, {
      base: true,
      rows: ALL,
      states: { instagram: 'on', x: 'on', imessage: 'on' },
    });
    const u = s.userId;
    const other = await makeUser(t.db);
    // Ivy has a chat in the pipeline, with a stage moved by an Instagram reply; Uma has nothing
    const [chat] = await t.db.sql<{ id: string }>`
      insert into orbit.chats (user_id, person_id, stage) values (${u}::uuid, ${s.people.ivy!}::uuid, 'replied')
      returning id`;
    await t.db
      .sql`insert into orbit.stage_events (user_id, chat_id, from_stage, to_stage, status, actor, evidence)
                   values (${u}::uuid, ${chat!.id}::uuid, 'reached_out', 'replied', 'applied', 'agent',
                           ${{ provider: 'instagram' }}::jsonb)`;
    await t.db.sql`insert into orbit.social_not_same (user_id, platform, account_id, person_id)
                   values (${u}::uuid, 'instagram', 'ig_dan', ${s.people.ana!}::uuid)`;
    await t.db.sql`insert into orbit.social_match_asks (user_id, platform, account_id, person_id, score)
                   values (${u}::uuid, 'instagram', 'ig_ana', ${s.people.ana!}::uuid, 0.8)`;
    await t.db.sql`insert into orbit.social_lookups (user_id, platform, target_person_id, target_account_id)
                   values (${u}::uuid, 'instagram', ${s.people.cara!}::uuid, 'ig_cara')`;
    // an email Ben's Instagram account added
    await t.db
      .sql`insert into orbit.person_identities (user_id, person_id, kind, value_norm, source, social_account_id)
                   values (${u}::uuid, ${s.people.ben!}::uuid, 'email', 'ben@insta.example', 'instagram', 'ig_ben')`;
    // the shared graph: a public list's rows and another student's own rows stay
    await t.db.sql`insert into orbit.social_follows (platform, follower_id, followed_id, owner_user_id)
                   values ('instagram', 'ig_cara', 'ig_ivy', null), ('instagram', 'ig_other', 'ig_ivy', ${other}::uuid)`;
    const [queuedDraft] = await t.db.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, channel, kind, body, status)
      values (${u}::uuid, ${s.people.ivy!}::uuid, 'instagram', 'outreach', 'Hi', 'scheduled') returning id`;

    const r = await switchSource(t.db, sqlQueue(t.db), u, 'instagram', { state: 'removed' }, NOW);
    expect(r.removed).toMatchObject({ peopleDeleted: 1, peopleKept: 1, drafts: 1, links: 3, follows: 5 });
    const count = (q: Promise<unknown[]>) => q.then((x) => x.length);
    expect(
      await count(
        t.db.sql`select 1 from orbit.messages where user_id = ${u}::uuid and provider = 'instagram'`,
      ),
    ).toBe(0);
    expect(
      await count(
        t.db.sql`select 1 from orbit.threads where user_id = ${u}::uuid and provider = 'instagram'`,
      ),
    ).toBe(0);
    expect(
      await count(t.db.sql`select 1 from orbit.ties where user_id = ${u}::uuid and kind like 'instagram%'`),
    ).toBe(0);
    expect(
      await count(t.db.sql`select 1 from orbit.person_identities where user_id = ${u}::uuid
                            and (kind = 'instagram_id' or social_account_id = 'ig_ben')`),
    ).toBe(0);
    expect(await count(t.db.sql`select 1 from orbit.social_links where user_id = ${u}::uuid`)).toBe(1); // X's
    expect(await count(t.db.sql`select 1 from orbit.social_match_asks where user_id = ${u}::uuid`)).toBe(0);
    expect(await count(t.db.sql`select 1 from orbit.social_lookups where user_id = ${u}::uuid`)).toBe(0);
    expect(
      await count(
        t.db
          .sql`select 1 from orbit.social_follows where owner_user_id = ${u}::uuid and platform = 'instagram'`,
      ),
    ).toBe(0);
    expect(
      await count(
        t.db.sql`select 1 from orbit.social_follows where owner_user_id = ${u}::uuid and platform = 'x'`,
      ),
    ).toBe(2);
    expect(
      await count(t.db.sql`select 1 from orbit.social_list_reads where owner_user_id = ${u}::uuid`),
    ).toBe(0);
    expect(
      await count(t.db
        .sql`select 1 from orbit.social_follows where platform = 'instagram' and followed_id = 'ig_ivy'
                            and (owner_user_id is null or owner_user_id = ${other}::uuid)`),
    ).toBe(2);
    // "not the same person" answers are kept so they are not asked again
    expect(await count(t.db.sql`select 1 from orbit.social_not_same where user_id = ${u}::uuid`)).toBe(1);
    // Uma (no chat, no note) is gone; Ivy stays, as the student's own, without the handle
    const people = await t.db.sql<{ display_name: string; sources: string[]; source_account: string | null }>`
      select display_name, sources, source_account from orbit.people
       where user_id = ${u}::uuid and display_name in ('Ivy Park', 'Uma Bell')`;
    expect(people).toEqual([{ display_name: 'Ivy Park', sources: ['manual'], source_account: null }]);
    // the chat stays where it is; its evidence says the source was removed
    const [ev] = await t.db.sql<{ stage: string; evidence: Record<string, unknown> }>`
      select c.stage, se.evidence from orbit.chats c join orbit.stage_events se on se.chat_id = c.id
       where c.id = ${chat!.id}::uuid`;
    expect(ev).toEqual({ stage: 'replied', evidence: { provider: 'instagram', sourceRemoved: 'instagram' } });
    // the queued draft becomes an unsent draft to copy
    const [d] = await t.db.sql<{ status: string; error: string }>`
      select status, error from orbit.drafts where id = ${queuedDraft!.id}::uuid`;
    expect(d).toEqual({ status: 'draft', error: 'source_removed:instagram' });
    const [acct] = await t.db.sql<{ status: string; social_account_id: string | null }>`
      select status, social_account_id from orbit.integration_accounts where user_id = ${u}::uuid and provider = 'instagram'`;
    expect(acct).toEqual({ status: 'revoked', social_account_id: null });
    // X and texts are untouched
    expect(
      await count(t.db.sql`select 1 from orbit.messages where user_id = ${u}::uuid and provider = 'x'`),
    ).toBe(2);
    expect(await count(t.db.sql`select 1 from orbit.text_days where user_id = ${u}::uuid`)).toBe(5);
    // the person deleted reaches the browser through the audit log
    expect(
      await count(t.db.sql`select 1 from orbit.audit_log where user_id = ${u}::uuid and action = 'sync.delete'
                            and target_table = 'people'`),
    ).toBe(1);
  });

  it('texts: the days, the numbers the browser sent and the people only texts know go', async () => {
    const s = await seedStudent(t, { base: true, rows: ['imessage'], states: { imessage: 'on' } });
    await switchSource(t.db, sqlQueue(t.db), s.userId, 'imessage', { state: 'removed' }, NOW);
    expect(await t.db.sql`select 1 from orbit.text_days where user_id = ${s.userId}::uuid`).toHaveLength(0);
    expect(
      await t.db
        .sql`select 1 from orbit.people where user_id = ${s.userId}::uuid and display_name = 'Tia Moss'`,
    ).toHaveLength(0);
    expect(
      await t.db
        .sql`select 1 from orbit.person_identities where user_id = ${s.userId}::uuid and kind = 'phone'`,
    ).toHaveLength(0);
    expect(
      await t.db
        .sql`select 1 from orbit.people where user_id = ${s.userId}::uuid and display_name = 'Ana Lopez'`,
    ).toHaveLength(1);
  });
});

describe('delete_user', () => {
  it("takes the student's own accounts out of the shared graph and suppresses them", async () => {
    const s = await seedStudent(t, { base: true, rows: ['instagram', 'x'] });
    const other = await makeUser(t.db);
    await t.db.sql`
      insert into orbit.social_accounts (platform, account_id, username) values ('instagram', 'ig_me', 'me'),
             ('x', 'x_me', 'me'), ('instagram', 'ig_zed', 'cara')`;
    await t.db.sql`
      insert into orbit.social_follows (platform, follower_id, followed_id, owner_user_id)
      values ('instagram', 'ig_zed', 'ig_me', null), ('instagram', 'ig_me', 'ig_zed', ${other}::uuid),
             ('x', 'x_wes', 'x_me', null), ('instagram', 'ig_zed', 'ig_yan', null)`;
    await t.db.sql`
      insert into orbit.social_list_reads (platform, account_id, list, owner_user_id, read_by, rows_read, ended)
      values ('instagram', 'ig_me', 'followers', null, ${other}::uuid, 1, true),
             ('instagram', 'ig_zed', 'followers', null, ${s.userId}::uuid, 2, true)`;
    await t.db.sql`select orbit.delete_user(${s.userId}::uuid)`;
    const left = await t.db.sql<{ platform: string; follower_id: string; followed_id: string }>`
      select platform, follower_id, followed_id from orbit.social_follows
       where follower_id in ('ig_me', 'x_me', 'ig_zed', 'x_wes') or followed_id in ('ig_me', 'x_me')
       order by platform, follower_id`;
    expect(left).toEqual([{ platform: 'instagram', follower_id: 'ig_zed', followed_id: 'ig_yan' }]);
    expect(
      await t.db.sql`select 1 from orbit.social_accounts where account_id in ('ig_me', 'x_me')`,
    ).toHaveLength(0);
    const reads = await t.db.sql<{ account_id: string; read_by: string | null }>`
      select account_id, read_by from orbit.social_list_reads where platform = 'instagram' order by account_id`;
    expect(reads).toEqual([{ account_id: 'ig_zed', read_by: null }]);
    const suppressed = await t.db.sql<{ platform: string; account_id: string; reason: string }>`
      select platform, account_id, reason from orbit.social_suppressed where account_id in ('ig_me', 'x_me')
       order by platform`;
    expect(suppressed).toEqual([
      { platform: 'instagram', account_id: 'ig_me', reason: 'deleted_user' },
      { platform: 'x', account_id: 'x_me', reason: 'deleted_user' },
    ]);
    expect(
      await t.db.sql`select 1 from orbit.social_follows where owner_user_id = ${s.userId}::uuid`,
    ).toHaveLength(0);
  });
});

describe('a student with no optional source', () => {
  it('keeps exactly the scores they have, offered or not', async () => {
    const run = async (sources: Awaited<ReturnType<typeof sourcesFor>>) => {
      const s = await seedStudent(t, { base: true, rows: [] });
      const srcFor = sources.offered.length ? await sourcesFor(t.db, s.userId, sources.offered) : sources;
      await scorePeople(t.db, s.userId, { now: NOW, fit: true, sources: srcFor });
      await scorePeople(t.db, s.userId, { now: NOW, fit: true, sources: srcFor });
      return t.db.sql<Record<string, unknown>>`
        select p.display_name, p.strength, p.last_interaction_at, ts.score, ts.share_score, ts.band, ts.features,
               ts.contributions, ts.explanation
          from orbit.people p join orbit.tie_scores ts on ts.person_id = p.id
         where p.user_id = ${s.userId}::uuid order by p.display_name`;
    };
    const none = await run(NO_SOURCES);
    const offered = await run({ ...NO_SOURCES, offered: ALL });
    expect(offered).toEqual(none);
    expect(none.length).toBe(4);
  });
});
