import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqlQueue } from '../../functions/_shared/queue.ts';
import {
  backoffSec,
  defaultHandlers,
  type JobHandler,
  makeWorkerHandler,
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

  it('health.snapshot writes orbit.health() to the audit log', async () => {
    await sqlQueue(t.db).enqueue({ kind: 'health.snapshot', userId: null, payload: {} });
    await runTick({ db: t.db, handlers: defaultHandlers() });
    const rows = await t.db.sql<{ details: { queues: unknown[] } }>`
      select details from orbit.audit_log where action = 'health.snapshot' and actor = 'system'`;
    expect(rows.at(-1)!.details.queues).toHaveLength(6);
  });
});
