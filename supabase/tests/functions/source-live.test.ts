/**
 * Web sourcing against the real web and the real model (plan 31 §3), for iteration: what a student gets for
 * "source professors I can reach out to for biomed research at Berkeley", and what it cost. Skipped unless
 * ORBIT_SOURCE_LIVE=1 and ANTHROPIC_API_KEY are set. The ask can be changed with ORBIT_SOURCE_ASK, the school with
 * ORBIT_SOURCE_SCHOOL. Prints the ranked list; writes it to SOURCE_LIVE_OUT when set.
 */
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeServices } from '../../functions/_shared/services.ts';
import { runSourcing } from '../../functions/_shared/sourcing/run.ts';
import { ALL_KEYS, signedInUser } from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

const LIVE = process.env.ORBIT_SOURCE_LIVE === '1' && !!process.env.ANTHROPIC_API_KEY;
const d = LIVE ? describe : describe.skip;

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

d('web sourcing, live', () => {
  it('finds professors with email and context for the Berkeley biomed ask', async () => {
    const { userId } = await signedInUser(t, { firstName: 'Ana' });
    const s = makeServices(
      {
        env: {
          ...ALL_KEYS,
          anthropicKey: process.env.ANTHROPIC_API_KEY,
          exaKey: process.env.EXA_API_KEY,
          apolloKey: undefined,
          unipileKey: undefined,
          semanticScholarKey: undefined,
        },
        fetch,
      },
      { db: t.db },
    );
    const school = process.env.ORBIT_SOURCE_SCHOOL ?? 'UC Berkeley';
    const query = process.env.ORBIT_SOURCE_ASK ?? 'professors I can reach out to for biomed research';
    const t0 = Date.now();
    const r = await runSourcing(s, userId, {
      purpose: 'collaboration',
      query,
      filters: { schools: [school], keywords: ['biomedical research'] },
      limit: 25,
    });
    const ms = Date.now() - t0;
    const spend = await t.db.sql<{ provider: string; operation: string; usd: string; n: number }>`
        select provider, operation, sum(cost_usd)::text as usd, count(*)::int as n from orbit.usage_ledger
         where user_id = ${userId}::uuid group by 1, 2 order by 3 desc`;
    const lines = [
      `ask: ${query} at ${school}`,
      `results: ${r.results.length} in ${ms} ms; unconfigured: ${r.unconfigured.join(', ') || 'none'}; ${(r.notes ?? []).join('; ')}`,
      ...spend.map(
        (x) => `spend ${x.provider}/${x.operation}: $${Number(x.usd).toFixed(4)} over ${x.n} calls`,
      ),
      '',
      ...r.results.map(
        (c, i) =>
          `${i + 1}. ${c.name} | ${c.title ?? ''} | ${c.org ?? ''} | ${c.email ?? 'no email'} | fit ${c.fit} | ${c.source}\n   ${(c.evidence ?? []).join('\n   ')}\n   reasons: ${c.reasons.join('; ')}`,
      ),
    ];
    const text = lines.join('\n');
    console.log(text);
    if (process.env.SOURCE_LIVE_OUT) writeFileSync(process.env.SOURCE_LIVE_OUT, `${text}\n`);
    expect(r.results.length).toBeGreaterThan(0);
  }, 180_000);
});
