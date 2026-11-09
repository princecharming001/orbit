import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqlQueue } from '../../functions/_shared/queue.ts';
import { type CostDigest, costHandlers } from '../../functions/orbit-worker/handlers/cost.ts';
import {
  backoffSec,
  defaultHandlers,
  HEAVY_PER_TICK,
  isPaidError,
  type JobHandler,
  makeWorkerHandler,
  PAID_ERROR_PREFIX,
  PLACEHOLDER_KINDS,
  runTick,
} from '../../functions/orbit-worker/worker.ts';
import { freshDb, makeUser, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});
beforeEach(async () => {
  for (const q of [
    'orbit_send',
    'orbit_classify',
    'orbit_sync',
    'orbit_cadence',
    'orbit_score',
    'orbit_enrich',
  ])
    await t.pg.exec(`delete from pgmq.q_${q}; delete from pgmq.a_${q};`);
  await t.pg.exec('delete from orbit.job_runs; delete from orbit.dead_letters;');
});

const send = (queue: string, msg: unknown) =>
  t.db.sql`select pgmq.send(${queue}, ${JSON.stringify(msg)}::jsonb)`;
const runs = () =>
  t.db.sql<{ kind: string; status: string; error: string | null; attempt: number }>`
    select kind, status, error, attempt from orbit.job_runs order by id`;
const left = async (queue: string) =>
  (await t.db.query<{ n: number }>(`select count(*)::int as n from pgmq.q_${queue}`))[0]!.n;

describe('the worker endpoint', () => {
  const tick = vi.fn(async () => ({
    processed: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    deadLettered: 0,
    byQueue: {},
    stoppedBy: 'empty' as const,
  }));
  const post = (headers: Record<string, string> = {}) =>
    new Request('https://ref.supabase.co/functions/v1/orbit-worker', { method: 'POST', headers, body: '{}' });

  it('is unconfigured without the cron secret', async () => {
    const h = makeWorkerHandler({ cronSecret: undefined, db: t.db, tick });
    const r = await h(post());
    expect(r.status).toBe(503);
    expect(r.headers.get('x-orbit-connector')).toBe('unconfigured');
  });

  it('runs only for the scheduler', async () => {
    const h = makeWorkerHandler({ cronSecret: 'cron-placeholder', db: t.db, tick });
    expect((await h(post())).status).toBe(401);
    expect((await h(post({ 'x-orbit-cron': 'cron-placeholder-x' }))).status).toBe(401);
    expect((await h(new Request('https://x/orbit-worker'))).status).toBe(405);
    expect(tick).not.toHaveBeenCalled();
    const ok = await h(post({ 'x-orbit-cron': 'cron-placeholder' }));
    expect(ok.status).toBe(200);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('answers at once and keeps draining in the background when the runtime allows it', async () => {
    const waitUntil = vi.fn();
    const h = makeWorkerHandler({ cronSecret: 'cron-placeholder', db: t.db, tick, waitUntil });
    const r = await h(post({ 'x-orbit-cron': 'cron-placeholder' }));
    expect(r.status).toBe(202);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });
});

describe('runTick', () => {
  it('runs a noop, deletes it and records an ok run', async () => {
    await sqlQueue(t.db).enqueue({ kind: 'noop', userId: null, payload: {} });
    const s = await runTick({ db: t.db });
    expect(s).toMatchObject({ processed: 1, ok: 1, stoppedBy: 'empty' });
    expect(await left('orbit_enrich')).toBe(0);
    expect(await runs()).toEqual([{ kind: 'noop', status: 'ok', error: null, attempt: 1 }]);
  });

  it('drains queues in priority order', async () => {
    const order: string[] = [];
    const rec: JobHandler = async (job) => {
      order.push(job.queue);
    };
    await send('orbit_enrich', { kind: 'x', userId: null, payload: {} });
    await send('orbit_score', { kind: 'x', userId: null, payload: {} });
    await send('orbit_send', { kind: 'x', userId: null, payload: {} });
    await send('orbit_sync', { kind: 'x', userId: null, payload: {} });
    await runTick({ db: t.db, handlers: { x: rec } });
    expect(order).toEqual(['orbit_send', 'orbit_sync', 'orbit_score', 'orbit_enrich']);
  });

  it('skips the kinds later phases implement, without retrying them', async () => {
    const u = await makeUser(t.db);
    for (const kind of PLACEHOLDER_KINDS) await sqlQueue(t.db).enqueue({ kind, userId: u, payload: {} });
    const s = await runTick({ db: t.db });
    expect(s.skipped).toBe(PLACEHOLDER_KINDS.length);
    expect(s.failed).toBe(0);
    const r = await runs();
    expect(r.every((x) => x.status === 'skipped' && x.error === 'not_implemented')).toBe(true);
    for (const q of [
      'orbit_send',
      'orbit_classify',
      'orbit_sync',
      'orbit_cadence',
      'orbit_score',
      'orbit_enrich',
    ])
      expect(await left(q)).toBe(0);
  });

  it('drops a message whose dedupe key already ran, and one whose user is gone', async () => {
    await t.db.sql`insert into orbit.job_runs (queue, kind, dedupe_key, status, finished_at)
      values ('orbit_enrich', 'noop', 'once', 'ok', now())`;
    await send('orbit_enrich', { kind: 'noop', userId: null, payload: {}, dedupeKey: 'once' });
    await send('orbit_enrich', { kind: 'noop', userId: crypto.randomUUID(), payload: {} });
    const s = await runTick({ db: t.db });
    expect(s.skipped).toBe(2);
    const r = await runs();
    expect(r.slice(1).map((x) => x.error)).toEqual(['duplicate', 'user_gone']);
  });

  it('dead-letters malformed messages and unknown kinds at once', async () => {
    await send('orbit_sync', { payload: {} });
    await send('orbit_sync', { kind: 'nobody.handles.this', userId: null, payload: {} });
    await send('orbit_sync', { kind: 'noop', userId: 'not-a-uuid', payload: {} });
    const s = await runTick({ db: t.db });
    expect(s.deadLettered).toBe(3);
    const dl = await t.db.sql<{ error: string }>`select error from orbit.dead_letters order by id`;
    expect(dl.map((d) => d.error)).toEqual([
      'malformed message',
      'unknown kind nobody.handles.this',
      'malformed message',
    ]);
    expect(await left('orbit_sync')).toBe(0);
  });

  it('sets aside a message whose runs keep dying before they finish, without running it again', async () => {
    const ran = vi.fn(async () => {});
    await sqlQueue(t.db).enqueue({ kind: 'heavy', userId: null, payload: {} }, { queue: 'orbit_sync' });
    // eleven reads that never reached the handler's finish (the isolate died each time)
    await t.pg.exec('update pgmq.q_orbit_sync set read_ct = 10');
    const s = await runTick({ db: t.db, handlers: { heavy: ran } });
    expect(ran).not.toHaveBeenCalled();
    expect(s.deadLettered).toBe(1);
    expect(await left('orbit_sync')).toBe(0);
    const [dl] = await t.db.sql<{ error: string }>`select error from orbit.dead_letters`;
    expect(dl!.error).toBe('read 11 times without finishing');
  });

  it('§9.4 test 2: a failing handler is retried with growing timeouts and dead-lettered after 6 reads', async () => {
    const failing: JobHandler = async () => {
      throw new Error('upstream 500');
    };
    await sqlQueue(t.db).enqueue({ kind: 'flaky', userId: null, payload: { n: 1 } }, { queue: 'orbit_sync' });
    const timeouts: number[] = [];
    for (let read = 1; read <= 6; read++) {
      await runTick({ db: t.db, handlers: { flaky: failing } });
      if (read < 6) {
        const [m] = await t.db.sql<{ secs: number; read_ct: number }>`
          select extract(epoch from vt - now())::int as secs, read_ct from pgmq.q_orbit_sync`;
        expect(m!.read_ct).toBe(read);
        timeouts.push(m!.secs);
        // nothing runs again until the timeout passes
        const idle = await runTick({ db: t.db, handlers: { flaky: failing } });
        expect(idle.processed).toBe(0);
        await t.pg.exec('update pgmq.q_orbit_sync set vt = now()');
      }
    }
    expect(timeouts.map((s) => Math.round(s / 10) * 10)).toEqual([30, 60, 120, 240, 480]);
    expect([1, 2, 3, 4, 5].map(backoffSec)).toEqual([30, 60, 120, 240, 480]);
    expect(await left('orbit_sync')).toBe(0);
    const archived = await t.db.sql`select 1 from pgmq.a_orbit_sync`;
    expect(archived).toHaveLength(1);
    const [dl] = await t.db.sql<{ queue: string; error: string; message: { kind: string } }>`
      select queue, error, message from orbit.dead_letters`;
    expect(dl).toMatchObject({
      queue: 'orbit_sync',
      error: 'Error: upstream 500',
      message: { kind: 'flaky' },
    });
    const r = await runs();
    expect(r.map((x) => [x.status, x.attempt])).toEqual([1, 2, 3, 4, 5, 6].map((n) => ['error', n]));
  });

  it('stops at the time budget and hands unstarted messages straight back', async () => {
    for (let i = 0; i < 4; i++) await sqlQueue(t.db).enqueue({ kind: 'noop', userId: null, payload: {} });
    let ms = 0;
    const s = await runTick({ db: t.db, budgetMs: 2_500, clock: () => (ms += 400) });
    expect(s.stoppedBy).toBe('budget');
    expect(s.processed).toBeLessThan(4);
    const visible = await t.db.sql`select 1 from pgmq.q_orbit_enrich where vt <= now()`;
    expect(visible).toHaveLength(4 - s.processed);
  });

  it('closes runs an earlier tick left running, as died with the isolate', async () => {
    await t.db.sql`insert into orbit.job_runs (queue, msg_id, kind, status, attempt, started_at)
      values ('orbit_score', 1, 'score.user', 'running', 1, now() - interval '20 minutes'),
             ('orbit_score', 2, 'score.user', 'running', 1, now() - interval '2 minutes')`;
    const s = await runTick({ db: t.db, handlers: {} });
    expect(s.swept).toBe(1);
    const r = await runs();
    expect(r.map((x) => [x.status, x.error])).toEqual([
      ['error', 'died with the isolate'],
      ['running', null],
    ]);
  });

  it('does not start a job whose kind needs more time than the budget has left', async () => {
    const ran = vi.fn(async () => {});
    await sqlQueue(t.db).enqueue({ kind: 'sync.linkedin', userId: null, payload: {} });
    let ms = 0;
    // 30 s left: a LinkedIn sync needs 65 s, so it waits for the next tick and is visible at once
    const s = await runTick({
      db: t.db,
      budgetMs: 30_000,
      clock: () => (ms += 10),
      handlers: { 'sync.linkedin': ran },
    });
    expect(ran).not.toHaveBeenCalled();
    expect(s.stoppedBy).toBe('budget');
    const visible = await t.db.sql`select 1 from pgmq.q_orbit_sync where vt <= now()`;
    expect(visible).toHaveLength(1);
  });

  it('runs one CPU-heavy job per tick and leaves the rest for a fresh isolate', async () => {
    // plan 34 A7: three score.page runs in one isolate shared its 2 s of CPU and died with it
    expect(HEAVY_PER_TICK).toBe(1);
    const ran = vi.fn(async () => {});
    for (let i = 0; i < 3; i++)
      await sqlQueue(t.db).enqueue({ kind: 'score.page', userId: null, payload: { i } });
    const s = await runTick({ db: t.db, handlers: { 'score.page': ran, noop: async () => {} } });
    expect(ran).toHaveBeenCalledTimes(1);
    expect(s.stoppedBy).toBe('cpu');
    expect(await left('orbit_score')).toBe(2);
    const visible = await t.db.sql`select 1 from pgmq.q_orbit_score where vt <= now()`;
    expect(visible).toHaveLength(2);
    const again = await runTick({ db: t.db, handlers: { 'score.page': ran } });
    expect(again.processed).toBe(1);
    expect(await left('orbit_score')).toBe(1);
  });

  it('a job that failed after a paid call is run once more, then dead-lettered (plan 34 A6)', async () => {
    let calls = 0;
    const paidFailure: JobHandler = async () => {
      calls++;
      throw Object.assign(new Error('parse failed after the model answered'), { paid: true });
    };
    await sqlQueue(t.db).enqueue({ kind: 'paid', userId: null, payload: {} }, { queue: 'orbit_sync' });
    await runTick({ db: t.db, handlers: { paid: paidFailure } });
    // the first paid failure is retried like any other
    expect(await left('orbit_sync')).toBe(1);
    await t.pg.exec('update pgmq.q_orbit_sync set vt = now()');
    const s = await runTick({ db: t.db, handlers: { paid: paidFailure } });
    expect(calls).toBe(2);
    expect(s.deadLettered).toBe(1);
    expect(await left('orbit_sync')).toBe(0);
    const r = await runs();
    expect(r.map((x) => x.error)).toEqual([
      `${PAID_ERROR_PREFIX}Error: parse failed after the model answered`,
      `${PAID_ERROR_PREFIX}Error: parse failed after the model answered`,
    ]);
    expect(isPaidError(new Error('x'))).toBe(false);
  });

  it('an unpaid failure before a paid one does not count toward the paid retry', async () => {
    let calls = 0;
    const handler: JobHandler = async () => {
      calls++;
      if (calls === 1) throw new Error('upstream 500');
      throw Object.assign(new Error('after spend'), { paid: true });
    };
    await sqlQueue(t.db).enqueue({ kind: 'mixed', userId: null, payload: {} }, { queue: 'orbit_sync' });
    for (let i = 0; i < 3; i++) {
      await runTick({ db: t.db, handlers: { mixed: handler } });
      await t.pg.exec('update pgmq.q_orbit_sync set vt = now()');
    }
    // unpaid, paid (retried), paid (dead-lettered)
    expect(calls).toBe(3);
    expect(await left('orbit_sync')).toBe(0);
    expect(await t.db.sql`select 1 from orbit.dead_letters`).toHaveLength(1);
  });

  it('health.snapshot writes orbit.health() to the audit log', async () => {
    await sqlQueue(t.db).enqueue({ kind: 'health.snapshot', userId: null, payload: {} });
    await runTick({ db: t.db, handlers: defaultHandlers() });
    const rows = await t.db.sql<{ details: { queues: unknown[] } }>`
      select details from orbit.audit_log where action = 'health.snapshot' and actor = 'system'`;
    expect(rows.at(-1)!.details.queues).toHaveLength(6);
  });
});

describe('cost.digest (plan 34 E2)', () => {
  const NOW = new Date('2026-11-10T07:50:00Z');
  const YESTERDAY = '2026-11-09T12:00:00Z';
  beforeEach(async () => {
    await t.pg.exec(`
      delete from orbit.audit_log where action = 'cost.digest';
      delete from orbit.usage_ledger; delete from public.orbit_proxy_spend; delete from public.orbit_proxy_counters;
      delete from orbit_private.claude_usage; delete from public.orbit_research_runs;
      update orbit_private.provider_switches set enabled = true;
    `);
  });
  const digestRows = () =>
    t.db.sql<{ details: CostDigest; target_id: string }>`
      select details, target_id from orbit.audit_log where action = 'cost.digest' order by id`;
  const mailer = () => {
    const sent: { to: string; subject: string; text: string }[] = [];
    return {
      sent,
      configured: true,
      send: async (m: { to: string; subject: string; text: string }) => {
        sent.push(m);
        return { ok: true as const, id: 'm1' };
      },
    };
  };
  const run = async (deps: Parameters<typeof costHandlers>[0]) => {
    // the cron enqueues to orbit_enrich over SQL (orbit.enqueue_cost_digest)
    await sqlQueue(t.db).enqueue(
      { kind: 'cost.digest', userId: null, payload: {} },
      { queue: 'orbit_enrich' },
    );
    await runTick({ db: t.db, now: () => NOW, handlers: costHandlers(deps) });
  };

  it('writes one audit row for yesterday with spend per provider and per student, and mails nothing under the lines', async () => {
    const u = await makeUser(t.db);
    await t.db
      .sql`insert into orbit.usage_ledger (user_id, provider, operation, units, cost_usd, created_at) values
      (${u}::uuid, 'anthropic', 'classify', 1, 0.01, ${YESTERDAY}::timestamptz),
      (${u}::uuid, 'hunter', 'find', 2, 0, ${YESTERDAY}::timestamptz),
      (${u}::uuid, 'anthropic', 'classify', 1, 5, '2026-11-08T12:00:00Z'::timestamptz)`;
    await t.db.sql`insert into public.orbit_proxy_spend (subject, usd, requests) values
      ('global:2026-11-09', 1.5, 60), (${`user:${u}:2026-11-09`}, 1.2, 50), (${`user:${u}`}, 9, 400)`;
    await t.db
      .sql`insert into orbit_private.claude_usage (subject, at, input, cache_read, cache_write, output, web_searches, usd)
      values (${`user:${u}`}, ${YESTERDAY}::timestamptz, 1000, 7000, 2000, 500, 2, 0.02)`;
    await t.db.sql`insert into public.orbit_proxy_counters (bucket, count, expires_at)
      values ('connectors:li:profile:2026-11-09:acc-1', 40, now() + interval '1 day')`;
    const m = mailer();
    await run({ mailer: m, ownerId: u });
    const rows = await digestRows();
    expect(rows).toHaveLength(1);
    const d = rows[0]!.details;
    expect(rows[0]!.target_id).toBe('2026-11-09');
    expect(d.day).toBe('2026-11-09');
    expect(d.anthropicUsd).toBeCloseTo(1.51, 5);
    expect(d.totalUsd).toBeCloseTo(1.51, 5);
    expect(d.providers.map((p) => `${p.provider}/${p.operation}`).sort()).toEqual(
      ['anthropic/chat', 'anthropic/classify', 'hunter/find'].sort(),
    );
    expect(d.users).toEqual([{ userId: u, ledgerUsd: 0.01, chatUsd: 1.2, totalUsd: 1.21 }]);
    expect(d.chat).toMatchObject({ answers: 1, cacheReadTokens: 7000, webSearches: 2, cacheReadShare: 0.7 });
    expect(d.hunterMonthCredits).toBe(2);
    expect(d.linkedin).toEqual([{ kind: 'profile', accountId: 'acc-1', count: 40, total: 100, share: 0.4 }]);
    expect(d.jobs).toMatchObject({ isolateDeaths: 0, deadLetters: 0 });
    expect(d.switchedOff).toEqual([]);
    expect(d.unipileAccounts).toBeNull();
    expect(d.crossed).toEqual([]);
    expect(d.mailed).toBe(false);
    expect(m.sent).toHaveLength(0);
  });

  it('mails the owner once when a threshold is crossed, in plain words', async () => {
    const owner = await makeUser(t.db, { email: 'owner@example.com' });
    await t.db
      .sql`insert into public.orbit_proxy_spend (subject, usd, requests) values ('global:2026-11-09', 6, 200)`;
    await t.pg.exec(`update orbit_private.provider_switches set enabled = false where provider = 'hunter'`);
    const m = mailer();
    await run({ mailer: m, ownerId: owner });
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]!.to).toBe('owner@example.com');
    expect(m.sent[0]!.text).toContain('Anthropic spend in the day');
    expect(m.sent[0]!.text).toContain('Switched off: hunter.');
    expect(m.sent[0]!.text + m.sent[0]!.subject).not.toMatch(/[\u2014!]/);
    const d = (await digestRows())[0]!.details;
    expect(d.crossed.map((c) => c.key)).toEqual(['anthropicUsdDay', 'switchedOff']);
    expect(d.mailed).toBe(true);
  });

  it('records why nothing was mailed when there is no mailer or no owner', async () => {
    await t.db
      .sql`insert into public.orbit_proxy_spend (subject, usd, requests) values ('global:2026-11-09', 6, 200)`;
    await run({});
    expect((await digestRows())[0]!.details.mailError).toBe('no_mailer');
    await t.pg.exec(`delete from orbit.job_runs; delete from orbit.audit_log where action = 'cost.digest';`);
    const m = mailer();
    await run({ mailer: m, thresholds: { anthropicUsdDay: 1 } });
    expect((await digestRows())[0]!.details.mailError).toBe('no_owner');
    expect(m.sent).toHaveLength(0);
  });
});
