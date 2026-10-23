import type { Person, User } from '@orbit/core';
import { isKnownContact } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { setOrbitApiBaseForTests } from '../integrations/orbitApi';
import { setUnipileUrlForTests } from '../integrations/unipile';
import { createLocalUser } from './account';
import { autoSyncLinkedInActivity, syncLinkedInActivity } from './linkedinActivity';

const NOW = new Date('2026-10-20T15:00:00.000Z');
let user: User;

async function person(id: string, name: string, memberId: string | undefined, patch: Partial<Person> = {}) {
  const [first, last] = name.split(' ');
  await db.people.put({
    id,
    userId: user.id,
    displayName: name,
    firstName: first!,
    lastName: last!,
    nameNormalized: name.toLowerCase(),
    emails: [],
    linkedinMemberId: memberId,
    relationshipType: 'unknown',
    strength: 0,
    interactionCount: 0,
    sources: ['linkedin_csv'],
    isHuman: true,
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  } as unknown as Person);
}

type Answer = Record<string, unknown>;
/** The proxy: answers per route, one per call in order (the last one repeated), and the bodies it was asked with. */
function fakeProxy(routes: Record<string, Answer[]>) {
  const asked: { path: string; body: Record<string, unknown> }[] = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    const path = url.replace(/.*orbit-connectors/, '');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    asked.push({ path, body });
    const list = routes[path];
    if (!list) return new Response('{}', { status: 404 });
    const n = asked.filter((a) => a.path === path).length - 1;
    return new Response(JSON.stringify(list[Math.min(n, list.length - 1)]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { doFetch, asked };
}

const dm = (id: string, at: string, out: boolean, text = 'hi') => ({ id, at, out, text });
const noPosts: Answer = { ok: true, items: [], postsRead: [], ownDone: true, cursor: null };

describe('LinkedIn activity into closeness', () => {
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
    await db.integrations.put({
      id: 'int_li',
      userId: user.id,
      provider: 'linkedin_live',
      externalAccountId: 'acc_1',
      accessToken: 'tok_1',
      status: 'active',
      scopes: [],
      syncState: { rows: 3, repliesAfter: '2026-10-19T00:00:00.000Z' },
      connectedAt: '2026-10-01T00:00:00.000Z',
    });
    await person('p_maya', 'Maya Chen', 'ACoMaya', { linkedinConnectedOn: '2024-05-01' });
    await person('p_sam', 'Sam Lee', 'ACoSam');
    // a namesake Orbit has no member id for: never matched by name
    await person('p_jo', 'Jo Park', undefined);
  });
  afterEach(() => {
    setOrbitApiBaseForTests(undefined);
    setConnectorsMockForTests(undefined);
    setUnipileUrlForTests(undefined);
  });

  it('turns the whole chat history into one touch per person per day each way, by member id only, once', async () => {
    const chats = [
      {
        chatId: 'c1',
        memberId: 'ACoMaya',
        name: 'Maya Chen',
        messages: [
          dm('a1', '2026-10-18T09:00:00.000Z', true, 'Hey Maya!'),
          dm('a2', '2026-10-18T15:00:00.000Z', false, 'Hi Alex'),
          dm('a3', '2026-10-18T16:00:00.000Z', false, 'Free Thursday?'),
          dm('a4', '2026-10-19T08:00:00.000Z', true, 'Thursday works'),
        ],
      },
      // nobody Orbit has, and a name that matches someone without a member id: both left alone
      {
        chatId: 'c2',
        memberId: 'ACoStranger',
        name: 'Jo Park',
        messages: [dm('b1', '2026-10-18T10:00:00.000Z', false)],
      },
    ];
    const proxy = fakeProxy({
      '/chats/history': [
        { chats: chats.slice(0, 1), latest: '2026-10-19T08:00:00.000Z', cursor: 'next' },
        { chats: chats.slice(1), latest: '2026-10-18T10:00:00.000Z', cursor: null },
      ],
      '/posts/activity': [noPosts],
    });
    const seen: number[] = [];
    const r = await syncLinkedInActivity(user, {
      now: NOW,
      fetch: proxy.doFetch,
      onProgress: (n) => seen.push(n),
    });
    expect(r).toEqual({ ok: true, messages: 5, engagement: 0, people: 1, complete: true });
    expect(seen).toEqual([4, 5]);
    // the first read is the whole history (no `after`), then the cursor
    const hist = proxy.asked.filter((a) => a.path === '/chats/history');
    expect(hist[0]!.body).toMatchObject({ accountId: 'acc_1', token: 'tok_1' });
    expect(hist[0]!.body.after).toBeUndefined();
    expect(hist[1]!.body.cursor).toBe('next');
    const tps = (await db.touchpoints.where('userId').equals(user.id).toArray()).sort((a, b) =>
      a.occurredAt.localeCompare(b.occurredAt),
    );
    // each direction is dated by its own first message that day: her reply came six hours after his note
    expect(tps.map((t) => [t.personId, t.kind, t.occurredAt])).toEqual([
      ['p_maya', 'linkedin_out', '2026-10-18T09:00:00.000Z'],
      ['p_maya', 'linkedin_in', '2026-10-18T15:00:00.000Z'],
      ['p_maya', 'linkedin_out', '2026-10-19T08:00:00.000Z'],
    ]);
    const maya = (await db.people.get('p_maya'))!;
    expect(maya.strength).toBeGreaterThan(0);
    expect(maya.strengthBreakdown?.counts).toMatchObject({ linkedin_in: 1, linkedin_out: 2 });
    expect(maya.tieExplanation?.join(' ')).toMatch(/3 messages between you/);
    expect((await db.people.get('p_jo'))!.linkedinMemberId).toBeUndefined();
    // the checkpoint is the newest message; the reply reader's state is kept next to it
    expect((await db.integrations.get('int_li'))!.syncState).toMatchObject({
      rows: 3,
      repliesAfter: '2026-10-19T00:00:00.000Z',
      dmAfter: '2026-10-19T08:00:00.000Z',
    });

    // read again: only since the checkpoint, and nothing doubles
    const again = fakeProxy({
      '/chats/history': [{ chats: chats.slice(0, 1), latest: '2026-10-19T08:00:00.000Z', cursor: null }],
    });
    expect(await syncLinkedInActivity(user, { now: NOW, fetch: again.doFetch })).toMatchObject({
      ok: true,
      people: 0,
    });
    expect(again.asked[0]!.body.after).toBe('2026-10-19T07:59:00.000Z');
    expect(await db.touchpoints.where('userId').equals(user.id).count()).toBe(3);
    // post engagement is read once a day, not on every run
    expect(again.asked.some((a) => a.path === '/posts/activity')).toBe(false);
  });

  it('keeps its place when a read is cut short, and carries on from there when the app opens', async () => {
    const first = fakeProxy({
      '/chats/history': [
        {
          chats: [
            { chatId: 'c1', memberId: 'ACoSam', messages: [dm('s1', '2026-10-10T10:00:00.000Z', false)] },
          ],
          latest: '2026-10-10T10:00:00.000Z',
          cursor: 'k2',
        },
      ],
      '/posts/activity': [noPosts],
    });
    const r = await syncLinkedInActivity(user, { now: NOW, fetch: first.doFetch, dmCalls: 1 });
    expect(r).toMatchObject({ ok: true, complete: false, messages: 1 });
    const st = (await db.integrations.get('int_li'))!.syncState as Record<string, unknown>;
    // no checkpoint yet: older messages are still unread
    expect(st.dmAfter).toBeUndefined();
    expect(st).toMatchObject({ dmCursor: 'k2', dmPendingLatest: '2026-10-10T10:00:00.000Z' });
    // too soon after the last read: nothing
    expect(await autoSyncLinkedInActivity(user, new Date(NOW.getTime() + 60_000))).toBeUndefined();
    const rest = fakeProxy({
      '/chats/history': [
        {
          chats: [
            { chatId: 'c1', memberId: 'ACoSam', messages: [dm('s0', '2026-09-01T10:00:00.000Z', true)] },
          ],
          latest: '2026-09-01T10:00:00.000Z',
          cursor: null,
        },
      ],
    });
    setUnipileUrlForTests('https://proxy.test/orbit-connectors');
    const later = new Date(NOW.getTime() + 20 * 60_000);
    const done = await syncLinkedInActivity(user, { now: later, fetch: rest.doFetch, posts: false });
    expect(done).toMatchObject({ ok: true, complete: true });
    expect(rest.asked[0]!.body.cursor).toBe('k2');
    expect((await db.integrations.get('int_li'))!.syncState).toMatchObject({
      dmAfter: '2026-10-10T10:00:00.000Z',
    });
    expect(
      ((await db.integrations.get('int_li'))!.syncState as Record<string, unknown>).dmCursor,
    ).toBeUndefined();
  });

  it('records comments and reactions on posts as weak engagement, and a stranger who only reacts is not known', async () => {
    await person('p_fan', 'Ria Fan', 'ACoFan');
    const items = [
      {
        kind: 'comment_in',
        memberId: 'ACoMaya',
        at: '2026-10-11T10:00:00.000Z',
        id: 'k1',
        postId: 'p1',
        text: 'Congrats!',
      },
      {
        kind: 'comment_out',
        memberId: 'ACoMaya',
        at: '2026-10-12T10:00:00.000Z',
        id: 'k2',
        postId: 'p9',
        text: 'Nice',
      },
      ...Array.from({ length: 12 }, (_, i) => ({
        kind: 'reaction_in',
        memberId: 'ACoFan',
        at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
        id: `p${i}:ACoFan`,
        postId: `p${i}`,
      })),
    ];
    const proxy = fakeProxy({
      '/chats/history': [{ chats: [], latest: null, cursor: null }],
      '/posts/activity': [
        {
          ok: true,
          items: items.slice(0, 2),
          postsRead: [{ socialId: 'p1', seen: '1:0' }],
          ownDone: false,
          cursor: 'pc',
        },
        { ok: true, items: items.slice(2), postsRead: [], ownDone: true, cursor: null },
      ],
    });
    const r = await syncLinkedInActivity(user, { now: NOW, fetch: proxy.doFetch });
    expect(r).toMatchObject({ ok: true, engagement: 14, people: 2 });
    const posts = proxy.asked.filter((a) => a.path === '/posts/activity');
    expect(posts[0]!.body).toMatchObject({ seen: {} });
    expect(posts[1]!.body).toMatchObject({ cursor: 'pc' });
    const kinds = (await db.touchpoints.where('personId').equals('p_maya').toArray())
      .map((t) => t.kind)
      .sort();
    expect(kinds).toEqual(['linkedin_comment_in', 'linkedin_comment_out']);
    expect(await db.touchpoints.where('personId').equals('p_fan').count()).toBe(12);
    const fan = (await db.people.get('p_fan'))!;
    // reacting to every post is attention, not a relationship: no tie, not someone the student knows
    expect(fan.strength).toBe(0);
    expect(fan.tieBand).toBe('faint');
    expect(isKnownContact({ ...fan, sources: [] })).toBe(false);
    // comments both ways do say the student knows them
    const maya = (await db.people.get('p_maya'))!;
    expect(isKnownContact({ ...maya, sources: [], linkedinConnectedOn: undefined })).toBe(true);
    const st = (await db.integrations.get('int_li'))!.syncState as Record<string, unknown>;
    expect(st.postsSeen).toEqual({ p1: '1:0' });
    expect(st.commentsSince).toBe(NOW.toISOString());
    // read again: the same comments and reactions write nothing twice
    await syncLinkedInActivity(user, {
      now: NOW,
      fetch: fakeProxy({
        '/chats/history': [{ chats: [], latest: null, cursor: null }],
        '/posts/activity': [{ ok: true, items, postsRead: [], ownDone: true, cursor: null }],
      }).doFetch,
      posts: true,
    });
    expect(await db.touchpoints.where('userId').equals(user.id).count()).toBe(14);
  });

  it('does nothing for the sample student, and says when LinkedIn is not connected', async () => {
    setConnectorsMockForTests(true);
    expect(await syncLinkedInActivity(user, { now: NOW })).toMatchObject({ ok: true, messages: 0 });
    setConnectorsMockForTests(false);
    await db.integrations.update('int_li', { status: 'revoked' });
    expect(await syncLinkedInActivity(user, { now: NOW })).toMatchObject({
      ok: false,
      reason: 'not_connected',
    });
  });
});
