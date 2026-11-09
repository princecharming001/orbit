/**
 * Plan 35 B1 through the worker: a score run infers the ties once (one score.ties job per tie group, core inferTies
 * called once per group that uses it) and its score.page jobs only score; the result equals inferring the whole
 * network and scoring the pages in order; the next run rescores only people with something new, and everyone once a
 * week.
 */
import * as core from '@orbit/core/graph/ties';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { changedPeople, scorePeople } from '../../functions/_shared/ingest/score.ts';
import { refreshTies, TIE_GROUPS } from '../../functions/_shared/ingest/ties.ts';
import { SCORE_PAGE } from '../../functions/orbit-worker/handlers/score.ts';
import { defaultHandlers } from '../../functions/orbit-worker/worker.ts';
import { seedBigNetwork } from '../helpers/bigNetwork.ts';
import { clearQueues, connectedUser, drain } from '../helpers/ingest.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

vi.mock('@orbit/core/graph/ties', async (orig) => {
  const m = await orig<typeof import('@orbit/core/graph/ties')>();
  return { ...m, inferTies: vi.fn(m.inferTies) };
});
const inferTies = vi.mocked(core.inferTies);

const SHAPE = {
  people: 420,
  orgs: 90,
  cities: 40,
  schools: 30,
  withOrg: 0.6,
  withCity: 0.4,
  withSchool: 0.2,
  withHistory: 0.3,
  withEmail: 0.25,
  threads: 80,
  events: 25,
};
const NOW = new Date('2026-11-10T07:30:00Z');
const base = defaultHandlers({});
/** the person ids each score.page job scored, in order */
let paged: string[] = [];
const handlers: typeof base = {
  ...base,
  'score.page': async (job, ctx) => {
    paged.push(...((job.payload.personIds as string[]) ?? []));
    await base['score.page']!(job, ctx);
  },
};

let t: TestDb;
let u: string;
let ids: string[];
beforeAll(async () => {
  t = await freshDb();
  u = await connectedUser(t.db);
  ids = (await seedBigNetwork(t.db, u, SHAPE, 11)).personIds;
}, 120_000);
afterAll(async () => {
  await t.pg.close();
});
beforeEach(async () => {
  await clearQueues(t);
  inferTies.mockClear();
  paged = [];
});

const scoreUser = (payload: Record<string, unknown> = {}) =>
  t.db.sql`select orbit.enqueue('orbit_score', ${{ kind: 'score.user', userId: u, payload }}::jsonb, 0)`;

const pagedPeople = async () => paged;

const kindsRun = async () =>
  (await t.db.sql<{ kind: string }>`select kind from orbit.job_runs where status = 'ok' order by id`).map(
    (r) => r.kind,
  );

const tieRows = () =>
  t.db.sql<{ a: string; b: string; kind: string; w: number; c: number; ev: unknown }>`
    select a_person_id as a, b_person_id as b, kind, weight as w, confidence as c, evidence as ev
      from orbit.ties where user_id = ${u}::uuid order by 1, 2, 3`;
const scoreRows = () =>
  t.db.sql<{ person_id: string; score: number; share_score: number; band: string; features: unknown }>`
    select person_id, score, share_score, band, features from orbit.tie_scores where user_id = ${u}::uuid
     order by person_id`;
const peopleRows = () =>
  t.db.sql<{ id: string; strength: number; last: string | null }>`
    select id, strength, last_interaction_at::text as last from orbit.people
     where user_id = ${u}::uuid and not is_self order by id`;

describe('score.user (plan 35 B1)', () => {
  it('infers once per tie group, pages only score, and equals inferring the whole network then scoring the pages', async () => {
    const before = await peopleRows();
    await scoreUser();
    await drain(t, handlers, () => NOW);
    const ran = await kindsRun();
    expect(ran.filter((k) => k === 'score.ties')).toHaveLength(TIE_GROUPS.length);
    expect(ran.filter((k) => k === 'score.page')).toHaveLength(Math.ceil(ids.length / SCORE_PAGE));
    // interaction, employment and education run core's inference; same_city needs none; no page runs it
    expect(inferTies).toHaveBeenCalledTimes(TIE_GROUPS.filter((g) => g.name !== 'same_city').length);
    const viaJobs = { ties: await tieRows(), scores: await scoreRows(), people: await peopleRows() };
    expect(viaJobs.ties.length).toBeGreaterThan(100);
    expect(viaJobs.scores).toHaveLength(ids.length);

    // the reference: start again from the same rows, infer the whole network in one call, score the pages in order
    await t.db.sql`delete from orbit.ties where user_id = ${u}::uuid`;
    await t.db.sql`delete from orbit.tie_scores where user_id = ${u}::uuid`;
    await t.db.sql`
      update orbit.people p set strength = b.strength, last_interaction_at = b.last::timestamptz, scored_at = null
        from jsonb_to_recordset(${JSON.stringify(before)}::jsonb) as b(id uuid, strength real, last text)
       where p.id = b.id`;
    await refreshTies(t.db, u, NOW);
    for (let i = 0; i < ids.length; i += SCORE_PAGE)
      await scorePeople(t.db, u, { now: NOW, personIds: [...ids].sort().slice(i, i + SCORE_PAGE) });
    expect(await tieRows()).toEqual(viaJobs.ties);
    expect(await scoreRows()).toEqual(viaJobs.scores);
    expect(await peopleRows()).toEqual(viaJobs.people);
  }, 120_000);

  it('the next run rescores nobody when nothing changed, and only who has something new', async () => {
    await scoreUser({ full: true });
    await drain(t, handlers, () => NOW);
    await clearQueues(t);
    paged = [];
    const stamp = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.tie_scores where user_id = ${u}::uuid`;
    expect(stamp[0]!.n).toBe(ids.length);

    await scoreUser();
    await drain(t, handlers, () => NOW);
    expect(await pagedPeople()).toEqual([]);
    expect(await kindsRun()).not.toContain('score.page');
    expect(await changedPeople(t.db, u)).toEqual([]);

    // a new message from one person (a thread with only them: no new tie for anyone else)
    await clearQueues(t);
    paged = [];
    const someone = ids[17]!;
    const [th] = await t.db.sql<{ id: string }>`
      insert into orbit.threads (user_id, provider, external_id, participant_person_ids, participant_count, is_networking)
      values (${u}::uuid, 'gmail', 'delta-thread', ${[someone]}::uuid[], 1, true) returning id`;
    await t.db.sql`
      insert into orbit.messages (user_id, thread_id, provider, external_id, direction, from_person_id, from_addr,
                                  sent_at, body_text)
      values (${u}::uuid, ${th!.id}::uuid, 'gmail', 'delta-1', 'in', ${someone}::uuid, 'x@example.org',
              ${new Date(NOW.getTime() - 3_600_000)}::timestamptz, 'hi')`;
    await scoreUser();
    await drain(t, handlers, () => NOW);
    expect(await pagedPeople()).toEqual([someone]);

    // a label on someone else
    await clearQueues(t);
    paged = [];
    const other = ids[42]!;
    await t.db
      .sql`insert into orbit.tie_labels (user_id, person_id, closeness) values (${u}::uuid, ${other}::uuid, 4)`;
    expect(await changedPeople(t.db, u)).toEqual([other]);
  }, 120_000);

  it('rescores everyone once someone’s score is a week old', async () => {
    await clearQueues(t);
    await t.db.sql`update orbit.people set scored_at = now() - interval '8 days' where id = ${ids[3]!}::uuid`;
    await scoreUser();
    await drain(t, handlers, () => NOW);
    expect((await pagedPeople()).sort()).toEqual([...ids].sort());
  }, 120_000);

  it('full (what a reply-tone change sends) rescores everyone', async () => {
    await clearQueues(t);
    await scoreUser({ full: true });
    await drain(t, handlers, () => NOW);
    expect(await pagedPeople()).toHaveLength(ids.length);
  }, 120_000);
});
