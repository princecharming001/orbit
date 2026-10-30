/**
 * Gmail ingestion end to end on PGlite with a fake Gmail (§12.3, §12.8): the backfill over a realistic mailbox,
 * chained jobs over 1,200 messages within 90 quota units a second, resuming after a crash from the stored
 * pageToken, incremental history with the 404 recovery, the watch, send-as aliases and re-authentication.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NeedsReauth } from '../../functions/_shared/google.ts';
import { googleClient, QuotaPacer } from '../../functions/_shared/googleApi.ts';
import { defaultHandlers } from '../../functions/orbit-worker/worker.ts';
import { type Call, FakeGoogle, virtualTime } from '../helpers/fakeApis.ts';
import { clearQueues, connectedUser, drain, fakeTokens, jobRuns } from '../helpers/ingest.ts';
import { ago, bulkMailbox, fixtureMailbox, MAYA, NOW } from '../helpers/mailFixtures.ts';
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

function setup(o: { topic?: string } = {}) {
  const time = virtualTime(NOW);
  const google = new FakeGoogle(time, 'maya@example.com');
  google.sendAs = [
    { sendAsEmail: 'maya@example.com', isPrimary: true, verificationStatus: 'accepted' },
    { sendAsEmail: 'maya.chen@state.edu', isPrimary: false, verificationStatus: 'accepted' },
  ];
  const tokens = fakeTokens();
  const handlers = defaultHandlers({
    google: tokens,
    fetch: google.fetch,
    clock: time.clock,
    sleep: time.sleep,
    random: () => 0,
    gmailTopic: o.topic,
  });
  return { time, google, tokens, handlers };
}

async function startBackfill(userId: string) {
  await t.db.sql`select orbit.enqueue('orbit_sync', ${{
    kind: 'sync.gmail.backfill',
    userId,
    payload: { phase: 'recent' },
    dedupeKey: `gmail-backfill:${userId}:recent`,
  }}::jsonb, 0)`;
}

const people = (u: string) =>
  t.db.sql<{ id: string; display_name: string; primary_email: string | null; do_not_contact: boolean }>`
    select id, display_name, primary_email, do_not_contact from orbit.people
     where user_id = ${u}::uuid and not is_self and merged_into is null order by display_name`;

describe('the Gmail backfill over a fixture mailbox', () => {
  let u: string;
  let env: ReturnType<typeof setup>;
  let kinds: string[];
  beforeAll(async () => {
    u = await connectedUser(t.db, { email: 'maya@example.com' });
    env = setup({ topic: 'projects/orbit-test/topics/orbit-gmail' });
    env.google.add(...fixtureMailbox());
    await startBackfill(u);
    await drain(t, env.handlers, env.time.now);
    kinds = (await jobRuns(t.db, u)).map((r) => `${r.kind}:${r.status}`);
  });

  it('runs recent, then deep, then completes, saving progress and the history id', async () => {
    const [a] = await t.db.sql<{
      sync_state: { gmail: { historyId: string; backfill: { phase: string; done: number; total: number } } };
      watch_expires_at: Date | null;
      last_synced_at: Date | null;
    }>`select sync_state, watch_expires_at, last_synced_at from orbit.integration_accounts
        where user_id = ${u}::uuid and provider = 'google'`;
    expect(a!.sync_state.gmail.historyId).toBe('5000');
    expect(a!.sync_state.gmail.backfill.phase).toBe('complete');
    expect(a!.watch_expires_at).not.toBeNull();
    expect(a!.last_synced_at).not.toBeNull();
    const watch = env.google.calls.find((c) => c.url.endsWith('/watch'))!;
    expect(JSON.parse(watch.body)).toEqual({
      topicName: 'projects/orbit-test/topics/orbit-gmail',
      labelIds: ['INBOX', 'SENT'],
      labelFilterBehavior: 'include',
    });
    expect(kinds.filter((k) => k.startsWith('sync.gmail.backfill'))).toEqual([
      'sync.gmail.backfill:ok',
      'sync.gmail.backfill:ok',
    ]);
    // the first backfill also starts the calendar and contacts syncs, and the end of it the nightly score
    for (const k of [
      'sync.calendar:ok',
      'sync.contacts:ok',
      'score.user:ok',
      'score.person:ok',
      'classify.message:ok',
    ])
      expect(kinds).toContain(k);
  });

  it('classifies the replies it reads from the history but drafts no answer to them', async () => {
    // mail from before Orbit: a new account starts with no drafts, however many replies the backfill finds
    const answerable = await t.db.sql<{ reply_class: string }>`
      select reply_class from orbit.messages
       where user_id = ${u}::uuid and direction = 'in'
         and reply_class in ('interested', 'scheduling', 'question', 'objection', 'referral', 'not_now', 'decline')`;
    expect(answerable.length).toBeGreaterThan(0);
    const [n] = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.drafts where user_id = ${u}::uuid`;
    expect(n!.n).toBe(0);
  });

  it('asks for metadata first, and full threads only for networking candidates', async () => {
    const lists = env.google.calls.filter((c) => /\/users\/me\/messages\?/.test(c.url));
    expect(new URL(lists[0]!.url).searchParams.get('q')).toBe('newer_than:90d -in:chats');
    expect(new URL(lists[1]!.url).searchParams.get('q')).toMatch(/^after:\d+ before:\d+ -in:chats$/);
    const get = env.google.calls.find((c) => /\/messages\/m-priya-1/.test(c.url))!;
    const q = new URL(get.url).searchParams;
    expect(q.get('format')).toBe('metadata');
    expect(q.getAll('metadataHeaders')).toEqual([
      'From',
      'To',
      'Cc',
      'Date',
      'Subject',
      'Message-ID',
      'In-Reply-To',
      'References',
      'List-Unsubscribe',
      'Auto-Submitted',
      'Precedence',
    ]);
    const threads = env.google.calls
      .filter((c) => c.url.includes('/threads/'))
      .map((c) => decodeURIComponent(new URL(c.url).pathname.split('/').pop()!))
      .sort();
    // the user wrote in these; the ATS mail, the newsletter and the club thread (no known person) are not read
    expect(threads).toEqual(['T-alias', 'T-dan', 'T-intro', 'T-priya']);
  });

  it('makes people from human mail only: never applicant-tracking, newsletter or role senders', async () => {
    const ps = await people(u);
    const emails = ps.map((p) => p.primary_email);
    expect(emails).toEqual(
      expect.arrayContaining([
        'priya.patel@figma.com',
        'sam@riveralabs.io',
        'lena@acme.vc',
        'dan@foxco.com',
        'alex.kim@state.edu',
        'ghopper@state.edu',
      ]),
    );
    expect(emails).not.toContain('no-reply@greenhouse.io');
    expect(emails).not.toContain('jordan@ashbyhq.com');
    expect(emails).not.toContain('hello@briefnews.co');
    expect(ps.find((p) => p.primary_email === 'priya.patel@figma.com')!.display_name).toBe('Priya Patel');
    // mail that involves no one in the graph is not kept at all
    const ats = await t.db.sql`
      select 1 from orbit.messages where user_id = ${u}::uuid and external_id in ('m-ats-1', 'm-ats-2', 'm-news-1')`;
    expect(ats).toHaveLength(0);
  });

  it('stores threads with aggregates, bodies only for networking threads, quotes stripped', async () => {
    const threads = await t.db.sql<{
      external_id: string;
      is_networking: boolean;
      message_count: number;
      participant_count: number;
      last_direction: string;
      category: string | null;
    }>`select external_id, is_networking, message_count, participant_count, last_direction, category
         from orbit.threads where user_id = ${u}::uuid order by external_id`;
    const byId = Object.fromEntries(threads.map((x) => [x.external_id, x]));
    expect(byId['T-priya']).toMatchObject({
      is_networking: true,
      message_count: 3,
      participant_count: 1,
      last_direction: 'out',
    });
    expect(byId['T-intro']).toMatchObject({ is_networking: true, message_count: 3, participant_count: 2 });
    expect(byId['T-club']).toMatchObject({ is_networking: false, message_count: 3, participant_count: 12 });
    const msgs = await t.db.sql<{ external_id: string; direction: string; body_text: string | null }>`
      select external_id, direction, body_text from orbit.messages where user_id = ${u}::uuid order by external_id`;
    const m = Object.fromEntries(msgs.map((x) => [x.external_id, x]));
    expect(m['m-priya-2']!.direction).toBe('in');
    expect(m['m-priya-2']!.body_text).toContain('Would Tuesday at 2pm ET work?');
    expect(m['m-priya-2']!.body_text).not.toContain('> Hi Priya');
    expect(m['m-club-1']!.body_text).toBeNull();
    // a message from a send-as alias is the user's own
    expect(m['m-alias-1']!.direction).toBe('out');
  });

  it('attaches the send-as aliases to the one self person (§1.8 test 5)', async () => {
    const self = await t.db.sql<{
      id: string;
    }>`select id from orbit.people where user_id = ${u}::uuid and is_self`;
    expect(self).toHaveLength(1);
    const ids = await t.db.sql<{ value_norm: string }>`
      select value_norm from orbit.person_identities
       where user_id = ${u}::uuid and person_id = ${self[0]!.id}::uuid and kind = 'email' order by value_norm`;
    expect(ids.map((i) => i.value_norm)).toEqual(['maya.chen@state.edu', 'maya@example.com']);
  });

  it('records the introduction and the exchange between introducer and introduced', async () => {
    const ps = await people(u);
    const lena = ps.find((p) => p.primary_email === 'lena@acme.vc')!.id;
    const sam = ps.find((p) => p.primary_email === 'sam@riveralabs.io')!.id;
    const ties = await t.db.sql<{
      kind: string;
      weight: number;
      confidence: number;
      evidence: { introducerId?: string };
    }>`
      select kind, weight, confidence, evidence from orbit.ties
       where user_id = ${u}::uuid and least(a_person_id, b_person_id) = least(${lena}::uuid, ${sam}::uuid)
         and greatest(a_person_id, b_person_id) = greatest(${lena}::uuid, ${sam}::uuid)
       order by kind`;
    const kinds = ties.map((x) => x.kind);
    expect(kinds).toContain('email_exchange');
    expect(kinds).toContain('introduced_by');
    expect(ties.find((x) => x.kind === 'email_exchange')!.confidence).toBeCloseTo(0.95, 5);
    expect(ties.find((x) => x.kind === 'introduced_by')!.evidence.introducerId).toBe(lena);
  });

  it('the 12-person thread yields no ties among its people (§2.8 test 1)', async () => {
    const club = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.ties t
        join orbit.people a on a.id = t.a_person_id join orbit.people b on b.id = t.b_person_id
       where t.user_id = ${u}::uuid and a.primary_email like '%@state.edu' and b.primary_email like '%@state.edu'
         and t.kind like 'email%'`;
    expect(club[0]!.n).toBe(0);
  });

  it('classifies replies: "remove me" sets do_not_contact; times proposed read as scheduling', async () => {
    const ps = await people(u);
    expect(ps.find((p) => p.primary_email === 'dan@foxco.com')!.do_not_contact).toBe(true);
    const cls = await t.db.sql<{ external_id: string; reply_class: string | null }>`
      select external_id, reply_class from orbit.messages
       where user_id = ${u}::uuid and external_id in ('m-dan-2', 'm-priya-2', 'm-intro-2') order by external_id`;
    expect(Object.fromEntries(cls.map((c) => [c.external_id, c.reply_class]))).toEqual({
      'm-dan-2': 'unsubscribe',
      'm-intro-2': 'scheduling',
      'm-priya-2': 'scheduling',
    });
  });

  it('scores the people: a two-way thread beats a one-way "remove me", and ATS mail counts for nothing', async () => {
    const scores = await t.db.sql<{ email: string; score: number; strength: number }>`
      select p.primary_email as email, s.score, p.strength from orbit.tie_scores s
        join orbit.people p on p.id = s.person_id where s.user_id = ${u}::uuid`;
    const by = Object.fromEntries(scores.map((s) => [s.email, s]));
    expect(by['priya.patel@figma.com']!.score).toBeGreaterThan(by['dan@foxco.com']!.score);
    expect(by['priya.patel@figma.com']!.strength).toBeCloseTo(by['priya.patel@figma.com']!.score / 100, 2);
    expect(by['member1@state.edu']!.score).toBeLessThan(20);
  });

  it('a second backfill request after completion does nothing; re-running a page stores nothing twice', async () => {
    const before = await t.db.sql<{
      n: number;
    }>`select count(*)::int as n from orbit.messages where user_id = ${u}::uuid`;
    await startBackfill(u);
    await drain(t, env.handlers, env.time.now);
    const after = await t.db.sql<{
      n: number;
    }>`select count(*)::int as n from orbit.messages where user_id = ${u}::uuid`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});

describe('chained backfill of 1,200 messages', () => {
  it('pages through in jobs of ≤ 250, never above 90 units a second, and resumes after a crash', async () => {
    const u = await connectedUser(t.db);
    const env = setup();
    env.google.add(...bulkMailbox(1200));
    let crashed = false;
    let crashedOn: string | null = null;
    env.google.intercept = (c: Call) => {
      // the job working on the third page dies half-way through its metadata reads
      const lists = env.google.calls.filter((x) => /\/users\/me\/messages\?/.test(x.url));
      if (!crashed && lists.length === 3 && /\/messages\/bulk-/.test(c.url)) {
        const n = env.google.calls.filter(
          (x) => /\/messages\/bulk-/.test(x.url) && x.at >= lists[2]!.at,
        ).length;
        if (n === 100) {
          crashed = true;
          crashedOn = new URL(lists[2]!.url).searchParams.get('pageToken');
          throw new TypeError('connection reset');
        }
      }
      return undefined;
    };
    await startBackfill(u);
    await drain(t, env.handlers, env.time.now, { maxTicks: 60 });

    expect(crashed).toBe(true);
    const runs = (await jobRuns(t.db, u)).filter((r) => r.kind === 'sync.gmail.backfill');
    expect(runs.filter((r) => r.status === 'error')).toHaveLength(1);
    expect(runs.filter((r) => r.status === 'ok').length).toBeGreaterThanOrEqual(5);
    // the retried job asked for the same page again
    const lists = env.google.calls.filter((c) => /\/users\/me\/messages\?/.test(c.url));
    const tokens = lists.map((c) => new URL(c.url).searchParams.get('pageToken'));
    expect(tokens.filter((x) => x === crashedOn)).toHaveLength(2);
    for (const c of lists)
      expect(Number(new URL(c.url).searchParams.get('maxResults'))).toBeLessThanOrEqual(250);

    const [{ n }] = (await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.messages where user_id = ${u}::uuid`) as [{ n: number }];
    expect(n).toBe(1200);
    // each message was read once except those the crashed job had already read
    const gets = env.google.calls.filter((c) => /\/messages\/bulk-/.test(c.url));
    expect(gets.length).toBeLessThanOrEqual(1200 + 105);
    expect(env.google.peakUnitsPerSecond()).toBeLessThanOrEqual(90);
    const [a] = await t.db.sql<{ s: { gmail: { backfill: { phase: string; done: number } } } }>`
      select sync_state as s from orbit.integration_accounts where user_id = ${u}::uuid and provider = 'google'`;
    expect(a!.s.gmail.backfill.phase).toBe('complete');
  }, 240_000);
});

describe('incremental sync', () => {
  it('reads new messages from history and advances the history id', async () => {
    const u = await connectedUser(t.db);
    const env = setup();
    env.google.add(...fixtureMailbox().filter((m) => m.threadId === 'T-priya'));
    await startBackfill(u);
    await drain(t, env.handlers, env.time.now);
    env.google.add({
      id: 'm-priya-4',
      threadId: 'T-priya',
      from: 'Priya Patel <priya.patel@figma.com>',
      to: [MAYA],
      subject: 'Re: Coffee chat about product design at Figma?',
      body: 'Great talking today! Happy to introduce you to our design lead.',
      at: ago(0, 2),
    });
    env.google.history.push({ id: '5001', messages: ['m-priya-4'] });
    env.google.historyId = 5001;
    await t.db
      .sql`select orbit.enqueue('orbit_sync', ${{ kind: 'sync.gmail.incremental', userId: u, payload: { reason: 'poll' } }}::jsonb, 0)`;
    await drain(t, env.handlers, env.time.now);
    const [m] = await t.db.sql<{ direction: string; reply_class: string | null; body_text: string | null }>`
      select direction, reply_class, body_text from orbit.messages where user_id = ${u}::uuid and external_id = 'm-priya-4'`;
    expect(m).toMatchObject({ direction: 'in' });
    expect(m!.body_text).toContain('Great talking today');
    expect(m!.reply_class).not.toBeNull();
    const [a] = await t.db.sql<{ s: { gmail: { historyId: string } } }>`
      select sync_state as s from orbit.integration_accounts where user_id = ${u}::uuid and provider = 'google'`;
    expect(a!.s.gmail.historyId).toBe('5001');
  });

  it('a 404 from history.list runs a 30-day recovery and resets the history id (§12.8 test 2)', async () => {
    const u = await connectedUser(t.db);
    const env = setup();
    env.google.add(...fixtureMailbox().filter((m) => m.threadId === 'T-priya'));
    await startBackfill(u);
    await drain(t, env.handlers, env.time.now);
    // a week offline: the stored history id has expired
    env.google.historyFloor = 9000;
    env.google.historyId = 9100;
    env.google.add({
      id: 'm-late',
      threadId: 'T-priya',
      from: 'Priya Patel <priya.patel@figma.com>',
      to: [MAYA],
      subject: 'Re: Coffee chat',
      body: 'Following up with the link I mentioned.',
      at: ago(1),
    });
    await t.db
      .sql`select orbit.enqueue('orbit_sync', ${{ kind: 'sync.gmail.incremental', userId: u, payload: { reason: 'poll' } }}::jsonb, 0)`;
    await drain(t, env.handlers, env.time.now);
    const recovery = env.google.calls.filter((c) =>
      new URL(c.url).searchParams.get('q')?.startsWith('newer_than:30d'),
    );
    expect(recovery).toHaveLength(1);
    const [a] = await t.db.sql<{ s: { gmail: { historyId: string; backfill: { phase: string } } } }>`
      select sync_state as s from orbit.integration_accounts where user_id = ${u}::uuid and provider = 'google'`;
    expect(a!.s.gmail.historyId).toBe('9100');
    expect(a!.s.gmail.backfill.phase).toBe('complete');
    const late = await t.db
      .sql`select 1 from orbit.messages where user_id = ${u}::uuid and external_id = 'm-late'`;
    expect(late).toHaveLength(1);
  });

  it('renewWatch without a topic skips the watch quietly', async () => {
    const u = await connectedUser(t.db);
    const env = setup();
    await t.db
      .sql`update orbit.integration_accounts set sync_state = '{"gmail":{"historyId":"5000","backfill":{"phase":"complete"}}}'::jsonb
      where user_id = ${u}::uuid and provider = 'google'`;
    await t.db
      .sql`select orbit.enqueue('orbit_sync', ${{ kind: 'sync.gmail.incremental', userId: u, payload: { renewWatch: true } }}::jsonb, 0)`;
    await drain(t, env.handlers, env.time.now);
    expect(env.google.calls.some((c) => c.url.endsWith('/watch'))).toBe(false);
    expect((await jobRuns(t.db, u)).map((r) => r.status)).toEqual(['ok']);
  });
});

describe('pacing, retries and re-authentication', () => {
  it('the per-user bucket keeps 90 units in any second and 5 requests in flight', async () => {
    const time = virtualTime(0);
    const pacer = new QuotaPacer({ clock: time.clock, sleep: time.sleep });
    const starts: { at: number; units: number }[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        pacer.run(i % 3 === 0 ? 40 : 20, async () => {
          starts.push({ at: time.clock(), units: i % 3 === 0 ? 40 : 20 });
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await time.sleep(50);
          inFlight--;
        }),
      ),
    );
    expect(starts).toHaveLength(60);
    expect(maxInFlight).toBeLessThanOrEqual(5);
    for (const s of starts) {
      const window = starts
        .filter((x) => x.at > s.at - 1000 && x.at <= s.at)
        .reduce((a, x) => a + x.units, 0);
      expect(window).toBeLessThanOrEqual(90);
    }
  });

  it('retries 429 and 5xx honouring Retry-After, then gives up with the status', async () => {
    const time = virtualTime(0);
    let n = 0;
    const fetch = (async () => {
      n++;
      if (n === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '7' } });
      if (n === 2) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as typeof globalThis.fetch;
    const c = googleClient({
      tokens: fakeTokens(),
      fetch,
      clock: time.clock,
      sleep: time.sleep,
      random: () => 0,
    });
    expect(await c.request('u1', { url: 'https://gmail.googleapis.com/x', units: 1 })).toEqual({ ok: 1 });
    expect(n).toBe(3);
    // 7 s from Retry-After, then 2 s backoff for the second attempt
    expect(time.clock()).toBe(9000);
    const always = (async () => new Response('{}', { status: 500 })) as typeof globalThis.fetch;
    const c2 = googleClient({ tokens: fakeTokens(), fetch: always, clock: time.clock, sleep: time.sleep });
    await expect(c2.request('u1', { url: 'https://gmail.googleapis.com/x', units: 1 })).rejects.toMatchObject(
      {
        status: 500,
      },
    );
  });

  it('a 401 refreshes the token once; a second 401 marks the account needs_reauth and skips the job', async () => {
    const u = await connectedUser(t.db);
    const env = setup();
    env.google.unauthorized = true;
    await startBackfill(u);
    await drain(t, env.handlers, env.time.now);
    expect(env.tokens.invalidated).toBe(1);
    expect(env.google.calls).toHaveLength(2);
    const [a] = await t.db.sql<{ status: string }>`
      select status from orbit.integration_accounts where user_id = ${u}::uuid and provider = 'google'`;
    expect(a!.status).toBe('needs_reauth');
    expect(await jobRuns(t.db, u)).toEqual([
      { kind: 'sync.gmail.backfill', status: 'skipped', error: 'needs_reauth' },
    ]);
    const c = googleClient({ tokens: fakeTokens(), fetch: env.google.fetch });
    await expect(
      c.request(u, { url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile', units: 1 }),
    ).rejects.toBeInstanceOf(NeedsReauth);
  });

  it('without Google configured the jobs end skipped, not failed', async () => {
    const u = await connectedUser(t.db);
    await startBackfill(u);
    await drain(t, defaultHandlers({}), () => new Date(NOW));
    expect(await jobRuns(t.db, u)).toEqual([
      { kind: 'sync.gmail.backfill', status: 'skipped', error: 'unconfigured' },
    ]);
  });
});
