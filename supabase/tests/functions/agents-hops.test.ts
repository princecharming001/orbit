/**
 * Plan 21 in account mode: the migration, blocked pairs and the new tie kinds in /paths/find, the hop corrections
 * routes, the hop_evidence job end to end through the worker (Unipile faked), and intro outcome logging.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mutuals from '../../functions/_shared/__fixtures__/unipile-mutuals.json';
import { sharedLedgerBucket } from '../../functions/_shared/paths/hopJob.ts';
import { introOutcomes } from '../../functions/_shared/paths/outcomes.ts';
import { ledgerBucket } from '../../functions/orbit-connectors/connectors.ts';
import { defaultHandlers, runTick } from '../../functions/orbit-worker/worker.ts';
import {
  ALL_KEYS,
  addPerson,
  addTie,
  agentConfig,
  api,
  DAY,
  fakeNet,
  jsonRes,
  type NetCall,
  signedInUser,
  UNIPILE,
} from '../helpers/agents.ts';
import { freshDb, makeUser, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

type Hop = { fromId: string; toId: string; p: number; kind: string; band?: string };
type Found = {
  paths: { id: string; nodes: string[]; p: number; firstHopId: string; hops: Hop[]; reasonText: string }[];
  fallback?: string;
  hopEvidence?: 'queued' | 'checked';
};
type PairState = { aPersonId: string; bPersonId: string; blocked: boolean; close: boolean };

const ENV = { ...ALL_KEYS, villageKey: undefined };
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

describe('migration 20261025_orbit_hop_strength', () => {
  it('accepts the plan 21 tie kinds and rejects others', async () => {
    const u = await makeUser(t.db);
    const ids = (
      await t.db.sql<{ id: string }>`
        insert into orbit.people (user_id, display_name, name_norm)
        values (${u}::uuid, 'A', 'a'), (${u}::uuid, 'B', 'b') returning id`
    )
      .map((r) => r.id)
      .sort();
    for (const kind of [
      'linkedin_recommendation',
      'linkedin_engagement',
      'linkedin_mention',
      'common_contacts',
      'student_says_close',
      'same_city',
    ])
      await t.db.sql`insert into orbit.ties (user_id, a_person_id, b_person_id, kind, weight, confidence)
        values (${u}::uuid, ${ids[0]!}::uuid, ${ids[1]!}::uuid, ${kind}, 0.5, 0.5)`;
    await expect(
      t.db.sql`insert into orbit.ties (user_id, a_person_id, b_person_id, kind, weight, confidence)
        values (${u}::uuid, ${ids[0]!}::uuid, ${ids[1]!}::uuid, 'gossip', 0.5, 0.5)`,
    ).rejects.toThrow(/ties_kind_check/);
  });

  it('keeps blocked pairs ordered and per user, with RLS on; adds hop_features, follower counts, account ids', async () => {
    const u = await makeUser(t.db);
    const [a, b] = (
      await t.db.sql<{ id: string }>`
        insert into orbit.people (user_id, display_name, name_norm)
        values (${u}::uuid, 'A', 'a'), (${u}::uuid, 'B', 'b') returning id`
    )
      .map((r) => r.id)
      .sort();
    await t.db
      .sql`insert into orbit.blocked_pairs (user_id, a_person_id, b_person_id) values (${u}::uuid, ${a!}::uuid, ${b!}::uuid)`;
    await expect(
      t.db
        .sql`insert into orbit.blocked_pairs (user_id, a_person_id, b_person_id) values (${u}::uuid, ${b!}::uuid, ${a!}::uuid)`,
    ).rejects.toThrow();
    const [rls] = await t.db.sql<{ rls: boolean }>`
      select c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'orbit' and c.relname = 'blocked_pairs'`;
    expect(rls!.rls).toBe(true);
    const cols = await t.db.sql<{ table_name: string; column_name: string }>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'orbit' and column_name in ('hop_features', 'linkedin_follower_count',
                                                       'linkedin_connections_count', 'account_id')
       order by 1, 2`;
    expect(cols.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      'intro_requests.hop_features',
      'people.linkedin_connections_count',
      'people.linkedin_follower_count',
      'usage_ledger.account_id',
    ]);
  });
});

describe('/paths/find with plan 21 evidence', () => {
  it('a blocked pair is no hop; a student_says_close tie routes; engagement alone never makes a route', async () => {
    const call = api(t, fakeNet(), { env: {} });
    const { userId, token } = await signedInUser(t);
    const arlan = await addPerson(t, userId, { name: 'Arlan Kade', title: 'Engineer' });
    const noah = await addPerson(t, userId, { name: 'Noah Bell', score: 65 });
    const jai = await addPerson(t, userId, { name: 'Jai Rao', score: 40 });
    const fan = await addPerson(t, userId, { name: 'Fay Nguyen', score: 70 });
    await addTie(t, userId, noah, arlan, 'linkedin_mutual', 0.3, 0.95);
    await addTie(t, userId, jai, arlan, 'linkedin_mutual', 0.3, 0.95);
    // engagement without any connection evidence: support only
    await addTie(t, userId, fan, arlan, 'linkedin_engagement', 0.25, 0.9, {
      counts: { [fan]: { comments: 3 } },
      reciprocal: false,
    });
    const r = await call<Found>('/paths/find', token, { target: { personId: arlan } });
    expect(r.status).toBe(200);
    expect(r.body.paths.map((p) => p.firstHopId).sort()).toEqual([jai, noah].sort());
    expect(r.body.paths[0]!.firstHopId).toBe(noah);
    const last = r.body.paths[0]!.hops.at(-1)!;
    expect(last).toMatchObject({ kind: 'linkedin_mutual', band: 'connected' });

    // "they're close": Jai's hop becomes close and his route goes first
    const closed = await call<PairState>('/pairs/close', token, { aPersonId: arlan, bPersonId: jai });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ blocked: false, close: true });
    const r2 = await call<Found>('/paths/find', token, { target: { personId: arlan } });
    expect(r2.body.paths[0]!.firstHopId).toBe(jai);
    expect(r2.body.paths[0]!.hops.at(-1)).toMatchObject({ kind: 'student_says_close', band: 'close' });

    // "they don't really know each other": Noah's route is gone, and stays gone until undone
    const blocked = await call<PairState>('/pairs/block', token, { aPersonId: noah, bPersonId: arlan });
    expect(blocked.body).toMatchObject({ blocked: true, close: false });
    expect(blocked.body.aPersonId < blocked.body.bPersonId).toBe(true);
    const r3 = await call<Found>('/paths/find', token, { target: { personId: arlan } });
    expect(r3.body.paths.map((p) => p.firstHopId)).toEqual([jai]);
    await call('/pairs/unblock', token, { aPersonId: noah, bPersonId: arlan });
    const r4 = await call<Found>('/paths/find', token, { target: { personId: arlan } });
    expect(r4.body.paths.map((p) => p.firstHopId).sort()).toEqual([jai, noah].sort());
  });
});

describe('/pairs/* corrections (plan 21 §3.5)', () => {
  it('validates both people are the user’s own, and the latest word wins', async () => {
    const call = api(t, fakeNet(), { env: {} });
    const { userId, token } = await signedInUser(t);
    const other = await signedInUser(t);
    const a = await addPerson(t, userId, { name: 'Ana Silva' });
    const b = await addPerson(t, userId, { name: 'Ben Cole' });
    const stranger = await addPerson(t, other.userId, { name: 'Sid Vale' });
    expect((await call('/pairs/block', token, { aPersonId: a, bPersonId: a })).status).toBe(400);
    expect((await call('/pairs/block', token, { aPersonId: a })).status).toBe(400);
    expect((await call('/pairs/close', token, { aPersonId: a, bPersonId: 'nope' })).status).toBe(400);
    expect((await call('/pairs/close', token, { aPersonId: a, bPersonId: stranger })).status).toBe(404);

    const c = await call<PairState>('/pairs/close', token, { aPersonId: b, bPersonId: a });
    expect(c.body).toEqual({
      aPersonId: a < b ? a : b,
      bPersonId: a < b ? b : a,
      blocked: false,
      close: true,
    });
    const [tie] = await t.db.sql<{ weight: number; confidence: number; evidence: { source: string } }>`
      select weight, confidence, evidence from orbit.ties
       where user_id = ${userId}::uuid and kind = 'student_says_close'`;
    expect(tie!.weight).toBeCloseTo(0.8);
    expect(tie!.confidence).toBeCloseTo(0.9);
    expect(tie!.evidence.source).toBe('student');
    // blocking takes back "close"; closing again lifts the block
    expect((await call<PairState>('/pairs/block', token, { aPersonId: a, bPersonId: b })).body).toMatchObject(
      {
        blocked: true,
        close: false,
      },
    );
    expect((await call<PairState>('/pairs/close', token, { aPersonId: a, bPersonId: b })).body).toMatchObject(
      {
        blocked: false,
        close: true,
      },
    );
    const u = await call<PairState>('/pairs/unclose', token, { aPersonId: a, bPersonId: b });
    expect(u.body).toMatchObject({ blocked: false, close: false });
    // the deleted tie reaches other devices through /sync/pull
    const audits = await t.db.sql<{ action: string; target_table: string }>`
      select action, target_table from orbit.audit_log where user_id = ${userId}::uuid and action = 'sync.delete'`;
    expect(audits.length).toBe(2);
    expect(audits.every((x) => x.target_table === 'ties')).toBe(true);
    // the other user's people are untouched
    expect(
      await t.db.sql`select 1 from orbit.blocked_pairs where user_id = ${other.userId}::uuid`,
    ).toHaveLength(0);
  });
});

/** Unipile for Dana Lee (target) with mutuals Mia (comments, Dana replies) and Omar (recommended Dana). */
function linkedin() {
  return fakeNet((c: NetCall) => {
    if (!c.url.startsWith(UNIPILE)) return undefined;
    const path = new URL(c.url).pathname.replace('/api/v1', '');
    switch (path) {
      case '/linkedin/search':
        return jsonRes(200, mutuals);
      case '/users/ACoAADanaLee':
        return jsonRes(200, {
          provider_id: 'ACoAADanaLee',
          shared_connections_count: 2,
          follower_count: 1200,
          connections_count: 500,
          recommendations: {
            received: [{ actor: { provider_id: 'ACoAAOmarHale' }, caption: 'Worked together', date: '2024' }],
            given: [],
          },
        });
      case '/users/ACoAADanaLee/posts':
        return jsonRes(200, {
          items: [{ id: '8001', parsed_datetime: ago(30), comment_counter: 2, text: 'post' }],
        });
      case '/users/ACoAADanaLee/comments':
        return jsonRes(200, {
          items: [{ id: '9100001', post_id: '8001', thread_id: '9000001', date: ago(28), text: 'thanks!' }],
        });
      case '/users/ACoAAMiaChen/reactions':
        return jsonRes(200, { items: [{ value: 'LIKE', post_id: '8001', author: { id: 'ACoAADanaLee' } }] });
      case '/users/ACoAAMiaChen/comments':
        return jsonRes(200, { items: [{ id: '9000001', post_id: '8001', date: ago(29), text: 'Congrats' }] });
      case '/posts/8001/comments':
        return jsonRes(200, {
          items: [{ id: '9000001', author_details: { id: 'ACoAAMiaChen' }, date: ago(29), text: 'Congrats' }],
        });
      default:
        if (/^\/users\/[^/]+\/(reactions|comments|posts)$/.test(path)) return jsonRes(200, { items: [] });
        return undefined;
    }
  });
}

async function linkedinUser() {
  const { userId, token } = await signedInUser(t);
  await t.db.sql`insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
    values (${userId}::uuid, 'linkedin', ${`acc-${userId}`}, 'active')`;
  const dana = await addPerson(t, userId, {
    name: 'Dana Lee',
    title: 'Partner',
    linkedinUrl: 'https://www.linkedin.com/in/dana-lee',
    memberId: 'ACoAADanaLee',
  });
  const mia = await addPerson(t, userId, {
    name: 'Mia Chen',
    score: 55,
    linkedinUrl: 'https://www.linkedin.com/in/mia-chen',
  });
  const omar = await addPerson(t, userId, {
    name: 'Omar Hale',
    score: 45,
    linkedinUrl: 'https://www.linkedin.com/in/omar-hale',
  });
  return { userId, token, dana, mia, omar, account: `acc-${userId}` };
}

const queued = async (userId: string) =>
  t.db.sql<{ kind: string; payload: { targetPersonId: string; mutualPersonIds: string[] } }>`
    select message->>'kind' as kind, message->'payload' as payload from pgmq.q_orbit_enrich
     where message->>'userId' = ${userId} and message->>'kind' = 'hop_evidence'`;

describe('hop_evidence job (plan 21 §5.3)', () => {
  it('find queues it for a target with mutuals; the worker stores the new ties; the next find is "checked"', async () => {
    const net = linkedin();
    const call = api(t, net, { env: ENV });
    const u = await linkedinUser();
    const r = await call<Found>('/paths/find', u.token, { target: { personId: u.dana } });
    expect(r.status).toBe(200);
    expect(r.body.hopEvidence).toBe('queued');
    // the search's member ids were kept for the people found by the same profile address
    const ids = await t.db.sql<{ id: string; linkedin_member_id: string }>`
      select id, linkedin_member_id from orbit.people where id = any(${[u.mia, u.omar]}::uuid[]) order by display_name`;
    expect(ids.map((x) => x.linkedin_member_id)).toEqual(['ACoAAMiaChen', 'ACoAAOmarHale']);
    const jobs = await queued(u.userId);
    expect(jobs).toHaveLength(1);
    // best first: the introducers of the ranked routes (Mia's route ranks above Omar's)
    expect(jobs[0]!.payload).toEqual({ targetPersonId: u.dana, mutualPersonIds: [u.mia, u.omar] });
    // finding paths read nothing beyond the mutuals search: the evidence is read by the job
    expect(net.calls.filter((c) => /\/(posts|reactions|comments)\b/.test(c.url))).toHaveLength(0);
    // a second open inside the day queues nothing new
    await call('/paths/find', u.token, { target: { personId: u.dana } });
    expect(await queued(u.userId)).toHaveLength(1);

    const before = net.calls.length;
    const tick = await runTick({ db: t.db, handlers: defaultHandlers(agentConfig(net, ENV)) });
    expect(tick.ok).toBeGreaterThanOrEqual(1);
    const reads = net.calls.slice(before).map((c) => new URL(c.url).pathname.replace('/api/v1', ''));
    expect(reads).toEqual([
      '/users/ACoAADanaLee',
      '/users/ACoAADanaLee/posts',
      '/users/ACoAADanaLee/reactions',
      '/users/ACoAADanaLee/comments',
      '/users/ACoAAMiaChen/reactions',
      '/users/ACoAAMiaChen/comments',
      '/users/ACoAAOmarHale/reactions',
      '/users/ACoAAOmarHale/comments',
      '/posts/8001/comments',
    ]);
    const ties = await t.db.sql<{ a: string; b: string; kind: string; weight: number; evidence: unknown }>`
      select a_person_id as a, b_person_id as b, kind, weight, evidence from orbit.ties
       where user_id = ${u.userId}::uuid and kind = any(${['linkedin_engagement', 'linkedin_recommendation']}::text[])
       order by kind`;
    const other = (x: { a: string; b: string }) => (x.a === u.dana ? x.b : x.a);
    expect(ties.map((x) => [x.kind, other(x)])).toEqual([
      ['linkedin_engagement', u.mia],
      ['linkedin_recommendation', u.omar],
    ]);
    expect(ties[0]!.evidence).toMatchObject({ reciprocal: true, popularityKnown: true });
    expect(JSON.stringify(ties)).not.toMatch(/Congrats|thanks!/);
    const cache = await t.db.sql<{ response: unknown }>`
      select response from orbit.research_cache where user_id = ${u.userId}::uuid`;
    expect(JSON.stringify(cache)).not.toMatch(/Congrats|thanks!/);
    // reads are counted against the LinkedIn account
    const [led] = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.usage_ledger
       where account_id = ${u.account} and provider = 'unipile' and operation = 'hop_read'`;
    expect(led!.n).toBe(9);
    // and taken from the account's LinkedIn ledgers the browser's connector shares
    const day = new Date().toISOString().slice(0, 10);
    const counters = await t.db.sql<{ bucket: string; count: number }>`
      select bucket, count from public.orbit_proxy_counters where bucket like ${`connectors:li:%:${day}:${u.account}`}
       order by bucket`;
    expect(counters.map((c) => [c.bucket.split(':')[2], c.count])).toEqual([
      ['posts', 8],
      ['profile', 1],
    ]);
    const [dana] = await t.db.sql<{ f: number; c: number }>`
      select linkedin_follower_count as f, linkedin_connections_count as c from orbit.people where id = ${u.dana}::uuid`;
    expect(dana).toEqual({ f: 1200, c: 500 });

    // the next find sees fresh evidence: hops carry the new kinds, nothing is queued, nothing is read
    await t.db.sql`delete from pgmq.q_orbit_enrich where message->>'userId' = ${u.userId}`;
    const n = net.calls.length;
    const r2 = await call<Found>('/paths/find', u.token, { target: { personId: u.dana } });
    expect(r2.body.hopEvidence).toBe('checked');
    expect(await queued(u.userId)).toHaveLength(0);
    expect(net.calls.length).toBe(n);
    const miaPath = r2.body.paths.find((p) => p.firstHopId === u.mia)!;
    expect(miaPath.hops.at(-1)!.p).toBeGreaterThan(0.285);
    expect(miaPath.reasonText).toContain('LinkedIn');
    const omarPath = r2.body.paths.find((p) => p.firstHopId === u.omar)!;
    expect(omarPath.hops.at(-1)!.kind).toBe('linkedin_recommendation');
  });

  it('stops at the account’s daily read budget and leaves nothing marked fresh', async () => {
    const net = linkedin();
    const call = api(t, net, { env: ENV });
    const u = await linkedinUser();
    // the account already spent 38 of its 40 reads today
    for (let i = 0; i < 38; i++)
      await t.db
        .sql`insert into orbit.usage_ledger (user_id, provider, operation, units, cost_usd, account_id)
        values (${u.userId}::uuid, 'unipile', 'hop_read', 1, 0, ${u.account})`;
    await call('/paths/find', u.token, { target: { personId: u.dana } });
    const before = net.calls.length;
    await runTick({ db: t.db, handlers: defaultHandlers(agentConfig(net, ENV)) });
    expect(net.calls.length - before).toBe(2);
    const [led] = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.usage_ledger where account_id = ${u.account} and operation = 'hop_read'`;
    expect(led!.n).toBe(40);
    await t.db.sql`delete from pgmq.q_orbit_enrich where message->>'userId' = ${u.userId}`;
    await t.db.sql`delete from orbit.job_runs where user_id = ${u.userId}::uuid`;
    const r = await call<Found>('/paths/find', u.token, { target: { personId: u.dana } });
    expect(r.body.hopEvidence).toBe('queued');
  });

  it('shares the account’s LinkedIn ledger with orbit-connectors: what the browser spent, the job cannot', async () => {
    const now = new Date();
    expect(sharedLedgerBucket('posts', 'acc9', now, 100)).toEqual(ledgerBucket('posts', 'acc9', now, 100));
    expect(sharedLedgerBucket('profile', 'acc9', now, 100)).toEqual(
      ledgerBucket('profile', 'acc9', now, 100),
    );
    const net = linkedin();
    const call = api(t, net, { env: ENV });
    const u = await linkedinUser();
    // the browser has read 100 posts pages on this account today
    const b = ledgerBucket('posts', u.account, now, 100);
    await t.db.sql`insert into public.orbit_proxy_counters (bucket, count, expires_at)
      values (${b.key}, 100, ${b.expires}::timestamptz)`;
    await call('/paths/find', u.token, { target: { personId: u.dana } });
    const before = net.calls.length;
    await runTick({ db: t.db, handlers: defaultHandlers(agentConfig(net, ENV)) });
    // the profile (its own ledger) is read; no page of posts, reactions or comments
    expect(net.calls.slice(before).map((c) => new URL(c.url).pathname)).toEqual([
      '/api/v1/users/ACoAADanaLee',
    ]);
    const [c] = await t.db.sql<{
      count: number;
    }>`select count from public.orbit_proxy_counters where bucket = ${b.key}`;
    expect(c!.count).toBe(100);
  });

  it('is skipped without a LinkedIn account, and never queued without one', async () => {
    const net = linkedin();
    const call = api(t, net, { env: ENV });
    const { userId, token } = await signedInUser(t);
    const dana = await addPerson(t, userId, { name: 'Dana Lee', memberId: 'ACoAADanaLee' });
    const mia = await addPerson(t, userId, { name: 'Mia Chen', score: 50, memberId: 'ACoAAMiaChen' });
    await addTie(t, userId, mia, dana, 'linkedin_mutual', 0.3, 0.95);
    const r = await call<Found>('/paths/find', token, { target: { personId: dana } });
    expect(r.body.hopEvidence).toBeUndefined();
    expect(await queued(userId)).toHaveLength(0);
    await t.db.sql`select orbit.enqueue('orbit_enrich', ${{
      kind: 'hop_evidence',
      userId,
      payload: { targetPersonId: dana, mutualPersonIds: [mia] },
    }}::jsonb)`;
    const tick = await runTick({ db: t.db, handlers: defaultHandlers(agentConfig(net, ENV)) });
    expect(tick.skipped).toBe(1);
  });
});

describe('intro outcome logging (plan 21 §8)', () => {
  it('freezes the path’s hop features on the intro request, and exports them with the outcome', async () => {
    const call = api(t, fakeNet(), { env: {} });
    const { userId, token } = await signedInUser(t);
    const target = await addPerson(t, userId, { name: 'Priya Ahmed', title: 'Product Manager' });
    const intro = await addPerson(t, userId, { name: 'Ana Silva', email: 'ana@example.com', score: 60 });
    await addTie(t, userId, intro, target, 'email_exchange', 0.8, 0.95);
    const found = await call<Found>('/paths/find', token, { target: { personId: target } });
    const path = found.body.paths[0]!;
    const r = await call<{ introRequestId: string }>('/intros/ask', token, {
      introducerPersonId: intro,
      targetPersonId: target,
      pathScore: path.p,
      path,
    });
    expect(r.status).toBe(200);
    const [row] = await t.db.sql<{ hop_features: { p: number; hops: Hop[] } }>`
      select hop_features from orbit.intro_requests where id = ${r.body.introRequestId}::uuid`;
    expect(row!.hop_features.p).toBeCloseTo(path.p, 4);
    expect(row!.hop_features.hops).toEqual(
      path.hops.map((h, i) => ({
        fromId: h.fromId,
        toId: h.toId,
        p: Math.round(h.p * 10_000) / 10_000,
        kind: h.kind,
        ...(i > 0 ? { band: h.band } : {}),
      })),
    );
    expect(row!.hop_features.hops.at(-1)).toMatchObject({ kind: 'email_exchange', toId: target });
    await t.db.sql`update orbit.intro_requests set status = 'intro_made', outcome_at = now()
      where id = ${r.body.introRequestId}::uuid`;
    const out = await introOutcomes(t.db, userId);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: r.body.introRequestId, status: 'intro_made', goalKind: null });
    expect(out[0]!.hops).toEqual(row!.hop_features.hops);
    expect(out[0]!.outcomeAt).not.toBeNull();
  });
});
