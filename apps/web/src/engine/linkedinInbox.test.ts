import type { CoffeeChat, Person, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { setOrbitApiBaseForTests } from '../integrations/orbitApi';
import { setUnipileUrlForTests } from '../integrations/unipile';
import { createLocalUser } from './account';
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

/** The proxy's /inbox answer, and the request bodies it was asked with. */
function fakeInbox(messages: unknown[], latest: string) {
  const asked: { after: string; token: string }[] = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    expect(url).toMatch(/\/inbox$/);
    asked.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ messages, latest, more: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { doFetch, asked };
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

describe('LinkedIn replies', () => {
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

  it('a reply from someone the student wrote to moves their chat on, once, and strangers are left alone', async () => {
    const latest = '2026-10-19T10:00:00.000Z';
    const first = fakeInbox([mine, hers, stranger], latest);
    const r = await syncLinkedInReplies(user, { now: NOW, fetch: first.doFetch });
    expect(r).toEqual({ ok: true, replies: 1, people: ['Maya'] });
    expect(first.asked[0]).toMatchObject({ accountId: 'acc_1', token: 'tok_1' });
    // the first read looks back thirty days
    expect(Date.parse(first.asked[0]!.after)).toBe(NOW.getTime() - 30 * 86_400_000);
    const chat = (await db.chats.get('c_maya'))!;
    expect(chat.stage).toBe('replied');
    expect(chat.lastInboundAt).toBe(hers.at);
    const notes = await db.notifications.where('userId').equals(user.id).toArray();
    expect(notes.filter((n) => n.kind === 'reply_received').map((n) => n.title)).toEqual([
      'Maya replied on LinkedIn',
    ]);
    expect(await db.people.where('userId').equals(user.id).count()).toBe(1);
    const row = (await db.integrations.get('int_li'))!;
    // the connection sync's own state is kept next to the checkpoint
    expect(row.syncState).toMatchObject({
      rows: 120,
      repliesAfter: latest,
      repliesCheckedAt: NOW.toISOString(),
    });

    // the next read starts just before the checkpoint and records nothing twice
    const again = fakeInbox([hers], latest);
    const r2 = await syncLinkedInReplies(user, { now: NOW, fetch: again.doFetch });
    expect(r2).toEqual({ ok: true, replies: 0, people: [] });
    expect(Date.parse(again.asked[0]!.after)).toBe(Date.parse(latest) - 60_000);
    expect(
      (await db.notifications.where('userId').equals(user.id).toArray()).filter(
        (n) => n.kind === 'reply_received',
      ),
    ).toHaveLength(1);
  });

  it('matches by name only for someone the student writes to on LinkedIn, and keeps the member id', async () => {
    await db.people.update('p_maya', { linkedinMemberId: undefined });
    const byName = { ...hers, counterpart: { providerId: 'ACo_new', name: 'Maya  Chen' } };
    const r = await syncLinkedInReplies(user, { now: NOW, fetch: fakeInbox([byName], hers.at).doFetch });
    expect(r).toMatchObject({ ok: true, replies: 1 });
    expect((await db.people.get('p_maya'))!.linkedinMemberId).toBe('ACo_new');
  });

  it('says LinkedIn is not connected when it is not', async () => {
    await db.integrations.update('int_li', { status: 'revoked' });
    const r = await syncLinkedInReplies(user, { now: NOW, fetch: fakeInbox([], NOW.toISOString()).doFetch });
    expect(r).toMatchObject({ ok: false, reason: 'not_connected' });
  });
});
