import type { CalendarEvent, CoffeeChat, MeetingNote, Person, PersonFact, Suggestion } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { afterText, clockOf, upcomingChats } from './chatsView';

const TZ = 'America/Detroit';
// Tuesday Oct 20 2026, 1 pm in Detroit
const NOW = new Date('2026-10-20T17:00:00Z');
const H = 3_600_000;

const person = (id: string, name: string): Person =>
  ({
    id,
    userId: 'u',
    displayName: name,
    firstName: name.split(' ')[0]!,
    lastName: name.split(' ')[1] ?? '',
    nameNormalized: name.toLowerCase(),
    emails: [],
    relationshipType: 'unknown',
    strength: 0.4,
    interactionCount: 0,
    sources: ['manual'],
    isHuman: true,
    tags: [],
    createdAt: '',
    updatedAt: '',
  }) as Person;
const chat = (id: string, personId: string, stage: CoffeeChat['stage'], extra: Partial<CoffeeChat> = {}) =>
  ({
    id,
    userId: 'u',
    personId,
    stage,
    stageEnteredAt: '',
    source: 'manual',
    goalTags: [],
    bumpCount: 0,
    priority: 2,
    createdAt: '',
    updatedAt: '',
    ...extra,
  }) as CoffeeChat;
const event = (id: string, start: Date, mins: number, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  userId: 'u',
  externalEventId: id,
  startAt: start.toISOString(),
  endAt: new Date(start.getTime() + mins * 60_000).toISOString(),
  status: 'confirmed',
  attendees: [],
  attendeePersonIds: [],
  isCoffeeChat: true,
  ...extra,
});

const dana = person('p_dana', 'Dana Lee');
const jay = person('p_jay', 'Jay Park');
const sam = person('p_sam', 'Sam Diaz');
const lee = person('p_lee', 'Lee Wong');

describe('the chats view (plan 23 §4.4)', () => {
  const base = {
    people: [dana, jay, sam, lee],
    notes: [] as MeetingNote[],
    facts: [] as PersonFact[],
    suggestions: [] as Suggestion[],
  };

  it('groups by day in the student zone: an 11:30 pm chat stays on its day', () => {
    // 11:30 pm Detroit on Oct 20 is 03:30 UTC on Oct 21
    const late = event('e_late', new Date('2026-10-21T03:30:00Z'), 30, { attendeePersonIds: [dana.id] });
    const tomorrow = event('e_tom', new Date('2026-10-21T19:00:00Z'), 30, { attendeePersonIds: [jay.id] });
    const v = upcomingChats({ ...base, events: [tomorrow, late], chats: [] }, NOW, TZ);
    expect(v.days.map((d) => d.label)).toEqual(['Today', 'Tomorrow']);
    expect(v.days[0]!.rows[0]!.person.id).toBe(dana.id);
    expect(v.todayCount).toBe(1);
    expect(clockOf(late.startAt, TZ)).toBe('11:30 pm');
  });

  it('lists chats agreed to with no time yet, and hides cancelled events', () => {
    const cancelled = event('e_x', new Date(NOW.getTime() + 2 * H), 30, {
      attendeePersonIds: [sam.id],
      status: 'cancelled',
    });
    const v = upcomingChats(
      { ...base, events: [cancelled], chats: [chat('c_sam', sam.id, 'scheduling')] },
      NOW,
      TZ,
    );
    expect(v.days).toEqual([]);
    expect(v.noTime.map((r) => r.person.id)).toEqual([sam.id]);
  });

  it('says what came back, in each of its four forms', () => {
    const ended = (id: string, p: Person, hoursAgo: number) =>
      event(id, new Date(NOW.getTime() - hoursAgo * H - 30 * 60_000), 30, { attendeePersonIds: [p.id] });
    const eDana = ended('e1', dana, 0.5);
    const eJay = ended('e2', jay, 0.5);
    const eSam = ended('e3', sam, 3);
    const eLee = ended('e4', lee, 1);
    const note = {
      id: 'n1',
      userId: 'u',
      source: 'fathom',
      occurredAt: eDana.startAt,
      rawText: '',
      attendees: [],
      personIds: [dana.id],
      calendarEventId: eDana.id,
      matchStatus: 'auto',
      createdAt: NOW.toISOString(),
    } as MeetingNote;
    const fact = (id: string) =>
      ({
        id,
        userId: 'u',
        personId: dana.id,
        type: 'background',
        text: 'x',
        sourceTable: 'notes',
        sourceId: 'n1',
        confidence: 0.9,
        createdAt: '',
      }) as PersonFact;
    const thanks = { id: 's1', kind: 'thank_you', status: 'pending', personId: dana.id } as Suggestion;
    const input = {
      ...base,
      events: [eDana, eJay, eSam],
      chats: [],
      notes: [note],
      facts: [fact('f1'), fact('f2'), fact('f3')],
      suggestions: [thanks],
      notetaker: 'Fathom',
    };
    const v = upcomingChats(input, NOW, TZ);
    const by = (id: string) => v.justHappened.find((r) => r.person.id === id)!.after!;
    expect(afterText(by(dana.id))).toBe('Notes in · 3 facts · Thank-you ready');
    expect(afterText(by(jay.id))).toBe("Waiting for Fathom's notes");
    expect(afterText(by(sam.id))).toBe('Fathom has no recording of this chat');
    const none = upcomingChats({ ...base, events: [eLee], chats: [] }, NOW, TZ);
    expect(afterText(none.justHappened[0]!.after!)).toBe('No notetaker');
    for (const r of v.justHappened) expect(afterText(r.after!)).not.toMatch(/[–—]/);
  });

  it('the disclosure has the goal and ask, the last thing they said, one fact', () => {
    const e = event('e5', new Date(NOW.getTime() + 2 * H), 30, {
      attendeePersonIds: [dana.id],
      conferenceUrl: 'https://meet.example/abc',
    });
    const v = upcomingChats(
      {
        ...base,
        events: [e],
        chats: [
          chat('c_dana', dana.id, 'scheduled', {
            prepQuestions: ['How do teams pick projects?'],
            scheduledEventId: 'e5',
          }),
        ],
        facts: [
          {
            id: 'f',
            userId: 'u',
            personId: dana.id,
            type: 'role_detail',
            text: 'leads the payments API team',
            sourceTable: 'notes',
            sourceId: 'x',
            confidence: 0.9,
            createdAt: '',
          } as PersonFact,
        ],
        messages: [
          {
            id: 'm',
            userId: 'u',
            threadId: 't',
            externalMessageId: 'x',
            direction: 'inbound',
            fromEmail: 'd@x',
            fromPersonId: dana.id,
            toEmails: [],
            ccEmails: [],
            sentAt: NOW.toISOString(),
            bodyText: 'Sure, next week works. Talk soon.',
            headers: {},
            isAutomated: false,
          },
        ],
      },
      NOW,
      TZ,
    );
    const r = v.days[0]!.rows[0]!;
    expect(r.joinUrl).toBe('https://meet.example/abc');
    expect(r.lines).toEqual({
      goal: 'Ask: How do teams pick projects?',
      lastSaid: 'Sure, next week works.',
      fact: 'leads the payments API team',
    });
    expect(v.next?.key).toBe('e5');
  });
});
