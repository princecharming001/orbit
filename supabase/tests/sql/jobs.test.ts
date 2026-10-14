import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDb, makeUser, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const queued = async (queue: string) =>
  t.db.query<{ message: { kind: string; userId: string; dedupeKey?: string } }>(
    `select message from pgmq.q_${queue} order by msg_id`,
  );

describe('orbit.enqueue', () => {
  beforeEach(async () => {
    await t.pg.exec('delete from pgmq.q_orbit_sync; delete from orbit.job_runs;');
  });

  it('sends a message and drops a duplicate key while it is queued', async () => {
    const msg = { kind: 'noop', userId: null, payload: {}, dedupeKey: 'k1' };
    const [a] = await t.db.sql<{
      id: number | null;
    }>`select orbit.enqueue('orbit_sync', ${msg}::jsonb) as id`;
    const [b] = await t.db.sql<{
      id: number | null;
    }>`select orbit.enqueue('orbit_sync', ${msg}::jsonb) as id`;
    expect(a!.id).toBeGreaterThan(0);
    expect(b!.id).toBeNull();
    expect(await queued('orbit_sync')).toHaveLength(1);
  });

  it('drops a key that ran successfully in the last 24 hours, and accepts it after', async () => {
    await t.db.sql`insert into orbit.job_runs (queue, kind, dedupe_key, status, finished_at)
      values ('orbit_sync', 'noop', 'k2', 'ok', now() - interval '1 hour')`;
    const msg = { kind: 'noop', userId: null, payload: {}, dedupeKey: 'k2' };
    const [a] = await t.db.sql<{
      id: number | null;
    }>`select orbit.enqueue('orbit_sync', ${msg}::jsonb) as id`;
    expect(a!.id).toBeNull();
    await t.db
      .sql`update orbit.job_runs set finished_at = now() - interval '25 hours' where dedupe_key = 'k2'`;
    const [b] = await t.db.sql<{
      id: number | null;
    }>`select orbit.enqueue('orbit_sync', ${msg}::jsonb) as id`;
    expect(b!.id).toBeGreaterThan(0);
  });

  it('always sends a message without a key, and rejects unknown queues and kind-less messages', async () => {
    const msg = { kind: 'noop', userId: null, payload: {} };
    await t.db.sql`select orbit.enqueue('orbit_sync', ${msg}::jsonb)`;
    await t.db.sql`select orbit.enqueue('orbit_sync', ${msg}::jsonb)`;
    expect(await queued('orbit_sync')).toHaveLength(2);
    await expect(t.db.sql`select orbit.enqueue('nope', ${msg}::jsonb)`).rejects.toThrow(/unknown queue/);
    await expect(t.db.sql`select orbit.enqueue('orbit_sync', ${{ payload: {} }}::jsonb)`).rejects.toThrow(
      /kind/,
    );
  });
});

describe('orbit.enqueue_cadence (§9.4 test 1)', () => {
  it('enqueues exactly one message per active user per hour', async () => {
    await t.pg.exec('delete from pgmq.q_orbit_cadence;');
    const a = await makeUser(t.db);
    const b = await makeUser(t.db);
    const gone = await makeUser(t.db);
    await t.db.sql`update orbit.users set deleted_at = now() where id = ${gone}::uuid`;
    const [first] = await t.db.sql<{ n: number }>`select orbit.enqueue_cadence() as n`;
    const [second] = await t.db.sql<{ n: number }>`select orbit.enqueue_cadence() as n`;
    const msgs = (await queued('orbit_cadence')).map((r) => r.message);
    const mine = msgs.filter((m) => [a, b, gone].includes(m.userId));
    expect(mine.map((m) => m.userId).sort()).toEqual([a, b].sort());
    expect(second!.n).toBe(0);
    expect(first!.n).toBe(msgs.length);
    const hour = new Date().toISOString().slice(0, 13).replace('T', '-');
    for (const m of mine) {
      expect(m.kind).toBe('cadence.user');
      expect(m.dedupeKey).toBe(`cadence:${m.userId}:${hour}`);
    }
  });
});

describe('orbit.enqueue_incremental_syncs and enqueue_nightly', () => {
  it('polls connected Google accounts not synced in 10 minutes, by granted scope', async () => {
    await t.pg.exec('delete from pgmq.q_orbit_sync;');
    const fresh = await makeUser(t.db);
    const stale = await makeUser(t.db);
    const mailOnly = await makeUser(t.db);
    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ];
    await t.db.sql`insert into orbit.integration_accounts (user_id, provider, scopes, last_synced_at)
      values (${fresh}::uuid, 'google', ${scopes}::text[], now()),
             (${stale}::uuid, 'google', ${scopes}::text[], now() - interval '1 hour'),
             (${mailOnly}::uuid, 'google', ${scopes.slice(0, 1)}::text[], null)`;
    await t.db.sql`select orbit.enqueue_incremental_syncs()`;
    const msgs = (await queued('orbit_sync')).map((r) => `${r.message.kind}:${r.message.userId}`).sort();
    expect(msgs).toEqual(
      [
        `sync.calendar:${stale}`,
        `sync.gmail.incremental:${mailOnly}`,
        `sync.gmail.incremental:${stale}`,
      ].sort(),
    );
    const [again] = await t.db.sql<{ n: number }>`select orbit.enqueue_incremental_syncs() as n`;
    expect(again!.n).toBe(0);
  });

  it('nightly queues a score for every user and renewals for connected ones, once a day', async () => {
    await t.pg.exec('delete from pgmq.q_orbit_score; delete from pgmq.q_orbit_sync;');
    const u = await makeUser(t.db);
    await t.db.sql`insert into orbit.integration_accounts (user_id, provider, scopes)
      values (${u}::uuid, 'google', ${['https://www.googleapis.com/auth/gmail.readonly']}::text[])`;
    await t.db.sql`select orbit.enqueue_nightly()`;
    const [again] = await t.db.sql<{ n: number }>`select orbit.enqueue_nightly() as n`;
    expect(again!.n).toBe(0);
    const score = (await queued('orbit_score')).filter((r) => r.message.userId === u);
    const sync = (await queued('orbit_sync')).filter((r) => r.message.userId === u);
    expect(score.map((r) => r.message.kind)).toEqual(['score.user']);
    expect(sync.map((r) => r.message.kind)).toEqual(['sync.gmail.incremental']);
  });
});

describe('orbit.retention_purge (§10.4 test 3)', () => {
  it('nulls bodies older than the user setting and deletes expired dossiers and cache rows', async () => {
    const six = await makeUser(t.db, { settings: { body_retention_months: 6 } });
    const dflt = await makeUser(t.db);
    const thread = async (u: string) =>
      (
        await t.db.sql<{ id: string }>`insert into orbit.threads (user_id, provider, external_id)
        values (${u}::uuid, 'gmail', ${`t-${u}`}) returning id`
      )[0]!.id;
    const msg = (u: string, th: string, id: string, months: number) =>
      t.db
        .sql`insert into orbit.messages (user_id, thread_id, provider, external_id, direction, sent_at, body_text)
        values (${u}::uuid, ${th}::uuid, 'gmail', ${id}, 'in', now() - make_interval(months => ${months}), 'hello')`;
    const t6 = await thread(six);
    const td = await thread(dflt);
    await msg(six, t6, 'six-old', 7);
    await msg(six, t6, 'six-new', 5);
    await msg(dflt, td, 'd-mid', 7);
    await msg(dflt, td, 'd-old', 25);

    const person = (
      await t.db.sql<{ id: string }>`insert into orbit.people (user_id, display_name, name_norm)
        values (${dflt}::uuid, 'Priya', 'priya') returning id`
    )[0]!.id;
    const person2 = (
      await t.db.sql<{ id: string }>`insert into orbit.people (user_id, display_name, name_norm)
        values (${dflt}::uuid, 'Sam', 'sam') returning id`
    )[0]!.id;
    await t.db.sql`insert into orbit.dossiers (user_id, person_id, status, expires_at)
      values (${dflt}::uuid, ${person}::uuid, 'ready', now() - interval '1 day'),
             (${dflt}::uuid, ${person2}::uuid, 'ready', now() + interval '30 days')`;
    await t.db.sql`insert into orbit.research_cache (user_id, key, provider, response, expires_at)
      values (${dflt}::uuid, 'old', 'exa', '{}', now() - interval '1 hour'),
             (${dflt}::uuid, 'new', 'exa', '{}', now() + interval '6 days')`;
    await t.db.sql`insert into orbit.job_runs (queue, kind, status, started_at)
      values ('orbit_sync', 'noop', 'ok', now() - interval '31 days'), ('orbit_sync', 'noop', 'ok', now())`;
    await t.db.sql`insert into orbit.dead_letters (queue, message, created_at)
      values ('orbit_sync', '{}', now() - interval '91 days')`;

    const [res] = await t.db.sql<{ r: Record<string, number> }>`select orbit.retention_purge() as r`;
    expect(res!.r).toMatchObject({ message_bodies: 2, dossiers: 1, research_cache: 1, dead_letters: 1 });
    const bodies = await t.db.sql<{ external_id: string; body_text: string | null }>`
      select external_id, body_text from orbit.messages where user_id in (${six}::uuid, ${dflt}::uuid) order by 1`;
    expect(Object.fromEntries(bodies.map((b) => [b.external_id, b.body_text]))).toEqual({
      'd-mid': 'hello',
      'd-old': null,
      'six-new': 'hello',
      'six-old': null,
    });
    const dossiers = await t.db.sql`select 1 from orbit.dossiers where user_id = ${dflt}::uuid`;
    expect(dossiers).toHaveLength(1);
    const cache = await t.db.sql<{
      key: string;
    }>`select key from orbit.research_cache where user_id = ${dflt}::uuid`;
    expect(cache.map((c) => c.key)).toEqual(['new']);
    const runs = await t.db.sql`select 1 from orbit.job_runs where started_at < now() - interval '30 days'`;
    expect(runs).toHaveLength(0);
  });

  it('hard-deletes accounts marked deleted more than 24 hours ago', async () => {
    const u = await makeUser(t.db);
    await t.db.sql`update orbit.users set deleted_at = now() - interval '2 days' where id = ${u}::uuid`;
    await t.db.sql`select orbit.retention_purge()`;
    expect(await t.db.sql`select 1 from orbit.users where id = ${u}::uuid`).toHaveLength(0);
  });
});

describe('orbit.delete_user (§10.4 test 4)', () => {
  it('leaves zero rows for the user in every orbit table with a user_id column, and removes their secrets and jobs', async () => {
    const u = await makeUser(t.db);
    const other = await makeUser(t.db);
    const db = t.db;
    const [{ sid }] = (await db.sql<{
      sid: string;
    }>`select orbit.vault_put(${`google_refresh:${u}`}, 'token') as sid`) as [{ sid: string }];
    await db.sql`insert into orbit.integration_accounts (user_id, provider, token_secret_id)
      values (${u}::uuid, 'google', ${sid}::uuid)`;
    const p1 = (
      await db.sql<{ id: string }>`insert into orbit.people (user_id, display_name, name_norm, is_self)
      values (${u}::uuid, 'Me', 'me', true) returning id`
    )[0]!.id;
    const p2 = (
      await db.sql<{ id: string }>`insert into orbit.people (user_id, display_name, name_norm)
      values (${u}::uuid, 'Ann', 'ann') returning id`
    )[0]!.id;
    const [a, b] = [p1, p2].sort();
    const org = (
      await db.sql<{ id: string }>`insert into orbit.organizations (user_id, name, name_norm)
      values (${u}::uuid, 'Stripe', 'stripe') returning id`
    )[0]!.id;
    const goal = (
      await db.sql<{ id: string }>`insert into orbit.goals (user_id, kind, title)
      values (${u}::uuid, 'recruiting', 'PM') returning id`
    )[0]!.id;
    const th = (
      await db.sql<{ id: string }>`insert into orbit.threads (user_id, provider, external_id)
      values (${u}::uuid, 'gmail', 'x') returning id`
    )[0]!.id;
    const chat = (
      await db.sql<{ id: string }>`insert into orbit.chats (user_id, person_id, stage)
      values (${u}::uuid, ${p2}::uuid, 'identified') returning id`
    )[0]!.id;
    await t.pg.exec(`
      insert into orbit.sessions (user_id, refresh_hash, expires_at) values ('${u}', 'h-${u}', now() + interval '1 day');
      insert into orbit.oauth_states (state, code_verifier, redirect_to, user_id, scopes, expires_at)
        values ('s-${u}', 'v', 'r', '${u}', '{}', now());
      insert into orbit.login_codes (code_hash, user_id, expires_at) values ('c-${u}', '${u}', now());
      insert into orbit.person_identities (user_id, person_id, kind, value_norm, source)
        values ('${u}', '${p1}', 'email', 'me-${u}@x.com', 'google');
      insert into orbit.affiliations (user_id, person_id, org_id, kind, source) values ('${u}', '${p2}', '${org}', 'employment', 't');
      insert into orbit.merge_suggestions (user_id, person_a, person_b, score, features) values ('${u}', '${a}', '${b}', 0.7, '{}');
      insert into orbit.do_not_merge (user_id, person_a, person_b) values ('${u}', '${a}', '${b}');
      insert into orbit.messages (user_id, thread_id, provider, external_id, direction, sent_at)
        values ('${u}', '${th}', 'gmail', 'm', 'in', now());
      insert into orbit.calendar_events (user_id, external_id, start_at) values ('${u}', 'e', now());
      insert into orbit.ties (user_id, a_person_id, b_person_id, kind, weight, confidence)
        values ('${u}', '${a}', '${b}', 'email_cc', 0.5, 0.8);
      insert into orbit.tie_scores (user_id, person_id, score, band, features, contributions, model_version)
        values ('${u}', '${p2}', 50, 'Warm', '{}', '{}', 'tie-v1');
      insert into orbit.tie_labels (user_id, person_id, closeness) values ('${u}', '${p2}', 4);
      insert into orbit.stage_events (user_id, chat_id, to_stage, status, actor) values ('${u}', '${chat}', 'warming', 'applied', 'user');
      insert into orbit.drafts (user_id, person_id, channel, kind, body) values ('${u}', '${p2}', 'gmail', 'first_touch', 'hi');
      insert into orbit.notes (user_id, source, occurred_at, raw_text) values ('${u}', 'chat', now(), 'n');
      insert into orbit.facts (user_id, person_id, type, text) values ('${u}', '${p2}', 'role', 'PM');
      insert into orbit.dossiers (user_id, person_id, status) values ('${u}', '${p2}', 'ready');
      insert into orbit.research_cache (user_id, key, provider, response, expires_at) values ('${u}', 'k', 'exa', '{}', now());
      insert into orbit.recommendations (user_id, goal_id, candidate, source, rank, batch_id)
        values ('${u}', '${goal}', '{}', 'exa', 0.5, gen_random_uuid());
      insert into orbit.intro_requests (user_id, path, path_score, rank) values ('${u}', '[]', 0.3, 1);
      insert into orbit.memories (user_id, kind, text, source) values ('${u}', 'preference', 't', 'chat');
      insert into orbit.usage_ledger (user_id, provider, operation, units, cost_usd) values ('${u}', 'anthropic', 'x', 1, 0.01);
      insert into orbit.job_runs (queue, user_id, kind, status) values ('orbit_sync', '${u}', 'noop', 'ok');
      insert into orbit.audit_log (user_id, actor, action) values ('${u}', 'user', 'x');
      insert into orbit.dead_letters (queue, message) values ('orbit_sync', '{"kind":"x","userId":"${u}"}');
    `);
    await db.sql`select orbit.enqueue('orbit_sync', ${{ kind: 'noop', userId: u, payload: {} }}::jsonb)`;
    await db.sql`select orbit.enqueue('orbit_sync', ${{ kind: 'noop', userId: other, payload: {} }}::jsonb)`;
    await db.sql`insert into orbit.job_runs (queue, user_id, kind, status) values ('orbit_sync', ${other}::uuid, 'noop', 'ok')`;

    const tables = await db.sql<{ table_name: string }>`
      select c.table_name from information_schema.columns c
      join information_schema.tables b on b.table_schema = c.table_schema and b.table_name = c.table_name
      where c.table_schema = 'orbit' and c.column_name = 'user_id' and b.table_type = 'BASE TABLE'`;
    // every table with a user_id column holds at least one row for the user before the delete
    for (const { table_name } of tables) {
      const rows = await db.query(`select 1 from orbit.${table_name} where user_id = $1`, [u]);
      expect(rows.length, table_name).toBeGreaterThan(0);
    }

    await db.sql`select orbit.delete_user(${u}::uuid)`;

    for (const { table_name } of tables) {
      const rows = await db.query(`select 1 from orbit.${table_name} where user_id = $1`, [u]);
      expect(rows, table_name).toHaveLength(0);
    }
    expect(await db.sql`select 1 from orbit.users where id = ${u}::uuid`).toHaveLength(0);
    expect(await db.sql`select 1 from vault.secrets where id = ${sid}::uuid`).toHaveLength(0);
    expect(await db.sql`select 1 from orbit.dead_letters where message->>'userId' = ${u}`).toHaveLength(0);
    const jobs = await db.sql<{ uid: string }>`select message->>'userId' as uid from pgmq.q_orbit_sync`;
    expect(jobs.map((j) => j.uid)).not.toContain(u);
    expect(jobs.map((j) => j.uid)).toContain(other);
    expect(await db.sql`select 1 from orbit.job_runs where user_id = ${other}::uuid`).toHaveLength(1);
    expect(await db.sql`select 1 from orbit.users where id = ${other}::uuid`).toHaveLength(1);
  });
});

describe('orbit.health (§16)', () => {
  it('returns dead letters in 24 h, depth and oldest age per queue, needs_reauth users and stuck backfills', async () => {
    const u = await makeUser(t.db);
    const v = await makeUser(t.db);
    await t.db.sql`insert into orbit.integration_accounts (user_id, provider, status, sync_state)
      values (${u}::uuid, 'google', 'needs_reauth', '{}'),
             (${v}::uuid, 'google', 'active', ${{ gmail: { backfill: { phase: 'deep', done: 10, total: 100 } } }}::jsonb)`;
    // back-date past the touch trigger
    await t.pg.exec(`set session_replication_role = replica;
      update orbit.integration_accounts set updated_at = now() - interval '2 hours' where user_id = '${v}';
      set session_replication_role = origin;`);
    await t.db.sql`insert into orbit.dead_letters (queue, message) values ('orbit_send', '{}')`;
    const [{ h }] = (await t.db.sql<{ h: Record<string, unknown> }>`select orbit.health() as h`) as [
      { h: Record<string, unknown> },
    ];
    expect(Object.keys(h).sort()).toEqual(
      [
        'dead_letters_24h',
        'generated_at',
        'job_errors_24h',
        'needs_reauth',
        'queues',
        'stuck_backfills',
      ].sort(),
    );
    expect(h.dead_letters_24h).toBeGreaterThanOrEqual(1);
    expect(h.needs_reauth).toBeGreaterThanOrEqual(1);
    expect(h.stuck_backfills).toBeGreaterThanOrEqual(1);
    const queues = h.queues as { queue: string; depth: number; visible: number; oldest_age_sec: number }[];
    expect(queues.map((q) => q.queue)).toEqual([
      'orbit_send',
      'orbit_classify',
      'orbit_sync',
      'orbit_cadence',
      'orbit_score',
      'orbit_enrich',
    ]);
    for (const q of queues) {
      expect(typeof q.depth).toBe('number');
      expect(typeof q.oldest_age_sec).toBe('number');
    }
  });

  it('health_snapshot writes the snapshot to the audit log as system', async () => {
    await t.db.sql`select orbit.health_snapshot()`;
    const rows = await t.db.sql<{ actor: string; details: { queues: unknown[] } }>`
      select actor, details from orbit.audit_log where action = 'health.snapshot'`;
    expect(rows.at(-1)!.actor).toBe('system');
    expect(rows.at(-1)!.details.queues).toHaveLength(6);
  });

  it('the dashboard views answer', async () => {
    const u = await makeUser(t.db);
    await t.db.sql`insert into orbit.usage_ledger (user_id, provider, operation, units, cost_usd)
      values (${u}::uuid, 'anthropic', 'compose', 1000, 0.25), (${u}::uuid, 'anthropic', 'compose', 1000, 0.5)`;
    const costs = await t.db.sql<{ provider: string; cost_usd: string }>`
      select provider, cost_usd::text from orbit.v_costs where provider = 'anthropic'`;
    expect(Number(costs[0]!.cost_usd)).toBeGreaterThanOrEqual(0.75);
    const p = (
      await t.db.sql<{ id: string }>`insert into orbit.people (user_id, display_name, name_norm)
      values (${u}::uuid, 'Ann', 'ann') returning id`
    )[0]!.id;
    await t.db
      .sql`insert into orbit.drafts (user_id, person_id, channel, kind, body, status, sent_at, replied_at, reply_class, variant)
      values (${u}::uuid, ${p}::uuid, 'gmail', 'first_touch', 'hi', 'sent', now() - interval '3 days', now(), 'interested', 'A'),
             (${u}::uuid, ${p}::uuid, 'gmail', 'first_touch', 'hi', 'sent', now() - interval '3 days', null, null, 'A')`;
    const rates = await t.db.sql<{ sent: number; replied: number; replied_positive: number }>`
      select sent::int, replied::int, replied_positive::int from orbit.v_reply_rates where variant = 'A'`;
    expect(rates[0]).toEqual({ sent: 2, replied: 1, replied_positive: 1 });
    const depth = await t.db.sql`select * from orbit.v_queue_depth`;
    expect(depth).toHaveLength(6);
  });
});
