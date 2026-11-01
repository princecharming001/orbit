import type { User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setOrbitApiBaseForTests } from '../integrations/orbitApi';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import { ANA_USER_ID, type FakeOrbitApi, withFriend } from '../test/fakeOrbitApi';
import { createLocalUser } from './account';
import {
  acceptFriend,
  askFriendForIntro,
  endFriendship,
  FRIENDS_EMPTY,
  FRIENDS_NEEDS_ACCOUNT,
  friendRouteOf,
  friendRoutes,
  friendsAvailable,
  inviteFriend,
  listAsks,
  listFriends,
  markPrivate,
  previewShares,
  respondToAsk,
  setShareMode,
  throughFriendsLine,
} from './friends';
import { clearPathCacheForTests } from './paths';
import { flushQueue } from './serverSync';

const DASH_OR_BANG = /[—–!]/;

describe('friends in local mode', () => {
  let user: User;
  beforeEach(async () => {
    await wipeDatabase();
    setOrbitApiBaseForTests(null);
    user = await createLocalUser({ fullName: 'Alex Rivera', firstName: 'Alex' });
  });
  afterEach(async () => {
    // nothing may still be on its way to Dexie when the next test wipes it
    await flushQueue().catch(() => undefined);
    setOrbitApiBaseForTests(undefined);
  });

  it('is an account feature: every call says so, and the words carry no dash or exclamation mark', async () => {
    expect(friendsAvailable(user)).toBe(false);
    const r = await listFriends(user);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('needs_account');
      expect(r.message).toMatch(/needs an Orbit account/);
    }
    expect((await inviteFriend(user, 'noah@cornell.edu')).ok).toBe(false);
    expect(await friendRoutes(user, { company: 'Stripe' })).toEqual([]);
    expect(FRIENDS_EMPTY).toMatch(/^Friends pool their networks\./);
    for (const s of [FRIENDS_EMPTY, FRIENDS_NEEDS_ACCOUNT]) expect(s).not.toMatch(DASH_OR_BANG);
  });

  it('marking a person private is kept locally and queued for the server', async () => {
    await db.people.put({
      id: 'p1',
      userId: user.id,
      displayName: 'Lena Novak',
      firstName: 'Lena',
      lastName: 'Novak',
      nameNormalized: 'lena novak',
      emails: [],
      relationshipType: 'unknown',
      strength: 0.5,
      sources: ['manual'],
      isHuman: true,
      tags: [],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    } as never);
    expect(await markPrivate('p1', true)).toBe(true);
    expect((await db.people.get('p1'))?.private).toBe(true);
    expect(await markPrivate('p1', false)).toBe(true);
    expect((await db.people.get('p1'))?.private).toBeUndefined();
    expect(await markPrivate('nobody', true)).toBe(false);
  });
});

describe('friends against the fake orbit-api', () => {
  let api: FakeOrbitApi;
  let user: User;
  beforeEach(async () => {
    await wipeDatabase();
    clearPathCacheForTests();
    ({ api, user } = await signInToFakeApi());
    await db.people.bulkPut([
      {
        id: 'p_maya_chen',
        userId: user.id,
        displayName: 'Maya Chen',
        firstName: 'Maya',
        lastName: 'Chen',
        nameNormalized: 'maya chen',
        currentTitle: 'Software Engineer',
        currentOrganizationRaw: 'Stripe',
        emails: [],
        relationshipType: 'unknown',
        strength: 0.4,
        sources: ['manual'],
        isHuman: true,
        tags: [],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        id: 'p_lena_novak',
        userId: user.id,
        displayName: 'Lena Novak',
        firstName: 'Lena',
        lastName: 'Novak',
        nameNormalized: 'lena novak',
        currentTitle: 'Engineering Manager',
        currentOrganizationRaw: 'Ramp',
        emails: [],
        relationshipType: 'unknown',
        strength: 0.6,
        sources: ['manual'],
        isHuman: true,
        tags: [],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    ] as never[]);
    withFriend(
      api,
      { id: user.id, firstName: 'Maya' },
      (await db.people.where('userId').equals(user.id).toArray()).map((p) => ({
        id: p.id,
        displayName: p.displayName,
        currentTitle: p.currentTitle,
        currentOrganizationRaw: p.currentOrganizationRaw,
      })),
    );
  });
  afterEach(async () => {
    // the people written above in account mode queued outbox writes: let them land before the next test wipes Dexie
    await flushQueue().catch(() => undefined);
    await leaveFakeApi();
  });

  it('lists Ana with her counts and keeps the list in Dexie for the tab', async () => {
    const r = await listFriends(user);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.friends).toHaveLength(1);
    const ana = r.value.friends[0]!;
    expect(ana.name).toBe('Ana Okafor');
    expect(ana.shares).toBe(120);
    expect(ana.atTargets).toBe(6);
    expect(ana.knowsAt.find((k) => k.company === 'Stripe')?.count).toBe(2);
    const rows = await db.friends.where('ownerId').equals(user.id).toArray();
    expect(rows.map((f) => f.userId)).toEqual([ANA_USER_ID]);
  });

  it('invite, accept and end go through the server; what you share is kept in the settings row too', async () => {
    const inv = await inviteFriend(user, 'noah.patel@cornell.edu');
    expect(inv.ok).toBe(true);
    if (inv.ok) {
      expect(inv.value.link).toMatch(/\/friends\/join\//);
      expect(api.state.friendInvites).toHaveLength(1);
    }
    expect((await inviteFriend(user, 'not an address')).ok).toBe(false);
    // a request waiting on the student, accepted sharing everyone
    api.state.friendInvites.push({
      id: 'inv_noah',
      direction: 'in',
      email: null,
      name: 'Noah Patel',
      status: 'pending',
      createdAt: '2026-10-05T12:00:00.000Z',
    });
    const acc = await acceptFriend(user, { friendshipId: 'inv_noah' }, 'all');
    expect(acc.ok).toBe(true);
    if (acc.ok) expect(acc.value.name).toBe('Noah Patel');
    expect(await db.friends.where('ownerId').equals(user.id).count()).toBe(2);
    const off = await setShareMode(user, 'none');
    expect(off.ok).toBe(true);
    expect(api.state.friendShareMode).toBe('none');
    expect((await db.settings.get(user.id))?.friendShareMode).toBe('none');
    const pv = await previewShares(user);
    expect(pv.ok && pv.value.total).toBe(0);
    const only = await setShareMode(user, 'companies', { companyDomains: ['Stripe.com', 'ramp.com'] });
    expect(only.ok).toBe(true);
    expect(api.state.friendCompanyDomains).toEqual(['stripe.com', 'ramp.com']);
    const ended = await endFriendship(user, 'fr_ana');
    expect(ended.ok).toBe(true);
    expect(api.state.friends.map((f) => f.name)).toEqual(['Noah Patel']);
    expect(await db.friends.get('fr_ana')).toBeUndefined();
  });

  it('the asks: one to Ana for Dan goes to Ana and never to Dan; her ask of me forwards as a draft I approve', async () => {
    const before = await listAsks(user);
    expect(before.ok && before.value.received.map((a) => a.targetName)).toEqual(['Lena Novak']);
    const asked = await askFriendForIntro(
      user,
      ANA_USER_ID,
      'ana_p_1',
      'Junior at Cornell on payments infra, would love 15 minutes on how the team decides what to automate.',
    );
    expect(asked.ok).toBe(true);
    if (asked.ok) {
      expect(asked.value.targetName).toBe('Dan Lee');
      expect(asked.value.friendUserId).toBe(ANA_USER_ID);
      expect(asked.value.status).toBe('asked');
    }
    // nothing addressed to Dan exists anywhere
    expect([...api.state.drafts.values()].some((d) => /Dan/.test(d.body))).toBe(false);
    expect((await askFriendForIntro(user, ANA_USER_ID, 'ana_p_1', '   ')).ok).toBe(false);
    // Ana's ask of me: forward makes the draft with Ana in cc, approved like any draft
    const fwd = await respondToAsk(user, 'ask_ana_lena', 'forward');
    expect(fwd.ok).toBe(true);
    if (fwd.ok) {
      expect(fwd.value.ask.status).toBe('forwarded');
      expect(fwd.value.draft?.body).toContain("Cc'ing Ana");
      expect(fwd.value.draft?.body).toContain('Hi Lena,');
    }
    const after = await listAsks(user);
    expect(after.ok && after.value.asked.map((a) => a.status)).toEqual(['asked']);
    expect(after.ok && after.value.received[0]?.status).toBe('forwarded');
    expect(await db.friendAsks.where('ownerId').equals(user.id).count()).toBe(2);
    // answered once
    const again = await respondToAsk(user, 'ask_ana_lena', 'decline');
    expect(again.ok).toBe(false);
  });

  it('routes through friends come from the server paths, marked via, and read as the friend knowing them', async () => {
    const stripe = await friendRoutes(user, { company: 'Stripe' });
    expect(stripe.map((r) => r.target.name).sort()).toEqual(['Dan Lee', 'Maya Chen']);
    const dan = stripe.find((r) => r.target.name === 'Dan Lee')!;
    expect(dan.friend).toEqual({ userId: ANA_USER_ID, name: 'Ana Okafor', first: 'Ana' });
    expect(dan.closeness).toBe(3);
    expect(dan.phrase).toBe('is close to Dan');
    expect(dan.target.sharedPersonId).toBe('ana_p_1');
    expect(dan.p).toBeGreaterThan(0.7);
    // Maya Chen is the student's own person too: the route joins to their row
    const maya = stripe.find((r) => r.target.name === 'Maya Chen')!;
    expect(maya.target.personId).toBe('p_maya_chen');
    expect(throughFriendsLine(stripe)).toBe('Through friends: 2 people');
    expect(await friendRoutes(user, { company: 'Linear' })).toEqual([]);
    const toMaya = await friendRoutes(user, { personId: 'p_maya_chen' });
    expect(toMaya).toHaveLength(1);
    expect(toMaya[0]!.phrase).toBe('knows Maya well');
    // a path with no friend hop is not a friend route
    expect(
      friendRouteOf({
        id: 'x',
        nodes: ['user', 'p1', 'p2'],
        hops: [],
        p: 0.3,
        band: 'medium',
        firstHopId: 'p1',
        otherWays: 0,
        reasonText: '',
        names: {},
      }),
    ).toBeUndefined();
  });
});
