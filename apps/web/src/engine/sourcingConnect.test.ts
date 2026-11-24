/**
 * Connect on someone a people search found, from the browser's side: whether the button is offered at all
 * (`canConnectOnLinkedIn`), what the call brings back (`connectSourced`), and who has a request still waiting
 * (`requestsWaiting`). The server is the in-memory one (test/fakeOrbitApi): nothing here reaches LinkedIn.
 */
import type { Person, SourcedCandidate, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import type { FakeOrbitApi } from '../test/fakeOrbitApi';
import { refreshSyncStatus } from './serverSync';
import { addSourced, canConnectOnLinkedIn, connectSourced, requestsWaiting } from './sourcing';

let api: FakeOrbitApi;
let user: User;

const found = (over: Partial<SourcedCandidate> = {}): SourcedCandidate => ({
  id: 'rec_maya',
  name: 'Maya Chen',
  title: 'Partner',
  org: 'Seed Fund',
  linkedinUrl: 'https://www.linkedin.com/in/maya-chen',
  source: 'unipile',
  rank: 0.8,
  fit: 0.9,
  reach: 0.3,
  responsiveness: 0.5,
  reasons: [],
  degree: 2,
  ...over,
});

beforeEach(async () => {
  await wipeDatabase();
  const signedIn = await signInToFakeApi();
  api = signedIn.api;
  user = signedIn.user as unknown as User;
  api.state.sourced = [found()];
});
afterEach(async () => {
  await leaveFakeApi();
});

const linkedin = async (status: string) => {
  api.state.linkedin.status = status;
  await refreshSyncStatus();
};
const connects = () => api.calls.filter((c) => c.route === '/source/connect');

describe('whether Connect is offered', () => {
  it('only with an Orbit account whose own LinkedIn is connected and active', async () => {
    await linkedin('active');
    expect(await canConnectOnLinkedIn(user)).toBe(true);
    // a copy with no account, and the sample student, never
    expect(await canConnectOnLinkedIn({ id: 'local-user' })).toBe(false);
    expect(await canConnectOnLinkedIn({ id: 'demo' })).toBe(false);
  });

  it.each(['not_connected', 'parked', 'needs_reauth', 'connecting', 'error'])(
    'LinkedIn %s: Save instead',
    async (status) => {
      await linkedin(status);
      expect(await canConnectOnLinkedIn(user)).toBe(false);
    },
  );
});

describe('Connect', () => {
  it('sends one request, saves the person, and their chat stands at a sent request, never at "to contact"', async () => {
    await linkedin('active');
    const r = await connectSourced(user, 'rec_maya');
    expect(r).toMatchObject({ ok: true, sent: true, requested: true, person: { displayName: 'Maya Chen' } });
    if (!r.ok) throw new Error('expected a sent request');
    expect(connects().map((c) => c.body)).toEqual([{ recommendationId: 'rec_maya' }]);
    // nothing else was asked of the server on this click: no draft, no message
    expect(api.calls.some((c) => c.route.startsWith('/drafts/'))).toBe(false);
    // "Request sent, open" opens a page: the person is in the browser's own copy, and so is where the chat stands
    expect((await db.people.get(r.person.id))?.displayName).toBe('Maya Chen');
    const chat = await db.chats.get(r.person.chatId);
    expect(chat?.stage).toBe('outreach_sent');
    expect(chat?.outreachChannel).toBe('linkedin');
    expect(chat?.connectionRequestedAt).toBeTruthy();
    expect(await requestsWaiting([r.person.id])).toEqual(new Set([r.person.id]));
  });

  it('a second ask sends nothing: the same person, and the row still reads as requested', async () => {
    await linkedin('active');
    const first = await connectSourced(user, 'rec_maya');
    const again = await connectSourced(user, 'rec_maya');
    expect(again).toMatchObject({
      ok: true,
      sent: false,
      requested: true,
      code: 'already_requested',
      reason: 'You already sent them a connection request. Saved to People.',
    });
    expect(first.ok && again.ok && again.person.id === first.person.id).toBe(true);
    expect(api.state.linkedin.connects).toEqual(['rec_maya']);
  });

  it.each([
    ['weekly_limit', "LinkedIn's weekly limit on connection requests is reached. Saved to People instead."],
    ['profile_not_found', 'LinkedIn could not find their profile. Saved to People instead.'],
    [
      'linkedin_limit',
      'LinkedIn says you have reached its limit on connection requests. Saved to People instead.',
    ],
  ] as const)('refused (%s): saved, at "to contact", with the reason in words', async (code, reason) => {
    await linkedin('active');
    api.state.linkedin.connectError = code;
    const r = await connectSourced(user, 'rec_maya');
    expect(r).toMatchObject({ ok: true, sent: false, requested: false, code, reason });
    if (!r.ok) throw new Error('expected a saved person');
    expect((await db.people.get(r.person.id))?.displayName).toBe('Maya Chen');
    expect((await db.chats.get(r.person.chatId))?.stage).toBe('identified');
    expect(await requestsWaiting([r.person.id])).toEqual(new Set());
  });

  it('LinkedIn paused by the time of the click: saved, and the reason says so', async () => {
    await linkedin('parked');
    const r = await connectSourced(user, 'rec_maya');
    expect(r).toMatchObject({
      ok: true,
      sent: false,
      code: 'linkedin_not_active',
      reason: 'LinkedIn is paused because you were away. Saved to People instead.',
    });
  });

  it('a copy with no account is told to sign in, and nothing is called', async () => {
    const r = await connectSourced({ id: 'local-user' }, 'rec_maya');
    expect(r.ok).toBe(false);
    expect(connects()).toHaveLength(0);
  });
});

describe('Save', () => {
  it('saves and sends nothing: the chat waits at "to contact" and no request is waiting', async () => {
    await linkedin('active');
    const r = await addSourced(user, ['rec_maya']);
    if (!r.ok) throw new Error('expected a saved person');
    expect(connects()).toHaveLength(0);
    expect((await db.chats.get(r.people[0]!.chatId))?.stage).toBe('identified');
    expect(await requestsWaiting([r.people[0]!.id])).toEqual(new Set());
  });
});

describe('who has a request waiting', () => {
  it('someone asked and not yet a connection; never a connection, an archived chat or someone never asked', async () => {
    const at = '2026-11-20T12:00:00.000Z';
    const person = (id: string, over: Partial<Person> = {}) =>
      ({ id, userId: user.id, displayName: id, createdAt: at, updatedAt: at, ...over }) as Person;
    await db.people.bulkPut([
      person('p_waiting'),
      person('p_accepted', { linkedinConnectedOn: '2026-11-21' }),
      person('p_archived'),
      person('p_never'),
    ]);
    const chat = (id: string, personId: string, over: Record<string, unknown> = {}) => ({
      id,
      userId: user.id,
      personId,
      stage: 'outreach_sent' as const,
      stageEnteredAt: at,
      source: 'recommendation' as const,
      goalTags: [],
      bumpCount: 0,
      priority: 2 as const,
      createdAt: at,
      updatedAt: at,
      ...over,
    });
    await db.chats.bulkPut([
      chat('c1', 'p_waiting', { connectionRequestedAt: at }),
      chat('c2', 'p_accepted', { connectionRequestedAt: at }),
      chat('c3', 'p_archived', { connectionRequestedAt: at, archivedAt: at }),
      chat('c4', 'p_never'),
    ]);
    expect(await requestsWaiting(['p_waiting', 'p_accepted', 'p_archived', 'p_never', 'p_gone'])).toEqual(
      new Set(['p_waiting']),
    );
    expect(await requestsWaiting([])).toEqual(new Set());
  });
});
