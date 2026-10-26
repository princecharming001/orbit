/**
 * Reply rapport on the server (plan 27): classify.message reads how warm a reply is (lexical, then Haiku), stores it
 * as an object in extraction.rapport, and rescores the sender after the reading; the score loader turns readings into
 * f16; the student can turn it off; rapport.backfill reads a year of stored replies; /settings/profile takes the
 * switch and rescores.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeClaude } from '../../functions/_shared/claude.ts';
import { defaultHandlers } from '../../functions/orbit-worker/worker.ts';
import { api, fakeNet, signedInUser } from '../helpers/agents.ts';
import { jsonRes, recordingFetch } from '../helpers/google.ts';
import { clearQueues, connectedUser, drain } from '../helpers/ingest.ts';
import { ago, NOW } from '../helpers/mailFixtures.ts';
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
  await t.db.sql`delete from orbit.job_runs`;
});

const WARM =
  "Maya! So good to hear from you. How did the Stripe interview go? Happy to intro you to my old manager, and let's grab coffee when you're back.";

async function world() {
  const u = await connectedUser(t.db);
  const [p] = await t.db.sql<{ id: string }>`
    insert into orbit.people (user_id, display_name, first_name, name_norm, primary_email)
    values (${u}::uuid, 'Rae Moon', 'Rae', 'rae moon', 'rae@moon.co') returning id`;
  const [th] = await t.db.sql<{ id: string }>`
    insert into orbit.threads (user_id, provider, external_id, is_networking, participant_person_ids, participant_count)
    values (${u}::uuid, 'gmail', ${`T-${Math.random()}`}, true, ${[p!.id]}::uuid[], 1) returning id`;
  return { u, rae: p!.id, th: th!.id };
}

async function message(
  u: string,
  th: string,
  m: { dir: 'in' | 'out'; from?: string; body: string; at: string },
) {
  const [row] = await t.db.sql<{ id: string }>`
    insert into orbit.messages (user_id, thread_id, provider, external_id, direction, from_person_id, to_person_ids,
                                sent_at, body_text)
    values (${u}::uuid, ${th}::uuid, 'gmail', ${`g-${Math.random()}`}, ${m.dir}, ${m.from ?? null}::uuid,
            ${m.dir === 'out' && m.from ? [m.from] : []}::uuid[], ${m.at}::timestamptz, ${m.body})
    returning id`;
  return row!.id;
}

const classify = (u: string, messageId: string) =>
  t.db
    .sql`select orbit.enqueue('orbit_classify', ${{ kind: 'classify.message', userId: u, payload: { messageId } }}::jsonb, 0)`;

const claudeAnswer = (data: unknown) =>
  jsonRes(200, {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [{ type: 'text', text: JSON.stringify(data) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 300, output_tokens: 40 },
  });

/** Haiku that answers the rapport read, and the reply classifier if asked. */
function fakeHaiku() {
  return recordingFetch((c) =>
    c.body.includes('how the sender feels about the student')
      ? claudeAnswer({
          warmth: 2,
          familiarity: 'friendly',
          effort: 2,
          cues: ['asks_about_you', 'offers_help'],
        })
      : claudeAnswer({
          class: 'interested',
          confidence: 0.9,
          proposed_times: [],
          return_date: null,
          referred_people: [],
          question: null,
        }),
  );
}

async function stored(id: string) {
  const [m] = await t.db.sql<{ kind: string; rapport: { score: number; by: string; cues: string[] } | null }>`
    select jsonb_typeof(extraction -> 'rapport') as kind, extraction -> 'rapport' as rapport
      from orbit.messages where id = ${id}::uuid`;
  return m!;
}

describe('reply rapport on the server (plan 27)', () => {
  it('reads a warm reply with Haiku, stores it as an object, and rescores the sender after the reading', async () => {
    const { u, rae, th } = await world();
    await message(u, th, {
      dir: 'out',
      from: rae,
      body: 'Hi Rae, could I ask about your time at Stripe?',
      at: ago(4),
    });
    const reply = await message(u, th, { dir: 'in', from: rae, body: WARM, at: ago(3) });
    const net = fakeHaiku();
    const claude = makeClaude({ apiKey: 'sk-placeholder', fetch: net.fetch, db: t.db });
    await classify(u, reply);
    await drain(t, defaultHandlers({ claude }), () => new Date(NOW));

    const m = await stored(reply);
    expect(m.kind).toBe('object');
    expect(m.rapport).toMatchObject({ by: 'llm', cues: ['asks_about_you', 'offers_help'] });
    expect(m.rapport!.score).toBeGreaterThan(0.8);
    const rapportCall = net.calls.find((c) => c.body.includes('how the sender feels about the student'));
    expect(JSON.parse(rapportCall!.body).model).toBe('claude-haiku-5-5');

    const runs = await t.db.sql<{ kind: string }>`
      select kind from orbit.job_runs where user_id = ${u}::uuid and status = 'ok' order by started_at, id`;
    const kinds = runs.map((r) => r.kind);
    expect(kinds.indexOf('score.person')).toBeGreaterThan(kinds.indexOf('classify.message'));
    const [s] = await t.db.sql<{ rapport: number; explanation: string[] }>`
      select (features ->> 'rapport')::float8 as rapport, explanation from orbit.tie_scores
       where user_id = ${u}::uuid and person_id = ${rae}::uuid`;
    expect(s!.rapport).toBeGreaterThan(0);
    expect(s!.explanation.join(' ')).toContain('Their replies are warm');
  });

  it('keeps the lexical reading without Claude, and never reads tone when the student turned it off', async () => {
    const { u, rae, th } = await world();
    const reply = await message(u, th, { dir: 'in', from: rae, body: WARM, at: ago(2) });
    await classify(u, reply);
    await drain(t, defaultHandlers({}), () => new Date(NOW));
    const lexical = await stored(reply);
    expect(lexical.kind).toBe('object');
    expect(lexical.rapport).toMatchObject({ by: 'lexical' });
    expect(lexical.rapport!.score).toBeGreaterThan(0.5);

    await t.db
      .sql`update orbit.users set settings = settings || '{"read_reply_tone": false}'::jsonb where id = ${u}::uuid`;
    const second = await message(u, th, { dir: 'in', from: rae, body: `${WARM} Also congrats!`, at: ago(1) });
    const net = fakeHaiku();
    const claude = makeClaude({ apiKey: 'sk-placeholder', fetch: net.fetch, db: t.db });
    await classify(u, second);
    await drain(t, defaultHandlers({ claude }), () => new Date(NOW));
    expect(net.calls.some((c) => c.body.includes('how the sender feels about the student'))).toBe(false);
    const [s] = await t.db.sql<{ rapport: number }>`
      select (features ->> 'rapport')::float8 as rapport from orbit.tie_scores
       where user_id = ${u}::uuid and person_id = ${rae}::uuid`;
    expect(s!.rapport).toBe(0);
  });

  it('rapport.backfill reads a year of stored replies, then rescores everyone', async () => {
    const { u, rae, th } = await world();
    const ids = [
      await message(u, th, { dir: 'in', from: rae, body: WARM, at: ago(40) }),
      await message(u, th, { dir: 'in', from: rae, body: 'Sounds good, talk soon!', at: ago(20) }),
    ];
    const old = await message(u, th, { dir: 'in', from: rae, body: WARM, at: ago(500) });
    await t.db
      .sql`select orbit.enqueue('orbit_classify', ${{ kind: 'rapport.backfill', userId: u, payload: {} }}::jsonb, 0)`;
    await drain(t, defaultHandlers({}), () => new Date(NOW));
    for (const id of ids) expect((await stored(id)).kind).toBe('object');
    expect((await stored(old)).kind).toBeNull();
    const runs = await t.db.sql<{ kind: string }>`
      select kind from orbit.job_runs where user_id = ${u}::uuid and status = 'ok'`;
    expect(runs.map((r) => r.kind)).toContain('score.user');
  });
});

describe('/settings/profile readReplyTone', () => {
  it('stores only "off", removes it when turned back on, and rescores', async () => {
    const call = api(t, fakeNet(), { env: {} });
    const { userId, token } = await signedInUser(t);
    expect((await call('/settings/profile', token, { readReplyTone: 'no' })).status).toBe(400);
    expect((await call('/settings/profile', token, { readReplyTone: false })).status).toBe(200);
    const settings = async () =>
      (
        await t.db.sql<{
          s: Record<string, unknown>;
        }>`select settings as s from orbit.users where id = ${userId}::uuid`
      )[0]!.s;
    expect((await settings()).read_reply_tone).toBe(false);
    const queued = await t.db.sql<{ n: number }>`
      select count(*)::int as n from pgmq.q_orbit_score
       where message ->> 'kind' = 'score.user' and message ->> 'userId' = ${userId}`;
    expect(queued[0]!.n).toBeGreaterThan(0);
    await call('/settings/profile', token, { readReplyTone: true });
    expect('read_reply_tone' in (await settings())).toBe(false);
  });
});
