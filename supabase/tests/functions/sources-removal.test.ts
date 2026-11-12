/**
 * Plan 43 §3.2, the removal test. For each of the 8 on and off combinations of Instagram, X and texts, on a student
 * with LinkedIn and Gmail and on a student with neither: a student who had every source on, scored, then switched the
 * others off (PUT /sources's switchSource and the switch job), is compared at every entry point (closeness, paths to a
 * person and to a company, what the browser pulls, the friend projection, a draft's context) with a freshly seeded
 * student who never had the off sources' rows, scored by the same job with the clock fixed. They must match.
 *
 * The one stated exception, asserted on its own: people Orbit merged because of a source's evidence stay merged.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scorePeople } from '../../functions/_shared/ingest/score.ts';
import { sqlQueue } from '../../functions/_shared/queue.ts';
import { sourcesFor } from '../../functions/_shared/sources/states.ts';
import { switchSource } from '../../functions/_shared/sources/switch.ts';
import { PULL_TABLES } from '../../functions/orbit-api/tables.ts';
import { defaultHandlers } from '../../functions/orbit-worker/worker.ts';
import { clearQueues, drain } from '../helpers/ingest.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';
import { NOW, type Optional, seedStudent, snapshot } from '../helpers/sourcesFixture.ts';

const ALL: Optional[] = ['instagram', 'x', 'imessage'];
const handlers = defaultHandlers({ offered: ALL });
// the switch states themselves are what differs between the two students, by design
const TABLES = PULL_TABLES.map((t) => t.table).filter((t) => t !== 'source_states');

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

const switchJob = async (userId: string, source: Optional = 'instagram') => {
  await sqlQueue(t.db).enqueue({
    kind: 'sources.switch',
    userId,
    payload: { source, state: 'on' },
    dedupeKey: `test:${userId}:${Math.random()}`,
  });
  await drain(t, handlers, () => NOW);
};

const combos: Optional[][] = [];
for (let m = 0; m < 8; m++) combos.push(ALL.filter((_, i) => m & (1 << i)));

describe('the removal test (plan 43 §3.2)', () => {
  for (const base of [true, false])
    for (const on of combos) {
      const off = ALL.filter((s) => !on.includes(s));
      it(`${base ? 'LinkedIn and Gmail' : 'neither'}; on: ${on.join(', ') || 'none'}`, async () => {
        // a student who had everything on and scored, then switched the others off
        const a = await seedStudent(t, {
          base,
          rows: ALL,
          states: { instagram: 'on', x: 'on', imessage: 'on' },
        });
        await switchJob(a.userId);
        for (const s of off) await switchSource(t.db, sqlQueue(t.db), a.userId, s, { state: 'off' }, NOW);
        await drain(t, handlers, () => NOW);
        // a student who never had the off sources' rows, scored by the same job
        const b = await seedStudent(t, {
          base,
          rows: on,
          states: Object.fromEntries(on.map((s) => [s, 'on'])),
        });
        await switchJob(b.userId);
        const got = await snapshot(t, a, { offered: ALL, tables: TABLES });
        const want = await snapshot(t, b, { offered: ALL, tables: TABLES });
        expect(JSON.parse(JSON.stringify(got))).toEqual(JSON.parse(JSON.stringify(want)));
      });
    }

  it('switching a source back on brings everything back as it was', async () => {
    const a = await seedStudent(t, {
      base: true,
      rows: ALL,
      states: { instagram: 'on', x: 'on', imessage: 'on' },
    });
    await switchJob(a.userId);
    const before = await snapshot(t, a, { offered: ALL, tables: TABLES });
    for (const s of ALL) await switchSource(t.db, sqlQueue(t.db), a.userId, s, { state: 'off' }, NOW);
    await drain(t, handlers, () => NOW);
    const offSnap = await snapshot(t, a, { offered: ALL, tables: TABLES });
    expect(offSnap).not.toEqual(before);
    for (const s of ALL) await switchSource(t.db, sqlQueue(t.db), a.userId, s, { state: 'on' }, NOW);
    await drain(t, handlers, () => NOW);
    expect(await snapshot(t, a, { offered: ALL, tables: TABLES })).toEqual(before);
  });

  it('a source the owner does not offer counts for nothing, whatever the student said', async () => {
    const a = await seedStudent(t, {
      base: true,
      rows: ALL,
      states: { instagram: 'on', x: 'on', imessage: 'on' },
    });
    await switchJob(a.userId);
    // the owner takes every optional source away: the student's rows are as good as off
    const quiet = defaultHandlers({ offered: [] });
    await sqlQueue(t.db).enqueue({
      kind: 'sources.switch',
      userId: a.userId,
      payload: {},
      dedupeKey: 'owner-off',
    });
    await drain(t, quiet, () => NOW);
    const b = await seedStudent(t, { base: true, rows: [] });
    await sqlQueue(t.db).enqueue({
      kind: 'sources.switch',
      userId: b.userId,
      payload: {},
      dedupeKey: 'owner-off-b',
    });
    await drain(t, quiet, () => NOW);
    expect(await snapshot(t, a, { tables: TABLES })).toEqual(await snapshot(t, b, { tables: TABLES }));
  });

  it('the stated exception: people merged on a source’s evidence stay merged when it goes off', async () => {
    const a = await seedStudent(t, {
      base: true,
      rows: ALL,
      states: { instagram: 'on', x: 'on', imessage: 'on' },
    });
    const [dup] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm, sources, source_account, merged_into)
      values (${a.userId}::uuid, 'Ben O', 'ben o', array['instagram'], 'instagram:ig_ben', ${a.people.ben!}::uuid)
      returning id`;
    await switchSource(t.db, sqlQueue(t.db), a.userId, 'instagram', { state: 'off' }, NOW);
    await drain(t, handlers, () => NOW);
    const [row] = await t.db.sql<{ merged_into: string | null }>`
      select merged_into from orbit.people where id = ${dup!.id}::uuid`;
    expect(row?.merged_into).toBe(a.people.ben);
    // and Ben, the survivor, is still there, scored without his Instagram messages
    const src = await sourcesFor(t.db, a.userId, ALL);
    expect(src.inUse.has('instagram')).toBe(false);
    await scorePeople(t.db, a.userId, { now: NOW, personIds: [a.people.ben!], sources: src });
    const [ben] = await t.db.sql<{ deleted_at: Date | null; merged_into: string | null }>`
      select deleted_at, merged_into from orbit.people where id = ${a.people.ben!}::uuid`;
    expect(ben).toEqual({ deleted_at: null, merged_into: null });
  });
});
