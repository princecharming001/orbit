/**
 * Web sourcing (plan 31) through the API: a research ask that names a school reads that school's faculty page, lists
 * the people on it with their email and what they work on, and Add makes a person whose facts carry that context.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebSource } from '../../functions/_shared/research/web.ts';
import {
  linksFor,
  pageAnchors,
  selectPages,
  webAsk,
  webQueries,
} from '../../functions/_shared/sourcing/web.ts';
import {
  ALL_KEYS,
  type AnthropicRequest,
  agentConfig,
  anthropic,
  api,
  fakeNet,
  signedInUser,
  systemText,
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

const FACULTY_PAGE = {
  url: 'https://bioeng.berkeley.edu/faculty',
  title: 'Faculty | Bioengineering at Berkeley',
  text: [
    'Faculty. Department of Bioengineering, University of California, Berkeley.',
    'Jane Doe, Professor of Bioengineering. jdoe@berkeley.edu. Research: tissue engineering, organoids, stem cell niches. Doe Lab: https://doelab.berkeley.edu',
    'Raj Patel, Associate Professor. rpatel [at] berkeley.edu. Research: biomedical imaging, optical microscopy for surgery.',
    'Maria Lopez, Department Manager. mlopez@berkeley.edu.',
    'Footer. Apply now. Courses. Events.',
  ].join('\n'),
};

function readAnswer(r: AnthropicRequest) {
  const u = userText(r);
  if (!u.includes('bioeng.berkeley.edu/faculty')) return { people: [] };
  return {
    people: [
      {
        name: 'Jane Doe',
        title: 'Professor of Bioengineering',
        department: 'Bioengineering',
        email: 'jdoe@berkeley.edu',
        works_on: ['tissue engineering', 'organoids', 'stem cell niches'],
        lab_url: 'https://doelab.berkeley.edu',
        note: null,
      },
      {
        name: 'Raj Patel',
        title: 'Associate Professor',
        department: 'Bioengineering',
        email: null,
        works_on: [],
        lab_url: null,
        note: null,
      },
    ],
  };
}

/** The reader on Raj's own profile page: his email as the page writes it, and his research. */
function profileAnswer(r: AnthropicRequest) {
  const u = userText(r);
  if (!u.includes('bioeng.berkeley.edu/people/raj-patel')) return { people: [] };
  return {
    people: [
      {
        name: 'Raj Patel',
        title: 'Associate Professor of Bioengineering',
        department: 'Bioengineering',
        email: 'rpatel [at] berkeley.edu',
        works_on: ['biomedical imaging', 'optical microscopy for surgery'],
        lab_url: null,
        note: 'Teaches BioE 101, Instrumentation in Biology and Medicine',
      },
    ],
  };
}

const DIRECTORY_HTML = `<html><head><title>Faculty | Bioengineering at Berkeley</title></head><body>
<h1>Faculty</h1>
<ul>
<li><a href="/people/jane-doe">Jane Doe</a> Professor of Bioengineering <a href="mailto:jdoe@berkeley.edu">email</a></li>
<li><a href="/people/raj-patel">Raj Patel</a> Associate Professor</li>
<li><a href="/people/maria-lopez">Maria Lopez</a> Department Manager</li>
</ul></body></html>`;

const PROFILE_HTML = `<html><head><title>Raj Patel | Bioengineering</title></head><body>
<h1>Raj Patel</h1><p>Associate Professor of Bioengineering. Email: rpatel [at] berkeley.edu</p>
<p>Research: biomedical imaging, optical microscopy for surgery. Teaches BioE 101, Instrumentation in Biology and Medicine.</p>
<p>${'More about the lab. '.repeat(20)}</p></body></html>`;

const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
const pages = (c: { url: string }) =>
  c.url === FACULTY_PAGE.url
    ? html(DIRECTORY_HTML)
    : c.url === 'https://bioeng.berkeley.edu/people/raj-patel'
      ? html(PROFILE_HTML)
      : undefined;

function fitAnswer(r: AnthropicRequest) {
  const block = userText(r).split('<candidates>')[1]!.split('</candidates>')[0]!;
  const cands = block
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as { id: string; name: string; evidence?: string[] });
  return {
    scores: cands.map((c) => ({
      id: c.id,
      fit: /doe/i.test(c.name) ? 0.9 : 0.6,
      reasons: c.evidence?.length ? [c.evidence[0]!] : ['On the department page'],
    })),
  };
}

/** A web that answers every search with the faculty page, as Exa or Claude would after the cache. */
const fakeWeb = (): WebSource & { plans: unknown[] } => {
  const plans: unknown[] = [];
  return {
    name: 'exa',
    plans,
    estimateUsd: () => 0.02,
    async gather(plan, ctx) {
      plans.push(plan);
      const hits = plan.queries.map((q) => ({
        url: FACULTY_PAGE.url,
        title: FACULTY_PAGE.title,
        query: q.query,
      }));
      const want = ctx.select(hits);
      return {
        hits,
        pages: want.includes(FACULTY_PAGE.url) ? [FACULTY_PAGE] : [],
        costUsd: 0.02,
        notes: [],
        steps: [],
      };
    },
  };
};

describe('the ask', () => {
  it('reads the place and the subject from filters or from the words', () => {
    expect(
      webAsk({
        id: null,
        kind: 'collaboration',
        title: 'biomed research',
        criteria: [],
        topic: 'biomed research',
        school: 'UC Berkeley',
      }),
    ).toEqual({ place: 'UC Berkeley', subject: 'biomed research', role: undefined });
    const a = webAsk({
      id: null,
      kind: 'collaboration',
      title: 'professors i can reach out to for biomed research at berkeley',
      criteria: [],
      topic: 'professors i can reach out to for biomed research at berkeley',
    });
    expect(a?.place).toBe('berkeley');
    expect(a?.subject).toBe('for biomed research'.replace(/^for /, ''));
    expect(a?.role).toBe('professors');
    // no place named: the web is not searched for the whole world
    expect(
      webAsk({
        id: null,
        kind: 'advice',
        title: 'mentors in fintech',
        criteria: [],
        topic: 'mentors in fintech',
      }),
    ).toBeUndefined();
  });

  it('builds a few directory-style searches and prefers the place’s own pages', () => {
    const ask = { place: 'UC Berkeley', subject: 'biomedical research', role: 'professors' };
    const qs = webQueries(ask);
    expect(qs.length).toBeGreaterThanOrEqual(3);
    expect(qs[0]!.query).toBe('UC Berkeley biomedical research faculty');
    const picked = selectPages(
      [
        { url: 'https://en.wikipedia.org/wiki/UC_Berkeley', title: 'UC Berkeley', query: 'q' },
        { url: 'https://news.berkeley.edu/2026/story', title: 'News', query: 'q' },
        { url: 'https://bioeng.berkeley.edu/faculty', title: 'Faculty | Bioengineering', query: 'q' },
        { url: 'https://www.linkedin.com/in/someone', title: 'Someone', query: 'q' },
        { url: 'https://doelab.berkeley.edu/people', title: 'People - Doe Lab', query: 'q' },
      ],
      ask,
    );
    expect(picked[0]).toBe('https://bioeng.berkeley.edu/faculty');
    expect(picked).toContain('https://doelab.berkeley.edu/people');
    expect(picked.join(' ')).not.toMatch(/wikipedia|linkedin/);
  });
});

describe('the directory page\u2019s own links', () => {
  it('finds each person\u2019s profile link and mailto', () => {
    const anchors = pageAnchors(DIRECTORY_HTML, FACULTY_PAGE.url);
    const links = linksFor(
      anchors,
      [{ name: 'Jane Doe' }, { name: 'Raj Patel' }, { name: 'Nobody Here' }],
      FACULTY_PAGE.url,
    );
    expect(links.get('Jane Doe')).toEqual({
      profile: 'https://bioeng.berkeley.edu/people/jane-doe',
      email: 'jdoe@berkeley.edu',
    });
    expect(links.get('Raj Patel')).toEqual({ profile: 'https://bioeng.berkeley.edu/people/raj-patel' });
    expect(links.has('Nobody Here')).toBe(false);
  });
});

describe('POST /source/search with a school', () => {
  it('lists the professors on the faculty page with email and context, and Add keeps both', async () => {
    const claude = anthropic((r) =>
      systemText(r).includes('list the people it names')
        ? userText(r).includes('<person>')
          ? profileAnswer(r)
          : readAnswer(r)
        : fitAnswer(r),
    );
    const net = fakeNet(claude.answer, pages);
    const web = fakeWeb();
    const env = {
      ...ALL_KEYS,
      exaKey: undefined,
      apolloKey: undefined,
      unipileKey: undefined,
      semanticScholarKey: undefined,
    };
    const call = api(t, net, { env, agent: { ...agentConfig(net, env), web: [web] } });
    const { userId, token } = await signedInUser(t, { firstName: 'Ana' });

    const r = await call<{
      results: {
        id: string;
        name: string;
        title?: string;
        org?: string;
        email?: string;
        url?: string;
        evidence?: string[];
        source: string;
        reasons: string[];
      }[];
      unconfigured: string[];
      notes?: string[];
    }>('/source/search', token, {
      purpose: 'collaboration',
      query: 'professors I can reach out to for biomed research',
      filters: { schools: ['UC Berkeley'], keywords: ['biomedical research'] },
    });
    expect(r.status).toBe(200);
    const names = r.body.results.map((c) => c.name);
    expect(names).toEqual(['Jane Doe', 'Raj Patel']);
    const jane = r.body.results[0]!;
    expect(jane).toMatchObject({
      title: 'Professor of Bioengineering',
      org: 'Bioengineering, UC Berkeley',
      email: 'jdoe@berkeley.edu',
      url: FACULTY_PAGE.url,
      source: 'web',
    });
    expect(jane.evidence?.[0]).toBe('Works on tissue engineering, organoids, stem cell niches');
    expect(jane.evidence).toContain('Lab page: https://doelab.berkeley.edu');
    // Raj had no email on the directory: his profile page, linked there, gave it (as written, then cleaned) and his
    // research; the manager was not listed by the reader
    const raj = r.body.results[1]!;
    expect(raj.email).toBe('rpatel@berkeley.edu');
    expect(raj.url).toBe('https://bioeng.berkeley.edu/people/raj-patel');
    expect(raj.evidence?.[0]).toBe('Works on biomedical imaging, optical microscopy for surgery');
    expect(raj.evidence).toContain('Teaches BioE 101, Instrumentation in Biology and Medicine');
    expect(r.body.notes).toEqual(['web: searched 4 hits, read 1 pages', 'web: read 1 profile pages']);
    expect(r.body.unconfigured).not.toContain('web');
    // the reader saw the page text, and fit saw the evidence
    expect(claude.requests.some((q) => userText(q).includes('jdoe@berkeley.edu'))).toBe(true);
    expect(claude.requests.some((q) => userText(q).includes('"evidence"'))).toBe(true);
    // the web spend is in the ledger
    const [spend] = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.usage_ledger where user_id = ${userId}::uuid and operation = 'sourcing_web'`;
    expect(spend!.n).toBe(1);

    const added = await call<{ people: { id: string; displayName: string }[] }>('/source/add', token, {
      recommendationIds: [jane.id],
    });
    expect(added.status).toBe(200);
    const pid = added.body.people[0]!.id;
    const [p] = await t.db.sql<{
      primary_email: string | null;
      title: string | null;
      org_raw: string | null;
    }>`
      select primary_email, title, org_raw from orbit.people where id = ${pid}::uuid`;
    expect(p).toMatchObject({ primary_email: 'jdoe@berkeley.edu', title: 'Professor of Bioengineering' });
    const facts = await t.db.sql<{ type: string; text: string }>`
      select type, text from orbit.facts where person_id = ${pid}::uuid order by created_at`;
    expect(facts.map((f) => f.type)).toEqual(['sourced', 'sourced', 'sourced']);
    const texts = facts.map((f) => f.text);
    expect(texts.some((x) => /^Works on tissue engineering/.test(x))).toBe(true);
    expect(texts.some((x) => /^Lab page: https:\/\/doelab/.test(x))).toBe(true);
    expect(texts.some((x) => /^Listed on Faculty/.test(x))).toBe(true);
  });

  it("an ask that names no place searches the student's school for advice, and by subject alone last for the rest", async () => {
    const claude = anthropic((r) =>
      systemText(r).includes('list the people it names') ? readAnswer(r) : fitAnswer(r),
    );
    const net = fakeNet(claude.answer);
    const web = fakeWeb();
    const env = {
      ...ALL_KEYS,
      exaKey: undefined,
      apolloKey: undefined,
      unipileKey: undefined,
      semanticScholarKey: undefined,
    };
    const call = api(t, net, { env, agent: { ...agentConfig(net, env), web: [web] } });
    const { token } = await signedInUser(t);
    const r = await call<{ results: unknown[]; assumedPlace?: string; relaxed: string[] }>(
      '/source/search',
      token,
      { purpose: 'advice', query: 'mentors in fintech' },
    );
    expect(r.status).toBe(200);
    expect(r.body.assumedPlace).toBe('Stanford');
    expect(r.body.relaxed).not.toContain('place');
    expect(web.plans).toHaveLength(1);
    const first = web.plans[0] as { queries: { query: string }[] };
    expect(first.queries[0]!.query).toMatch(/^Stanford /);
    // fundraising has no school to stand in: the web is searched by the subject alone, and only because nothing
    // else found anyone
    const r2 = await call<{ results: unknown[]; assumedPlace?: string; relaxed: string[] }>(
      '/source/search',
      token,
      { purpose: 'fundraising', query: 'seed climate investors' },
    );
    expect(r2.status).toBe(200);
    expect(r2.body.assumedPlace).toBeUndefined();
    expect(r2.body.relaxed).toContain('place');
    expect(web.plans).toHaveLength(2);
    const second = web.plans[1] as { queries: { query: string }[] };
    const qs = second.queries.map((q) => q.query).join(' | ');
    expect(qs).toContain('seed climate investors');
    expect(qs).not.toMatch(/Stanford/);
  });
});
