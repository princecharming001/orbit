import { describe, expect, it } from 'vitest';
import { createExa } from '../../../../../supabase/functions/_shared/providers/exa';
import {
  BOTH_CAP_USD,
  type BriefRequest,
  deeperPlan,
  honestWho,
  QUICK_CAP_USD,
  quickPlan,
  runBrief,
} from '../../../../../supabase/functions/_shared/research/brief';
import type {
  ClaudeDep,
  ClaudePrompt,
  ClaudeTask,
} from '../../../../../supabase/functions/_shared/research/deps';
import { writeBrief } from '../../../../../supabase/functions/_shared/research/dossier';
import { identityCard } from '../../../../../supabase/functions/_shared/research/identity';
import type { DossierContent } from '../../../../../supabase/functions/_shared/research/prompts';
import { applyVerdicts, claimsOf } from '../../../../../supabase/functions/_shared/research/support';
import {
  claudeWeb,
  claudeWebTools,
  exaWeb,
  type GatherPlan,
  memorySharedCache,
  readGatherBlocks,
  type WebPage,
  type WebSource,
} from '../../../../../supabase/functions/_shared/research/web';
import { DAY, fakeFetch, instant, json, manualClock } from './fakes';

const NOW = Date.parse('2026-10-23T12:00:00Z');

const dana: BriefRequest = {
  kind: 'quick',
  person: {
    name: 'Dana Liu',
    firstName: 'Dana',
    lastName: 'Liu',
    title: 'Product Manager',
    org: 'Ramp',
    linkedinUrl: 'https://www.linkedin.com/in/dana-liu-4b2',
  },
  profile: {
    headline: 'Product Manager at Ramp',
    location: 'New York, New York',
    publicIdentifier: 'dana-liu-4b2',
    experience: [
      { title: 'Product Manager', company: 'Ramp', current: true, start: '2024' },
      { title: 'Associate PM', company: 'Capital One', start: '2021', end: '2024' },
    ],
    education: [{ school: 'University of Michigan' }],
  },
  history: '2026-10-01 student → them: Loved your talk on card controls.',
  student: {
    firstName: 'Sam',
    context: 'Sam, Michigan 2027',
    goalSentence: 'find a PM internship',
    goalKind: 'recruiting',
  },
};

const PAGES: WebPage[] = [
  {
    url: 'https://ramp.com/blog/card-controls',
    title: 'How we built card controls at Ramp',
    text: 'By Dana Liu, product manager at Ramp. We shipped spend limits in six weeks.',
  },
  {
    url: 'https://podcast.example/ep-12',
    title: 'Ep. 12 with Dana Liu',
    text: 'Dana Liu, a University of Michigan alum, talks about moving from Capital One to Ramp.',
  },
  // a namesake: not her
  {
    url: 'https://bakery.example/team',
    title: 'Dana Liu - Baker at Sweet Spot',
    text: 'Dana Liu bakes in Ohio.',
  },
  // a page that names only her company, for Go deeper's company round
  {
    url: 'https://ramp.com/newsroom/q3',
    title: 'Ramp Q3 update',
    text: 'Ramp opened 40 new roles, including interns.',
  },
];

/** A web source over fixed pages, recording each plan; each URL is one page, and each search costs a cent. */
function fakeWeb(pages: WebPage[] = PAGES, opts: { usd?: number; fail?: boolean } = {}) {
  const plans: GatherPlan[] = [];
  const source: WebSource = {
    name: 'claude',
    estimateUsd: () => opts.usd ?? 0.04,
    async gather(plan, ctx) {
      plans.push(plan);
      if (opts.fail) throw new Error('down');
      if ((opts.usd ?? 0.04) > ctx.budgetUsd)
        return { hits: [], pages: [], costUsd: 0, notes: ['web search skipped: cost cap'], steps: [] };
      const companyRound = plan.queries.some((q) => q.id.startsWith('company'));
      const hits = pages.map((p) => ({ url: p.url, title: p.title, query: plan.queries[0]!.query }));
      const want = new Set(ctx.select(hits));
      const read = pages.filter((p) => want.has(p.url) && (companyRound || !p.url.includes('newsroom')));
      return {
        hits,
        pages: read,
        costUsd: opts.usd ?? 0.04,
        notes: [],
        steps: [{ step: 'search', provider: 'fake', costUsd: 0.04, ms: 1 }],
      };
    },
  };
  return { source, plans };
}

/** The ids a brief prompt offers: [S1] in the LinkedIn block, <source id="S2"> in the web blocks. */
const idsIn = (p: ClaudePrompt) =>
  [...p.user.matchAll(/\[(S\d+)\]|<source id="(S\d+)"/g)].map((m) => (m[1] ?? m[2])!);

function brief(p: ClaudePrompt, over: Partial<DossierContent> = {}): DossierContent {
  const ids = idsIn(p);
  const web = ids.filter((i) => i !== 'S1');
  return {
    who: 'Dana Liu is a product manager at Ramp who wrote about card controls.',
    now: { role: 'Product Manager', org: 'Ramp', since: '2024', source_ids: ['S1'] },
    recently: web[0]
      ? [{ date: '2026', text: 'Wrote about shipping spend limits in six weeks.', source_ids: [web[0]] }]
      : [],
    in_common: [{ text: 'You both went to the University of Michigan', kind: 'school', source_ids: ['S1'] }],
    history: { first_contact: null, last_contact: null, summary: null },
    openers: web[0]
      ? [
          { text: 'Your post on shipping spend limits in six weeks was a great read.', source_ids: [web[0]] },
          { text: 'You led the whole card platform at Ramp.', source_ids: [web[0]] },
        ]
      : [],
    careful: [],
    confidence: 'high',
    career: [{ role: 'Product Manager', org: 'Ramp', start: '2024', end: null, source_ids: ['S1'] }],
    education: [{ school: 'University of Michigan', degree: null, years: null, source_ids: ['S1'] }],
    profiles: [],
    highlights: [],
    topics: ['Payments'],
    company: [],
    ...over,
  };
}

/** Claude for the two tasks: the brief (the writing model) and the support check (the fast model), each with its own answer. */
function fakeClaude(
  write: (p: ClaudePrompt, n: number) => unknown,
  support: (p: ClaudePrompt) => unknown = (p) => ({
    verdicts: [...p.user.matchAll(/^(C\d+)\. /gm)].map((m) => ({ id: m[1]!, verdict: 'supported' })),
  }),
  costs: { write?: number; support?: number } = {},
) {
  const calls: { task: ClaudeTask; prompt: ClaudePrompt }[] = [];
  let writes = 0;
  const claude: ClaudeDep = {
    async parse(task, schema, prompt) {
      calls.push({ task, prompt });
      const raw = task === 'support' ? support(prompt) : write(prompt, ++writes);
      if (raw instanceof Error) return { ok: false, reason: 'error', message: raw.message, costUsd: 0.01 };
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return { ok: false, reason: 'error', message: 'schema', costUsd: 0.01 };
      return {
        ok: true,
        value: parsed.data,
        costUsd: task === 'support' ? (costs.support ?? 0.003) : (costs.write ?? 0.14),
      };
    },
  };
  return { claude, calls };
}

const limits = (cap = QUICK_CAP_USD, ms = 85_000) => ({ capUsd: cap, deadline: NOW + ms });
const clock = () => NOW;

describe('the quick brief', () => {
  it('reads only pages surely about her, numbers the sources, checks the claims and stays under $0.30', async () => {
    const web = fakeWeb();
    const llm = fakeClaude((p) => brief(p));
    const out = await runBrief({ web: [web.source], claude: llm.claude, clock }, dana, limits());
    expect(out.status).toBe('ready');
    if (out.status !== 'ready') return;
    expect(out.sources.map((s) => s.url)).toEqual([
      'https://www.linkedin.com/in/dana-liu-4b2',
      'https://ramp.com/blog/card-controls',
      'https://podcast.example/ep-12',
    ]);
    // the namesake baker never reached the writer
    expect(llm.calls[0]!.prompt.user).not.toContain('Sweet Spot');
    // her history with the student goes to the writer, never anywhere else
    expect(llm.calls[0]!.prompt.user).toContain('Loved your talk on card controls.');
    // three searches: about her, news, talks
    expect(web.plans[0]!.queries.map((q) => q.id)).toEqual(['about', 'news', 'talks']);
    expect(out.costUsd).toBeLessThanOrEqual(QUICK_CAP_USD);
    expect(out.checked).toBe(true);
    expect(out.strongPages).toBe(2);
    const c = out.content as unknown as Record<string, { support?: string }[]>;
    expect(c.openers!.every((o) => o.support === 'full')).toBe(true);
    expect(llm.calls.map((x) => x.task)).toEqual(['dossier', 'support']);
  });

  it('removes unsupported claims and keeps partly supported ones out of the openers', async () => {
    const web = fakeWeb();
    // the second opener ("led the whole card platform") is more than the page says; the "in common" line is unsupported
    const llm = fakeClaude(
      (p) => brief(p),
      (p) => ({
        verdicts: [...p.user.matchAll(/^(C\d+)\. (?:\([^)]*\) )?\[[^\]]*\] (.*)$/gm)].map((m) => ({
          id: m[1]!,
          verdict: /led the whole/.test(m[2]!)
            ? 'partial'
            : /both went/.test(m[2]!)
              ? 'unsupported'
              : /wrote about shipping/i.test(m[2]!)
                ? 'partial'
                : 'supported',
        })),
      }),
    );
    const out = await runBrief({ web: [web.source], claude: llm.claude, clock }, dana, limits());
    if (out.status !== 'ready') throw new Error(out.status);
    const c = out.content as unknown as Record<string, { text: string; support?: string }[]>;
    expect(c.openers!.map((o) => o.text)).toEqual([
      'Your post on shipping spend limits in six weeks was a great read.',
    ]);
    expect(c.in_common).toEqual([]);
    expect(c.recently!.map((r) => r.support)).toEqual(['partial']);
    expect(out.notes).toContain('1 unsupported claim removed');
  });

  it('with nothing beyond LinkedIn, says so plainly and leans on LinkedIn', async () => {
    const web = fakeWeb([]);
    const llm = fakeClaude((p) => brief(p, { who: 'Dana Liu is a product manager at Ramp.' }));
    const out = await runBrief({ web: [web.source], claude: llm.claude, clock }, dana, limits());
    if (out.status !== 'ready') throw new Error(out.status);
    expect(out.content.who).toBe(
      'Dana Liu is a product manager at Ramp. Not much is public about Dana beyond LinkedIn.',
    );
    expect(out.strongPages).toBe(0);
    expect(honestWho('Not much is public about Dana beyond LinkedIn.', 'Dana')).toBe(
      'Not much is public about Dana beyond LinkedIn.',
    );
  });

  it('no LinkedIn and no company: stops before spending anything and asks for one', async () => {
    const web = fakeWeb();
    const llm = fakeClaude((p) => brief(p));
    const out = await runBrief(
      { web: [web.source], claude: llm.claude, clock },
      { ...dana, person: { name: 'Dana Liu' }, profile: null },
      limits(),
    );
    expect(out).toMatchObject({ status: 'needs_anchor', costUsd: 0 });
    expect(web.plans).toHaveLength(0);
    expect(llm.calls).toHaveLength(0);
  });

  it('two people share the name and only a company anchors her: asks which one, then researches the one picked', async () => {
    const twins: WebPage[] = [
      { url: 'https://a.example/1', title: 'Dana Liu - Partner at Granite Law', text: 'Dana Liu, partner.' },
      { url: 'https://b.example/2', title: 'Dana Liu - Chef at Blue Oak', text: 'Dana Liu, chef.' },
    ];
    const web = fakeWeb(twins);
    const llm = fakeClaude((p) => brief(p));
    const req: BriefRequest = { ...dana, person: { name: 'Dana Liu', org: 'Northwind' }, profile: null };
    const out = await runBrief({ web: [web.source], claude: llm.claude, clock }, req, limits());
    expect(out.status).toBe('needs_disambiguation');
    if (out.status !== 'needs_disambiguation') return;
    expect(out.candidates.map((c) => c.org)).toEqual(['Granite Law', 'Blue Oak']);
    expect(llm.calls).toHaveLength(0);
    const picked = await runBrief(
      { web: [web.source], claude: llm.claude, clock },
      { ...req, chosen: { org: 'Granite Law' } },
      limits(),
    );
    expect(picked.status).toBe('ready');
    if (picked.status === 'ready') expect(picked.sources.map((s) => s.url)).toEqual(['https://a.example/1']);
  });

  it('never researches someone who appears to be in high school', async () => {
    const llm = fakeClaude((p) => brief(p));
    const out = await runBrief(
      { web: [fakeWeb().source], claude: llm.claude, clock },
      { ...dana, person: { ...dana.person, title: 'High school student' } },
      limits(),
    );
    expect(out).toMatchObject({ status: 'failed', error: 'minor', costUsd: 0 });
  });

  it('skips the web when it would cross the cap, and writes from LinkedIn alone when the writer would', async () => {
    const web = fakeWeb(PAGES, { usd: 0.5 });
    const llm = fakeClaude((p) => brief(p));
    const out = await runBrief({ web: [web.source], claude: llm.claude, clock }, dana, limits(0.03));
    if (out.status !== 'partial') throw new Error(out.status);
    expect(out.notes).toEqual(
      expect.arrayContaining(['web search skipped: cost cap', 'synthesis skipped: cost cap']),
    );
    expect(out.model).toBeNull();
    expect(out.content.who).toContain('Not much is public about Dana beyond LinkedIn');
    expect(out.content.career?.map((c) => c.org)).toEqual(['Ramp', 'Capital One']);
    expect(out.costUsd).toBe(0);
  });

  it('with too little time left to write, answers from LinkedIn instead of running past the deadline', async () => {
    const llm = fakeClaude((p) => brief(p));
    const out = await runBrief(
      { web: [fakeWeb().source], claude: llm.claude, clock },
      dana,
      limits(QUICK_CAP_USD, 10_000),
    );
    expect(out.status).toBe('partial');
    expect(llm.calls).toHaveLength(0);
    if (out.status === 'partial') expect(out.notes).toContain('writing skipped: out of time');
  });

  it('falls back to the next web source when the first is down', async () => {
    const down = fakeWeb(PAGES, { fail: true });
    const up = fakeWeb();
    const llm = fakeClaude((p) => brief(p));
    const out = await runBrief({ web: [down.source, up.source], claude: llm.claude, clock }, dana, limits());
    expect(out.status).toBe('ready');
    expect(down.plans).toHaveLength(1);
    expect(up.plans).toHaveLength(1);
  });
});

describe('the paid-answer fix', () => {
  it('keeps the first, paid answer (minus its uncited lines) when the source-id retry would cost too much', async () => {
    const bad = (p: ClaudePrompt) => ({
      ...brief(p),
      recently: [{ date: null, text: 'Cites a source that does not exist.', source_ids: ['S99'] }],
    });
    const llm = fakeClaude((p) => bad(p));
    const notes: string[] = [];
    const budget = { spent: 0, cap: 0.17, notes };
    // the first call costs $0.14, so the retry's estimate (about $0.04) no longer fits in $0.17
    const out = await writeBrief(llm.claude, { system: 's', user: '[S1] profile' }, ['S1'], budget);
    expect(llm.calls).toHaveLength(1);
    expect(out.content).not.toBeNull();
    expect(out.content!.who).toContain('Dana Liu');
    expect(out.content!.recently).toEqual([]);
    expect(out.content!.now.source_ids).toEqual(['S1']);
    expect(out.partial).toBe(true);
    expect(notes[0]).toMatch(/kept the first answer/);
  });

  it('keeps the first answer when the retry itself fails', async () => {
    const llm = fakeClaude((p, n) =>
      n === 1 ? { ...brief(p), openers: [{ text: 'x', source_ids: ['S42'] }] } : new Error('overloaded'),
    );
    const out = await writeBrief(llm.claude, { system: 's', user: '[S1] p' }, ['S1'], {
      spent: 0,
      cap: 1,
      notes: [],
    });
    expect(llm.calls).toHaveLength(2);
    expect(out.content?.openers).toEqual([]);
    expect(out.content?.who).toContain('Dana Liu');
  });

  it('turns the model’s blank strings back into nulls', async () => {
    const llm = fakeClaude((p) => ({
      ...brief(p),
      now: { role: 'PM', org: 'Ramp', since: '', source_ids: ['S1'] },
    }));
    const out = await writeBrief(llm.claude, { system: 's', user: '[S1] p' }, ['S1'], {
      spent: 0,
      cap: 1,
      notes: [],
    });
    expect(out.content?.now.since).toBeNull();
  });
});

describe('the support check, on its own', () => {
  it('numbers every cited claim, and without a verdict marks them unchecked without removing any', () => {
    const d = brief({ system: '', user: '[S1] p <source id="S2">' });
    const located = claimsOf(d, ['S1', 'S2']);
    expect(located.map((l) => l.claim.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
    const r = applyVerdicts(d, located, null, 'Dana Liu.');
    expect(r.removed).toBe(0);
    expect((r.content.openers as { support?: string }[]).map((o) => o.support)).toEqual([
      'unchecked',
      'unchecked',
    ]);
  });
});

describe('Go deeper', () => {
  it('after a quick brief with strong pages, looks further into her; without them, into her company', () => {
    const card = identityCard({ ...dana.person, profile: dana.profile });
    expect(deeperPlan(dana, card, NOW, 2, []).mode).toBe('person');
    const company = deeperPlan(dana, card, NOW, 0, []);
    expect(company.mode).toBe('company');
    expect(company.queries.map((q) => q.query)).toEqual([
      'Ramp news',
      'Ramp hiring OR internship OR "new grad" OR careers',
    ]);
    expect(quickPlan(dana, card, NOW).queries[1]).toMatchObject({ category: 'news', since: '2025-04-01' });
  });

  it('adds company context within $0.50 for both calls, reusing the quick round from the shared cache', async () => {
    const cache = memorySharedCache(clock);
    const net = fakeFetch(); // nothing should reach the network once cached
    const pages = new Map(PAGES.map((p) => [p.url, p]));
    let searches = 0;
    const cached: WebSource = {
      name: 'claude',
      estimateUsd: () => 0.04,
      async gather(plan, ctx) {
        const key = JSON.stringify(plan.queries);
        const hit = (await cache.get(key)) as WebPage[] | undefined;
        if (hit) return { hits: [], pages: hit, costUsd: 0, notes: [], steps: [] };
        searches++;
        const companyRound = plan.queries.some((q) => q.id.startsWith('company'));
        const hits = [...pages.values()].map((p) => ({ url: p.url, title: p.title, query: '' }));
        const want = new Set(ctx.select(hits));
        const read = [...pages.values()].filter(
          (p) => want.has(p.url) && (companyRound || !p.url.includes('newsroom')),
        );
        await cache.put(key, 'test', read, 7 * DAY);
        return { hits, pages: read, costUsd: 0.04, notes: [], steps: [] };
      },
    };
    const llm = fakeClaude((p) => {
      const companyId = p.user.match(/<company_sources><source id="(S\d+)"/)?.[1];
      return brief(
        p,
        companyId ? { company: [{ text: 'Ramp opened 40 new roles.', source_ids: [companyId] }] } : {},
      );
    });
    const quick = await runBrief({ web: [cached], claude: llm.claude, clock }, dana, limits());
    if (quick.status !== 'ready') throw new Error(quick.status);
    // strong pages beyond LinkedIn: deeper looks into her, and its company query brings the newsroom page
    const deeper = await runBrief(
      { web: [cached], claude: llm.claude, clock },
      { ...dana, kind: 'deeper' },
      limits(BOTH_CAP_USD - quick.costUsd, 120_000),
    );
    if (deeper.status !== 'ready') throw new Error(deeper.status);
    expect(searches).toBe(2);
    expect(net.calls).toHaveLength(0);
    expect((deeper.content as unknown as { deeper?: string }).deeper).toBe('person');
    expect(deeper.content.company?.map((c) => c.text)).toEqual(['Ramp opened 40 new roles.']);
    expect(quick.costUsd + deeper.costUsd).toBeLessThanOrEqual(BOTH_CAP_USD);
  });
});

describe('Claude web search and fetch', () => {
  const plan: GatherPlan = {
    queries: [
      { id: 'about', query: '"Dana Liu" Ramp' },
      { id: 'news', query: '"Dana Liu" Ramp news' },
    ],
    focus: 'Dana Liu, Product Manager at Ramp',
    maxPages: 2,
  };

  it('uses the current tool types, results back to Orbit as they are, and blocked sites off', () => {
    const [search] = claudeWebTools(2, 'search');
    const [fetchTool] = claudeWebTools(2, 'fetch');
    expect(search).toMatchObject({
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: 2,
      allowed_callers: ['direct'],
    });
    expect(fetchTool).toMatchObject({
      type: 'web_fetch_20260209',
      name: 'web_fetch',
      max_content_tokens: 2500,
    });
    expect(search!.blocked_domains).toEqual(
      expect.arrayContaining(['spokeo.com', 'facebook.com', 'linkedin.com']),
    );
    expect((fetchTool as { blocked_domains: string[] }).blocked_domains).toContain('zoominfo.com');
  });

  it('reads search hits and fetched page text out of the content blocks, skipping blocked sites and PDFs', () => {
    const r = readGatherBlocks([
      { type: 'server_tool_use', id: 'su1', name: 'web_search', input: { query: '"Dana Liu" Ramp' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'su1',
        content: [
          {
            type: 'web_search_result',
            url: 'https://ramp.com/blog/x',
            title: 'Card controls',
            page_age: '2026',
            encrypted_content: 'e',
          },
          {
            type: 'web_search_result',
            url: 'https://www.spokeo.com/Dana-Liu',
            title: 'Dana Liu',
            encrypted_content: 'e',
          },
        ],
      },
      {
        type: 'web_fetch_tool_result',
        tool_use_id: 'fu1',
        content: {
          type: 'web_fetch_result',
          url: 'https://ramp.com/blog/x',
          content: {
            type: 'document',
            title: 'Card controls',
            source: { type: 'text', media_type: 'text/plain', data: 'By Dana Liu.' },
          },
        },
      },
      {
        type: 'web_fetch_tool_result',
        tool_use_id: 'fu2',
        content: {
          type: 'web_fetch_result',
          url: 'https://x.example/a.pdf',
          content: { source: { type: 'base64', data: 'JVBE' } },
        },
      },
      {
        type: 'web_fetch_tool_result',
        tool_use_id: 'fu3',
        content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' },
      },
    ]);
    expect(r.searches).toBe(1);
    expect(r.hits).toEqual([
      { url: 'https://ramp.com/blog/x', title: 'Card controls', published: '2026', query: '"Dana Liu" Ramp' },
    ]);
    expect(r.pages).toEqual([
      { url: 'https://ramp.com/blog/x', title: 'Card controls', published: null, text: 'By Dana Liu.' },
    ]);
  });

  it('searches in one call and fetches the selected pages in another, then answers a retry from the cache', async () => {
    const requests: Record<string, unknown>[] = [];
    const client = {
      messages: {
        async create(body: Record<string, unknown>) {
          requests.push(body);
          const tools = body.tools as { name: string }[];
          const usage = {
            input_tokens: 20_000,
            output_tokens: 300,
            server_tool_use: { web_search_requests: tools[0]!.name === 'web_search' ? 2 : 0 },
          };
          if (tools[0]!.name === 'web_search')
            return {
              stop_reason: 'end_turn',
              usage,
              content: [
                {
                  type: 'server_tool_use',
                  id: 's1',
                  name: 'web_search',
                  input: { query: '"Dana Liu" Ramp' },
                },
                {
                  type: 'web_search_tool_result',
                  tool_use_id: 's1',
                  content: [
                    {
                      type: 'web_search_result',
                      url: 'https://ramp.com/blog/x',
                      title: 'Dana Liu on card controls',
                      encrypted_content: 'e',
                    },
                    {
                      type: 'web_search_result',
                      url: 'https://www.linkedin.com/in/dana',
                      title: 'Dana Liu | LinkedIn',
                      encrypted_content: 'e',
                    },
                  ],
                },
                { type: 'text', text: 'done' },
              ],
            };
          return {
            stop_reason: 'end_turn',
            usage,
            content: [
              {
                type: 'web_fetch_tool_result',
                tool_use_id: 'f1',
                content: {
                  type: 'web_fetch_result',
                  url: 'https://ramp.com/blog/x',
                  content: {
                    type: 'document',
                    title: 'Card controls',
                    source: { type: 'text', data: 'By Dana Liu, PM at Ramp.' },
                  },
                },
              },
              { type: 'text', text: 'done' },
            ],
          };
        },
      },
    };
    const cache = memorySharedCache(clock);
    const web = claudeWeb(client as never, cache);
    const select = (hits: { url: string }[]) =>
      hits.filter((h) => !h.url.includes('linkedin')).map((h) => h.url);
    const first = await web.gather(plan, { budgetUsd: 0.3, timeoutMs: 40_000, select });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.model).toBe('claude-haiku-5-5');
    expect(String((requests[1]!.messages as { content: string }[])[0]!.content)).toContain(
      'https://ramp.com/blog/x',
    );
    expect(String((requests[1]!.messages as { content: string }[])[0]!.content)).not.toContain('linkedin');
    expect(first.pages.map((p) => p.text)).toEqual(['By Dana Liu, PM at Ramp.']);
    // two searches at $0.01 plus the fast model's tokens
    expect(first.costUsd).toBeGreaterThan(0.02);
    expect(first.costUsd).toBeLessThan(0.03);
    // the same searches again (a retry, or another student this week): nothing is paid for
    const again = await web.gather(plan, { budgetUsd: 0.3, timeoutMs: 40_000, select });
    expect(requests).toHaveLength(2);
    expect(again.costUsd).toBe(0);
    expect(again.pages.map((p) => p.url)).toEqual(['https://ramp.com/blog/x']);
  });

  it('keeps the shared cache 7 days', async () => {
    const t = manualClock(NOW);
    const cache = memorySharedCache(t.clock);
    await cache.put('k', 'page', { a: 1 }, 7 * DAY);
    t.advance(7 * DAY - 1000);
    expect(await cache.get('k')).toEqual({ a: 1 });
    t.advance(2000);
    expect(await cache.get('k')).toBeUndefined();
  });

  it('Exa, when its key is set: searches with blocked sites excluded, then reads only the selected pages', async () => {
    const net = fakeFetch((c) => {
      if (c.url.endsWith('/search'))
        return json({
          results: [
            {
              url: 'https://ramp.com/blog/x',
              title: 'How we built card controls at Ramp',
              highlights: ['By Dana Liu, product manager at Ramp.'],
            },
            {
              url: 'https://bakery.example/team',
              title: 'Dana Liu - Baker',
              highlights: ['Dana Liu bakes in Ohio.'],
            },
          ],
          costDollars: { total: 0.012 },
        });
      if (c.url.endsWith('/contents'))
        return json({
          results: [
            { url: 'https://ramp.com/blog/x', text: 'By Dana Liu, product manager at Ramp. Spend limits.' },
          ],
          costDollars: { total: 0.001 },
        });
      return undefined;
    });
    const exa = createExa({ fetch: net.fetch, apiKey: 'k', sleep: instant });
    const web = exaWeb(exa, memorySharedCache(clock));
    const card = identityCard({ ...dana.person, profile: dana.profile });
    const { scorePage } = await import('../../../../../supabase/functions/_shared/research/identity');
    const out = await web.gather(plan, {
      budgetUsd: 0.3,
      timeoutMs: 40_000,
      select: (hits) =>
        hits
          .filter(
            (h) => scorePage({ url: h.url, title: h.title, text: h.snippet }, card).strength === 'strong',
          )
          .map((h) => h.url),
    });
    const searches = net.calls.filter((c) => c.url.endsWith('/search'));
    expect(searches).toHaveLength(2);
    expect((searches[0]!.body as { excludeDomains: string[] }).excludeDomains).toContain('whitepages.com');
    expect((net.calls.find((c) => c.url.endsWith('/contents'))!.body as { urls: string[] }).urls).toEqual([
      'https://ramp.com/blog/x',
    ]);
    expect(out.pages.map((p) => p.url)).toEqual(['https://ramp.com/blog/x']);
  });
});
