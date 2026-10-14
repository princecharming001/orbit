/**
 * Calendar and contacts sync on PGlite with a fake Google (§12.3): the initial window, people from attendees (not
 * from big events, declined attendees or rooms), one-on-ones, co-attendance ties, the sync token, the 410 resync,
 * and contacts naming people known only by their address.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CalendarApiEvent } from '../../functions/_shared/calendar.ts';
import { resolvePeople } from '../../functions/_shared/ingest/people.ts';
import { defaultHandlers } from '../../functions/orbit-worker/worker.ts';
import { FakeGoogle, virtualTime } from '../helpers/fakeApis.ts';
import { clearQueues, connectedUser, drain, fakeTokens, jobRuns } from '../helpers/ingest.ts';
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

function setup(email: string) {
  const time = virtualTime(NOW);
  const google = new FakeGoogle(time, email);
  const handlers = defaultHandlers({
    google: fakeTokens(),
    fetch: google.fetch,
    clock: time.clock,
    sleep: time.sleep,
    random: () => 0,
  });
  return { time, google, handlers };
}

const ev = (
  id: string,
  at: string,
  attendees: CalendarApiEvent['attendees'],
  extra: Partial<CalendarApiEvent> = {},
): CalendarApiEvent => ({
  id,
  status: 'confirmed',
  summary: `Event ${id}`,
  start: { dateTime: at },
  end: { dateTime: new Date(Date.parse(at) + 30 * 60_000).toISOString() },
  attendees,
  ...extra,
});

const enqueue = (userId: string, payload: Record<string, unknown> = {}, kind = 'sync.calendar') =>
  t.db.sql`select orbit.enqueue('orbit_sync', ${{ kind, userId, payload }}::jsonb, 0)`;

describe('sync.calendar', () => {
  let u: string;
  let env: ReturnType<typeof setup>;
  const me = { email: 'maya.cal@example.com', self: true, responseStatus: 'accepted' };
  beforeAll(async () => {
    u = await connectedUser(t.db, { email: me.email });
    env = setup(me.email);
    const big = Array.from({ length: 20 }, (_, i) => ({
      email: `staff${i}@bigco.com`,
      displayName: `Staff ${i} Person`,
      responseStatus: 'accepted',
    }));
    env.google.events = [
      ev(
        'e-priya',
        ago(10),
        [me, { email: 'priya.patel@figma.com', displayName: 'Priya Patel', responseStatus: 'accepted' }],
        {
          hangoutLink: 'https://meet.google.com/abc-defg-hij',
        },
      ),
      ev('e-trio', ago(20), [
        me,
        { email: 'ana@acme.com', displayName: 'Ana Diaz', responseStatus: 'accepted' },
        { email: 'ben@acme.com', displayName: 'Ben Ode', responseStatus: 'accepted' },
        { email: 'room-4b@resource.calendar.google.com', displayName: 'Room 4B', resource: true },
      ]),
      ev('e-declined', ago(15), [
        me,
        { email: 'cara@acme.com', displayName: 'Cara Moss', responseStatus: 'declined' },
        { email: 'dev@acme.com', displayName: 'Dev Rao', responseStatus: 'accepted' },
      ]),
      ev('e-allhands', ago(5), [me, ...big]),
      ev(
        'e-exec',
        ago(3),
        [me, { email: 'exec@bigco.com', displayName: 'Erin Exec', responseStatus: 'accepted' }],
        { organizer: { email: 'assistant@bigco.com' } },
      ),
      ev('e-future', new Date(NOW + 5 * 86_400_000).toISOString(), [
        me,
        { email: 'priya.patel@figma.com', displayName: 'Priya Patel', responseStatus: 'needsAction' },
      ]),
    ];
    await enqueue(u);
    await drain(t, env.handlers, env.time.now);
  });

  it('reads the 2-year window once and saves the sync token', async () => {
    const reads = env.google.calls.filter((c) => c.url.includes('/calendar/v3/'));
    expect(reads).toHaveLength(1);
    const q = new URL(reads[0]!.url).searchParams;
    expect(q.get('singleEvents')).toBe('true');
    expect(q.get('maxResults')).toBe('2500');
    expect(Date.parse(q.get('timeMin')!)).toBe(NOW - 730 * 86_400_000);
    expect(Date.parse(q.get('timeMax')!)).toBe(NOW + 90 * 86_400_000);
    const [a] = await t.db.sql<{ s: { calendar: { syncToken: string } } }>`
      select sync_state as s from orbit.integration_accounts where user_id = ${u}::uuid and provider = 'google'`;
    expect(a!.s.calendar.syncToken).toBe('cal-sync-1');
  });

  it('stores events with attendees, one-on-ones and conference links; rooms dropped', async () => {
    const rows = await t.db.sql<{
      external_id: string;
      attendee_count: number;
      is_one_on_one: boolean;
      conference_url: string | null;
      attendee_person_ids: string[];
    }>`select external_id, attendee_count, is_one_on_one, conference_url, attendee_person_ids
         from orbit.calendar_events where user_id = ${u}::uuid order by external_id`;
    const by = Object.fromEntries(rows.map((r) => [r.external_id, r]));
    expect(by['e-priya']).toMatchObject({
      attendee_count: 2,
      is_one_on_one: true,
      conference_url: 'https://meet.google.com/abc-defg-hij',
    });
    expect(by['e-trio']).toMatchObject({ attendee_count: 3, is_one_on_one: false });
    expect(by['e-trio']!.attendee_person_ids).toHaveLength(2);
    // a declined attendee is kept in the attendee list but not linked
    expect(by['e-declined']!.attendee_person_ids).toHaveLength(1);
    // an all-hands creates no one
    expect(by['e-allhands']!.attendee_person_ids).toEqual([]);
  });

  it('makes people from small meetings only, never the assistant who organized', async () => {
    const ps = await t.db.sql<{ primary_email: string; display_name: string; sources: string[] }>`
      select primary_email, display_name, sources from orbit.people where user_id = ${u}::uuid and not is_self
       order by primary_email`;
    expect(ps.map((p) => p.primary_email)).toEqual([
      'ana@acme.com',
      'ben@acme.com',
      'cara@acme.com',
      'dev@acme.com',
      'exec@bigco.com',
      'priya.patel@figma.com',
    ]);
    expect(ps[0]).toMatchObject({ display_name: 'Ana Diaz', sources: ['calendar'] });
  });

  it('co-attendance becomes a meeting tie; meetings count toward the score (§2.3)', async () => {
    const ties = await t.db.sql<{ kind: string; confidence: number; a: string; b: string }>`
      select t.kind, t.confidence, a.primary_email as a, b.primary_email as b from orbit.ties t
        join orbit.people a on a.id = t.a_person_id join orbit.people b on b.id = t.b_person_id
       where t.user_id = ${u}::uuid`;
    expect(ties).toHaveLength(1);
    expect(ties[0]!.kind).toBe('meeting_coattendee');
    expect([ties[0]!.a, ties[0]!.b].sort()).toEqual(['ana@acme.com', 'ben@acme.com']);
    expect(ties[0]!.confidence).toBeCloseTo(0.8, 5);
    // the nightly run scores everyone, the declined attendee included
    await enqueue(u, {}, 'score.user');
    await drain(t, env.handlers, env.time.now);
    const [s] = await t.db.sql<{ score: number }>`
      select s.score from orbit.tie_scores s join orbit.people p on p.id = s.person_id
       where s.user_id = ${u}::uuid and p.primary_email = 'priya.patel@figma.com'`;
    const [never] = await t.db.sql<{ score: number }>`
      select s.score from orbit.tie_scores s join orbit.people p on p.id = s.person_id
       where s.user_id = ${u}::uuid and p.primary_email = 'cara@acme.com'`;
    expect(s!.score).toBeGreaterThan(never!.score);
  });

  it('later runs read with the sync token only; a cancellation keeps the row as cancelled', async () => {
    env.google.changedEvents = [{ id: 'e-trio', status: 'cancelled' }];
    await enqueue(u, { reason: 'poll' });
    await drain(t, env.handlers, env.time.now);
    const reads = env.google.calls.filter((c) => c.url.includes('/calendar/v3/'));
    const q = new URL(reads.at(-1)!.url).searchParams;
    expect(q.get('syncToken')).toBe('cal-sync-1');
    expect(q.get('timeMin')).toBeNull();
    const [row] = await t.db.sql<{ status: string }>`
      select status from orbit.calendar_events where user_id = ${u}::uuid and external_id = 'e-trio'`;
    expect(row!.status).toBe('cancelled');
  });

  it('a 410 Gone runs a full resync', async () => {
    env.google.calendarTokenValid = false;
    const before = env.google.calls.length;
    await enqueue(u, { reason: 'poll' });
    await drain(t, env.handlers, env.time.now);
    const reads = env.google.calls.slice(before).filter((c) => c.url.includes('/calendar/v3/'));
    expect(reads).toHaveLength(2);
    expect(new URL(reads[0]!.url).searchParams.get('syncToken')).toBe('cal-sync-1');
    expect(new URL(reads[1]!.url).searchParams.get('timeMin')).not.toBeNull();
    expect((await jobRuns(t.db, u)).map((r) => r.status)).toContain('ok');
    const [a] = await t.db.sql<{ s: { calendar: { syncToken: string; fullSyncAt: string } } }>`
      select sync_state as s from orbit.integration_accounts where user_id = ${u}::uuid and provider = 'google'`;
    expect(a!.s.calendar.syncToken).toBe('cal-sync-1');
    expect(a!.s.calendar.fullSyncAt).toBeTruthy();
  });

  it('a booked meeting with an intro target moves the request to meeting (§4.3)', async () => {
    const [ana] = await t.db.sql<{ id: string }>`
      select id from orbit.people where user_id = ${u}::uuid and primary_email = 'ana@acme.com'`;
    const [ben] = await t.db.sql<{ id: string }>`
      select id from orbit.people where user_id = ${u}::uuid and primary_email = 'ben@acme.com'`;
    await t.db.sql`
      insert into orbit.intro_requests (user_id, target_person_id, introducer_person_id, path, path_score, rank,
                                        status, asked_at)
      values (${u}::uuid, ${ana!.id}::uuid, ${ben!.id}::uuid, '{}'::jsonb, 0.4, 1, 'agreed', ${ago(2)}::timestamptz)`;
    env.google.changedEvents = [
      ev('e-ana', new Date(NOW + 2 * 86_400_000).toISOString(), [
        { email: 'maya.cal@example.com', self: true },
        { email: 'ana@acme.com', displayName: 'Ana Diaz', responseStatus: 'accepted' },
      ]),
    ];
    await enqueue(u, { reason: 'poll' });
    await drain(t, env.handlers, env.time.now);
    const [r] = await t.db.sql<{ status: string }>`
      select status from orbit.intro_requests where user_id = ${u}::uuid`;
    expect(r!.status).toBe('meeting');
  });
});

describe('sync.contacts', () => {
  it('names people known only by address, never creates people, and lists again after an expired token', async () => {
    const email = 'maya.contacts@example.com';
    const u = await connectedUser(t.db, { email });
    const env = setup(email);
    const now = env.time.now();
    await resolvePeople(
      t.db,
      u,
      [
        { key: 'tom', email: 'tom.wu@gmail.com', source: 'gmail' },
        { key: 'priya', email: 'priya@figma.com', name: 'Priya Patel', source: 'gmail' },
      ],
      { now },
    );
    env.google.otherContacts = [
      { names: [{ displayName: 'Tom Wu' }], emailAddresses: [{ value: 'Tom.Wu@gmail.com' }] },
      { names: [{ displayName: 'Priya P.' }], emailAddresses: [{ value: 'priya@figma.com' }] },
      { names: [{ displayName: 'Stranger Danger' }], emailAddresses: [{ value: 'stranger@x.com' }] },
    ];
    await enqueue(u, {}, 'sync.contacts');
    await drain(t, env.handlers, env.time.now);
    const ps = await t.db.sql<{ primary_email: string; display_name: string }>`
      select primary_email, display_name from orbit.people where user_id = ${u}::uuid and not is_self
       order by primary_email`;
    expect(ps).toEqual([
      { primary_email: 'priya@figma.com', display_name: 'Priya Patel' },
      { primary_email: 'tomwu@gmail.com', display_name: 'Tom Wu' },
    ]);
    const reads = env.google.calls.filter((c) => c.url.includes('people.googleapis.com'));
    expect(new URL(reads[0]!.url).searchParams.get('readMask')).toBe('names,emailAddresses');
    expect(new URL(reads[1]!.url).searchParams.get('personFields')).toBe(
      'names,emailAddresses,organizations',
    );
    const [a] = await t.db.sql<{ s: { contacts: Record<string, string> } }>`
      select sync_state as s from orbit.integration_accounts where user_id = ${u}::uuid and provider = 'google'`;
    expect(a!.s.contacts.otherContactsSyncToken).toBe('other-1');
    expect(a!.s.contacts.connectionsSyncToken).toBe('conn-1');

    // the next run sends the token; an expired one (410) lists everything again
    env.google.intercept = (c) =>
      new URL(c.url).searchParams.get('syncToken') === 'other-1'
        ? new Response('{"error":{"status":"GONE"}}', { status: 410 })
        : undefined;
    const before = env.google.calls.length;
    await enqueue(u, {}, 'sync.contacts');
    await drain(t, env.handlers, env.time.now);
    const again = env.google.calls.slice(before).map((c) => new URL(c.url).searchParams.get('syncToken'));
    expect(again).toEqual(['other-1', null, 'conn-1']);
    expect((await jobRuns(t.db, u)).at(-1)!.status).toBe('ok');
  });
});
