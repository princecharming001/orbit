import type { Person } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { clearPrefs, writePrefs } from '../integrations/prefs';
import { setVillageUrlForTests } from '../integrations/village';
import { villageAvailable, villageOffered, warmIntrosFor } from './warmIntros';

const BASE = 'https://proxy.test/functions/v1/orbit-connectors';
const user = { id: 'u1' };

function person(id: string, name: string, over: Partial<Person> = {}): Person {
  const [first, ...rest] = name.split(' ');
  return {
    id,
    userId: user.id,
    displayName: name,
    firstName: first!,
    lastName: rest.join(' '),
    nameNormalized: name.toLowerCase(),
    emails: [],
    relationshipType: 'unknown',
    strength: 0.3,
    interactionCount: 0,
    sources: ['manual'],
    isHuman: true,
    tags: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

let calls: unknown[];
beforeEach(async () => {
  await wipeDatabase();
  await clearPrefs();
  setConnectorsMockForTests(false);
  setVillageUrlForTests(BASE);
  calls = [];
  await db.people.bulkPut([
    person('p_mia', 'Mia Chen', {
      linkedinUrl: 'https://www.linkedin.com/in/mia-chen',
      linkedinSlug: 'mia-chen',
    }),
    person('p_dana', 'Dana Lee', { currentOrganizationRaw: 'Stripe' }),
    person('p_sam', 'Sam Ortiz', { currentOrganizationRaw: 'Stripe' }),
  ]);
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string));
    return new Response(
      JSON.stringify({
        paths: [
          {
            introducer: { name: 'Mia C.', linkedin_url: 'https://www.linkedin.com/in/mia-chen/' },
            warmth: 0.82,
            hops: ['You', 'Mia C.', 'Sam Ortiz'],
            note: 'Worked together at Stripe',
          },
          { introducer: { name: 'Unknown Person' }, warmth: 0.3, hops: [] },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setConnectorsMockForTests(undefined);
  setVillageUrlForTests(undefined);
});

describe('warm intros from Village', () => {
  it('stay off until the student turns them on, so no name leaves the browser', async () => {
    expect(villageOffered(user)).toBe(true);
    expect(villageAvailable(user)).toBe(false);
    expect(await warmIntrosFor(user, { company: 'Stripe' })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('are not offered at all without Village in the build', () => {
    setVillageUrlForTests(null);
    writePrefs({ warmIntros: true });
    expect(villageOffered(user)).toBe(false);
    expect(villageAvailable(user)).toBe(false);
  });

  it('match the introducer and the person at the company to the people Orbit knows', async () => {
    writePrefs({ warmIntros: true });
    const r = await warmIntrosFor(user, { company: 'Stripe' });
    expect(calls[0]).toMatchObject({ company: 'Stripe' });
    expect(r[0]).toMatchObject({
      introducer: { name: 'Mia C.', personId: 'p_mia' },
      warmth: 0.82,
      warmthWord: 'warm',
      hops: ['You', 'Mia C.', 'Sam Ortiz'],
      targetPersonId: 'p_sam',
      source: 'village',
    });
    // an introducer Orbit does not know still shows, with a chain in words
    expect(r[1]).toMatchObject({
      introducer: { name: 'Unknown Person', personId: undefined },
      warmthWord: 'a stretch',
      hops: ['You', 'Unknown Person', 'Stripe'],
    });
  });

  it('for a person, asks by name, company and LinkedIn, and points every path at them', async () => {
    writePrefs({ warmIntros: true });
    const dana = (await db.people.get('p_dana'))!;
    const r = await warmIntrosFor(user, { person: dana });
    expect(calls[0]).toMatchObject({ name: 'Dana Lee', company: 'Stripe' });
    expect(r.every((w) => w.targetPersonId === 'p_dana')).toBe(true);
  });
});
