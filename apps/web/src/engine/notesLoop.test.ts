/**
 * Plan 23 §4.5: the loop after a chat closes on its own. A recorded meeting for a booked chat comes in through the
 * notes check, and ends as the chat completed, facts on the person, a promise as an action item, a thank-you that
 * quotes the notes, and the Chats row saying so. A recording of strangers asks first.
 */
import type { CalendarEvent, CoffeeChat, Person, User } from '@orbit/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import type { FathomMeeting } from '../integrations/notesApps';
import { createLocalUser } from './account';
import { afterText, upcomingChats } from './chatsView';
import { answerHeldMeeting, importMeetings } from './fathom';
import { mapWisprMeeting, parseGranolaMeetings } from './meetingApps';
import { CHECK_OFFSETS_MIN, checkNotes, dueOffset, nextNotesCheckAt } from './notesCheck';

const page = vi.hoisted(() => ({ meetings: [] as FathomMeeting[], calls: 0, since: [] as string[] }));
vi.mock('../integrations/notesApps', async (orig) => ({
  ...(await orig<typeof import('../integrations/notesApps')>()),
  fathomMeetingsPage: async (_auth: unknown, q: { createdAfter?: string }) => {
    page.calls++;
    if (q.createdAfter) page.since.push(q.createdAfter);
    return { ok: true, value: { meetings: page.meetings, nextCursor: undefined } };
  },
}));

const MIN = 60_000;
const START = new Date('2026-10-20T19:00:00Z');
const END = new Date(START.getTime() + 30 * MIN);
let user: User;

const dana: Person = {
  id: 'p_dana',
  userId: '',
  displayName: 'Dana Lee',
  firstName: 'Dana',
  lastName: 'Lee',
  nameNormalized: 'dana lee',
  primaryEmail: 'dana@stripe.com',
  emails: ['dana@stripe.com'],
  currentOrganizationRaw: 'Stripe',
  currentTitle: 'Software Engineer',
  relationshipType: 'alumni',
  strength: 0.5,
  interactionCount: 2,
  sources: ['gmail'],
  isHuman: true,
  tags: [],
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

const meeting = (extra: Partial<FathomMeeting> = {}): FathomMeeting => ({
  id: 'fm_dana_1',
  title: 'Coffee chat: Dana Lee',
  url: 'https://fathom.video/calls/1',
  startAt: START.toISOString(),
  invitees: [{ name: 'Dana Lee', email: 'dana@stripe.com', external: true }],
  recordedBy: 'alex@umich.edu',
  summary:
    'Dana leads the payments API team at Stripe. She said the Payments intern team values a project that moves money. She offered to introduce Alex to Priya, the university recruiter. Dana grew up in Ann Arbor.',
  actionItems: [
    { text: 'Send Dana the marketplace write-up by Friday', done: false, assignee: 'Alex Rivera' },
    { text: 'Intro Alex to Priya', done: false, assignee: 'Dana Lee' },
  ],
  ...extra,
});

beforeEach(async () => {
  await wipeDatabase();
  user = await createLocalUser({
    fullName: 'Alex Rivera',
    email: 'alex@umich.edu',
    school: 'University of Michigan',
  });
  await db.users.update(user.id, {
    onboardingCompletedAt: '2026-09-01T00:00:00Z',
    timezone: 'America/Detroit',
  });
  user = (await db.users.get(user.id))!;
  await db.people.put({ ...dana, userId: user.id });
  const ev: CalendarEvent = {
    id: 'ev_dana',
    userId: user.id,
    externalEventId: 'g_ev_dana',
    title: 'Dana / Alex coffee chat',
    startAt: START.toISOString(),
    endAt: END.toISOString(),
    status: 'confirmed',
    attendees: [
      { email: 'alex@umich.edu', self: true },
      { email: 'dana@stripe.com', displayName: 'Dana Lee' },
    ],
    attendeePersonIds: [dana.id],
    isCoffeeChat: true,
    chatId: 'c_dana',
  };
  const chat: CoffeeChat = {
    id: 'c_dana',
    userId: user.id,
    personId: dana.id,
    stage: 'scheduled',
    stageEnteredAt: '2026-10-15T00:00:00Z',
    source: 'manual',
    goalTags: [],
    bumpCount: 0,
    scheduledEventId: ev.id,
    priority: 2,
    createdAt: '2026-10-10T00:00:00Z',
    updatedAt: '2026-10-15T00:00:00Z',
  };
  await db.events.put(ev);
  await db.chats.put(chat);
  await db.integrations.put({
    id: 'i_fathom',
    userId: user.id,
    provider: 'fathom',
    accessToken: 'fathom-key',
    status: 'active',
    scopes: [],
    syncState: { since: '2026-09-01T00:00:00Z' },
    connectedAt: '2026-09-01T00:00:00Z',
    lastSyncedAt: '2026-10-20T08:00:00Z',
  });
  page.meetings = [];
  page.calls = 0;
  page.since = [];
});

describe('the notes check schedule', () => {
  const ev = { endAt: END.toISOString(), status: 'confirmed' as const };
  it('fires at 10, 30, 60 and 120 minutes after the end, then stops', () => {
    expect(dueOffset(ev, [], false, new Date(END.getTime() + 5 * MIN))).toBeUndefined();
    const asked: number[] = [];
    for (const m of CHECK_OFFSETS_MIN) {
      expect(dueOffset(ev, asked, false, new Date(END.getTime() + m * MIN))).toBe(m);
      asked.push(m);
    }
    expect(dueOffset(ev, asked, false, new Date(END.getTime() + 170 * MIN))).toBeUndefined();
    // never for a cancelled event or one whose notes are in
    expect(
      dueOffset({ ...ev, status: 'cancelled' }, [], false, new Date(END.getTime() + 10 * MIN)),
    ).toBeUndefined();
    expect(dueOffset(ev, [], true, new Date(END.getTime() + 10 * MIN))).toBeUndefined();
  });

  it('asks once per moment, from the meeting start, and never twice for one meeting', async () => {
    const at10 = new Date(END.getTime() + 10 * MIN);
    expect(await nextNotesCheckAt(user.id, new Date(END.getTime() + MIN))).toBe(END.getTime() + 10 * MIN);
    const first = await checkNotes(user, { now: at10 });
    expect(first.asked).toEqual(['ev_dana']);
    expect(page.calls).toBe(1);
    expect(Date.parse(page.since[0]!)).toBeLessThanOrEqual(START.getTime());
    expect(await checkNotes(user, { now: new Date(at10.getTime() + MIN) })).toMatchObject({ asked: [] });
    expect(page.calls).toBe(1);
    // the regular import keeps its own place
    expect(((await db.integrations.get('i_fathom'))!.syncState as { since?: string }).since).toBe(
      '2026-09-01T00:00:00Z',
    );
  });
});

describe('the loop, end to end', () => {
  it('Fathom at end + 10 min: chat completed, facts, a promise, a thank-you quoting the notes, the row updated', async () => {
    page.meetings = [meeting()];
    const r = await checkNotes(user, { now: new Date(END.getTime() + 10 * MIN) });
    expect(r.imported).toBe(1);
    const chat = (await db.chats.get('c_dana'))!;
    expect(chat.stage).toBe('completed');
    const facts = await db.facts
      .where('personId')
      .equals(dana.id)
      .filter((f) => f.sourceTable === 'notes')
      .toArray();
    expect(facts.length).toBeGreaterThanOrEqual(2);
    const promises = await db.actionItems.where('personId').equals(dana.id).toArray();
    expect(promises.some((a) => /write-up/i.test(a.text))).toBe(true);
    const thanks = await db.suggestions
      .where('userId')
      .equals(user.id)
      .filter((s) => s.kind === 'thank_you' && s.status === 'pending' && s.personId === dana.id)
      .first();
    expect(thanks).toBeTruthy();
    const draft = thanks?.outboundMessageId ? await db.outbound.get(thanks.outboundMessageId) : undefined;
    expect(draft?.bodyDraft).toMatch(/payments|Priya|project that moves money|write-up/i);
    // and the Chats row says what came back
    const [events, chats, people, notes, allFacts, suggestions] = await Promise.all([
      db.events.toArray(),
      db.chats.toArray(),
      db.people.toArray(),
      db.notes.toArray(),
      db.facts.toArray(),
      db.suggestions.toArray(),
    ]);
    const v = upcomingChats(
      { events, chats, people, notes, facts: allFacts, suggestions, notetaker: 'Fathom' },
      new Date(END.getTime() + 11 * MIN),
      'America/Detroit',
    );
    const row = v.justHappened.find((x) => x.person.id === dana.id)!;
    expect(row.after?.kind).toBe('notes_in');
    expect(afterText(row.after!)).toMatch(/^Notes in · \d+ facts? · Thank-you ready$/);
  });

  it('Granola and Wispr Flow meetings run the same pipeline', async () => {
    const granola = parseGranolaMeetings(
      `<meeting id="g1" title="Coffee with Dana" date="${START.toISOString()}"><known_participants>Dana Lee <dana@stripe.com></known_participants><summary>Dana leads the payments API team. She offered to share the team's onboarding doc.</summary></meeting>`,
    );
    const wispr = mapWisprMeeting({
      meeting_id: 'w1',
      title: 'Dana coffee',
      start_time: START.toISOString(),
      attendees: [{ name: 'Dana Lee', email: 'dana@stripe.com' }],
      summary: 'Dana leads the payments API team at Stripe and suggested applying before the posting closes.',
    })!;
    for (const [m, source] of [
      [granola[0], 'granola_api'],
      [wispr, 'wispr_notetaker'],
    ] as const) {
      expect(m).toBeTruthy();
      const r = await importMeetings(user, [m!], new Date(END.getTime() + 10 * MIN), source);
      expect(r.imported).toBe(1);
    }
    expect((await db.chats.get('c_dana'))!.stage).toBe('completed');
    const notes = await db.notes.toArray();
    for (const source of ['granola_api', 'wispr_notetaker'])
      expect(notes.find((n) => n.source === source)?.personIds).toContain(dana.id);
    expect(await db.facts.where('personId').equals(dana.id).count()).toBeGreaterThan(0);
  });
});

describe('the matching guard', () => {
  it('a meeting that lines up with a coffee chat is filed', async () => {
    const r = await importMeetings(user, [meeting()], new Date(END.getTime() + 10 * MIN));
    expect(r.imported).toBe(1);
  });

  it('a meeting with someone the student has a chat with is filed, whenever it was', async () => {
    const r = await importMeetings(
      user,
      [meeting({ id: 'fm_2', startAt: '2026-10-01T15:00:00Z' })],
      new Date(END.getTime() + 10 * MIN),
    );
    expect(r.imported).toBe(1);
  });

  it('a recording of strangers asks first; yes files it as a chat, no files it with nobody', async () => {
    const standup = meeting({
      id: 'fm_standup',
      title: 'Project sync',
      startAt: '2026-10-19T18:00:00Z',
      invitees: [
        { name: 'Priya Shah', email: 'priya@club.org' },
        { name: 'Sam Ortiz', email: 'sam@club.org' },
      ],
      summary: 'Weekly sync for the club project.',
      actionItems: [],
    });
    const people = await db.people.count();
    const r = await importMeetings(user, [standup], new Date(END.getTime() + 10 * MIN));
    expect(r.imported).toBe(0);
    expect(await db.people.count()).toBe(people);
    const card = (await db.suggestions.where('dedupeKey').equals('heldmeeting:fathom:fm_standup').first())!;
    expect(card.kind).toBe('confirm_note_match');
    expect(card.reasonText).toMatch(/^Was your .*meeting with Priya and Sam a networking chat\?$/);
    // a second import does not ask twice
    expect((await importMeetings(user, [standup], new Date(END.getTime() + 20 * MIN))).imported).toBe(0);
    expect(await db.suggestions.where('dedupeKey').equals('heldmeeting:fathom:fm_standup').count()).toBe(1);
    await answerHeldMeeting(user, card.id, false);
    expect(await db.people.count()).toBe(people);
    const filed = await db.notes.where('[source+externalId]').equals(['fathom', 'fathom:fm_standup']).first();
    expect(filed?.matchStatus).toBe('rejected');
  });

  it('answering yes files it as a networking chat', async () => {
    const coffee = meeting({
      id: 'fm_new',
      startAt: '2026-10-19T18:00:00Z',
      invitees: [{ name: 'Marcus Ortiz', email: 'marcus@stripe.com' }],
      summary: 'Marcus manages the payments team. He offered to look at my resume.',
      actionItems: [],
    });
    await importMeetings(user, [coffee], new Date(END.getTime() + 10 * MIN));
    const card = (await db.suggestions.where('dedupeKey').equals('heldmeeting:fathom:fm_new').first())!;
    await answerHeldMeeting(user, card.id, true);
    const marcus = await db.people.where('emails').equals('marcus@stripe.com').first();
    expect(marcus).toBeTruthy();
    const chat = await db.chats.where('personId').equals(marcus!.id).first();
    expect(chat?.stage).toBe('completed');
  });
});
