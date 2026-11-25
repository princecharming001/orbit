import type { User } from '@orbit/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { createLocalUser } from './account';

// LinkedIn as the card's Find people button asks it: a recruiter there, someone on the team, and a result at another
// company that must not be picked
const lookups: string[] = [];
vi.mock('./linkedinSearch', async (orig) => {
  const real = await orig<typeof import('./linkedinSearch')>();
  const person = (memberId: string, name: string, headline: string) => ({
    id: `li:${memberId}`,
    memberId,
    name,
    headline,
  });
  return {
    ...real,
    linkedInLookupReady: async () => true,
    lookUpLinkedInPeople: async (_u: unknown, q: string) => {
      lookups.push(q);
      if (q.includes('recruiter'))
        return {
          ok: true,
          people: [person('ACoAAR1', 'Rae Lin', 'Technical Recruiter at Princeton SYNAPSE')],
        };
      if (q.includes('Michigan'))
        return { ok: true, people: [person('ACoAAX1', 'Max Ode', 'Engineer at Google')] };
      return { ok: true, people: [person('ACoAAT1', 'Tom Bay', 'Research Fellow, Princeton SYNAPSE')] };
    },
  };
});

const { findPlanPeopleOnLinkedIn, planFromInput } = await import('./targetPlan');

const NOW = new Date('2026-10-20T15:00:00Z');

describe('Find people at X: the plan card when nobody in the network is there', () => {
  let user: User;
  beforeEach(async () => {
    lookups.length = 0;
    await wipeDatabase();
    user = await createLocalUser({
      fullName: 'Ravi Jain',
      email: 'ravi@umich.edu',
      school: 'University of Michigan',
    });
  });

  it('adds the people LinkedIn finds there as steps to draft, and remembers that it looked', async () => {
    const r = await planFromInput(user, 'Princeton SYNAPSE', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.steps).toHaveLength(0);
    expect(r.plan.cold).toBe(true);

    const found = await findPlanPeopleOnLinkedIn(user, r.plan.id, { now: NOW });
    expect(found).toEqual({ ok: true, added: 2 });
    const plan = (await db.targetPlans.get(r.plan.id))!;
    expect(plan.linkedInSearchedAt).toBe(NOW.toISOString());
    expect(plan.steps.map((s) => [s.found?.name, s.role, s.roleText, s.draft, s.status])).toEqual([
      ['Rae Lin', 'recruiter', 'recruits at Princeton SYNAPSE', 'warm_up', 'proposed'],
      ['Tom Bay', 'team', 'works at Princeton SYNAPSE', 'warm_up', 'proposed'],
    ]);
    // the one at another company is not picked
    expect(plan.steps.some((s) => s.found?.name === 'Max Ode')).toBe(false);
    // the find can be added after a reload: the search result is kept with the step
    expect((plan.steps[0]!.found!.raw as { memberId: string }).memberId).toBe('ACoAAR1');
    expect(lookups).toEqual([
      'Princeton SYNAPSE recruiter',
      'Princeton SYNAPSE',
      'Princeton SYNAPSE University of Michigan',
    ]);
  });

  it('says it looked when LinkedIn has nobody there', async () => {
    const r = await planFromInput(user, 'Princeton SYNAPSE', NOW);
    if (!r.ok) throw new Error(r.message);
    await db.targetPlans.update(r.plan.id, { posting: { ...r.plan.posting, company: 'Nowhere Labs' } });
    const found = await findPlanPeopleOnLinkedIn(user, r.plan.id, { now: NOW });
    expect(found).toEqual({ ok: true, added: 0 });
    expect((await db.targetPlans.get(r.plan.id))!.linkedInSearchedAt).toBe(NOW.toISOString());
  });
});
