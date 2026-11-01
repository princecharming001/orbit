/**
 * The voice on the server (plan 29 §B2.4, §B7): the style card through /settings/profile, the student's sent mail
 * embedded as it is ingested and on demand, so the drafts' exemplars are real; every edit kept as a typed row,
 * whether it came with the approval, through /sync/push on the draft, or as the browser's own record.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exemplars, styleCardOf, loadUserRow } from '../../functions/_shared/compose/context.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import { distillVoice } from '../../functions/_shared/voice/voice.ts';
import { defaultHandlers } from '../../functions/orbit-worker/worker.ts';
import {
  addPerson,
  agentConfig,
  anthropic,
  api,
  fakeEmbed,
  fakeNet,
  signedInUser,
  userText,
} from '../helpers/agents.ts';
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

const ORBIT_WROTE =
  "Hi Dana,\n\nI'm a junior at State and would love to hear how you got to Stripe. Would you be open to a quick call next week? Thanks either way.\n\nBest,\nSam";
const SAM_SENT =
  "Hi Dana,\n\nI'm a junior at State and would love to hear how you got to Stripe. Would you be open to a call next week?\n\nThanks,\nSam";

async function aDraft(userId: string, personId: string, body = ORBIT_WROTE) {
  const [d] = await t.db.sql<{ id: string; body_original: string }>`
    insert into orbit.drafts (user_id, person_id, channel, kind, subject, body, status)
    values (${userId}::uuid, ${personId}::uuid, 'gmail', 'first_touch', 'Stripe', ${body}, 'draft')
    returning id, body_original`;
  return d!;
}

const editsOf = (userId: string) =>
  t.db.sql<{
    id: string;
    draft_id: string | null;
    kind: string;
    before: string;
    after: string;
    distance: number;
  }>`
    select id, draft_id, kind, before, after, distance from orbit.draft_edits where user_id = ${userId}::uuid
     order by created_at`;

describe('edits, typed, whichever way they arrive', () => {
  it('a draft keeps the words Orbit wrote, and an approve with edited words writes one draft_edits row', async () => {
    const net = fakeNet();
    const call = api(t, net);
    const { userId, token } = await signedInUser(t);
    const p = await addPerson(t, userId, { name: 'Dana Ruiz', email: 'dana@example.com' });
    const d = await aDraft(userId, p);
    expect(d.body_original).toBe(ORBIT_WROTE);
    const later = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const r = await call<{ draft: { body: string; status: string } }>('/drafts/approve', token, {
      draftId: d.id,
      body: SAM_SENT,
      sendAt: later,
    });
    expect(r.status).toBe(200);
    expect(r.body.draft.body).toBe(SAM_SENT);
    const edits = await editsOf(userId);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      draft_id: d.id,
      kind: 'first_touch',
      before: ORBIT_WROTE,
      after: SAM_SENT,
    });
    expect(edits[0]!.distance).toBeGreaterThan(3);
    // approving again, unchanged, writes nothing new
    await call('/drafts/approve', token, { draftId: d.id, sendAt: later });
    expect(await editsOf(userId)).toHaveLength(1);
  });

  it('an approve of the words as written records nothing', async () => {
    const call = api(t, fakeNet());
    const { userId, token } = await signedInUser(t);
    const p = await addPerson(t, userId, { name: 'Lee Park', email: 'lee@example.com' });
    const d = await aDraft(userId, p);
    await call('/drafts/approve', token, {
      draftId: d.id,
      sendAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(await editsOf(userId)).toHaveLength(0);
  });

  it('an edit pushed on the draft is one row, and the browser’s own record folds into it', async () => {
    const call = api(t, fakeNet());
    const { userId, token } = await signedInUser(t);
    const p = await addPerson(t, userId, { name: 'Ana Cole', email: 'ana@example.com' });
    const d = await aDraft(userId, p);
    const push = await call<{ results: { ok: boolean }[] }>('/sync/push', token, {
      changes: [{ table: 'drafts', op: 'upsert', id: d.id, row: { body: SAM_SENT } }],
    });
    expect(push.body.results[0]!.ok).toBe(true);
    expect(await editsOf(userId)).toHaveLength(1);
    const again = `${SAM_SENT}\n`;
    const own = crypto.randomUUID();
    const r = await call<{ results: { ok: boolean }[] }>('/sync/push', token, {
      changes: [
        {
          table: 'draft_edits',
          op: 'upsert',
          id: own,
          row: { draftId: d.id, kind: 'first_touch', before: ORBIT_WROTE, after: again, distance: 6 },
        },
        // an edit to a draft only that browser had: kept, with no draft named
        {
          table: 'draft_edits',
          op: 'upsert',
          id: crypto.randomUUID(),
          row: {
            draftId: crypto.randomUUID(),
            kind: 'bump',
            before: 'Just bumping this.',
            after: 'Bumping this.',
            distance: 1,
          },
        },
        {
          table: 'draft_edits',
          op: 'upsert',
          id: crypto.randomUUID(),
          row: { kind: 'bump', before: '', after: 'x', distance: 1 },
        },
      ],
    });
    expect(r.body.results.map((x) => x.ok)).toEqual([true, true, false]);
    const edits = await editsOf(userId);
    expect(edits).toHaveLength(2);
    expect(edits.find((e) => e.draft_id === d.id)!.after).toBe(again);
    expect(edits.find((e) => e.kind === 'bump')!.draft_id).toBeNull();
  });

  it('a user’s edits go with the account', async () => {
    const { userId } = await signedInUser(t);
    await t.db.sql`
      insert into orbit.draft_edits (user_id, kind, before, after, distance) values (${userId}::uuid, 'bump', 'a b', 'a', 1)`;
    await t.db.sql`select orbit.delete_user(${userId}::uuid)`;
    expect(await editsOf(userId)).toHaveLength(0);
  });
});

async function someEdits(userId: string, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const [r] = await t.db.sql<{ id: string }>`
      insert into orbit.draft_edits (user_id, kind, before, after, distance, created_at)
      values (${userId}::uuid, 'first_touch', ${`${ORBIT_WROTE} ${i}`}, ${`${SAM_SENT} ${i}`}, 6,
              now() - ${`${i} hours`}::interval)
      returning id`;
    ids.push(r!.id);
  }
  return ids;
}

const settingsOf = async (userId: string) =>
  (await t.db.sql<{ settings: Record<string, unknown> }>`select settings from orbit.users where id = ${userId}::uuid`)[0]!
    .settings;

describe('notes learned from the edits', () => {
  it('voice.distill keeps at most eight, each backed by real edits, and never learns a forgotten one again', async () => {
    const { userId } = await signedInUser(t, {
      settings: {
        voice_notes: [
          {
            id: 'vn_gone',
            text: "You cut 'Thanks either way' every time",
            avoid: 'Thanks either way',
            evidence: [],
            createdAt: '2026-10-01T00:00:00.000Z',
            keptAt: null,
            forgottenAt: '2026-10-20T00:00:00.000Z',
          },
        ],
      },
    });
    const ids = await someEdits(userId, 5);
    const net = fakeNet();
    const claude = anthropic(() => ({
      notes: [
        // the forgotten note, reworded: never back
        { text: 'You cut "thanks either way" every time.', avoid: 'Thanks either way', evidence: [ids[0], ids[1]] },
        ...Array.from({ length: 11 }, (_, i) => ({
          text: `You keep rule ${i} in mind`,
          avoid: '',
          evidence: [ids[i % 5], ids[(i + 1) % 5]],
        })),
        // evidence Claude made up: dropped
        { text: 'You always mention the weather', avoid: '', evidence: ['not-an-edit'] },
      ],
    }));
    net.use(claude.answer);
    const s = makeServices(agentConfig(net), { db: t.db, now: () => new Date(NOW) });
    const r = await distillVoice(s, userId);
    expect(r.by).toBe('claude');
    expect(userText(claude.requests[0]!)).toContain('<forgotten_notes');
    expect(userText(claude.requests[0]!)).toContain(ids[0]!);
    const notes = (await settingsOf(userId)).voice_notes as { text: string; forgottenAt: string | null; evidence: string[] }[];
    const live = notes.filter((n) => !n.forgottenAt);
    expect(live.length).toBeLessThanOrEqual(8);
    expect(live.some((n) => /thanks either way/i.test(n.text))).toBe(false);
    expect(live.some((n) => /weather/.test(n.text))).toBe(false);
    for (const n of live) for (const e of n.evidence) expect(ids).toContain(e);
    expect(notes.find((n) => n.text.includes("'Thanks either way'"))!.forgottenAt).toBeTruthy();
  });

  it('without Claude it reads the edits as plain observations', async () => {
    const { userId } = await signedInUser(t);
    await someEdits(userId, 3);
    const s = makeServices(agentConfig(fakeNet(), {}), { db: t.db, now: () => new Date(NOW) });
    const r = await distillVoice(s, userId);
    expect(r.by).toBe('observations');
    expect(r.added.map((n) => n.text)).toContain("You cut 'Thanks either way' in 3 edits");
  });

  it('drafting reads the notes in force into the card, and never a forgotten one', async () => {
    const { userId } = await signedInUser(t, {
      settings: {
        style_card: CARD,
        voice_notes: [
          { id: 'a', text: "You cut 'Thanks either way' every time", evidence: ['e'], createdAt: 'x', keptAt: null, forgottenAt: null },
          { id: 'b', text: "You cut 'Hope you are well'", evidence: ['e'], createdAt: 'x', keptAt: null, forgottenAt: 'y' },
        ],
      },
    });
    const card = styleCardOf(await loadUserRow(t.db, userId));
    expect(card.avoid).toEqual(['circle back', 'Thanks either way']);
    expect(card.notes).toContain("You cut 'Thanks either way' every time");
    expect(card.notes).not.toContain('Hope you are well');
  });
});

describe('the /voice routes', () => {
  it('reads the card in sentences and the notes, keeps and forgets one, and queues a relearn', async () => {
    const call = api(t, fakeNet());
    const { userId, token } = await signedInUser(t, {
      settings: {
        style_card: CARD,
        voice_notes: [
          { id: 'vn_a', text: "You cut 'Thanks either way' every time", evidence: ['e'], createdAt: 'x', keptAt: null, forgottenAt: null },
          { id: 'vn_b', text: 'You sign with your first name only', evidence: ['e'], createdAt: 'x', keptAt: null, forgottenAt: null },
        ],
      },
    });
    const p = await addPerson(t, userId, { name: 'Dana Ruiz', email: 'dana@example.com' });
    await aDraft(userId, p, SAM_SENT);
    const v = await call<{ cardProse: string[]; notes: { id: string }[]; soundsLikeYou: number | null }>('/voice', token);
    expect(v.status).toBe(200);
    expect(v.body.cardProse[0]).toBe('You greet with Hi and sign off with Thanks.');
    expect(v.body.notes.map((n) => n.id)).toEqual(['vn_a', 'vn_b']);
    expect(v.body.soundsLikeYou).toBe(3);
    const kept = await call<{ note: { keptAt: string | null } }>('/voice/notes', token, { id: 'vn_b', action: 'keep' });
    expect(kept.body.note.keptAt).toBeTruthy();
    const gone = await call<{ note: { forgottenAt: string | null } }>('/voice/notes', token, { id: 'vn_a', action: 'forget' });
    expect(gone.body.note.forgottenAt).toBeTruthy();
    expect((await call<{ notes: { id: string }[] }>('/voice', token)).body.notes.map((n) => n.id)).toEqual(['vn_b']);
    expect((await call('/voice/notes', token, { id: 'nope', action: 'forget' })).status).toBe(404);
    expect((await call('/voice/notes', token, { id: 'vn_b', action: 'delete' })).status).toBe(400);
    const r = await call<{ queued: boolean }>('/voice/relearn', token);
    expect(r.body.queued).toBe(true);
    const kinds = await t.db.sql<{ kind: string }>`
      select message->>'kind' as kind from pgmq.q_orbit_enrich where message->>'userId' = ${userId}
      union all select message->>'kind' from pgmq.q_orbit_cadence where message->>'userId' = ${userId}`;
    expect(kinds.map((k) => k.kind).sort()).toEqual(['voice.card', 'voice.distill', 'voice.embed_sent']);
  });
});
