/**
 * Plan 44, the join of the source side and the search side, on PGlite, with nothing in between faked: the real
 * readers parse the captured board shapes (Greenhouse, Ashby, Lever, Workday, the two SimplifyJobs lists), the real
 * intake keeps them (`readBoard`, `roleSources.keep`), and the real routes search them for a made-up student, read
 * each role's text on demand through `roleSources.text` (a fake network stands in for the boards) and score it (a fake
 * model answers). The two sides were each tested against a fake of the other; this is the test of both together.
 *
 * What it holds: the roles listed are open, at the student's level (or level not said), of the kinds they ticked;
 * a role listed in two cities is one row; a SimplifyJobs entry that is a board's role is listed once, from the board;
 * a role's text is read from its board once, when first read closely, and kept; every listed role is scored, thin
 * when its source gives no text; a role a board stops listing leaves the next search and stays in Saved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  RoleMatch,
  RoleProfile,
  RolesListResponse,
  RolesSearchResponse,
} from '../../../packages/core/src/roles/types.ts';
import { memoryTake } from '../../functions/_shared/ratelimit.ts';
import {
  BOARD_COLUMNS,
  type BoardRow,
  readBoard,
  upsertBoard,
} from '../../functions/_shared/roles/boards.ts';
import { readSimplify } from '../../functions/_shared/roles/readers/simplify.ts';
import { resetWorkdayPacing, roleSources } from '../../functions/_shared/roles/sources.ts';
import { createSession } from '../../functions/_shared/session.ts';
import { makeApiHandler } from '../../functions/orbit-api/api.ts';
import {
  ALL_KEYS,
  type Answer,
  APP,
  agentConfig,
  anthropic,
  BASE,
  fakeNet,
  jsonRes,
  SECRET,
  signedInUser,
} from '../helpers/agents.ts';
import { fixture } from '../helpers/fakeBoards.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';
import { fakeRolesModel, kind } from '../helpers/rolesModel.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
  resetWorkdayPacing();
});
afterAll(async () => {
  await t.pg.close();
});

const DAY1 = new Date('2026-11-24T09:30:00Z');
const DAY2 = new Date('2026-11-25T09:30:00Z');
let today = DAY1;
let ticks = 0;
/** each read of the clock is a second later, so rows made one after another have their own times */
const now = () => new Date(today.getTime() + ++ticks * 1000);

// ---- the boards, as the real services answer (the readers' own fixtures) ---------------------------------------------

type Gh = { jobs: Record<string, unknown>[] };
/** Nimbus Pay on Greenhouse: its intern role is listed in two cities, as boards list one role per city. */
function nimbusList(): Gh {
  const body = fixture<Gh>('greenhouse-list.json');
  const intern = body.jobs.find((j) => j.id === 8186367)!;
  body.jobs.push({
    ...intern,
    id: 8186368,
    location: { name: 'Dublin' },
    absolute_url: 'https://nimbuspay.example/jobs/search?gh_jid=8186368',
  });
  return body;
}
let nimbus = nimbusList();

const escaped = (html: string) => html.replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** What a role's own page says, by its title: requirements the fake model reads from "Must have X." lines. */
function postingHtml(title: string): string {
  const needs = /data|scien/i.test(title)
    ? ['Must have Python.', 'Must have SQL.', 'Must have Statistics.', 'Nice to have Spark.']
    : ['Must have Python.', 'Must have SQL.', 'Nice to have Go.'];
  return `<h2>About the role</h2><p>${title}. We build things people rely on.</p><h3>What you need</h3>${needs
    .map((n) => `<p>${n}</p>`)
    .join('')}`;
}

const boards: Answer = (c) => {
  const u = new URL(c.url);
  const path = u.pathname;
  if (u.hostname === 'boards-api.greenhouse.io') {
    if (path === '/v1/boards/nimbuspay/jobs') return jsonRes(200, nimbus);
    // the board a SimplifyJobs internship entry links to: the same role, on the company's own board
    if (path === '/v1/boards/board1/jobs')
      return jsonRes(200, {
        jobs: [
          {
            id: 4993728008,
            title: 'Data Science Intern',
            location: { name: 'New York, NY' },
            absolute_url: 'https://job-boards.greenhouse.io/board1/jobs/4993728008',
            updated_at: '2026-11-20T10:00:00-05:00',
            first_published: '2026-11-01T10:00:00-05:00',
            company_name: 'Company A',
            language: 'en',
          },
        ],
        meta: { total: 1 },
      });
    const m = /^\/v1\/boards\/([^/]+)\/jobs\/(\d+)$/.exec(path);
    if (m) {
      const listed =
        m[1] === 'nimbuspay'
          ? nimbus.jobs.find((j) => String(j.id) === m[2])
          : { title: 'Data Science Intern' };
      if (!listed) return jsonRes(404, { error: 'not found' });
      return jsonRes(200, {
        id: Number(m[2]),
        title: listed.title,
        location: { name: 'Listed place' },
        departments: [{ name: 'Engineering' }],
        content: escaped(postingHtml(String(listed.title))),
      });
    }
  }
  if (u.hostname === 'api.ashbyhq.com') return jsonRes(200, fixture('ashby-board.json'));
  if (u.hostname === 'api.lever.co') {
    // one posting by its id (a SimplifyJobs entry links to it); board14 has taken its posting down
    const one = /^\/v0\/postings\/([^/]+)\/([0-9a-f-]{36})$/.exec(path);
    if (one?.[1] === 'board14') return jsonRes(404, { ok: false, error: 'Document not found' });
    if (one)
      return jsonRes(200, {
        ...fixture<Record<string, unknown>[]>('lever-page.json')[2],
        id: one[2],
        text: 'Systems Engineering Intern',
        descriptionPlain: 'Systems Engineering Intern. Must have Python. Must have SQL. Nice to have Go.',
        lists: [],
        additionalPlain: '',
        hostedUrl: `https://jobs.lever.co/${one[1]}/${one[2]}`,
      });
    return jsonRes(200, fixture('lever-page.json'));
  }
  if (u.hostname.endsWith('.myworkdayjobs.com')) {
    if (c.method === 'POST') return jsonRes(200, fixture('workday-page.json'));
    // one role's detail: its text, and every place it is listed in
    const title = decodeURIComponent(path.split('/').pop() ?? '')
      .replace(/_JR\d+$/, '')
      .replace(/-+/g, ' ');
    return jsonRes(200, {
      jobPostingInfo: {
        title,
        jobDescription: postingHtml(title),
        location: 'Israel, Raanana',
        additionalLocations: ['Israel, Tel Aviv'],
        postedOn: 'Posted Today',
        timeType: 'Full time',
      },
      hiringOrganization: { name: 'Lumen' },
    });
  }
  if (u.hostname === 'raw.githubusercontent.com')
    return jsonRes(
      200,
      fixture(path.includes('Internships') ? 'simplify-intern.json' : 'simplify-newgrad.json'),
    );
  if (u.hostname === 'api.anthropic.com') return undefined;
  // every other site a SimplifyJobs entry links to: a careers page with no posting Orbit can read
  return new Response('<html><body><h1>Careers</h1><p>Sign in to see this role.</p></body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
};

const claude = anthropic(fakeRolesModel());
const net = fakeNet(claude.answer, boards);
const readerNet = { fetch: net.fetch, now: () => today, sleep: async () => {} };
const boardCalls = (part: string) => net.count((c) => c.url.includes(part));

async function seedBoard(service: BoardRow['service'], token: string, name: string): Promise<BoardRow> {
  const b = await upsertBoard(t.db, { service, token, companyName: name, foundVia: 'seed' });
  const [row] = await t.db.query<BoardRow>(
    `select ${BOARD_COLUMNS} from orbit_private.job_boards where id = $1::uuid`,
    [b.id],
  );
  return row!;
}
const boardRow = async (id: string) =>
  (
    await t.db.query<BoardRow>(`select ${BOARD_COLUMNS} from orbit_private.job_boards where id = $1::uuid`, [
      id,
    ])
  )[0]!;

// ---- the API, with the real source side behind it ------------------------------------------------------------------------

const handler = makeApiHandler({
  env: {
    googleClientId: 'client-id-placeholder.apps.googleusercontent.com',
    googleClientSecret: 'client-secret-placeholder',
    googleRedirectUri: `${BASE}/auth/google/callback`,
    sessionSecret: SECRET,
    appUrl: APP,
    ownerId: '00000000-0000-4000-8000-0000000000ff',
    features: ['roles'],
  },
  // a handle of its own, so nothing else's cached switches are read
  get db() {
    return t.db;
  },
  fetch: net.fetch,
  take: memoryTake(),
  now,
  agent: agentConfig(net, ALL_KEYS),
});
async function call<T>(path: string, token: string, body: unknown = {}): Promise<T> {
  const r = await handler(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  const json = (await r.json()) as T;
  expect(r.status, `${path}: ${JSON.stringify(json).slice(0, 300)}`).toBe(200);
  return json;
}

/** A made-up third-year who ticked software engineering and data science. */
const STUDENT: RoleProfile = {
  level: 'student',
  graduation: '2028-05',
  degree: 'bachelor',
  field: 'Computer Science',
  school: 'State University',
  courses: ['Databases', 'Statistics'],
  experience: [
    {
      title: 'Data Intern',
      org: 'Northwind Health',
      start: '2026-06',
      end: '2026-08',
      fullTime: false,
      text: 'Built a churn model in Python and SQL for the finance team.',
    },
  ],
  projects: [{ title: 'Course planner', text: 'A scheduling service written in Go.' }],
  skills: [
    { name: 'Python', from: 'written' },
    { name: 'SQL', from: 'written' },
  ],
  kinds: [
    { title: 'Software engineer', family: 'engineering', on: true },
    { title: 'Data scientist', family: 'data_ml', on: true },
  ],
  wants: { levels: [], places: [], notPlaces: [], remote: false },
  eligibility: {},
  sources: ['resume'],
  fullTimeMonths: 0,
};

/** The search read to the end, as the browser reads it: /roles/search, then /roles/more until done. */
async function searched(token: string, fresh = false): Promise<RoleMatch[]> {
  const s = await call<RolesSearchResponse>('/roles/search', token, fresh ? { fresh: true } : {});
  let last = s;
  for (let i = 0; i < 12 && !last.done; i++)
    last = await call<RolesSearchResponse>('/roles/more', token, { searchId: s.searchId });
  expect(last.done).toBe(true);
  const listed = await call<RolesListResponse>('/roles/list', token, { rest: true });
  expect(listed.matches.length).toBe(last.listed);
  return listed.matches;
}

const titled = (ms: RoleMatch[], title: string) => ms.filter((m) => m.job.title === title);

describe('the real sources into the real search', () => {
  let token = '';
  let userId = '';
  let first: RoleMatch[] = [];
  let nimbusBoard: BoardRow;

  it('the boards and the lists are read and kept by the real readers and intake', async () => {
    nimbusBoard = await seedBoard('greenhouse', 'nimbuspay', 'Nimbus Pay');
    const others = [
      await seedBoard('greenhouse', 'board1', 'Company A'),
      await seedBoard('ashby', 'quarry', 'Quarry'),
      await seedBoard('lever', 'halcyon', 'Halcyon'),
      await seedBoard('workday', 'lumen.wd5.myworkdayjobs.com/lumen/LumenExternalCareerSite', 'Lumen'),
    ];
    for (const b of [nimbusBoard, ...others]) {
      const o = await readBoard(t.db, readerNet, b, today);
      expect(o, `${b.token}: ${o.error ?? ''}`).toMatchObject({ ok: true });
    }
    for (const list of ['intern', 'newgrad'] as const) {
      const got = await readSimplify(readerNet, list);
      if (!got.ok) throw new Error(got.message);
      const kept = await roleSources.keep(t.db, got.value.listings);
      expect(kept.length).toBeGreaterThan(8);
    }
    const [n] = await t.db.sql<{ open: number; all: number; sources: string[] }>`
      select count(*) filter (where closed_at is null and dupe_of is null)::int as open, count(*)::int as all,
             array_agg(distinct source order by source) as sources
        from orbit_private.jobs`;
    expect(n!.sources).toEqual(['ashby', 'greenhouse', 'lever', 'simplify', 'workday']);
    expect(n!.open).toBeGreaterThan(30);
    expect(n!.all).toBeGreaterThan(n!.open);
    // boards that list without text have none yet: it is read when a role is first read closely
    const [texts] = await t.db.sql<{ gh: number; wd: number; ashby: number }>`
      select count(*) filter (where source = 'greenhouse' and text is not null)::int as gh,
             count(*) filter (where source = 'workday' and text is not null)::int as wd,
             count(*) filter (where source = 'ashby' and text is not null)::int as ashby
        from orbit_private.jobs`;
    expect(texts).toEqual({ gh: 0, wd: 0, ashby: 3 });
  });

  it('a student is shown open roles at their level, of the kinds they ticked, each once, read and scored', async () => {
    const u = await signedInUser(t);
    token = u.token;
    userId = u.userId;
    await call('/roles/profile', token, { save: STUDENT });
    const jobCallsBefore = boardCalls('/jobs/');
    first = await searched(token);
    const titles = first.map((m) => `${m.job.title} | ${m.job.companyName}`);

    // ---- open, at the right levels ----
    expect(first.length).toBeGreaterThanOrEqual(10);
    for (const m of first) {
      expect(m.job.closedAt, m.job.title).toBeUndefined();
      // a student is shown internships, and roles whose posting does not say a level
      expect([undefined, 'intern'], `${m.job.title}: ${m.job.level}`).toContain(m.job.level);
    }
    const levels = new Set(first.map((m) => m.job.level));
    expect(levels.has('intern')).toBe(true);
    // entry, senior and lead roles are in the table of roles and not in this student's list
    for (const not of [
      'Software Engineer, New Grad - Frontend',
      'Staff Product Designer, Link',
      'Engineering Manager, Payments',
      'Senior SRE Engineer',
      'Senior Engineer, Backend, Vendor Management',
      'Junior Firmware Engineer',
      'Software Engineer - New Grad',
      // another kind of role
      'Account Executive, AI Sales',
      'Administrative Business Partner',
      // not English, and never kept
      'Softwareentwickler, Zahlungen',
    ])
      expect(titled(first, not), not).toHaveLength(0);
    const [kept] = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit_private.jobs
       where title in ('Software Engineer, New Grad - Frontend', 'Senior SRE Engineer', 'Junior Firmware Engineer')
         and closed_at is null`;
    expect(kept!.n).toBeGreaterThanOrEqual(3);
    // a SimplifyJobs entry that is no longer active was never kept
    expect(titles.some((x) => x.includes('Design Automation'))).toBe(false);
    // one whose own posting answered "gone" when its text was asked for is closed, and has left the list
    expect(titled(first, 'AI Agent Builder Intern')).toHaveLength(0);
    const [gone] = await t.db.sql<{ closed: boolean }>`
      select closed_at is not null as closed from orbit_private.jobs where title = 'AI Agent Builder Intern'`;
    expect(gone!.closed).toBe(true);

    // ---- from every source that has such roles ----
    expect(new Set(first.map((m) => m.job.source))).toEqual(
      new Set(['greenhouse', 'ashby', 'workday', 'simplify']),
    );
    expect(titled(first, 'Applied Scientist Intern')[0]!.job).toMatchObject({
      source: 'ashby',
      companyName: 'Quarry',
      level: 'intern',
    });
    expect(titled(first, 'Software Engineer, Storage')[0]!.job).toMatchObject({
      source: 'workday',
      companyName: 'Lumen',
    });
    expect(titled(first, 'Intern Software Engineer')[0]!.job).toMatchObject({
      source: 'simplify',
      companyName: 'Company J',
      level: 'intern',
      term: 'Summer 2026',
      sponsorship: 'none',
    });

    // ---- each role once ----
    expect(new Set(first.map((m) => m.job.id)).size).toBe(first.length);
    // listed in two cities on its board: one row, both places
    const intern = titled(first, 'Integration Reliability Engineer Intern, Technical Operations');
    expect(intern).toHaveLength(1);
    expect(intern[0]!.job).toMatchObject({
      source: 'greenhouse',
      companyName: 'Nimbus Pay',
      level: 'intern',
      places: ['Singapore', 'Dublin'],
    });
    const [rows] = await t.db.sql<{ n: number; shown: number }>`
      select count(*)::int as n, count(*) filter (where dupe_of is null)::int as shown from orbit_private.jobs
       where title = 'Integration Reliability Engineer Intern, Technical Operations'`;
    expect(rows).toEqual({ n: 2, shown: 1 });
    // on a SimplifyJobs list and on the company's own board: listed once, from the board
    const ds = titled(first, 'Data Science Intern');
    expect(ds).toHaveLength(1);
    expect(ds[0]!.job).toMatchObject({ source: 'greenhouse', companyName: 'Company A' });
    // one role with several places in one listing keeps them all
    const cloud = titled(first, 'Software Engineer, Security, Cloud');
    expect(cloud).toHaveLength(1);
    expect(cloud[0]!.job.places.length).toBe(4);

    // ---- text read on demand, once, through the source side ----
    expect(boardCalls('/v1/boards/nimbuspay/jobs/8186367')).toBe(1);
    // the second city's copy is the same role: its text is not fetched
    expect(boardCalls('/v1/boards/nimbuspay/jobs/8186368')).toBe(0);
    expect(boardCalls('/v1/boards/board1/jobs/4993728008')).toBe(1);
    expect(boardCalls('Software-Engineer--Storage_JR2029278')).toBe(1);
    expect(boardCalls('/jobs/') - jobCallsBefore).toBeGreaterThanOrEqual(3);
    const stored = await t.db.sql<{
      title: string;
      text: string | null;
      hash: string | null;
      places: string[];
    }>`
      select title, text, text_hash as hash, places from orbit_private.jobs
       where external_id in ('8186367', '4993728008') or title = 'Software Engineer, Storage'
       order by title`;
    for (const j of stored) {
      expect(j.text, j.title).toMatch(/Must have Python\./);
      expect(j.hash, j.title).toMatch(/^[0-9a-f]{64}$/);
    }
    // Workday's detail also gave every place the role is listed in
    expect(stored.find((j) => j.title === 'Software Engineer, Storage')!.places).toEqual([
      'Israel, Raanana',
      'Israel, Tel Aviv',
    ]);

    // ---- every one scored ----
    for (const m of first) {
      expect(m.state, m.job.title).toBe('read');
      expect(m.fit, m.job.title).toBeDefined();
      expect(m.fit!.score).toBeGreaterThanOrEqual(1);
      expect(m.fit!.score).toBeLessThanOrEqual(10);
    }
    // read from the board's own text: the student's job line shows Python and SQL, Go only in a project
    const scored = intern[0]!;
    expect(scored.answers!.skills.map((x) => [x.name, x.need, x.answer])).toEqual([
      ['Python', 'must', 'work'],
      ['SQL', 'must', 'work'],
      ['Go', 'nice', 'project'],
    ]);
    expect(scored.answers!.skills[0]).toMatchObject({
      you: 'Built a churn model in Python and SQL for the finance team.',
      posting: 'Must have Python.',
    });
    expect(scored.fit).toMatchObject({ score: 9, band: 'strong', caps: [] });
    expect(scored.fit!.parts).toMatchObject({ level: 1 });
    // the data role asks for more: statistics, which the student has from a course (so not shown in work), and
    // Spark, which nothing of theirs shows
    expect(ds[0]!.answers!.skills.map((x) => [x.name, x.answer])).toEqual([
      ['Python', 'work'],
      ['SQL', 'work'],
      ['Statistics', 'project'],
      ['Spark', 'none'],
    ]);
    expect(ds[0]!.fit!.score).toBeLessThan(scored.fit!.score);
    // a role whose page Orbit cannot read is scored on its listing, and cannot be a strong fit on paper
    const thin = titled(first, 'Intern Software Engineer')[0]!;
    expect(thin.fit!.caps.map((c) => c.kind)).toContain('thin');
    expect(thin.fit!.score).toBeLessThanOrEqual(6);
    expect(['stretch', 'out']).toContain(thin.fit!.band);
    // a role that does not sponsor is never capped for a student who was not asked
    expect(thin.fit!.caps.map((c) => c.kind)).not.toContain('sponsorship');
    // requirements were read once for each role that has a text, kept on the role, and never for one with none
    const [reqs] = await t.db.sql<{ kept: number; without: number }>`
      select count(*) filter (where requirements_hash is not null and requirements_hash = text_hash)::int as kept,
             count(*) filter (where text is null and requirements is not null)::int as without
        from orbit_private.jobs`;
    const read = claude.requests.filter((r) => kind(r) === 'requirements').length;
    expect(read).toBe(reqs!.kept);
    expect(reqs!.without).toBe(0);
    expect(read).toBeLessThanOrEqual(first.length + 1);
  });

  it('asked again, nothing is fetched or read twice; a role its board stops listing leaves the list and stays in Saved', async () => {
    const calls = net.calls.length;
    const again = await searched(token);
    expect(again.map((m) => m.id).sort()).toEqual(first.map((m) => m.id).sort());
    expect(net.calls.length).toBe(calls);

    // the student saves the internship; the next day Nimbus Pay has taken it down in both cities
    const intern = titled(first, 'Integration Reliability Engineer Intern, Technical Operations')[0]!;
    await call('/roles/act', token, { matchId: intern.id, status: 'saved' });
    today = DAY2;
    ticks = 0;
    // a new day, a new session (yesterday's hour-long token has run out)
    token = (await createSession(t.db, { secret: SECRET, now: () => today }, userId)).accessToken;
    nimbus = { ...nimbus, jobs: nimbus.jobs.filter((j) => j.id !== 8186367 && j.id !== 8186368) };
    const o = await readBoard(t.db, readerNet, await boardRow(nimbusBoard.id), today);
    expect(o).toMatchObject({ ok: true, closed: 2 });

    const next = await searched(token, true);
    expect(titled(next, intern.job.title)).toHaveLength(0);
    expect(next.length).toBe(first.length - 1);
    // read before, for the same profile: nothing is read again
    const scoreCalls = claude.requests.filter((r) => kind(r) === 'score').length;
    expect(next.every((m) => m.fit)).toBe(true);
    expect(claude.requests.filter((r) => kind(r) === 'score').length).toBe(scoreCalls);
    const saved = await call<RolesListResponse>('/roles/list', token, { view: 'saved' });
    expect(saved.matches).toHaveLength(1);
    expect(saved.matches[0]).toMatchObject({ id: intern.id, status: 'saved' });
    expect(saved.matches[0]!.job.closedAt).toBe(o.ok ? saved.matches[0]!.job.closedAt : '');
    expect(saved.matches[0]!.job.closedAt).toMatch(/^2026-11-25T/);
    // its score is still there to read
    expect(saved.matches[0]!.fit).toEqual(intern.fit);
  });
});
