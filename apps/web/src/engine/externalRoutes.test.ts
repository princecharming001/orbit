/**
 * Warm paths to people outside the student's records (plan 17 §C): LinkedIn mutuals and Village introducers as route
 * candidates in the browser's route finding, with the proxies faked at the fetch level.
 */
import type { Person, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { writePrefs } from '../integrations/prefs';
import { setUnipileUrlForTests } from '../integrations/unipile';
import { checkVillage, setVillageUrlForTests, villageHealth } from '../integrations/village';
import { resetTargetMutualsForTests, targetMutuals } from './externalRoutes';
import { reachPerson, updateEdgesFor } from './graph';
import { addLinkedInFound, searchLinkedInLive } from './linkedinSearch';
import { resetWarmIntrosCache } from './warmIntros';

const LI = 'https://proxy.test/functions/v1/orbit-connectors';
const VILLAGE = 'https://village.test/functions/v1/orbit-connectors';
const NOW = new Date('2026-10-20T15:00:00Z');

const user: User = {
  id: 'u1',
  email: 'ravi.jain@umich.edu',
  fullName: 'Ravi Jain',
  firstName: 'Ravi',
  lastName: 'Jain',
  school: 'University of Michigan',
  majors: ['Computer Science'],
  timezone: 'America/Detroit',
  onboardingStep: 11,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const person = (id: string, name: string, extra: Partial<Person> = {}): Person => {
  const [firstName, ...rest] = name.split(' ');
  return {
    id,
    userId: user.id,
    displayName: name,
    firstName: firstName!,
    lastName: rest.join(' '),
    nameNormalized: name.toLowerCase(),
    emails: [],
    relationshipType: 'unknown',
    strength: 0,
    interactionCount: 0,
    sources: ['manual'],
    isHuman: true,
    tags: [],
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
    ...extra,
  };
};

/** Mia: a LinkedIn connection and nothing more. Ben: a real friend who works at Figma. */
const MIA = person('p_mia', 'Mia Chen', {
  linkedinConnectedOn: '2024-03-02',
  linkedinUrl: 'https://www.linkedin.com/in/mia-chen',
  linkedinSlug: 'mia-chen',
  linkedinMemberId: 'm_mia',
});
const BEN = person('p_ben', 'Ben Ortiz', {
  strength: 0.7,
  currentOrganizationRaw: 'Figma',
  currentTitle: 'Engineer',
  linkedinUrl: 'https://www.linkedin.com/in/ben-ortiz',
  linkedinSlug: 'ben-ortiz',
});

type Answer = { status?: number; body: unknown; headers?: Record<string, string> };
let routes: Record<string, Answer | ((body: Record<string, unknown>) => Answer)>;
let calls: { url: string; body: Record<string, unknown> }[];
const UNCONFIGURED: Answer = {
  status: 503,
  body: { error: 'not configured' },
  headers: { 'x-orbit-connector': 'unconfigured' },
};
const mutualsCalls = () => calls.filter((c) => c.url === `${LI}/mutuals`);
const searchCalls = () => calls.filter((c) => c.url === `${LI}/search`);

async function connectLinkedIn() {
  await db.integrations.put({
    id: 'li_live',
    userId: user.id,
    provider: 'linkedin_live',
    externalAccountId: 'acc_1',
    accessToken: 'tok_1',
    status: 'active',
    scopes: [],
    syncState: {},
    connectedAt: user.createdAt,
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await wipeDatabase();
  await db.users.put(user);
  await db.people.bulkPut([MIA, BEN]);
  setConnectorsMockForTests(false);
  setUnipileUrlForTests(LI);
  setVillageUrlForTests(null);
  resetTargetMutualsForTests();
  resetWarmIntrosCache();
  calls = [];
  routes = {};
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse((init.body as string) || '{}') as Record<string, unknown>;
    calls.push({ url, body });
    const path = url.replace(LI, '').replace(VILLAGE, '');
    const r = routes[path];
    const a = typeof r === 'function' ? r(body) : (r ?? { status: 404, body: {} });
    return new Response(JSON.stringify(a.body), {
      status: a.status ?? 200,
      headers: { 'content-type': 'application/json', ...(a.headers ?? {}) },
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setUnipileUrlForTests(undefined);
  setVillageUrlForTests(undefined);
  setConnectorsMockForTests(undefined);
  writePrefs({ warmIntros: undefined });
});

const names = async (ids: string[]) =>
  Promise.all(ids.map(async (id) => (await db.people.get(id))?.firstName ?? id));

describe('a second-degree person found on LinkedIn', () => {
  it('found by search with a member id: added with their edges, and routed through a mutual and a colleague', async () => {
    await connectLinkedIn();
    routes['/search'] = {
      body: {
        people: [
          {
            memberId: 'm_kenji',
            name: 'Kenji Watanabe',
            headline: 'Design Lead at Figma',
            profileUrl: 'https://www.linkedin.com/in/kenji-watanabe',
            distance: 2,
          },
        ],
      },
    };
    routes['/mutuals'] = {
      body: {
        verified: true,
        mutuals: [
          { name: 'Mia Chen', member_id: 'm_mia', url: 'https://www.linkedin.com/in/mia-chen' },
          // Ben has no member id in Orbit: matched by his profile name
          { name: 'Ben Ortiz', member_id: 'm_ben', url: 'https://www.linkedin.com/in/ben-ortiz' },
          { name: 'Stranger Person', member_id: 'm_x' },
        ],
      },
    };
    const found = await searchLinkedInLive(user, 'Kenji');
    if (!found.ok) throw new Error(found.message);
    const added = await addLinkedInFound(user, [found.people[0]!.id], NOW);
    if (!added.ok) throw new Error(added.message);
    const kenji = (await db.people.get(added.people[0]!.id))!;
    expect(kenji.linkedinMemberId).toBe('m_kenji');
    // the edges were worked out when he was added: Ben works with him
    const edges = await db.edges.where('userId').equals(user.id).toArray();
    expect(
      edges.some(
        (e) =>
          e.type === 'same_current_company' &&
          [e.personAId, e.personBId].sort().join() === [BEN.id, kenji.id].sort().join(),
      ),
    ).toBe(true);

    // a colleague alone is not a route (§4.1: company-only pairs are too unsure); LinkedIn's word makes both routes
    expect(await reachPerson(user.id, kenji.id, 3, { external: false })).toEqual([]);
    const paths = await reachPerson(user.id, kenji.id);
    expect(await names(paths.map((p) => p.hops[0]!.toId))).toEqual(['Ben', 'Mia']);
    expect(paths[0]!.reason).toMatch(/^Through Ben, a strong tie \(70\): Ben /);
    const viaMia = paths.find((p) => p.hops[0]!.toId === MIA.id)!;
    expect(viaMia.via).toBe('linkedin_mutual');
    expect(viaMia.hops.map((h) => h.text)).toEqual([
      "You're connected with Mia on LinkedIn (since Mar 2024)",
      'Mia is connected to Kenji on LinkedIn',
    ]);
    expect(viaMia.reason).toMatch(
      /^Through Mia, a faint tie \(12\): Mia is connected to Kenji on LinkedIn\./,
    );
    expect(mutualsCalls()[0]!.body).toEqual({
      accountId: 'acc_1',
      token: 'tok_1',
      targetMemberId: 'm_kenji',
    });
  });

  it('with only a LinkedIn profile name: finds the member id by name (never a namesake), keeps it, then the mutuals', async () => {
    await connectLinkedIn();
    const sara = person('p_sara', 'Sara Lee', {
      linkedinUrl: 'https://www.linkedin.com/in/sara-lee-42',
      linkedinSlug: 'sara-lee-42',
    });
    await db.people.put(sara);
    routes['/search'] = {
      body: {
        people: [
          { memberId: 'm_wrong', name: 'Sara Lee', profileUrl: 'https://www.linkedin.com/in/sara-lee' },
          { memberId: 'm_sara', name: 'Sara Lee', profileUrl: 'https://www.linkedin.com/in/sara-lee-42/' },
        ],
      },
    };
    routes['/mutuals'] = ({ targetMemberId }) => ({
      body: {
        verified: true,
        mutuals: targetMemberId === 'm_sara' ? [{ name: 'Mia Chen', member_id: 'm_mia' }] : [],
      },
    });
    const paths = await reachPerson(user.id, sara.id);
    expect(searchCalls()[0]!.body).toMatchObject({ keywords: 'Sara Lee', distance: [1, 2, 3] });
    expect((await db.people.get(sara.id))!.linkedinMemberId).toBe('m_sara');
    expect(paths.map((p) => p.hops.map((h) => h.toId))).toEqual([[MIA.id, sara.id]]);

    // the same day: LinkedIn is not asked again, for the id or for the mutuals
    resetTargetMutualsForTests();
    expect((await reachPerson(user.id, sara.id)).length).toBe(1);
    expect(searchCalls()).toHaveLength(1);
    expect(mutualsCalls()).toHaveLength(1);
    // the next day the mutuals are asked for again
    vi.setSystemTime(new Date(NOW.getTime() + 86_400_000));
    resetTargetMutualsForTests();
    await reachPerson(user.id, sara.id);
    expect(mutualsCalls()).toHaveLength(2);
  });

  it('with mutuals but no edges of their own: every mutual Orbit has is a route, a faint one kept as a weaker route', async () => {
    await connectLinkedIn();
    const ceo = person('p_ceo', 'Dana Park', {
      currentTitle: 'CEO',
      currentOrganizationRaw: 'Lumen',
      linkedinMemberId: 'm_dana',
    });
    await db.people.put(ceo);
    routes['/mutuals'] = {
      body: {
        verified: true,
        mutuals: [
          { name: 'Mia Chen', member_id: 'm_mia' },
          { name: 'Ben Ortiz', member_id: 'm_ben' },
        ],
      },
    };
    const paths = await reachPerson(user.id, ceo.id);
    expect(await names(paths.map((p) => p.hops[0]!.toId))).toEqual(['Ben', 'Mia']);
    const [ben, mia] = paths;
    expect(ben!.weak).toBeUndefined();
    // Mia is only a LinkedIn connection, and Dana is a CEO: under the bar, kept, and said to be weaker
    expect(mia!.weak).toBe(true);
    expect(mia!.band).toBe('long_shot');
    expect(mia!.reason).toContain('A weaker route, but a real connection.');
    // without the mutuals there is no way in at all
    expect(await reachPerson(user.id, ceo.id, 3, { external: false })).toEqual([]);
  });
});

describe('Village paths', () => {
  it('add Village introducers Orbit has as routes, with the hop said to be from Village', async () => {
    setVillageUrlForTests(VILLAGE);
    writePrefs({ warmIntros: true });
    const kenji = person('p_kenji', 'Kenji Watanabe', {
      linkedinUrl: 'https://www.linkedin.com/in/kenji-watanabe',
      linkedinSlug: 'kenji-watanabe',
      currentOrganizationRaw: 'Lumen',
    });
    await db.people.put(kenji);
    routes['/paths'] = {
      body: {
        paths: [
          {
            introducer: { name: 'Ben Ortiz', linkedin_url: 'https://www.linkedin.com/in/ben-ortiz' },
            warmth: 0.8,
            hops: ['You', 'Ben Ortiz', 'Kenji Watanabe'],
          },
          // someone Orbit does not have: shown on the Map, never a route node
          { introducer: { name: 'Somebody Else' }, warmth: 0.9, hops: ['You', 'Somebody Else', 'Kenji'] },
        ],
      },
    };
    const paths = await reachPerson(user.id, kenji.id);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.via).toBe('village_path');
    expect(paths[0]!.hops.map((h) => h.text)[1]).toBe('Ben knows Kenji (via Village)');
    expect(calls.filter((c) => c.url === `${VILLAGE}/paths`)[0]!.body).toMatchObject({
      linkedin_url: 'https://www.linkedin.com/in/kenji-watanabe',
    });
    expect(villageHealth()).toBe('ready');
  });

  it('when the server has no Village key: says so (health), and the routes still answer', async () => {
    setVillageUrlForTests(VILLAGE);
    writePrefs({ warmIntros: true });
    routes['/paths'] = UNCONFIGURED;
    const kenji = person('p_kenji', 'Kenji Watanabe', {
      linkedinUrl: 'https://www.linkedin.com/in/kenji-watanabe',
    });
    await db.people.put(kenji);
    // Ben and Kenji write to each other: Orbit's own route
    await db.edges.put({
      id: `${user.id}:ben-kenji`,
      userId: user.id,
      personAId: BEN.id,
      personBId: kenji.id,
      type: 'email_exchange',
      weight: 0.8,
      evidence: { lastSeenAt: '2026-10-01T00:00:00Z' },
    } as never);
    const paths = await reachPerson(user.id, kenji.id);
    expect(await names(paths.map((p) => p.hops[0]!.toId))).toEqual(['Ben']);
    expect(villageHealth()).toBe('unconfigured');
    // the Settings check: an empty request, no one looked up
    setVillageUrlForTests(VILLAGE);
    routes['/paths'] = { body: { paths: [] } };
    expect(await checkVillage()).toBe('ready');
    routes['/paths'] = UNCONFIGURED;
    expect(await checkVillage({ force: true })).toBe('unconfigured');
    expect(calls.filter((c) => c.url === `${VILLAGE}/paths`).at(-1)!.body).toEqual({});
  });
});

describe('LinkedIn not connected', () => {
  it('no mutuals and no LinkedIn calls; Orbit’s own routes stand alone', async () => {
    const kenji = person('p_kenji', 'Kenji Watanabe', { linkedinMemberId: 'm_kenji' });
    await db.people.put(kenji);
    expect(await targetMutuals(user, kenji)).toMatchObject({ ok: false, reason: 'not_connected' });
    expect(await reachPerson(user.id, kenji.id)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('a LinkedIn error is not kept: the next look asks again', async () => {
    await connectLinkedIn();
    const kenji = person('p_kenji', 'Kenji Watanabe', { linkedinMemberId: 'm_kenji' });
    await db.people.put(kenji);
    routes['/mutuals'] = { status: 500, body: {} };
    expect(await targetMutuals(user, kenji)).toMatchObject({ ok: false, reason: 'error' });
    routes['/mutuals'] = { body: { verified: true, mutuals: [{ name: 'Mia Chen', member_id: 'm_mia' }] } };
    const r = await targetMutuals(user, kenji);
    expect(r.ok && r.mutuals.map((m) => m.personId)).toEqual([MIA.id]);
  });
});

describe('updateEdgesFor', () => {
  it('rewrites only the edges touching the people named', async () => {
    const kenji = person('p_kenji', 'Kenji Watanabe', { currentOrganizationRaw: 'Figma' });
    await db.people.put(kenji);
    await db.edges.put({
      id: `${user.id}:keep`,
      userId: user.id,
      personAId: MIA.id,
      personBId: 'p_other',
      type: 'email_cothread',
      weight: 0.3,
      evidence: {},
    } as never);
    expect(await updateEdgesFor(user.id, [kenji.id])).toBeGreaterThan(0);
    const edges = await db.edges.where('userId').equals(user.id).toArray();
    expect(edges.map((e) => e.id)).toContain(`${user.id}:keep`);
    expect(
      edges.every((e) => e.id === `${user.id}:keep` || [e.personAId, e.personBId].includes(kenji.id)),
    ).toBe(true);
  });
});
