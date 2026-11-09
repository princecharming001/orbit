/**
 * Plan 34 D1 and D3 on PGlite: the crons enqueue only when there is work (search reading with someone unread,
 * cadence for active students, the nightly scores when something changed, the calendar's full re-list on Sundays),
 * the new schedules, and retention_purge's new sweeps. Plan 35 B5 and B6: the crons follow the student (Google polls
 * for students seen lately or with something going out, Gmail only without a watch, the calendar by slot, LinkedIn
 * hourly, cadence only when something is due, friends only when something changed, reading only what was asked for,
 * the census weekly after its first pass).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pickPeople, requestReads } from '../../functions/_shared/search/reading.ts';
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

  it('reads a profile again once its last read is over 180 days old, when someone asked for it', async () => {
    const u = await connectedUser(t.db, { linkedinAccount: 'acc-old' });
    const p = await addPerson(u, 'ACoCal');
    await t.db.sql`insert into orbit.profile_reads (user_id, person_id, member_id, read_at)
      values (${u}::uuid, ${p}::uuid, 'ACoCal', now() - interval '200 days')`;
    await t.db.sql`select orbit.enqueue_search_reading()`;
    expect(await queued('orbit_enrich', 'search_reading')).toHaveLength(0);
    await requestReads(t.db, u, [p]);
    await t.db.sql`select orbit.enqueue_search_reading()`;
    expect(await queued('orbit_enrich', 'search_reading')).toHaveLength(1);
  });

  it('takes only profiles asked for in the last 7 days, plus the 50 closest never read (plan 35 B6)', async () => {
    const u = await connectedUser(t.db, { linkedinAccount: 'acc-asked' });
    const ids: string[] = [];
    for (let i = 0; i < 53; i++) ids.push(await addPerson(u, `ACoP${i}`));
    // strength 1..53: the 50 closest are ids[3..52]; mark them read, so only an ask brings anyone back
    for (let i = 0; i < ids.length; i++)
      await t.db.sql`update orbit.people set strength = ${(i + 1) / 100}::real where id = ${ids[i]!}::uuid`;
    await t.db.sql`insert into orbit.profile_reads (user_id, person_id, member_id)
      select ${u}::uuid, id, linkedin_member_id from orbit.people where id = any(${ids.slice(3)}::uuid[])`;
    const pick = async () => (await pickPeople(t.db, u, 100)).map((c) => c.id).sort();
    // ids[0..2] are unread but outside the 50 closest, and nobody asked for them
    expect(await pick()).toEqual([]);
    await t.db.sql`select orbit.enqueue_search_reading()`;
    expect(await queued('orbit_enrich', 'search_reading')).toHaveLength(0);

    await requestReads(t.db, u, [ids[0]!, ids[1]!, ids[10]!]);
    await t.db.sql`update orbit.profile_requests set requested_at = now() - interval '8 days'
      where person_id = ${ids[1]!}::uuid`;
    // ids[10] was read lately: an ask does not read it again inside 180 days
    expect(await pick()).toEqual([ids[0]!]);
    await t.db.sql`select orbit.enqueue_search_reading()`;
    await t.db.sql`select orbit.enqueue_search_reading()`;
    const q = await queued('orbit_enrich', 'search_reading');
    expect(q.map((r) => r.user_id)).toEqual([u]);
  });

  it('requestReads marks only the student’s own people, once each', async () => {
    const u = await connectedUser(t.db, { linkedinAccount: 'acc-hooks' });
    const p = await addPerson(u, 'ACoHook');
    const someoneElse = await addPerson(await makeUser(t.db), 'ACoOther');
    await requestReads(t.db, u, [p, p, someoneElse]);
    const rows = await t.db.sql<{ person_id: string }>`
      select person_id from orbit.profile_requests where user_id = ${u}::uuid`;
    expect(rows.map((r) => r.person_id)).toEqual([p]);
  });
});

describe('orbit.enqueue_cadence', () => {
  it('queues students seen in 14 days, and an away student only when something is due within the hour', async () => {
    const away = async () => {
      const u = await makeUser(t.db);
      await t.db.sql`update orbit.users set last_seen_at = now() - interval '30 days' where id = ${u}::uuid`;
      return u;
    };
    const seen = await makeUser(t.db);
    await t.db.sql`update orbit.users set last_seen_at = now() - interval '2 days' where id = ${seen}::uuid`;
    const idle = await away();
    const withSession = await makeUser(t.db);
    await t.db.sql`insert into orbit.sessions (user_id, refresh_hash, last_used_at, expires_at)
      values (${withSession}::uuid, ${`h-${Math.random()}`}, now() - interval '1 day', now() + interval '30 days')`;
    // a goal alone, an open chat with no timer due and a draft not approved no longer keep a student scanned
    const goalOnly = await away();
    await t.db
      .sql`insert into orbit.goals (user_id, kind, title) values (${goalOnly}::uuid, 'recruiting', 'Find a PM role')`;
    const chatOnly = await away();
    const cp = await addPerson(chatOnly, null);
    await t.db.sql`insert into orbit.chats (user_id, person_id, stage, stage_entered_at)
      values (${chatOnly}::uuid, ${cp}::uuid, 'followed_up', now() - interval '3 days')`;
    const draftOnly = await away();
    const dp = await addPerson(draftOnly, null);
    await t.db.sql`insert into orbit.drafts (user_id, person_id, channel, kind, body, status)
      values (${draftOnly}::uuid, ${dp}::uuid, 'gmail', 'outreach', 'hi', 'draft')`;
    // due within the hour: an approved draft, a stage timer, a goal on autopilot
    const sendDue = await away();
    const sp = await addPerson(sendDue, null);
    await t.db.sql`insert into orbit.drafts (user_id, person_id, channel, kind, body, status, send_at)
      values (${sendDue}::uuid, ${sp}::uuid, 'gmail', 'outreach', 'hi', 'scheduled', now() + interval '20 minutes')`;
    const later = await away();
    const lp = await addPerson(later, null);
    await t.db.sql`insert into orbit.drafts (user_id, person_id, channel, kind, body, status, send_at)
      values (${later}::uuid, ${lp}::uuid, 'gmail', 'outreach', 'hi', 'scheduled', now() + interval '3 hours')`;
    const timerDue = await away();
    const tp = await addPerson(timerDue, null);
    await t.db.sql`insert into orbit.chats (user_id, person_id, stage, stage_entered_at)
      values (${timerDue}::uuid, ${tp}::uuid, 'completed', now() - interval '14 days')`;
    const autopilot = await away();
    await t.db.sql`insert into orbit.goals (user_id, kind, title, autonomy_level)
      values (${autopilot}::uuid, 'recruiting', 'Find a PM role', 2)`;
    await t.db.sql`select orbit.enqueue_cadence()`;
    const ids = (await queued('orbit_cadence', 'cadence.user')).map((r) => r.user_id).sort();
    expect(ids).toEqual([seen, withSession, sendDue, timerDue, autopilot].sort());
    for (const u of [idle, goalOnly, chatOnly, draftOnly, later]) expect(ids).not.toContain(u);
  });
});

describe('orbit.enqueue_incremental_syncs (plan 35 B5)', () => {
  const polls = async () =>
    (
      await t.db.query<{ kind: string; user_id: string; key: string }>(
        `select message->>'kind' as kind, message->>'userId' as user_id, message->>'dedupeKey' as key
           from pgmq.q_orbit_sync`,
      )
    ).map((r) => r);

  it('polls Google only for students seen in 14 days or with something going out, Gmail only without a watch', async () => {
    const seen = await connectedUser(t.db);
    await t.db.sql`update orbit.users set last_seen_at = now() - interval '3 days' where id = ${seen}::uuid`;
    const away = await connectedUser(t.db);
    await t.db.sql`update orbit.users set last_seen_at = now() - interval '30 days' where id = ${away}::uuid`;
    const awaySending = await connectedUser(t.db);
    const ap = await addPerson(awaySending, null);
    await t.db.sql`insert into orbit.drafts (user_id, person_id, channel, kind, body, status)
      values (${awaySending}::uuid, ${ap}::uuid, 'gmail', 'outreach', 'hi', 'approved')`;
    const awaitingReply = await connectedUser(t.db);
    await t.db
      .sql`insert into orbit.threads (user_id, provider, external_id, last_at, last_direction, is_networking)
      values (${awaitingReply}::uuid, 'gmail', 'out-1', now() - interval '2 days', 'out', true)`;
    const watched = await connectedUser(t.db);
    await t.db.sql`update orbit.users set last_seen_at = now() where id = ${watched}::uuid`;
    await t.db.sql`update orbit.integration_accounts set watch_expires_at = now() + interval '3 days'
      where user_id = ${watched}::uuid and provider = 'google'`;
    await t.db.sql`select orbit.enqueue_incremental_syncs()`;
    const q = await polls();
    const gmail = q
      .filter((r) => r.kind === 'sync.gmail.incremental')
      .map((r) => r.user_id)
      .sort();
    const cal = q
      .filter((r) => r.kind === 'sync.calendar')
      .map((r) => r.user_id)
      .sort();
    expect(gmail).toEqual([seen, awaySending, awaitingReply].sort());
    expect(cal).toEqual([seen, awaySending, awaitingReply, watched].sort());
    expect(q.map((r) => r.user_id)).not.toContain(away);
  });

  it('the calendar once a half hour for a student seen today and once an hour for the rest', async () => {
    const today = await connectedUser(t.db);
    await t.db
      .sql`update orbit.users set last_seen_at = now() - interval '2 hours' where id = ${today}::uuid`;
    const week = await connectedUser(t.db);
    await t.db.sql`update orbit.users set last_seen_at = now() - interval '5 days' where id = ${week}::uuid`;
    await t.db.sql`select orbit.enqueue_incremental_syncs()`;
    const key = (u: string) =>
      polls().then((q) => q.find((r) => r.kind === 'sync.calendar' && r.user_id === u)?.key);
    expect(await key(today)).toMatch(
      new RegExp(`^calendar-poll:${today}:\\d{4}-\\d{2}-\\d{2}-\\d{2}-(00|30)$`),
    );
    expect(await key(week)).toMatch(new RegExp(`^calendar-poll:${week}:\\d{4}-\\d{2}-\\d{2}-\\d{2}$`));
    // a slot that ran is not queued again inside it, however often the 10-minute cron fires
    const done = (await polls()).find((r) => r.kind === 'sync.calendar' && r.user_id === week)!.key;
    await clearQueues(t);
    await t.db.sql`insert into orbit.job_runs (queue, user_id, kind, status, dedupe_key, finished_at)
      values ('orbit_sync', ${week}::uuid, 'sync.calendar', 'ok', ${done}, now())`;
    await t.db.sql`select orbit.enqueue_incremental_syncs()`;
    expect((await polls()).filter((r) => r.kind === 'sync.calendar').map((r) => r.user_id)).toEqual([today]);
  });
});

describe('orbit.enqueue_friend_refresh (plan 35 B5)', () => {
  it('expires asks every night but rebuilds a projection only when something it is made from changed', async () => {
    const a = await makeUser(t.db);
    const b = await makeUser(t.db);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    await t.db.sql`insert into orbit.friendships (a, b, status, requested_by)
      values (${lo}::uuid, ${hi}::uuid, 'active', ${lo}::uuid)`;
    const p = await addPerson(a, 'ACoShared');
    await t.db.sql`update orbit.people set updated_at = now() - interval '2 days' where id = ${p}::uuid`;
    const refreshes = async () => {
      await clearQueues(t);
      await t.db.sql`select orbit.enqueue_friend_refresh()`;
      return (await queued('orbit_score', 'friend_shares_refresh')).map((r) => r.user_id).sort();
    };
    // nothing built yet: both are rebuilt
    expect(await refreshes()).toEqual([a, b].sort());
    await t.db
      .sql`insert into orbit.friend_shares (owner_user_id, person_id, display_name, linkedin_member_id, closeness)
      values (${a}::uuid, ${p}::uuid, 'Ada Lovelace', 'ACoShared', 2)`;
    // a's projection is newer than everything it is made from; b has none
    expect(await refreshes()).toEqual([b]);
    await t.db.sql`update orbit.people set title = 'Founder' where id = ${p}::uuid`;
    expect(await refreshes()).toEqual([a, b].sort());
  });
});

describe('orbit.enqueue_search_census (plan 35 B6)', () => {
  it('steps every run until the first pass ends, then only in the week’s first slot', async () => {
    const first = await connectedUser(t.db, { linkedinAccount: 'acc-first' });
    const done = await connectedUser(t.db, { linkedinAccount: 'acc-done' });
    await t.db.sql`insert into orbit.search_census (user_id, pass_started_at, pass_done_at)
      values (${done}::uuid, now() - interval '10 days', now() - interval '9 days')`;
    await t.db.sql`select orbit.enqueue_search_census()`;
    const ids = (await queued('orbit_enrich', 'search_census')).map((r) => r.user_id);
    const now = new Date();
    const weekly = now.getUTCDay() === 1 && now.getUTCHours() < 6;
    expect(ids).toContain(first);
    // a pass done 9 days ago: nothing to resume and not due again for 30 days, in the weekly slot or not
    expect(ids).not.toContain(done);
    await clearQueues(t);
    await t.db
      .sql`update orbit.search_census set pass_done_at = now() - interval '40 days' where user_id = ${done}::uuid`;
    await t.db.sql`select orbit.enqueue_search_census()`;
    const again = (await queued('orbit_enrich', 'search_census')).map((r) => r.user_id);
    expect(again.includes(done)).toBe(weekly);
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

  it('reads the last scoring from people.scored_at too (plan 35 B1: unchanged scores keep their old time)', async () => {
    const u = await connectedUser(t.db);
    const p = await addPerson(u, null);
    await t.db
      .sql`update orbit.people set created_at = now() - interval '3 days', scored_at = now() - interval '1 hour'
      where id = ${p}::uuid`;
    await t.db
      .sql`insert into orbit.tie_scores (user_id, person_id, score, band, features, contributions, model_version, computed_at)
      values (${u}::uuid, ${p}::uuid, 20, 'weak', '{}'::jsonb, '{}'::jsonb, 'test', now() - interval '10 days')`;
    await t.db.sql`select orbit.enqueue_nightly()`;
    expect(await queued('orbit_score', 'score.user')).toHaveLength(0);
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
  it('reading daily, census every 6 hours, health hourly, the cost digest each morning', async () => {
    const jobs = await t.db.sql<{ jobname: string; schedule: string }>`
      select jobname, schedule from cron.job
       where jobname in ('orbit-search-reading', 'orbit-search-census', 'orbit-health', 'orbit-cost-digest')
       order by jobname`;
    expect(jobs).toEqual([
      { jobname: 'orbit-cost-digest', schedule: '50 7 * * *' },
      { jobname: 'orbit-health', schedule: '3 * * * *' },
      { jobname: 'orbit-search-census', schedule: '11 */6 * * *' },
      { jobname: 'orbit-search-reading', schedule: '41 9 * * *' },
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
