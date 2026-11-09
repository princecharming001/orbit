/**
 * Plan 35 B3 on PGlite: orbit.user_marks moves on a real insert, update or delete of what the browser pulls, once per
 * transaction, and not on an update that changes nothing (or only updated_at). LinkedIn's and autopilot's marks move
 * only for their own rows. B4: the weekly logo sweep's cron entry and enqueue.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, makeUser, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

type Marks = {
  changed_at: string;
  linkedin_at: string;
  autopilot_at: string;
};
const marks = async (u: string): Promise<Marks | undefined> =>
  (
    await t.db.sql<Marks>`
      select changed_at::text as changed_at, linkedin_at::text as linkedin_at, autopilot_at::text as autopilot_at
        from orbit.user_marks where user_id = ${u}::uuid`
  )[0];

const addPerson = async (u: string, name = 'Ada Lovelace') =>
  (
    await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm)
      values (${u}::uuid, ${name}, ${name.toLowerCase()}) returning id`
  )[0]!.id;

describe('orbit.user_marks', () => {
  it('has RLS on and a trigger pair on every pulled table', async () => {
    const [rls] = await t.db.sql<{ on: boolean }>`
      select relrowsecurity as on from pg_class where oid = 'orbit.user_marks'::regclass`;
    expect(rls!.on).toBe(true);
    const rows = await t.db.sql<{ tbl: string; n: number }>`
      select c.relname as tbl, count(*)::int as n from pg_trigger g join pg_class c on c.oid = g.tgrelid
       where g.tgname in ('user_marks_ins_del', 'user_marks_upd') group by 1`;
    const by = Object.fromEntries(rows.map((r) => [r.tbl, r.n]));
    for (const tbl of [
      'people',
      'ties',
      'tie_scores',
      'drafts',
      'messages',
      'threads',
      'integration_accounts',
      'notifications',
    ])
      expect(by[tbl], tbl).toBe(2);
  });

  it('moves on an insert, a real update and a delete, and not on a no-op update', async () => {
    const u = await makeUser(t.db);
    expect(await marks(u)).toBeUndefined();
    const p = await addPerson(u);
    const first = await marks(u);
    expect(first).toBeDefined();

    // the same values written again (touch_updated_at may still bump updated_at): nothing changed
    await t.db
      .sql`update orbit.people set display_name = display_name, strength = strength where id = ${p}::uuid`;
    expect((await marks(u))!.changed_at).toBe(first!.changed_at);

    await t.db.sql`update orbit.people set display_name = 'Ada King' where id = ${p}::uuid`;
    const second = await marks(u);
    expect(second!.changed_at > first!.changed_at).toBe(true);
    // a person is not LinkedIn's status nor autopilot's
    expect(second!.linkedin_at).toBe(first!.linkedin_at);
    expect(second!.autopilot_at).toBe(first!.autopilot_at);

    await t.db.sql`update orbit.people set deleted_at = now() where id = ${p}::uuid`;
    const third = await marks(u);
    expect(third!.changed_at > second!.changed_at).toBe(true);
    await t.db.sql`delete from orbit.people where id = ${p}::uuid`;
    expect((await marks(u))!.changed_at > third!.changed_at).toBe(true);
  });

  it('writes one mark for a statement over many rows, and leaves other students alone', async () => {
    const u = await makeUser(t.db);
    const other = await makeUser(t.db);
    await addPerson(other, 'Ben Other');
    const otherBefore = await marks(other);
    await t.db.sql`
      insert into orbit.people (user_id, display_name, name_norm)
      select ${u}::uuid, 'P ' || g, 'p ' || g from generate_series(1, 200) g`;
    const m = await marks(u);
    expect(m).toBeDefined();
    // one row per user, and the other student's mark did not move
    const [n] = await t.db.sql<{
      n: number;
    }>`select count(*)::int as n from orbit.user_marks where user_id = ${u}::uuid`;
    expect(n!.n).toBe(1);
    expect(await marks(other)).toEqual(otherBefore);
    // a bulk update in one transaction moves it once, past the last value
    await t.db.sql`update orbit.people set title = 'Engineer' where user_id = ${u}::uuid`;
    expect((await marks(u))!.changed_at > m!.changed_at).toBe(true);
  });

  it('moves the LinkedIn mark for the LinkedIn account and its relations only', async () => {
    const u = await makeUser(t.db);
    await t.db
      .sql`insert into orbit.integration_accounts (user_id, provider, status) values (${u}::uuid, 'google', 'active')`;
    const g = await marks(u);
    await t.db
      .sql`insert into orbit.integration_accounts (user_id, provider, status) values (${u}::uuid, 'linkedin', 'connecting')`;
    const l = await marks(u);
    expect(l!.linkedin_at > g!.linkedin_at).toBe(true);
    await t.db
      .sql`update orbit.integration_accounts set status = 'active' where user_id = ${u}::uuid and provider = 'linkedin'`;
    expect((await marks(u))!.linkedin_at > l!.linkedin_at).toBe(true);
  });

  it('moves the autopilot mark for drafts and the autopilot settings, not for last_seen_at', async () => {
    const u = await makeUser(t.db);
    const p = await addPerson(u);
    const before = await marks(u);
    await t.db.sql`update orbit.users set last_seen_at = now() where id = ${u}::uuid`;
    expect((await marks(u))!.autopilot_at).toBe(before!.autopilot_at);
    await t.db
      .sql`update orbit.users set settings = settings || '{"autopilot_mode":"assist"}'::jsonb where id = ${u}::uuid`;
    const set = await marks(u);
    expect(set!.autopilot_at > before!.autopilot_at).toBe(true);
    expect(set!.changed_at).toBe(before!.changed_at);
    await t.db.sql`
      insert into orbit.drafts (user_id, person_id, kind, channel, body)
      values (${u}::uuid, ${p}::uuid, 'bump', 'gmail', 'Hi')`;
    const d = await marks(u);
    expect(d!.autopilot_at > set!.autopilot_at).toBe(true);
    expect(d!.changed_at > set!.changed_at).toBe(true);
  });

  it('lets an account be deleted (the cascade does not write a mark for a user that is gone)', async () => {
    const u = await makeUser(t.db);
    await addPerson(u);
    await t.db.sql`delete from orbit.users where id = ${u}::uuid`;
    expect(await marks(u)).toBeUndefined();
  });
});

describe('logos.sweep schedule', () => {
  it('runs weekly and queues one job a week', async () => {
    const [job] = await t.db.sql<{ schedule: string; command: string }>`
      select schedule, command from cron.job where jobname = 'orbit-logos-weekly'`;
    expect(job).toMatchObject({ schedule: '17 9 * * 0', command: 'select orbit.enqueue_logos_sweep()' });
    const [a] = await t.db.sql<{ n: number }>`select orbit.enqueue_logos_sweep() as n`;
    const [b] = await t.db.sql<{ n: number }>`select orbit.enqueue_logos_sweep() as n`;
    expect([a!.n, b!.n]).toEqual([1, 0]);
    const rows = await t.db.query<{ kind: string }>(
      `select message->>'kind' as kind from pgmq.q_orbit_enrich where message->>'kind' = 'logos.sweep'`,
    );
    expect(rows).toHaveLength(1);
  });
});
