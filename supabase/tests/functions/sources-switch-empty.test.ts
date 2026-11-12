/**
 * Plan 43 §8.1: with the owner's switch empty (ORBIT_EXTRA_SOURCES unset) Orbit behaves exactly as it did before the
 * optional sources were built. A student with LinkedIn and Gmail, and one with neither, are scored, routed, pulled,
 * projected for friends and given a draft's context, and the answers are compared with what the code before plan 43's
 * server base gave for the same fixture (sources-switch-empty.baseline.json; refresh only from a known-good build
 * with SOURCES_BASELINE=write).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scorePeople } from '../../functions/_shared/ingest/score.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';
import { NOW, seedStudent, snapshot } from '../helpers/sourcesFixture.ts';

const BASELINE = join(__dirname, 'sources-switch-empty.baseline.json');
const WRITE = process.env.SOURCES_BASELINE === 'write';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

async function run(base: boolean) {
  const s = await seedStudent(t, { base, rows: [] });
  // a full rescore with a refit, twice: a person's score reads the neighbours' previous scores
  await scorePeople(t.db, s.userId, { now: NOW, fit: true });
  await scorePeople(t.db, s.userId, { now: NOW, fit: true });
  return snapshot(t, s);
}

describe('the owner switch, empty', () => {
  it('gives what the code before plan 43 gave, for a student with LinkedIn and Gmail and one with neither', async () => {
    const out = { withBase: await run(true), neither: await run(false) };
    // a round trip through JSON, as the baseline is stored
    const got = JSON.parse(JSON.stringify(out));
    if (WRITE) writeFileSync(BASELINE, `${JSON.stringify(got, null, 2)}\n`);
    const want = JSON.parse(readFileSync(BASELINE, 'utf8'));
    expect(got).toEqual(want);
  });
});
