/**
 * The voice on the server (plan 29 §B2.4, §B7): the style card through /settings/profile, the student's sent mail
 * embedded as it is ingested and on demand, so the drafts' exemplars are real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exemplars } from '../../functions/_shared/compose/context.ts';
import { defaultHandlers } from '../../functions/orbit-worker/worker.ts';
import { agentConfig, api, fakeEmbed, fakeNet, signedInUser } from '../helpers/agents.ts';
import { FakeGoogle, virtualTime } from '../helpers/fakeApis.ts';
import { clearQueues, connectedUser, drain, fakeTokens } from '../helpers/ingest.ts';
import { fixtureMailbox, NOW } from '../helpers/mailFixtures.ts';
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

const CARD = {
  greetingPatterns: ['Hi {first},'],
  signoffs: ['Thanks,\nMaya'],
  formality: 0.4,
  avgSentenceWords: 12,
  avgMessageWords: 60,
  contractions: true,
  exclamationsPerMessage: 0,
  emoji: false,
  characteristicPhrases: ['quick question about'],
  avoid: ['circle back'],
  notes: '',
  builtFromCount: 14,
  version: 2,
  sources: { email: 14 },
};

describe('the style card through /settings/profile', () => {
  it('keeps a card of the right shape, refuses a malformed one and removes it on null', async () => {
    const net = fakeNet();
    const call = api(t, net);
    const { userId, token } = await signedInUser(t);
    const ok = await call('/settings/profile', token, { styleCard: CARD });
    expect(ok.status).toBe(200);
    const [u] = await t.db.sql<{ settings: Record<string, unknown> }>`
      select settings from orbit.users where id = ${userId}::uuid`;
    expect(u!.settings.style_card).toEqual(CARD);
    const bad = await call('/settings/profile', token, { styleCard: { ...CARD, avoid: 'circle back' } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('styleCard.avoid');
    const gone = await call('/settings/profile', token, { styleCard: null });
    expect(gone.status).toBe(200);
    const [after] = await t.db.sql<{ settings: Record<string, unknown> }>`
      select settings from orbit.users where id = ${userId}::uuid`;
    expect(after!.settings.style_card).toBeUndefined();
  });
});

describe('sent mail into embeddings', () => {
  it('embeds the student’s own sent mail as Gmail is ingested, and exemplars() finds it', async () => {
    const u = await connectedUser(t.db, { email: 'maya@example.com' });
    const time = virtualTime(NOW);
    const google = new FakeGoogle(time, 'maya@example.com');
    google.add(...fixtureMailbox());
    const handlers = defaultHandlers({
      google: fakeTokens(),
      fetch: google.fetch,
      clock: time.clock,
      sleep: time.sleep,
      random: () => 0,
      embed: fakeEmbed,
    });
    await t.db.sql`select orbit.enqueue('orbit_sync', ${{
      kind: 'sync.gmail.backfill',
      userId: u,
      payload: { phase: 'recent' },
      dedupeKey: `gmail-backfill:${u}:recent`,
    }}::jsonb, 0)`;
    await drain(t, handlers, time.now);
    const rows = await t.db.sql<{ direction: string; n: number }>`
      select direction, count(*)::int as n from orbit.messages
       where user_id = ${u}::uuid and embedding is not null group by direction`;
    expect(rows.find((r) => r.direction === 'out')?.n ?? 0).toBeGreaterThan(0);
    expect(rows.find((r) => r.direction === 'in')).toBeUndefined();
    const [someone] = await t.db.sql<{ id: string }>`
      select id from orbit.people where user_id = ${u}::uuid and not is_self and display_name <> 'Priya Patel' limit 1`;
    const ex = await exemplars(
      { db: t.db, embed: fakeEmbed },
      u,
      someone!.id,
      'coffee chat product design call',
    );
    expect(ex.length).toBeGreaterThan(0);
    expect(ex[0]).toMatch(/\[name\]|design/);
  });

  it('voice.embed_sent embeds the newest sent mail that has none, and a missing model changes nothing', async () => {
    const u = await connectedUser(t.db);
    const [th] = await t.db.sql<{ id: string }>`
      insert into orbit.threads (user_id, provider, external_id, subject) values (${u}::uuid, 'gmail', 'T-1', 's')
      returning id`;
    const body =
      'Hi Leo,\n\nI am a junior at State and I read your post about the payments team with real interest. Would you have twenty minutes next week to tell me how you got there and what you look for?\n\nThanks,\nMaya';
    for (let i = 0; i < 3; i++)
      await t.db.sql`
        insert into orbit.messages (user_id, thread_id, provider, external_id, direction, sent_at, body_text)
        values (${u}::uuid, ${th!.id}::uuid, 'gmail', ${`x-${i}`}, 'out', now() - ${`${i} days`}::interval, ${body})`;
    const none = defaultHandlers({ env: {}, embed: async () => null });
    await t.db
      .sql`select orbit.enqueue('orbit_enrich', ${{ kind: 'voice.embed_sent', userId: u, payload: {} }}::jsonb, 0)`;
    await drain(t, none, () => new Date(NOW));
    const before = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.messages where user_id = ${u}::uuid and embedding is not null`;
    expect(before[0]!.n).toBe(0);
    const handlers = defaultHandlers(agentConfig(fakeNet()));
    await t.db
      .sql`select orbit.enqueue('orbit_enrich', ${{ kind: 'voice.embed_sent', userId: u, payload: {} }}::jsonb, 0)`;
    await drain(t, handlers, () => new Date(NOW));
    const after = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.messages where user_id = ${u}::uuid and embedding is not null`;
    expect(after[0]!.n).toBe(3);
  });
});
