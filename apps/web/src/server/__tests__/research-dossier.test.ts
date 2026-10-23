import { describe, expect, it } from 'vitest';
import contentsJane from '../../../../../supabase/functions/_shared/__fixtures__/exa-contents-jane.json';
import newsJane from '../../../../../supabase/functions/_shared/__fixtures__/exa-search-news-jane.json';
import peopleAlex from '../../../../../supabase/functions/_shared/__fixtures__/exa-search-people-alex-kim.json';
import peopleJane from '../../../../../supabase/functions/_shared/__fixtures__/exa-search-people-jane.json';
import talksJane from '../../../../../supabase/functions/_shared/__fixtures__/exa-search-talks-jane.json';
import postsJane from '../../../../../supabase/functions/_shared/__fixtures__/unipile-posts-jane.json';
import profileJane from '../../../../../supabase/functions/_shared/__fixtures__/unipile-profile-jane.json';
import { createExa } from '../../../../../supabase/functions/_shared/providers/exa';
import { createUnipileResearch } from '../../../../../supabase/functions/_shared/providers/unipileResearch';
import type { ClaudePrompt } from '../../../../../supabase/functions/_shared/research/deps';
import {
  buildDossier,
  DOSSIER_CAP_USD,
  type DossierInput,
  dropUncited,
  exaSearches,
  finish,
  invalidSourceIds,
} from '../../../../../supabase/functions/_shared/research/dossier';
import {
  appearsMinor,
  passesIdentity,
  sensitiveCategory,
} from '../../../../../supabase/functions/_shared/research/guards';
import { dossierSchema, PROMPT_VERSION } from '../../../../../supabase/functions/_shared/research/prompts';
import {
  type Call,
  DAY,
  fakeClaude,
  fakeFetch,
  instant,
  json,
  manualClock,
  memoryBudget,
  memoryResearchDb,
} from './fakes';

const UNIPILE = 'https://api9.unipile.com:13999';

const jane: DossierInput = {
  userId: 'u1',
  personId: 'p-jane',
  goalId: 'g1',
  goalKind: 'recruiting',
  goalSentence: 'land a robotics engineering internship for summer 2027',
  user: { firstName: 'Sam', context: 'Sam, Stanford CS 2027, robotics club lead.' },
  person: {
    name: 'Jane Doe',
    title: 'VP Engineering',
    org: 'Northwind Robotics',
    linkedinMemberId: 'ACoAAJaneDoe',
    linkedinUrl: 'https://www.linkedin.com/in/jane-doe-nw',
  },
  unipileAccountId: 'acc1',
};

/** Exa and Unipile answering from the recorded fixtures. */
function upstream(people: unknown = peopleJane, profile: unknown = profileJane) {
  return fakeFetch((c: Call) => {
    if (c.url.startsWith('https://api.exa.ai/search')) {
      const cat = (c.body as { category?: string }).category;
      return json(cat === 'people' ? people : cat === 'news' ? newsJane : talksJane);
    }
    if (c.url.startsWith('https://api.exa.ai/contents')) return json(contentsJane);
    if (c.url.includes('/posts?')) return json(postsJane);
    if (c.url.startsWith(`${UNIPILE}/api/v1/users/`)) return json(profile);
    return undefined;
  });
}

/** The ids a prompt offers: [S1] in the LinkedIn block, <source id="S2"> in the web block. */
function idsIn(p: ClaudePrompt): string[] {
  return [...p.user.matchAll(/\[(S\d+)\]|<source id="(S\d+)"/g)].map((m) => (m[1] ?? m[2])!);
}

function goodDossier(p: ClaudePrompt, override: Record<string, unknown> = {}) {
  const ids = idsIn(p);
  const last = ids[ids.length - 1]!;
  return {
    who: 'Jane Doe runs engineering at Northwind Robotics, which builds warehouse picking robots.',
    now: { role: 'VP Engineering', org: 'Northwind Robotics', since: '2023-02', source_ids: [ids[0]!] },
    recently: [
      {
        date: '2026-06-02',
        text: 'Northwind raised a $40M Series B and plans to hire 30 engineers.',
        source_ids: [last],
      },
    ],
    in_common: [{ text: 'Both Stanford engineering', kind: 'school', source_ids: [ids[0]!] }],
    history: { first_contact: null, last_contact: null, summary: null },
    openers: [
      {
        text: 'Your point about designing for the shelves warehouses already have stuck with me.',
        source_ids: [last],
      },
      { text: 'I saw Northwind is hiring field reliability engineers in Oakland.', source_ids: [ids[1]!] },
      { text: 'Congrats on the Series B.', source_ids: [last] },
    ],
    careful: [],
    confidence: 'high',
    ...override,
  };
}

function setup(opts: { people?: unknown; profile?: unknown; exaKey?: string | null } = {}) {
  const time = manualClock();
  const net = upstream(opts.people, opts.profile);
  const db = memoryResearchDb(time.clock, {
    messages: [
      {
        at: '2026-09-01T10:00:00Z',
        direction: 'outbound',
        subject: 'Robotics club demo',
        body: 'Would you look at our arm?',
      },
    ],
    notes: [],
    facts: [],
    events: [],
  });
  const money = memoryBudget();
  const exa = createExa({
    fetch: net.fetch,
    apiKey: opts.exaKey === null ? undefined : 'exa-k',
    sleep: instant,
  });
  const unipile = createUnipileResearch({ fetch: net.fetch, apiKey: 'uk', baseUrl: UNIPILE, sleep: instant });
  return { time, net, db, money, exa, unipile };
}

describe('dossier pipeline (§5.6)', () => {
  it('1. builds a schema-valid dossier from Exa and Unipile fixtures, every source id real, cost ≤ $0.25', async () => {
    const s = setup();
    const llm = fakeClaude((_t, p) => goodDossier(p), { costUsd: 0.14, ledger: s.money.ledger });
    const out = await buildDossier(
      {
        exa: s.exa,
        unipile: s.unipile,
        claude: llm.claude,
        db: s.db,
        budget: s.money.budget,
        clock: s.time.clock,
      },
      jane,
    );
    expect(out.status).toBe('ready');
    if (out.status !== 'ready') return;
    expect(dossierSchema.safeParse(out.dossier).success).toBe(true);
    const ids = new Set(out.sources.map((x) => x.id));
    const cited = [
      ...out.dossier.now.source_ids,
      ...out.dossier.recently.flatMap((x) => x.source_ids),
      ...out.dossier.in_common.flatMap((x) => x.source_ids),
      ...out.dossier.openers.flatMap((x) => x.source_ids),
    ];
    expect(cited.length).toBeGreaterThan(0);
    for (const id of cited) expect(ids.has(id), id).toBe(true);

    // identity check: the pastry chef and the marathon runner share the name but not the org
    const urls = out.sources.map((x) => x.url);
    expect(urls).not.toContain('https://sweetspot.example/about');
    expect(urls).not.toContain('https://local.example/marathon');
    expect(urls).toContain('https://news.example/northwind-series-b');
    expect(out.sources[0]).toMatchObject({ id: 'S1', kind: 'linkedin_profile' });

    // money: Exa (3 searches + 1 contents) and the synthesis, all in the ledger, under the cap
    expect(s.money.ledger.map((r) => `${r.provider}:${r.operation}`).sort()).toEqual([
      'claude:dossier',
      'exa:contents',
      'exa:search',
      'exa:search',
      'exa:search',
      'unipile_profile:profile',
    ]);
    expect(s.money.total()).toBeLessThanOrEqual(DOSSIER_CAP_USD);
    expect(out.costUsd).toBeCloseTo(s.money.total(), 6);

    // the request shapes: notify=false on the profile view, three Exa searches, one contents call for ≤ 6 pages
    const profileCall = s.net.calls.find((c) => c.url.startsWith(`${UNIPILE}/api/v1/users/ACoAAJaneDoe?`))!;
    expect(profileCall.url).toContain('notify=false');
    const searches = s.net.calls.filter((c) => c.url.endsWith('/search'));
    const byCategory = (cat: string | undefined) =>
      searches.find((c) => (c.body as { category?: string }).category === cat)!;
    expect(searches).toHaveLength(3);
    expect(byCategory('people').body).toMatchObject({
      query: '"Jane Doe" Northwind Robotics VP Engineering',
      type: 'auto',
      numResults: 5,
    });
    expect(byCategory('news').body).toMatchObject({
      startPublishedDate: '2025-04-01T00:00:00.000Z',
      numResults: 5,
    });
    expect(byCategory(undefined).body).toMatchObject({
      query:
        '"Jane Doe" Northwind Robotics podcast OR talk OR interview OR blog OR GitHub OR personal website',
    });
    const contents = s.net.calls.filter((c) => c.url.endsWith('/contents'));
    expect(contents).toHaveLength(1);
    expect(contents[0]!.body).toMatchObject({ text: { maxCharacters: 6000 }, maxAgeHours: 720 });
    // the news story and the podcast name her and Northwind; her LinkedIn page never counts as a web source (the profile
    // itself is the LinkedIn source), and the namesake baker and runner are not her
    expect((contents[0]!.body as { urls: string[] }).urls).toEqual([
      'https://news.example/northwind-series-b',
      'https://pod.example/ep-88',
    ]);
    // blocked sources never reach the search
    expect((byCategory('people').body as { excludeDomains: string[] }).excludeDomains).toContain(
      'spokeo.com',
    );

    // the exact §5.4 instructions went out, and the stored row carries the prompt version and a 30-day expiry
    expect(llm.calls[0]!.prompt.system).toContain(
      'You write a research brief about one person for Sam, who wants to land a robotics engineering internship',
    );
    expect(llm.calls[0]!.prompt.user).toContain(
      '<internal_history>2026-09-01 user → them · Robotics club demo',
    );
    const row = s.db.dossiers.get('u1:p-jane')!;
    expect(row).toMatchObject({ status: 'ready', goal_id: 'g1', prompt_version: PROMPT_VERSION });
    expect(Date.parse(row.expires_at) - s.time.clock()).toBe(30 * DAY);
  });

  it('2. two same-name people → needs_disambiguation with both candidates and no synthesis call', async () => {
    const s = setup({ people: peopleAlex });
    const llm = fakeClaude((_t, p) => goodDossier(p));
    const out = await buildDossier(
      {
        exa: s.exa,
        unipile: s.unipile,
        claude: llm.claude,
        db: s.db,
        budget: s.money.budget,
        clock: s.time.clock,
      },
      { ...jane, personId: 'p-alex', person: { name: 'Alex Kim' }, unipileAccountId: undefined },
    );
    expect(out.status).toBe('needs_disambiguation');
    if (out.status !== 'needs_disambiguation') return;
    expect(out.candidates.map((c) => c.org)).toEqual(['Stripe', 'Bluebird Capital']);
    expect(out.candidates.map((c) => c.url)).toEqual([
      'https://www.linkedin.com/in/alexkim-stripe',
      'https://www.linkedin.com/in/alex-kim-vc',
    ]);
    expect(llm.calls).toHaveLength(0);
    expect(s.net.calls.some((c) => c.url.endsWith('/contents'))).toBe(false);
    expect(s.db.dossiers.get('u1:p-alex')).toMatchObject({ status: 'needs_disambiguation' });
  });

  it('3. a second request within 30 days returns the cached dossier with zero upstream calls', async () => {
    const s = setup();
    const llm = fakeClaude((_t, p) => goodDossier(p));
    const deps = {
      exa: s.exa,
      unipile: s.unipile,
      claude: llm.claude,
      db: s.db,
      budget: s.money.budget,
      clock: s.time.clock,
    };
    const first = await buildDossier(deps, jane);
    const callsAfterFirst = s.net.calls.length;
    s.time.advance(12 * DAY);
    const second = await buildDossier(deps, jane);
    expect(second).toMatchObject({ status: 'ready', cached: true, costUsd: 0 });
    if (first.status === 'ready' && second.status === 'ready') expect(second.dossier).toEqual(first.dossier);
    expect(s.net.calls.length).toBe(callsAfterFirst);
    expect(llm.calls).toHaveLength(1);
  });

  it('a refresh within the Exa cache week rebuilds the synthesis without any Exa or LinkedIn call', async () => {
    const s = setup();
    const llm = fakeClaude((_t, p) => goodDossier(p));
    const deps = {
      exa: s.exa,
      unipile: s.unipile,
      claude: llm.claude,
      db: s.db,
      budget: s.money.budget,
      clock: s.time.clock,
    };
    await buildDossier(deps, jane);
    const n = s.net.calls.length;
    s.time.advance(3 * DAY);
    const again = await buildDossier(deps, { ...jane, refresh: true });
    expect(again).toMatchObject({ status: 'ready', cached: false });
    expect(s.net.calls.length).toBe(n);
    expect(llm.calls).toHaveLength(2);
  });

  it('rejects unknown source ids and retries once with the allowed ids', async () => {
    const s = setup();
    const llm = fakeClaude((_t, p, n) =>
      n === 1 ? goodDossier(p, { openers: [{ text: 'Made up.', source_ids: ['S42'] }] }) : goodDossier(p),
    );
    const out = await buildDossier(
      {
        exa: s.exa,
        unipile: s.unipile,
        claude: llm.claude,
        db: s.db,
        budget: s.money.budget,
        clock: s.time.clock,
      },
      jane,
    );
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]!.prompt.user).toContain('cited source ids that do not exist (S42)');
    expect(out.status).toBe('ready');
  });

  it('drops claims still uncited after the retry and marks the dossier partial', async () => {
    const s = setup();
    const llm = fakeClaude((_t, p) =>
      goodDossier(p, {
        openers: [
          { text: 'Made up.', source_ids: ['S42'] },
          { text: 'Real one.', source_ids: ['S1'] },
        ],
      }),
    );
    const out = await buildDossier(
      {
        exa: s.exa,
        unipile: s.unipile,
        claude: llm.claude,
        db: s.db,
        budget: s.money.budget,
        clock: s.time.clock,
      },
      jane,
    );
    expect(llm.calls).toHaveLength(2);
    expect(out.status).toBe('partial');
    if (out.status === 'partial') {
      expect(out.dossier.openers.map((o) => o.text)).toEqual(['Real one.']);
      expect(out.dossier.confidence).toBe('low');
    }
  });

  it('removes sensitive-category claims and openers over 25 words', async () => {
    const s = setup();
    const long = Array.from({ length: 30 }, () => 'word').join(' ');
    const llm = fakeClaude((_t, p) =>
      goodDossier(p, {
        who: 'Jane Doe runs engineering at Northwind Robotics. She is married with two kids.',
        recently: [{ date: null, text: 'She voted for the transit levy.', source_ids: ['S1'] }],
        openers: [
          { text: 'Congratulations on your wedding and your husband’s new job.', source_ids: ['S1'] },
          { text: 'I hear she is 42 years old and still shipping.', source_ids: ['S1'] },
          { text: long, source_ids: ['S1'] },
        ],
      }),
    );
    const out = await buildDossier(
      {
        exa: s.exa,
        unipile: s.unipile,
        claude: llm.claude,
        db: s.db,
        budget: s.money.budget,
        clock: s.time.clock,
      },
      jane,
    );
    if (out.status !== 'ready') throw new Error(out.status);
    expect(out.dossier.who).toBe('Jane Doe runs engineering at Northwind Robotics.');
    expect(out.dossier.recently).toEqual([]);
    expect(out.dossier.openers).toEqual([]);
    expect(sensitiveCategory('her husband works at Google')).toBe('family');
  });

  it('stops for someone who appears to be in high school: no contents, no synthesis, nothing kept', async () => {
    const s = setup({
      profile: {
        ...profileJane,
        headline: 'High school student at Lincoln High School',
        work_experience: [],
        education: [{ school: 'Lincoln High School', start: '2024', end: '2028' }],
      },
    });
    const llm = fakeClaude((_t, p) => goodDossier(p));
    const out = await buildDossier(
      {
        exa: s.exa,
        unipile: s.unipile,
        claude: llm.claude,
        db: s.db,
        budget: s.money.budget,
        clock: s.time.clock,
      },
      jane,
    );
    expect(out).toMatchObject({ status: 'failed', error: 'minor' });
    expect(llm.calls).toHaveLength(0);
    expect(s.net.calls.some((c) => c.url.endsWith('/contents'))).toBe(false);
    expect(s.db.dossiers.get('u1:p-jane')).toMatchObject({ status: 'failed', content: null, error: 'minor' });
  });

  it('without Exa builds from LinkedIn and internal history, marked partial', async () => {
    const s = setup({ exaKey: null });
    const llm = fakeClaude((_t, p) =>
      goodDossier(p, { recently: [], openers: [{ text: 'Hiring post.', source_ids: ['S2'] }] }),
    );
    const out = await buildDossier(
      {
        exa: s.exa,
        unipile: s.unipile,
        claude: llm.claude,
        db: s.db,
        budget: s.money.budget,
        clock: s.time.clock,
      },
      jane,
    );
    expect(out.status).toBe('partial');
    if (out.status === 'partial') {
      expect(out.notes).toContain('Exa is not configured');
      expect(out.sources.map((x) => x.kind)).toEqual(['linkedin_profile', 'linkedin_post']);
    }
    expect(s.net.calls.some((c) => c.url.includes('api.exa.ai'))).toBe(false);
  });

  it('falls back to a no-model brief when synthesis is unavailable, and skips Exa over the user budget', async () => {
    const s = setup();
    const money = memoryBudget({ exa: true });
    const llm = fakeClaude(() => new Error('refused'));
    const out = await buildDossier(
      {
        exa: s.exa,
        unipile: s.unipile,
        claude: llm.claude,
        db: s.db,
        budget: money.budget,
        clock: s.time.clock,
      },
      jane,
    );
    expect(out.status).toBe('partial');
    if (out.status === 'partial') {
      expect(out.model).toBeNull();
      expect(out.dossier).toMatchObject({
        now: { role: 'VP Engineering', org: 'Northwind Robotics', source_ids: ['S1'] },
        confidence: 'low',
      });
      expect(out.notes).toContain('exa budget exceeded');
    }
    expect(s.net.calls.some((c) => c.url.includes('api.exa.ai'))).toBe(false);
  });
});

describe('research guards', () => {
  it('identity needs the full name and one anchor', () => {
    const a = { fullName: 'Jane Doe', anchors: ['northwind robotics'] };
    expect(passesIdentity('Jane Doe, VP at Northwind Robotics', a)).toBe(true);
    expect(passesIdentity('Jane Doe bakes bread', a)).toBe(false);
    expect(passesIdentity('J. Doe at Northwind Robotics', a)).toBe(false);
  });

  it('flags current high-schoolers only', () => {
    expect(appearsMinor({ headline: 'Junior at Lincoln High School', year: 2026 })).toBe(true);
    expect(appearsMinor({ headline: 'Mentor to high school students', year: 2026 })).toBe(false);
    expect(
      appearsMinor({
        education: [{ school: 'Lincoln High School', end: '2012' }],
        headline: 'Engineer',
        year: 2026,
      }),
    ).toBe(false);
  });

  it('builds the §5.2 Exa queries, with publications for collaboration goals', () => {
    const q = exaSearches(
      { ...jane, goalKind: 'collaboration', field: 'soft robotics' },
      Date.parse('2026-10-14T00:00:00Z'),
    );
    expect(q.map((x) => [x.category, x.query])).toEqual([
      ['people', '"Jane Doe" Northwind Robotics VP Engineering'],
      ['news', '"Jane Doe" Northwind Robotics'],
      ['publication', '"Jane Doe" soft robotics'],
    ]);
    expect(exaSearches(jane, 0)[2]!.query).toBe(
      '"Jane Doe" Northwind Robotics podcast OR talk OR interview OR blog OR GitHub OR personal website',
    );
  });

  it('keeps the full picture only when cited, and the fallback lays out the LinkedIn career', () => {
    const base = {
      who: 'x',
      now: { role: 'VP', org: 'Northwind', since: null, source_ids: ['S1'] },
      recently: [],
      in_common: [],
      history: { first_contact: null, last_contact: null, summary: null },
      openers: [],
      careful: [],
      confidence: 'high' as const,
      career: [
        { role: 'VP Engineering', org: 'Northwind', start: '2022', end: null, source_ids: ['S1'] },
        { role: 'Engineer', org: 'Nowhere', start: null, end: null, source_ids: ['S9'] },
      ],
      highlights: [
        {
          kind: 'talk' as const,
          title: 'Robots at scale',
          date: '2026',
          url: 'javascript:alert(1)',
          summary: null,
          source_ids: ['S1'],
        },
      ],
      profiles: [
        { kind: 'github' as const, url: 'https://github.com/janedoe' },
        { kind: 'other' as const, url: 'javascript:alert(1)' },
      ],
    };
    expect(invalidSourceIds(base, ['S1'])).toEqual(['S9']);
    const dropped = dropUncited(base, ['S1']);
    expect(dropped.career?.map((c) => c.org)).toEqual(['Northwind']);
    const done = finish(dropped, { messages: [], notes: [], events: [] } as never, false);
    expect(done.highlights?.[0]?.url).toBeNull();
    expect(done.profiles?.map((p) => p.url)).toEqual(['https://github.com/janedoe']);
  });
});
