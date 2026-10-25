import { describe, expect, it } from 'vitest';
import mutualsFixture from '../../../../../supabase/functions/_shared/__fixtures__/unipile-mutuals.json';
import villageCompany from '../../../../../supabase/functions/_shared/__fixtures__/village-company-paths.json';
import villagePeople from '../../../../../supabase/functions/_shared/__fixtures__/village-person-paths.json';
import villageToken from '../../../../../supabase/functions/_shared/__fixtures__/village-token.json';
import {
  type ExternalDeps,
  gatherExternalCandidates,
} from '../../../../../supabase/functions/_shared/paths/externalCandidates';
import { createUnipileResearch } from '../../../../../supabase/functions/_shared/providers/unipileResearch';
import { createVillage } from '../../../../../supabase/functions/_shared/providers/village';
import { type Call, DAY, fakeFetch, instant, json, manualClock, memoryBudget, memoryCache } from './fakes';

const UNIPILE = 'https://api9.unipile.com:13999';

/** Local people by LinkedIn slug, as entity resolution would find them. */
const PEOPLE: Record<string, string> = {
  'mia-chen': '0b1e0000-0000-4000-8000-000000000001',
  'omar-hale': '0b1e0000-0000-4000-8000-000000000002',
  'sam-ortiz': '0b1e0000-0000-4000-8000-000000000003',
  'ana-ruiz': '0b1e0000-0000-4000-8000-000000000004',
};
const DANA = '0b1e0000-0000-4000-8000-0000000000aa';

function setup() {
  const time = manualClock();
  const net = fakeFetch((c: Call) => {
    if (c.url.includes('/linkedin/search?')) return json(mutualsFixture);
    if (c.url.endsWith('/v2/auth/tokens')) return json(villageToken);
    if (c.url.endsWith('/v2/people/paths')) return json(villagePeople);
    if (c.url.endsWith('/v2/companies/paths')) return json(villageCompany);
    return undefined;
  });
  const money = memoryBudget();
  const cache = memoryCache(time.clock);
  const deps: ExternalDeps = {
    unipile: createUnipileResearch({ fetch: net.fetch, apiKey: 'uk', baseUrl: UNIPILE, sleep: instant }),
    village: createVillage({ fetch: net.fetch, secretKey: 'sk', clock: time.clock, sleep: instant }),
    cache,
    budget: money.budget,
    clock: time.clock,
    resolvePerson: async (p) => {
      const slug = p.linkedinUrl?.split('/in/')[1];
      return (slug && PEOPLE[slug]) ?? null;
    },
  };
  return { time, net, money, cache, deps };
}

const input = {
  userId: 'u1',
  unipileAccountId: 'acc1',
  villageUser: { externalUserId: 'u1', email: 'u1@orbit.test' },
  target: {
    kind: 'person' as const,
    personId: DANA,
    memberId: 'ACoAADanaLee',
    linkedinUrl: 'https://www.linkedin.com/in/dana-lee',
    name: 'Dana Lee',
  },
};

describe('external path candidates (§4.2 acceptance 4)', () => {
  it('turns mutuals and Village introducers into candidates and ties; a repeat within 30 days calls nothing', async () => {
    const s = setup();
    const out = await gatherExternalCandidates(s.deps, input);

    expect(out.candidates.map((c) => [c.source, c.name, c.warmth])).toEqual([
      ['linkedin_mutual', 'Mia Chen', 0.3],
      ['linkedin_mutual', 'Omar Hale', 0.3],
      ['village_path', 'Sam Ortiz', 0.82],
      ['village_path', 'Mia Chen', 0.55],
    ]);
    expect(out.candidates[0]).toMatchObject({
      memberId: 'ACoAAMiaChen',
      linkedinUrl: 'https://www.linkedin.com/in/mia-chen',
      personId: PEOPLE['mia-chen'],
      target: { personId: DANA, name: 'Dana Lee' },
      evidence: { source: 'unipile', via: 'connections_of', target_member_id: 'ACoAADanaLee' },
    });

    // tie rows exactly per §4.1: linkedin_mutual w 0.3 c 0.95; village_path w = warmth c 0.7; a < b
    expect(out.ties.map((t) => [t.kind, t.a_person_id, t.b_person_id, t.weight, t.confidence])).toEqual([
      ['linkedin_mutual', PEOPLE['mia-chen'], DANA, 0.3, 0.95],
      ['linkedin_mutual', PEOPLE['omar-hale'], DANA, 0.3, 0.95],
      ['village_path', PEOPLE['sam-ortiz'], DANA, 0.82, 0.7],
      ['village_path', PEOPLE['mia-chen'], DANA, 0.55, 0.7],
    ]);
    for (const t of out.ties) {
      expect(t.a_person_id < t.b_person_id).toBe(true);
      expect(t.user_id).toBe('u1');
      expect(t.last_seen_at).toBe('2026-10-14T12:00:00.000Z');
    }
    expect(out.ties[2]!.evidence).toMatchObject({ source: 'village', degree: 2, score_label: 'Strong' });

    // the upstream requests, and Village's credits in the ledger
    const mutualCall = s.net.calls.find((c) => c.url.includes('/linkedin/search?'))!;
    expect(mutualCall.body).toEqual({
      api: 'classic',
      category: 'people',
      network_distance: [1],
      connections_of: 'ACoAADanaLee',
    });
    expect(s.net.calls.find((c) => c.url.endsWith('/v2/people/paths'))!.body).toEqual({
      linkedin_url: 'https://www.linkedin.com/in/dana-lee',
    });
    expect(s.money.ledger).toEqual([
      { userId: 'u1', provider: 'village', operation: 'people/paths', units: 5, costUsd: 0.1 },
    ]);
    expect(out.fromCache).toEqual({ mutuals: false, village: false });

    // a second request 29 days later: same answer, no upstream call (the Village token would have expired too)
    const n = s.net.calls.length;
    s.time.advance(29 * DAY);
    const again = await gatherExternalCandidates(s.deps, input);
    expect(s.net.calls.length).toBe(n);
    expect(again.fromCache).toEqual({ mutuals: true, village: true });
    expect(again.candidates.map((c) => c.name)).toEqual(out.candidates.map((c) => c.name));
    expect(again.ties.map((t) => t.kind)).toEqual(out.ties.map((t) => t.kind));

    // after 30 days the mutuals are fetched again
    s.time.advance(2 * DAY);
    await gatherExternalCandidates(s.deps, input);
    expect(s.net.calls.filter((c) => c.url.includes('/linkedin/search?'))).toHaveLength(2);
  });

  it('asks Village company paths by domain and resolves both introducer and target', async () => {
    const s = setup();
    const out = await gatherExternalCandidates(s.deps, {
      ...input,
      target: { kind: 'company', domain: 'www.Stripe.com', name: 'Stripe' },
    });
    expect(s.net.calls.find((c) => c.url.endsWith('/v2/companies/paths'))!.body).toEqual({
      domain: 'stripe.com',
      limit: 25,
    });
    expect(s.net.calls.some((c) => c.url.includes('/linkedin/search'))).toBe(false);
    expect(out.candidates).toEqual([
      expect.objectContaining({
        name: 'Sam Ortiz',
        source: 'village_path',
        warmth: 0.64,
        personId: PEOPLE['sam-ortiz'],
        target: expect.objectContaining({ name: 'Ana Ruiz', personId: PEOPLE['ana-ruiz'] }),
      }),
    ]);
    expect(out.ties).toEqual([
      expect.objectContaining({
        kind: 'village_path',
        a_person_id: PEOPLE['sam-ortiz'],
        b_person_id: PEOPLE['ana-ruiz'],
        weight: 0.64,
        confidence: 0.7,
      }),
    ]);
  });

  it('says why a source was skipped, lists unconfigured ones, and writes no tie for unresolved people', async () => {
    const s = setup();
    const partial = await gatherExternalCandidates(
      { ...s.deps, resolvePerson: undefined },
      { userId: 'u1', target: { kind: 'person', name: 'Dana Lee', company: 'Acme' } },
    );
    expect(partial.skipped).toEqual(['mutuals: LinkedIn not connected', 'village: no Village user']);
    expect(s.net.calls).toEqual([]);

    const noKeys = await gatherExternalCandidates(
      {
        ...s.deps,
        unipile: createUnipileResearch({ fetch: s.net.fetch }),
        village: createVillage({ fetch: s.net.fetch }),
      },
      input,
    );
    expect(noKeys.unconfigured).toEqual(['unipile', 'village']);

    const unresolved = await gatherExternalCandidates({ ...s.deps, resolvePerson: async () => null }, input);
    expect(unresolved.candidates.length).toBe(4);
    expect(unresolved.ties).toEqual([]);

    const noUrl = await gatherExternalCandidates(s.deps, {
      ...input,
      target: { kind: 'person', personId: DANA, name: 'Dana Lee', memberId: 'ACoAADanaLee' },
    });
    expect(noUrl.skipped).toContain('village: needs the LinkedIn URL');
  });

  it('skips Village over the credit cap', async () => {
    const s = setup();
    const capped = memoryBudget({ village: true });
    const out = await gatherExternalCandidates({ ...s.deps, budget: capped.budget }, input);
    expect(out.skipped).toContain('village: budget_exceeded');
    expect(s.net.calls.some((c) => c.url.includes('village'))).toBe(false);
    expect(capped.checks).toEqual([{ provider: 'village', estimate: 5 }]);
  });
});
