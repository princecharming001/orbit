import { describe, expect, it } from 'vitest';
import { decideTransition } from '../pipeline/transitions';
import {
  type Candidate,
  generateCandidates,
  kindAllowedInStage,
  type RuleInput,
  relTime,
  selectForBrief,
  staleReason,
  thankYouDue,
  usableProposedTime,
  weekMondayKey,
} from '../suggestions/rules';
import type {
  ActionItem,
  CalendarEvent,
  CoffeeChat,
  EmailMessage,
  Person,
  PersonFact,
  Recommendation,
  UserSettings,
} from '../types';

const NOW = new Date('2026-10-02T13:00:00Z'); // a Friday
const H = 3_600_000;
const D = 86_400_000;
const ago = (ms: number, from = NOW) => new Date(from.getTime() - ms).toISOString();
const ahead = (ms: number, from = NOW) => new Date(from.getTime() + ms).toISOString();

const settings: UserSettings = {
  userId: 'u',
  briefTimeLocal: '07:00',
  briefChannels: ['in_app'],
  quietDays: [],
  weeklyOutreachTarget: 4,
  dailySendCapGmail: 15,
  dailySendCapLinkedin: 10,
  perPersonCooldownHours: 72,
  maxBumps: 2,
  tonePreset: 'warm',
  warmUpEnabled: true,
  warmUpDays: 4,
};

function person(id: string, extra: Partial<Person> = {}): Person {
  return {
    id,
    userId: 'u',
    displayName: `${id} Lee`,
    firstName: id,
    lastName: 'Lee',
    isHuman: true,
    relationshipType: 'unknown',
    strength: 0.3,
    currentOrganizationRaw: `${id} Corp`,
    ...extra,
  } as Person;
}

function chat(id: string, personId: string, extra: Partial<CoffeeChat> = {}): CoffeeChat {
  return {
    id,
    userId: 'u',
    personId,
    stage: 'identified',
    stageEnteredAt: ago(30 * D),
    source: 'detected',
    goalTags: [],
    bumpCount: 0,
    priority: 2,
    createdAt: ago(30 * D),
    updatedAt: ago(1 * D),
    ...extra,
  } as CoffeeChat;
}

function inbound(id: string, sentAt: string, extra: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id,
    userId: 'u',
    threadId: 't',
    externalMessageId: id,
    direction: 'inbound',
    fromEmail: 'x@y.com',
    toEmails: [],
    ccEmails: [],
    sentAt,
    bodyText: '',
    headers: {},
    isAutomated: false,
    ...extra,
  } as EmailMessage;
}

function input(over: Omit<Partial<RuleInput>, 'people'> & { people: Person[] }): RuleInput {
  const { people, ...rest } = over;
  return {
    userId: 'u',
    now: NOW,
    settings,
    chats: [],
    lastInboundByChat: new Map(),
    events: [],
    actionItems: [],
    factsByPerson: new Map(),
    targetCompanies: [],
    recommendations: [],
    dismissCounts: new Map(),
    outreachSentThisWeek: 0,
    freeSlotsIso: [ahead(3 * D), ahead(4 * D)],
    recentlyContacted: new Set(),
    timezone: 'America/New_York',
    ...rest,
    people: new Map(people.map((p) => [p.id, p])),
  };
}

const cand = (kind: Candidate['kind'], personId: string, urgency: number, extra: Partial<Candidate> = {}) =>
  ({
    kind,
    personId,
    dedupeKey: `${kind}:${personId}`,
    reasonText: kind,
    signals: {},
    payload: {},
    urgency,
    goalRelevance: 0.2,
    confidence: 1,
    ...extra,
  }) as Candidate;

describe('thank-you (PS-1, PS-6, EG-01)', () => {
  it('is due only within three days of the real meeting and before anything was sent', () => {
    expect(thankYouDue({ completedAt: ago(20 * H) }, NOW)).toBe(true);
    expect(thankYouDue({ completedAt: ago(51 * D) }, NOW)).toBe(false);
    expect(thankYouDue({ completedAt: ago(20 * H), lastOutboundAt: ago(18 * H) }, NOW)).toBe(false);
    // an outbound from before the meeting (the scheduling mail) does not count as the thank-you
    expect(thankYouDue({ completedAt: ago(20 * H), lastOutboundAt: ago(5 * D) }, NOW)).toBe(true);
  });
  it('produces no card for a weeks-old chat that was already thanked', () => {
    const p = person('sofia');
    const cands = generateCandidates(
      input({
        people: [p],
        chats: [
          chat('c1', 'sofia', { stage: 'completed', completedAt: ago(51 * D), lastOutboundAt: ago(50 * D) }),
        ],
      }),
    );
    expect(cands.filter((c) => c.kind === 'thank_you')).toEqual([]);
  });
  it('words a recent chat in plain English', () => {
    const p = person('alina');
    const [c] = generateCandidates(
      input({ people: [p], chats: [chat('c1', 'alina', { stage: 'completed', completedAt: ago(22 * H) })] }),
    ).filter((x) => x.kind === 'thank_you');
    expect(c?.reasonText).toBe('You spoke yesterday. Send a thank-you while it is fresh.');
  });
});

describe('confirming a proposed time (PS-2)', () => {
  const p = person('hannah');
  const c = chat('c1', 'hannah', { stage: 'scheduling', lastOutboundAt: ago(10 * D) });
  const msg = (startIso: string) =>
    inbound('m1', ago(9 * D), {
      signal: 'scheduling_proposal',
      extraction: {
        proposedTimes: [{ startIso, raw: 'Thursday at 2pm' }],
        asksOfUser: [],
        offers: [],
        factsAboutSender: [],
      } as never,
    });
  it('never asks to confirm a time that has passed; proposes new times instead', () => {
    const cands = generateCandidates(
      input({ people: [p], chats: [c], lastInboundByChat: new Map([['c1', msg(ago(D))]]) }),
    );
    expect(cands.some((x) => x.kind === 'schedule_confirm')).toBe(false);
    const prop = cands.find((x) => x.kind === 'schedule_propose');
    expect(prop?.reasonText).toBe(
      'hannah suggested Thursday at 2pm, but that time has passed; propose new times',
    );
    expect(prop?.payload.missedProposal).toMatchObject({ reason: 'passed' });
  });
  it('confirms a future time that is free', () => {
    const cands = generateCandidates(
      input({ people: [p], chats: [c], lastInboundByChat: new Map([['c1', msg(ahead(2 * D))]]) }),
    );
    expect(cands.find((x) => x.kind === 'schedule_confirm')?.reasonText).toBe(
      'hannah suggested Thursday at 2pm; confirm it',
    );
  });
  it('treats a clash with the calendar as unusable', () => {
    const start = ahead(2 * D);
    const busy = {
      startAt: ago(15 * 60_000, new Date(start)),
      endAt: ahead(H, new Date(start)),
      status: 'confirmed',
    } as CalendarEvent;
    expect(usableProposedTime({ startIso: start, raw: 'x' }, [busy], NOW)).toBe('busy');
    expect(usableProposedTime({ startIso: ahead(H), raw: 'x' }, [], NOW)).toBe('passed');
  });
  it('says nothing about times once the chat is on the calendar', () => {
    const ev = {
      id: 'e1',
      chatId: 'c1',
      startAt: ahead(2 * D),
      endAt: ahead(2 * D + H),
      status: 'confirmed',
      attendeePersonIds: [],
    } as unknown as CalendarEvent;
    const cands = generateCandidates(
      input({
        people: [p],
        chats: [c],
        events: [ev],
        lastInboundByChat: new Map([['c1', msg(ahead(2 * D))]]),
      }),
    );
    expect(cands.filter((x) => x.kind === 'schedule_confirm' || x.kind === 'schedule_propose')).toEqual([]);
  });
});

describe('stage validity of pending cards (PS-3)', () => {
  it('knows which cards a stage can hold', () => {
    expect(kindAllowedInStage('schedule_propose', 'declined')).toBe(false);
    expect(kindAllowedInStage('schedule_confirm', 'completed')).toBe(false);
    expect(kindAllowedInStage('thank_you', 'completed')).toBe(true);
    expect(kindAllowedInStage('follow_up_bump', 'replied')).toBe(false);
    expect(kindAllowedInStage('action_item_reminder', 'declined')).toBe(true);
  });
  it('names why a card went stale', () => {
    const base = { payload: {}, createdAt: ago(2 * D), chatId: 'c1', dedupeKey: 'k' };
    const c = chat('c1', 'p', { stage: 'declined' });
    expect(
      staleReason({ ...base, kind: 'schedule_propose' }, { chat: c, now: NOW, stillCandidate: false }),
    ).toBe('stage:declined');
    expect(
      staleReason(
        { ...base, kind: 'schedule_confirm', payload: { time: { startIso: ago(H) } } },
        { chat: chat('c1', 'p', { stage: 'scheduling' }), now: NOW, stillCandidate: false },
      ),
    ).toBe('time_passed');
    expect(
      staleReason(
        { ...base, kind: 'thank_you' },
        {
          chat: chat('c1', 'p', { stage: 'completed', completedAt: ago(D), lastOutboundAt: ago(H) }),
          now: NOW,
          stillCandidate: false,
        },
      ),
    ).toBe('thanked');
    expect(staleReason({ ...base, kind: 'thank_you' }, { now: NOW, stillCandidate: true })).toBeUndefined();
  });
});

describe('no response (PS-7)', () => {
  it('closes a silent thread after three weeks even when no bump went out', () => {
    expect(
      decideTransition('outreach_sent', { type: 'timer_no_response', bumps: 0, maxBumps: 2, daysSilent: 22 }),
    ).toMatchObject({
      to: 'no_response',
    });
    expect(
      decideTransition('outreach_sent', { type: 'timer_no_response', bumps: 0, maxBumps: 2, daysSilent: 15 }),
    ).toBeUndefined();
    expect(
      decideTransition('outreach_sent', { type: 'timer_no_response', bumps: 2, maxBumps: 2, daysSilent: 15 }),
    ).toMatchObject({
      to: 'no_response',
    });
  });
});

describe('selection (PS-8, PS-11)', () => {
  it('keeps a promise due today next to a thank-you for the same person', () => {
    const sel = selectForBrief(
      [
        cand('thank_you', 'alina', 0.95),
        cand('action_item_reminder', 'alina', 0.7),
        cand('new_outreach', 'yuki', 0.5),
        cand('nurture_checkin', 'sofia', 0.4),
      ],
      new Map(),
      7,
    );
    expect(sel.map((s) => s.kind)).toContain('action_item_reminder');
  });
  it('still allows only one message to a person', () => {
    const sel = selectForBrief(
      [cand('schedule_propose', 'marcus', 0.9), cand('ask_referral', 'marcus', 0.8)],
      new Map(),
      7,
    );
    expect(sel.length).toBe(1);
  });
  it('clears a follow-up in a live thread before any cold outreach', () => {
    const p = person('felix', { currentOrganizationRaw: 'Datadog' });
    const bump = generateCandidates(
      input({
        people: [p],
        chats: [chat('c1', 'felix', { stage: 'outreach_sent', lastOutboundAt: ago(8 * D) })],
      }),
    ).find((c) => c.kind === 'follow_up_bump')!;
    expect(bump).toBeDefined();
    const yuki = cand('new_outreach', 'yuki', 0.5, { goalRelevance: 1 });
    const sel = selectForBrief([cand('thank_you', 'alina', 0.95), yuki, bump], new Map(), 2);
    expect(sel.map((s) => s.kind)).toEqual(['thank_you', 'follow_up_bump']);
  });
  it('follows up on an offered intro before messaging strangers', () => {
    const sel = selectForBrief(
      [
        cand('new_outreach', 'yuki', 0.5, { goalRelevance: 1 }),
        cand('new_outreach', 'ines', 0.5, { goalRelevance: 1 }),
        cand('intro_request', 'sofia', 0.6),
      ],
      new Map(),
      2,
    );
    expect(sel.map((s) => s.kind)).toContain('intro_request');
  });
  it('caps one company at two non-urgent messages per brief', () => {
    const cands = ['a', 'b', 'c'].map((id, i) => cand('new_outreach', id, 0.5 - i * 0.01));
    const nurture = ['d'].map((id) => cand('nurture_checkin', id, 0.45));
    const sel = selectForBrief([...cands, ...nurture], new Map(), 7, { orgOf: () => 'Stripe' });
    expect(sel.length).toBe(2);
  });
});

describe('nurture check-in (PS-13)', () => {
  const p = person('sofia', { relationshipType: 'mentor', lastInteractionAt: ago(2 * D) });
  const c = chat('c1', 'sofia', { stage: 'nurturing' });
  const fact = (occurredAt: string): PersonFact =>
    ({
      id: 'f1',
      userId: 'u',
      personId: 'sofia',
      type: 'hook',
      text: 'launching in November',
      occurredAt,
      createdAt: occurredAt,
      confidence: 1,
    }) as PersonFact;
  it('ignores a stale hook', () => {
    const cands = generateCandidates(
      input({
        people: [p],
        chats: [c],
        factsByPerson: new Map([['sofia', [fact('2025-01-01T00:00:00Z')]]]),
        lastConversationByPerson: new Map([['sofia', ago(50 * D)]]),
      }),
    );
    // the stale hook is not used; 50 days of silence with a mentor still earns a plain update note (EG-19)
    const n = cands.find((x) => x.kind === 'nurture_checkin');
    expect(n?.signals.hookId).toBeUndefined();
    expect(n?.reasonText).not.toMatch(/hook/);
  });
  it('counts days from the last real conversation, not a LinkedIn connection', () => {
    const cands = generateCandidates(
      input({
        people: [p],
        chats: [c],
        factsByPerson: new Map([['sofia', [fact(ago(40 * D))]]]),
        lastConversationByPerson: new Map([['sofia', ago(50 * D)]]),
      }),
    );
    expect(cands.find((x) => x.kind === 'nurture_checkin')?.reasonText).toBe(
      '50 days since your last conversation; you have a hook: "launching in November"',
    );
  });
});

describe('weekly keys and pacing (PS-14, PS-17)', () => {
  it('keys outreach by the Monday of the week', () => {
    const keys = ['2026-09-28', '2026-09-30', '2026-10-01', '2026-10-04', '2026-10-05'].map((d) =>
      weekMondayKey(new Date(`${d}T12:00:00`)),
    );
    expect(keys).toEqual(['2026-09-28', '2026-09-28', '2026-09-28', '2026-09-28', '2026-10-05']);
  });
  it('counts Sunday as behind when nothing went out this week', () => {
    const rec = {
      id: 'r1',
      userId: 'u',
      personId: 'yuki',
      status: 'new',
      score: 0.8,
      reasons: [{ text: 'Cornell alum' }],
      batchDate: ago(D),
    } as unknown as Recommendation;
    const run = (now: Date) =>
      generateCandidates(input({ now, people: [person('yuki')], recommendations: [rec] })).find(
        (c) => c.kind === 'new_outreach',
      );
    expect(run(new Date('2026-10-04T12:00:00'))?.urgency).toBe(0.5);
    expect(run(new Date('2026-10-05T12:00:00'))?.urgency).toBe(0.3);
  });
});

describe('reason wording (PS-15)', () => {
  it('reads correctly at every range', () => {
    expect(relTime(ahead(10 * 60_000), NOW, 'UTC')).toBe('in 10 minutes');
    expect(relTime(ahead(1 * 60_000), NOW, 'UTC')).toBe('in 1 minute');
    expect(relTime(ahead(H), NOW, 'UTC')).toBe('in about an hour');
    expect(relTime(ahead(5 * H), NOW, 'UTC')).toBe('in 5 hours');
    expect(relTime(ahead(30 * H), NOW, 'UTC')).toBe('tomorrow');
    expect(relTime(ahead(3 * D), NOW, 'UTC')).toBe('in 3 days');
    expect(relTime(ago(30 * 60_000), NOW, 'UTC')).toBe('30 minutes ago');
    expect(relTime(ago(H), NOW, 'UTC')).toBe('about an hour ago');
    expect(relTime(ago(5 * H), NOW, 'UTC')).toBe('5 hours ago');
    expect(relTime(ago(30 * H), NOW, 'UTC')).toBe('yesterday');
    expect(relTime(ago(4 * D), NOW, 'UTC')).toBe('4 days ago');
    // late evening to early next morning is still "tomorrow", by the calendar in the student's zone
    expect(relTime('2026-10-03T13:00:00Z', new Date('2026-10-03T02:30:00Z'), 'America/New_York')).toBe(
      'tomorrow',
    );
    expect(relTime('2026-10-02T09:00:00Z', new Date('2026-10-02T20:00:00Z'), 'UTC')).toBe('11 hours ago');
    expect(relTime(NOW.toISOString(), NOW, 'UTC')).toBe('right now');
  });
  it('drops the prep card once the chat started and says minutes when it is close', () => {
    const p = person('grace');
    const ev = (startAt: string) =>
      ({
        id: 'e1',
        startAt,
        endAt: ahead(30 * 60_000, new Date(startAt)),
        status: 'confirmed',
        attendeePersonIds: ['grace'],
        isCoffeeChat: true,
      }) as unknown as CalendarEvent;
    const prep = (startAt: string) =>
      generateCandidates(input({ people: [p], events: [ev(startAt)] })).find((c) => c.kind === 'prep_brief');
    expect(prep(ago(30 * 60_000))).toBeUndefined();
    expect(prep(ahead(10 * 60_000))?.reasonText).toBe(
      'Chat with grace starts in 10 minutes. Prep takes two minutes.',
    );
    expect(prep(ahead(20 * H))?.reasonText).toBe('Chat with grace is tomorrow. Prep takes two minutes.');
    // a brief built just after midnight still lists tomorrow's chat, and not the day after
    const midnight = new Date('2026-10-02T04:20:00Z'); // 00:20 in New York
    const prepAt = (startAt: string) =>
      generateCandidates(input({ now: midnight, people: [p], events: [ev(startAt)] })).find(
        (c) => c.kind === 'prep_brief',
      );
    expect(prepAt('2026-10-03T15:30:00Z')?.reasonText).toBe(
      'Chat with grace is tomorrow. Prep takes two minutes.',
    );
    expect(prepAt('2026-10-04T05:00:00Z')).toBeUndefined();
  });
  it('dates action items by calendar day in the student timezone', () => {
    // 09:00 in New York
    const now = new Date('2026-10-02T13:00:00Z');
    const item = (dueAt: string): ActionItem => ({
      id: dueAt,
      userId: 'u',
      text: 'Send resume',
      dueAt,
      status: 'open',
      createdAt: '',
    });
    const reasons = generateCandidates(
      input({
        now,
        people: [],
        actionItems: [
          item('2026-10-01T21:00:00Z'), // yesterday 17:00 local
          item('2026-10-02T21:00:00Z'), // today 17:00 local
          item('2026-10-03T12:00:00Z'), // tomorrow 08:00 local
        ],
      }),
    )
      .filter((c) => c.kind === 'action_item_reminder')
      .map((c) => c.reasonText);
    expect(reasons).toEqual(['Overdue: Send resume', 'Due today: Send resume']);
  });
});
