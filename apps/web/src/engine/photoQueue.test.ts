import type { Person, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setConnectorModeForTests } from '../integrations/connectorOutcome';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { setUnipileUrlForTests } from '../integrations/unipile';
import { readBudget } from './enrichment/store';
import {
  PHOTO_RETRY_MS,
  PHOTOS_PER_DAY,
  PHOTOS_PER_MINUTE,
  photoOrder,
  refreshOnePhoto,
  resetPhotoQueueForTests,
  wantsPhoto,
} from './photoQueue';
import { photoBroken, photoWanted, resetPhotoSignalsForTests } from './photoSignals';

const BASE = 'https://proxy.test/functions/v1/orbit-connectors';
const NOW = new Date('2026-10-22T15:00:00Z');
const user: Pick<User, 'id'> = { id: 'u1' };

/** a LinkedIn image link that expires at `e` (seconds since 1970) */
const licdn = (name: string, e = 1_900_000_000) =>
  `https://media.licdn.com/dms/image/v2/${name}?e=${e}&v=beta&t=x`;
const EXPIRED = licdn('old', 1_700_000_000);

function person(over: Partial<Person> & Pick<Person, 'id' | 'firstName' | 'lastName'>): Person {
  return {
    userId: user.id,
    displayName: `${over.firstName} ${over.lastName}`,
    nameNormalized: `${over.firstName} ${over.lastName}`.toLowerCase(),
    emails: [],
    relationshipType: 'unknown',
    strength: 0.3,
    interactionCount: 1,
    sources: ['manual'],
    isHuman: true,
    tags: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

let calls: { identifier: string }[];
let answers: Record<string, unknown>;

beforeEach(async () => {
  await wipeDatabase();
  await db.integrations.put({
    id: 'int_li',
    userId: user.id,
    provider: 'linkedin_live',
    externalAccountId: 'acc_1',
    accessToken: 'tok',
    status: 'active',
    scopes: [],
    syncState: {},
    connectedAt: '2026-01-01T00:00:00.000Z',
  });
  setUnipileUrlForTests(BASE);
  setConnectorsMockForTests(false);
  setConnectorModeForTests('live');
  resetPhotoQueueForTests();
  resetPhotoSignalsForTests();
  calls = [];
  answers = {};
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(url).toBe(`${BASE}/photo`);
    const body = JSON.parse(init.body as string) as { identifier: string; token?: string };
    expect(body.token).toBe('tok');
    calls.push({ identifier: body.identifier });
    const a = answers[body.identifier] ?? { ok: false, reason: 'not_found', message: 'no' };
    return new Response(JSON.stringify(a), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setUnipileUrlForTests(undefined);
  setConnectorsMockForTests(undefined);
  setConnectorModeForTests(undefined);
});

const at = (ms: number) => new Date(NOW.getTime() + ms);
const GAP = 60_000 / PHOTOS_PER_MINUTE;

describe('who needs a photo fetched', () => {
  it('anyone with a LinkedIn profile and no working photo; never a photo from elsewhere', () => {
    const base = { id: 'p', isHuman: true, linkedinMemberId: 'm' } as const;
    expect(wantsPhoto({ ...base })).toBe(true);
    expect(wantsPhoto({ ...base, photoUrl: 'https://gravatar.com/avatar/abc?s=200&d=404' })).toBe(true);
    expect(wantsPhoto({ ...base, photoUrl: EXPIRED, linkedinMemberId: undefined, linkedinSlug: 'sam' })).toBe(
      true,
    );
    expect(wantsPhoto({ ...base, photoUrl: licdn('fresh') }, NOW)).toBe(false);
    expect(wantsPhoto({ ...base, photoUrl: 'data:image/png;base64,AAAA' })).toBe(false);
    expect(wantsPhoto({ ...base, photoUrl: 'https://example.com/me.jpg' })).toBe(false);
    // no LinkedIn profile at all: nothing to ask about
    expect(wantsPhoto({ id: 'q', isHuman: true })).toBe(false);
    expect(wantsPhoto({ ...base, hiddenAt: '2026-01-01' })).toBe(false);
    // a link that would not load is fetched again, once
    photoBroken('p', licdn('fresh'));
    expect(wantsPhoto({ ...base, photoUrl: licdn('fresh') }, NOW)).toBe(true);
  });

  it('people on screen first (the latest to appear first), then the newest', () => {
    const people = [
      { id: 'a', createdAt: '2026-01-01' },
      { id: 'b', createdAt: '2026-03-01' },
      { id: 'c', createdAt: '2026-02-01' },
      { id: 'd', createdAt: '2026-04-01' },
    ];
    const onScreen = new Map([
      ['a', 1],
      ['c', 2],
    ]);
    expect(photoOrder(people, onScreen).map((p) => p.id)).toEqual(['c', 'a', 'd', 'b']);
  });
});

describe('the photo queue', () => {
  it('fetches one photo a tick, people on screen first and the newest next, and never the same person twice', async () => {
    await db.people.bulkPut([
      person({
        id: 'p_old',
        firstName: 'Old',
        lastName: 'Hand',
        linkedinSlug: 'old-hand',
        createdAt: '2026-01-01',
      }),
      person({
        id: 'p_new',
        firstName: 'New',
        lastName: 'Face',
        linkedinMemberId: 'm_new',
        createdAt: '2026-10-20',
      }),
      person({
        id: 'p_seen',
        firstName: 'On',
        lastName: 'Screen',
        linkedinMemberId: 'm_seen',
        createdAt: '2026-05-01',
      }),
      // has a fresh photo: not asked about
      person({
        id: 'p_ok',
        firstName: 'All',
        lastName: 'Good',
        linkedinMemberId: 'm_ok',
        photoUrl: licdn('ok'),
      }),
    ]);
    photoWanted('p_seen');
    answers.m_seen = { ok: true, photo: { pictureUrl: licdn('seen') } };
    answers.m_new = { ok: true, photo: { pictureUrl: licdn('new'), publicIdentifier: 'new-face' } };
    answers['old-hand'] = { ok: true, photo: { providerId: 'ACo_old' } };
    expect(await refreshOnePhoto(user, { now: at(0) })).toEqual({ step: 'asked', personId: 'p_seen' });
    expect(await refreshOnePhoto(user, { now: at(GAP) })).toEqual({ step: 'asked', personId: 'p_new' });
    expect(await refreshOnePhoto(user, { now: at(2 * GAP) })).toEqual({ step: 'asked', personId: 'p_old' });
    expect(calls.map((c) => c.identifier)).toEqual(['m_seen', 'm_new', 'old-hand']);
    expect((await db.people.get('p_seen'))!.photoUrl).toBe(licdn('seen'));
    const neu = (await db.people.get('p_new'))!;
    expect(neu.photoUrl).toBe(licdn('new'));
    expect(neu.linkedinSlug).toBe('new-face');
    expect(neu.linkedinUrl).toBe('https://www.linkedin.com/in/new-face');
    // no photo on LinkedIn: the initials stay, and the member id learnt is kept for later
    const old = (await db.people.get('p_old'))!;
    expect(old.photoUrl).toBeUndefined();
    expect(old.linkedinMemberId).toBe('ACo_old');
    // everyone due was asked once: nothing more today, and not again for a week
    expect(await refreshOnePhoto(user, { now: at(3 * GAP) })).toEqual({ step: 'idle' });
    expect(await refreshOnePhoto(user, { now: at(PHOTO_RETRY_MS - 1) })).toEqual({ step: 'idle' });
    expect(calls).toHaveLength(3);
  });

  it('spaces calls out to a few a minute and stops at the day’s allowance', async () => {
    await db.people.bulkPut(
      Array.from({ length: PHOTOS_PER_DAY + 2 }, (_, i) =>
        person({ id: `p${i}`, firstName: 'P', lastName: `N${i}`, linkedinMemberId: `m${i}` }),
      ),
    );
    expect((await refreshOnePhoto(user, { now: at(0) })).step).toBe('asked');
    // too soon: nothing goes out
    expect(await refreshOnePhoto(user, { now: at(GAP - 1) })).toEqual({ step: 'wait' });
    expect(calls).toHaveLength(1);
    expect((await refreshOnePhoto(user, { now: at(GAP) })).step).toBe('asked');
    // a minute holds at most PHOTOS_PER_MINUTE calls
    let n = 2;
    for (let t = GAP + 1; t < 60_000; t += 1000)
      if ((await refreshOnePhoto(user, { now: at(t) })).step === 'asked') n++;
    expect(n).toBe(PHOTOS_PER_MINUTE);
    // the day's allowance, at the steady pace
    const later = (k: number) => at(60_000 + k * GAP);
    for (let k = 1; n < PHOTOS_PER_DAY; k++, n++)
      expect((await refreshOnePhoto(user, { now: later(k) })).step).toBe('asked');
    expect(await refreshOnePhoto(user, { now: later(PHOTOS_PER_DAY) })).toEqual({ step: 'paused' });
    expect(calls).toHaveLength(PHOTOS_PER_DAY);
    // a new day starts afresh
    expect((await refreshOnePhoto(user, { now: at(86_400_000) })).step).toBe('asked');
  }, 30_000);

  it('fetches a fresh link for an expired LinkedIn photo, and clears a dead one LinkedIn no longer has', async () => {
    await db.people.bulkPut([
      person({
        id: 'p_exp',
        firstName: 'Ex',
        lastName: 'Pired',
        linkedinMemberId: 'm_exp',
        photoUrl: EXPIRED,
      }),
      person({
        id: 'p_gone',
        firstName: 'Go',
        lastName: 'Ne',
        linkedinMemberId: 'm_gone',
        photoUrl: EXPIRED,
      }),
      person({
        id: 'p_grav',
        firstName: 'Gr',
        lastName: 'Av',
        linkedinMemberId: 'm_grav',
        photoUrl: 'https://gravatar.com/avatar/abc?s=200&d=404',
      }),
    ]);
    answers.m_exp = { ok: true, photo: { pictureUrl: licdn('renewed') } };
    answers.m_gone = { ok: true, photo: {} };
    answers.m_grav = { ok: true, photo: { pictureUrl: licdn('li') } };
    for (let i = 0; i < 3; i++)
      expect((await refreshOnePhoto(user, { now: at(i * GAP) })).step).toBe('asked');
    expect((await db.people.get('p_exp'))!.photoUrl).toBe(licdn('renewed'));
    expect((await db.people.get('p_gone'))!.photoUrl).toBeUndefined();
    // LinkedIn's photo replaces a Gravatar
    expect((await db.people.get('p_grav'))!.photoUrl).toBe(licdn('li'));
  });

  it('a photo the screen could not load is fetched once more; the same link back does not loop', async () => {
    await db.people.put(
      person({
        id: 'p_b',
        firstName: 'Bro',
        lastName: 'Ken',
        linkedinMemberId: 'm_b',
        photoUrl: licdn('same'),
      }),
    );
    expect(await refreshOnePhoto(user, { now: at(0) })).toEqual({ step: 'idle' });
    photoBroken('p_b', licdn('same'));
    answers.m_b = { ok: true, photo: { pictureUrl: licdn('same') } };
    expect(await refreshOnePhoto(user, { now: at(GAP) })).toEqual({ step: 'asked', personId: 'p_b' });
    expect(await refreshOnePhoto(user, { now: at(2 * GAP) })).toEqual({ step: 'idle' });
    expect(calls).toHaveLength(1);
  });

  it('stops for the day when LinkedIn asks to slow down, with the pause enrichment keeps', async () => {
    await db.people.bulkPut([
      person({ id: 'p1', firstName: 'A', lastName: 'One', linkedinMemberId: 'm1' }),
      person({ id: 'p2', firstName: 'B', lastName: 'Two', linkedinMemberId: 'm2' }),
    ]);
    answers.m1 = { ok: false, reason: 'throttled', message: 'slow down' };
    answers.m2 = { ok: false, reason: 'throttled', message: 'slow down' };
    expect((await refreshOnePhoto(user, { now: at(0) })).step).toBe('paused');
    expect(await refreshOnePhoto(user, { now: at(GAP) })).toEqual({ step: 'paused' });
    expect(calls).toHaveLength(1);
    expect((await readBudget(user.id, at(GAP))).pausedUntil).toBe('2026-10-23T00:00:00.000Z');
  });

  it('does nothing without live LinkedIn, and uses the demo’s own pictures on the mock connector', async () => {
    await db.integrations.clear();
    await db.people.put(person({ id: 'p1', firstName: 'A', lastName: 'One', linkedinMemberId: 'm1' }));
    expect(await refreshOnePhoto(user, { now: at(0) })).toEqual({ step: 'off' });
    setConnectorsMockForTests(true);
    await db.integrations.put({
      id: 'int_li',
      userId: user.id,
      provider: 'linkedin_live',
      externalAccountId: 'demo-linkedin-account',
      status: 'active',
      scopes: [],
      syncState: {},
      connectedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await refreshOnePhoto(user, { now: at(0) })).toEqual({ step: 'asked', personId: 'p1' });
    expect(calls).toHaveLength(0);
  });
});
