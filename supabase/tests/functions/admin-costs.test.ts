import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryTake } from '../../functions/_shared/ratelimit.ts';
import { makeApiHandler } from '../../functions/orbit-api/api.ts';
import { APP, agentConfig, BASE, fakeNet, SECRET, signedInUser } from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

/**
 * Plan 34 E3 and C1: the owner's cost view over the worker's daily digest rows, and the functions the Claude proxy
 * and the connectors write their usage through.
 */

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

function getter(ownerId: string | undefined) {
  const net = fakeNet();
  const handler = makeApiHandler({
    env: { sessionSecret: SECRET, appUrl: APP, ownerId },
    db: t.db,
    fetch: net.fetch,
    take: memoryTake(),
    agent: agentConfig(net),
  });
  return async (token: string) => {
    const r = await handler(
      new Request(`${BASE}/admin/costs`, { headers: { authorization: `Bearer ${token}` } }),
    );
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
}

describe('GET /admin/costs', () => {
  it('gives the owner the last 30 digest rows, newest first, and nobody else anything', async () => {
    const owner = await signedInUser(t);
    const other = await signedInUser(t);
    for (let i = 0; i < 32; i++)
      await t.db.sql`
        insert into orbit.audit_log (actor, action, details, created_at)
        values ('system', 'cost.digest', ${{ day: `2026-10-${String(i + 1).padStart(2, '0')}`, n: i }}::jsonb,
                now() - make_interval(days => ${32 - i}))`;
    await t.db
      .sql`insert into orbit.audit_log (actor, action, details) values ('system', 'health.snapshot', '{}'::jsonb)`;

    const get = getter(owner.userId);
    const mine = await get(owner.token);
    expect(mine.status).toBe(200);
    const rows = mine.body.rows as { at: string; details: { n: number } }[];
    expect(rows).toHaveLength(30);
    expect(rows[0]!.details.n).toBe(31);
    expect(rows[29]!.details.n).toBe(2);
    expect(typeof rows[0]!.at).toBe('string');

    expect((await get(other.token)).status).toBe(404);
    // with no owner set, the route answers as if it did not exist
    expect((await getter(undefined)(owner.token)).status).toBe(404);
  });
});

describe('usage functions for the proxy and the connectors', () => {
  it('writes one claude_usage row per answer and clamps nonsense', async () => {
    await t.db.sql`select public.orbit_claude_usage_add('user:x:2026-11-09', 'chat', 'claude-opus-5-5',
                                                        100, 900, 50, 20, 1, 2, 0.0123)`;
    await t.db.sql`select public.orbit_claude_usage_add('client:y', null, null, -5, null, 0, 0, 0, null, -1)`;
    const rows = await t.db.sql<{
      subject: string;
      call: string;
      input: number;
      cache_read: number;
      iterations: number | null;
      usd: string;
    }>`select subject, call, input, cache_read, iterations, usd::text from orbit_private.claude_usage order by id`;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      subject: 'user:x:2026-11-09',
      call: 'chat',
      input: 100,
      cache_read: 900,
      iterations: 2,
    });
    expect(Number(rows[0]!.usd)).toBeCloseTo(0.0123, 5);
    expect(rows[1]).toMatchObject({ call: 'chat', input: 0, cache_read: 0, iterations: null });
    expect(Number(rows[1]!.usd)).toBe(0);
  });

  it('records Exa and Village rows with no user and refuses any other provider', async () => {
    await t.db.sql`select public.orbit_usage_add('exa', 'web', 1, 0.007, 'visitorhash')`;
    await t.db.sql`select public.orbit_usage_add('village', 'paths:person', 5, 0.1, 'visitorhash')`;
    const rows = await t.db.sql<{
      provider: string;
      user_id: string | null;
      account_id: string;
      units: string;
    }>`
      select provider, user_id, account_id, units::text from orbit.usage_ledger
       where account_id = 'visitorhash' order by id`;
    expect(rows.map((r) => [r.provider, r.user_id, Number(r.units)])).toEqual([
      ['exa', null, 1],
      ['village', null, 5],
    ]);
    await expect(t.db.sql`select public.orbit_usage_add('hunter', 'find', 1, 0, 'x')`).rejects.toThrow();
  });

  it('reads the session key from Vault for the proxy', async () => {
    await t.db.sql`delete from vault.secrets where name = 'orbit_session_secret'`;
    await t.db.sql`select vault.create_secret('a-session-key-kept-in-vault', 'orbit_session_secret')`;
    const r = await t.db.sql<{ v: string }>`select public.orbit_session_secret() as v`;
    expect(r[0]!.v).toBe('a-session-key-kept-in-vault');
  });
});
