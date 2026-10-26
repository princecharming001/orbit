import type { CoffeeChat, Person, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { setOrbitApiBaseForTests } from '../integrations/orbitApi';
import { setUnipileUrlForTests } from '../integrations/unipile';
import { createLocalUser } from './account';
import { conversationWith, latestReply, quotedMessageFor } from './conversation';
import { lastInboundOf } from './drafts';
import { syncLinkedInReplies } from './linkedinInbox';

const NOW = new Date('2026-10-20T15:00:00.000Z');
const SENT = '2026-10-15T14:00:00.000Z';
let user: User;

async function seed() {
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
  await db.people.put({
    id: 'p_maya',
    userId: user.id,
    displayName: 'Maya Chen',
    firstName: 'Maya',
    lastName: 'Chen',
    nameNormalized: 'maya chen',
    emails: [],
    linkedinMemberId: 'ACo_maya',
    relationshipType: 'unknown',
    strength: 0.3,
    interactionCount: 1,
    sources: ['manual'],
    isHuman: true,
    tags: [],
    createdAt: SENT,
    updatedAt: SENT,
  } as unknown as Person);
  await db.chats.put({
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
  } satisfies CoffeeChat);
}

/** The proxy's /inbox answers (one per call, the last one repeated), and the request bodies it was asked with. */
function fakeInbox(messages: unknown[], latest: string, more: Record<string, unknown>[] = []) {
  const asked: { after: string; token: string; cursor?: string }[] = [];
  const pages = [{ messages, latest, more: false, cursor: null, complete: true }, ...more];
  const doFetch = (async (url: string, init?: RequestInit) => {
    expect(url).toMatch(/\/inbox$/);
    asked.push(JSON.parse(String(init?.body)));
    const page = pages[Math.min(asked.length - 1, pages.length - 1)];
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { doFetch, asked };
}

/** Orbit itself sent the outreach on LinkedIn (through Unipile), before her reply. */
async function sentByOrbit() {
  await db.outbound.put({
    id: 'out_1',
    userId: user.id,
    personId: 'p_maya',
    chatId: 'c_maya',
    channel: 'linkedin',
    kind: 'outreach',
    bodyDraft: mine.text,
    bodyFinal: mine.text,
    status: 'sent',
    sentAt: SENT,
    providerMessageId: 'li_msg_1',
    generatedBy: 'template',
  } as never);
}

const mine = {
  id: 'm1',
  chatId: 'chat_maya',
  text: 'Hi Maya, would love 15 minutes about your path to Stripe.',
  at: SENT,
  fromMe: true,
  counterpart: { providerId: 'ACo_maya', name: 'Maya Chen' },
};
const hers = {
  id: 'm2',
  chatId: 'chat_maya',
  text: 'Hey Alex, happy to chat! Sending you some times.',
  at: '2026-10-19T09:30:00.000Z',
  fromMe: false,
  counterpart: { providerId: 'ACo_maya', name: 'Maya Chen' },
};
const stranger = {
  id: 'm3',
  chatId: 'chat_x',
  text: 'Hi, are you hiring for our sales platform demo?',
  at: '2026-10-19T10:00:00.000Z',
  fromMe: false,
  counterpart: { providerId: 'ACo_x', name: 'Sam Recruiter' },
};

describe('one inbox (plan 25)', () => {
  beforeEach(async () => {
    await wipeDatabase();
    setOrbitApiBaseForTests(null);
    setConnectorsMockForTests(false);
    setUnipileUrlForTests('https://proxy.test/orbit-connectors');
    user = await createLocalUser({
      fullName: 'Alex Rivera',
      firstName: 'Alex',
      school: 'Cornell University',
    });
    await seed();
  });
  afterEach(() => {
    setOrbitApiBaseForTests(undefined);
    setConnectorsMockForTests(undefined);
    setUnipileUrlForTests(undefined);
  });

  it('keeps LinkedIn messages as messages, once, only for people Orbit has', async () => {
    await sentByOrbit();
    await syncLinkedInReplies(user, { now: NOW, fetch: fakeInbox([mine, hers, stranger], hers.at).doFetch });
    await syncLinkedInReplies(user, { now: NOW, fetch: fakeInbox([mine, hers, stranger], hers.at).doFetch });
    const msgs = await db.messages.toArray();
    expect(msgs.map((m) => m.externalMessageId).sort()).toEqual(['linkedin:m1', 'linkedin:m2']);
    expect(msgs.every((m) => m.channel === 'linkedin')).toBe(true);
    const reply = msgs.find((m) => m.externalMessageId === 'linkedin:m2')!;
    expect(reply).toMatchObject({ direction: 'inbound', fromPersonId: 'p_maya', bodyText: hers.text });
    expect(reply.signal).toBeTruthy();
    const threads = await db.threads.toArray();
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      externalThreadId: 'linkedin:chat_maya',
      channel: 'linkedin',
      participantPersonIds: ['p_maya'],
      messageCount: 2,
    });
    // a LinkedIn thread is never the chat's email thread
    expect((await db.chats.get('c_maya'))?.threadId).toBeUndefined();
    // the stage move points at the stored message, and the notification opens the conversation
    const moved = await db.stageEvents.where('chatId').equals('c_maya').toArray();
    expect(moved.some((e) => e.evidenceRefTable === 'messages' && e.evidenceRefId === reply.id)).toBe(true);
    const n = (await db.notifications.toArray()).find((x) => x.kind === 'reply_received');
    expect(n?.link).toBe('/people/p_maya?tab=conversation');
  });

  it('a LinkedIn reply makes the card that answers it, quoted, drafted on LinkedIn', async () => {
    // the cards come once the student has set Orbit up
    await db.users.update(user.id, { onboardingCompletedAt: SENT });
    user = (await db.users.get(user.id))!;
    await sentByOrbit();
    await syncLinkedInReplies(user, { now: NOW, fetch: fakeInbox([mine, hers], hers.at).doFetch });
    const reply = (await db.messages.where('externalMessageId').equals('linkedin:m2').first())!;
    expect((await latestReply({ personId: 'p_maya' }))?.id).toBe(reply.id);
    expect((await lastInboundOf((await db.chats.get('c_maya'))!))?.lastInboundBody).toBe(hers.text);
    const cards = (await db.suggestions.toArray()).filter(
      (s) => s.chatId === 'c_maya' && s.status === 'pending',
    );
    const card = cards.find((s) => s.payload.inReplyTo === reply.id);
    expect(card, JSON.stringify(cards.map((c) => [c.kind, c.reasonText]))).toBeTruthy();
    expect(card!.reasonText).not.toMatch(/You marked/);
    expect(await quotedMessageFor(card!)).toMatchObject({ channel: 'linkedin', text: hers.text });
    // answered where they wrote, not in an email thread
    const draft = await db.outbound.get(card!.outboundMessageId!);
    expect(draft).toMatchObject({ channel: 'linkedin', kind: 'schedule' });
    expect(draft?.externalThreadId).toBeUndefined();
  });

  it('the conversation reads every channel, oldest first', async () => {
    await sentByOrbit();
    await syncLinkedInReplies(user, { now: NOW, fetch: fakeInbox([mine, hers], hers.at).doFetch });
    await db.people.update('p_maya', { emails: ['maya@stripe.com'], primaryEmail: 'maya@stripe.com' });
    await db.threads.put({
      id: 'th_mail',
      userId: user.id,
      externalThreadId: 'gm_1',
      subject: 'Coffee?',
      messageCount: 1,
      participantEmails: ['maya@stripe.com'],
      participantPersonIds: ['p_maya'],
      isNetworking: true,
    } as never);
    await db.messages.put({
      id: 'm_mail',
      userId: user.id,
      threadId: 'th_mail',
      externalMessageId: 'gm_m1',
      direction: 'inbound',
      fromEmail: 'maya@stripe.com',
      fromPersonId: 'p_maya',
      toEmails: [],
      ccEmails: [],
      sentAt: '2026-10-19T20:00:00.000Z',
      subject: 'Coffee?',
      bodyText: 'Thursday at 3 works.',
      headers: {},
      isAutomated: false,
    });
    await db.textThreads.put({
      id: 'p_maya',
      userId: user.id,
      personId: 'p_maya',
      handles: [],
      inCount: 1,
      outCount: 0,
      firstAt: '2026-10-20T08:00:00.000Z',
      lastAt: '2026-10-20T08:00:00.000Z',
      recent: [{ at: '2026-10-20T08:00:00.000Z', fromMe: false, text: 'Running 5 late' }],
      importedAt: NOW.toISOString(),
    } as never);
    const conv = await conversationWith(user.id, 'p_maya');
    expect(conv.map((m) => [m.channel, m.out, m.text])).toEqual([
      ['linkedin', true, mine.text],
      ['linkedin', false, hers.text],
      ['gmail', false, 'Thursday at 3 works.'],
      ['text', false, 'Running 5 late'],
    ]);
    // the newest reply, across email and LinkedIn
    expect((await latestReply({ personId: 'p_maya', threadId: 'th_mail' }))?.id).toBe('m_mail');
  });
});
