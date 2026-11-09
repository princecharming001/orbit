import { describe, expect, it } from 'vitest';
import apolloInvestors from '../../../../../supabase/functions/_shared/__fixtures__/apollo-search-investors.json';
import exaFunds from '../../../../../supabase/functions/_shared/__fixtures__/exa-search-company-funds.json';
import exaInvestors from '../../../../../supabase/functions/_shared/__fixtures__/exa-search-people-investors.json';
import unipilePeople from '../../../../../supabase/functions/_shared/__fixtures__/unipile-search-people.json';
import { createApollo } from '../../../../../supabase/functions/_shared/providers/apollo';
import { createExa } from '../../../../../supabase/functions/_shared/providers/exa';
import { createSemanticScholar } from '../../../../../supabase/functions/_shared/providers/semanticScholar';
import { createUnipileResearch } from '../../../../../supabase/functions/_shared/providers/unipileResearch';
import type { SearchEngine } from '../../../../../supabase/functions/_shared/providers/webSearch';
import type { ClaudePrompt } from '../../../../../supabase/functions/_shared/research/deps';
import { engineWeb } from '../../../../../supabase/functions/_shared/research/engineWeb';
import {
  gatherFrom,
  memorySharedCache,
  type WebSource,
} from '../../../../../supabase/functions/_shared/research/web';
import {
  type Candidate,
  keywordFit,
  mergeCandidates,
  type SourcingDeps,
  type SourcingGoal,
  sourcePeople,
} from '../../../../../supabase/functions/_shared/sourcing/search';
import { type Call, fakeClaude, fakeFetch, instant, json, manualClock, memoryBudget } from './fakes';

const UNIPILE = 'https://api9.unipile.com:13999';

const fundraising: SourcingGoal = {
  id: 'g-raise',
  kind: 'fundraising',
  title: 'Raise a $2M seed for a climate software company',
  criteria: ['invests at seed', 'climate software', 'leads or co-leads rounds'],
  sector: 'climate software',
  stage: 'seed',
};

function providers(
  fetch: typeof globalThis.fetch,
  keys: { exa?: boolean; apollo?: boolean; unipile?: boolean } = {},
) {
  const on = { exa: true, apollo: true, unipile: true, ...keys };
  return {
    exa: createExa({ fetch, apiKey: on.exa ? 'ek' : undefined, sleep: instant }),
    apollo: createApollo({ fetch, apiKey: on.apollo ? 'ak' : undefined, sleep: instant }),
    unipile: createUnipileResearch({
      fetch,
      apiKey: on.unipile ? 'uk' : undefined,
      baseUrl: UNIPILE,
      sleep: instant,
    }),
    semanticScholar: createSemanticScholar({ fetch, sleep: instant }),
  };
}

/** Fit by name from the prompt's candidate lines, as Haiku would answer. */
function fitAnswer(fits: Record<string, number>) {
  return (_t: unknown, p: ClaudePrompt) => {
    const lines = p.user.split('<candidates>')[1]!.split('</candidates>')[0]!.split('\n');
    return {
      scores: lines.map((l) => {
        const c = JSON.parse(l) as { id: string; name: string };
        return { id: c.id, fit: fits[c.name] ?? 0.1, reasons: [`${c.name} fits`, 'second', 'third'] };
      }),
    };
  };
}

describe('sourcing (§6.6)', () => {
  it('1. a fundraising query merges Exa and Apollo, dedupes the person in both, and ranks with reasons', async () => {
    const net = fakeFetch((c: Call) => {
      if (c.url.endsWith('api.exa.ai/search'))
        return json((c.body as { category?: string }).category === 'company' ? exaFunds : exaInvestors);
      if (c.url.includes('mixed_people/api_search')) return json(apolloInvestors);
      return undefined;
    });
    const money = memoryBudget();
    const llm = fakeClaude(
      fitAnswer({ 'Maya Patel': 0.9, 'Leo Grant': 0.7, 'Sam Ok***r': 0.6, 'Greenfield Ventures': 0.3 }),
    );
    const deps: SourcingDeps = {
      ...providers(net.fetch),
      claude: llm.claude,
      reachOf: (c) => (c.name === 'Maya Patel' ? 0.4 : null),
      responsiveness: () => 0.5,
      budget: money.budget,
      clock: manualClock().clock,
      newId: () => 'batch-1',
    };
    const out = await sourcePeople(deps, { userId: 'u1', goal: fundraising, user: { firstName: 'Ari' } });

    expect(out.unconfigured).toEqual([]);
    expect(out.errors).toEqual([]);
    expect(out.results.map((r) => r.candidate.name)).toEqual([
      'Maya Patel',
      'Leo Grant',
      'Sam Ok***r',
      'Greenfield Ventures',
    ]);
    const maya = out.results[0]!;
    expect(maya).toMatchObject({
      user_id: 'u1',
      goal_id: 'g-raise',
      person_id: null,
      source: 'exa+apollo',
      external_id: 'ap_maya',
      fit: 0.9,
      reach: 0.4,
      responsiveness: 0.5,
      rank: 0.645,
      reasons: ['Maya Patel fits', 'second'],
      status: 'new',
      batch_id: 'batch-1',
    });
    expect(maya.candidate).toMatchObject({
      linkedinUrl: 'https://www.linkedin.com/in/maya-patel-gv',
      org: 'Greenfield Ventures',
      title: 'Partner',
      sources: ['exa', 'apollo'],
      externalIds: { exa: 'https://www.linkedin.com/in/maya-patel-gv', apollo: 'ap_maya' },
    });
    expect(out.results.filter((r) => r.candidate.name.startsWith('Maya'))).toHaveLength(1);
    expect(out.results[3]!.candidate.entity).toBe('organization');
    for (let i = 1; i < out.results.length; i++)
      expect(out.results[i - 1]!.rank).toBeGreaterThanOrEqual(out.results[i]!.rank);

    // routing: Exa people + Exa company + Apollo with investor titles; fit scored in one Haiku batch
    const apollo = net.calls.find((c) => c.url.includes('api_search'))!;
    expect(decodeURIComponent(apollo.url)).toContain(
      'person_titles[]=Partner&person_titles[]=Principal&person_titles[]=General Partner&person_titles[]=Investor',
    );
    expect(
      net.calls
        .filter((c) => c.url.endsWith('/search'))
        .map((c) => (c.body as { category: string }).category)
        .sort(),
    ).toEqual(['company', 'people']);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.task).toBe('sourcing_fit');
    expect(llm.calls[0]!.prompt.system).toContain('Do not reward fame.');
    expect(money.ledger.filter((r) => r.provider === 'exa')).toHaveLength(2);
  });

  it('3. with no provider key configured returns no results, the unconfigured list, and no error', async () => {
    const net = fakeFetch();
    const deps: SourcingDeps = {
      ...providers(net.fetch, { exa: false, apollo: false, unipile: false }),
      reachOf: () => null,
      responsiveness: () => 0.5,
      clock: manualClock().clock,
    };
    expect(
      await sourcePeople(deps, { userId: 'u1', goal: fundraising, user: { firstName: 'Ari' } }),
    ).toMatchObject({
      results: [],
      unconfigured: ['apollo', 'exa'],
      relaxed: [],
      errors: [],
    });
    const recruiting = await sourcePeople(deps, {
      userId: 'u1',
      goal: {
        id: 'g2',
        kind: 'recruiting',
        title: 'PM internship',
        criteria: [],
        roles: ['Product Manager'],
      },
      user: { firstName: 'Ari' },
    });
    expect(recruiting.unconfigured).toEqual(['apollo', 'unipile']);
    expect(net.calls).toEqual([]);
  });

  it('recruiting searches LinkedIn classic with ids for company and school, distance 2–3, labels known people', async () => {
    const net = fakeFetch((c: Call) => {
      if (c.url.includes('/linkedin/search/parameters')) {
        const type = new URL(c.url).searchParams.get('type');
        return json({
          items: [{ object: 'LinkedinSearchParameter', id: type === 'COMPANY' ? 123 : 456, title: 'x' }],
        });
      }
      if (c.url.includes('/users/me')) return json({ object: 'AccountOwnerProfile', premium: false });
      if (c.url.includes('/linkedin/search?')) return json(unipilePeople);
      if (c.url.includes('api_search')) return json({ people: [] });
      return undefined;
    });
    const deps: SourcingDeps = {
      ...providers(net.fetch, { exa: false }),
      reachOf: () => null,
      responsiveness: () => 0.4,
      knownPerson: async (c) => (c.name === 'Ken Ito' ? { personId: 'p-ken', score: 72 } : null),
      inPipeline: async (c) => c.name === 'Mia Chen',
      clock: manualClock().clock,
    };
    const out = await sourcePeople(deps, {
      userId: 'u1',
      goal: {
        id: 'g3',
        kind: 'recruiting',
        title: 'Design internship at Figma',
        criteria: ['product design', 'Figma'],
        roles: ['Product Designer'],
        orgs: ['Figma'],
      },
      user: { firstName: 'Ari', school: 'Stanford University' },
      unipileAccountId: 'acc1',
    });
    const search = net.calls.find((c) => c.url.includes('/linkedin/search?'))!;
    expect(search.body).toEqual({
      api: 'classic',
      category: 'people',
      keywords: '"Product Designer"',
      network_distance: [2, 3],
      company: ['123'],
      school: ['456'],
    });
    expect(out.results.map((r) => r.candidate.name)).toEqual(['Priya Shah', 'Ken Ito']);
    expect(out.results[0]).toMatchObject({
      reach: 0.05,
      external_id: 'ACoAAPriyaShah',
      reasons: expect.arrayContaining(['2nd-degree on LinkedIn']),
    });
    expect(out.results[1]).toMatchObject({
      person_id: 'p-ken',
      reach: 0,
      reasons: expect.arrayContaining(['You know them (72)']),
    });
    expect(out.unconfigured).toEqual([]);
  });

  it('uses Sales Navigator filters when the account has a seat', async () => {
    const net = fakeFetch((c: Call) => {
      if (c.url.includes('/linkedin/search?')) return json({ items: [] });
      if (c.url.includes('api_search')) return json({ people: [] });
      return undefined;
    });
    await sourcePeople(
      {
        ...providers(net.fetch),
        reachOf: () => null,
        responsiveness: () => 0.4,
        clock: manualClock().clock,
      },
      {
        userId: 'u1',
        goal: { id: 'g', kind: 'recruiting', title: 'x', criteria: [], roles: ['Designer'], orgs: ['Figma'] },
        user: { firstName: 'Ari' },
        unipileAccountId: 'acc1',
        salesNavigator: true,
      },
    );
    const search = net.calls.find((c) => c.url.includes('/linkedin/search?'))!;
    expect(search.url).toContain('limit=100');
    expect(search.body).toMatchObject({
      api: 'sales_navigator',
      company: { include: ['Figma'] },
      role: { include: ['Designer'] },
      network_distance: [2, 3],
    });
  });

  it('relaxes location, then seniority, when nothing comes back, and says so', async () => {
    const net = fakeFetch((c: Call) => {
      if (!c.url.includes('api_search')) return undefined;
      const u = decodeURIComponent(c.url);
      return json(
        u.includes('person_seniorities') ? { people: [] } : { people: apolloInvestors.people.slice(1) },
      );
    });
    const out = await sourcePeople(
      {
        ...providers(net.fetch, { exa: false, unipile: false }),
        reachOf: () => null,
        responsiveness: () => 0.3,
        clock: manualClock().clock,
      },
      {
        userId: 'u1',
        goal: {
          id: 'g',
          kind: 'sales',
          title: 'Sell to climate funds',
          criteria: ['climate'],
          roles: ['Investor'],
          location: 'Boston',
          seniorities: ['partner'],
        },
        user: { firstName: 'Ari' },
      },
    );
    expect(out.relaxed).toEqual(['location', 'seniority']);
    expect(out.results.map((r) => r.candidate.name)).toEqual(['Sam Ok***r']);
    expect(net.calls).toHaveLength(3);
    expect(decodeURIComponent(net.calls[0]!.url)).toContain('person_locations[]=Boston');
    expect(decodeURIComponent(net.calls[1]!.url)).not.toContain('person_locations');
  });

  it('falls back to the keyword rule when the fit model fails', async () => {
    const net = fakeFetch((c: Call) => (c.url.includes('api_search') ? json(apolloInvestors) : undefined));
    const llm = fakeClaude(() => new Error('overloaded'));
    const out = await sourcePeople(
      {
        ...providers(net.fetch, { exa: false }),
        claude: llm.claude,
        reachOf: () => null,
        responsiveness: () => 0,
        clock: manualClock().clock,
      },
      {
        userId: 'u1',
        goal: { id: 'g', kind: 'sales', title: 'x', criteria: ['Partner', 'Greenfield'] },
        user: { firstName: 'Ari' },
      },
    );
    expect(llm.calls).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ fit: 1, reasons: ['Matches "Partner"', 'Matches "Greenfield"'] });
    // "Cedar Climate Partners" matches "Partner" only
    expect(out.results[1]).toMatchObject({ fit: 0.5, reasons: ['Matches "Partner"'] });
  });
});

describe('merge and fit rules', () => {
  const person = (over: Partial<Candidate>): Candidate => ({
    key: Math.random().toString(36),
    entity: 'person',
    name: 'x',
    sources: ['exa'],
    externalIds: {},
    ...over,
  });

  it('merges by LinkedIn URL, by email, and an obfuscated Apollo last name by initial', () => {
    const merged = mergeCandidates([
      person({
        name: 'Jane Doe',
        firstName: 'Jane',
        lastName: 'Doe',
        org: 'Acme',
        linkedinUrl: 'https://www.linkedin.com/in/jd',
      }),
      person({
        name: 'Jane D***e',
        firstName: 'Jane',
        lastName: 'D***e',
        lastNameObfuscated: true,
        org: 'Acme Inc.',
        sources: ['apollo'],
      }),
      person({
        name: 'J. Doe',
        linkedinUrl: 'https://linkedin.com/in/JD/',
        email: 'jd@acme.test',
        sources: ['unipile'],
      }),
      person({ name: 'Jane Doe (Acme)', email: 'JD@acme.test', sources: ['unipile'] }),
    ]);
    expect(merged.map((m) => [m.name, m.sources.join('+')])).toEqual([['Jane Doe', 'exa+apollo+unipile']]);
  });

  it('never merges two real names, and leaves an initial shared by two people unmerged', () => {
    const merged = mergeCandidates([
      person({ name: 'Jane Doe', firstName: 'Jane', lastName: 'Doe', org: 'Acme' }),
      person({ name: 'Jane Dunn', firstName: 'Jane', lastName: 'Dunn', org: 'Acme' }),
      person({
        name: 'Jane D***e',
        firstName: 'Jane',
        lastName: 'D***e',
        lastNameObfuscated: true,
        org: 'Acme',
        sources: ['apollo'],
      }),
    ]);
    expect(merged.map((m) => m.name)).toEqual(['Jane Doe', 'Jane Dunn', 'Jane D***e']);
  });

  it('keyword fit is the share of criteria matched', () => {
    const c = person({
      name: 'A',
      title: 'Partner',
      org: 'Seed Climate Fund',
      headline: 'climate software investor',
    });
    expect(keywordFit({ ...fundraising, criteria: ['climate software', 'biotech'] }, c)).toEqual({
      fit: 0.5,
      reasons: ['Matches "climate software"'],
    });
  });

  it('warmth: a warm intro outranks a better-fitting stranger, and the email finder fills the rest', async () => {
    const net = fakeFetch((c: Call) => {
      if (c.url.endsWith('api.exa.ai/search'))
        return json((c.body as { category?: string }).category === 'company' ? exaFunds : exaInvestors);
      if (c.url.includes('mixed_people/api_search')) return json(apolloInvestors);
      return undefined;
    });
    const llm = fakeClaude(
      fitAnswer({ 'Maya Patel': 0.9, 'Leo Grant': 0.5, 'Sam Ok***r': 0.6, 'Greenfield Ventures': 0.3 }),
    );
    const { warmthOf } = await import('../../../../../supabase/functions/_shared/sourcing/warmth');
    const { fillEmails } = await import('../../../../../supabase/functions/_shared/sourcing/email');
    const deps: SourcingDeps = {
      ...providers(net.fetch),
      claude: llm.claude,
      reachOf: () => null,
      responsiveness: () => 0.5,
      budget: memoryBudget().budget,
      clock: manualClock().clock,
      newId: () => 'batch-w',
      warmthOf: (c, known) =>
        warmthOf(c, {
          student: { orgs: [], interests: [] },
          known,
          warm:
            c.name === 'Leo Grant' && c.org
              ? [{ personId: 'kel', name: 'Kelly Moss', score: 83, org: c.org }]
              : [],
          year: 2026,
        }),
      fillEmails: (cands) => fillEmails(cands, { known: [], orgDomains: new Map(), mx: async () => false }),
    };
    const out = await sourcePeople(deps, { userId: 'u1', goal: fundraising, user: { firstName: 'Ari' } });
    const names = out.results.map((r) => r.candidate.name);
    expect(names.indexOf('Leo Grant')).toBeLessThan(names.indexOf('Maya Patel'));
    const leo = out.results.find((r) => r.candidate.name === 'Leo Grant')!;
    expect(leo.candidate.warmth).toMatchObject({ tier: 2, bridge: { personId: 'kel' } });
    expect(leo.reasons[0]).toMatch(/Kelly is close to you/);
  });
});

describe('plan 34: cheaper sourcing', () => {
  it('B2 the same ask twice, from anyone: Exa and Apollo are asked once, and the second run pays nothing', async () => {
    const net = fakeFetch((c: Call) => {
      if (c.url.endsWith('api.exa.ai/search'))
        return json((c.body as { category?: string }).category === 'company' ? exaFunds : exaInvestors);
      if (c.url.includes('mixed_people/api_search')) return json(apolloInvestors);
      return undefined;
    });
    const cache = memorySharedCache();
    const run = async (userId: string) => {
      const money = memoryBudget();
      const llm = fakeClaude(fitAnswer({ 'Maya Patel': 0.9 }));
      const out = await sourcePeople(
        {
          ...providers(net.fetch),
          claude: llm.claude,
          reachOf: () => null,
          responsiveness: () => 0.5,
          budget: money.budget,
          cache,
          clock: manualClock().clock,
        },
        { userId, goal: fundraising, user: { firstName: 'Ari' } },
      );
      return { out, money };
    };
    const first = await run('u1');
    const callsAfterFirst = net.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(first.money.ledger.some((r) => r.provider === 'exa')).toBe(true);
    const second = await run('u2');
    expect(net.calls.length).toBe(callsAfterFirst);
    expect(second.money.ledger.filter((r) => r.provider === 'exa')).toHaveLength(0);
    expect(second.out.results.map((r) => r.candidate.name)).toEqual(
      first.out.results.map((r) => r.candidate.name),
    );
  });

  it('B5 a search engine goes first: pages by plain fetch, and Claude web search is never asked', async () => {
    const searched: string[][] = [];
    const serper: SearchEngine = {
      name: 'serper',
      configured: true,
      usdPerCall: 0.001,
      queriesPerCall: 1,
      search: async (queries) => {
        searched.push(queries);
        return {
          ok: true,
          value: [{ url: 'https://lab.example.edu/people', title: 'People', snippet: 'Our lab' }],
        };
      },
    };
    const page = fakeFetch((c: Call) =>
      c.url === 'https://lab.example.edu/people'
        ? new Response(
            `<html><title>People</title><body>${'Dr. Jane Doe runs the lab. '.repeat(20)}</body></html>`,
            {
              headers: { 'content-type': 'text/html' },
            },
          )
        : undefined,
    );
    let claudeAsked = 0;
    const claudeSource: WebSource = {
      name: 'claude',
      estimateUsd: () => 0.05,
      gather: async () => {
        claudeAsked++;
        return { hits: [], pages: [], costUsd: 0.05, notes: [], steps: [] };
      },
    };
    const cache = memorySharedCache();
    const plan = { queries: [{ id: 'a', query: 'lab people' }], focus: 'lab people', maxPages: 2 };
    const ctx = { budgetUsd: 0.25, timeoutMs: 10_000, select: (h: { url: string }[]) => h.map((x) => x.url) };
    const g = await gatherFrom([engineWeb(serper, cache, page.fetch), claudeSource], plan, ctx);
    expect(g.provider).toBe('serper');
    expect(g.costUsd).toBeCloseTo(0.001, 6);
    expect(g.pages[0]?.text).toContain('Jane Doe');
    expect(claudeAsked).toBe(0);
    // the same search again is free: cached by engine and query, and the page by URL
    const again = await gatherFrom([engineWeb(serper, cache, page.fetch), claudeSource], plan, ctx);
    expect(again.costUsd).toBe(0);
    expect(searched).toHaveLength(1);
    expect(page.calls).toHaveLength(1);
  });

  it('B5 an engine that cannot answer hands over to the next source', async () => {
    const down: SearchEngine = {
      name: 'parallel',
      configured: true,
      usdPerCall: 0.001,
      queriesPerCall: 5,
      search: async () => ({
        ok: false,
        kind: 'http',
        provider: 'parallel',
        status: 402,
        message: 'parallel 402',
      }),
    };
    const next: WebSource = {
      name: 'claude',
      estimateUsd: () => 0,
      gather: async () => ({ hits: [], pages: [], costUsd: 0, notes: ['claude ran'], steps: [] }),
    };
    const g = await gatherFrom(
      [engineWeb(down, memorySharedCache()), next],
      { queries: [{ id: 'a', query: 'x' }], focus: 'x', maxPages: 1 },
      { budgetUsd: 1, timeoutMs: 1000, select: () => [] },
    );
    expect(g.provider).toBe('claude');
  });
});
