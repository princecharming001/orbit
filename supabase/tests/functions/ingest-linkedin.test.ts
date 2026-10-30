/**
 * LinkedIn through a fake Unipile, and entity resolution across providers (§1.8, §12.3, §12.8): an unconfigured or
 * unconnected account is skipped, relations become people with identities and employers, chats become threads with
 * the user's own messages outbound, webhooks store messages once, and the same person met on Gmail, LinkedIn and
 * Calendar is one person.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mergePeople, resolvePeople } from '../../functions/_shared/ingest/people.ts';
import { makeWebhookHandler } from '../../functions/orbit-webhooks/webhooks.ts';
import { defaultHandlers } from '../../functions/orbit-worker/worker.ts';
import { FakeUnipile, virtualTime } from '../helpers/fakeApis.ts';
import { clearQueues, connectedUser, drain, jobRuns } from '../helpers/ingest.ts';
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

const UNIPILE = { apiKey: 'unipile-key-placeholder', baseUrl: 'https://api.unipile.test' };

function setup(configured = true, extra: { jobBudgetMs?: number } = {}) {
  const time = virtualTime(NOW);
  const unipile = new FakeUnipile();
  const handlers = defaultHandlers({
    fetch: unipile.fetch,
    unipile: configured ? UNIPILE : undefined,
    clock: time.clock,
    sleep: time.sleep,
    random: () => 0,
    ...extra,
  });
  return { time, unipile, handlers };
}

const sync = (userId: string, payload: Record<string, unknown> = { mode: 'backfill' }) =>
  t.db.sql`select orbit.enqueue('orbit_sync', ${{ kind: 'sync.linkedin', userId, payload }}::jsonb, 0)`;

const person = async (u: string, where: { email?: string; member?: string }) => {
  const [p] = await t.db.sql<{
    id: string;
    display_name: string;
    org_raw: string | null;
    title: string | null;
  }>`
    select p.id, p.display_name, p.org_raw, p.title from orbit.people p
     where p.user_id = ${u}::uuid and p.merged_into is null and exists (
       select 1 from orbit.person_identities i where i.person_id = p.id
          and ((i.kind = 'email' and i.value_norm = ${where.email ?? ''})
            or (i.kind = 'linkedin_member' and i.value_norm = ${where.member ?? ''})))`;
  return p;
};

describe('sync.linkedin', () => {
  it('is skipped cleanly when Unipile is not configured, or the account is not connected', async () => {
    const u = await connectedUser(t.db, { linkedinAccount: 'acc-x' });
    await sync(u);
    await drain(t, setup(false).handlers, () => new Date(NOW));
    const v = await connectedUser(t.db);
    await sync(v);
    await drain(t, setup(true).handlers, () => new Date(NOW));
    expect(await jobRuns(t.db)).toEqual([
      { kind: 'sync.linkedin', status: 'skipped', error: 'unconfigured' },
      { kind: 'sync.linkedin', status: 'skipped', error: 'not_connected' },
    ]);
  });

  describe('a backfill', () => {
    let u: string;
    let env: ReturnType<typeof setup>;
    let runs: { kind: string; status: string }[];
    beforeAll(async () => {
      u = await connectedUser(t.db, { linkedinAccount: 'acc-maya' });
      env = setup();
      // known from Gmail first
      await resolvePeople(
        t.db,
        u,
        [{ key: 'p', email: 'priya.patel@figma.com', name: 'Priya Patel', source: 'gmail' }],
        { now: env.time.now() },
      );
      env.unipile.relationsPageSize = 2;
      env.unipile.relations = [
        {
          member_id: 'ACoPriya',
          public_identifier: 'priyapatel',
          public_profile_url: 'https://www.linkedin.com/in/priyapatel',
          first_name: 'Priya',
          last_name: 'Patel',
          headline: 'Product Designer at Figma',
          created_at: Date.parse(ago(300)),
        },
        {
          member_id: 'ACoJo',
          public_identifier: 'jo-park',
          first_name: 'Jo',
          last_name: 'Park',
          headline: 'Founder | building things',
          created_at: Date.parse(ago(40)),
        },
        {
          member_id: 'ACoKim',
          public_identifier: 'kim-li',
          first_name: 'Kim',
          last_name: 'Li',
          headline: 'Analyst at Goldman Sachs',
          created_at: Date.parse(ago(20)),
        },
      ];
      const self = { id: 'att-me', provider_id: 'ACoMaya', name: 'Maya Chen', is_self: 1 };
      env.unipile.chats = [
        {
          id: 'chat-priya',
          attendees: [self, { id: 'att-p', provider_id: 'ACoPriya', name: 'Priya Patel' }],
          messages: [
            {
              id: 'li-1',
              sender_id: 'ACoMaya',
              text: 'Hi Priya, loved your talk!',
              timestamp: ago(12),
              is_sender: 1,
            },
            {
              id: 'li-2',
              sender_id: 'ACoPriya',
              text: 'Thanks Maya! Happy to chat sometime.',
              timestamp: ago(11),
              is_sender: 0,
            },
            // marked as the user's by sender id alone
            { id: 'li-3', sender_id: 'ACoMaya', text: 'Would next Tuesday work?', timestamp: ago(11) },
          ],
        },
        {
          id: 'chat-trio',
          attendees: [
            self,
            { id: 'att-j', provider_id: 'ACoJo', name: 'Jo Park' },
            { id: 'att-k', provider_id: 'ACoKim', name: 'Kim Li' },
          ],
          messages: [{ id: 'li-4', sender_id: 'ACoJo', text: 'Kim, meet Maya!', timestamp: ago(30) }],
        },
        {
          id: 'chat-group',
          attendees: [
            self,
            ...['A', 'B', 'C', 'D'].map((x) => ({
              id: `att-${x}`,
              provider_id: `ACo${x}`,
              name: `Group ${x} Member`,
            })),
          ],
          messages: [{ id: 'li-5', sender_id: 'ACoA', text: 'Group hello', timestamp: ago(5) }],
        },
      ];
      await sync(u);
      await drain(t, env.handlers, env.time.now);
      runs = await jobRuns(t.db, u);
    });

    it('walks relations by cursor, then chats, at one request a second', async () => {
      const rels = env.unipile.calls.filter((c) => c.includes('/users/relations'));
      expect(rels).toHaveLength(2);
      expect(rels[0]).toContain('limit=50');
      expect(rels[1]).toContain('cursor=2');
      const chats = env.unipile.calls.find((c) => c.includes('/api/v1/chats?'))!;
      expect(chats).toContain('limit=250');
      expect(new URL(chats.split(' ')[1]!).searchParams.get('after')).toBe(
        new Date(NOW - 730 * 86_400_000).toISOString(),
      );
      // messages are read for the 1:1 and the three-way chat, not the group
      const msgs = env.unipile.calls.filter((c) => c.includes('/messages'));
      expect(msgs.map((c) => c.split('/chats/')[1]!.split('/')[0])).toEqual(['chat-priya', 'chat-trio']);
      expect(msgs[0]).toContain('limit=100');
      expect(runs.find((r) => r.kind === 'sync.linkedin')!.status).toBe('ok');
      const [a] = await t.db.sql<{ s: { linkedin: { stage: string; selfMemberId: string } } }>`
        select sync_state as s from orbit.integration_accounts where user_id = ${u}::uuid and provider = 'linkedin'`;
      expect(a!.s.linkedin).toMatchObject({ stage: 'done', selfMemberId: 'ACoMaya' });
    });

    it('the same person from Gmail and LinkedIn is one person (§12.8 test 5)', async () => {
      const byEmail = await person(u, { email: 'priya.patel@figma.com' });
      const byMember = await person(u, { member: 'ACoPriya' });
      expect(byEmail!.id).toBe(byMember!.id);
      const ids = await t.db.sql<{ kind: string; source: string }>`
        select kind, source from orbit.person_identities where person_id = ${byEmail!.id}::uuid order by kind`;
      expect(ids.map((i) => i.kind)).toEqual([
        'email',
        'linkedin_member',
        'linkedin_slug',
        'unipile_attendee',
      ]);
      expect(ids.find((i) => i.kind === 'linkedin_member')!.source).toBe('linkedin_relation');
    });

    it('relations carry the employer from the headline; the self person gets the member id', async () => {
      const kim = await person(u, { member: 'ACoKim' });
      expect(kim).toMatchObject({ display_name: 'Kim Li', org_raw: 'Goldman Sachs', title: 'Analyst' });
      const affs = await t.db.sql<{ org_raw: string; is_current: boolean; source: string }>`
        select org_raw, is_current, source from orbit.affiliations where person_id = ${kim!.id}::uuid`;
      expect(affs).toEqual([{ org_raw: 'Goldman Sachs', is_current: true, source: 'linkedin' }]);
      const jo = await person(u, { member: 'ACoJo' });
      expect(jo!.org_raw).toBeNull();
      const [self] = await t.db.sql<{ linkedin_member_id: string }>`
        select linkedin_member_id from orbit.people where user_id = ${u}::uuid and is_self`;
      expect(self!.linkedin_member_id).toBe('ACoMaya');
    });

    it('a relation carries the day they connected, so the browser counts them as known', async () => {
      const priya = await person(u, { member: 'ACoPriya' });
      const [row] = await t.db.sql<{ connected: Date }>`
        select linkedin_connected_on as connected from orbit.people where id = ${priya!.id}::uuid`;
      expect(new Date(row!.connected).toISOString()).toBe(new Date(ago(300)).toISOString());
    });

    it('stores chats as threads with the user’s own messages outbound, never inbound (§12.8 test 4)', async () => {
      const msgs = await t.db.sql<{ external_id: string; direction: string; from_person_id: string | null }>`
        select external_id, direction, from_person_id from orbit.messages
         where user_id = ${u}::uuid and provider = 'linkedin' order by external_id`;
      const priya = await person(u, { member: 'ACoPriya' });
      const jo = await person(u, { member: 'ACoJo' });
      expect(msgs).toEqual([
        { external_id: 'li-1', direction: 'out', from_person_id: null },
        { external_id: 'li-2', direction: 'in', from_person_id: priya!.id },
        { external_id: 'li-3', direction: 'out', from_person_id: null },
        { external_id: 'li-4', direction: 'in', from_person_id: jo!.id },
      ]);
      const threads = await t.db.sql<{
        external_id: string;
        participant_count: number;
        is_networking: boolean;
      }>`
        select external_id, participant_count, is_networking from orbit.threads
         where user_id = ${u}::uuid and provider = 'linkedin' order by external_id`;
      expect(threads).toEqual([
        { external_id: 'chat-priya', participant_count: 1, is_networking: true },
        { external_id: 'chat-trio', participant_count: 2, is_networking: true },
      ]);
    });

    it('classifies the inbound messages and scores the people it touched', async () => {
      expect(runs.filter((r) => r.kind === 'classify.message')).toHaveLength(2);
      const [s] = await t.db.sql<{ score: number; features: { linkedin: number } }>`
        select s.score, s.features from orbit.tie_scores s where s.user_id = ${u}::uuid
           and s.person_id = ${(await person(u, { member: 'ACoPriya' }))!.id}::uuid`;
      expect(s!.features.linkedin).toBe(1);
      expect(s!.score).toBeGreaterThan(15);
    });

    it('a job change closes the old employer and opens the new one (§1.7)', async () => {
      env.unipile.relations = [{ ...env.unipile.relations[2]!, headline: 'Associate at Blackstone' }];
      env.unipile.chats = [];
      await sync(u, { mode: 'sync' });
      await drain(t, env.handlers, env.time.now);
      const kim = await person(u, { member: 'ACoKim' });
      expect(kim!.org_raw).toBe('Blackstone');
      const affs = await t.db.sql<{ org_raw: string; is_current: boolean }>`
        select org_raw, is_current from orbit.affiliations where person_id = ${kim!.id}::uuid order by org_raw`;
      expect(affs).toEqual([
        { org_raw: 'Blackstone', is_current: true },
        { org_raw: 'Goldman Sachs', is_current: false },
      ]);
    });

    it('a sync soon after a full pass reads one page of the newest relations and no chats', async () => {
      // the app asks for a sync on every open; walking 6,000 relations and two years of chats again each time kept
      // the worker busy for hours and rewrote every person (the browser then pulled them all again)
      const before = env.unipile.calls.length;
      env.unipile.chats = [{ id: 'chat-new', attendees: [], messages: [] }];
      await sync(u, { mode: 'sync' });
      await drain(t, env.handlers, env.time.now);
      const calls = env.unipile.calls.slice(before);
      expect(calls.filter((c) => c.includes('/users/relations'))).toHaveLength(1);
      expect(calls.filter((c) => c.includes('/api/v1/chats'))).toHaveLength(0);
      const [a] = await t.db.sql<{ s: { linkedin: { stage: string; syncedAt: string } } }>`
        select sync_state as s from orbit.integration_accounts where user_id = ${u}::uuid and provider = 'linkedin'`;
      expect(a!.s.linkedin.stage).toBe('done');
      // the next pass is still measured from the last full one
      expect(Date.parse(a!.s.linkedin.syncedAt)).toBeLessThanOrEqual(NOW + 60_000);
    });

    it('a sync a day later walks everything again', async () => {
      env.time.advance(21 * 3_600_000);
      const before = env.unipile.calls.length;
      await sync(u, { mode: 'sync' });
      await drain(t, env.handlers, env.time.now);
      const calls = env.unipile.calls.slice(before);
      expect(calls.filter((c) => c.includes('/users/relations'))).toHaveLength(1);
      expect(calls.filter((c) => c.includes('/api/v1/chats?'))).toHaveLength(1);
    });
  });

  describe('the time budget', () => {
    it('a job hands back after its minute, saving its place, and the next one carries on', async () => {
      // filing a page of relations takes a minute or more; a job that only counted requests overstayed the worker
      // run, was killed without a trace, and was dead-lettered after eleven tries at the same page
      const u = await connectedUser(t.db, { linkedinAccount: 'acc-budget' });
      const env = setup(true, { jobBudgetMs: 1500 });
      env.unipile.relationsPageSize = 1;
      env.unipile.relations = ['Ada', 'Ben', 'Cal'].map((n) => ({
        member_id: `ACo${n}`,
        public_identifier: n.toLowerCase(),
        first_name: n,
        last_name: 'Budget',
        headline: `Engineer at ${n} Co`,
        created_at: Date.parse(ago(10)),
      }));
      env.unipile.chats = [];
      await sync(u, { mode: 'sync' });
      await drain(t, env.handlers, env.time.now);
      const runs = (await jobRuns(t.db, u)).filter((r) => r.kind === 'sync.linkedin');
      expect(runs.length).toBeGreaterThanOrEqual(2);
      expect(runs.every((r) => r.status === 'ok')).toBe(true);
      expect(env.unipile.calls.filter((c) => c.includes('/users/relations'))).toHaveLength(3);
      const [n] = await t.db.sql<{ n: number }>`
        select count(*)::int as n from orbit.people where user_id = ${u}::uuid and linkedin_connected_on is not null`;
      expect(n!.n).toBe(3);
      const [a] = await t.db.sql<{ s: { linkedin: { stage: string } } }>`
        select sync_state as s from orbit.integration_accounts where user_id = ${u}::uuid and provider = 'linkedin'`;
      expect(a!.s.linkedin.stage).toBe('done');
    });
  });
});

describe('Unipile webhooks', () => {
  const SECRET = 'unipile-secret-placeholder';
  const handler = () => makeWebhookHandler({ db: t.db, pubsubToken: 'x', unipileSecret: SECRET });
  const post = (body: unknown) =>
    handler()(
      new Request('https://ref.supabase.co/functions/v1/orbit-webhooks/unipile', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orbit-webhook': SECRET },
        body: JSON.stringify(body),
      }),
    );
  const event = (over: Record<string, unknown>) => ({
    event: 'message_received',
    account_id: 'acc-hook',
    account_type: 'LINKEDIN',
    account_info: { type: 'LINKEDIN', user_id: 'ACoMayaHook' },
    chat_id: 'chat-hook',
    message_id: 'hook-1',
    message: 'Hi Maya, are you free for a call on Thursday?',
    timestamp: ago(0, 1),
    sender: { attendee_id: 'att-r', attendee_name: 'Rosa Diaz', attendee_provider_id: 'ACoRosa' },
    attendees: [
      { attendee_id: 'att-me', attendee_name: 'Maya Chen', attendee_provider_id: 'ACoMayaHook' },
      { attendee_id: 'att-r', attendee_name: 'Rosa Diaz', attendee_provider_id: 'ACoRosa' },
    ],
    ...over,
  });

  it('stores a message from someone else and queues its classification, once (§12.8 test 3)', async () => {
    const u = await connectedUser(t.db, { linkedinAccount: 'acc-hook' });
    const first = await post(event({}));
    expect(await first.json()).toEqual({ ok: true, result: 'queued' });
    expect(await (await post(event({}))).json()).toEqual({ ok: true, result: 'duplicate' });
    const msgs = await t.db.sql<{ id: string; direction: string; body_text: string; from_person_id: string }>`
      select id, direction, body_text, from_person_id from orbit.messages where user_id = ${u}::uuid`;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      direction: 'in',
      body_text: 'Hi Maya, are you free for a call on Thursday?',
    });
    const rosa = await person(u, { member: 'ACoRosa' });
    expect(msgs[0]!.from_person_id).toBe(rosa!.id);
    const jobs = await t.db.sql<{ message: { kind: string; payload: Record<string, unknown> } }>`
      select message from pgmq.q_orbit_classify where message->>'userId' = ${u}`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.message.payload).toMatchObject({ messageRowId: msgs[0]!.id, messageId: 'hook-1' });
    // the worker classifies the stored message
    await drain(t, setup().handlers, () => new Date(NOW));
    const [m] = await t.db.sql<{
      reply_class: string;
    }>`select reply_class from orbit.messages where id = ${msgs[0]!.id}::uuid`;
    expect(m!.reply_class).toBe('scheduling');
  });

  it('stores the user’s own message as outbound and classifies nothing', async () => {
    const u = await connectedUser(t.db, { linkedinAccount: 'acc-own' });
    const r = await post(
      event({
        account_id: 'acc-own',
        message_id: 'hook-own',
        message: 'Thursday works, talk then!',
        sender: { attendee_id: 'att-me', attendee_name: 'Maya Chen', attendee_provider_id: 'ACoMayaHook' },
      }),
    );
    expect(await r.json()).toEqual({ ok: true, result: 'own_message' });
    const msgs = await t.db.sql<{ direction: string; to_person_ids: string[] }>`
      select direction, to_person_ids from orbit.messages where user_id = ${u}::uuid`;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.direction).toBe('out');
    expect(msgs[0]!.to_person_ids).toHaveLength(1);
    const jobs = await t.db.sql`select 1 from pgmq.q_orbit_classify where message->>'userId' = ${u}`;
    expect(jobs).toHaveLength(0);
  });
});

describe('entity resolution across providers (§1.8)', () => {
  it('1: Gmail, LinkedIn and a calendar invite resolve to one person with three identities', async () => {
    const u = await connectedUser(t.db);
    const now = new Date(NOW);
    await resolvePeople(
      t.db,
      u,
      [{ key: 'g', email: 'Liz.Chen+jobs@gmail.com', name: 'Liz Chen', source: 'gmail' }],
      {
        now,
      },
    );
    // the relation alone is a nickname and a surname: a new person and a merge suggestion
    const li = await resolvePeople(
      t.db,
      u,
      [
        {
          key: 'li',
          linkedinMemberId: 'ACoLiz',
          linkedinSlug: 'elizabeth-chen-12',
          firstName: 'Elizabeth',
          lastName: 'Chen',
          companyRaw: 'Stripe',
          source: 'linkedin',
          identitySource: 'linkedin_relation',
        },
      ],
      { now },
    );
    expect(li.created.size).toBe(1);
    const open = await t.db.sql<{
      status: string;
    }>`select status from orbit.merge_suggestions where user_id = ${u}::uuid`;
    expect(open).toEqual([{ status: 'open' }]);
    // the invite shows Liz's mailbox under the LinkedIn name: the same person
    const cal = await resolvePeople(
      t.db,
      u,
      [{ key: 'c', email: 'lizchen@gmail.com', name: 'Elizabeth Chen', source: 'calendar' }],
      { now },
    );
    expect(cal.merged.size).toBe(1);
    const live = await t.db.sql<{ id: string; org_raw: string | null }>`
      select id, org_raw from orbit.people where user_id = ${u}::uuid and not is_self and merged_into is null`;
    expect(live).toHaveLength(1);
    expect(live[0]!.org_raw).toBe('Stripe');
    const ids = await t.db.sql<{ kind: string; value_norm: string }>`
      select kind, value_norm from orbit.person_identities where person_id = ${live[0]!.id}::uuid order by kind`;
    expect(ids).toEqual([
      { kind: 'email', value_norm: 'lizchen@gmail.com' },
      { kind: 'linkedin_member', value_norm: 'ACoLiz' },
      { kind: 'linkedin_slug', value_norm: 'elizabeth-chen-12' },
    ]);
    const decided = await t.db.sql<{
      status: string;
    }>`select status from orbit.merge_suggestions where user_id = ${u}::uuid`;
    expect(decided).toEqual([{ status: 'merged' }]);
  });

  it('2: do_not_merge holds, even for a same-mailbox proof', async () => {
    const u = await connectedUser(t.db);
    const now = new Date(NOW);
    const a = await resolvePeople(
      t.db,
      u,
      [{ key: 'g', email: 'lizchen@gmail.com', name: 'Liz Chen', source: 'gmail' }],
      {
        now,
      },
    );
    const b = await resolvePeople(
      t.db,
      u,
      [
        {
          key: 'li',
          linkedinMemberId: 'ACoLiz2',
          firstName: 'Elizabeth',
          lastName: 'Chen',
          source: 'linkedin',
        },
      ],
      { now },
    );
    const liz = a.byKey.get('g')!;
    const eliz = b.byKey.get('li')!;
    const [x, y] = liz < eliz ? [liz, eliz] : [eliz, liz];
    await t.db
      .sql`insert into orbit.do_not_merge (user_id, person_a, person_b) values (${u}::uuid, ${x}::uuid, ${y}::uuid)`;
    const cal = await resolvePeople(
      t.db,
      u,
      [{ key: 'c', email: 'lizchen@gmail.com', name: 'Elizabeth Chen', source: 'calendar' }],
      { now },
    );
    expect(cal.byKey.get('c')).toBe(liz);
    expect(cal.merged.size).toBe(0);
    expect(await mergePeople(t.db, u, liz, eliz)).toBe(false);
    const live = await t.db.sql`
      select 1 from orbit.people where user_id = ${u}::uuid and not is_self and merged_into is null`;
    expect(live).toHaveLength(2);
  });

  it('role inboxes and automated senders never become people; an address seen twice is one person', async () => {
    const u = await connectedUser(t.db);
    const r = await resolvePeople(
      t.db,
      u,
      [
        { key: 'a', email: 'careers@stripe.com', name: 'Stripe Careers', source: 'gmail' },
        { key: 'b', email: 'noreply@lever.co', source: 'gmail' },
        { key: 'c', email: 'Sam.Rivera@gmail.com', name: 'Sam Rivera', source: 'gmail' },
        { key: 'd', email: 'samrivera@gmail.com', source: 'calendar' },
      ],
      { now: new Date(NOW) },
    );
    expect(r.byKey.get('a')).toBeUndefined();
    expect(r.byKey.get('b')).toBeUndefined();
    expect(r.byKey.get('c')).toBe(r.byKey.get('d'));
    expect(r.created.size).toBe(1);
  });
});
