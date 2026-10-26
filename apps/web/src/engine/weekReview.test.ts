import type { CoffeeChat, EmailMessage, OutboundMessage, Person, StageEvent, Suggestion } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { reviewSunday, type WeekRows, weekReviewDue, weekReviewFrom } from './weekReview';

const TZ = 'America/Detroit';
// Sunday Oct 25 2026, 6 pm in Detroit
const SUNDAY_EVENING = new Date('2026-10-25T22:00:00Z');

const person = (id: string): Person =>
  ({
    id,
    userId: 'u',
    displayName: `${id} Lee`,
    firstName: id,
    lastName: 'Lee',
    isHuman: true,
    tags: [],
    emails: [],
  }) as unknown as Person;
const sent = (id: string, personId: string, kind: OutboundMessage['kind'], at: string) =>
  ({
    id,
    userId: 'u',
    personId,
    kind,
    status: 'sent',
    sentAt: at,
    channel: 'gmail',
    bodyDraft: '',
    generatedBy: 'template',
    createdAt: at,
  }) as OutboundMessage;
const chat = (id: string, personId: string, extra: Partial<CoffeeChat> = {}) =>
  ({
    id,
    userId: 'u',
    personId,
    stage: 'outreach_sent',
    stageEnteredAt: '2026-10-10T15:00:00Z',
    source: 'manual',
    goalTags: [],
    bumpCount: 0,
    priority: 2,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...extra,
  }) as CoffeeChat;
const stage = (chatId: string, to: StageEvent['toStage'], at: string) =>
  ({
    id: `se_${chatId}_${to}`,
    userId: 'u',
    chatId,
    toStage: to,
    status: 'applied',
    actor: 'system',
    reason: 'x',
    createdAt: at,
  }) as StageEvent;
const inbound = (personId: string, at: string, automated = false) =>
  ({
    id: `m_${personId}_${at}`,
    userId: 'u',
    threadId: 't',
    externalMessageId: 'x',
    direction: 'inbound',
    fromEmail: 'x@x',
    fromPersonId: personId,
    toEmails: [],
    ccEmails: [],
    sentAt: at,
    bodyText: 'Sure',
    headers: {},
    isAutomated: automated,
  }) as EmailMessage;

const empty: WeekRows = {
  people: [],
  outbound: [],
  messages: [],
  threads: [],
  chats: [],
  stageEvents: [],
  events: [],
  notes: [],
  facts: [],
  suggestions: [],
  actionItems: [],
  plans: [],
  weeklyTarget: 4,
};

describe('the weekly review (plan 23 §4.8)', () => {
  it('counts a seeded week: reached is first messages only, replied is human replies, booked is to scheduled, quiet uses wentQuiet', () => {
    const rows: WeekRows = {
      ...empty,
      people: ['Dana', 'Priya', 'Jay', 'Kenji', 'Omar', 'Sam'].map(person),
      outbound: [
        sent('o1', 'Dana', 'outreach', '2026-10-19T15:00:00Z'),
        sent('o2', 'Priya', 'first_touch', '2026-10-20T15:00:00Z'),
        sent('o3', 'Jay', 'outreach', '2026-10-21T15:00:00Z'),
        // a bump and a thank-you are not reaching anyone new
        sent('o4', 'Kenji', 'bump', '2026-10-21T15:00:00Z'),
        sent('o5', 'Omar', 'thank_you', '2026-10-22T15:00:00Z'),
        // last week's first message is last week's
        sent('o6', 'Sam', 'outreach', '2026-10-16T15:00:00Z'),
      ],
      chats: [
        chat('c_dana', 'Dana', { stage: 'replied', lastInboundAt: '2026-10-22T15:00:00Z' }),
        chat('c_priya', 'Priya', { stage: 'scheduled' }),
        chat('c_sam', 'Sam', { lastOutboundAt: '2026-10-16T15:00:00Z' }),
        chat('c_omar', 'Omar'),
      ],
      messages: [
        inbound('Dana', '2026-10-22T15:00:00Z'),
        // an out-of-office is not a reply
        inbound('Omar', '2026-10-22T16:00:00Z', true),
      ],
      stageEvents: [
        stage('c_dana', 'replied', '2026-10-22T15:05:00Z'),
        stage('c_priya', 'scheduled', '2026-10-23T15:00:00Z'),
      ],
    };
    const r = weekReviewFrom(rows, SUNDAY_EVENING, TZ);
    expect(r.weekEnding).toBe('2026-10-25');
    expect(r.reached.map((x) => x.personId).sort()).toEqual(['Dana', 'Jay', 'Priya']);
    expect(r.replied.map((x) => x.personId)).toEqual(['Dana']);
    expect(r.booked.map((x) => x.personId)).toEqual(['Priya']);
    expect(r.quiet.map((x) => x.personId)).toEqual(['Sam']);
    expect(r.headline).toBe('3 reached · 1 replied · 1 chat booked · 1 went quiet');
    expect(r.moved.map((m) => m.text)).toEqual(['Priya booked a chat', 'Dana replied Thu']);
    expect(r.headline).not.toMatch(/[–—]/);
  });

  it('an empty week says so, and names the holiday when the week held one', () => {
    expect(weekReviewFrom(empty, SUNDAY_EVENING, TZ)).toMatchObject({
      empty: true,
      headline: 'Nothing moved this week',
    });
    // the week of Thanksgiving 2026 ends Sunday Nov 29
    const r = weekReviewFrom(empty, new Date('2026-11-29T23:00:00Z'), TZ);
    expect(r.holiday).toBe('Thanksgiving');
    expect(r.headline).toBe('Nothing moved this week. It was Thanksgiving week');
  });

  it('lists what waits: drafted nudges and thank-yous, and a promise past due', () => {
    const r = weekReviewFrom(
      {
        ...empty,
        suggestions: [
          {
            id: 's1',
            kind: 'follow_up_bump',
            status: 'pending',
            priorityScore: 0.6,
            outboundMessageId: 'd1',
          } as Suggestion,
          {
            id: 's2',
            kind: 'thank_you',
            status: 'pending',
            priorityScore: 0.9,
            outboundMessageId: 'd2',
          } as Suggestion,
          {
            id: 's3',
            kind: 'new_outreach',
            status: 'pending',
            priorityScore: 0.9,
            outboundMessageId: 'd3',
          } as Suggestion,
        ],
        actionItems: [
          {
            id: 'a1',
            userId: 'u',
            text: 'Send Dana the write-up',
            status: 'open',
            dueAt: '2026-10-23T15:00:00Z',
            createdAt: '',
          },
          {
            id: 'a2',
            userId: 'u',
            text: 'Later',
            status: 'open',
            dueAt: '2026-11-23T15:00:00Z',
            createdAt: '',
          },
        ],
      },
      SUNDAY_EVENING,
      TZ,
    );
    expect(r.waiting.suggestionIds).toEqual(['s2', 's1']);
    expect(r.waiting.overdue.map((a) => a.text)).toEqual(['Send Dana the write-up']);
  });

  it('is due Sunday from 5 pm local, once, and never in the first week', () => {
    const first = '2026-10-01T00:00:00Z';
    const at = (iso: string) => new Date(iso);
    // 4 pm Sunday in Detroit: not yet; 5 pm: due
    expect(weekReviewDue(undefined, first, at('2026-10-25T20:00:00Z'), TZ)).toBe(false);
    expect(weekReviewDue(undefined, first, at('2026-10-25T21:00:00Z'), TZ)).toBe(true);
    // the same moment is Monday morning in Tokyo: last week's, still due
    expect(weekReviewDue(undefined, first, at('2026-10-25T21:00:00Z'), 'Asia/Tokyo')).toBe(true);
    // and Sunday at 2 pm in Los Angeles: not yet
    expect(weekReviewDue(undefined, first, at('2026-10-25T21:00:00Z'), 'America/Los_Angeles')).toBe(false);
    // seen this week: not again until next Sunday
    const seen = { weekReviewSeenOn: reviewSunday(at('2026-10-25T22:00:00Z'), TZ) };
    expect(weekReviewDue(seen, first, at('2026-10-26T15:00:00Z'), TZ)).toBe(false);
    expect(weekReviewDue(seen, first, at('2026-11-01T22:00:00Z'), TZ)).toBe(true);
    // a student who started this week
    expect(weekReviewDue(undefined, '2026-10-21T00:00:00Z', at('2026-10-25T22:00:00Z'), TZ)).toBe(false);
  });
});
