/**
 * Plan 43 §3.6, §8.3: the Instagram lookup end to end on a fake Unipile with a known follow graph. Every bridge is
 * found and none invented; a one-way follow is support only; a partial list never says "no one"; a zero count ends
 * the lookup only when the whole circle is accounts the student follows; a second student asking about the same
 * target makes no call; a list of an account that turned private is dropped, not reused; an unfollow removes the tie
 * on the next lookup; a lookup the budget stops resumes where it was; and the bridge carries a warm path.
 */
import { socialFollowWeight } from '@orbit/core/graph/ties';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../functions/_shared/db.ts';
import { findPaths } from '../../functions/_shared/paths/find.ts';
import { sqlQueue } from '../../functions/_shared/queue.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import { UNLIMITED } from '../../functions/_shared/social/budget.ts';
import { readListPage } from '../../functions/_shared/social/graph.ts';
import { createInstagramAdapter } from '../../functions/_shared/social/instagram.ts';
import { attachAccount } from '../../functions/_shared/social/links.ts';
import { startLookup } from '../../functions/_shared/social/lookup.ts';
import { socialHandlers } from '../../functions/orbit-worker/handlers/social.ts';
import type { JobHandler } from '../../functions/orbit-worker/worker.ts';
import { agentConfig, fakeNet, signedInUser } from '../helpers/agents.ts';
import { FakeInstagram } from '../helpers/fakeInstagram.ts';
import { clearQueues, drain } from '../helpers/ingest.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

let clock = Date.now();
const now = () => new Date(clock);
const BASE = 'https://api.unipile.test';
const noop: JobHandler = async () => {};

function handlersFor(fake: FakeInstagram): Record<string, JobHandler> {
  return {
    ...socialHandlers({
      fetch: fake.fetch,
      unipile: { apiKey: 'unipile-placeholder', baseUrl: BASE },
      random: () => 0.5,
    }),
    'score.person': noop,
    friend_shares_refresh: noop,
  };
}

let seq = 0;
async function person(db: Db, userId: string, name: string, known = false): Promise<string> {
  const [first, ...rest] = name.split(' ');
  const [p] = await db.sql<{ id: string }>`
    insert into orbit.people (user_id, display_name, first_name, last_name, name_norm, sources, linkedin_connected_on)
    values (${userId}::uuid, ${name}, ${first}, ${rest.join(' ')}, ${name.toLowerCase()}, ${['test']}::text[],
            ${known ? new Date().toISOString() : null}::timestamptz)
    returning id`;
  return p!.id;
}

/**
 * A student signed in to Instagram as `me`, Instagram on, their own lists read from the fake (without counting those
 * reads), and the target's account attached to a person in their People by proof.
 */
async function student(
  fake: FakeInstagram,
  me: string,
  target: string,
  opts: { known?: Record<string, string> } = {},
) {
  const { userId } = await signedInUser(t);
  seq++;
  const unipileAccount = `acc-ig-${seq}`;
  await t.db.sql`
    insert into orbit.integration_accounts (user_id, provider, external_account_id, social_account_id, status)
    values (${userId}::uuid, 'instagram', ${unipileAccount}, ${me}, 'active')`;
  await t.db
    .sql`insert into orbit.source_states (user_id, source, state) values (${userId}::uuid, 'instagram', 'on')`;
  const free = createInstagramAdapter({
    fetch: fake.fetch,
    apiKey: 'k',
    baseUrl: BASE,
    accountId: unipileAccount,
    budget: UNLIMITED,
  });
  const before = fake.calls.length;
  for (const list of ['following', 'followers'] as const)
    for (;;) {
      const page = await readListPage(t.db, free, {
        accountId: me,
        list,
        owner: userId,
        readBy: userId,
        now: now(),
        keepAccounts: true,
      });
      if (page.ended) break;
    }
  fake.calls.splice(before);
  const targetPerson = await person(t.db, userId, 'Priya Target');
  await attachAccount(t.db, userId, {
    platform: 'instagram',
    accountId: target,
    personId: targetPerson,
    via: 'proof',
    proof: 'links_back',
    now: now(),
  });
  // people the student knows, with their accounts attached (a texting friend whose account they do not follow)
  const known: Record<string, string> = {};
  for (const [account, name] of Object.entries(opts.known ?? {})) {
    known[account] = await person(t.db, userId, name, true);
    await attachAccount(t.db, userId, {
      platform: 'instagram',
      accountId: account,
      personId: known[account]!,
      via: 'student',
      now: now(),
    });
  }
  return { userId, unipileAccount, targetPerson, known };
}

async function lookup(fake: FakeInstagram, userId: string, targetPerson: string) {
  const { lookupId } = await startLookup(t.db, sqlQueue(t.db), userId, 'instagram', targetPerson);
  const before = fake.calls.length;
  await drain(t, handlersFor(fake), now, { maxTicks: 30 });
  const [l] = await t.db.sql<{
    status: string;
    state: Record<string, unknown>;
    result: {
      bridges: { personId: string; accountId: string }[];
      oneWay: { personId: string; accountId: string; followerId: string }[];
      partial: boolean;
      reason?: string;
    };
  }>`select status, state, result from orbit.social_lookups where id = ${lookupId}::uuid`;
  return { ...l!, lookupId, calls: fake.calls.slice(before) };
}

async function ties(userId: string) {
  return t.db.sql<{ a: string; b: string; kind: string; weight: number; evidence: Record<string, unknown> }>`
    select a_person_id as a, b_person_id as b, kind, weight, evidence from orbit.ties
     where user_id = ${userId}::uuid and kind in ('instagram_mutual', 'instagram_follow')`;
}

const has = (rows: { a: string; b: string; kind: string }[], x: string, y: string, kind: string) =>
  rows.some((r) => r.kind === kind && ((r.a === x && r.b === y) || (r.a === y && r.b === x)));

/**
 * The known graph, per prefix: the student follows A, B, C and D; A, B and C follow back (the circle), D does not.
 * E is a friend the student texts (attached to a person they know) whose account they do not follow. The target T
 * and A follow each other, and T and E; B follows T, who does not follow back; C and D have nothing to do with T.
 */
function world(prefix: string) {
  const id = (x: string) => `${prefix}-${x}`;
  const me = id('me');
  const fake = new FakeInstagram(me, () => clock, BASE);
  fake
    .add({ id: id('A'), username: `${prefix}.alex`, name: 'Alex Bridge' })
    .add({ id: id('B'), username: `${prefix}.blair`, name: 'Blair Oneway' })
    .add({ id: id('C'), username: `${prefix}.casey`, name: 'Casey None' })
    .add({ id: id('D'), username: `${prefix}.dana`, name: 'Dana Follow' })
    .add({ id: id('E'), username: `${prefix}.erin`, name: 'Erin Text' })
    .add({ id: id('T'), username: `${prefix}.priya`, name: 'Priya Target' });
  for (let i = 0; i < 6; i++)
    fake.add({ id: id(`x${i}`), username: `${prefix}.x${i}`, name: `Other Person${i}` });
  for (const x of ['A', 'B', 'C', 'D']) fake.follow(me, id(x));
  for (const x of ['A', 'B', 'C']) fake.follow(id(x), me);
  fake.mutual(id('T'), id('A')).mutual(id('T'), id('E')).follow(id('B'), id('T'));
  for (let i = 0; i < 6; i++) fake.follow(id(`x${i}`), id('T')).follow(id('T'), id(`x${i}`));
  return { fake, me, id };
}

describe('the Instagram lookup on a known graph', () => {
  const w = world('g1');
  let s: Awaited<ReturnType<typeof student>>;

  it('finds every bridge and invents none; a one-way follow is support only', async () => {
    await clearQueues(t);
    s = await student(w.fake, w.me, w.id('T'), { known: { [w.id('E')]: 'Erin Text' } });
    const r = await lookup(w.fake, s.userId, s.targetPerson);
    expect(r.status).toBe('done');
    expect(r.result.partial).toBe(false);
    expect(r.result.bridges.map((b) => b.accountId).sort()).toEqual([w.id('A'), w.id('E')]);
    expect(r.result.oneWay.map((b) => b.accountId)).toEqual([w.id('B')]);
    // one profile read (the count) and the target's two lists, nothing else
    expect(r.calls.map((c) => c.path.split('?')[0])).toEqual([
      `/api/v1/users/${w.id('T')}`,
      '/api/v1/users/following',
      '/api/v1/users/followers',
    ]);
    // the count was read for this lookup and not kept
    expect(r.state.count).toBeUndefined();
    const rows = await ties(s.userId);
    const a = r.result.bridges.find((b) => b.accountId === w.id('A'))!.personId;
    const e = s.known[w.id('E')]!;
    const b = r.result.oneWay[0]!.personId;
    expect(has(rows, a, s.targetPerson, 'instagram_mutual')).toBe(true);
    expect(has(rows, e, s.targetPerson, 'instagram_mutual')).toBe(true);
    expect(has(rows, b, s.targetPerson, 'instagram_mutual')).toBe(false);
    const follow = rows.find((x) => x.kind === 'instagram_follow')!;
    expect(follow.evidence.followerId).toBe(b);
    expect(
      rows
        .filter((x) => x.kind === 'instagram_mutual')
        .every((x) => Math.abs(x.weight - socialFollowWeight(undefined, 7)) < 1e-6),
    ).toBe(true);
    // the bridge Orbit had no person for became one, unlisted, from the account
    const [ap] = await t.db.sql<{ listed: boolean; source_account: string }>`
      select listed, source_account from orbit.people where id = ${a}::uuid`;
    expect(ap).toEqual({ listed: false, source_account: `instagram:${w.id('A')}` });
    // and the student was told
    const [n] = await t.db.sql<{ title: string; body: string }>`
      select title, body from orbit.notifications where user_id = ${s.userId}::uuid and kind = 'social_lookup'`;
    expect(n!.title).toBe('Finished checking Instagram for Priya');
    expect(n!.body).not.toMatch(/[!—]/);
  });

  it('carries a warm path through the bridge, only while Instagram is offered and on', async () => {
    const off = makeServices(agentConfig(fakeNet(), {}), { db: t.db, now });
    const hidden = await findPaths(off, s.userId, { target: { personId: s.targetPerson } });
    const viaBridge = (paths: typeof hidden.paths, id: string) =>
      paths.some((p) => p.nodes.includes(id) || p.nodes.includes(s.known[w.id('E')]!));
    const services = makeServices(agentConfig(fakeNet(), { extraSources: ['instagram'] }), { db: t.db, now });
    const got = await findPaths(services, s.userId, { target: { personId: s.targetPerson } });
    const a = (
      await t.db.sql<{ id: string }>`
      select id from orbit.people where user_id = ${s.userId}::uuid and source_account = ${`instagram:${w.id('A')}`}`
    )[0]!.id;
    expect(viaBridge(got.paths, a)).toBe(true);
    // with Instagram not offered (the shipped default) the same rows carry no path
    expect(viaBridge(hidden.paths, a)).toBe(false);
  });

  it('a second student asking about the same target makes no call', async () => {
    w.fake.add({ id: w.id('me2'), username: 'g1.me2', name: 'Robin Second' });
    // the second student's own lists name A as someone they follow each other with
    const second = await (async () => {
      const fake2 = new FakeInstagram(w.id('me2'), () => clock, BASE);
      for (const v of w.fake.accounts.values()) fake2.add(v);
      fake2.follows = [...w.fake.follows];
      fake2.mutual(w.id('me2'), w.id('A'));
      return student(fake2, w.id('me2'), w.id('T'));
    })();
    const r = await lookup(w.fake, second.userId, second.targetPerson);
    expect(r.status).toBe('done');
    expect(r.calls).toEqual([]);
    expect(r.result.bridges.map((b) => b.accountId)).toEqual([w.id('A')]);
  });

  it('an unfollow removes the tie on the next lookup that reads the list again', async () => {
    w.fake.unfollow(w.id('A'), w.id('T'));
    // the lists were read more than a week ago: a lookup reads them again rather than trusting them
    await t.db.sql`
      update orbit.social_list_reads set read_at = read_at - interval '8 days' where account_id = ${w.id('T')}`;
    await t.db.sql`
      update orbit.social_follows set seen_at = seen_at - interval '8 days'
       where owner_user_id is null and (follower_id = ${w.id('T')} or followed_id = ${w.id('T')})`;
    const r = await lookup(w.fake, s.userId, s.targetPerson);
    expect(r.status).toBe('done');
    expect(r.result.bridges.map((b) => b.accountId)).toEqual([w.id('E')]);
    const rows = await ties(s.userId);
    const a = (
      await t.db.sql<{ id: string }>`
      select id from orbit.people where user_id = ${s.userId}::uuid and source_account = ${`instagram:${w.id('A')}`}`
    )[0]!.id;
    expect(has(rows, a, s.targetPerson, 'instagram_mutual')).toBe(false);
    // T still follows A: kept as one-way support, the target as the follower
    const f = rows.find((x) => x.kind === 'instagram_follow' && (x.a === a || x.b === a))!;
    expect(f.evidence.followerId).toBe(s.targetPerson);
  });

  it('a list of an account that turned private is dropped, not reused', async () => {
    const fresh = await (async () => {
      const fake3 = new FakeInstagram(w.id('me3'), () => clock, BASE);
      for (const [, v] of w.fake.accounts) fake3.add(v);
      fake3.add({ id: w.id('me3'), username: 'g1.me3', name: 'Jo Third' });
      fake3.follows = [...w.fake.follows];
      fake3.mutual(w.id('me3'), w.id('E'));
      return student(fake3, w.id('me3'), w.id('T'));
    })();
    w.fake.accounts.get(w.id('T'))!.isPrivate = true;
    // another read saw it turn private
    await t.db.sql`update orbit.social_accounts set is_private = true where account_id = ${w.id('T')}`;
    const r = await lookup(w.fake, fresh.userId, fresh.targetPerson);
    expect(r.status).toBe('done');
    expect(r.result.reason).toBe('private');
    expect(r.result.bridges).toEqual([]);
    expect(r.calls.map((c) => c.path.split('?')[0])).toEqual([`/api/v1/users/${w.id('T')}`]);
    const [left] = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.social_list_reads where account_id = ${w.id('T')} and owner_user_id is null`;
    expect(left!.n).toBe(0);
    w.fake.accounts.get(w.id('T'))!.isPrivate = false;
  });
});

describe('when the lookup may stop', () => {
  it('a zero count ends it only when the whole circle is accounts the student follows', async () => {
    await clearQueues(t);
    const w = world('g2');
    // nobody the student follows follows T
    w.fake.unfollow(w.id('A'), w.id('T')).unfollow(w.id('B'), w.id('T'));
    const s1 = await student(w.fake, w.me, w.id('T'));
    const r1 = await lookup(w.fake, s1.userId, s1.targetPerson);
    expect(r1.result).toMatchObject({ bridges: [], partial: false, reason: 'none' });
    expect(r1.calls).toHaveLength(1);

    // with a texting friend in the circle whose account the student does not follow, it reads on, and finds them
    const w2 = world('g3');
    w2.fake.unfollow(w2.id('A'), w2.id('T')).unfollow(w2.id('B'), w2.id('T'));
    const s2 = await student(w2.fake, w2.me, w2.id('T'), { known: { [w2.id('E')]: 'Erin Text' } });
    const r2 = await lookup(w2.fake, s2.userId, s2.targetPerson);
    expect(r2.calls.length).toBeGreaterThan(1);
    expect(r2.result.bridges.map((b) => b.accountId)).toEqual([w2.id('E')]);
  });

  it('a partial list never says no one', async () => {
    await clearQueues(t);
    const w = world('g4');
    // a verified target returns only a sample of followers; its lists are too long to read whole
    const T = w.fake.accounts.get(w.id('T'))!;
    T.verified = true;
    T.followersCount = 80_000;
    T.followingCount = 3_000;
    for (const x of ['A', 'B', 'C', 'E']) {
      const a = w.fake.accounts.get(w.id(x))!;
      a.followersCount = 5_000;
      a.followingCount = 5_000;
    }
    w.fake.unfollow(w.id('A'), w.id('T'));
    const s = await student(w.fake, w.me, w.id('T'), { known: { [w.id('E')]: 'Erin Text' } });
    // what earlier profile reads said about the circle's own lists: too long to read whole as well
    for (const x of ['A', 'B', 'C', 'E'])
      await t.db.sql`
        insert into orbit.social_accounts (platform, account_id, username, name, followers, following, kind)
        values ('instagram', ${w.id(x)}, ${x}, ${`${x} Person`}, 5000, 5000, 'person')
        on conflict (platform, account_id) do update set followers = 5000, following = 5000`;
    const r = await lookup(w.fake, s.userId, s.targetPerson);
    expect(r.status).toBe('done');
    expect(r.result.partial).toBe(true);
    expect(r.result.reason).toBeUndefined();
    const [n] = await t.db.sql<{ body: string }>`
      select body from orbit.notifications where user_id = ${s.userId}::uuid and kind = 'social_lookup'`;
    expect(n!.body).toMatch(/only part/);
  });

  it('resumes where it stopped after the budget refuses', async () => {
    await clearQueues(t);
    const w = world('g5');
    const s = await student(w.fake, w.me, w.id('T'), { known: { [w.id('E')]: 'Erin Text' } });
    // eight calls already this hour: the student's own request has two left
    await t.db.sql`
      insert into orbit.social_call_log (platform, account, kind, caller, at)
      select 'instagram', ${s.unipileAccount}, 'list', 'background', ${new Date(clock - 10 * 60_000)}::timestamptz
        from generate_series(1, 8)`;
    const { lookupId } = await startLookup(t.db, sqlQueue(t.db), s.userId, 'instagram', s.targetPerson);
    const h = handlersFor(w.fake);
    await drain(t, h, now, { maxTicks: 3 });
    const [mid] = await t.db.sql<{
      status: string;
    }>`select status from orbit.social_lookups where id = ${lookupId}::uuid`;
    expect(mid!.status).toBe('waiting');
    expect(w.fake.calls).toHaveLength(2);
    clock += 61 * 60_000;
    await drain(t, h, now, { maxTicks: 10 });
    const [end] = await t.db.sql<{ status: string; result: { bridges: { accountId: string }[] } }>`
      select status, result from orbit.social_lookups where id = ${lookupId}::uuid`;
    expect(end!.status).toBe('done');
    expect(end!.result.bridges.map((b) => b.accountId).sort()).toEqual([w.id('A'), w.id('E')]);
    // the same three reads as a lookup that was never stopped: nothing read twice
    expect(w.fake.calls).toHaveLength(3);
  });
});
