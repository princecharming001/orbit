/**
 * Marketers set aside. Someone who only ever wrote to sell the student something, and was never answered, is hidden
 * like a person hidden by hand, with the reason kept. Anyone the student has had anything to do with is never
 * looked at, anyone the student brings back stays, and turning the setting off brings everyone back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bringMarketersBack, setAsideMarketers } from '../../functions/_shared/ingest/marketers.ts';
import { addPerson, api, fakeNet, signedInUser } from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const NOW = new Date('2026-11-24T12:00:00Z');
const PITCH =
  'Hi, thanks for connecting. We help SaaS founders book 20+ qualified meetings a month. Worth a quick chat this week?';
let n = 0;

/** A message from (or to) someone, on a thread of its own. */
async function message(
  userId: string,
  personId: string,
  body: string,
  o: { out?: boolean; provider?: 'gmail' | 'linkedin'; unsubscribe?: boolean } = {},
) {
  n++;
  const provider = o.provider ?? 'linkedin';
  const [th] = await t.db.sql<{ id: string }>`
    insert into orbit.threads (user_id, provider, external_id, participant_person_ids, participant_count,
                               first_at, last_at, message_count, last_direction)
    values (${userId}::uuid, ${provider}, ${`th-${n}`}, ${[personId]}::uuid[], 1, ${NOW}::timestamptz,
            ${NOW}::timestamptz, 1, ${o.out ? 'out' : 'in'})
    returning id`;
  await t.db.sql`
    insert into orbit.messages (user_id, thread_id, provider, external_id, direction, from_person_id, to_person_ids,
                                sent_at, body_text, list_unsubscribe)
    values (${userId}::uuid, ${th!.id}::uuid, ${provider}, ${`m-${n}`}, ${o.out ? 'out' : 'in'},
            ${o.out ? null : personId}::uuid, ${o.out ? [personId] : []}::uuid[], ${NOW}::timestamptz, ${body},
            ${o.unsubscribe ?? false})`;
}
const hidden = async (userId: string) =>
  (
    await t.db.sql<{ display_name: string; hidden_reason: string | null }>`
      select display_name, hidden_reason from orbit.people
       where user_id = ${userId}::uuid and hidden_at is not null order by display_name`
  ).map((r) => `${r.display_name}:${r.hidden_reason}`);

describe('who is set aside', () => {
  it('only people who pitched and were never answered; anyone the student dealt with is left alone', async () => {
    const { userId } = await signedInUser(t, { firstName: 'Ana' });
    const seller = await addPerson(t, userId, { name: 'Grow Fast' });
    await message(userId, seller, PITCH);
    const blast = await addPerson(t, userId, { name: 'News Letter', email: 'news@tooling.io' });
    await message(userId, blast, 'Our November product update is here.', {
      provider: 'gmail',
      unsubscribe: true,
    });
    // pitched, but the student answered: a conversation, not a marketer
    const answered = await addPerson(t, userId, { name: 'Answered Pitch' });
    await message(userId, answered, PITCH);
    await message(userId, answered, 'Thanks, send me more.', { out: true });
    // pitched, but the student put them on the pipeline
    const tracked = await addPerson(t, userId, { name: 'Tracked Pitch' });
    await message(userId, tracked, PITCH);
    await t.db.sql`
      insert into orbit.chats (user_id, person_id, stage, stage_entered_at) values (${userId}::uuid, ${tracked}::uuid, 'identified', now())`;
    // pitched, but the student tagged them
    const tagged = await addPerson(t, userId, { name: 'Tagged Pitch' });
    await message(userId, tagged, PITCH);
    await t.db.sql`update orbit.people set tags = ${['vendor']}::text[] where id = ${tagged}::uuid`;
    // a real person asking for a call, never answered yet
    const real = await addPerson(t, userId, { name: 'Real Ask' });
    await message(
      userId,
      real,
      'Hey, loved your demo day pitch. Do you have 15 minutes for a quick call next week?',
    );
    // someone who never wrote at all
    await addPerson(t, userId, { name: 'Quiet Connection' });

    const out = await setAsideMarketers(t.db, userId, NOW);
    expect(out).toEqual({ looked: 3, setAside: 2 });
    expect(await hidden(userId)).toEqual(['Grow Fast:marketer', 'News Letter:marketer']);
    // a second look changes nothing
    expect(await setAsideMarketers(t.db, userId, NOW)).toEqual({ looked: 1, setAside: 0 });
  });

  it('someone the student brings back is never set aside again', async () => {
    const { userId } = await signedInUser(t, { firstName: 'Ben' });
    const seller = await addPerson(t, userId, { name: 'Actually Useful' });
    await message(userId, seller, PITCH);
    await setAsideMarketers(t.db, userId, NOW);
    expect(await hidden(userId)).toEqual(['Actually Useful:marketer']);
    // the student unhides them (the browser pushes hidden_at = null)
    await t.db.sql`update orbit.people set hidden_at = null where id = ${seller}::uuid`;
    await message(userId, seller, PITCH);
    expect(await setAsideMarketers(t.db, userId, NOW)).toEqual({ looked: 0, setAside: 0 });
    expect(await hidden(userId)).toEqual([]);
    const [p] = await t.db.sql<{ hidden_reason: string | null }>`
      select hidden_reason from orbit.people where id = ${seller}::uuid`;
    expect(p!.hidden_reason).toBe('kept');
  });

  it('someone the student hid by hand is theirs to bring back, not the setting’s', async () => {
    const { userId } = await signedInUser(t, { firstName: 'Cal' });
    const mine = await addPerson(t, userId, { name: 'Hidden By Hand' });
    await t.db.sql`update orbit.people set hidden_at = now() where id = ${mine}::uuid`;
    const seller = await addPerson(t, userId, { name: 'Grow Fast' });
    await message(userId, seller, PITCH);
    await setAsideMarketers(t.db, userId, NOW);
    expect(await bringMarketersBack(t.db, userId)).toBe(1);
    expect(await hidden(userId)).toEqual(['Hidden By Hand:null']);
  });
});

describe('the setting', () => {
  it('off brings everyone Orbit set aside back and stops looking; on looks at once', async () => {
    const call = api(t, fakeNet(), { env: {} });
    const me = await signedInUser(t, { firstName: 'Dee' });
    const seller = await addPerson(t, me.userId, { name: 'Grow Fast' });
    await message(me.userId, seller, PITCH);
    await setAsideMarketers(t.db, me.userId, NOW);
    expect(await hidden(me.userId)).toEqual(['Grow Fast:marketer']);

    const off = await call('/settings/profile', me.token, { hideMarketers: false });
    expect(off.status).toBe(200);
    expect(await hidden(me.userId)).toEqual([]);
    const [u] = await t.db.sql<{ settings: Record<string, unknown> }>`
      select settings from orbit.users where id = ${me.userId}::uuid`;
    expect(u!.settings.hide_marketers).toBe(false);
    // off: nobody is looked at
    expect(await setAsideMarketers(t.db, me.userId, NOW)).toEqual({ looked: 0, setAside: 0 });

    const on = await call('/settings/profile', me.token, { hideMarketers: true });
    expect(on.status).toBe(200);
    expect(await hidden(me.userId)).toEqual(['Grow Fast:marketer']);
    const bad = await call('/settings/profile', me.token, { hideMarketers: 'yes' });
    expect(bad.status).toBe(400);
  });
});
