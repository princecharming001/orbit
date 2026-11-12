/**
 * The LinkedIn spread and swarm limit (migration 20261206) on PGlite: scheduled LinkedIn work waits a per-account
 * offset plus a little wobble (Google does not), a delayed job is never queued or run twice, and
 * public.orbit_linkedin_target_take lets one account repeat itself but keeps a crowd of accounts off one person.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearQueues, connectedUser } from '../helpers/ingest.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});
beforeEach(async () => {
  await clearQueues(t);
  await t.pg.exec('delete from orbit.users; delete from orbit_private.linkedin_target_reads;');
});

const spread = async (key: string, window: number, wobble: number) =>
  (await t.db.sql<{ d: number }>`select orbit.spread_delay(${key}, ${window}::int, ${wobble}::int) as d`)[0]!
    .d;

/** each queued message with how many seconds it waits before a worker may take it */
const waits = async (queue: string) =>
  t.db.query<{ kind: string; user_id: string; key: string; wait: number }>(
    `select message->>'kind' as kind, message->>'userId' as user_id, message->>'dedupeKey' as key,
            extract(epoch from vt - enqueued_at)::int as wait
       from pgmq.q_${queue} order by msg_id`,
  );

describe('orbit.spread_delay', () => {
  it('gives a key the same offset within the window every time, plus a wobble below its bound', async () => {
    const plain: number[] = [];
    for (let i = 0; i < 5; i++) plain.push(await spread('li-poll:user-a', 3000, 0));
    expect(new Set(plain).size).toBe(1);
    expect(plain[0]).toBeGreaterThanOrEqual(0);
    expect(plain[0]).toBeLessThan(3000);
    const wobbly: number[] = [];
    for (let i = 0; i < 20; i++) wobbly.push(await spread('li-poll:user-a', 3000, 300));
    for (const d of wobbly) {
      expect(d).toBeGreaterThanOrEqual(plain[0]!);
      expect(d).toBeLessThan(plain[0]! + 300);
    }
    // twenty draws of a 300-second wobble are not all the same
    expect(new Set(wobbly).size).toBeGreaterThan(1);
  });

  it('gives two accounts different offsets', async () => {
    const offsets = new Set<number>();
    for (const u of ['a', 'b', 'c', 'd', 'e', 'f']) offsets.add(await spread(`li-poll:${u}`, 3000, 0));
    expect(offsets.size).toBeGreaterThan(1);
    expect(await spread('li-reading:a', 43200, 0)).not.toBe(await spread('li-poll:a', 43200, 0));
  });
});

describe('the schedulers spread LinkedIn and leave Google as it was', () => {
  it('orbit.enqueue_incremental_syncs: LinkedIn waits its offset inside the hour, Gmail and the calendar do not', async () => {
    const u = await connectedUser(t.db, { linkedinAccount: 'acc-spread' });
    await t.db.sql`update orbit.users set last_seen_at = now() where id = ${u}::uuid`;
    await t.db.sql`select orbit.enqueue_incremental_syncs()`;
    const q = await waits('orbit_sync');
    const li = q.filter((r) => r.kind === 'sync.linkedin');
    expect(li).toHaveLength(1);
    const offset = await spread(`li-poll:${u}`, 3000, 0);
    const [row] = await t.db.query<{ left: number }>(
      `select 3599 - floor(extract(epoch from (now() at time zone 'utc')
                - date_trunc('hour', now() at time zone 'utc')))::int as left`,
    );
    const left = row!.left;
    // its offset plus up to five minutes, cut so the job still runs inside this hour
    expect(li[0]!.wait).toBeGreaterThanOrEqual(Math.min(offset, left) - 1);
    expect(li[0]!.wait).toBeLessThanOrEqual(Math.min(offset + 300, left) + 1);
    expect(li[0]!.key).toMatch(new RegExp(`^linkedin-poll:${u}:\\d{4}-\\d{2}-\\d{2}-\\d{2}$`));
    const google = q.filter((r) => r.kind !== 'sync.linkedin');
    expect(google.map((r) => r.kind).sort()).toEqual(['sync.calendar', 'sync.gmail.incremental']);
    for (const g of google) expect(g.wait).toBe(0);
  });

  it('a delayed LinkedIn poll is never queued or run twice', async () => {
    const u = await connectedUser(t.db, { linkedinAccount: 'acc-once' });
    await t.db.sql`update orbit.users set last_seen_at = now() where id = ${u}::uuid`;
    const linkedin = async () => (await waits('orbit_sync')).filter((r) => r.kind === 'sync.linkedin');
    await t.db.sql`select orbit.enqueue_incremental_syncs()`;
    // the next ticks while it waits: its key is in the queue, so nothing new
    await t.db.sql`select orbit.enqueue_incremental_syncs()`;
    await t.db.sql`select orbit.enqueue_incremental_syncs()`;
    const waiting = await linkedin();
    expect(waiting).toHaveLength(1);
    // it ran: the key is held for a day, and the account was synced this hour
    await clearQueues(t);
    await t.db.sql`insert into orbit.job_runs (queue, user_id, kind, status, dedupe_key, finished_at)
      values ('orbit_sync', ${u}::uuid, 'sync.linkedin', 'ok', ${waiting[0]!.key}, now())`;
    await t.db.sql`select orbit.enqueue_incremental_syncs()`;
    expect(await linkedin()).toHaveLength(0);
    // even without the run's record, a sync this hour is enough
    await t.pg.exec('delete from orbit.job_runs;');
    await t.db.sql`update orbit.integration_accounts set last_synced_at = now()
      where user_id = ${u}::uuid and provider = 'linkedin'`;
    await t.db.sql`select orbit.enqueue_incremental_syncs()`;
    expect(await linkedin()).toHaveLength(0);
    // last synced before this hour began: due again
    await t.db.sql`update orbit.integration_accounts
      set last_synced_at = date_trunc('hour', now() at time zone 'utc') at time zone 'utc' - interval '1 minute'
      where user_id = ${u}::uuid and provider = 'linkedin'`;
    await t.db.sql`select orbit.enqueue_incremental_syncs()`;
    expect(await linkedin()).toHaveLength(1);
  });

  it('orbit.enqueue_search_reading and enqueue_search_census pass a spread delay, once per slot', async () => {
    const u = await connectedUser(t.db, { linkedinAccount: 'acc-reading' });
    await t.db.sql`insert into orbit.people (user_id, display_name, name_norm, linkedin_member_id)
      values (${u}::uuid, 'Ada Lovelace', 'ada lovelace', 'ACoAda')`;
    await t.db.sql`select orbit.enqueue_search_reading()`;
    await t.db.sql`select orbit.enqueue_search_census()`;
    await t.db.sql`select orbit.enqueue_search_reading()`;
    await t.db.sql`select orbit.enqueue_search_census()`;
    const q = await waits('orbit_enrich');
    const reading = q.filter((r) => r.kind === 'search_reading');
    const census = q.filter((r) => r.kind === 'search_census');
    expect(reading).toHaveLength(1);
    expect(census).toHaveLength(1);
    const ro = await spread(`li-reading:${u}`, 43200, 0);
    expect(reading[0]!.wait).toBeGreaterThanOrEqual(ro - 1);
    expect(reading[0]!.wait).toBeLessThanOrEqual(ro + 1200 + 1);
    const co = await spread(`li-census:${u}`, 19800, 0);
    expect(census[0]!.wait).toBeGreaterThanOrEqual(co - 1);
    expect(census[0]!.wait).toBeLessThanOrEqual(co + 600 + 1);
    // inside the six hours to the next census run, and the next day's reading
    expect(census[0]!.wait).toBeLessThan(6 * 3600);
    expect(reading[0]!.wait).toBeLessThan(24 * 3600);
  });
});

type Verdict = { allowed: boolean; retryAt: string | null };
const takeTarget = async (target: string, account: string, max?: number, gap?: number) =>
  (
    await t.db.sql<{ v: Verdict }>`
      select public.orbit_linkedin_target_take(${target}, ${account}, ${max ?? 3}::int, ${gap ?? 1200}::int) as v`
  )[0]!.v;
const age = (minutes: number) =>
  t.db.sql`update orbit_private.linkedin_target_reads set at = at - make_interval(mins => ${minutes}::int)`;

describe('public.orbit_linkedin_target_take', () => {
  it('lets one account look the same person up again and again', async () => {
    for (let i = 0; i < 5; i++)
      expect(await takeTarget('ACoTarget', 'acc-1')).toEqual({ allowed: true, retryAt: null });
    // the identifier as callers write it: trimmed and lower case are the same person
    expect((await takeTarget('  acotarget ', 'acc-1')).allowed).toBe(true);
  });

  it('keeps a second and third account a gap behind, then lets them in', async () => {
    expect((await takeTarget('ACoTarget', 'acc-1')).allowed).toBe(true);
    const second = await takeTarget('ACoTarget', 'acc-2');
    expect(second.allowed).toBe(false);
    // the gap after acc-1's look, plus up to ten minutes
    const wait = (Date.parse(second.retryAt!) - Date.now()) / 1000;
    expect(wait).toBeGreaterThan(1200 - 60);
    expect(wait).toBeLessThanOrEqual(1200 + 600 + 5);
    await age(21);
    expect((await takeTarget('ACoTarget', 'acc-2')).allowed).toBe(true);
    expect((await takeTarget('ACoTarget', 'acc-3')).allowed).toBe(false);
    await age(21);
    expect((await takeTarget('ACoTarget', 'acc-3')).allowed).toBe(true);
    // another person is not held back by this one
    expect((await takeTarget('ACoSomeoneElse', 'acc-4')).allowed).toBe(true);
  });

  it('refuses a fourth account inside 24 hours, saying when the first one leaves the window', async () => {
    for (const a of ['acc-1', 'acc-2', 'acc-3']) {
      expect((await takeTarget('ACoBusy', a)).allowed).toBe(true);
      await age(30);
    }
    // acc-1 looked 90 minutes ago, acc-2 60, acc-3 30
    const fourth = await takeTarget('ACoBusy', 'acc-4');
    expect(fourth.allowed).toBe(false);
    const expected = Date.now() + (24 * 60 - 90) * 60_000;
    expect(Math.abs(Date.parse(fourth.retryAt!) - expected)).toBeLessThan(60_000);
    // the three can still look again
    expect((await takeTarget('ACoBusy', 'acc-2')).allowed).toBe(true);
    // a day on, acc-1 has left the window: acc-4 may look
    await t.db.sql`update orbit_private.linkedin_target_reads set at = at - interval '23 hours'`;
    expect((await takeTarget('ACoBusy', 'acc-4')).allowed).toBe(true);
  });

  it('keeps no identifier and clears rows older than two days', async () => {
    await takeTarget('ACoOld', 'acc-1');
    await takeTarget('ACoOld', 'acc-1');
    const rows = await t.db.sql<{ target: string }>`select target from orbit_private.linkedin_target_reads`;
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.target))).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/acoold/i);
    await t.db.sql`update orbit_private.linkedin_target_reads set at = now() - interval '3 days'`;
    await takeTarget('ACoOld', 'acc-2');
    const left = await t.db.sql<{ account: string }>`select account from orbit_private.linkedin_target_reads`;
    expect(left.map((r) => r.account)).toEqual(['acc-2']);
  });

  it('is security definer with its search path set, executable by the service role only', async () => {
    const [f] = await t.db.sql<{ prosecdef: boolean; proconfig: string[]; acl: string }>`
      select p.prosecdef, p.proconfig, p.proacl::text as acl from pg_proc p
       where p.proname = 'orbit_linkedin_target_take'`;
    expect(f!.prosecdef).toBe(true);
    expect(f!.proconfig).toContain('search_path=orbit_private');
    expect(f!.acl).toContain('service_role=X');
    expect(f!.acl).not.toMatch(/(^|[{,])=X/);
    expect(f!.acl).not.toContain('anon=');
    expect(f!.acl).not.toContain('authenticated=');
  });
});
