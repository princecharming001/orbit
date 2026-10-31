/**
 * An Orbit account's timeline, from pulled rows: emails either way, LinkedIn messages, meetings that happened, keyed
 * to their rows so a second build adds nothing; and the one-time backfill over what was pulled before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { backfillServerTouchpoints, touchpointsFromServer } from './serverTouchpoints';

const U = '11111111-1111-4111-8111-111111111111';
const ERIC = '22222222-2222-4222-8222-222222222222';
const BO = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-30T12:00:00Z');

beforeEach(async () => {
  await wipeDatabase();
  for (const [id, first] of [
    [ERIC, 'Eric'],
    [BO, 'Bo'],
  ])
    await db.people.put({ id, userId: U, firstName: first, displayName: `${first} X`, emails: [] } as never);
  await db.threads.bulkPut([
    { id: 'th-net', userId: U, participantPersonIds: [ERIC], isNetworking: true, subject: 'Coffee?' },
    { id: 'th-rec', userId: U, participantPersonIds: [ERIC], isNetworking: false, subject: 'Jobright role' },
    { id: 'th-li', userId: U, participantPersonIds: [ERIC], isNetworking: true, channel: 'linkedin' },
  ] as never);
});
afterEach(async () => {
  await wipeDatabase();
});

const msg = (
  id: string,
  threadId: string,
  direction: string,
  at: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  userId: U,
  threadId,
  direction,
  sentAt: at,
  isAutomated: false,
  ...extra,
});

describe('touchpoints from server rows', () => {
  it('records each email, LinkedIn message and past small meeting once, with the words the timeline shows', async () => {
    const rows = {
      messages: [
        msg('m1', 'th-net', 'outbound', '2026-06-29T13:00:00Z', {
          toPersonIds: [ERIC],
          ccPersonIds: [BO],
          subject: 'Coffee?',
        }),
        msg('m2', 'th-rec', 'inbound', '2026-07-20T13:00:00Z', {
          fromPersonId: ERIC,
          subject: 'Jobright role',
        }),
        msg('m3', 'th-li', 'inbound', '2026-10-12T00:40:00Z', { fromPersonId: ERIC }),
        msg('m4', 'th-li', 'outbound', '2026-10-12T01:00:00Z'),
        msg('m5', 'th-net', 'inbound', '2026-07-01T10:00:00Z', { fromPersonId: ERIC, isAutomated: true }),
      ],
      events: [
        {
          id: 'e1',
          title: 'Coffee with Eric',
          startAt: '2026-09-01T16:00:00Z',
          endAt: '2026-09-01T16:30:00Z',
          attendeePersonIds: [ERIC],
        },
        {
          id: 'e2',
          title: 'Next week',
          startAt: '2026-11-05T16:00:00Z',
          endAt: '2026-11-05T16:30:00Z',
          attendeePersonIds: [ERIC],
        },
        {
          id: 'e3',
          title: 'Cancelled',
          startAt: '2026-08-01T16:00:00Z',
          endAt: '2026-08-01T16:30:00Z',
          attendeePersonIds: [ERIC],
          status: 'cancelled',
        },
      ],
    };
    expect(await touchpointsFromServer(U, rows, NOW)).toBe(6);
    const eric = (await db.touchpoints.where('personId').equals(ERIC).toArray()).sort((a, b) =>
      a.occurredAt.localeCompare(b.occurredAt),
    );
    expect(eric.map((t) => [t.kind, t.summary])).toEqual([
      ['email_out', 'Email to Eric: Coffee?'],
      ['email_in', 'Email from Eric: Jobright role'],
      ['meeting', 'Meeting: Coffee with Eric'],
      ['linkedin_in', 'LinkedIn message from Eric'],
      ['linkedin_out', 'LinkedIn message to Eric'],
    ]);
    // copied on the email: a light touch for Bo
    expect((await db.touchpoints.where('personId').equals(BO).toArray()).map((t) => t.kind)).toEqual([
      'email_cc',
    ]);
    // the same rows again (the next pull, their page loading its history): nothing doubles
    expect(await touchpointsFromServer(U, rows, NOW)).toBe(0);
  });

  it('never records for someone who is not this student’s', async () => {
    expect(
      await touchpointsFromServer(U, {
        messages: [msg('m9', 'th-net', 'inbound', '2026-06-01T10:00:00Z', { fromPersonId: 'stranger' })],
      }),
    ).toBe(0);
  });

  it('backfills what was pulled before once, then leaves it', async () => {
    await db.messages.bulkPut([
      msg('m1', 'th-net', 'outbound', '2026-06-29T13:00:00Z', { toPersonIds: [ERIC] }),
      msg('m2', 'th-rec', 'inbound', '2026-07-20T13:00:00Z', { fromPersonId: ERIC }),
    ] as never);
    expect(await backfillServerTouchpoints(U, NOW)).toBe(2);
    expect(await db.touchpoints.count()).toBe(2);
    await db.touchpoints.clear();
    expect(await backfillServerTouchpoints(U, NOW)).toBe(0);
  });
});
