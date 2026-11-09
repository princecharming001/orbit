/**
 * Plan 34 D1 and D3 on PGlite: the crons enqueue only when there is work (search reading with someone unread,
 * cadence for active students, the nightly scores when something changed, the calendar's full re-list on Sundays),
 * the new schedules, and retention_purge's new sweeps.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearQueues, connectedUser } from '../helpers/ingest.ts';
import { freshDb, makeUser, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});
beforeEach(async () => {
  await clearQueues(t);
  await t.pg.exec('delete from orbit.job_runs; delete from orbit.users;');
});

const queued = async (queue: string, kind: string) =>
  (
    await t.db.query<{ user_id: string; payload: Record<string, unknown> }>(
      `select message->>'userId' as user_id, message->'payload' as payload from pgmq.q_${queue}
        where message->>'kind' = '${kind}'`,
    )
  ).map((r) => r);

const addPerson = async (u: string, member: string | null) =>
  (
    await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm, linkedin_member_id)
      values (${u}::uuid, 'Ada Lovelace', 'ada lovelace', ${member}) returning id`
  )[0]!.id;

describe('orbit.enqueue_search_reading', () => {
  it('queues a reading only for a student with a LinkedIn member left to read', async () => {
    const unread = await connectedUser(t.db, { linkedinAccount: 'acc-unread' });
    await addPerson(unread, 'ACoAda');
    const allRead = await connectedUser(t.db, { linkedinAccount: 'acc-read' });
    const p = await addPerson(allRead, 'ACoBen');
    await t.db
      .sql`insert into orbit.profile_reads (user_id, person_id, member_id) values (${allRead}::uuid, ${p}::uuid, 'ACoBen')`;
    const noMembers = await connectedUser(t.db, { linkedinAccount: 'acc-none' });
    await addPerson(noMembers, null);
    await t.db.sql`select orbit.enqueue_search_reading()`;
    expect((await queued('orbit_enrich', 'search_reading')).map((r) => r.user_id)).toEqual([unread]);
  });

  it('reads a profile again once its last read is over 180 days old', async () => {
    const u = await connectedUser(t.db, { linkedinAccount: 'acc-old' });
    const p = await addPerson(u, 'ACoCal');
    await t.db.sql`insert into orbit.profile_reads (user_id, person_id, member_id, read_at)
      values (${u}::uuid, ${p}::uuid, 'ACoCal', now() - interval '200 days')`;
    await t.db.sql`select orbit.enqueue_search_reading()`;
    expect(await queued('orbit_enrich', 'search_reading')).toHaveLength(1);
  });
});

describe('orbit.enqueue_cadence', () => {
  it('queues only students seen in 14 days or with something open', async () => {
    const seen = await makeUser(t.db);
    await t.db.sql`update orbit.users set last_seen_at = now() - interval '2 days' where id = ${seen}::uuid`;
    const away = await makeUser(t.db);
    await t.db.sql`update orbit.users set last_seen_at = now() - interval '30 days' where id = ${away}::uuid`;
    const withGoal = await makeUser(t.db);
    await t.db
      .sql`insert into orbit.goals (user_id, kind, title) values (${withGoal}::uuid, 'recruiting', 'Find a PM role')`;
    const withSession = await makeUser(t.db);
    await t.db.sql`insert into orbit.sessions (user_id, refresh_hash, last_used_at, expires_at)
      values (${withSession}::uuid, ${`h-${Math.random()}`}, now() - interval '1 day', now() + interval '30 days')`;
    await t.db.sql`select orbit.enqueue_cadence()`;
    const ids = (await queued('orbit_cadence', 'cadence.user')).map((r) => r.user_id).sort();
    expect(ids).toEqual([seen, withGoal, withSession].sort());
    expect(ids).not.toContain(away);
  });
});

describe('orbit.enqueue_nightly', () => {
  const sunday = new Date().getUTCDay() === 0;

  it('re-lists the calendar two years back on Sundays only, and scores a student with no scores yet', async () => {
    const u = await connectedUser(t.db);
    await t.db.sql`select orbit.enqueue_nightly()`;
    const cal = await queued('orbit_sync', 'sync.calendar');
    expect(cal).toHaveLength(1);
    expect(cal[0]!.payload).toEqual(sunday ? { resync: true } : {});
    expect((await queued('orbit_score', 'score.user')).map((r) => r.user_id)).toEqual([u]);
  });

  it('skips score.user when nothing arrived since the last scores, and runs it when something did', async () => {
    const u = await connectedUser(t.db);
    const p = await addPerson(u, null);
    await t.db.sql`update orbit.people set created_at = now() - interval '3 days' where id = ${p}::uuid`;
    await t.db
      .sql`insert into orbit.tie_scores (user_id, person_id, score, band, features, contributions, model_version, computed_at)
      values (${u}::uuid, ${p}::uuid, 20, 'weak', '{}'::jsonb, '{}'::jsonb, 'test', now() - interval '1 day')`;
    await t.db.sql`select orbit.enqueue_nightly()`;
    expect(await queued('orbit_score', 'score.user')).toHaveLength(0);

    await clearQueues(t);
    await addPerson(u, 'ACoNew');
    await t.db.sql`select orbit.enqueue_nightly()`;
    expect(await queued('orbit_score', 'score.user')).toHaveLength(1);
  });

  it('rebuilds scores a week old even with nothing new, so recency decay still moves them', async () => {
    const u = await connectedUser(t.db);
    const p = await addPerson(u, null);
    await t.db.sql`update orbit.people set created_at = now() - interval '30 days' where id = ${p}::uuid`;
    await t.db
      .sql`insert into orbit.tie_scores (user_id, person_id, score, band, features, contributions, model_version, computed_at)
      values (${u}::uuid, ${p}::uuid, 20, 'weak', '{}'::jsonb, '{}'::jsonb, 'test', now() - interval '8 days')`;
    await t.db.sql`select orbit.enqueue_nightly()`;
    expect(await queued('orbit_score', 'score.user')).toHaveLength(1);
  });
});

describe('schedules', () => {
  it('reading and census every 6 hours, health hourly, the cost digest each morning', async () => {
    const jobs = await t.db.sql<{ jobname: string; schedule: string }>`
      select jobname, schedule from cron.job
       where jobname in ('orbit-search-reading', 'orbit-search-census', 'orbit-health', 'orbit-cost-digest')
       order by jobname`;
    expect(jobs).toEqual([
      { jobname: 'orbit-cost-digest', schedule: '50 7 * * *' },
      { jobname: 'orbit-health', schedule: '3 * * * *' },
      { jobname: 'orbit-search-census', schedule: '11 */6 * * *' },
      { jobname: 'orbit-search-reading', schedule: '41 */6 * * *' },
    ]);
  });

  it('enqueue_cost_digest queues one digest a day', async () => {
    await t.db.sql`select orbit.enqueue_cost_digest()`;
    await t.db.sql`select orbit.enqueue_cost_digest()`;
    const rows = await queued('orbit_enrich', 'cost.digest');
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('orbit.retention_purge (plan 34 D3)', () => {
  it('drops old proxy day rows, old ledger rows, old health snapshots and old token rows, and keeps the rest', async () => {
    const u = await makeUser(t.db);
    await t.pg.exec(`
      delete from public.orbit_proxy_spend; delete from orbit.usage_ledger; delete from orbit.audit_log;
      delete from orbit_private.claude_usage;
      insert into public.orbit_proxy_spend (subject, usd, updated_at) values
        ('client:abc:2026-01-01', 1, now() - interval '120 days'),
        ('client:abc:2026-11-01', 1, now() - interval '5 days'),
        ('client:abc', 9, now() - interval '120 days');
      insert into orbit.audit_log (actor, action, details, created_at) values
        ('system', 'health.snapshot', '{}', now() - interval '40 days'),
        ('system', 'health.snapshot', '{}', now() - interval '2 days'),
        ('system', 'cost.digest', '{}', now() - interval '40 days');
      insert into orbit_private.claude_usage (subject, at) values ('client:abc', now() - interval '100 days'),
        ('client:abc', now() - interval '1 day');
    `);
    await t.db
      .sql`insert into orbit.usage_ledger (user_id, provider, operation, units, cost_usd, created_at) values
      (${u}::uuid, 'hunter', 'find', 1, 0, now() - interval '14 months'),
      (${u}::uuid, 'hunter', 'find', 1, 0, now() - interval '1 month')`;
    const [r] = await t.db.sql<{ out: Record<string, number> }>`select orbit.retention_purge() as out`;
    expect(r!.out).toMatchObject({
      proxy_spend_days: 1,
      usage_ledger: 1,
      health_snapshots: 1,
      claude_usage: 1,
    });
    const spend = await t.db.sql<{
      subject: string;
    }>`select subject from public.orbit_proxy_spend order by subject`;
    expect(spend.map((s) => s.subject)).toEqual(['client:abc', 'client:abc:2026-11-01']);
    const audit = await t.db.sql<{ action: string }>`select action from orbit.audit_log order by action`;
    expect(audit.map((a) => a.action)).toEqual(['cost.digest', 'health.snapshot']);
  });
});
