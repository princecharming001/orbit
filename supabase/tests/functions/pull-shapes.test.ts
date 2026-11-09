/**
 * Every field a core mapper (packages/core/src/server/mappers.ts) reads straight from a column must reach the browser
 * under the same name through /sync/pull's generic shaping: a field the browser's screens read that the pull sends
 * under another name is simply missing in account mode (a role with no company, a merge suggestion with no people).
 * Plan 35 B2: a row rewritten with the same values keeps its updated_at, so the next pull does not send it again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as M from '../../../packages/core/src/server/mappers.ts';
import { scorePeople } from '../../functions/_shared/ingest/score.ts';
import { upsertTies } from '../../functions/_shared/ingest/ties.ts';
import { PULL_BY_NAME, shapeRow } from '../../functions/orbit-api/tables.ts';
import { freshDb, makeUser, type TestDb } from '../helpers/pglite.ts';

const COLUMNS: Record<string, [string[], (r: never) => unknown]> = {
  affiliations: [
    [
      'id',
      'user_id',
      'person_id',
      'org_id',
      'org_raw',
      'kind',
      'title',
      'degree',
      'field',
      'start_date',
      'end_date',
      'source',
    ],
    M.affiliationFromRow as never,
  ],
  merge_suggestions: [
    ['id', 'user_id', 'person_a', 'person_b', 'created_at'],
    M.mergeSuggestionFromRow as never,
  ],
  threads: [
    ['id', 'user_id', 'provider', 'external_id', 'subject', 'first_at', 'last_at', 'category', 'chat_id'],
    ((r: never) => M.threadFromRow(r)) as never,
  ],
  calendar_events: [
    [
      'id',
      'user_id',
      'external_id',
      'title',
      'description',
      'start_at',
      'end_at',
      'conference_url',
      'chat_id',
    ],
    M.calendarEventFromRow as never,
  ],
  chats: [
    ['id', 'user_id', 'person_id', 'goal_id', 'org_id', 'stage', 'stage_entered_at'],
    M.chatFromRow as never,
  ],
  people: [
    [
      'id',
      'user_id',
      'display_name',
      'name_norm',
      'primary_email',
      'headline',
      'title',
      'org_id',
      'org_raw',
      'location',
    ],
    ((r: never) => M.personFromRow(r)) as never,
  ],
  organizations: [
    ['id', 'user_id', 'name', 'name_norm', 'linkedin_slug', 'industry'],
    M.organizationFromRow as never,
  ],
};

describe('pull shapes', () => {
  for (const [table, [cols, fromRow]] of Object.entries(COLUMNS))
    it(`${table} sends every column-backed field under the browser's name`, () => {
      const row: Record<string, unknown> = {
        data: {},
        attendees: [],
        attendee_person_ids: [],
        participant_person_ids: [],
        domains: [],
        sources: [],
        tags: [],
      };
      for (const c of cols) row[c] = `v:${c}`;
      const want = fromRow(row as never) as Record<string, unknown>;
      const got = shapeRow(PULL_BY_NAME.get(table)!, row);
      const missing = Object.entries(want)
        .filter(([k, v]) => typeof v === 'string' && v.startsWith('v:') && got[k] !== v)
        .map(([k]) => k);
      expect(missing).toEqual([]);
    });

  it('merge suggestions arrive with the browser status', () => {
    const t = PULL_BY_NAME.get('merge_suggestions')!;
    expect(shapeRow(t, { status: 'open' }).status).toBe('pending');
    expect(shapeRow(t, { status: 'merged' }).status).toBe('accepted');
    expect(shapeRow(t, { status: 'rejected' }).status).toBe('rejected');
  });
});

describe('unchanged rows are not sent again (plan 35 B2)', () => {
  let t: TestDb;
  let u: string;
  let a: string;
  let b: string;
  const DAY_AGO = new Date(Date.now() - 86_400_000).toISOString();
  beforeAll(async () => {
    t = await freshDb();
    u = await makeUser(t.db);
    const ids = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, first_name, name_norm, updated_at)
      values (${u}::uuid, 'Ada Lovelace', 'Ada', 'ada lovelace', ${DAY_AGO}::timestamptz),
             (${u}::uuid, 'Ben Okafor', 'Ben', 'ben okafor', ${DAY_AGO}::timestamptz)
      returning id`;
    [a, b] = ids.map((r) => r.id).sort() as [string, string];
  });
  afterAll(async () => {
    await t.pg.close();
  });
  const stamp = async (table: string, where: string) =>
    (await t.db.query<{ at: string }>(`select updated_at::text as at from orbit.${table} where ${where}`))[0]!
      .at;

  it('an update that changes nothing keeps updated_at, even when it sets updated_at itself', async () => {
    const before = await stamp('people', `id = '${a}'`);
    await t.db
      .sql`update orbit.people set display_name = display_name, updated_at = now() where id = ${a}::uuid`;
    expect(await stamp('people', `id = '${a}'`)).toBe(before);
    await t.db.sql`update orbit.people set scored_at = now() where id = ${a}::uuid`;
    expect(await stamp('people', `id = '${a}'`)).toBe(before);
    await t.db.sql`update orbit.people set title = 'Engineer' where id = ${a}::uuid`;
    expect(await stamp('people', `id = '${a}'`)).not.toBe(before);
  });

  it('a no-op tie upsert and an unchanged score run keep their updated_at', async () => {
    const now = new Date();
    const tie = { a, b, kind: 'email_cc', weight: 0.45, confidence: 0.6, evidence: { messages: 1 } };
    await upsertTies(t.db, u, [tie], now);
    await t.db.sql`update orbit.ties set evidence = evidence where user_id = ${u}::uuid`;
    const tieAt = await stamp('ties', `user_id = '${u}'`);
    await upsertTies(t.db, u, [tie], now);
    expect(await stamp('ties', `user_id = '${u}'`)).toBe(tieAt);
    await upsertTies(t.db, u, [{ ...tie, weight: 0.5 }], now);
    expect(await stamp('ties', `user_id = '${u}'`)).not.toBe(tieAt);

    // without the tie: with it each run reads the other's last score (the structural feature), which moves a little
    // every run until it settles
    await t.db.sql`delete from orbit.ties where user_id = ${u}::uuid`;
    await scorePeople(t.db, u, { now, personIds: [a, b] });
    const scoreAt = await stamp('tie_scores', `person_id = '${a}'`);
    const personAt = await stamp('people', `id = '${a}'`);
    const [first] = await t.db.sql<{ scored_at: string }>`
      select scored_at::text from orbit.people where id = ${a}::uuid`;
    await scorePeople(t.db, u, { now, personIds: [a, b] });
    expect(await stamp('tie_scores', `person_id = '${a}'`)).toBe(scoreAt);
    expect(await stamp('people', `id = '${a}'`)).toBe(personAt);
    const [second] = await t.db.sql<{ scored_at: string }>`
      select scored_at::text from orbit.people where id = ${a}::uuid`;
    expect(second!.scored_at >= first!.scored_at).toBe(true);
  });

  it('tie_scores reach the browser without features, contributions or explanation', () => {
    const row = shapeRow(PULL_BY_NAME.get('tie_scores')!, {
      person_id: 'p',
      score: 40,
      band: 'medium',
      features: { reciprocity: 1 },
      contributions: { f1: 2 },
      explanation: ['3 meetings'],
    });
    expect(row).toEqual({ personId: 'p', score: 40, band: 'medium' });
  });
});
