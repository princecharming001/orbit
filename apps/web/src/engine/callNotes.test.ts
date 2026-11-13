/**
 * Zoom and Google Meet as a source of notes: a coffee chat held on their link gets the call's transcript, filed by the
 * notetakers' pipeline, never twice and never over a notetaker's notes; Zoom without Orbit's keys is cleanly "not set
 * up"; and the call link Orbit puts on an invite it books.
 */
import type { CalendarEvent, CoffeeChat, Person, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import type { FathomMeeting } from '../integrations/notesApps';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import type { FakeOrbitApi } from '../test/fakeOrbitApi';
import { createLocalUser } from './account';
import { sendCalendarInvite } from './calendarInvite';
import {
  CALL_AFTER_NOTETAKER_MIN,
  callAppForEvent,
  callAppStatus,
  connectCallApp,
  connectedCallApps,
  disconnectCallApp,
  pullCallNotes,
  refreshCallApp,
} from './callNotes';
import { afterText, upcomingChats } from './chatsView';
import { checkNotes } from './notesCheck';
import { setMeetingLink } from './settings';

const page = vi.hoisted(() => ({ meetings: [] as unknown[], calls: 0 }));
vi.mock('../integrations/notesApps', async (orig) => ({
  ...(await orig<typeof import('../integrations/notesApps')>()),
  fathomMeetingsPage: async () => {
    page.calls++;
    return { ok: true, value: { meetings: page.meetings, nextCursor: undefined } };
  },
}));

const MIN = 60_000;
const START = new Date('2026-10-20T19:00:00Z');
const END = new Date(START.getTime() + 30 * MIN);
const ZOOM_URL = 'https://us02web.zoom.us/j/85012345678?pwd=abc';
const MEET_URL = 'https://meet.google.com/abc-defg-hij';

const dana = (userId: string): Person => ({
  id: 'p_dana',
  userId,
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
});

async function seed(user: User, conferenceUrl: string | undefined) {
  await db.people.put(dana(user.id));
  const ev: CalendarEvent = {
    id: 'ev_dana',
    userId: user.id,
    externalEventId: 'g_ev_dana',
    title: 'Dana / Alex coffee chat',
    startAt: START.toISOString(),
    endAt: END.toISOString(),
    status: 'confirmed',
    attendees: [
      { email: user.email, self: true },
      { email: 'dana@stripe.com', displayName: 'Dana Lee' },
    ],
    attendeePersonIds: ['p_dana'],
    conferenceUrl,
    isCoffeeChat: true,
    chatId: 'c_dana',
  };
  const chat: CoffeeChat = {
    id: 'c_dana',
    userId: user.id,
    personId: 'p_dana',
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
  return ev;
}

const at = (minAfterEnd: number) => new Date(END.getTime() + minAfterEnd * MIN);

async function chatsRow(user: User, now: Date) {
  const [events, chats, people, notes, facts, suggestions] = await Promise.all([
    db.events.toArray(),
    db.chats.toArray(),
    db.people.toArray(),
    db.notes.toArray(),
    db.facts.toArray(),
    db.suggestions.toArray(),
  ]);
  const v = upcomingChats(
    { events, chats, people, notes, facts, suggestions, callApps: await connectedCallApps(user.id) },
    now,
    'America/Detroit',
  );
  return v.justHappened.find((r) => r.person.id === 'p_dana')!;
}

describe('the demo: Zoom and Meet bring a call’s transcript', () => {
  let user: User;
  beforeEach(async () => {
    await wipeDatabase();
    setConnectorsMockForTests(true);
    user = await createLocalUser({ fullName: 'Alex Rivera', email: 'alex@umich.edu', school: 'Michigan' });
    await db.users.update(user.id, {
      onboardingCompletedAt: '2026-09-01T00:00:00Z',
      timezone: 'America/Detroit',
    });
    user = (await db.users.get(user.id))!;
    page.meetings = [];
    page.calls = 0;
  });
  afterEach(() => setConnectorsMockForTests(undefined));

  it('connecting Zoom, then the notes check files the transcript and the Chats row flips', async () => {
    await seed(user, ZOOM_URL);
    const r = await connectCallApp(user, 'zoom', at(-120));
    expect(r).toEqual({ ok: true, imported: 0 });
    expect((await callAppStatus(user, 'zoom')).connected).toBe(true);
    // before the check: the row waits for Zoom
    expect(afterText((await chatsRow(user, at(5))).after!)).toBe("Waiting for Zoom's notes");
    const out = await checkNotes(user, { now: at(10) });
    expect(out).toEqual({ asked: ['ev_dana'], imported: 1 });
    const notes = await db.notes.toArray();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ source: 'zoom', calendarEventId: 'ev_dana', personIds: ['p_dana'] });
    expect(notes[0]!.rawText).toContain('Summary:');
    expect(notes[0]!.rawText).toContain('Dana Lee: Of course, happy to help.');
    expect((await db.chats.get('c_dana'))!.stage).toBe('completed');
    const row = await chatsRow(user, at(11));
    expect(row.after?.kind).toBe('notes_in');
    expect((await callAppStatus(user, 'zoom')).meetings).toBe(1);
    // asked again later: nothing new, never a second note
    await checkNotes(user, { now: at(30) });
    await pullCallNotes(user, { now: at(40), firstLook: true });
    expect(await db.notes.count()).toBe(1);
  });

  it('Meet files only chats on a Meet link, and Zoom only chats on a Zoom link', async () => {
    await seed(user, MEET_URL);
    await connectCallApp(user, 'zoom', at(-120));
    expect((await checkNotes(user, { now: at(10) })).asked).toEqual([]);
    expect(await db.notes.count()).toBe(0);
    await connectCallApp(user, 'google_meet', at(-120));
    expect((await checkNotes(user, { now: at(30) })).imported).toBe(1);
    const [n] = await db.notes.toArray();
    expect(n!.source).toBe('google_meet');
    expect(n!.rawText).not.toContain('Summary:');
  });

  it('connecting looks back over the last two weeks once', async () => {
    await seed(user, ZOOM_URL);
    const r = await connectCallApp(user, 'zoom', at(60 * 24));
    expect(r).toEqual({ ok: true, imported: 1 });
  });

  it('off means off: nothing is asked and the row says no notetaker', async () => {
    await seed(user, ZOOM_URL);
    await connectCallApp(user, 'zoom', at(-120));
    await disconnectCallApp(user, 'zoom');
    expect(await connectedCallApps(user.id)).toEqual([]);
    expect((await checkNotes(user, { now: at(10) })).asked).toEqual([]);
    expect((await chatsRow(user, at(10))).after?.kind).toBe('no_notetaker');
  });
});

describe('beside a notetaker: never a duplicate', () => {
  let user: User;
  beforeEach(async () => {
    await wipeDatabase();
    setConnectorsMockForTests(true);
    user = await createLocalUser({ fullName: 'Alex Rivera', email: 'alex@umich.edu', school: 'Michigan' });
    await db.users.update(user.id, {
      onboardingCompletedAt: '2026-09-01T00:00:00Z',
      timezone: 'America/Detroit',
    });
    user = (await db.users.get(user.id))!;
    await seed(user, ZOOM_URL);
    await connectCallApp(user, 'zoom', at(-120));
    // Fathom is on (a real key, not the demo's, so the mock above answers it)
    await db.integrations.put({
      id: 'i_fathom',
      userId: user.id,
      provider: 'fathom',
      accessToken: 'fathom-key',
      status: 'active',
      scopes: [],
      syncState: { since: '2026-09-01T00:00:00Z' },
      connectedAt: '2026-09-01T00:00:00Z',
    });
    page.calls = 0;
    page.meetings = [];
  });
  afterEach(() => setConnectorsMockForTests(undefined));

  const fathomMeeting = (): FathomMeeting => ({
    id: 'fm_1',
    title: 'Coffee chat: Dana Lee',
    startAt: START.toISOString(),
    invitees: [{ name: 'Dana Lee', email: 'dana@stripe.com', external: true }],
    recordedBy: 'alex@umich.edu',
    summary: 'Dana leads the payments API team at Stripe. She offered to introduce Alex to the recruiter.',
    actionItems: [],
  });

  it('the notetaker brought notes: Zoom files nothing for that chat', async () => {
    page.meetings = [fathomMeeting()];
    await checkNotes(user, { now: at(10) });
    await checkNotes(user, { now: at(CALL_AFTER_NOTETAKER_MIN) });
    await checkNotes(user, { now: at(60) });
    const notes = await db.notes.toArray();
    expect(notes.map((n) => n.source)).toEqual(['fathom']);
  });

  it('the notetaker goes first, and Zoom fills in once it brought nothing', async () => {
    await checkNotes(user, { now: at(10) });
    expect(page.calls).toBe(1);
    expect(await db.notes.count()).toBe(0);
    await checkNotes(user, { now: at(CALL_AFTER_NOTETAKER_MIN) });
    const notes = await db.notes.toArray();
    expect(notes.map((n) => n.source)).toEqual(['zoom']);
    // the Chats row names the notetaker while it waits, and shows the notes once in
    expect((await chatsRow(user, at(31))).after?.kind).toBe('notes_in');
  });
});

describe('an Orbit account: the server reads the call', () => {
  let api: FakeOrbitApi;
  let user: User;
  beforeEach(async () => {
    await wipeDatabase();
    ({ api, user } = await signInToFakeApi());
    await db.users.update(user.id, {
      onboardingCompletedAt: '2026-09-01T00:00:00Z',
      timezone: 'America/Detroit',
    });
    user = (await db.users.get(user.id))!;
  });
  afterEach(async () => {
    await leaveFakeApi();
  });

  it('Zoom without Orbit’s keys: the row says not set up, connecting says so, nothing asks Zoom', async () => {
    api.state.callApps.zoom.configured = false;
    await seed(user, ZOOM_URL);
    await refreshCallApp(user, 'zoom');
    const st = await callAppStatus(user, 'zoom');
    expect(st).toMatchObject({ supported: true, configured: false, connected: false, needsReauth: false });
    const r = await connectCallApp(user, 'zoom');
    expect(r).toEqual({ ok: false, reason: 'not_set_up', message: 'Zoom is not set up on Orbit yet.' });
    await checkNotes(user, { now: at(10) });
    expect(api.calls.filter((c) => c.route === '/zoom/notes')).toHaveLength(0);
    expect(api.calls.filter((c) => c.route === '/zoom/meetings')).toHaveLength(0);
  });

  it('Zoom on: the check sends the chat, files what the server found, and the row updates', async () => {
    const z = api.state.callApps.zoom;
    z.status = 'active';
    z.email = 'alex@school.edu';
    z.notes.ev_dana = {
      meetingId: 'uuid-1',
      title: 'Coffee with Dana',
      transcript: 'Dana Lee: She offered to introduce Alex to the recruiter.',
      summary: 'Dana talked about the payments team.',
    };
    await seed(user, ZOOM_URL);
    await refreshCallApp(user, 'zoom');
    expect(await callAppStatus(user, 'zoom')).toMatchObject({ connected: true, email: 'alex@school.edu' });
    const out = await checkNotes(user, { now: at(10) });
    expect(out.imported).toBe(1);
    const sent = api.calls.find((c) => c.route === '/zoom/notes')!.body as {
      events: { id: string; conferenceUrl: string; attendees: { email: string }[] }[];
    };
    expect(sent.events).toEqual([
      expect.objectContaining({
        id: 'ev_dana',
        conferenceUrl: ZOOM_URL,
        attendees: [{ name: 'Dana Lee', email: 'dana@stripe.com' }],
      }),
    ]);
    const [n] = await db.notes.toArray();
    expect(n).toMatchObject({ source: 'zoom', externalId: 'zoom:uuid-1', calendarEventId: 'ev_dana' });
  });

  it('a refused Zoom sign-in marks the row to sign in again', async () => {
    api.state.callApps.zoom.status = 'active';
    await seed(user, ZOOM_URL);
    await refreshCallApp(user, 'zoom');
    api.state.callApps.zoom.status = 'needs_reauth';
    const r = await pullCallNotes(user, { now: at(10), firstLook: true });
    expect(r.needs).toEqual(['zoom']);
    expect(await callAppStatus(user, 'zoom')).toMatchObject({ connected: false, needsReauth: true });
  });

  it('Meet asks Google for the permission first, and files the transcript once it is on', async () => {
    const m = api.state.callApps.meet;
    m.notes.ev_dana = { meetingId: 'conferenceRecords/r1', title: 'Dana', transcript: 'Dana Lee: Hello.' };
    await seed(user, MEET_URL);
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    try {
      const r = await connectCallApp(user, 'google_meet');
      expect(r).toEqual({ ok: true, imported: 0, leaving: true });
      expect(assign).toHaveBeenCalledWith('https://accounts.google.test/o/oauth2/v2/auth');
    } finally {
      vi.unstubAllGlobals();
    }
    await refreshCallApp(user, 'google_meet');
    expect(await callAppStatus(user, 'google_meet')).toMatchObject({ connected: false, needsConsent: true });
    expect((await checkNotes(user, { now: at(10) })).asked).toEqual([]);
    m.granted = true;
    await refreshCallApp(user, 'google_meet');
    expect((await checkNotes(user, { now: at(30) })).imported).toBe(1);
    expect((await db.notes.toArray())[0]!.source).toBe('google_meet');
  });
});

describe('the call link on an invite Orbit books', () => {
  let user: User;
  beforeEach(async () => {
    await wipeDatabase();
    setConnectorsMockForTests(true);
    user = await createLocalUser({ fullName: 'Alex Rivera', email: 'alex@umich.edu', school: 'Michigan' });
    user = (await db.users.get(user.id))!;
    await db.people.put(dana(user.id));
    await db.chats.put({
      id: 'c_dana',
      userId: user.id,
      personId: 'p_dana',
      stage: 'scheduling',
      stageEnteredAt: '2026-10-15T00:00:00Z',
      source: 'manual',
      goalTags: [],
      bumpCount: 0,
      priority: 2,
      createdAt: '2026-10-10T00:00:00Z',
      updatedAt: '2026-10-15T00:00:00Z',
    });
  });
  afterEach(() => setConnectorsMockForTests(undefined));

  const book = async () => {
    const chat = (await db.chats.get('c_dana'))!;
    return sendCalendarInvite(user, chat, {
      at: new Date('2026-11-20T15:00:00Z'),
      now: new Date('2026-11-13T15:00:00Z'),
    });
  };

  it('Google Meet by default', async () => {
    const r = await book();
    expect(r.ok && r.meetUrl).toMatch(/^https:\/\/meet\.google\.com\//);
  });

  it('a Zoom meeting when the student picked Zoom', async () => {
    await setMeetingLink(user.id, 'zoom');
    const r = await book();
    expect(r.ok && r.meetUrl).toMatch(/^https:\/\/zoom\.us\/j\/8\d{9}$/);
    expect(r.ok && callAppForEvent(r.event, ['zoom'])).toBe('zoom');
  });

  it('no link when the student picked none', async () => {
    await setMeetingLink(user.id, 'none');
    const r = await book();
    expect(r.ok).toBe(true);
    expect(r.ok && r.meetUrl).toBeUndefined();
  });
});

describe('the setting reaches the server', () => {
  afterEach(async () => {
    await leaveFakeApi();
  });
  it('saved here and as users.settings.meeting_link; unchanged sends nothing', async () => {
    await wipeDatabase();
    const { api, user } = await signInToFakeApi();
    await setMeetingLink(user.id, 'zoom');
    await setMeetingLink(user.id, 'zoom');
    expect((await db.settings.get(user.id))?.meetingLink).toBe('zoom');
    expect(api.state.profile.meetingLink).toBe('zoom');
    await setMeetingLink(user.id, 'meet');
    expect(api.state.profile.meetingLink).toBeUndefined();
    expect(api.calls.filter((c) => c.route === '/settings/profile').map((c) => c.body)).toEqual([
      { meetingLink: 'zoom' },
      { meetingLink: 'meet' },
    ]);
  });
});
