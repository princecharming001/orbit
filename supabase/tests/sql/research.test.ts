/**
 * supabase/migrations/20261023_orbit_research.sql: the deep-research tables are service role only with RLS on, and
 * the allowance counts different people per LinkedIn account per month, atomically, with a person given back when
 * no brief was written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, migrationSql, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const use = async (account: string, person: string, limit = 3, month = '2026-10') =>
  (
    await t.db.sql<{ allowed: boolean; used: number; counted: boolean }>`
      select * from public.orbit_research_use(${account}, ${month}, ${person}, ${limit})`
  )[0]!;

describe('the research migration', () => {
  it('creates four service-role-only tables with RLS on', async () => {
    const rows = await t.db.sql<{ relname: string; rls: boolean }>`
      select c.relname, c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname like 'orbit_research_%' and c.relkind = 'r' order by 1`;
    expect(rows.map((r) => r.relname)).toEqual([
      'orbit_research_cache',
      'orbit_research_runs',
      'orbit_research_suppressions',
      'orbit_research_uses',
    ]);
    expect(rows.every((r) => r.rls)).toBe(true);
    for (const role of ['anon', 'authenticated']) {
      const [g] = await t.db.sql<{ n: number }>`
        select count(*)::int as n from information_schema.role_table_grants
         where grantee = ${role} and table_name like 'orbit_research_%'`;
      expect(g!.n, role).toBe(0);
      const [f] = await t.db.sql<{ n: number }>`
        select count(*)::int as n from information_schema.role_routine_grants
         where grantee = ${role} and routine_name like 'orbit_research_%'`;
      expect(f!.n, role).toBe(0);
    }
  });

  it('counts different people per account per month, the same person once, and stops at the limit', async () => {
    expect(await use('a1', 'p1')).toEqual({ allowed: true, used: 1, counted: true });
    expect(await use('a1', 'p1')).toEqual({ allowed: true, used: 1, counted: false });
    expect(await use('a1', 'p2')).toMatchObject({ allowed: true, used: 2 });
    expect(await use('a1', 'p3')).toMatchObject({ allowed: true, used: 3 });
    expect(await use('a1', 'p4')).toEqual({ allowed: false, used: 3, counted: false });
    // someone already counted this month can still be researched again
    expect(await use('a1', 'p2')).toMatchObject({ allowed: true, counted: false });
    // another account, and next month, start fresh
    expect(await use('a2', 'p4')).toMatchObject({ allowed: true, used: 1 });
    expect(await use('a1', 'p4', 3, '2026-11')).toMatchObject({ allowed: true, used: 1 });
  });

  it('gives a person back, reports the month and the day’s spend, and finds the last quick brief', async () => {
    const [left] = await t.db.sql<{
      n: number;
    }>`select public.orbit_research_refund('a1', '2026-10', 'p3') as n`;
    expect(left!.n).toBe(2);
    await t.db.sql`
      insert into public.orbit_research_runs (account, person_key, kind, status, cost_usd)
      values ('a1', 'p1', 'quick', 'ready', 0.21), ('a1', 'p1', 'deeper', 'ready', 0.18), ('a1', 'p2', 'quick', 'needs_anchor', 0)`;
    const [st] = await t.db.sql<{ used: number; spent_today: string }>`
      select * from public.orbit_research_status('a1', '2026-10')`;
    expect(st!.used).toBe(2);
    expect(Number(st!.spent_today)).toBeCloseTo(0.39, 5);
    const [q] = await t.db.sql<{
      v: string | null;
    }>`select public.orbit_research_last_quick('a1', 'p1') as v`;
    expect(Number(q!.v)).toBeCloseTo(0.21, 5);
    const [none] = await t.db.sql<{
      v: string | null;
    }>`select public.orbit_research_last_quick('a1', 'p2') as v`;
    expect(none!.v).toBeNull();
  });

  it('cleans up the expired cache and is re-runnable', async () => {
    await t.db.sql`
      insert into public.orbit_research_cache (key, kind, value, expires_at)
      values ('old', 'page', '{}'::jsonb, now() - interval '1 day'), ('new', 'page', '{}'::jsonb, now() + interval '7 days')`;
    await t.db.sql`select public.orbit_research_cleanup()`;
    const keys = await t.db.sql<{ key: string }>`select key from public.orbit_research_cache order by key`;
    expect(keys.map((k) => k.key)).toEqual(['new']);
    await t.pg.exec(migrationSql('20261023_orbit_research.sql'));
  });
});
