import type { User } from '@orbit/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../db/schema';
import { setConnectorsMockForTests, usesMockConnectors } from '../integrations/connectorsMock';
import { setUnipileUrlForTests } from '../integrations/unipile';
import { setVillageUrlForTests } from '../integrations/village';
import { loadDemo } from './demo';
import {
  connectLinkedInLive,
  disconnectLinkedInLive,
  linkedInLiveStatus,
  liveLinkedInAvailable,
  mutualsFor,
  syncLinkedInLive,
} from './linkedinLive';
import { villageAvailable, warmIntrosFor, warmthWord } from './warmIntros';

const NOW = new Date('2026-10-13T14:00:00Z');
let user: User;

beforeAll(async () => {
  user = await loadDemo({ reset: true, now: NOW });
}, 90_000);

afterEach(() => {
  vi.restoreAllMocks();
  setUnipileUrlForTests(undefined);
  setVillageUrlForTests(undefined);
  setConnectorsMockForTests(undefined);
});

const person = async (name: string) =>
  (await db.people.where('userId').equals(user.id).toArray()).find((p) => p.displayName === name)!;

describe('the sample student uses the mock connector', () => {
  it('offers live LinkedIn and warm intros with no proxy and no network', async () => {
    setUnipileUrlForTests(null);
    setVillageUrlForTests(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(usesMockConnectors(user.id)).toBe(true);
    expect(liveLinkedInAvailable(user)).toBe(true);
    expect(villageAvailable(user)).toBe(true);
    expect(usesMockConnectors('someone-else')).toBe(false);
    expect(villageAvailable({ id: 'someone-else' })).toBe(false);
    await warmIntrosFor(user, { company: 'Stripe' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('connects at once with no popup, adds the few new connections, and a re-sync adds nobody', async () => {
    const open = vi.spyOn(window, 'open');
    const before = await db.people.where('userId').equals(user.id).count();
    const r = await connectLinkedInLive(user);
    if (!r.ok) throw new Error(r.message);
    expect(open).not.toHaveBeenCalled();
    expect(r.added).toBe(4);
    expect(r.rows).toBeGreaterThan(20);
    expect(await db.people.where('userId').equals(user.id).count()).toBe(before + 4);
    const priya = await person('Priya Raman');
    expect(priya).toMatchObject({
      currentOrganizationRaw: 'Stripe',
      linkedinMemberId: expect.stringMatching(/^mock_/),
    });
    // the demo's own connections keep a member id too
    expect((await person('Maya Chen')).linkedinMemberId).toBeTruthy();
    const again = await syncLinkedInLive(user);
    expect(again).toMatchObject({ ok: true, added: 0 });
    expect(await linkedInLiveStatus(user)).toMatchObject({ connected: true, demo: true, status: 'active' });
    expect(await disconnectLinkedInLive(user)).toEqual({ ok: true, unlinkedAtUnipile: true });
    expect((await linkedInLiveStatus(user)).connected).toBe(false);
  }, 60_000);

  it('gives mutual connections from the people at their company and school', async () => {
    const maya = await person('Maya Chen');
    const r = await mutualsFor(user, maya);
    if (!r.ok) throw new Error(r.message);
    expect(r.source).toBe('demo');
    expect(r.mutuals.length).toBeGreaterThan(0);
    expect(r.mutuals.map((m) => m.name)).toContain('Daniel Okafor');
    expect(r.mutuals.map((m) => m.name)).not.toContain('Maya Chen');
    // each is an Orbit person the app can open
    expect(r.mutuals.every((m) => !!m.personId)).toBe(true);
  });

  it('gives warm intro paths to a Stripe person and to Stripe itself, with words for warmth', async () => {
    const daniel = await person('Daniel Okafor');
    const toPerson = await warmIntrosFor(user, { person: daniel });
    expect(toPerson.length).toBeGreaterThan(0);
    for (const w of toPerson) {
      expect(w.source).toBe('demo');
      expect(w.hops[0]).toBe('You');
      expect(w.hops[w.hops.length - 1]).toBe('Daniel Okafor');
      expect(w.introducer.personId).toBeTruthy();
      expect(w.targetPersonId).toBe(daniel.id);
      expect(w.warmthWord).toBe(warmthWord(w.warmth));
    }
    expect(toPerson.map((w) => w.warmth)).toEqual([...toPerson.map((w) => w.warmth)].sort((a, b) => b - a));
    const toCompany = await warmIntrosFor(user, { company: 'Stripe' });
    expect(toCompany.length).toBeGreaterThan(0);
    for (const w of toCompany) expect(w.hops[w.hops.length - 1]).toBe('Stripe');
  });

  it('turns warmth into words', () => {
    expect([0.9, 0.7, 0.5, 0.45, 0.3].map(warmthWord)).toEqual(['warm', 'warm', 'good', 'good', 'a stretch']);
  });
});
