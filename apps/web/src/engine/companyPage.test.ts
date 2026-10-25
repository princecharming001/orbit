import type { Person } from '@orbit/core';
import { DIRECT_TIE_SCORE } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { createLocalUser } from './account';
import {
  buildReachGraph,
  companyPeople,
  reachCompany,
  reachGraphFrom,
  reachPersonIn,
  teamNameOf,
  teamOf,
} from './graph';
import { addTarget, addTargetCompany } from './targets';

const NOW = new Date('2026-10-20T15:00:00Z');

const person = (id: string, extra: Partial<Person> = {}): Person => ({
  id,
  userId: 'u',
  displayName: `${id} Lee`,
  firstName: id,
  lastName: 'Lee',
  nameNormalized: `${id} lee`,
  emails: [],
  relationshipType: 'unknown',
  strength: 0,
  interactionCount: 0,
  sources: ['manual'],
  isHuman: true,
  tags: [],
  createdAt: '',
  updatedAt: '',
  ...extra,
});

describe('teams from titles', () => {
  it('puts C-level in Leadership, recruiters in Recruiting, and the rest by function or Other', () => {
    expect(teamOf('Chief Technology Officer')).toBe('leadership');
    expect(teamOf('Technical Recruiter, Engineering')).toBe('recruiting');
    expect(teamOf('University Recruiting Lead')).toBe('recruiting');
    expect(teamOf('Software Engineer')).toBe('engineering');
    expect(teamOf('Product Manager, Payments')).toBe('product');
    expect(teamOf('Chief of Staff to the Head of Something')).toBe('leadership');
    expect(teamOf('Ambassador')).toBe('other');
    expect(teamOf(undefined)).toBe('other');
    expect(teamNameOf('Product Manager, Payments')).toBe('Payments');
    expect(teamNameOf('Software Engineer')).toBeUndefined();
  });
});

describe('the company list (plan 23 §4.2)', () => {
  // the student knows Dana (direct) and Kenji; Kenji worked with Priya, so Priya is warm; Sam is saved and cold
  const dana = person('Dana', {
    currentTitle: 'Software Engineer',
    currentOrganizationRaw: 'Stripe',
    strength: 0.68,
    isAlumni: true,
  });
  const kenji = person('Kenji', {
    currentTitle: 'Analyst',
    currentOrganizationRaw: 'Lazard',
    strength: 0.82,
  });
  const priya = person('Priya', { currentTitle: 'University Recruiter', currentOrganizationRaw: 'Stripe' });
  const sam = person('Sam', { currentTitle: 'Engineering Manager', currentOrganizationRaw: 'Stripe' });
  const ceo = person('Pat', { currentTitle: 'CEO', currentOrganizationRaw: 'Stripe' });
  const misc = person('Max', { currentTitle: 'Ambassador', currentOrganizationRaw: 'Stripe' });
  const edges = [
    {
      id: 'e1',
      userId: 'u',
      personAId: 'Kenji',
      personBId: 'Priya',
      type: 'co_tenure' as const,
      weight: 0.7,
      confidence: 0.9,
      kinds: ['co_tenure' as const],
      evidence: { text: 'worked together at Lazard' },
    },
  ];
  const people = [dana, kenji, priya, sam, ceo, misc];
  const { g } = reachGraphFrom(people, edges, NOW);
  const list = companyPeople(g, [dana, priya, sam, ceo, misc]);

  it('groups by team with Other last, and scores within a team', () => {
    const teams = list.map((c) => c.team);
    expect(teams.at(-1)).toBe('other');
    expect(list.find((c) => c.person.id === 'Pat')?.team).toBe('leadership');
    expect(list.find((c) => c.person.id === 'Priya')?.team).toBe('recruiting');
    // one block per team: a team never comes back after another started
    const seen: string[] = [];
    for (const t of teams) if (seen.at(-1) !== t) seen.push(t);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("someone the student knows gets the direct tie's score, as the Map's direct route", () => {
    const d = list.find((c) => c.person.id === 'Dana')!;
    expect(d.route.kind).toBe('direct');
    expect(d.action).toBe('write');
    const mapDirect = reachPersonIn(g, 'Dana', 3).find((p) => p.hops.length === 1)!;
    expect(Math.round(d.route.score * 100)).toBe(Math.round(mapDirect.score * 100));
    expect(Math.round(d.route.score * 100)).toBeGreaterThanOrEqual(DIRECT_TIE_SCORE);
  });

  it("someone reachable through a contact gets the Map's best route and an Ask", () => {
    const p = list.find((c) => c.person.id === 'Priya')!;
    expect(p.route.kind).toBe('warm');
    expect(p.action).toBe('ask');
    expect(p.route.via).toEqual({ id: 'Kenji', name: 'Kenji' });
    expect(p.route.score).toBeCloseTo(reachPersonIn(g, 'Priya', 1)[0]!.score, 6);
    expect(p.route.line).toMatch(/^via Kenji \(your tie · \d+\)$/);
  });

  it('a saved person with no route is Cold', () => {
    const s = list.find((c) => c.person.id === 'Sam')!;
    expect(s.route).toMatchObject({ kind: 'cold', score: 0 });
    expect(s.action).toBe('save');
    const withLinkedIn = companyPeople(g, [{ ...sam, linkedinSlug: 'sam-lee' }])[0]!;
    expect(withLinkedIn.action).toBe('warm_up');
  });

  it('never writes a dash', () => {
    for (const c of list) expect(c.route.line).not.toMatch(/[–—]/);
  });
});

describe('targets tie to their organization', () => {
  beforeEach(async () => {
    await wipeDatabase();
  });

  it('adding a target makes or finds the organization and keeps its id', async () => {
    const user = await createLocalUser({ fullName: 'Alex Rivera' });
    await db.organizations.add({ id: 'o_stripe', name: 'Stripe', nameNormalized: 'stripe', domains: [] });
    expect(await addTargetCompany(user.id, 'Stripe, Inc.')).toBe('added');
    const [t] = await db.targetCompanies.where('userId').equals(user.id).toArray();
    expect(t?.organizationId).toBe('o_stripe');
    // a company Orbit had never seen gets an organization of its own
    const r = await addTarget(user.id, 'Ramp', {
      role: 'Software Engineer Intern',
      postingUrl: 'https://x.test/1',
    });
    expect(r.status).toBe('added');
    const org = await db.organizations.get(r.target!.organizationId!);
    expect(org?.name).toBe('Ramp');
    expect(r.target).toMatchObject({ role: 'Software Engineer Intern', postingUrl: 'https://x.test/1' });
    // the same company again keeps one target and fills in what the posting adds
    const again = await addTarget(user.id, 'ramp', { team: 'Payments' });
    expect(again.status).toBe('duplicate');
    expect((await db.targetCompanies.get(r.target!.id))?.team).toBe('Payments');
  });

  it('reachCompany lists everyone there now with a route', async () => {
    const user = await createLocalUser({ fullName: 'Alex Rivera' });
    await db.people.bulkAdd([
      person('Dana', {
        userId: user.id,
        currentTitle: 'Software Engineer',
        currentOrganizationRaw: 'Stripe',
        strength: 0.6,
        linkedinConnectedOn: '2024-01-01',
      }),
      person('Sam', { userId: user.id, currentTitle: 'Recruiter', currentOrganizationRaw: 'Stripe' }),
    ]);
    const r = await reachCompany(user.id, 'Stripe', NOW);
    expect(r.people.map((c) => c.person.id).sort()).toEqual(['Dana', 'Sam']);
    const { g } = await buildReachGraph(user.id, NOW);
    expect(r.people.find((c) => c.person.id === 'Dana')?.route.score).toBeCloseTo(
      reachPersonIn(g, 'Dana', 3).find((p) => p.hops.length === 1)!.score,
      6,
    );
  });
});
