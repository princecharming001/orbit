import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, makeUser, migrationSql, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const QUEUES = ['orbit_send', 'orbit_classify', 'orbit_sync', 'orbit_cadence', 'orbit_score', 'orbit_enrich'];

describe('orbit core migration', () => {
  it('applies cleanly and creates every table of §11.3 with RLS on', async () => {
    const tables = await t.db.sql<{ table_name: string; rls: boolean }>`
      select c.relname as table_name, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'orbit' and c.relkind = 'r' order by 1`;
    const names = tables.map((r) => r.table_name);
    for (const name of [
      'users',
      'sessions',
      'oauth_states',
      'login_codes',
      'integration_accounts',
      'organizations',
      'people',
      'person_identities',
      'affiliations',
      'merge_suggestions',
      'do_not_merge',
      'goals',
      'threads',
      'messages',
      'calendar_events',
      'ties',
      'tie_scores',
      'tie_labels',
      'chats',
      'stage_events',
      'drafts',
      'notes',
      'facts',
      'dossiers',
      'research_cache',
      'recommendations',
      'intro_requests',
      'memories',
      'usage_ledger',
      'job_runs',
      'dead_letters',
      'audit_log',
      'webhook_events',
    ])
      expect(names).toContain(name);
    expect(tables.every((r) => r.rls)).toBe(true);
    const policies = await t.db.sql`select 1 from pg_policies where schemaname = 'orbit'`;
    expect(policies).toHaveLength(0);
  });

  it('is re-runnable', async () => {
    await t.pg.exec(migrationSql('20261014_orbit_core.sql'));
    await t.pg.exec(migrationSql('20261014_orbit_cron.sql'));
    const jobs = await t.db.sql<{ jobname: string }>`select jobname from cron.job order by jobname`;
    expect(jobs.map((j) => j.jobname)).toEqual([
      'orbit-cadence',
      'orbit-health',
      'orbit-incremental',
      'orbit-nightly',
      'orbit-retention',
      'orbit-worker-tick',
    ]);
  });

  it('creates the six queues', async () => {
    const rows = await t.db.sql<{ queue_name: string }>`select queue_name from pgmq.meta order by 1`;
    expect(rows.map((r) => r.queue_name).sort()).toEqual([...QUEUES].sort());
  });

  it('gives every table with updated_at the touch trigger and a (user_id, updated_at) index', async () => {
    const withUpdated = await t.db.sql<{ table_name: string }>`
      select c.table_name from information_schema.columns c
      join information_schema.tables b on b.table_schema = c.table_schema and b.table_name = c.table_name
      where c.table_schema = 'orbit' and c.column_name = 'updated_at' and b.table_type = 'BASE TABLE'`;
    const triggers = await t.db.sql<{ tbl: string }>`
      select c.relname as tbl from pg_trigger g join pg_class c on c.oid = g.tgrelid
      join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'orbit' and g.tgname = 'touch_updated_at'`;
    expect(new Set(triggers.map((r) => r.tbl))).toEqual(new Set(withUpdated.map((r) => r.table_name)));
    const idx = await t.db.sql<{
      indexname: string;
    }>`select indexname from pg_indexes where schemaname = 'orbit'`;
    for (const { table_name } of withUpdated)
      if (table_name !== 'users') expect(idx.map((i) => i.indexname)).toContain(`${table_name}_sync_idx`);
  });

  it('touches updated_at on update', async () => {
    const userId = await makeUser(t.db);
    await t.db.sql`update orbit.users set updated_at = now() - interval '1 day' where id = ${userId}::uuid`;
    // the trigger wins over an explicit value
    const [before] = await t.db.sql<{
      updated_at: Date;
    }>`select updated_at from orbit.users where id = ${userId}::uuid`;
    expect(Date.now() - before!.updated_at.getTime()).toBeLessThan(60_000);
  });

  it('declares every function security definer with an empty search_path, executable by service_role only', async () => {
    const fns = await t.db.sql<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      acl: string | null;
    }>`
      select p.proname, p.prosecdef, p.proconfig, p.proacl::text as acl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'orbit'`;
    expect(fns.length).toBeGreaterThan(10);
    for (const f of fns) {
      expect(f.prosecdef, f.proname).toBe(true);
      expect(f.proconfig, f.proname).toContain('search_path=""');
      expect(f.acl ?? '', f.proname).toContain('service_role=X');
      expect(f.acl ?? '', f.proname).not.toMatch(/(^|[{,])=X/);
      expect(f.acl ?? '', f.proname).not.toContain('anon=');
    }
  });

  it('keeps anon and authenticated out of the schema', async () => {
    const rows = await t.db.sql<{ anon: boolean; auth: boolean; svc: boolean }>`
      select has_schema_privilege('anon', 'orbit', 'usage') as anon,
             has_schema_privilege('authenticated', 'orbit', 'usage') as auth,
             has_schema_privilege('service_role', 'orbit', 'usage') as svc`;
    expect(rows[0]).toEqual({ anon: false, auth: false, svc: true });
  });

  it('stores 384-dimension embeddings', async () => {
    const userId = await makeUser(t.db);
    const vec = `[${Array.from({ length: 384 }, () => 0.01).join(',')}]`;
    await t.db.sql`insert into orbit.memories (user_id, kind, text, embedding, source)
      values (${userId}::uuid, 'preference', 'Prefers email', ${vec}::vector, 'test')`;
    const rows = await t.db.sql`select 1 from orbit.memories where user_id = ${userId}::uuid`;
    expect(rows).toHaveLength(1);
  });
});

describe('vault helpers', () => {
  it('puts, updates by name, reads and deletes', async () => {
    const [{ id }] = (await t.db.sql<{ id: string }>`select orbit.vault_put('test:a', 'one') as id`) as [
      { id: string },
    ];
    const [{ id: id2 }] = (await t.db.sql<{ id: string }>`select orbit.vault_put('test:a', 'two') as id`) as [
      { id: string },
    ];
    expect(id2).toBe(id);
    const [got] = await t.db.sql<{ v: string }>`select orbit.vault_get(${id}::uuid) as v`;
    expect(got!.v).toBe('two');
    await t.db.sql`select orbit.vault_delete(${id}::uuid)`;
    const [gone] = await t.db.sql<{ v: string | null }>`select orbit.vault_get(${id}::uuid) as v`;
    expect(gone!.v).toBeNull();
  });
});

describe('cron schedules', () => {
  it('schedules the §9.1 entries', async () => {
    const jobs = await t.db.sql<{ jobname: string; schedule: string; command: string }>`
      select jobname, schedule, command from cron.job`;
    const by = Object.fromEntries(jobs.map((j) => [j.jobname, j]));
    expect(by['orbit-worker-tick']!.schedule).toBe('* * * * *');
    expect(by['orbit-incremental']).toMatchObject({
      schedule: '*/10 * * * *',
      command: 'select orbit.enqueue_incremental_syncs()',
    });
    expect(by['orbit-cadence']).toMatchObject({
      schedule: '7 * * * *',
      command: 'select orbit.enqueue_cadence()',
    });
    expect(by['orbit-nightly']).toMatchObject({
      schedule: '13 7 * * *',
      command: 'select orbit.enqueue_nightly()',
    });
    expect(by['orbit-retention']).toMatchObject({
      schedule: '23 8 * * *',
      command: 'select orbit.retention_purge()',
    });
    expect(by['orbit-health']!.schedule).toBe('*/15 * * * *');
  });

  it('the worker tick posts to orbit-worker with the cron secret from Vault, and does nothing until both are set', async () => {
    const [none] = await t.db.sql<{ id: number | null }>`select orbit.cron_call_worker() as id`;
    expect(none!.id).toBeNull();
    await t.db
      .sql`select vault.create_secret('https://ref.supabase.co/functions/v1/', 'orbit_functions_url')`;
    await t.db.sql`select vault.create_secret('cron-secret-placeholder', 'orbit_cron_secret')`;
    const [{ id }] = (await t.db.sql<{ id: number }>`select orbit.cron_call_worker() as id`) as [
      { id: number },
    ];
    const [req] = await t.db.sql<{ url: string; headers: Record<string, string> }>`
      select url, headers from net.http_request_queue where id = ${id}`;
    expect(req!.url).toBe('https://ref.supabase.co/functions/v1/orbit-worker');
    expect(req!.headers['x-orbit-cron']).toBe('cron-secret-placeholder');
  });
});
