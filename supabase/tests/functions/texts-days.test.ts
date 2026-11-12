/**
 * Plan 43 §6, texts for a signed-in student: POST /texts/days takes counts per person and local day, never words;
 * makes a text-only friend from a name and numbers (matched by phone first), upserts the days, needs the Texts source
 * on, and queues a rescore. Closeness moves only while Texts is on. /sync/push takes numbers on a person too.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sqlQueue } from '../../functions/_shared/queue.ts';
import { memoryTake } from '../../functions/_shared/ratelimit.ts';
import { createSession } from '../../functions/_shared/session.ts';
import { switchSource } from '../../functions/_shared/sources/switch.ts';
import { makeApiHandler } from '../../functions/orbit-api/api.ts';
import { defaultHandlers } from '../../functions/orbit-worker/worker.ts';
import { ALL_KEYS, APP, agentConfig, BASE, fakeNet, SECRET } from '../helpers/agents.ts';
import { clearQueues, drain } from '../helpers/ingest.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';
import { NOW, type Optional, seedStudent } from '../helpers/sourcesFixture.ts';

const ALL: Optional[] = ['instagram', 'x', 'imessage'];
const handlers = defaultHandlers({ offered: ALL });

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

function client(offered: Optional[]) {
  const net = fakeNet();
  const handler = makeApiHandler({
    env: {
      googleClientId: 'client-id-placeholder.apps.googleusercontent.com',
      googleClientSecret: 'client-secret-placeholder',
      googleRedirectUri: `${BASE}/auth/google/callback`,
      sessionSecret: SECRET,
      appUrl: APP,
      extraSources: offered,
    },
    db: t.db,
    fetch: net.fetch,
    take: memoryTake(),
    now: () => NOW,
    agent: agentConfig(net, ALL_KEYS),
  });
  return async <T = Record<string, unknown>>(path: string, token: string, body: unknown) => {
    const r = await handler(
      new Request(`${BASE}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return { status: r.status, body: (await r.json()) as T };
  };
}

const tokenFor = async (userId: string) =>
  (await createSession(t.db, { secret: SECRET }, userId)).accessToken;
const day = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);

async function student(state?: 'on' | 'off') {
  const s = await seedStudent(t, { base: true, rows: [], states: state ? { imessage: state } : {} });
  // numbers are read in the student's own country: Los Angeles is the US
  return { ...s, token: await tokenFor(s.userId) };
}

describe('POST /texts/days', () => {
  it('is not there while the owner does not offer texts, and needs Texts on', async () => {
    const s = await student('off');
    const body = { days: [{ personId: s.people.ana, day: day(1), in: 1, out: 1, group: 2, words: true }] };
    expect((await client([])('/texts/days', s.token, body)).status).toBe(404);
    const off = await client(ALL)('/texts/days', s.token, body);
    expect(off.status).toBe(409);
    expect(await t.db.sql`select 1 from orbit.text_days where user_id = ${s.userId}::uuid`).toHaveLength(0);
  });

  it('makes a text-only friend by phone, upserts the days and queues a rescore', async () => {
    const s = await student('on');
    const call = client(ALL);
    const r = await call<{ ok: boolean; days: number; people: Record<string, string>; created: number }>(
      '/texts/days',
      s.token,
      {
        people: [{ ref: 'c1', name: 'Tia Moss', phones: ['(555) 000-1111', '+1 555 000 1111'] }],
        days: [
          { ref: 'c1', day: day(2), in: 3, out: 4, group: 2, words: true },
          { ref: 'c1', day: day(9), in: 1, out: 0, group: 5, words: false },
          { personId: s.people.ana, day: day(1), in: 2, out: 2, group: 2, words: true },
        ],
      },
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, days: 3, created: 1 });
    const tia = r.body.people.c1!;
    const [p] = await t.db.sql<{ display_name: string; sources: string[]; listed: boolean }>`
      select display_name, sources, listed from orbit.people where id = ${tia}::uuid`;
    expect(p).toEqual({ display_name: 'Tia Moss', sources: ['imessage'], listed: true });
    const phones = await t.db.sql<{ value_norm: string; source: string }>`
      select value_norm, source from orbit.person_identities where person_id = ${tia}::uuid and kind = 'phone'`;
    expect(phones).toEqual([{ value_norm: '+15550001111', source: 'imessage' }]);
    const days = await t.db.sql<{ in_count: number; out_count: number; group_size: number; words: boolean }>`
      select in_count, out_count, group_size, words from orbit.text_days where person_id = ${tia}::uuid order by day`;
    expect(days).toEqual([
      { in_count: 1, out_count: 0, group_size: 5, words: false },
      { in_count: 3, out_count: 4, group_size: 2, words: true },
    ]);
    const [job] = await t.db.sql<{ message: { kind: string; payload: { personIds: string[] } } }>`
      select message from pgmq.q_orbit_score where message->>'userId' = ${s.userId} and message->>'kind' = 'score.person'`;
    expect(new Set(job!.message.payload.personIds)).toEqual(new Set([tia, s.people.ana]));

    // the same friend again, by another way of writing the number: matched, the day updated
    const again = await call<{ people: Record<string, string>; created: number }>('/texts/days', s.token, {
      people: [{ ref: 'z', name: 'T. Moss', phones: ['555-000-1111'] }],
      days: [{ ref: 'z', day: day(2), in: 5, out: 6, group: 2, words: true }],
    });
    expect(again.body).toMatchObject({ created: 0, people: { z: tia } });
    const [d2] = await t.db.sql<{ in_count: number; out_count: number }>`
      select in_count, out_count from orbit.text_days where person_id = ${tia}::uuid and day = ${day(2)}::date`;
    expect(d2).toEqual({ in_count: 5, out_count: 6 });
  });

  it('matches a person the student already has by their number', async () => {
    const s = await student('on');
    await t.db.sql`insert into orbit.person_identities (user_id, person_id, kind, value_norm, source)
                   values (${s.userId}::uuid, ${s.people.dev!}::uuid, 'phone', '+15550002222', 'contacts')`;
    const r = await client(ALL)<{ people: Record<string, string>; created: number }>('/texts/days', s.token, {
      people: [{ ref: 'd', name: 'Devendra', phones: ['5550002222'] }],
      days: [{ ref: 'd', day: day(3), in: 1, out: 1, group: 2, words: true }],
    });
    expect(r.body).toMatchObject({ created: 0, people: { d: s.people.dev } });
  });

  it('never takes words', async () => {
    const s = await student('on');
    const call = client(ALL);
    const ok = { personId: s.people.ana, day: day(1), in: 1, out: 1, group: 2, words: true };
    for (const body of [
      { days: [{ ...ok, text: 'see you at 7' }] },
      { days: [{ ...ok, words: 'see you at 7' }] },
      { days: [ok], messages: ['see you at 7'] },
      {
        days: [{ ...ok, ref: 'a', personId: undefined }],
        people: [{ ref: 'a', name: 'A', phones: ['5550003333'], body: 'hi' }],
      },
      { days: [{ ...ok, in: 'many' }] },
      { days: [{ ...ok, day: 'yesterday' }] },
    ]) {
      const r = await call('/texts/days', s.token, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(await t.db.sql`select 1 from orbit.text_days where user_id = ${s.userId}::uuid`).toHaveLength(0);
  });

  it('refuses a person who is not the student’s', async () => {
    const s = await student('on');
    const other = await student('on');
    const r = await client(ALL)('/texts/days', s.token, {
      days: [{ personId: other.people.ana, day: day(1), in: 1, out: 1, group: 2, words: true }],
    });
    expect(r.status).toBe(404);
  });

  it('moves closeness only while Texts is on', async () => {
    const s = await student('on');
    const score = async () => {
      const [r] = await t.db.sql<{ score: number }>`
        select score from orbit.tie_scores where user_id = ${s.userId}::uuid and person_id = ${s.people.dev!}::uuid`;
      return r?.score ?? null;
    };
    // Dev wrote once and was never answered: a faint tie from mail
    await sqlQueue(t.db).enqueue({
      kind: 'score.person',
      userId: s.userId,
      payload: { personIds: [s.people.dev!] },
    });
    await drain(t, handlers, () => NOW);
    const before = await score();
    const days = Array.from({ length: 12 }, (_, i) => ({
      personId: s.people.dev,
      day: day(1 + i * 3),
      in: 2,
      out: 3,
      group: 2,
      words: true,
    }));
    expect((await client(ALL)('/texts/days', s.token, { days })).status).toBe(200);
    await drain(t, handlers, () => NOW);
    const on = await score();
    expect(on!).toBeGreaterThan(before!);
    // off: the texts count for nothing, and the score is what it was
    await switchSource(t.db, sqlQueue(t.db), s.userId, 'imessage', { state: 'off' }, NOW);
    await drain(t, handlers, () => NOW);
    expect(await score()).toBe(before);
  });
});

describe('/sync/push with phones', () => {
  it('stores a pushed person’s numbers as phone identities', async () => {
    const s = await student();
    const id = crypto.randomUUID();
    const r = await client([])<{ results: { ok: boolean }[] }>('/sync/push', s.token, {
      changes: [
        { table: 'people', op: 'upsert', id, row: { displayName: 'Rae Kim', phones: ['(555) 000-4444'] } },
      ],
    });
    expect(r.body.results[0]?.ok).toBe(true);
    const ids = await t.db.sql<{ value_norm: string }>`
      select value_norm from orbit.person_identities where person_id = ${id}::uuid and kind = 'phone'`;
    expect(ids).toEqual([{ value_norm: '+15550004444' }]);
    const bad = await client([])<{ results: { ok: boolean }[] }>('/sync/push', s.token, {
      changes: [{ table: 'people', op: 'upsert', id, row: { phones: 'not a list' } }],
    });
    expect(bad.body.results[0]?.ok).toBe(false);
  });
});
