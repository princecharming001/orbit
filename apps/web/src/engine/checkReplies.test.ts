import type { CoffeeChat, Person, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import type { GcalEventRaw } from '../integrations/google';
import { setOrbitApiBaseForTests } from '../integrations/orbitApi';
import { setUnipileUrlForTests } from '../integrations/unipile';
import { createLocalUser } from './account';
import {
  autoCheckReplies,
  CHECK_ON_FOCUS_AFTER_MS,
  checkedAgo,
  checkingReplies,
  checkReplies,
  lastReplyCheck,
} from './checkReplies';
import { approveAndSend, confirmHandoff } from './send';
import { MEETING_OVER_AFTER_MS } from './stages';

// Google as the check sees it: a token (or none), an empty mailbox and whatever the calendar holds
const google = vi.hoisted(() => ({ token: true, events: [] as GcalEventRaw[] }));
vi.mock('../integrations/google', async (orig) => ({
  ...(await orig<typeof import('../integrations/google')>()),
  currentGoogleToken: () =>
    google.token ? { accessToken: 't', expiresAt: Date.now() + 3_600_000 } : undefined,
  gmailListIds: async () => [],
  gmailGet: async () => {
    throw new Error('no mail in this test');
  },
  gcalList: async () => google.events,
}));

const NOW = new Date('2026-10-20T15:00:00.000Z');
const SENT = '2026-10-15T14:00:00.000Z';
const MIN = 60_000;
let user: User;

async function seedPerson() {
  await db.people.put({
    id: 'p_maya',
    userId: user.id,
    displayName: 'Maya Chen',
    firstName: 'Maya',
    lastName: 'Chen',
    nameNormalized: 'maya chen',
    primaryEmail: 'maya@stripe.com',
    emails: ['maya@stripe.com'],
    linkedinMemberId: 'ACo_maya',
    currentOrganizationRaw: 'Stripe',
    relationshipType: 'unknown',
    strength: 0.3,
    interactionCount: 1,
    sources: ['manual'],
    isHuman: true,
    tags: [],
    createdAt: SENT,
    updatedAt: SENT,
  } as unknown as Person);
}

async function seedChat(partial: Partial<CoffeeChat>) {
  const chat: CoffeeChat = {
    id: 'c_maya',
    userId: user.id,
    personId: 'p_maya',
    stage: 'outreach_sent',
    stageEnteredAt: SENT,
    source: 'manual',
    goalTags: [],
    outreachChannel: 'linkedin',
    bumpCount: 0,
    priority: 2,
    firstOutreachAt: SENT,
    lastOutboundAt: SENT,
    createdAt: SENT,
    updatedAt: SENT,
    ...partial,
  };
  await db.chats.put(chat);
  return chat;
}

async function connectGoogle() {
  await db.integrations.put({
    id: 'int_google',
    userId: user.id,
    provider: 'google',
    status: 'active',
    scopes: [],
    syncState: { lastSyncAt: NOW.toISOString() },
    connectedAt: SENT,
  });
}

async function connectLinkedIn() {
  await db.integrations.put({
    id: 'int_li',
    userId: user.id,
    provider: 'linkedin_live',
    externalAccountId: 'acc_1',
    accessToken: 'tok_1',
    status: 'active',
    scopes: [],
    syncState: { rows: 120 },
    connectedAt: SENT,
  });
}

/** The proxy's /inbox answer: these messages, read to the end. */
function inbox(messages: unknown[]) {
  return (async (url: string) => {
    expect(url).toMatch(/\/inbox$/);
    const latest =
      (messages as { at: string }[])
        .map((m) => m.at)
        .sort()
        .at(-1) ?? NOW.toISOString();
    return new Response(JSON.stringify({ messages, latest, more: false, cursor: null, complete: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const dm = (id: string, at: string, fromMe: boolean, text: string) => ({
  id,
  chatId: 'chat_maya',
  text,
  at,
  fromMe,
  counterpart: { providerId: 'ACo_maya', name: 'Maya Chen' },
});

/** A 30-minute calendar event with Maya, as Google lists it. */
function meeting(startAt: string, status = 'confirmed'): GcalEventRaw {
  const start = new Date(startAt);
  return {
    id: 'gcal_maya',
    summary: 'Coffee chat: Maya Chen',
    status,
    start: { dateTime: start.toISOString() },
    end: { dateTime: new Date(start.getTime() + 30 * MIN).toISOString() },
    attendees: [
      { email: user.email, self: true, responseStatus: 'accepted' },
      { email: 'maya@stripe.com', displayName: 'Maya Chen', responseStatus: 'accepted' },
    ],
    created: SENT,
  };
}

const applied = async () =>
  (await db.stageEvents.where('chatId').equals('c_maya').sortBy('createdAt'))
    .filter((e) => e.status === 'applied')
    .map((e) => [e.fromStage, e.toStage, e.actor, e.reason]);

describe('the reply check moves cards on its own', () => {
  beforeEach(async () => {
    await wipeDatabase();
    setOrbitApiBaseForTests(null);
    setConnectorsMockForTests(false);
    setUnipileUrlForTests('https://proxy.test/orbit-connectors');
    google.token = true;
    google.events = [];
    user = await createLocalUser({
      email: 'alex@cornell.edu',
      fullName: 'Alex Rivera',
      firstName: 'Alex',
      school: 'Cornell University',
      schoolDomain: 'cornell.edu',
      onboardingCompletedAt: SENT,
    });
    await seedPerson();
    // the Gmail sync reads the clock itself: pin it to the check's "now"
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    setOrbitApiBaseForTests(undefined);
    setConnectorsMockForTests(undefined);
    setUnipileUrlForTests(undefined);
  });

  it('a LinkedIn DM after the outreach moves the chat to Replied within one check, with its reason, once', async () => {
    await connectLinkedIn();
    await seedChat({});
    const fetch = inbox([
      dm('m1', SENT, true, 'Hi Maya, would love 15 minutes about your path to Stripe.'),
      dm('m2', '2026-10-19T09:30:00.000Z', false, 'Hey Alex, happy to chat! Sending you some times.'),
    ]);
    const r = await checkReplies(user, { now: NOW, reason: 'interval', fetch });
    expect(r.sources).toEqual(['linkedin']);
    expect(r.problems).toEqual([]);
    expect(r.moved).toBe(1);
    const chat = (await db.chats.get('c_maya'))!;
    expect(chat.stage).toBe('replied');
    expect(chat.lastInboundAt).toBe('2026-10-19T09:30:00.000Z');
    expect(await applied()).toEqual([
      ['outreach_sent', 'replied', 'system', 'inbound_signal:reply_positive'],
    ]);
    const ev = (await db.stageEvents.where('chatId').equals('c_maya').first())!;
    expect(ev.evidenceRefTable).toBe('linkedin_messages');
    expect(ev.evidenceRefId).toBe('m2');
    // the record the board's line reads
    expect(await lastReplyCheck(user.id)).toMatchObject({
      checkedAt: NOW.toISOString(),
      sources: ['linkedin'],
      reason: 'interval',
    });

    // the same inbox again: nothing moves twice
    const again = await checkReplies(user, { now: new Date(NOW.getTime() + 3 * MIN), fetch });
    expect(again.moved).toBe(0);
    expect(await applied()).toHaveLength(1);
    expect((await db.chats.get('c_maya'))!.stage).toBe('replied');
  });

  it('a calendar event with the person moves the chat to Scheduled, and its end moves it to Completed', async () => {
    await connectGoogle();
    await seedChat({ stage: 'replied', stageEnteredAt: '2026-10-19T09:30:00.000Z', lastInboundAt: SENT });
    const start = new Date(NOW.getTime() + 2 * 86_400_000).toISOString();
    google.events = [meeting(start)];
    const r = await checkReplies(user, { now: NOW, reason: 'open' });
    expect(r.sources).toEqual(['gmail']);
    expect(r.problems).toEqual([]);
    let chat = (await db.chats.get('c_maya'))!;
    expect(chat.stage).toBe('scheduled');
    expect(chat.scheduledEventId).toBeTruthy();
    expect(await applied()).toEqual([['replied', 'scheduled', 'system', 'calendar:event_scheduled']]);
    // the same calendar a few minutes later: no second move
    await checkReplies(user, { now: new Date(NOW.getTime() + 3 * MIN) });
    expect(await applied()).toHaveLength(1);

    // the meeting ends: the next check finds the chat done, dated when the meeting ended
    const after = new Date(new Date(start).getTime() + 30 * MIN + MEETING_OVER_AFTER_MS + MIN);
    vi.setSystemTime(after);
    const done = await checkReplies(user, { now: after, reason: 'interval' });
    chat = (await db.chats.get('c_maya'))!;
    expect(chat.stage).toBe('completed');
    expect(chat.completedAt).toBe(new Date(new Date(start).getTime() + 30 * MIN).toISOString());
    expect(await applied()).toEqual([
      ['replied', 'scheduled', 'system', 'calendar:event_scheduled'],
      ['scheduled', 'completed', 'system', 'calendar:event_ended'],
    ]);
    expect(done.moved).toBe(1);
    // the thank-you is in Drafts right away
    const thanks = await db.suggestions
      .where('chatId')
      .equals('c_maya')
      .filter((s) => s.kind === 'thank_you' && s.status === 'pending')
      .count();
    expect(thanks).toBe(1);
    // and a check a minute later changes nothing
    await checkReplies(user, { now: new Date(after.getTime() + MIN) });
    expect(await applied()).toHaveLength(2);
  });

  it('with Gmail signed out, the clock still finishes a booked chat whose meeting ended, and the line says why', async () => {
    await connectGoogle();
    google.token = false;
    const start = new Date(NOW.getTime() - 60 * MIN).toISOString();
    await db.events.put({
      id: 'ev_1',
      userId: user.id,
      externalEventId: 'gcal_maya',
      title: 'Coffee chat: Maya Chen',
      startAt: start,
      endAt: new Date(NOW.getTime() - 30 * MIN).toISOString(),
      status: 'confirmed',
      attendees: [{ email: 'maya@stripe.com', displayName: 'Maya Chen' }],
      attendeePersonIds: ['p_maya'],
      isCoffeeChat: true,
      coffeeChatConfidence: 0.9,
      chatId: 'c_maya',
    });
    await seedChat({ stage: 'scheduled', stageEnteredAt: SENT, scheduledEventId: 'ev_1' });
    const r = await checkReplies(user, { now: NOW, reason: 'focus' });
    expect(r.sources).toEqual([]);
    expect(r.problems).toEqual([{ source: 'gmail', message: 'Gmail is signed out' }]);
    expect(r.moved).toBe(1);
    const chat = (await db.chats.get('c_maya'))!;
    expect(chat.stage).toBe('completed');
    expect(await applied()).toEqual([['scheduled', 'completed', 'system', 'calendar:event_ended']]);
    const ev = (await db.stageEvents.where('chatId').equals('c_maya').first())!;
    expect([ev.evidenceRefTable, ev.evidenceRefId]).toEqual(['events', 'ev_1']);
    expect(
      await db.suggestions
        .where('chatId')
        .equals('c_maya')
        .filter((s) => s.kind === 'thank_you' && s.status === 'pending')
        .count(),
    ).toBe(1);
    // a meeting still running (ended five minutes ago) is not over yet
    await db.events.update('ev_1', { endAt: new Date(NOW.getTime() - 5 * MIN).toISOString() });
    await db.chats.update('c_maya', { stage: 'scheduled' });
    await checkReplies(user, { now: NOW });
    expect((await db.chats.get('c_maya'))!.stage).toBe('scheduled');
  });

  it('a sent thank-you moves the chat to Thanked', async () => {
    await seedChat({
      stage: 'completed',
      stageEnteredAt: '2026-10-20T13:30:00.000Z',
      completedAt: '2026-10-20T13:30:00.000Z',
      lastInboundAt: '2026-10-18T09:00:00.000Z',
      outreachChannel: 'gmail',
    });
    await db.outbound.put({
      id: 'out_ty',
      userId: user.id,
      personId: 'p_maya',
      chatId: 'c_maya',
      channel: 'gmail',
      kind: 'thank_you',
      toEmail: 'maya@stripe.com',
      subject: 'Thank you',
      bodyDraft: 'Thank you for taking the time to talk today, Maya. It was really helpful.\n\nBest,\nAlex',
      status: 'draft',
      generatedBy: 'template',
    } as never);
    const body = 'Thank you for taking the time to talk today, Maya. It was really helpful.\n\nBest,\nAlex';
    // no Gmail send permission here: the student copies the text, sends it, and confirms
    const r = await approveAndSend(user, 'out_ty', body, undefined, NOW, { via: 'copy' });
    expect(r.ok).toBe(true);
    expect((await db.outbound.get('out_ty'))!.status).toBe('handed_off');
    expect((await db.chats.get('c_maya'))!.stage).toBe('completed');
    expect((await confirmHandoff(user, 'out_ty', NOW)).ok).toBe(true);
    const chat = (await db.chats.get('c_maya'))!;
    expect(chat.stage).toBe('followed_up');
    expect(chat.followedUpAt).toBe(NOW.toISOString());
    expect(await applied()).toEqual([['completed', 'followed_up', 'system', 'outbound:thank_you']]);
    const ev = (await db.stageEvents.where('chatId').equals('c_maya').first())!;
    expect([ev.evidenceRefTable, ev.evidenceRefId]).toEqual(['outbound', 'out_ty']);
    // a check afterwards leaves it there
    await checkReplies(user, { now: new Date(NOW.getTime() + MIN) });
    expect(await applied()).toHaveLength(1);
  });

  it('the window coming back checks again only after a minute, and overlapping checks share one run', async () => {
    await seedChat({});
    const first = await checkReplies(user, { now: NOW, reason: 'open' });
    expect(first.sources).toEqual([]);
    expect(await autoCheckReplies(user, { now: new Date(NOW.getTime() + 30_000) })).toBeUndefined();
    const again = await autoCheckReplies(user, { now: new Date(NOW.getTime() + CHECK_ON_FOCUS_AFTER_MS) });
    expect(again?.reason).toBe('focus');
    expect((await lastReplyCheck(user.id))?.checkedAt).toBe(
      new Date(NOW.getTime() + CHECK_ON_FOCUS_AFTER_MS).toISOString(),
    );
    const a = checkReplies(user, { now: NOW });
    expect(checkingReplies()).toBe(true);
    const b = checkReplies(user, { now: NOW });
    expect(b).toBe(a);
    await a;
    expect(checkingReplies()).toBe(false);
  });

  it('the sample student has nothing to read: only the rules run, and nothing is fetched', async () => {
    setConnectorsMockForTests(true);
    await connectLinkedIn();
    await seedChat({});
    const r = await checkReplies(user, {
      now: NOW,
      fetch: (() => {
        throw new Error('the demo never calls the proxy');
      }) as never,
    });
    expect(r.sources).toEqual([]);
    expect(r.problems).toEqual([]);
    expect((await db.chats.get('c_maya'))!.stage).toBe('outreach_sent');
  });

  it('says how long ago in minutes', () => {
    const now = NOW;
    expect(checkedAgo(now.toISOString(), now)).toBe('just now');
    expect(checkedAgo(new Date(now.getTime() - 2 * MIN).toISOString(), now)).toBe('2 min ago');
    expect(checkedAgo(new Date(now.getTime() - 3 * 60 * MIN).toISOString(), now)).toBe('3 h ago');
    expect(checkedAgo(new Date(now.getTime() - 2 * 86_400_000).toISOString(), now)).toBe('2 days ago');
  });
});
