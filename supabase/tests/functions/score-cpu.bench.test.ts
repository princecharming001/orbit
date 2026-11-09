/**
 * Plan 35 B1: CPU of the nightly scoring on a network the owner's size (helpers/bigNetwork.ts). Off by default (it
 * takes a minute); run with ORBIT_CPU_BENCH=1. JavaScript time is measured outside the database calls, so it is what
 * an edge isolate spends of its 2 s allowance, less the driver's row decoding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../functions/_shared/db.ts';
import { changedPeople, scorePeople } from '../../functions/_shared/ingest/score.ts';
import { refreshTies, TIE_GROUPS } from '../../functions/_shared/ingest/ties.ts';
import { loadGraph, loadNeighbourhood } from '../../functions/_shared/paths/find.ts';
import { seedBigNetwork } from '../helpers/bigNetwork.ts';
import { connectedUser } from '../helpers/ingest.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

const ON = !!process.env.ORBIT_CPU_BENCH;

/** A Db that counts the time spent waiting on it. */
function timed(db: Db): { db: Db; inDb: () => number; reset: () => void } {
  let spent = 0;
  const wrap = <T>(p: Promise<T>) => {
    const t0 = performance.now();
    return p.finally(() => {
      spent += performance.now() - t0;
    });
  };
  const out: Db = {
    sql: (s, ...v) => wrap(db.sql(s, ...v)),
    query: (q, p) => wrap(db.query(q, p)),
    begin: (fn) => db.begin(fn),
  };
  return {
    db: out,
    inDb: () => spent,
    reset: () => {
      spent = 0;
    },
  };
}

async function measure(label: string, w: ReturnType<typeof timed>, fn: () => Promise<unknown>) {
  w.reset();
  const t0 = performance.now();
  const r = await fn();
  const total = performance.now() - t0;
  const js = total - w.inDb();
  console.log(`[cpu] ${label}: total ${total.toFixed(0)} ms, js ${js.toFixed(0)} ms`, r ?? '');
  return { total, js };
}

describe.skipIf(!ON)('nightly scoring CPU on an owner-sized network', () => {
  let t: TestDb;
  let u: string;
  let ids: string[];
  beforeAll(async () => {
    t = await freshDb();
    u = await connectedUser(t.db);
    ids = (await seedBigNetwork(t.db, u)).personIds;
  }, 300_000);
  afterAll(async () => {
    await t?.pg.close();
  });

  it('measures', async () => {
    const w = timed(t.db);
    const now = new Date();
    const whole = await measure('whole-network refreshTies, first write', w, () => refreshTies(w.db, u, now));
    const kinds = await t.db.sql`
      select kind, count(*)::int n from orbit.ties where user_id = ${u}::uuid group by kind order by kind`;
    console.log('[cpu] ties by kind', kinds);
    await measure('whole-network refreshTies, nothing changed', w, () => refreshTies(w.db, u, now));
    let groups = 0;
    for (const g of TIE_GROUPS) {
      const r = await measure(`score.ties ${g.name}`, w, () => refreshTies(w.db, u, now, { kinds: g.kinds }));
      groups = Math.max(groups, r.js);
    }
    await measure('score.person refresh (100 people, interactions)', w, () =>
      refreshTies(w.db, u, now, { personIds: ids.slice(0, 100) }),
    );
    const page = await measure('score.page: scorePeople 100', w, () =>
      scorePeople(w.db, u, { now, personIds: ids.slice(0, 100) }),
    );
    await measure('changedPeople', w, () => changedPeople(w.db, u));
    console.log(
      `[cpu] largest tie group ${groups.toFixed(0)} ms js vs the whole inference ${whole.js.toFixed(0)} ms; a page ${page.js.toFixed(0)} ms`,
    );
    expect(groups).toBeLessThan(whole.js);
  }, 600_000);

  it('measures a Map search’s graph load (plan 35 B7)', async () => {
    const now = new Date();
    const [n] = await t.db.sql<{
      n: number;
    }>`select count(*)::int as n from orbit.ties where user_id = ${u}::uuid`;
    if (!n!.n) await refreshTies(t.db, u, now);
    const evidenceBytes = (ties: Iterable<{ evidence: unknown }>) => {
      let n = 0;
      for (const x of ties) n += JSON.stringify(x.evidence).length;
      return n;
    };
    const t0 = performance.now();
    const whole = await loadGraph(t.db, u, now);
    const wholeMs = performance.now() - t0;
    const wholeTies = [...whole.pairs.values()].flatMap((p) => p.ties);
    console.log(
      `[b7] whole graph: ${whole.people.size} people, ${wholeTies.length} ties, evidence ${evidenceBytes(wholeTies)} B, ${wholeMs.toFixed(0)} ms`,
    );
    const targets = await t.db.sql<{ id: string }>`
      select id from orbit.people where user_id = ${u}::uuid and not is_self order by md5(id::text) limit 20`;
    const busiest = await t.db.sql<{ id: string }>`
      select id from (select a_person_id as id from orbit.ties where user_id = ${u}::uuid
                      union all select b_person_id from orbit.ties where user_id = ${u}::uuid) x
       group by id order by count(*) desc limit 5`;
    const sizes: number[] = [];
    for (const x of [...busiest, ...targets]) {
      const t1 = performance.now();
      const g = await loadNeighbourhood(t.db, u, x.id, now);
      const ms = performance.now() - t1;
      sizes.push(g.people.size);
      console.log(
        `[b7] ${x.id.slice(0, 8)}: ${g.people.size} people, ${g.ties.size} ties, evidence ${evidenceBytes(g.ties.values())} B, ${ms.toFixed(0)} ms`,
      );
    }
    expect(Math.min(...sizes)).toBeLessThan(whole.people.size);
  }, 600_000);
});
