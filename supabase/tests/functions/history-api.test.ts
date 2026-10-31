/** POST /people/history: a person's whole story for their page, past the pull's networking and 180-day filters. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryTake } from '../../functions/_shared/ratelimit.ts';
import { createSession } from '../../functions/_shared/session.ts';
import { makeApiHandler } from '../../functions/orbit-api/api.ts';
import { upsertGoogleUser } from '../../functions/orbit-api/auth.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

const BASE = 'https://ref.supabase.co/functions/v1/orbit-api';
const SECRET = 'c2Vzc2lvbi1zZWNyZXQtcGxhY2Vob2xkZXItMzItYnl0ZXMhIQ==';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

async function signedIn() {
  const sub = `s-${Math.random()}`;
  const userId = (await upsertGoogleUser(t.db, {
    sub,
    email: `${sub}@example.com`,
    name: 'Test User',
    scopes: [],
    refreshToken: 'refresh-placeholder',
  }))!;
  const tokens = await createSession(t.db, { secret: SECRET }, userId);
  return { userId, token: tokens.accessToken };
}

const post = (token: string, body: unknown) =>
  new Request(`${BASE}/people/history`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('/people/history', () => {
  it('returns every thread with them, whatever its category or age, its messages and their meetings, as the pull shapes them', async () => {
    const { userId, token } = await signedIn();
    const handler = makeApiHandler({ env: { sessionSecret: SECRET }, db: t.db, take: memoryTake() });
    const [eric] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm, strength, primary_email)
      values (${userId}::uuid, 'Eric Cheng', 'eric cheng', 0.4, 'eric@jobright.ai') returning id`;
    const [other] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm, strength) values (${userId}::uuid, 'Bo', 'bo', 0.1) returning id`;
    const thread = async (cat: string, networking: boolean, lastAt: string, who: string) =>
      (
        await t.db.sql<{ id: string }>`
          insert into orbit.threads (user_id, provider, external_id, subject, participant_person_ids, participant_count,
                                     first_at, last_at, message_count, category, is_networking)
          values (${userId}::uuid, 'gmail', ${`x-${Math.random()}`}, ${`About ${cat}`}, ${[who]}::uuid[], 1,
                  ${lastAt}::timestamptz, ${lastAt}::timestamptz, 1, ${cat}, ${networking}) returning id`
      )[0]!.id;
    const recruiting = await thread('recruiting_process', false, '2025-01-10T10:00:00Z', eric!.id);
    const networking = await thread('networking', true, '2026-10-01T10:00:00Z', eric!.id);
    await thread('networking', true, '2026-10-02T10:00:00Z', other!.id);
    for (const [threadId, dir, at] of [
      [recruiting, 'in', '2025-01-10T10:00:00Z'],
      [networking, 'out', '2026-10-01T10:00:00Z'],
    ] as const)
      await t.db.sql`
        insert into orbit.messages (user_id, thread_id, provider, external_id, direction, from_addr, to_addrs,
                                    from_person_id, to_person_ids, sent_at, subject, body_text)
        values (${userId}::uuid, ${threadId}::uuid, 'gmail', ${`m-${Math.random()}`}, ${dir},
                ${dir === 'in' ? 'eric@jobright.ai' : 'me@example.com'},
                ${dir === 'in' ? ['me@example.com'] : ['eric@jobright.ai']}::text[],
                ${dir === 'in' ? eric!.id : null}::uuid, ${dir === 'out' ? [eric!.id] : []}::uuid[],
                ${at}::timestamptz, 'Hello', 'Hi Eric')`;
    await t.db.sql`
      insert into orbit.calendar_events (user_id, external_id, title, start_at, end_at, attendees, attendee_person_ids)
      values (${userId}::uuid, 'ev-1', 'Coffee with Eric', '2026-09-01T16:00:00Z', '2026-09-01T16:30:00Z', '[]'::jsonb,
              ${[eric!.id]}::uuid[])`;
    const r = await handler(post(token, { personId: eric!.id }));
    expect(r.status).toBe(200);
    const h = (await r.json()) as {
      threads: Record<string, unknown>[];
      messages: Record<string, unknown>[];
      events: Record<string, unknown>[];
    };
    // both of his threads, the newest first, never someone else's
    expect(h.threads.map((x) => x.id)).toEqual([networking, recruiting]);
    expect(h.threads[1]).toMatchObject({ category: 'recruiting_process', lastMessageAt: expect.any(String) });
    expect(h.messages).toHaveLength(2);
    expect(h.messages.map((m) => m.direction).sort()).toEqual(['inbound', 'outbound']);
    expect(h.messages[0]).not.toHaveProperty('embedding');
    expect(h.events).toEqual([
      expect.objectContaining({ title: 'Coffee with Eric', externalEventId: 'ev-1' }),
    ]);
  });

  it('answers only for the signed-in student’s own people', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const handler = makeApiHandler({ env: { sessionSecret: SECRET }, db: t.db, take: memoryTake() });
    const [theirs] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm, strength) values (${b.userId}::uuid, 'Zed', 'zed', 0.1) returning id`;
    expect((await handler(post(a.token, { personId: theirs!.id }))).status).toBe(404);
    expect((await handler(post(a.token, {}))).status).toBe(400);
  });
});
