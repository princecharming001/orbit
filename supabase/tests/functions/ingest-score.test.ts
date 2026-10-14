/**
 * Ties and tie scores through the worker handlers, on rows written straight to PGlite (§2.8, §3.8): routability of
 * same_city and email_cc rows, decay of old exchanges, A9 monotonicity, labels, calibration and the family floor.
 */
import { isRoutable, pairsFromEdges } from '@orbit/core/graph/ties';
import { edgeFromTieRow, type Row } from '@orbit/core/server/mappers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recountThread } from '../../functions/_shared/ingest/gmail.ts';
import { loadSelf } from '../../functions/_shared/ingest/util.ts';
import { defaultHandlers } from '../../functions/orbit-worker/worker.ts';
import { clearQueues, connectedUser, drain } from '../helpers/ingest.ts';
import { NOW } from '../helpers/mailFixtures.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});
beforeEach(async () => {
  await clearQueues(t);
});

const DAY = 86_400_000;
const at = (now: number, daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();
const handlers = defaultHandlers({});

async function addPerson(u: string, name: string, extra: { location?: string; relationship?: string } = {}) {
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}@example.org`;
  const [p] = await t.db.sql<{ id: string }>`
    insert into orbit.people (user_id, display_name, first_name, last_name, name_norm, primary_email, location,
                              relationship_type, sources)
    values (${u}::uuid, ${name}, ${name.split(' ')[0]}, ${name.split(' ')[1] ?? null}, ${name.toLowerCase()}, ${email},
            ${extra.location ?? null}, ${extra.relationship ?? null}, ${['gmail']}::text[])
    returning id`;
  await t.db.sql`insert into orbit.person_identities (user_id, person_id, kind, value_norm, source)
    values (${u}::uuid, ${p!.id}::uuid, 'email', ${email}, 'gmail')`;
  return { id: p!.id, email };
}

type P = { id: string; email: string };
interface Msg {
  dir: 'in' | 'out';
  from?: P;
  to?: P[];
  cc?: P[];
  daysAgo: number;
}

let threadNo = 0;
async function addThread(u: string, now: number, msgs: Msg[]) {
  const ext = `thread-${++threadNo}`;
  const [th] = await t.db.sql<{ id: string }>`
    insert into orbit.threads (user_id, provider, external_id, is_networking) values (${u}::uuid, 'gmail', ${ext}, true)
    returning id`;
  let i = 0;
  for (const m of msgs) {
    await t.db.sql`
      insert into orbit.messages (user_id, thread_id, provider, external_id, direction, from_person_id, from_addr,
                                  to_addrs, cc_addrs, to_person_ids, cc_person_ids, sent_at, body_text)
      values (${u}::uuid, ${th!.id}::uuid, 'gmail', ${`${ext}-${i++}`}, ${m.dir}, ${m.from?.id ?? null}::uuid,
              ${m.from?.email ?? 'me@example.com'}, ${(m.to ?? []).map((x) => x.email)}::text[],
              ${(m.cc ?? []).map((x) => x.email)}::text[], ${(m.to ?? []).map((x) => x.id)}::uuid[],
              ${(m.cc ?? []).map((x) => x.id)}::uuid[], ${at(now, m.daysAgo)}::timestamptz, 'hello')`;
  }
  await recountThread(t.db, th!.id, await loadSelf(t.db, u));
  return th!.id;
}

const job = (kind: string, userId: string, payload: Record<string, unknown> = {}) =>
  t.db.sql`select orbit.enqueue('orbit_score', ${{ kind, userId, payload }}::jsonb, 0)`;

async function score(u: string, p: string, now: number) {
  await job('score.person', u, { personIds: [p] });
  await drain(t, handlers, () => new Date(now));
  const [s] = await t.db.sql<{ score: number }>`
    select score from orbit.tie_scores where user_id = ${u}::uuid and person_id = ${p}::uuid`;
  return s!.score;
}

const tieRows = (u: string) =>
  t.db.sql<Record<string, unknown>>`select * from orbit.ties where user_id = ${u}::uuid`;

describe('ties (§2.8)', () => {
  it('2: same_city alone is not routable; email_cc alone is', async () => {
    const u = await connectedUser(t.db);
    const a = await addPerson(u, 'Ann Able', { location: 'New York, NY' });
    const b = await addPerson(u, 'Bo Baker', { location: 'new york' });
    const c = await addPerson(u, 'Cy Cole');
    const d = await addPerson(u, 'Di Dunn');
    // Cy wrote to the user with Di on Cc
    await addThread(u, NOW, [{ dir: 'in', from: c, to: [], cc: [d], daysAgo: 3 }]);
    await job('score.user', u);
    await drain(t, handlers, () => new Date(NOW));
    const rows = await tieRows(u);
    const kinds = rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(['email_cc', 'same_city']);
    const city = rows.find((r) => r.kind === 'same_city')!;
    expect(new Set([city.a_person_id, city.b_person_id])).toEqual(new Set([a.id, b.id]));
    expect(city).toMatchObject({ weight: expect.closeTo(0.05, 5), confidence: expect.closeTo(0.1, 5) });
    const edges = rows.map((r) =>
      edgeFromTieRow({
        ...r,
        first_seen_at: new Date(r.first_seen_at as Date).toISOString(),
        last_seen_at: new Date(r.last_seen_at as Date).toISOString(),
      } as unknown as Row.Ties),
    );
    const pairs = pairsFromEdges(edges);
    const key = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
    expect(isRoutable(pairs.get(key(a.id, b.id))!)).toBe(false);
    expect(isRoutable(pairs.get(key(c.id, d.id))!)).toBe(true);
  });

  it('3: an exchange four years old weighs at most a quarter of a fresh one', async () => {
    const u = await connectedUser(t.db);
    const [a, b, c, d] = await Promise.all(
      ['Al One', 'Bea Two', 'Cal Three', 'Dee Four'].map((n) => addPerson(u, n)),
    );
    await addThread(u, NOW, [
      { dir: 'in', from: a!, to: [b!], daysAgo: 4 * 366 + 5 },
      { dir: 'in', from: b!, to: [a!], daysAgo: 4 * 366 + 4 },
    ]);
    await addThread(u, NOW, [
      { dir: 'in', from: c!, to: [d!], daysAgo: 2 },
      { dir: 'in', from: d!, to: [c!], daysAgo: 1 },
    ]);
    await job('score.user', u);
    await drain(t, handlers, () => new Date(NOW));
    const rows = (await tieRows(u)).filter((r) => r.kind === 'email_exchange');
    expect(rows).toHaveLength(2);
    const old = rows.find((r) => [r.a_person_id, r.b_person_id].includes(a!.id))!;
    const fresh = rows.find((r) => [r.a_person_id, r.b_person_id].includes(c!.id))!;
    expect(Number(fresh.confidence)).toBeCloseTo(0.95, 5);
    expect(Number(old.weight)).toBeLessThanOrEqual(0.25 * Number(fresh.weight));
  });

  it('the nightly rebuild drops rows whose evidence is gone and leaves mutual and Village rows alone', async () => {
    const u = await connectedUser(t.db);
    const a = await addPerson(u, 'Eve Five', { location: 'Boston, MA' });
    const b = await addPerson(u, 'Fay Six', { location: 'Boston' });
    const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    await t.db.sql`insert into orbit.ties (user_id, a_person_id, b_person_id, kind, weight, confidence)
      values (${u}::uuid, ${x}::uuid, ${y}::uuid, 'linkedin_mutual', 0.3, 0.95),
             (${u}::uuid, ${x}::uuid, ${y}::uuid, 'email_cc', 0.5, 0.85)`;
    await job('score.user', u);
    await drain(t, handlers, () => new Date(NOW));
    const kinds = (await tieRows(u)).map((r) => r.kind).sort();
    expect(kinds).toEqual(['linkedin_mutual', 'same_city']);
  });
});

describe('tie scores through score.person (§3.8)', () => {
  it('A9: an inbound reply never lowers a score; 30 more days of silence never raise it', async () => {
    const u = await connectedUser(t.db);
    const p = await addPerson(u, 'Gil Seven');
    const th = await addThread(u, NOW, [{ dir: 'out', to: [p], daysAgo: 20 }]);
    const s1 = await score(u, p.id, NOW);
    expect(s1).toBeLessThanOrEqual(20);
    await t.db.sql`
      insert into orbit.messages (user_id, thread_id, provider, external_id, direction, from_person_id, from_addr,
                                  sent_at, body_text)
      values (${u}::uuid, ${th}::uuid, 'gmail', 'reply-a9', 'in', ${p.id}::uuid, ${p.email},
              ${at(NOW, 18)}::timestamptz, 'Happy to help!')`;
    const s2 = await score(u, p.id, NOW);
    expect(s2).toBeGreaterThanOrEqual(s1);
    const s3 = await score(u, p.id, NOW + 30 * DAY);
    expect(s3).toBeLessThanOrEqual(s2);
    const [row] = await t.db.sql<{
      band: string;
      explanation: string[];
      model_version: string;
      strength: number;
      last: Date;
    }>`
      select s.band, s.explanation, s.model_version, p.strength, p.last_interaction_at as last
        from orbit.tie_scores s join orbit.people p on p.id = s.person_id where s.person_id = ${p.id}::uuid`;
    expect(row!.model_version).toBe('tie-v1');
    expect(row!.explanation.length).toBeGreaterThan(0);
    expect(row!.strength).toBeCloseTo(s3 / 100, 2);
    expect(new Date(row!.last).toISOString()).toBe(at(NOW, 18));
  });

  it('automated mail and 12-person threads add nothing to a score', async () => {
    const u = await connectedUser(t.db);
    const p = await addPerson(u, 'Hal Eight');
    const base = await score(u, p.id, NOW);
    const others = await Promise.all(Array.from({ length: 11 }, (_, i) => addPerson(u, `Crowd ${i}x`)));
    await addThread(u, NOW, [
      { dir: 'in', from: p, to: others, daysAgo: 5 },
      { dir: 'out', to: [p, ...others], daysAgo: 4 },
    ]);
    const th = await addThread(u, NOW, [{ dir: 'in', from: p, daysAgo: 3 }]);
    await t.db.sql`update orbit.messages set is_automated = true where thread_id = ${th}::uuid`;
    expect(await score(u, p.id, NOW)).toBe(base);
  });

  it('a labelled person shows the band midpoint; family is floored at 80; an introducer gains', async () => {
    const u = await connectedUser(t.db);
    const p = await addPerson(u, 'Ida Nine');
    await t.db
      .sql`insert into orbit.tie_labels (user_id, person_id, closeness) values (${u}::uuid, ${p.id}::uuid, 4)`;
    expect(await score(u, p.id, NOW)).toBe(70);
    const mom = await addPerson(u, 'Jan Ten', { relationship: 'family' });
    expect(await score(u, mom.id, NOW)).toBeGreaterThanOrEqual(80);
    const lena = await addPerson(u, 'Kit Eleven');
    const before = await score(u, lena.id, NOW);
    const sam = await addPerson(u, 'Lou Twelve');
    const [x, y] = lena.id < sam.id ? [lena.id, sam.id] : [sam.id, lena.id];
    await t.db
      .sql`insert into orbit.ties (user_id, a_person_id, b_person_id, kind, weight, confidence, evidence)
      values (${u}::uuid, ${x}::uuid, ${y}::uuid, 'introduced_by', 0.85, 0.95,
              ${{ introducerId: lena.id }}::jsonb)`;
    expect(await score(u, lena.id, NOW)).toBeGreaterThan(before);
  });

  it('A10 through score.user: 8 "very close" labels refit the calibration and lift similar people', async () => {
    const u = await connectedUser(t.db);
    const people = await Promise.all(Array.from({ length: 9 }, (_, i) => addPerson(u, `Pal ${i}z`)));
    for (const p of people)
      await addThread(u, NOW, [
        { dir: 'out', to: [p], daysAgo: 40 },
        { dir: 'in', from: p, daysAgo: 39 },
      ]);
    const unlabelled = people[8]!;
    const before = await score(u, unlabelled.id, NOW);
    for (const p of people.slice(0, 8))
      await t.db.sql`insert into orbit.tie_labels (user_id, person_id, closeness, updated_at)
        values (${u}::uuid, ${p.id}::uuid, 5, ${at(NOW, 1)}::timestamptz)`;
    await job('score.user', u);
    await drain(t, handlers, () => new Date(NOW));
    const [usr] = await t.db.sql<{ settings: { tie_calibration?: { a: number; c: number; n: number } } }>`
      select settings from orbit.users where id = ${u}::uuid`;
    expect(usr!.settings.tie_calibration).toMatchObject({ n: 8 });
    const [after] = await t.db.sql<{ score: number }>`
      select score from orbit.tie_scores where person_id = ${unlabelled.id}::uuid`;
    expect(after!.score).toBeGreaterThan(before);
    expect(after!.score).toBeGreaterThan(75);
  });
});
