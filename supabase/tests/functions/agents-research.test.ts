import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import apolloInvestors from '../../functions/_shared/__fixtures__/apollo-search-investors.json';
import contentsJane from '../../functions/_shared/__fixtures__/exa-contents-jane.json';
import companyFunds from '../../functions/_shared/__fixtures__/exa-search-company-funds.json';
import newsJane from '../../functions/_shared/__fixtures__/exa-search-news-jane.json';
import peopleAlex from '../../functions/_shared/__fixtures__/exa-search-people-alex-kim.json';
import peopleInvestors from '../../functions/_shared/__fixtures__/exa-search-people-investors.json';
import peopleJane from '../../functions/_shared/__fixtures__/exa-search-people-jane.json';
import talksJane from '../../functions/_shared/__fixtures__/exa-search-talks-jane.json';
import postsJane from '../../functions/_shared/__fixtures__/unipile-posts-jane.json';
import profileJane from '../../functions/_shared/__fixtures__/unipile-profile-jane.json';
import { defaultHandlers, runTick } from '../../functions/orbit-worker/worker.ts';
import {
  ALL_KEYS,
  type AnthropicRequest,
  addPerson,
  agentConfig,
  anthropic,
  api,
  fakeNet,
  jsonRes,
  type NetCall,
  signedInUser,
  systemText,
  UNIPILE,
  userText,
} from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

/** The ids a dossier prompt offers: [S1] in the LinkedIn block, <source id="S2"> in the web block. */
const idsIn = (r: AnthropicRequest) =>
  [...userText(r).matchAll(/\[(S\d+)\]|<source id="(S\d+)"/g)].map((m) => (m[1] ?? m[2])!);

function dossierAnswer(r: AnthropicRequest) {
  const ids = idsIn(r);
  const last = ids[ids.length - 1]!;
  return {
    who: 'Jane Doe runs engineering at Northwind Robotics.',
    now: { role: 'VP Engineering', org: 'Northwind Robotics', since: '2023-02', source_ids: [ids[0]!] },
    recently: [{ date: '2026-06-02', text: 'Northwind raised a Series B.', source_ids: [last] }],
    in_common: [],
    history: { first_contact: null, last_contact: null, summary: null },
    openers: [{ text: 'Your talk on warehouse robots stuck with me.', source_ids: [last] }],
    careful: [],
    confidence: 'high',
  };
}

function fitAnswer(r: AnthropicRequest) {
  const block = userText(r).split('<candidates>')[1]!.split('</candidates>')[0]!;
  const cands = block
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as { id: string; name: string });
  return {
    scores: cands.map((c) => ({
      id: c.id,
      fit: /maya/i.test(c.name) ? 0.9 : 0.4,
      reasons: ['Leads seed rounds in climate'],
    })),
  };
}

/** Exa, Unipile and Apollo from the recorded fixtures; Claude answering dossier and fit prompts. */
function upstream() {
  const claude = anthropic((r) =>
    systemText(r).includes('research brief') ? dossierAnswer(r) : fitAnswer(r),
  );
  const net = fakeNet(claude.answer, (c: NetCall) => {
    const body = c.body as { category?: string; query?: string };
    if (c.url === 'https://api.exa.ai/search') {
      if (body.query?.includes('Alex Kim'))
        return jsonRes(200, body.category === 'people' ? peopleAlex : { results: [] });
      if (body.query?.includes('Jane Doe'))
        return jsonRes(
          200,
          body.category === 'people' ? peopleJane : body.category === 'news' ? newsJane : talksJane,
        );
      return jsonRes(200, body.category === 'company' ? companyFunds : peopleInvestors);
    }
    if (c.url === 'https://api.exa.ai/contents') return jsonRes(200, contentsJane);
    if (c.url.startsWith('https://api.apollo.io/api/v1/mixed_people/api_search'))
      return jsonRes(200, apolloInvestors);
    if (c.url.includes('/posts?')) return jsonRes(200, postsJane);
    if (c.url.startsWith(`${UNIPILE}/api/v1/users/`)) return jsonRes(200, profileJane);
    return undefined;
  });
  return { net, claude };
}

async function linkedinAccount(userId: string) {
  await t.db.sql`
    insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
    values (${userId}::uuid, 'linkedin', 'acc1', 'active')`;
}

const tick = (net: ReturnType<typeof fakeNet>) =>
  runTick({ db: t.db, handlers: defaultHandlers(agentConfig(net)) });

describe('research (§5)', () => {
  it('§5.8 tests 1 and 3: queues the job, builds a cited dossier under $0.25, and reuses it for 30 days', async () => {
    const { net, claude } = upstream();
    const call = api(t, net);
    const { userId, token } = await signedInUser(t);
    await linkedinAccount(userId);
    const g = await call<{ goal: { id: string } }>('/goals/upsert', token, {
      goal: {
        kind: 'recruiting',
        title: 'Robotics internship',
        targets: { organizations: ['Northwind Robotics'] },
      },
    });
    const jane = await addPerson(t, userId, {
      name: 'Jane Doe',
      title: 'VP Engineering',
      org: 'Northwind Robotics',
      memberId: 'ACoAAJaneDoe',
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe-nw',
    });
    const first = await call<{ status: string; dossier: { status: string } | null }>(
      '/research/person',
      token,
      {
        personId: jane,
        goalId: g.body.goal.id,
      },
    );
    expect(first.status).toBe(202);
    expect(first.body.status).toBe('queued');
    expect(first.body.dossier?.status).toBe('pending');
    expect(net.calls).toHaveLength(0);

    const s = await tick(net);
    expect(s.ok).toBeGreaterThanOrEqual(1);
    const got = await call<{
      dossier: {
        status: string;
        content: { openers: { source_ids: string[] }[] };
        sources: { id: string }[];
        costUsd: number;
        goalId: string;
      };
    }>('/research/get', token, { personId: jane });
    const d = got.body.dossier;
    expect(d.status).toBe('ready');
    expect(d.goalId).toBe(g.body.goal.id);
    const ids = new Set(d.sources.map((x) => x.id));
    for (const o of d.content.openers) for (const id of o.source_ids) expect(ids.has(id)).toBe(true);
    expect(d.costUsd).toBeLessThanOrEqual(0.25);
    // one Opus call with the cached system prompt and medium effort
    expect(claude.requests).toHaveLength(1);
    expect(claude.requests[0]!.model).toBe('claude-opus-5-5');
    expect(claude.requests[0]!.output_config.effort).toBe('medium');
    expect(claude.requests[0]!.system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    // §13.8 test 2: every call is a ledger row with its cost
    const ledger = await t.db.sql<{ provider: string; operation: string; cost_usd: string }>`
      select provider, operation, cost_usd::text from orbit.usage_ledger where user_id = ${userId}::uuid order by id`;
    expect(ledger.filter((l) => l.provider === 'anthropic')).toHaveLength(1);
    expect(Number(ledger.find((l) => l.provider === 'anthropic')!.cost_usd)).toBeGreaterThan(0);
    expect(
      ledger
        .filter((l) => l.provider === 'exa')
        .map((l) => l.operation)
        .sort(),
    ).toEqual(['contents', 'search', 'search', 'search']);
    expect(ledger.some((l) => l.provider === 'unipile' && l.operation === 'profile_view')).toBe(true);
    const total = ledger
      .filter((l) => l.provider !== 'anthropic')
      .reduce((x, l) => x + Number(l.cost_usd), 0);
    expect(total + Number(ledger.find((l) => l.provider === 'anthropic')!.cost_usd)).toBeLessThanOrEqual(
      0.25,
    );

    // §5.8 test 3: a second request within 30 days makes no upstream call and queues nothing
    const before = net.calls.length;
    const again = await call<{ status: string; dossier: { status: string } }>('/research/person', token, {
      personId: jane,
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: 'ready', dossier: { status: 'ready' } });
    expect(net.calls.length).toBe(before);
    const queued = await t.db.sql`select 1 from pgmq.q_orbit_enrich where message->>'userId' = ${userId}`;
    expect(queued).toHaveLength(0);
    // a refresh rebuilds, with Exa pages from the 7-day cache
    const exaCalls = () => net.calls.filter((c) => c.url.startsWith('https://api.exa.ai')).length;
    const exaBefore = exaCalls();
    const refresh = await call<{ status: string }>('/research/person', token, {
      personId: jane,
      refresh: true,
    });
    expect(refresh.body.status).toBe('queued');
    await tick(net);
    expect(exaCalls()).toBe(exaBefore);
    expect(claude.requests).toHaveLength(2);
  });

  it('§5.8 test 2: two people with the same name stop at needs_disambiguation without a synthesis call', async () => {
    const { net, claude } = upstream();
    const call = api(t, net);
    const { userId, token } = await signedInUser(t);
    const alex = await addPerson(t, userId, { name: 'Alex Kim' });
    await call('/research/person', token, { personId: alex });
    await tick(net);
    const r = await call<{ dossier: { status: string; candidates: { org: string }[] } }>(
      '/research/get',
      token,
      {
        personId: alex,
      },
    );
    expect(r.body.dossier.status).toBe('needs_disambiguation');
    expect(r.body.dossier.candidates.map((c) => c.org).sort()).toEqual(['Bluebird Capital', 'Stripe']);
    expect(claude.requests).toHaveLength(0);
    // a pending choice is returned as is, not re-queued
    const same = await call<{ status: string }>('/research/person', token, { personId: alex });
    expect(same.body.status).toBe('needs_disambiguation');
    // choosing pins the organization and runs it again
    const i = r.body.dossier.candidates.findIndex((c) => c.org === 'Stripe');
    const chosen = await call<{ status: string }>('/research/choose', token, {
      personId: alex,
      candidateIndex: i,
    });
    expect(chosen.status).toBe(202);
    const [p] = await t.db.sql<{ org_raw: string; linkedin_slug: string }>`
      select org_raw, linkedin_slug from orbit.people where id = ${alex}::uuid`;
    expect(p).toEqual({ org_raw: 'Stripe', linkedin_slug: 'alexkim-stripe' });
    await tick(net);
    const after = await call<{ dossier: { status: string } }>('/research/get', token, { personId: alex });
    expect(['ready', 'partial']).toContain(after.body.dossier.status);
    expect((await call('/research/choose', token, { personId: alex, candidateIndex: 0 })).status).toBe(409);
  });

  it('§13.8 test 1: with no keys the dossier is the internal fallback and no model is called', async () => {
    const { net, claude } = upstream();
    const call = api(t, net, { env: {} });
    const { userId, token } = await signedInUser(t);
    const p = await addPerson(t, userId, { name: 'Pat Doe', title: 'Engineer', org: 'Acme' });
    await call('/research/person', token, { personId: p });
    await runTick({ db: t.db, handlers: defaultHandlers(agentConfig(net, {})) });
    const r = await call<{ dossier: { status: string; content: { confidence: string } } }>(
      '/research/get',
      token,
      {
        personId: p,
      },
    );
    expect(r.body.dossier.status).toBe('partial');
    expect(r.body.dossier.content.confidence).toBe('low');
    expect(claude.requests).toHaveLength(0);
    expect(net.calls).toHaveLength(0);
  });
});

describe('sourcing (§6)', () => {
  it('§6.8 test 1: a fundraising search merges Exa and Apollo, dedupes, ranks with reasons and stores the batch', async () => {
    const { net, claude } = upstream();
    const call = api(t, net);
    const { userId, token } = await signedInUser(t);
    const g = await call<{ goal: { id: string } }>('/goals/upsert', token, {
      goal: {
        kind: 'fundraising',
        title: 'Seed round',
        criteria: { sector: 'climate software', stage: 'seed' },
      },
    });
    const r = await call<{
      batchId: string;
      results: { id: string; name: string; source: string; rank: number; reasons: string[]; org?: string }[];
      unconfigured: string[];
    }>('/source/search', token, {
      goalId: g.body.goal.id,
      purpose: 'fundraising',
      query: 'seed climate investors',
    });
    expect(r.status).toBe(200);
    const mayas = r.body.results.filter((x) => x.name.startsWith('Maya'));
    expect(mayas).toHaveLength(1);
    expect(mayas[0]!.org).toBe('Greenfield Ventures');
    expect(r.body.results[0]!.name).toMatch(/^Maya/);
    for (let i = 1; i < r.body.results.length; i++)
      expect(r.body.results[i - 1]!.rank).toBeGreaterThanOrEqual(r.body.results[i]!.rank);
    expect(mayas[0]!.reasons).toContain('Leads seed rounds in climate');
    expect(r.body.unconfigured).toEqual([]);
    const [rec] = await t.db.sql<{ source: string; batch_id: string; goal_id: string }>`
      select source, batch_id, goal_id from orbit.recommendations where id = ${mayas[0]!.id}::uuid`;
    expect(rec!.source).toContain('exa');
    expect(rec!.source).toContain('apollo');
    expect(rec).toMatchObject({ batch_id: r.body.batchId, goal_id: g.body.goal.id });
    // fit ran on Haiku at low effort
    expect(
      claude.requests.every((q) => q.model === 'claude-haiku-5-5' && q.output_config.effort === 'low'),
    ).toBe(true);
    expect(claude.requests.length).toBeGreaterThan(0);

    // §6.8 test 2: add creates one person, one chat with the goal, one dossier job, however often it is pressed
    for (let i = 0; i < 2; i++) {
      const add = await call<{ people: { id: string; chatId: string }[] }>('/source/add', token, {
        recommendationIds: [mayas[0]!.id],
      });
      expect(add.status).toBe(200);
      expect(add.body.people).toHaveLength(1);
    }
    const people = await t.db.sql<{ id: string }>`
      select id from orbit.people where user_id = ${userId}::uuid and display_name like 'Maya%'`;
    expect(people).toHaveLength(1);
    const chats = await t.db.sql<{ stage: string; goal_id: string }>`
      select stage, goal_id from orbit.chats where user_id = ${userId}::uuid and person_id = ${people[0]!.id}::uuid`;
    expect(chats).toEqual([{ stage: 'identified', goal_id: g.body.goal.id }]);
    const jobs = await t.db.sql<{ message: { kind: string } }>`
      select message from pgmq.q_orbit_enrich where message->>'userId' = ${userId}`;
    expect(jobs.map((j) => j.message.kind)).toEqual(['enrich.dossier']);
  });

  it('§6.8 test 3: with no keys the search answers {results: [], unconfigured} without an error', async () => {
    const { net } = upstream();
    const call = api(t, net, { env: {} });
    const { token } = await signedInUser(t);
    const r = await call<{ results: unknown[]; unconfigured: string[] }>('/source/search', token, {
      purpose: 'fundraising',
      query: 'seed climate investors',
    });
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([]);
    expect(r.body.unconfigured).toEqual(['apollo', 'exa']);
    expect(net.calls).toHaveLength(0);
    expect((await call('/source/search', token, { purpose: 'nope' })).status).toBe(400);
  });

  it('marks people the user already knows, and runs as a background job too', async () => {
    const { net } = upstream();
    const call = api(t, net);
    const { userId, token } = await signedInUser(t);
    const known = await addPerson(t, userId, {
      name: 'Leo Grant',
      linkedinUrl: 'https://www.linkedin.com/in/leo-grant',
      score: 55,
    });
    const r = await call<{ results: { name: string; knownPersonId?: string; reasons: string[] }[] }>(
      '/source/search',
      token,
      {
        purpose: 'fundraising',
        query: 'climate',
      },
    );
    const leo = r.body.results.find((x) => x.name === 'Leo Grant')!;
    expect(leo.knownPersonId).toBe(known);
    expect(leo.reasons[0]).toBe('You know them (55)');
    await t.db
      .sql`select orbit.enqueue('orbit_enrich', ${JSON.stringify({ kind: 'source.search', userId, payload: { purpose: 'fundraising', query: 'climate' } })}::jsonb, 0)`;
    const before = (await t.db.sql`select 1 from orbit.recommendations where user_id = ${userId}::uuid`)
      .length;
    await runTick({ db: t.db, handlers: defaultHandlers(agentConfig(net, ALL_KEYS)) });
    const after = (await t.db.sql`select 1 from orbit.recommendations where user_id = ${userId}::uuid`)
      .length;
    expect(after).toBeGreaterThan(before);
  });
});
