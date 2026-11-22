/**
 * Find people, on the server: the filters of a search build its queries and are checked on every person found; a
 * person's profile as the web search returns it is read into a title, a company, a headline, the places they worked
 * and studied; and each row says the way in (someone the student is connected to at their company, LinkedIn's second
 * degree, a shared school).
 *
 * Everyone here is made up.
 */
import type { SourceSearchResponse } from '@orbit/core/server/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanTitle,
  describePeople,
  filterChecks,
  leadJob,
  linkedInKeywords,
  peopleQueries,
  readExaPerson,
} from '../../functions/_shared/sourcing/people.ts';
import { askedChecks, PEOPLE_RESULTS } from '../../functions/_shared/sourcing/search.ts';
import { connectionsByOrg, orgBase, realOrg, warmthOf } from '../../functions/_shared/sourcing/warmth.ts';
import { needsOf } from '../../functions/orbit-api/routes/source.ts';
import {
  ALL_KEYS,
  type AnthropicRequest,
  addPerson,
  anthropic,
  api,
  fakeNet,
  jsonRes,
  type NetCall,
  signedInUser,
  UNIPILE,
  userText,
} from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

// ---- a profile as the web search returns it ------------------------------------------------------------------------

interface Work {
  title: string;
  org: string;
  from?: string | null;
  to?: string | null;
  location?: string;
}

function profile(
  name: string,
  work: Work[],
  o: { schools?: [string, string?][]; location?: string; text?: string; slug?: string; image?: string } = {},
) {
  const [firstName, ...rest] = name.split(' ');
  return {
    id: `https://linkedin.com/in/${o.slug ?? name.toLowerCase().replace(/\s+/g, '-')}`,
    url: `https://linkedin.com/in/${o.slug ?? name.toLowerCase().replace(/\s+/g, '-')}`,
    title: name,
    ...(o.image ? { image: o.image } : {}),
    highlights: [o.text ?? ''],
    entities: [
      {
        id: `https://exa.ai/library/person/${name.length}`,
        type: 'person',
        version: 1,
        properties: {
          name,
          firstName,
          lastName: rest.join(' '),
          location: o.location ?? null,
          workHistory: work.map((w) => ({
            title: w.title,
            company: { id: 'x', name: w.org },
            location: w.location ?? null,
            dates:
              w.from === undefined && w.to === undefined ? null : { from: w.from ?? null, to: w.to ?? null },
          })),
          educationHistory: (o.schools ?? []).flatMap(([school, degree]) => {
            const e = { institution: { id: 'x', name: school }, degree: degree ?? null, dates: null };
            // the index lists a school twice as often as not
            return [e, e];
          }),
        },
      },
    ],
  };
}

const MAYA = profile(
  'Maya Okafor',
  [
    { title: 'Managing Partner', org: 'Harbor Collective', from: '2012-01-01', to: null },
    { title: 'Visiting Lecturer', org: 'Lakeview Tech', from: '2024-01-01', to: null },
    { title: 'Board Observer', org: 'Tidepool Labs', from: '2025-01-01', to: null },
    { title: 'Associate', org: 'Bainbridge & Company', from: '2008-01-01', to: '2012-01-01' },
  ],
  {
    schools: [['University of California, Berkeley', 'BA Economics']],
    location: 'San Francisco, California, United States',
    text: '# Maya Okafor\n\nSeed investor. First cheques into developer tools.\n\nSan Francisco, California, United States (US)\n\n...\n\n## About\n\nI back founders at the very start. Reach out if you are building tools for engineers.\n\n### Managing Partner - [Harbor Collective](https://www.linkedin.com/company/harbor) (Current)',
    image: 'https://media.licdn.com/dms/image/maya.jpg',
  },
);
const TOMAS = profile(
  'Tomas Lindqvist',
  [
    { title: 'Investor - Northwind Ventures', org: 'Northwind Ventures', from: '2020-01-01', to: null },
    { title: 'Analyst', org: 'Bainbridge & Company', from: '2017-01-01', to: '2020-01-01' },
  ],
  { schools: [['Santa Rosa University', 'BS Finance']], location: 'London, England, United Kingdom' },
);
const PRIYA = profile(
  'Priya Venkataraman',
  [{ title: 'Senior Software Engineer', org: 'Stripe', from: '2021-01-01', to: null }],
  {
    schools: [['Stanford University', 'MS Computer Science']],
    location: 'New York, New York, United States',
  },
);
const FUND = {
  id: 'https://harborcollective.example',
  url: 'https://harborcollective.example',
  title: 'Harbor Collective',
  highlights: ['Harbor Collective is a seed fund.'],
  entities: [{ type: 'company', properties: { name: 'Harbor Collective' } }],
};

describe('a profile, read', () => {
  it('the job they list first is their job, whatever started later; the rest is where they also are and were', () => {
    const p = readExaPerson(MAYA)!;
    expect(p.name).toBe('Maya Okafor');
    expect(p.jobs.map((j) => [j.title, j.org, j.current])).toEqual([
      ['Managing Partner', 'Harbor Collective', true],
      ['Visiting Lecturer', 'Lakeview Tech', true],
      ['Board Observer', 'Tidepool Labs', true],
      ['Associate', 'Bainbridge & Company', false],
    ]);
    expect(leadJob(p.jobs)).toMatchObject({ title: 'Managing Partner', org: 'Harbor Collective' });
    expect(p.jobs[3]).toMatchObject({ from: 2008, to: 2012 });
    expect(p.location).toBe('San Francisco, California, United States');
  });

  it('the headline is the line under their name; the place under it is not one', () => {
    expect(readExaPerson(MAYA)!.headline).toBe('Seed investor. First cheques into developer tools.');
    // the text the search matched often starts lower down the page: the current job stands in
    expect(readExaPerson(TOMAS)!.headline).toBe('Investor at Northwind Ventures');
    const placeOnly = profile(
      'Ada Quist',
      [{ title: 'Designer', org: 'Figment', from: '2022-01-01', to: null }],
      {
        location: 'Austin, Texas, United States',
        text: '# Ada Quist\n\nAustin, Texas, United States (US)\n\n...',
      },
    );
    expect(readExaPerson(placeOnly)!.headline).toBe('Designer at Figment');
  });

  it('what they wrote about themselves is kept, a few lines of it, without the page marks', () => {
    expect(readExaPerson(MAYA)!.about).toBe(
      'I back founders at the very start. Reach out if you are building tools for engineers.',
    );
    expect(readExaPerson(TOMAS)!.about).toBeUndefined();
  });

  it('a school is listed once, and a title does not repeat its own company', () => {
    expect(readExaPerson(MAYA)!.schools).toEqual([
      { school: 'University of California, Berkeley', degree: 'BA Economics' },
    ]);
    expect(readExaPerson(TOMAS)!.jobs[0]).toMatchObject({ title: 'Investor', org: 'Northwind Ventures' });
    expect(cleanTitle('PM @ Stripe', 'Stripe')).toBe('PM');
    expect(cleanTitle('Stripe - Engineering Manager', 'Stripe')).toBe('Engineering Manager');
    expect(cleanTitle('Partner', 'Partner Fund')).toBe('Partner');
    expect(cleanTitle('Stripe', 'Stripe')).toBe('Stripe');
  });

  it('a profile with no dates: the first job is the one they hold; a page that is not a person is not read', () => {
    const p = readExaPerson(
      profile('Noor Haddad', [
        { title: 'Founder', org: 'Quillwork' },
        { title: 'Engineer', org: 'Oldco' },
      ]),
    )!;
    expect(p.jobs.map((j) => j.current)).toEqual([true, false]);
    expect(readExaPerson(FUND as never)).toBeUndefined();
    expect(readExaPerson({ url: 'https://x.example', title: 'A page' } as never)).toBeUndefined();
  });

  it('someone with two jobs now: the one the search asked about is the one shown', () => {
    const jobs = readExaPerson(
      profile('Sam Reyes', [
        { title: 'Co-Founder', org: 'Commonplace', from: '2019-01-01', to: null },
        { title: 'Developer Advocate', org: 'OpenAI', from: '2023-01-01', to: null },
      ]),
    )!.jobs;
    expect(leadJob(jobs)).toMatchObject({ org: 'Commonplace' });
    expect(leadJob(jobs, { currentOrgs: ['OpenAI'] })).toMatchObject({
      org: 'OpenAI',
      title: 'Developer Advocate',
    });
    expect(leadJob(jobs, { titles: ['developer advocate'] })).toMatchObject({ org: 'OpenAI' });
    // the first listed already is what was asked: it stays
    expect(leadJob(jobs, { titles: ['co-founder', 'developer advocate'] })).toMatchObject({
      org: 'Commonplace',
    });
  });
});

// ---- the filters as queries and as statements ---------------------------------------------------------------------

describe('the filters of a search', () => {
  it('read as one sentence a profile index can match', () => {
    expect(
      describePeople({ titles: ['investor', 'partner', 'principal'], keywords: ['venture capital'] }),
    ).toBe('investor, partner or principal working on venture capital');
    expect(
      describePeople({ titles: ['product manager'], currentOrgs: ['Google'], schools: ['UC Berkeley'] }),
    ).toBe('product manager at Google who studied at UC Berkeley');
    expect(describePeople({ everOrgs: ['McKinsey & Company'], keywords: ['startup'] })).toBe(
      'people who worked at McKinsey & Company working on startup',
    );
    expect(describePeople({ places: ['London'] })).toBe('people based in London');
    expect(describePeople({ titles: ['investor'], places: ['London'] }, { place: true })).toBe('investor');
    // a title says its own level
    expect(describePeople({ titles: ['vp of engineering'], seniority: ['vp'] })).toBe('vp of engineering');
    expect(describePeople({ seniority: ['vp'], currentOrgs: ['Stripe'] })).toBe(
      'vice president people at Stripe',
    );
    expect(describePeople({})).toBe('');
  });

  it('give at most three queries: the filters, the sentence when it says more, one a company when several', () => {
    const q = (ask: string, f: Parameters<typeof peopleQueries>[1]) => peopleQueries(ask, f);
    expect(
      q('investors at venture capital firms', { titles: ['investor', 'partner'], places: ['London'] }),
    ).toEqual(['investor or partner based in London', 'investors at venture capital firms in London']);
    // the sentence already names the place and the school, in its own words
    expect(
      q('VPs of engineering at fintech companies in NYC', {
        titles: ['vp of engineering'],
        places: ['New York'],
        keywords: ['fintech'],
      })[1],
    ).toBe('VPs of engineering at fintech companies in NYC');
    expect(
      q('Berkeley Haas MBAs in product management', {
        titles: ['product manager'],
        schools: ['UC Berkeley Haas School of Business'],
      })[1],
    ).toBe('Berkeley Haas MBAs in product management');
    // a bare title finds anyone with it: the sentence goes alone
    expect(q('founders who also invest', { titles: ['founder'] })).toEqual(['founders who also invest']);
    // the sentence says nothing the filters do not
    expect(
      q('software engineers at Stripe', { titles: ['software engineer'], currentOrgs: ['Stripe'] }),
    ).toEqual(['software engineer at Stripe']);
    expect(
      q('recruiters at Anthropic or OpenAI', {
        titles: ['recruiter'],
        currentOrgs: ['Anthropic', 'OpenAI', 'Cohere', 'Mistral'],
      }),
    ).toEqual(['recruiter at Anthropic', 'recruiter at OpenAI', 'recruiter at Cohere']);
    expect(q('', {})).toEqual([]);
    expect(q('people who know about batteries', {})).toEqual(['people who know about batteries']);
    for (const list of [q('x'.repeat(900), { titles: ['a'] })])
      for (const one of list) expect(one.length).toBeLessThanOrEqual(300);
  });

  it('LinkedIn takes the titles as alternatives; companies, schools and places go in its own fields', () => {
    expect(linkedInKeywords('x', { titles: ['investor', 'general partner'], keywords: ['seed'] })).toBe(
      '(investor OR "general partner") seed',
    );
    expect(linkedInKeywords('x', { titles: ['recruiter'] })).toBe('recruiter');
    expect(linkedInKeywords('people at Stripe', { currentOrgs: ['Stripe'] })).toBeUndefined();
    expect(linkedInKeywords('battery people', {})).toBe('battery people');
    expect(linkedInKeywords('', {})).toBeUndefined();
  });

  it('are each a statement every person found is checked against: must by default, nice where the student said so', () => {
    const checks = filterChecks({
      titles: ['investor', 'partner'],
      seniority: ['vp'],
      currentOrgs: ['Stripe', 'Plaid'],
      everOrgs: ['Bain'],
      schools: ['UC Berkeley'],
      places: ['London'],
      keywords: ['fintech'],
      placesNeed: 'nice',
      everOrgsNeed: 'nice',
    });
    expect(checks.map((c) => [c.key, c.need])).toEqual([
      ['role', 'must'],
      ['current', 'must'],
      ['ever', 'nice'],
      ['school', 'must'],
      ['place', 'nice'],
    ]);
    expect(checks[0]!.text).toContain('investor or partner');
    expect(checks[0]!.text).toContain('vice president level');
    expect(checks[1]!.text).toContain('Works now at Stripe or Plaid');
    expect(checks[3]!.text).toContain('Studied at UC Berkeley');
    // keywords only rank unless the student made them a must
    expect(filterChecks({ keywords: ['fintech'] })).toEqual([]);
    expect(filterChecks({ keywords: ['fintech'], keywordsNeed: 'must' }).map((c) => c.key)).toEqual([
      'keywords',
    ]);
    expect(filterChecks({})).toEqual([]);
    for (const c of checks) expect(c.text).not.toMatch(/[—!]/);
  });

  it('come before the criteria the student wrote, and only in a people search', () => {
    const base = { id: null, kind: 'advice' as const, title: 'x', criteria: [] };
    const filters = { titles: ['investor'] };
    const checks = [{ text: 'Invests at seed', need: 'must' as const }];
    expect(
      askedChecks({ ...base, peopleOnly: true, filters, checks }).map((c) => c.filter ?? 'criterion'),
    ).toEqual(['role', 'criterion']);
    expect(askedChecks({ ...base, filters, checks }).map((c) => c.filter ?? 'criterion')).toEqual([
      'criterion',
    ]);
  });

  it('the request says which filters only rank, and nothing else', () => {
    expect(needsOf(undefined)).toBeUndefined();
    expect(needsOf({ role: 'nice', keywords: 'must' })).toEqual({ role: 'nice', keywords: 'must' });
    expect(needsOf({ other: 'nice' })).toBeUndefined();
    expect(() => needsOf({ role: 'maybe' })).toThrow();
    expect(() => needsOf(['nice'])).toThrow();
  });
});

// ---- the way in -----------------------------------------------------------------------------------------------------

describe('the way in to someone found', () => {
  const student = { school: 'University of California, Berkeley', orgs: [], interests: [] };
  const cand = (over: Record<string, unknown>) =>
    ({
      key: 'c1',
      entity: 'person',
      name: 'Ada Quist',
      firstName: 'Ada',
      sources: ['exa'],
      externalIds: {},
      ...over,
    }) as never;

  it('someone the student is connected to at their company, close or not, is a person to ask', () => {
    const connections = connectionsByOrg([
      { personId: 'p1', name: 'Kai Brandt', score: 12, org: 'Figment' },
      { personId: 'p2', name: 'Lena Ortiz', score: 30, org: 'Figment Labs' },
      { personId: 'p3', name: 'Omar Said', score: 90, org: 'Elsewhere' },
    ]);
    const w = warmthOf(cand({ title: 'Designer', org: 'Figment' }), {
      student,
      warm: [],
      connections,
      year: 2026,
    });
    expect(w).toMatchObject({
      tier: 2,
      weak: true,
      bridge: { personId: 'p2', name: 'Lena Ortiz', score: 30 },
      // where she works, as she writes it
      why: 'Lena, a connection of yours, works at Figment Labs',
    });
    expect(w.why).not.toMatch(/[—!]/);
    // nobody there: no way in through a connection
    expect(warmthOf(cand({ org: 'Nowhere Inc' }), { student, warm: [], connections, year: 2026 }).tier).toBe(
      5,
    );
  });

  it('a placeholder where a company would be is not a company: two people in "stealth" do not work together', () => {
    const connections = connectionsByOrg([
      { personId: 'p1', name: 'Kai Brandt', score: 67, org: 'Stealth AI Startup' },
      { personId: 'p2', name: 'Lena Ortiz', score: 80, org: 'Self-employed' },
      { personId: 'p3', name: 'Omar Said', score: 90, org: 'Various Companies' },
    ]);
    expect(connections.size).toBe(0);
    const warm = [{ personId: 'p1', name: 'Kai Brandt', score: 67, org: 'Stealth AI Startup' }];
    for (const org of [
      'Stealth AI Startup',
      'Stealth Startup',
      'stealth',
      'Self-employed',
      'Various Companies',
      'Startup',
    ])
      expect([
        org,
        warmthOf(cand({ title: 'Founder', org }), { student, warm, connections, year: 2026 }).tier,
      ]).toEqual([org, 5]);
    for (const [name, real] of [
      ['Stealth AI Startup', false],
      ['Stealth', false],
      ['a startup', false],
      ['Freelance', false],
      ['N/A', false],
      ['Stripe', true],
      ['Startup Grind', true],
      ['Venture Forward', true],
      ['The Trade Desk', true],
      ['Student Loan Hero', true],
      ['Independent Sector', true],
    ] as const)
      expect([name, realOrg(name)]).toEqual([name, real]);
  });

  it('a close contact there comes first, and the sentence names the company as they write it', () => {
    const warm = [{ personId: 'p9', name: 'Nisha Rao', score: 78, org: 'Google' }];
    const connections = connectionsByOrg([
      ...warm,
      { personId: 'p1', name: 'Kai Brandt', score: 12, org: 'Google' },
    ]);
    const w = warmthOf(cand({ title: 'Investor', org: 'GV (Google Ventures)' }), {
      student,
      warm,
      connections,
      year: 2026,
    });
    expect(w).toMatchObject({ tier: 2, bridge: { personId: 'p9', score: 78 } });
    expect(w.weak).toBeUndefined();
    expect(w.why).toBe('Nisha is close to you and also at Google, so ask for an intro');
  });

  it('a school in their profile is where they studied: the same school is shared background', () => {
    expect(
      warmthOf(cand({ org: 'Figment', schools: ['University of California, Berkeley'] }), {
        student,
        warm: [],
        year: 2026,
      }),
    ).toMatchObject({ tier: 3, why: 'Also from UC Berkeley' });
    // a city of the same name in where they live is not a school
    expect(
      warmthOf(cand({ org: 'Figment', location: 'Berkeley, California' }), { student, warm: [], year: 2026 })
        .tier,
    ).toBe(5);
    expect(
      warmthOf(cand({ org: 'Figment', schools: ['Stanford University'] }), { student, warm: [], year: 2026 })
        .tier,
    ).toBe(5);
  });

  it('a company they left counts when the student worked there too', () => {
    const w = warmthOf(
      cand({
        org: 'Figment',
        history: [
          { title: 'PM', org: 'Ramp', current: false },
          { title: 'Designer', org: 'Figment', current: true },
        ],
      }),
      { student: { ...student, orgs: ['Ramp'] }, warm: [], year: 2026 },
    );
    expect(w).toMatchObject({ tier: 3, why: 'Also worked at Ramp' });
  });

  it('companies are matched by their name without the words that only qualify it', () => {
    expect(orgBase('Stripe Labs')).toBe('stripe');
    expect(orgBase('Northwind Ventures')).toBe('northwind');
    expect(orgBase('Capital')).toBe('capital');
  });
});

// ---- the whole search ----------------------------------------------------------------------------------------------

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

/** The reader: answers each numbered check from the candidate's own fields, the way the model is asked to. */
function reader() {
  return anthropic((req: AnthropicRequest) => {
    const text = userText(req);
    const checks = [
      ...(text.match(/<checks>([\s\S]*?)<\/checks>/)?.[1] ?? '').matchAll(/^\d+\. (.+)$/gm),
    ].map((m) => m[1]!);
    const cands = (text.match(/<candidates>([\s\S]*?)<\/candidates>/)?.[1] ?? '')
      .split('\n')
      .filter(Boolean)
      .map(
        (l) =>
          JSON.parse(l) as {
            id: string;
            title?: string;
            org?: string;
            location?: string;
            jobs?: string[];
            schools?: string[];
          },
      );
    const answer = (c: (typeof cands)[number], check: string): 'yes' | 'no' | 'unknown' => {
      const jobs = c.jobs ?? [];
      const now = jobs.filter((j) => j.includes('to now'));
      if (check.startsWith('Their current job is')) {
        if (!c.title) return 'unknown';
        return /investor|partner/i.test(c.title) === /investor|partner/.test(check) ? 'yes' : 'no';
      }
      if (check.startsWith('Works now at')) {
        if (!jobs.length) return 'unknown';
        return now.some((j) => /Stripe/.test(j)) && /Stripe/.test(check) ? 'yes' : 'no';
      }
      if (check.startsWith('Works or has worked at')) {
        if (!jobs.length) return 'unknown';
        return jobs.some((j) => /Bainbridge/.test(j)) ? 'yes' : 'no';
      }
      if (check.startsWith('Studied at')) {
        if (!c.schools?.length) return 'unknown';
        return c.schools.some((s) => /Berkeley/.test(s)) ? 'yes' : 'no';
      }
      if (check.startsWith('Is based in')) {
        if (!c.location) return 'unknown';
        return /London/.test(c.location) ? 'yes' : 'no';
      }
      return 'unknown';
    };
    return {
      scores: cands.map((c) => ({
        id: c.id,
        fit: 0.8,
        reasons: ['fits'],
        checks: checks.map((k) => answer(c, k)),
      })),
    };
  });
}

async function setup(o: { linkedin?: unknown[] } = {}) {
  const claude = reader();
  const exa: Record<string, unknown>[] = [];
  const li: NetCall[] = [];
  const net = fakeNet(claude.answer, (c) => {
    if (c.url.startsWith('https://api.exa.ai/search')) {
      exa.push(c.body as Record<string, unknown>);
      return jsonRes(200, { results: [MAYA, TOMAS, PRIYA, FUND], costDollars: { total: 0.02 } });
    }
    if (c.url.startsWith(`${UNIPILE}/api/v1/linkedin/search/parameters`))
      return jsonRes(200, {
        items: [{ id: `id:${new URL(c.url).searchParams.get('keywords')}`, title: 'x' }],
      });
    if (c.url.startsWith(`${UNIPILE}/api/v1/linkedin/search`)) {
      li.push(c);
      return jsonRes(200, { items: o.linkedin ?? [] });
    }
    if (c.url.startsWith(`${UNIPILE}/api/v1/users/me`)) return jsonRes(200, {});
    return undefined;
  });
  const call = api(t, net, { env: { ...ALL_KEYS, apolloKey: undefined, villageKey: undefined } });
  const { userId, token } = await signedInUser(t);
  await t.db
    .sql`update orbit.users set school = 'University of California, Berkeley' where id = ${userId}::uuid`;
  await t.db.sql`insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
    values (${userId}::uuid, 'linkedin', 'acc-li', 'active')`;
  const search = (body: Record<string, unknown>) =>
    call<SourceSearchResponse>('/source/search', token, {
      purpose: 'fundraising',
      peopleOnly: true,
      ...body,
    });
  return { search, exa, li, userId, claude };
}

describe('POST /source/search, a people search', () => {
  it('asks the profile index with the filters as sentences, and LinkedIn for people one connection away, once', async () => {
    const s = await setup();
    const r = await s.search({
      query: 'investors at venture capital firms',
      filters: { titles: ['investor', 'partner'], locations: ['London'] },
    });
    expect(r.status).toBe(200);
    expect(s.exa.map((b) => b.query)).toEqual([
      'investor or partner based in London',
      'investors at venture capital firms in London',
    ]);
    for (const b of s.exa) expect(b).toMatchObject({ category: 'people', numResults: PEOPLE_RESULTS });
    expect(s.li).toHaveLength(1);
    expect(s.li[0]!.body).toMatchObject({
      api: 'classic',
      category: 'people',
      keywords: '(investor OR partner)',
      network_distance: [2],
      location: ['id:London'],
    });
    // nothing is said about a provider the search does not need
    expect(r.body.unconfigured).toEqual([]);
  });

  it('a row has their title, company, headline, schools and past companies, and a fund is not a person', async () => {
    const s = await setup();
    const r = await s.search({ query: 'investors', filters: { titles: ['investor', 'partner'] } });
    const maya = r.body.results.find((x) => x.name === 'Maya Okafor')!;
    expect(maya).toMatchObject({
      title: 'Managing Partner',
      org: 'Harbor Collective',
      headline: 'Seed investor. First cheques into developer tools.',
      location: 'San Francisco, California, United States',
      schools: ['University of California, Berkeley'],
      pastOrgs: ['Bainbridge & Company'],
      photoUrl: 'https://media.licdn.com/dms/image/maya.jpg',
      linkedinUrl: 'https://www.linkedin.com/in/maya-okafor',
    });
    expect(r.body.results.find((x) => x.name === 'Tomas Lindqvist')).toMatchObject({
      title: 'Investor',
      org: 'Northwind Ventures',
      headline: 'Investor at Northwind Ventures',
    });
    expect(r.body.results.map((x) => x.name)).not.toContain('Harbor Collective');
  });

  it('a filter is kept to: someone the profile says does not meet it is left out, and each row says which were met', async () => {
    const s = await setup();
    const role = await s.search({ query: 'investors', filters: { titles: ['investor', 'partner'] } });
    // Priya is an engineer
    expect(role.body.results.map((x) => x.name).sort()).toEqual(['Maya Okafor', 'Tomas Lindqvist']);
    expect(role.body.results[0]!.checks).toEqual([
      expect.objectContaining({ filter: 'role', need: 'must', answer: 'yes' }),
    ]);

    const london = await s.search({
      query: 'investors',
      filters: { titles: ['investor'], locations: ['London'] },
    });
    expect(london.body.results.map((x) => x.name)).toEqual(['Tomas Lindqvist']);

    const berkeley = await s.search({
      query: 'investors',
      filters: { titles: ['investor'], schools: ['UC Berkeley'] },
    });
    expect(berkeley.body.results.map((x) => x.name)).toEqual(['Maya Okafor']);

    const stripe = await s.search({
      query: 'people at Stripe',
      filters: { currentOrganizations: ['Stripe'] },
    });
    expect(stripe.body.results.map((x) => x.name)).toEqual(['Priya Venkataraman']);
    expect(stripe.body.results[0]!.checks![0]).toMatchObject({ filter: 'current', answer: 'yes' });

    const ever = await s.search({
      query: 'ex Bainbridge',
      filters: { everOrganizations: ['Bainbridge & Company'] },
    });
    expect(ever.body.results.map((x) => x.name).sort()).toEqual(['Maya Okafor', 'Tomas Lindqvist']);
  });

  it('a filter marked nice ranks instead of leaving people out', async () => {
    const s = await setup();
    const r = await s.search({
      query: 'investors',
      filters: { titles: ['investor', 'partner'], locations: ['London'], needs: { locations: 'nice' } },
    });
    expect(r.body.results.map((x) => x.name).sort()).toEqual(['Maya Okafor', 'Tomas Lindqvist']);
    const place = (name: string) =>
      r.body.results.find((x) => x.name === name)!.checks!.find((k) => k.filter === 'place')!;
    expect(place('Tomas Lindqvist')).toMatchObject({ need: 'nice', answer: 'yes' });
    expect(place('Maya Okafor')).toMatchObject({ need: 'nice', answer: 'no' });
  });

  it('the student’s own criteria are answered beside the filters, and a must-have answered no leaves them out', async () => {
    const s = await setup();
    const r = await s.search({
      query: 'investors',
      filters: { titles: ['investor', 'partner'] },
      criteria: [{ text: 'Invests at seed', need: 'nice' }],
    });
    expect(r.body.results[0]!.checks!.map((k) => k.filter ?? 'criterion')).toEqual(['role', 'criterion']);
    expect(r.body.results[0]!.checks![1]).toMatchObject({ text: 'Invests at seed', answer: 'unknown' });
  });

  it('the reader is given where they work, worked and studied', async () => {
    const s = await setup();
    await s.search({ query: 'investors', filters: { titles: ['investor'] } });
    const text = userText(s.claude.requests[0]!);
    expect(text).toContain('"jobs":["Managing Partner at Harbor Collective (2012 to now)"');
    expect(text).toContain('"Associate at Bainbridge & Company (2008 to 2012)"');
    expect(text).toContain('"schools":["University of California, Berkeley"]');
    expect(text).toContain('1. Their current job is investor, or another wording of the same kind of work');
  });

  it('the way in: a connection at their company, a shared school, and LinkedIn’s second degree', async () => {
    const s = await setup({
      linkedin: [
        {
          type: 'PEOPLE',
          id: 'ACoAAfake1',
          name: 'Jonah Feld',
          headline: 'Partner at Greywater Capital',
          location: 'London, England, United Kingdom',
          network_distance: 'DISTANCE_2',
          public_identifier: 'jonah-feld',
        },
      ],
    });
    // someone the student is connected to and has never talked to, who works where Tomas does
    await addPerson(t, s.userId, { name: 'Wren Abara', org: 'Northwind Ventures', score: 9 });
    const r = await s.search({ query: 'investors', filters: { titles: ['investor', 'partner'] } });
    const by = (name: string) => r.body.results.find((x) => x.name === name)!;
    expect(by('Tomas Lindqvist')).toMatchObject({
      tier: 2,
      bridgeWeak: true,
      bridge: { name: 'Wren Abara', score: 9 },
      why: 'Wren, a connection of yours, works at Northwind Ventures',
    });
    expect(by('Maya Okafor')).toMatchObject({ tier: 3, why: 'Also from UC Berkeley' });
    expect(by('Maya Okafor').bridge).toBeUndefined();
    expect(by('Jonah Feld')).toMatchObject({ degree: 2, title: 'Partner', org: 'Greywater Capital' });
  });

  it('a filter LinkedIn’s own search applied is met for the people it lists, whatever their headline leaves out', async () => {
    const s = await setup({
      linkedin: [
        {
          type: 'PEOPLE',
          id: 'ACoAAfake2',
          name: 'Dara Flint',
          headline: 'Building things',
          network_distance: 'DISTANCE_2',
          public_identifier: 'dara-flint',
        },
      ],
    });
    const r = await s.search({ query: 'people at Stripe', filters: { currentOrganizations: ['Stripe'] } });
    expect(s.li[0]!.body).toMatchObject({ company: ['id:Stripe'], network_distance: [2] });
    const dara = r.body.results.find((x) => x.name === 'Dara Flint')!;
    expect(dara.checks).toEqual([expect.objectContaining({ filter: 'current', answer: 'yes' })]);
  });
});
