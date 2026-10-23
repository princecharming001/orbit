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

  it('a reply to an outreach Orbit sent on LinkedIn moves their chat on, once, and strangers are left alone', async () => {
    await sentByOrbit();
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

  it('a reply to an outreach the student sent by hand on LinkedIn moves the chat on, and both messages are touches', async () => {
    const r = await syncLinkedInReplies(user, {
      now: NOW,
      fetch: fakeInbox([mine, hers], hers.at).doFetch,
    });
    expect(r).toEqual({ ok: true, replies: 1, people: ['Maya'] });
    const chat = (await db.chats.get('c_maya'))!;
    // Orbit read the student's own message to her in this inbox first: her answer after it is the reply
    expect(chat.stage).toBe('replied');
    expect(chat.lastInboundAt).toBe(hers.at);
    const events = await db.stageEvents.where('chatId').equals('c_maya').toArray();
    expect(events.map((e) => [e.toStage, e.status, e.confidence])).toEqual([['replied', 'applied', 0.85]]);
    // her message and the student's are part of their history, one touch per day each way
    const tps = await db.touchpoints.where('personId').equals('p_maya').toArray();
    expect(tps.map((t) => [t.kind, t.occurredAt]).sort()).toEqual([
      ['linkedin_in', hers.at],
      ['linkedin_out', mine.at],
    ]);
    // nothing invented: no "They replied" touch next to the real message
    expect(tps.some((t) => t.refTable === 'stage_evidence')).toBe(false);
  });

  it('a LinkedIn message answering an ask that went out by email is proposed for the student to confirm', async () => {
    await db.chats.update('c_maya', { outreachChannel: 'gmail' });
    // nothing of the student's in this LinkedIn chat: Orbit cannot be sure what her message answers
    const r = await syncLinkedInReplies(user, { now: NOW, fetch: fakeInbox([hers], hers.at).doFetch });
    expect(r).toEqual({ ok: true, replies: 1, people: ['Maya'] });
    const chat = (await db.chats.get('c_maya'))!;
    expect(chat.stage).toBe('outreach_sent');
    expect(chat.lastInboundAt).toBe(hers.at);
    const events = await db.stageEvents.where('chatId').equals('c_maya').toArray();
    expect(events.map((e) => [e.toStage, e.status, e.confidence])).toEqual([['replied', 'proposed', 0.7]]);
  });

  it('a message from before the outreach is no reply, and an old conversation never starts a chat', async () => {
    // she wrote first (a day before the student's note): that answers nothing
    const early = { ...hers, id: 'm0', at: '2026-10-14T09:00:00.000Z' };
    const r = await syncLinkedInReplies(user, { now: NOW, fetch: fakeInbox([early], early.at).doFetch });
    expect(r).toEqual({ ok: true, replies: 0, people: [] });
    const waiting = (await db.chats.get('c_maya'))!;
    expect(waiting.stage).toBe('outreach_sent');
    expect(waiting.lastInboundAt).toBeUndefined();
    expect(await db.notifications.where('userId').equals(user.id).count()).toBe(0);
    expect(await db.stageEvents.count()).toBe(0);
    // ...but it is still a message between them, for closeness
    expect((await db.touchpoints.where('personId').equals('p_maya').toArray()).map((t) => t.kind)).toEqual([
      'linkedin_in',
    ]);

    // a chat opened today, "To contact": an exchange from three weeks ago is history, not its outreach or a reply
    await db.chats.update('c_maya', {
      stage: 'identified',
      stageEnteredAt: NOW.toISOString(),
      firstOutreachAt: undefined,
      lastOutboundAt: undefined,
      createdAt: '2026-10-20T08:00:00.000Z',
    });
    await db.integrations.update('int_li', { syncState: { rows: 120 } });
    const oldMine = { ...mine, id: 'o1', at: '2026-09-28T10:00:00.000Z' };
    const oldHers = { ...hers, id: 'o2', at: '2026-09-29T10:00:00.000Z' };
    const again = await syncLinkedInReplies(user, {
      now: NOW,
      fetch: fakeInbox([oldMine, oldHers], oldHers.at).doFetch,
    });
    expect(again).toEqual({ ok: true, replies: 0, people: [] });
    const fresh = (await db.chats.get('c_maya'))!;
    expect(fresh.stage).toBe('identified');
    expect(fresh.firstOutreachAt ?? fresh.lastOutboundAt).toBeUndefined();
    expect(await db.stageEvents.count()).toBe(0);
  });

  it('never matches by name: a namesake gets no reply and no member id', async () => {
    await db.people.update('p_maya', { linkedinMemberId: undefined });
    const byName = { ...hers, counterpart: { providerId: 'ACo_new', name: 'Maya  Chen' } };
    const r = await syncLinkedInReplies(user, { now: NOW, fetch: fakeInbox([byName], hers.at).doFetch });
    expect(r).toEqual({ ok: true, replies: 0, people: [] });
    expect((await db.people.get('p_maya'))!.linkedinMemberId).toBeUndefined();
    expect((await db.chats.get('c_maya'))!.stage).toBe('outreach_sent');
    expect(await db.touchpoints.count()).toBe(0);
  });

  it('reads on with the cursor, and keeps the checkpoint when the read could not finish', async () => {
    await sentByOrbit();
    // two calls: the newest messages first, then the older ones through the cursor
    const paged = fakeInbox([hers], hers.at, [
      { messages: [mine], latest: mine.at, cursor: null, complete: true },
    ]);
    await db.integrations.update('int_li', { syncState: { rows: 120 } });
    const pages = paged.doFetch;
    const firstCall = (async (url: string, init?: RequestInit) => {
      const res = await pages(url, init);
      const body = await res.json();
      // the first answer says more are waiting
      return new Response(JSON.stringify(paged.asked.length === 1 ? { ...body, cursor: 'c2' } : body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    expect(await syncLinkedInReplies(user, { now: NOW, fetch: firstCall })).toMatchObject({ replies: 1 });
    expect(paged.asked.map((a) => a.cursor)).toEqual([undefined, 'c2']);
    expect((await db.integrations.get('int_li'))!.syncState).toMatchObject({ repliesAfter: hers.at });

    // a read some of whose messages could not be placed: what was read counts, the checkpoint stays put
    const before = (await db.integrations.get('int_li'))!.syncState as { repliesAfter: string };
    const partial = fakeInbox([], NOW.toISOString());
    const broken = (async (url: string, init?: RequestInit) => {
      await partial.doFetch(url, init);
      return new Response(
        JSON.stringify({ messages: [], latest: NOW.toISOString(), cursor: null, complete: false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    await syncLinkedInReplies(user, { now: NOW, fetch: broken });
    expect((await db.integrations.get('int_li'))!.syncState).toMatchObject({
      repliesAfter: before.repliesAfter,
    });
  });

  it('says LinkedIn is not connected when it is not', async () => {
    await db.integrations.update('int_li', { status: 'revoked' });
    const r = await syncLinkedInReplies(user, { now: NOW, fetch: fakeInbox([], NOW.toISOString()).doFetch });
    expect(r).toMatchObject({ ok: false, reason: 'not_connected' });
  });
});
