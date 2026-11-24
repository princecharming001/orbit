/**
 * The backend audit of 2026-11-24, one situation per finding (the worker's own, finding A, is in orbit-worker.test.ts):
 *   B  a second tie inference with nothing new rewrites no undated tie, so delta scoring has nobody to rescore
 *   C  two ingests for one user at the same moment create a new person once
 *   D  a LinkedIn link that comes back under a new Unipile account id stores no message a second time
 *   E  the external calls that had no timeout give up, and a timeout is a handled failure
 *   F  one rescoring per person per hour after classified replies; a scoped tie refresh reads only the people it needs
 *   G  an ingest that brings nothing new writes no identity and no organization
 *   H  the identity lookup's indexes exist
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeClaude } from '../../functions/_shared/claude.ts';
import type { Db, Row } from '../../functions/_shared/db.ts';
import { ingestRelations, storeChat } from '../../functions/_shared/ingest/linkedin.ts';
import { peopleLockKey, resolvePeople } from '../../functions/_shared/ingest/people.ts';
import { changedPeople, scorePeople } from '../../functions/_shared/ingest/score.ts';
import { refreshTies, upsertTie, upsertTies } from '../../functions/_shared/ingest/ties.ts';
import { loadSelf } from '../../functions/_shared/ingest/util.ts';
import { sqlQueue } from '../../functions/_shared/queue.ts';
import { runCensusStep } from '../../functions/_shared/search/census.ts';
import { runFacetLookup } from '../../functions/_shared/search/lookup.ts';
import { runReadingStep } from '../../functions/_shared/search/reading.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import { slotsFor } from '../../functions/_shared/slots/slots.ts';
import { unipileAccount, unipileEvent } from '../../functions/orbit-webhooks/webhooks.ts';
import { scorePersonKey } from '../../functions/orbit-worker/handlers/classify.ts';
import { defaultHandlers } from '../../functions/orbit-worker/worker.ts';
import { addPerson, fakeEmbed, fakeTokens, instant, signedInUser, UNIPILE } from '../helpers/agents.ts';
import { FakeUnipile, virtualTime } from '../helpers/fakeApis.ts';
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
});

/** A Db that records the SQL it is asked to run, transactions included, and the rows each statement returned. */
function spyDb(
  db: Db,
  log: { text: string; rows: number }[] = [],
): Db & { log: { text: string; rows: number }[] } {
  const seen = async <T extends Row>(text: string, run: Promise<T[]>): Promise<T[]> => {
    const entry = { text, rows: 0 };
    log.push(entry);
    const rows = await run;
    entry.rows = rows.length;
    return rows;
  };
  return {
    log,
    sql: <T extends Row>(strings: TemplateStringsArray, ...values: unknown[]) =>
      seen(strings.join('?'), db.sql<T>(strings, ...values)),
    query: <T extends Row>(text: string, params?: unknown[]) => seen(text, db.query<T>(text, params)),
    begin: (fn) => {
      log.push({ text: 'begin', rows: 0 });
      return db.begin((tx) => fn(spyDb(tx, log)));
    },
  };
}

let seq = 0;
async function person(
  u: string,
  name: string,
  o: { email?: string; identity?: boolean; location?: string; member?: string } = {},
): Promise<string> {
  const [first, ...rest] = name.split(' ');
  const [p] = await t.db.sql<{ id: string }>`
    insert into orbit.people (user_id, display_name, first_name, last_name, name_norm, primary_email, location,
                              linkedin_member_id, sources)
    values (${u}::uuid, ${name}, ${first}, ${rest.join(' ') || null}, ${name.toLowerCase()}, ${o.email ?? null},
            ${o.location ?? null}, ${o.member ?? null}, ${['gmail']}::text[])
    returning id`;
  if (o.email && o.identity !== false)
    await t.db.sql`
      insert into orbit.person_identities (user_id, person_id, kind, value_norm, source)
      values (${u}::uuid, ${p!.id}::uuid, 'email', ${o.email}, 'gmail')`;
  return p!.id;
}

describe('B: tie inference leaves an unchanged tie alone', () => {
  const tieState = (u: string) =>
    t.db.sql<{ kind: string; last: string; updated: string; version: string }>`
      select kind, last_seen_at::text as last, updated_at::text as updated, xmin::text as version
        from orbit.ties where user_id = ${u}::uuid order by a_person_id, b_person_id, kind`;

  it('a second run with nothing new rewrites no same-city tie, and delta scoring finds nobody to rescore', async () => {
    const u = await connectedUser(t.db);
    for (const name of ['Ada Reyes', 'Bo Lind', 'Cy Marsh'])
      await person(u, name, { location: 'Austin, TX' });
    await refreshTies(t.db, u, new Date('2026-11-20T08:00:00Z'));
    const first = await tieState(u);
    expect(first.map((r) => r.kind)).toEqual(['same_city', 'same_city', 'same_city']);
    await scorePeople(t.db, u, { now: new Date('2026-11-20T08:00:00Z') });
    expect(await changedPeople(t.db, u)).toEqual([]);

    // the next night: the same evidence, a later clock
    const r = await refreshTies(t.db, u, new Date('2026-11-21T08:00:00Z'));
    expect(r).toEqual({ upserted: 3, deleted: 0 });
    // not one row was written again (xmin is the row version), so no browser pulls them and nobody is rescored
    expect(await tieState(u)).toEqual(first);
    expect(await changedPeople(t.db, u)).toEqual([]);
  });

  it('a tie that carries a date still follows it, and one without keeps the date it has', async () => {
    const u = await connectedUser(t.db);
    const a = await person(u, 'Dee Ash');
    const b = await person(u, 'Eli Oak');
    const dated = { a, b, kind: 'email_exchange', weight: 0.5, confidence: 0.9, evidence: { count: 1 } };
    await upsertTies(
      t.db,
      u,
      [{ ...dated, firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-01T00:00:00Z' }],
      new Date('2026-11-20T08:00:00Z'),
    );
    await upsertTies(
      t.db,
      u,
      [{ ...dated, firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-11-05T00:00:00Z' }],
      new Date('2026-11-21T08:00:00Z'),
    );
    const undated = { a, b, kind: 'linkedin_mutual', weight: 0.3, confidence: 0.5, evidence: { count: 2 } };
    await upsertTie(t.db, u, undated, new Date('2026-11-20T08:00:00Z'));
    const before = await tieState(u);
    await upsertTie(t.db, u, undated, new Date('2026-11-21T08:00:00Z'));
    const after = await tieState(u);
    expect(after).toEqual(before);
    expect(after.map((r) => [r.kind, new Date(r.last).toISOString()])).toEqual([
      ['email_exchange', '2026-11-05T00:00:00.000Z'],
      ['linkedin_mutual', '2026-11-20T08:00:00.000Z'],
    ]);
  });
});

describe('C: two ingests for one user at once', () => {
  it('create the same new LinkedIn member once (the webhook storing a message while the worker files relations)', async () => {
    const u = await connectedUser(t.db, { linkedinAccount: 'acc-race' });
    const self = await loadSelf(t.db, u);
    const now = new Date(NOW);
    const [relations, chat] = await Promise.all([
      ingestRelations(
        t.db,
        u,
        [
          {
            memberId: 'ACoRace',
            publicIdentifier: 'rae-race',
            firstName: 'Rae',
            lastName: 'Race',
            headline: 'Designer at Figma',
          },
        ],
        now,
      ),
      storeChat(
        t.db,
        u,
        self,
        { id: 'chat-race', attendees: [{ providerId: 'ACoRace', attendeeId: 'att-race', name: 'Rae Race' }] },
        [{ id: 'race-1', text: 'Hi Maya!', senderId: 'ACoRace', timestamp: ago(0, 1) }],
        now,
        new Set(['ACoMaya']),
      ),
    ]);
    const people = await t.db.sql<{ id: string }>`
      select id from orbit.people where user_id = ${u}::uuid and linkedin_member_id = 'ACoRace'`;
    expect(people).toHaveLength(1);
    expect(relations.byMember.get('ACoRace')).toBe(people[0]!.id);
    expect(chat.personIds).toEqual([people[0]!.id]);
    const [m] = await t.db.sql<{ from_person_id: string }>`
      select from_person_id from orbit.messages where user_id = ${u}::uuid and external_id = 'race-1'`;
    expect(m!.from_person_id).toBe(people[0]!.id);
  });

  it('takes the per-user lock inside a transaction before it looks anyone up', async () => {
    const u = await connectedUser(t.db);
    const spy = spyDb(t.db);
    await resolvePeople(
      spy,
      u,
      [{ key: 'k', email: 'lock@example.org', name: 'Lou Lock', source: 'gmail' }],
      {
        now: new Date(NOW),
      },
    );
    expect(spy.log[0]!.text).toBe('begin');
    expect(spy.log[1]!.text).toContain('pg_advisory_xact_lock(hashtextextended(');
    expect(spy.log.findIndex((l) => l.text.includes('from orbit.person_identities'))).toBeGreaterThan(1);
    expect(peopleLockKey(u)).toBe(`orbit.people:${u}`);
  });
});

describe('D: a LinkedIn link back under a new Unipile account id', () => {
  const UNIPILE_KEYS = { apiKey: 'unipile-key-placeholder', baseUrl: 'https://api.unipile.test' };
  const state = async (u: string) =>
    (
      await t.db.sql<{ external_account_id: string; linkedin: Record<string, unknown> }>`
        select external_account_id, sync_state -> 'linkedin' as linkedin from orbit.integration_accounts
         where user_id = ${u}::uuid and provider = 'linkedin'`
    )[0]!;
  const messages = (u: string) =>
    t.db.sql<{ external_id: string; body_text: string }>`
      select external_id, body_text from orbit.messages where user_id = ${u}::uuid and provider = 'linkedin'
       order by sent_at, external_id`;

  it('resumes from the last finished pass with a floor, and stores no old message again', async () => {
    const u = await connectedUser(t.db, { linkedinAccount: 'acc-old' });
    const time = virtualTime(NOW);
    const unipile = new FakeUnipile();
    const handlers = defaultHandlers({
      fetch: unipile.fetch,
      unipile: UNIPILE_KEYS,
      clock: time.clock,
      sleep: time.sleep,
      random: () => 0,
    });
    const me = { id: 'att-me', provider_id: 'ACoMaya', name: 'Maya Chen', is_self: 1 };
    const kim = { id: 'att-k', provider_id: 'ACoKim', name: 'Kim Li' };
    unipile.relations = [
      { member_id: 'ACoKim', first_name: 'Kim', last_name: 'Li', created_at: Date.parse(ago(40)) },
    ];
    unipile.chats = [
      {
        id: 'chat-old',
        attendees: [me, kim],
        messages: [
          {
            id: 'o1',
            sender_id: 'ACoMaya',
            text: 'Hi Kim, loved your talk!',
            timestamp: ago(12),
            is_sender: 1,
          },
          { id: 'o2', sender_id: 'ACoKim', text: 'Thanks Maya, glad it landed.', timestamp: ago(10) },
        ],
      },
    ];
    await t.db
      .sql`select orbit.enqueue('orbit_sync', ${{ kind: 'sync.linkedin', userId: u, payload: { mode: 'backfill' } }}::jsonb, 0)`;
    await drain(t, handlers, time.now);
    const synced = (await state(u)).linkedin;
    expect(synced).toMatchObject({ stage: 'done' });
    expect((await messages(u)).map((m) => m.external_id)).toEqual(['o1', 'o2']);

    // an hour later a message arrives by webhook, under the old account's ids
    time.advance(3_600_000);
    const hookAt = new Date(time.clock() - 60_000).toISOString();
    const hooked = await unipileEvent(t.db, sqlQueue, {
      event: 'message_received',
      account_id: 'acc-old',
      account_info: { type: 'LINKEDIN', user_id: 'ACoMaya' },
      chat_id: 'chat-old',
      message_id: 'w1',
      message: 'Are you free Thursday?',
      timestamp: hookAt,
      sender: { attendee_id: 'att-k', attendee_name: 'Kim Li', attendee_provider_id: 'ACoKim' },
      attendees: [
        { attendee_id: 'att-me', attendee_name: 'Maya Chen', attendee_provider_id: 'ACoMaya' },
        { attendee_id: 'att-k', attendee_name: 'Kim Li', attendee_provider_id: 'ACoKim' },
      ],
    });
    expect(hooked.result).toBe('queued');

    // the student goes through the hosted sign-in again: Unipile makes a new account, with new chat and message ids
    time.advance(3_600_000);
    const linked = await unipileAccount(t.db, sqlQueue(t.db), {
      status: 'CREATION_SUCCESS',
      account_id: 'acc-new',
      name: u,
    });
    expect(linked.result).toBe('connected');
    const back = await state(u);
    expect(back.external_account_id).toBe('acc-new');
    expect(back.linkedin).toMatchObject({
      stage: 'relations',
      short: true,
      resume: true,
      chatsAfter: synced.syncedAt,
      floor: synced.syncedAt,
      selfMemberId: 'ACoMaya',
    });

    const newAt = new Date(time.clock() - 60_000).toISOString();
    unipile.chats = [
      {
        id: 'chat-new',
        attendees: [me, kim],
        messages: [
          {
            id: 'n1',
            sender_id: 'ACoMaya',
            text: 'Hi Kim, loved your talk!',
            timestamp: ago(12),
            is_sender: 1,
          },
          { id: 'n2', sender_id: 'ACoKim', text: 'Thanks Maya, glad it landed.', timestamp: ago(10) },
          { id: 'n-w1', sender_id: 'ACoKim', text: 'Are you free Thursday?', timestamp: hookAt },
          { id: 'n3', sender_id: 'ACoKim', text: 'Or Friday, if that is easier.', timestamp: newAt },
        ],
      },
    ];
    await clearQueues(t);
    await t.db
      .sql`select orbit.enqueue('orbit_sync', ${{ kind: 'sync.linkedin', userId: u, payload: { mode: 'backfill', accountId: 'acc-new' } }}::jsonb, 0)`;
    await drain(t, handlers, time.now);
    // the two from before the floor are left out by date, the webhook's by what it says; only the new one is stored
    expect(await messages(u)).toEqual([
      { external_id: 'o1', body_text: 'Hi Kim, loved your talk!' },
      { external_id: 'o2', body_text: 'Thanks Maya, glad it landed.' },
      { external_id: 'w1', body_text: 'Are you free Thursday?' },
      { external_id: 'n3', body_text: 'Or Friday, if that is easier.' },
    ]);
    expect((await state(u)).linkedin).toMatchObject({ stage: 'done', floor: synced.syncedAt });
  });

  it('leaves the state alone when the account id is the same, and starts the walk over when no pass had finished', async () => {
    const same = await connectedUser(t.db, { linkedinAccount: 'acc-same' });
    const done = { stage: 'done', syncedAt: '2026-10-01T00:00:00.000Z', selfMemberId: 'ACoSame' };
    await t.db.sql`update orbit.integration_accounts set sync_state = ${{ linkedin: done }}::jsonb
                    where user_id = ${same}::uuid and provider = 'linkedin'`;
    await unipileAccount(t.db, sqlQueue(t.db), { status: 'RECONNECTED', account_id: 'acc-same', name: same });
    expect((await state(same)).linkedin).toEqual(done);

    const mid = await connectedUser(t.db, { linkedinAccount: 'acc-first' });
    await t.db.sql`
      update orbit.integration_accounts
         set sync_state = ${{ linkedin: { stage: 'chats', chatsCursor: 'cursor-of-acc-first', chatIndex: 3, selfMemberId: 'ACoMid' } }}::jsonb
       where user_id = ${mid}::uuid and provider = 'linkedin'`;
    await unipileAccount(t.db, sqlQueue(t.db), {
      status: 'CREATION_SUCCESS',
      account_id: 'acc-second',
      name: mid,
    });
    const restarted = (await state(mid)).linkedin;
    // the saved cursors paged the old account; what the first walk stored is recognised by what it says
    expect(restarted).toMatchObject({
      stage: 'relations',
      cursor: null,
      chatsCursor: null,
      chatIndex: 0,
      selfMemberId: 'ACoMid',
    });
    expect(restarted.floor).toBeUndefined();
  });

  it('message ingest skips a message stored under another id: same person, direction, time and words', async () => {
    const u = await connectedUser(t.db, { linkedinAccount: 'acc-twin' });
    const self = await loadSelf(t.db, u);
    const own = new Set(['ACoMaya']);
    const attendees = [{ providerId: 'ACoTess', attendeeId: 'att-t', name: 'Tess Twin' }];
    const now = new Date(NOW);
    const long = `${'A long note about the role. '.repeat(12)}Talk soon!`;
    const first = await storeChat(
      t.db,
      u,
      self,
      { id: 'chat-a', attendees },
      [
        { id: 'a1', text: 'Hi Tess, could I ask about Figma?', isSender: true, timestamp: ago(9) },
        { id: 'a2', text: long, senderId: 'ACoTess', timestamp: ago(8) },
      ],
      now,
      own,
    );
    expect(first.inserted).toBe(2);
    // retention has cleared the older bodies: the snippet still tells
    await t.db
      .sql`update orbit.messages set body_text = null where user_id = ${u}::uuid and external_id = 'a2'`;

    // the same chat under a new account's ids, nothing new in it: no message and no second thread
    const again = await storeChat(
      t.db,
      u,
      self,
      { id: 'chat-b', attendees },
      [
        { id: 'b1', text: 'Hi Tess, could I ask about Figma?', isSender: true, timestamp: ago(9) },
        { id: 'b2', text: long, senderId: 'ACoTess', timestamp: ago(8) },
      ],
      now,
      own,
    );
    expect(again).toMatchObject({ inserted: 0, inbound: [], threadId: first.threadId });
    const threads = await t.db.sql<{ external_id: string }>`
      select external_id from orbit.threads where user_id = ${u}::uuid order by 1`;
    expect(threads.map((r) => r.external_id)).toEqual(['chat-a']);

    // with one new message: that one is stored, the same words at another time are a different message
    const more = await storeChat(
      t.db,
      u,
      self,
      { id: 'chat-b', attendees },
      [
        { id: 'b1', text: 'Hi Tess, could I ask about Figma?', isSender: true, timestamp: ago(9) },
        { id: 'b3', text: 'Hi Tess, could I ask about Figma?', isSender: true, timestamp: ago(2) },
        { id: 'b4', text: 'Sure, ask away.', senderId: 'ACoTess', timestamp: ago(1) },
      ],
      now,
      own,
    );
    expect(more.inserted).toBe(2);
    expect(more.inbound.map((m) => m.externalId)).toEqual(['b4']);
    const stored = await t.db.sql<{ external_id: string }>`
      select external_id from orbit.messages where user_id = ${u}::uuid order by sent_at`;
    expect(stored.map((m) => m.external_id)).toEqual(['a1', 'a2', 'b3', 'b4']);
  });
});

describe('E: external calls give up after a timeout, and a timeout is handled', () => {
  /** A provider that never answers: fetch rejects as it does when its AbortSignal.timeout fires. */
  function silent() {
    const signals: boolean[] = [];
    const f = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      signals.push(init.signal instanceof AbortSignal);
      // without a signal the real call would wait until the worker's isolate is killed
      if (!(init.signal instanceof AbortSignal)) throw new Error('called without a timeout');
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as typeof fetch;
    return { fetch: f, signals };
  }
  const AT = new Date('2026-11-24T12:00:00Z');

  it('the census step stops as `timeout` and keeps its place', async () => {
    const { userId } = await signedInUser(t);
    const net = silent();
    const step = await runCensusStep(
      t.db,
      { fetch: net.fetch, apiKey: 'k', baseUrl: UNIPILE, sleep: instant, random: () => 0, clock: Date.now },
      userId,
      'acc-e1',
      AT,
    );
    expect(net.signals).toEqual([true]);
    expect(step).toMatchObject({ pages: 0, done: false, stopped: 'timeout' });
    const [row] = await t.db.sql<{ last_error: string | null; pass_done_at: string | null }>`
      select last_error, pass_done_at::text from orbit.search_census where user_id = ${userId}::uuid`;
    expect(row).toEqual({ last_error: 'timeout', pass_done_at: null });
  });

  it('a facet lookup answers with the reason `timeout`, from either of its two calls', async () => {
    const { userId } = await signedInUser(t);
    const net = silent();
    const deps = { fetch: net.fetch, apiKey: 'k', baseUrl: UNIPILE };
    expect(await runFacetLookup(t.db, deps, userId, 'acc-e2', 'company', 'Stripe', AT)).toMatchObject({
      ok: false,
      reason: 'timeout',
    });
    // the parameter is found, then the search itself does not answer
    const half = (async (input: RequestInfo | URL, init: RequestInit = {}) =>
      String(input).includes('/linkedin/search/parameters')
        ? jsonRes(200, { items: [{ id: '2135371' }] })
        : net.fetch(input, init)) as typeof fetch;
    expect(
      await runFacetLookup(t.db, { ...deps, fetch: half }, userId, 'acc-e2', 'company', 'Stripe', AT),
    ).toMatchObject({ ok: false, reason: 'timeout' });
    expect(net.signals).toEqual([true, true]);
  });

  it('a profile read that does not answer stops the reading step, with the person left for a later step', async () => {
    const { userId } = await signedInUser(t);
    const ana = await addPerson(t, userId, { name: 'Ana Slow', memberId: 'ACoAnaSlow' });
    const net = silent();
    const step = await runReadingStep(
      t.db,
      { fetch: net.fetch, apiKey: 'k', baseUrl: UNIPILE, sleep: instant, random: () => 0, clock: Date.now },
      userId,
      'acc-e3',
      AT,
      { mode: 'ask', personIds: [ana] },
    );
    expect(net.signals).toEqual([true]);
    expect(step).toMatchObject({ profiles: 0, stopped: 'timeout', readIds: [] });
    expect(await t.db.sql`select 1 from orbit.profile_reads where person_id = ${ana}::uuid`).toHaveLength(0);
  });

  it('free/busy that does not answer falls back to the synced calendar', async () => {
    const { userId } = await signedInUser(t);
    const net = silent();
    const s = makeServices(
      { env: {}, fetch: net.fetch, embed: fakeEmbed, tokens: fakeTokens, sleep: instant, random: () => 0 },
      { db: t.db, now: () => AT },
    );
    const slots = await slotsFor(s, userId);
    expect(net.signals).toEqual([true]);
    expect(slots.source).toBe('stored');
    expect(slots.slots.length).toBeGreaterThan(0);
  });
});

describe('F: scoring after classified replies', () => {
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

  it('two classified replies from one person in the same hour ask for one rescoring, not two', async () => {
    const u = await connectedUser(t.db);
    const rae = await person(u, 'Rae Moon', { email: 'rae@moon.co' });
    const [th] = await t.db.sql<{ id: string }>`
      insert into orbit.threads (user_id, provider, external_id, is_networking, participant_person_ids, participant_count)
      values (${u}::uuid, 'gmail', 'T-hour', true, ${[rae]}::uuid[], 1) returning id`;
    const replies: string[] = [];
    for (const [i, body] of [
      'Happy to chat, how is next week?',
      'Also, send me your resume first.',
    ].entries()) {
      const [m] = await t.db.sql<{ id: string }>`
        insert into orbit.messages (user_id, thread_id, provider, external_id, direction, from_person_id, sent_at,
                                    body_text)
        values (${u}::uuid, ${th!.id}::uuid, 'gmail', ${`hour-${i}`}, 'in', ${rae}::uuid, ${ago(1, i)}::timestamptz,
                ${body})
        returning id`;
      replies.push(m!.id);
    }
    const net = recordingFetch((c) =>
      c.body.includes('how the sender feels about the student')
        ? claudeAnswer({ warmth: 2, familiarity: 'friendly', effort: 2, cues: ['offers_help'] })
        : claudeAnswer({
            class: 'question',
            confidence: 0.9,
            proposed_times: [],
            return_date: null,
            referred_people: [],
            question: 'When?',
          }),
    );
    const claude = makeClaude({ apiKey: 'sk-placeholder', fetch: net.fetch, db: t.db });
    for (const messageId of replies)
      await t.db
        .sql`select orbit.enqueue('orbit_classify', ${{ kind: 'classify.message', userId: u, payload: { messageId } }}::jsonb, 0)`;
    await drain(t, defaultHandlers({ claude }), () => new Date(NOW));
    const runs = await t.db.sql<{ kind: string; dedupe_key: string | null }>`
      select kind, dedupe_key from orbit.job_runs where user_id = ${u}::uuid and status = 'ok' order by id`;
    expect(runs.filter((r) => r.kind === 'classify.message')).toHaveLength(2);
    const scored = runs.filter((r) => r.kind === 'score.person');
    expect(scored).toHaveLength(1);
    expect(scored[0]!.dedupe_key).toBe(scorePersonKey(u, rae, new Date(NOW)));
    // the next hour is a new key
    expect(scorePersonKey(u, rae, new Date(NOW + 3_600_000))).not.toBe(scored[0]!.dedupe_key);
  });

  it('a tie refresh for one person reads only the people on their threads, and infers what the whole run does', async () => {
    const u = await connectedUser(t.db);
    const ann = await person(u, 'Ann Focus', { email: 'ann@focus.org' });
    const ben = await person(u, 'Ben Near', { email: 'ben@near.org' });
    // reachable only by address: an identity added after the mail was filed, and a primary email stored as typed
    const cat = await person(u, 'Cat Late', { email: 'cat@late.org' });
    const dov = await person(u, 'Dov Dots', { email: 'Dov.Dots+work@Gmail.com', identity: false });
    for (let i = 0; i < 40; i++) await person(u, `Far Person${++seq}`, { email: `far${seq}@elsewhere.org` });
    const [th] = await t.db.sql<{ id: string }>`
      insert into orbit.threads (user_id, provider, external_id, is_networking, participant_person_ids,
                                 participant_count, first_at, last_at)
      values (${u}::uuid, 'gmail', 'T-scope', true, ${[ann, ben]}::uuid[], 2, ${ago(3)}::timestamptz,
              ${ago(3)}::timestamptz)
      returning id`;
    await t.db.sql`
      insert into orbit.messages (user_id, thread_id, provider, external_id, direction, from_person_id, from_addr,
                                  to_addrs, cc_addrs, to_person_ids, sent_at, body_text)
      values (${u}::uuid, ${th!.id}::uuid, 'gmail', 'scope-1', 'in', ${ann}::uuid, 'ann@focus.org',
              ${['maya@example.com', 'ben@near.org']}::text[], ${['cat@late.org', 'dovdots@gmail.com']}::text[],
              ${[ben]}::uuid[], ${ago(3)}::timestamptz, 'hello all')`;
    const ties = () =>
      t.db.sql<{ a: string; b: string; kind: string; w: number; ev: unknown }>`
        select a_person_id as a, b_person_id as b, kind, weight as w, evidence as ev from orbit.ties
         where user_id = ${u}::uuid order by 1, 2, 3`;
    const now = new Date(NOW);
    await refreshTies(t.db, u, now, {
      kinds: ['email_exchange', 'email_cc', 'email_cothread', 'meeting_coattendee'],
    });
    const whole = await ties();
    expect(whole.map((r) => (r.a === ann ? r.b : r.a)).sort()).toEqual([ben, cat, dov].sort());

    await t.db.sql`delete from orbit.ties where user_id = ${u}::uuid`;
    const spy = spyDb(t.db);
    const r = await refreshTies(spy, u, now, { personIds: [ann] });
    expect(r).toEqual({ upserted: 3, deleted: 0 });
    expect(await ties()).toEqual(whole);
    const loaded = spy.log.find((l) => l.text.includes('from orbit.people p'))!;
    expect(loaded.rows).toBe(4);
    const addresses = spy.log.find((l) => l.text.includes('select pi.person_id, pi.kind, pi.value_norm'))!;
    expect(addresses.rows).toBe(3);
  });
});

describe('G: an ingest that brings nothing new writes nothing', () => {
  it('a second pass over the same relation inserts no identity and touches no organization', async () => {
    const u = await connectedUser(t.db);
    const relation = {
      memberId: 'ACoGwen',
      publicIdentifier: 'gwen-stone',
      firstName: 'Gwen',
      lastName: 'Stone',
      headline: 'Designer at Figma',
      connectedAt: ago(30),
    };
    const first = await ingestRelations(t.db, u, [relation], new Date(NOW));
    expect(first.created).toBe(1);
    const org = async () =>
      (
        await t.db.sql<{ id: string; version: string }>`
          select id, xmin::text as version from orbit.organizations where user_id = ${u}::uuid and name_norm = 'figma'`
      )[0]!;
    const before = await org();

    const spy = spyDb(t.db);
    const again = await ingestRelations(spy, u, [relation], new Date(NOW));
    expect(again.created).toBe(0);
    expect(again.byMember.get('ACoGwen')).toBe(first.byMember.get('ACoGwen'));
    expect(spy.log.filter((l) => l.text.includes('insert into orbit.person_identities'))).toEqual([]);
    expect(spy.log.filter((l) => l.text.includes('insert into orbit.organizations'))).toEqual([]);
    // the row is the same version: the upsert that only fetched its id used to rewrite it
    expect(await org()).toEqual(before);
    const ids = await t.db.sql<{ kind: string }>`
      select kind from orbit.person_identities where user_id = ${u}::uuid and person_id = ${first.byMember.get('ACoGwen')!}::uuid
       order by kind`;
    expect(ids.map((i) => i.kind)).toEqual(['linkedin_member', 'linkedin_slug']);
  });

  it('a new identity of a known person is still added, and a new company still created', async () => {
    const u = await connectedUser(t.db);
    await resolvePeople(t.db, u, [{ key: 'a', email: 'hal@north.co', name: 'Hal North', source: 'gmail' }], {
      now: new Date(NOW),
    });
    const r = await resolvePeople(
      t.db,
      u,
      [
        {
          key: 'b',
          email: 'hal@north.co',
          name: 'Hal North',
          linkedinMemberId: 'ACoHal',
          companyRaw: 'Northwind',
          source: 'linkedin',
        },
      ],
      { now: new Date(NOW) },
    );
    const ids = await t.db.sql<{ kind: string; value_norm: string }>`
      select kind, value_norm from orbit.person_identities where user_id = ${u}::uuid and person_id = ${r.byKey.get('b')!}::uuid
       order by kind`;
    expect(ids).toEqual([
      { kind: 'email', value_norm: 'hal@north.co' },
      { kind: 'linkedin_member', value_norm: 'ACoHal' },
    ]);
    const [p] = await t.db.sql<{ org_raw: string | null }>`
      select org_raw from orbit.people where id = ${r.byKey.get('b')!}::uuid`;
    expect(p!.org_raw).toBe('Northwind');
  });
});

describe('H: the identity lookup has its indexes', () => {
  it('three partial indexes on orbit.people, none unique', async () => {
    const rows = await t.db.sql<{ indexname: string; indexdef: string }>`
      select indexname, indexdef from pg_indexes
       where schemaname = 'orbit' and tablename = 'people'
         and indexname in ('people_primary_email_idx', 'people_linkedin_member_idx', 'people_linkedin_slug_idx')
       order by indexname`;
    expect(rows.map((r) => r.indexname)).toEqual([
      'people_linkedin_member_idx',
      'people_linkedin_slug_idx',
      'people_primary_email_idx',
    ]);
    for (const [i, column] of ['linkedin_member_id', 'linkedin_slug', 'primary_email'].entries()) {
      expect(rows[i]!.indexdef).toContain(`(user_id, ${column})`);
      expect(rows[i]!.indexdef).toMatch(
        new RegExp(`WHERE \\(+${column} IS NOT NULL\\) AND \\(deleted_at IS NULL\\)+`),
      );
      expect(rows[i]!.indexdef).not.toContain('UNIQUE');
    }
  });
});
