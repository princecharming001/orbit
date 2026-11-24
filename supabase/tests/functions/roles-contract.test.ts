/**
 * Plan 44, the contract between the browser and the server, tested with both real: the browser's Roles engine
 * (apps/web/src/engine/roles.ts, with its real client, its real database on fake-indexeddb and its real sign-in) drives
 * the real orbit-api handler on PGlite, with the real source side (intake, the posting reader, text on demand) and a
 * fake of the model and of the job boards. Nothing here is the browser's fake API or the server's fake sources: this
 * is the join the three parts were merged without.
 *
 * Every /roles answer that crosses the wire is checked field by field against packages/core/src/roles/types.ts and
 * against what the browser reads from it (`fit.parts/weights/caps/band`, `answers.skills[].you/posting`, `roughFit`,
 * `coverage`, `note`, `job.closedAt`, `status`, `dismissReason`), and the browser's own words for a match are built
 * from each one. Covered, in the order a student meets them: the switch off; the owner's preview; the profile read
 * (LinkedIn's own date and description shapes), reviewed and saved; a search read in the background until done; the
 * list; Saved with a role that has since closed; save, dismiss with a reason, applied, watch; a posting scored by
 * text and by link, and with no profile; a search another tab replaced; the model off.
 */
import '../../../apps/web/src/test/setup.ts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../../../apps/web/src/db/schema.ts';
import { adoptAccountUser } from '../../../apps/web/src/engine/accountMode.ts';
import { featureOn } from '../../../apps/web/src/engine/features.ts';
import {
  actOnMatch,
  coverageWords,
  DEFAULT_FILTERS,
  filterMatches,
  keptMatches,
  keptProfile,
  keptSearch,
  partWords,
  postedWords,
  proposedProfile,
  quotesOf,
  readProfile,
  refreshMatches,
  resetRolesForTests,
  rolesCall,
  rolesMode,
  runSearch,
  savedMatches,
  saveProfile,
  scorePosting,
  setRolesPauseForTests,
  sortMatches,
  syncProfile,
  tableMatches,
  watchCompany,
  watching,
  whereTheyAre,
  whereWords,
} from '../../../apps/web/src/engine/roles.ts';
import { resetServerSyncForTests } from '../../../apps/web/src/engine/serverSync.ts';
import {
  callApi,
  clearSession,
  completeSignIn,
  refreshAccount,
  resetSessionForTests,
  setOrbitApiBaseForTests,
  setOrbitApiFetchForTests,
} from '../../../apps/web/src/integrations/orbitApi.ts';
import { bandOf, FIT_WEIGHTS } from '../../../packages/core/src/roles/fit.ts';
import type {
  Fit,
  FitAnswers,
  Job,
  JobListing,
  RoleMatch,
  RoleProfile,
  RolesCoverage,
  RolesListResponse,
  RolesProfileResponse,
  RolesScoreResponse,
  RolesSearchResponse,
} from '../../../packages/core/src/roles/types.ts';
import {
  BOARD_SERVICES,
  JOB_LEVELS,
  JOB_SOURCES,
  PROFILE_LEVELS,
} from '../../../packages/core/src/roles/types.ts';
import type { User } from '../../../packages/core/src/types.ts';
import { forgetFeatures } from '../../functions/_shared/features.ts';
import { memoryTake } from '../../functions/_shared/ratelimit.ts';
import { upsertBoard } from '../../functions/_shared/roles/boards.ts';
import { keepListings } from '../../functions/_shared/roles/intake.ts';
import { LINKEDIN_ONLY_NOTE } from '../../functions/_shared/roles/profile.ts';
import { NOT_READ_NOTE } from '../../functions/_shared/roles/score.ts';
import { NO_PROFILE } from '../../functions/_shared/roles/search.ts';
import type { AgentEnv } from '../../functions/_shared/services.ts';
import { createLoginCode } from '../../functions/_shared/session.ts';
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
import { freshDb, type TestDb } from '../helpers/pglite.ts';
import { fakeRolesModel, kind, POSTING } from '../helpers/rolesModel.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  setOrbitApiFetchForTests(undefined);
  setOrbitApiBaseForTests(undefined);
  setRolesPauseForTests(undefined);
  await t.pg.close();
});

// ---- the clock: a fixed day that moves at the real pace, so "today" never changes under a run -------------------

const DAY = Date.parse('2026-11-24T10:00:00Z');
const started = Date.now();
const now = () => new Date(DAY + (Date.now() - started));
/** The made-up student graduates in May of this year: a year and a half from the server's day, so a student. */
const GRAD = 2028;

// ---- the server: the real handler, the real sources, a fake of the model and of the boards -----------------------

const NIMBUS_JOB = 'https://boards.greenhouse.io/nimbuspay/jobs/7770001';

/** The job boards the real readers ask: one Greenhouse role's text, and a page Orbit cannot read. */
const boards: Answer = (c) => {
  const u = new URL(c.url);
  if (u.hostname === 'boards-api.greenhouse.io' && u.pathname === '/v1/boards/nimbuspay/jobs/7770001')
    return jsonRes(200, {
      id: 7770001,
      title: 'Software Engineering Intern, Payments',
      location: { name: 'New York, NY' },
      departments: [{ name: 'Payments' }],
      content:
        '&lt;p&gt;About us: we move money.&lt;/p&gt;&lt;p&gt;Must have Python.&lt;/p&gt;&lt;p&gt;Must have SQL.&lt;/p&gt;&lt;p&gt;Nice to have Kafka.&lt;/p&gt;',
    });
  if (u.hostname === 'boards-api.greenhouse.io' && u.pathname === '/v1/boards/nimbuspay/jobs/9990001')
    return jsonRes(404, { error: 'gone' });
  if (u.hostname === 'careers.unreadable.example')
    return new Response('<html><body>Sign in to see this job</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  return undefined;
};

interface Wire {
  route: string;
  body: Record<string, unknown>;
  status: number;
  json: unknown;
}

function server(o: { features?: string[]; ownerId?: string; env?: AgentEnv } = {}) {
  const claude = anthropic(fakeRolesModel());
  const net = fakeNet(claude.answer, boards);
  // production reads behind the answer (EdgeRuntime.waitUntil): the same here, the reads left running
  const background: Promise<unknown>[] = [];
  const handler = makeApiHandler({
    env: {
      googleClientId: 'client-id-placeholder.apps.googleusercontent.com',
      googleClientSecret: 'client-secret-placeholder',
      googleRedirectUri: `${BASE}/auth/google/callback`,
      sessionSecret: SECRET,
      appUrl: APP,
      ownerId: o.ownerId ?? '00000000-0000-4000-8000-0000000000ff',
      features: o.features ?? ['roles'],
    },
    db: t.db,
    fetch: net.fetch,
    take: memoryTake(),
    now,
    agent: agentConfig(net, o.env ?? ALL_KEYS),
    waitUntil: (p) => {
      background.push(p);
    },
  });
  const wire: Wire[] = [];
  /** something that happens elsewhere just before the server takes a request (another tab, say) */
  const hooks: { before?: (route: string, req: Request) => Promise<void> } = {};
  // the browser's own client talks to the real handler: every request and answer is kept as it crossed
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const route = new URL(req.url).pathname.replace(/^.*\/orbit-api/, '');
    await hooks.before?.(route, req);
    let body: Record<string, unknown> = {};
    try {
      body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    const res = await handler(req);
    const json = await res
      .clone()
      .json()
      .catch(() => undefined);
    wire.push({ route, body, status: res.status, json });
    return res;
  }) as typeof fetch;
  setOrbitApiBaseForTests(BASE);
  setOrbitApiFetchForTests(fetchImpl);
  forgetFeatures(t.db);
  const calls = (route: string) => wire.filter((w) => w.route === route);
  const modelCalls = (k: string) => claude.requests.filter((r) => kind(r) === k).length;
  return { handler, wire, hooks, calls, claude, net, background, modelCalls };
}

/** Sign the browser in the way /auth/done does: a login code redeemed at the real /auth/session. */
async function signIn(userId: string): Promise<User> {
  resetSessionForTests();
  resetServerSyncForTests();
  resetRolesForTests();
  const r = await completeSignIn(`#code=${await createLoginCode(t.db, userId, now())}`);
  if (!r.ok) throw new Error(r.message);
  return adoptAccountUser(r.user);
}

afterEach(async () => {
  resetRolesForTests();
  await clearSession();
  resetSessionForTests();
});

// ---- what the browser holds: the resume's kept lines and the student's own LinkedIn profile -------------------------

const T0 = '2026-11-24T09:00:00.000Z';

async function seedResume(userId: string) {
  await db.resumes.put({
    id: `r_${userId}`,
    userId,
    filename: 'Resume.pdf',
    text: '',
    isCurrent: true,
    createdAt: T0,
    parsedAt: T0,
  });
  await db.resumeFacets.bulkPut([
    {
      id: `f1_${userId}`,
      resumeId: `r_${userId}`,
      kind: 'experience',
      title: 'Data Intern',
      organizationName: 'Ramp',
      startDate: '2026-06-01',
      endDate: '2026-08-15',
      text: 'Built a churn model in Python and SQL for the finance team.',
      keywords: [],
      confirmed: true,
    },
    {
      id: `f2_${userId}`,
      resumeId: `r_${userId}`,
      kind: 'project',
      title: 'Course planner',
      text: 'A React app that plans courses.',
      keywords: [],
      confirmed: true,
    },
    {
      id: `f3_${userId}`,
      resumeId: `r_${userId}`,
      kind: 'education',
      title: 'BS Computer Science',
      organizationName: 'Stanford University',
      endDate: `${GRAD}-05-31`,
      text: 'BS Computer Science. Courses: databases, operating systems.',
      keywords: [],
      confirmed: true,
    },
    {
      id: `f4_${userId}`,
      resumeId: `r_${userId}`,
      kind: 'skill_group',
      text: 'Python, SQL, TypeScript',
      keywords: [],
      confirmed: true,
    },
  ]);
}

/**
 * The student's own LinkedIn profile as orbit-connectors hands it over (mapProfile): Unipile's month/day/year dates,
 * and each position's description when `described`.
 */
async function seedLinkedIn(userId: string, described: boolean) {
  await db.kv.put({
    key: `self:linkedin:${userId}`,
    value: {
      readAt: T0,
      v: 2,
      profile: {
        headline: 'CS at Stanford',
        experience: [
          {
            title: 'Software Engineering Intern',
            company: 'Brex',
            current: false,
            start: '6/1/2025',
            end: '8/15/2025',
            ...(described
              ? { description: 'Wrote Git hooks and a Python service for card reconciliation.' }
              : {}),
          },
        ],
        education: [
          {
            school: 'Stanford University',
            degree: 'Bachelor of Science',
            field: 'Computer Science',
            start: '9/1/2024',
            end: `5/31/${GRAD}`,
          },
        ],
        throttled: [],
        skills: ['Python', 'Kubernetes'],
      },
    },
  });
}

// ---- the roles, kept through the real intake ---------------------------------------------------------------------------

const listing = (id: string, title: string, company: string, over: Partial<JobListing> = {}): JobListing => ({
  source: 'ashby',
  externalId: id,
  companyName: company,
  title,
  locations: ['New York, NY'],
  url: `https://jobs.ashbyhq.com/${company.toLowerCase().replace(/\W+/g, '')}/${id}`,
  postedAt: new Date(DAY - 2 * 86_400_000).toISOString(),
  text: POSTING(title),
  ...over,
});

let harborBoard = '';

/** Sixteen roles a student who ticked "Software engineer" is shown, and four they are not. */
async function seedRoles() {
  await t.pg.exec(`delete from orbit.role_matches; delete from orbit.role_searches; delete from orbit.role_profiles;
    delete from orbit.role_watches; delete from orbit.role_source_reads; delete from orbit_private.jobs;
    delete from orbit_private.job_boards; delete from orbit_private.roles_usage;
    delete from orbit_private.feature_launch;`);
  const harbor = await upsertBoard(t.db, {
    service: 'ashby',
    token: 'harbor',
    companyName: 'Harbor',
    foundVia: 'seed',
  });
  const nimbus = await upsertBoard(t.db, {
    service: 'greenhouse',
    token: 'nimbuspay',
    companyName: 'Nimbus Pay',
    foundVia: 'seed',
  });
  harborBoard = harbor.id;
  await t.db.sql`update orbit_private.job_boards set status = 'active'`;
  const at = now();
  // one role listed in two cities on one board: one row, two places
  await keepListings(
    t.db,
    [
      listing('harbor-ny', 'Backend Engineer Intern', 'Harbor', { team: 'Platform' }),
      listing('harbor-sf', 'Backend Engineer Intern', 'Harbor', {
        team: 'Platform',
        locations: ['San Francisco, CA'],
      }),
    ],
    { boardId: harbor.id, now: at },
  );
  // a Greenhouse board lists without text: it is read when the role is first read closely
  await keepListings(
    t.db,
    [
      {
        source: 'greenhouse',
        externalId: '7770001',
        companyName: 'Nimbus Pay',
        title: 'Software Engineering Intern, Payments',
        locations: ['New York, NY'],
        url: NIMBUS_JOB,
        postedAt: new Date(DAY - 86_400_000).toISOString(),
      },
    ],
    { boardId: nimbus.id, now: at },
  );
  await keepListings(
    t.db,
    [
      listing('quarry-1', 'Software Engineer Intern', 'Quarry'),
      // asks for nothing the student has
      listing('beta-1', 'Platform Engineering Intern', 'Beta', {
        text: 'Platform Engineering Intern\nWhat you need:\nMust have Go.\nMust have Kubernetes.\nMust have Rust.',
        remote: 'remote',
        locations: ['Remote - US'],
      }),
      ...Array.from({ length: 12 }, (_, i) =>
        listing(`co-${i}`, 'Software Engineer Intern', `Company ${String.fromCharCode(65 + i)}`),
      ),
      // not shown to this student: another level, another kind of role
      listing('quarry-senior', 'Senior Software Engineer', 'Quarry'),
      listing('quarry-data', 'Sales Operations Intern', 'Quarry'),
      listing('gone-1', 'Software Engineer Intern', 'Gone Co'),
    ],
    { now: at },
  );
  await t.db.sql`update orbit_private.jobs set closed_at = ${at}::timestamptz where external_id = 'gone-1'`;
}

// ---- every answer, field by field ------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const only = (o: object, keys: string[], what: string) =>
  expect(
    Object.keys(o).filter((k) => !keys.includes(k)),
    `${what}: keys the shared types do not have`,
  ).toEqual([]);
const text = (v: unknown, what: string) => {
  expect(typeof v, what).toBe('string');
  expect((v as string).length, what).toBeGreaterThan(0);
};

const JOB_KEYS = [
  'id',
  'source',
  'externalId',
  'companyKey',
  'companyName',
  'companyDomain',
  'companyLogoUrl',
  'title',
  'team',
  'family',
  'level',
  'employment',
  'places',
  'countries',
  'remote',
  'term',
  'pay',
  'sponsorship',
  'degrees',
  'url',
  'applyUrl',
  'postedAt',
  'firstSeenAt',
  'closedAt',
];

function checkJob(j: Job, what: string) {
  only(j, JOB_KEYS, `${what} job`);
  expect(j.id, what).toMatch(UUID);
  expect(JOB_SOURCES, what).toContain(j.source);
  for (const k of ['externalId', 'companyKey', 'companyName', 'title'] as const)
    text(j[k], `${what} job.${k}`);
  expect(Array.isArray(j.places) && Array.isArray(j.countries) && Array.isArray(j.degrees), what).toBe(true);
  expect(typeof j.url, what).toBe('string');
  expect(j.firstSeenAt, what).toMatch(ISO);
  if (j.postedAt !== undefined) expect(j.postedAt, what).toMatch(ISO);
  if (j.closedAt !== undefined) expect(j.closedAt, what).toMatch(ISO);
  if (j.level !== undefined) expect(JOB_LEVELS, what).toContain(j.level);
  if (j.remote !== undefined) expect(['remote', 'hybrid', 'on_site'], what).toContain(j.remote);
  // the words the table and the panel build from a role
  const where = whereWords(j);
  expect(`${where.place} ${where.all}`, what).not.toMatch(/undefined|null|NaN/);
  expect(postedWords(j, now()), what).not.toMatch(/undefined|NaN|Invalid/);
}

function checkFit(f: Fit, a: FitAnswers, what: string) {
  only(f, ['score', 'raw', 'parts', 'weights', 'caps', 'band'], `${what} fit`);
  expect(Number.isInteger(f.score) && f.score >= 1 && f.score <= 10, `${what} score ${f.score}`).toBe(true);
  expect(Number.isInteger(f.raw) && f.raw >= f.score, `${what} raw ${f.raw}`).toBe(true);
  expect(f.band, what).toBe(bandOf(f.score));
  const parts = Object.keys(f.parts);
  expect(parts.sort(), what).toEqual(Object.keys(f.weights).sort());
  for (const k of parts) {
    expect(['skills', 'experience', 'education', 'level'], what).toContain(k);
    const v = f.parts[k as keyof Fit['parts']]!;
    expect(v >= 0 && v <= 1, `${what} parts.${k} ${v}`).toBe(true);
  }
  // the weights are the shares used: together they are the whole
  expect(
    Object.values(f.weights).reduce((s, w) => s + (w ?? 0), 0),
    what,
  ).toBeCloseTo(1, 6);
  // a part the posting says nothing about is left out
  expect('education' in f.parts, what).toBe(a.education.answer !== 'unsaid');
  expect('skills' in f.parts, what).toBe(a.skills.length > 0);
  expect(Array.isArray(f.caps), what).toBe(true);
  for (const c of f.caps) {
    only(c, ['kind', 'quote', 'label'], `${what} cap`);
    expect(Object.keys(FIT_WEIGHTS.caps), what).toContain(c.kind);
    text(c.label, `${what} cap.label`);
    expect(f.score, `${what} is held down by ${c.kind}`).toBeLessThanOrEqual(FIT_WEIGHTS.caps[c.kind]);
  }
}

function checkAnswers(a: FitAnswers, what: string) {
  only(a, ['skills', 'experience', 'education', 'level', 'caps', 'reason', 'gaps'], `${what} answers`);
  for (const s of a.skills) {
    only(s, ['name', 'need', 'answer', 'you', 'posting'], `${what} skill`);
    text(s.name, `${what} skill.name`);
    expect(['must', 'nice'], what).toContain(s.need);
    expect(['work', 'project', 'listed', 'none'], what).toContain(s.answer);
    // the posting's own words for the requirement are always there; the student's when the answer rests on a line
    text(s.posting, `${what} skill.posting`);
    if (s.answer === 'work' || s.answer === 'project') text(s.you, `${what} skill.you (${s.answer})`);
    if (s.answer === 'none') expect(s.you, what).toBeUndefined();
  }
  only(a.experience, ['answer', 'you', 'posting'], `${what} experience`);
  expect(['same', 'related', 'projects', 'none'], what).toContain(a.experience.answer);
  only(a.education, ['answer', 'you', 'posting'], `${what} education`);
  expect(['fits', 'close', 'no', 'unsaid'], what).toContain(a.education.answer);
  only(a.level, ['answer', 'you', 'posting'], `${what} level`);
  expect(['at', 'below', 'stretch', 'far'], what).toContain(a.level.answer);
  expect(typeof a.reason, what).toBe('string');
  expect(Array.isArray(a.gaps) && Array.isArray(a.caps), what).toBe(true);
  for (const line of [a.reason, ...a.gaps]) expect(line, what).not.toMatch(/[—!]/);
}

const MATCH_KEYS = [
  'id',
  'job',
  'state',
  'rank',
  'fit',
  'answers',
  'reason',
  'gaps',
  'status',
  'dismissReason',
  'readAt',
  'roughFit',
];

/** One match as it crossed the wire, against the shared types and what the browser's table and panel read. */
function checkMatch(m: RoleMatch, what: string) {
  only(m, MATCH_KEYS, what);
  expect(m.id, what).toMatch(UUID);
  checkJob(m.job, what);
  expect(['to_read', 'read', 'failed', 'gone'], what).toContain(m.state);
  expect(typeof m.rank, what).toBe('number');
  expect(['new', 'saved', 'dismissed', 'applied', 'interviewing'], what).toContain(m.status);
  expect(m.dismissReason !== undefined, `${what} dismissReason goes with dismissed`).toBe(
    m.status === 'dismissed',
  );
  if (m.dismissReason)
    expect(['kind', 'level', 'place', 'company', 'other'], what).toContain(m.dismissReason);
  if (m.fit) {
    // read closely: the score, what it rests on, and never the rough parts beside it
    expect(m.state, what).toBe('read');
    expect(m.answers, `${what} answers`).toBeDefined();
    checkAnswers(m.answers!, what);
    checkFit(m.fit, m.answers!, what);
    expect(m.fit.caps, what).toEqual(m.answers!.caps);
    expect(m.readAt, what).toMatch(ISO);
    expect(m.roughFit, what).toBeUndefined();
    // the panel's words for each part, and the quotes under them
    const words = partWords(m);
    expect(
      words.map((w) => w.part),
      what,
    ).toEqual(['skills', 'experience', 'education', 'level']);
    for (const w of words) {
      text(w.words, `${what} words for ${w.part}`);
      expect(w.words, what).not.toMatch(/undefined|NaN/);
      expect(w.value, `${what} value of ${w.part}`).toBe(m.fit.parts[w.part]);
    }
    const q = quotesOf(m);
    expect(q.posting.length, `${what} quotes from the posting`).toBeGreaterThan(0);
  } else {
    // not read closely: no number anywhere, and the free parts when the server sent the row for the table
    expect(m.answers, what).toBeUndefined();
    expect(m.reason, what).toBeUndefined();
    expect(m.readAt, what).toBeUndefined();
    expect(['to_read', 'failed', 'read'], what).toContain(m.state);
    if (m.roughFit) {
      only(m.roughFit, ['skills', 'level', 'place'], `${what} roughFit`);
      expect(m.roughFit.skills >= 0 && m.roughFit.skills <= 1, what).toBe(true);
      expect([typeof m.roughFit.level, typeof m.roughFit.place], what).toEqual(['boolean', 'boolean']);
    }
  }
}

function checkCoverage(c: RolesCoverage | undefined, what: string) {
  expect(c, `${what} coverage`).toBeDefined();
  only(c!, ['boards', 'roles', 'linkedin', 'simplify'], `${what} coverage`);
  expect([typeof c!.boards, typeof c!.roles, typeof c!.linkedin, typeof c!.simplify], what).toEqual([
    'number',
    'number',
    'boolean',
    'boolean',
  ]);
  expect(coverageWords(c), what).not.toMatch(/undefined|NaN/);
}

function checkSearch(r: RolesSearchResponse, what: string) {
  only(r, ['searchId', 'matches', 'listed', 'read', 'done', 'coverage', 'note'], what);
  expect(r.searchId, what).toMatch(UUID);
  expect(Number.isInteger(r.listed) && Number.isInteger(r.read) && r.read <= r.listed, what).toBe(true);
  expect(typeof r.done, what).toBe('boolean');
  checkCoverage(r.coverage, what);
  if (r.note !== undefined) {
    text(r.note, `${what} note`);
    expect(r.note, what).not.toMatch(/[—!]/);
    // a note stands on its own line on the page: a whole sentence
    expect(r.note, what).toMatch(/[.]$/);
  }
  expect(new Set(r.matches.map((m) => m.id)).size, `${what}: a role is in an answer once`).toBe(
    r.matches.length,
  );
  for (const m of r.matches) checkMatch(m, `${what} ${m.job.title}`);
  // every role read closely is in the answer: the answer is the whole of what is read so far
  expect(r.matches.filter((m) => m.fit).length, `${what}: every row read so far`).toBe(r.read);
}

/** Every /roles answer the browser got, checked. Returns how many of each route. */
function checkWire(wire: Wire[]): Record<string, number> {
  const seen: Record<string, number> = {};
  for (const w of wire) {
    if (!w.route.startsWith('/roles/')) continue;
    seen[w.route] = (seen[w.route] ?? 0) + 1;
    if (w.status !== 200) {
      const e = (w.json as { error?: { code?: string; message?: string } })?.error;
      text(e?.code, `${w.route} ${w.status} error.code`);
      text(e?.message, `${w.route} ${w.status} error.message`);
      continue;
    }
    const what = `${w.route} ${JSON.stringify(w.body).slice(0, 60)}`;
    if (w.route === '/roles/search' || w.route === '/roles/more')
      checkSearch(w.json as RolesSearchResponse, what);
    if (w.route === '/roles/list') {
      const r = w.json as RolesListResponse;
      only(r, ['matches', 'searchId', 'coverage', 'profileAt'], what);
      for (const m of r.matches) checkMatch(m, `${what} ${m.job.title}`);
      if (r.searchId !== undefined) expect(r.searchId, what).toMatch(UUID);
      if (r.coverage !== undefined) checkCoverage(r.coverage, what);
      if (r.profileAt !== undefined) expect(r.profileAt, what).toMatch(ISO);
    }
    if (w.route === '/roles/score') {
      const r = w.json as RolesScoreResponse;
      only(r, ['match', 'problem'], what);
      expect(!!r.match !== !!r.problem, `${what}: a match or a problem`).toBe(true);
      if (r.match) checkMatch(r.match, what);
      if (r.problem) text(r.problem, `${what} problem`);
    }
    if (w.route === '/roles/act') {
      const r = w.json as { match?: RoleMatch; watching?: string[] };
      only(r, ['match', 'watching'], what);
      if ('watch' in w.body) {
        expect(Array.isArray(r.watching), `${what}: watching, the companies watched after the call`).toBe(
          true,
        );
        expect(r.match, what).toBeUndefined();
      } else {
        expect(r.match, what).toBeDefined();
        checkMatch(r.match!, what);
      }
    }
    if (w.route === '/roles/profile') {
      const r = w.json as RolesProfileResponse;
      only(r, ['profile', 'proposed', 'note'], what);
      for (const p of [r.profile, r.proposed]) if (p) checkProfile(p, what);
    }
  }
  return seen;
}

function checkProfile(p: RoleProfile, what: string) {
  only(
    p,
    [
      'level',
      'graduation',
      'degree',
      'field',
      'school',
      'courses',
      'experience',
      'projects',
      'skills',
      'kinds',
      'wants',
      'eligibility',
      'sources',
      'fullTimeMonths',
    ],
    `${what} profile`,
  );
  expect(PROFILE_LEVELS, what).toContain(p.level);
  if (p.graduation !== undefined) expect(p.graduation, what).toMatch(/^\d{4}-\d{2}$/);
  for (const e of p.experience) {
    text(e.title, `${what} experience.title`);
    expect(typeof e.fullTime, what).toBe('boolean');
    expect(typeof e.text, what).toBe('string');
    for (const d of [e.start, e.end]) if (d !== undefined) expect(d, what).toMatch(/^\d{4}-\d{2}$/);
  }
  for (const s of p.skills) {
    text(s.name, `${what} skill.name`);
    expect(['written', 'read', 'added'], what).toContain(s.from);
  }
  for (const k of p.kinds) {
    text(k.title, `${what} kind.title`);
    expect(typeof k.on, what).toBe('boolean');
  }
  only(p.wants, ['levels', 'places', 'notPlaces', 'remote', 'companies'], `${what} wants`);
  expect(Array.isArray(p.wants.levels) && Array.isArray(p.wants.places), what).toBe(true);
  expect(typeof p.wants.remote, what).toBe('boolean');
  only(p.eligibility, ['needsSponsorship', 'usCitizen'], `${what} eligibility`);
  expect(typeof p.fullTimeMonths, what).toBe('number');
  expect(whereTheyAre(p), what).not.toMatch(/undefined|NaN/);
}

/** A student with a confirmed profile, signed in in the browser, through the real routes. */
async function studentWithProfile(): Promise<{ user: User; profile: RoleProfile; userId: string }> {
  const u = await signedInUser(t);
  const user = await signIn(u.userId);
  await seedResume(user.id);
  const read = await readProfile(user, { resume: true, linkedin: false });
  if (!read.ok) throw new Error(read.message);
  const profile = {
    ...read.proposed,
    kinds: [{ title: 'Software engineer', family: 'engineering' as const, on: true }],
  };
  const saved = await saveProfile(user, profile, { search: false });
  if (!saved.ok) throw new Error(saved.message);
  return { user, profile: (await keptProfile(user.id))!.profile, userId: u.userId };
}

beforeAll(async () => {
  await wipeDatabase();
  // the loop waits between asks as it does in the page, only shorter
  setRolesPauseForTests(25);
});

// ---- the switch, and the owner's preview ----------------------------------------------------------------------------

describe('the switch', () => {
  it('off: the browser offers nothing and asks nothing; a call made anyway is refused, never read as a replaced search', async () => {
    await seedRoles();
    const s = server({ features: [] });
    const u = await signedInUser(t);
    const user = await signIn(u.userId);
    expect(featureOn('roles', user.id)).toBe(false);
    expect(rolesMode(user.id)).toBe('off');
    const asked = s.wire.length;
    expect(await rolesCall(user.id, '/roles/list', {})).toMatchObject({ ok: false, reason: 'off' });
    expect((await runSearch(user)).ok).toBe(false);
    expect(s.wire.length).toBe(asked);
    // the routes themselves, for a client that asks all the same
    for (const [route, body] of [
      ['/roles/profile', { get: true }],
      ['/roles/search', {}],
      ['/roles/more', { searchId: '00000000-0000-4000-8000-000000000001' }],
      ['/roles/list', {}],
      ['/roles/score', { text: 'A posting' }],
      ['/roles/act', { watch: { companyName: 'Stripe', on: true } }],
    ] as const) {
      const r = await callApi(route, body as never);
      expect(r, route).toMatchObject({ ok: false, status: 404, code: 'not_offered' });
    }
    checkWire(s.wire);
  });

  it('the owner has the tab before it is launched: /auth/session says so, and every route answers', async () => {
    await seedRoles();
    const owner = await signedInUser(t);
    const s = server({ features: [], ownerId: owner.userId });
    const user = await signIn(owner.userId);
    // what the real sign-in handed the browser
    const session = s.calls('/auth/session')[0]!.json as { isOwner: boolean; features: string[] };
    expect(session).toMatchObject({ isOwner: true, features: ['roles'] });
    expect(featureOn('roles', user.id)).toBe(true);
    expect(rolesMode(user.id)).toBe('server');
    // the public switch is still off, and the Launch row reads that
    const launch = await callApi('/admin/features', {});
    expect(launch.ok && launch.value.features).toEqual([{ feature: 'roles', offered: false }]);
    await seedResume(user.id);
    const read = await readProfile(user, { resume: true, linkedin: false });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect((await saveProfile(user, read.proposed, { search: false })).ok).toBe(true);
    expect((await runSearch(user)).ok).toBe(true);
    expect((await keptSearch(user.id))?.done).toBe(true);
    // a student who is not the owner still has nothing
    const other = await signedInUser(t);
    const them = await signIn(other.userId);
    expect(featureOn('roles', them.id)).toBe(false);
    // and has it the moment the owner launches it (the browser asks /auth/me)
    await signIn(owner.userId);
    expect((await callApi('/admin/features/roles', { offered: true })).ok).toBe(true);
    await signIn(other.userId);
    await refreshAccount();
    expect(featureOn('roles', them.id)).toBe(true);
    checkWire(s.wire);
  });
});

// ---- the profile ---------------------------------------------------------------------------------------------------------

describe('the profile: read, reviewed, saved', () => {
  it('reads the resume and LinkedIn the browser holds, LinkedIn dates and descriptions included', async () => {
    await seedRoles();
    const s = server();
    const u = await signedInUser(t);
    const user = await signIn(u.userId);
    await seedResume(user.id);
    await seedLinkedIn(user.id, true);
    const read = await readProfile(user, { resume: true, linkedin: true });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const p = read.proposed;
    // what the server was sent: the LinkedIn job's own words, with LinkedIn's own way of writing a date
    const sent = s.calls('/roles/profile')[0]!.body.read as {
      linkedin: { positions: { start: string; description: string }[] };
    };
    expect(sent.linkedin.positions[0]).toMatchObject({
      start: '6/1/2025',
      description: 'Wrote Git hooks and a Python service for card reconciliation.',
    });
    // dates decide the level: graduating in a year and a half is a student, who is shown internships
    expect(p).toMatchObject({
      level: 'student',
      graduation: `${GRAD}-05`,
      degree: 'bachelor',
      fullTimeMonths: 0,
    });
    expect(p.sources).toEqual(['resume', 'linkedin']);
    // both jobs are kept, each with its own words and its dates read
    expect(p.experience.map((e) => [e.title, e.org, e.start, e.end, e.fullTime])).toEqual([
      ['Data Intern', 'Ramp', '2026-06', '2026-08', false],
      ['Software Engineering Intern', 'Brex', '2025-06', '2025-08', false],
    ]);
    expect(p.experience[1]!.text).toBe('Wrote Git hooks and a Python service for card reconciliation.');
    expect(p.skills.map((x) => x.name)).toEqual(
      expect.arrayContaining(['Python', 'SQL', 'TypeScript', 'Kubernetes']),
    );
    // the server leaves the levels to the profile's level; the screen shows them ticked
    const raw = (s.calls('/roles/profile')[0]!.json as RolesProfileResponse).proposed!;
    expect(raw.wants.levels).toEqual([]);
    expect(p.wants.levels).toEqual(['intern']);
    // never guessed
    expect(p.eligibility).toEqual({});
    expect(read.note).toBeUndefined();
    // some kind is proposed and ticked, so "Find roles" is not dead on arrival
    expect(p.kinds.some((k) => k.on)).toBe(true);

    // not confirmed yet: a reload (or another device) finds what Orbit read, not a profile to search with
    expect(await syncProfile(user)).toBeUndefined();
    expect(await keptProfile(user.id)).toBeUndefined();
    expect(proposedProfile(user.id)).toMatchObject({ level: 'student', wants: { levels: ['intern'] } });
    expect(await runSearch(user)).toMatchObject({ ok: false });
    expect(await t.db.sql`select 1 from orbit.role_searches where user_id = ${u.userId}::uuid`).toHaveLength(
      0,
    );

    // the student changes what was read, and saves it
    const edited: RoleProfile = {
      ...p,
      skills: [...p.skills, { name: 'Figma', from: 'added' }],
      kinds: [{ title: 'Software engineer', family: 'engineering', on: true }],
      wants: { ...p.wants, places: ['New York'], remote: true },
      eligibility: { needsSponsorship: false },
    };
    expect(await saveProfile(user, edited, { search: false })).toEqual({ ok: true });
    const kept = (await keptProfile(user.id))!.profile;
    expect(kept.skills.find((x) => x.name === 'Figma')).toMatchObject({ from: 'added' });
    expect(kept.wants).toMatchObject({ levels: ['intern'], places: ['New York'], remote: true });
    expect(kept.eligibility).toEqual({ needsSponsorship: false });
    // a new browser gets the same profile from the server
    await db.kv.delete(`roles:profile:${user.id}`);
    resetRolesForTests();
    expect((await syncProfile(user))?.profile).toEqual(kept);
    expect(proposedProfile(user.id)).toBeUndefined();
    expect(checkWire(s.wire)['/roles/profile']).toBe(4);
    expect(s.modelCalls('profile')).toBe(1);
  });

  it('LinkedIn alone with titles and no descriptions: the honest line, and still a profile', async () => {
    await seedRoles();
    const s = server();
    const u = await signedInUser(t);
    const user = await signIn(u.userId);
    await seedLinkedIn(user.id, false);
    const read = await readProfile(user, { resume: false, linkedin: true });
    expect(read).toMatchObject({ ok: true, note: LINKEDIN_ONLY_NOTE });
    if (!read.ok) return;
    expect(read.proposed).toMatchObject({
      level: 'student',
      graduation: `${GRAD}-05`,
      sources: ['linkedin'],
    });
    expect(read.proposed.experience[0]).toMatchObject({ title: 'Software Engineering Intern', text: '' });
    checkWire(s.wire);
  });
});

// ---- the search --------------------------------------------------------------------------------------------------------

describe('a search, read behind the answer as production reads it', () => {
  it('search once, more until done: every row read so far each time, each role once, only what fits the level', async () => {
    await seedRoles();
    const s = server();
    const { user } = await studentWithProfile();
    s.wire.length = 0;
    const out = await runSearch(user);
    expect(out).toEqual({ ok: true });
    await Promise.all(s.background);
    const seen = checkWire(s.wire);
    expect(seen['/roles/search']).toBe(1);
    // the first answer comes at once, before anything is read
    const first = s.calls('/roles/search')[0]!.json as RolesSearchResponse;
    expect(first).toMatchObject({ listed: 16, read: 0, done: false, matches: [] });
    expect(first.coverage).toEqual({ boards: 2, roles: 18, linkedin: false, simplify: false });
    // then /roles/more: answered at once each time, the rows growing, `done` only on the last
    const more = s.calls('/roles/more').map((w) => w.json as RolesSearchResponse);
    expect(more.length).toBeGreaterThanOrEqual(3);
    expect(more[0]).toMatchObject({ read: 0, done: false });
    expect(more.map((m) => m.done)).toEqual([...more.slice(0, -1).map(() => false), true]);
    for (let i = 1; i < more.length; i++) {
      expect(more[i]!.read).toBeGreaterThanOrEqual(more[i - 1]!.read);
      // nothing read earlier ever leaves a later answer
      const ids = new Set(more[i]!.matches.map((m) => m.id));
      for (const m of more[i - 1]!.matches) expect(ids.has(m.id)).toBe(true);
    }
    expect(more.at(-1)).toMatchObject({ read: 16, listed: 16 });
    // two reads of ten behind the answers, not one per ask
    expect(s.background.length).toBe(2);

    // what the browser kept: each role once, the search done, and the table is the whole of it
    const search = (await keptSearch(user.id))!;
    expect(search).toMatchObject({ done: true, listed: 16, read: 16, searchId: first.searchId });
    expect(search.note).toBeUndefined();
    const rows = await keptMatches(user.id);
    expect(rows).toHaveLength(16);
    const table = tableMatches(rows, search);
    expect(table).toHaveLength(16);
    expect(table.every((m) => m.fit && m.state === 'read' && m.status === 'new')).toBe(true);
    // open roles at the student's level, of the kind they ticked: not the senior role, the sales one or the closed one
    expect(table.every((m) => m.job.level === 'intern' && !m.job.closedAt)).toBe(true);
    const titles = table.map((m) => `${m.job.title} at ${m.job.companyName}`);
    expect(titles).not.toContain('Senior Software Engineer at Quarry');
    expect(titles.some((x) => /Sales|Gone Co/.test(x))).toBe(false);
    // the role listed in two cities is one row with both places
    const harbor = table.filter((m) => m.job.companyName === 'Harbor');
    expect(harbor).toHaveLength(1);
    expect(harbor[0]!.job).toMatchObject({ places: ['New York, NY', 'San Francisco, CA'], team: 'Platform' });
    expect(whereWords(harbor[0]!.job).all).toMatch(/New York.*San Francisco/);
    // the Greenhouse role's text was read from its board when first needed, and scored on it
    const nimbus = table.find((m) => m.job.companyName === 'Nimbus Pay')!;
    expect(s.net.count((c) => c.url.includes('/boards/nimbuspay/jobs/7770001'))).toBe(1);
    expect(nimbus.answers!.skills.map((x) => [x.name, x.need, x.answer])).toEqual([
      ['Python', 'must', 'work'],
      ['SQL', 'must', 'work'],
      ['Kafka', 'nice', 'none'],
    ]);
    expect(nimbus.fit).toMatchObject({ score: 8, band: 'good', caps: [] });
    // quotes: the student's own job line, the posting's own words
    const quarry = table.find((m) => m.job.companyName === 'Quarry')!;
    expect(quarry.answers!.skills).toEqual([
      {
        name: 'Python',
        need: 'must',
        answer: 'work',
        you: 'Built a churn model in Python and SQL for the finance team.',
        posting: 'Must have Python.',
      },
      {
        name: 'SQL',
        need: 'must',
        answer: 'work',
        you: 'Built a churn model in Python and SQL for the finance team.',
        posting: 'Must have SQL.',
      },
      { name: 'Git', need: 'must', answer: 'none', posting: 'Must have Git.' },
      // React is in a project line: shown in a project, never in work
      {
        name: 'React',
        need: 'nice',
        answer: 'project',
        you: 'Project: Course planner. A React app that plans courses.',
        posting: 'Nice to have React.',
      },
    ]);
    expect(quotesOf(quarry).you).toContain('Built a churn model in Python and SQL for the finance team.');
    // a role that asks for nothing they have is out of reach, and the least fit shown hides it; sorting puts it last
    const beta = table.find((m) => m.job.companyName === 'Beta')!;
    expect(beta.fit!.band).toBe('out');
    expect(filterMatches(table, DEFAULT_FILTERS).map((m) => m.id)).not.toContain(beta.id);
    expect(sortMatches(table, 'fit').at(-1)!.id).toBe(beta.id);
    // more than one band on one page
    expect(new Set(table.map((m) => m.fit!.band)).size).toBeGreaterThan(1);

    // the requirements were read once per text (twelve roles share one), the answers two roles a call
    expect(s.modelCalls('requirements')).toBeLessThanOrEqual(16);
    expect(s.modelCalls('score')).toBe(8);

    // the list, free: the same rows, nothing marked as taken down
    s.wire.length = 0;
    expect(await refreshMatches(user)).toEqual({ ok: true });
    checkWire(s.wire);
    expect(s.calls('/roles/list').map((w) => w.body)).toEqual([
      { view: 'matches', rest: true },
      { view: 'saved' },
    ]);
    const again = tableMatches(await keptMatches(user.id), await keptSearch(user.id));
    expect(again.map((m) => m.id).sort()).toEqual(table.map((m) => m.id).sort());
    expect(s.claude.requests.length).toBe(s.modelCalls('profile') + s.modelCalls('requirements') + 8);

    // asking for the search again is free too: the same one, as it stands
    expect((await runSearch(user)).ok).toBe(true);
    expect((await keptSearch(user.id))!.searchId).toBe(first.searchId);
    expect(s.modelCalls('score')).toBe(8);
  });

  it('save, dismiss with a reason, applied, watch: each kept, each answered as the browser reads it', async () => {
    await seedRoles();
    const s = server();
    const { user } = await studentWithProfile();
    expect((await runSearch(user)).ok).toBe(true);
    await Promise.all(s.background);
    s.wire.length = 0;
    const search = (await keptSearch(user.id))!;
    const table = sortMatches(tableMatches(await keptMatches(user.id), search), 'fit');
    const [a, b, c] = table;

    const savedA = await actOnMatch(user, a!, 'saved');
    expect(savedA).toMatchObject({ ok: true, match: { id: a!.id, status: 'saved' } });
    // the answer is the whole match again, score and all: the panel stays as it was
    if (savedA.ok) expect(savedA.match.fit).toEqual(a!.fit);
    const gone = await actOnMatch(user, b!, 'dismissed', 'place');
    expect(gone).toMatchObject({ ok: true, match: { status: 'dismissed', dismissReason: 'place' } });
    const applied = await actOnMatch(user, c!, 'applied');
    expect(applied).toMatchObject({ ok: true, match: { status: 'applied' } });
    if (applied.ok) expect(applied.match.dismissReason).toBeUndefined();
    // Undo: back to new, the reason gone
    const undone = await actOnMatch(user, { ...b!, status: 'dismissed' }, 'new');
    expect(undone).toMatchObject({ ok: true, match: { status: 'new' } });
    if (undone.ok) expect(undone.match.dismissReason).toBeUndefined();
    await actOnMatch(user, b!, 'dismissed', 'kind');

    const rows = await keptMatches(user.id);
    expect(
      savedMatches(rows)
        .map((m) => [m.id, m.status])
        .sort(),
    ).toEqual(
      [
        [a!.id, 'saved'],
        [c!.id, 'applied'],
      ].sort(),
    );
    expect(tableMatches(rows, search).map((m) => m.id)).not.toContain(b!.id);

    // watch: the answer is every company watched after the call
    expect(await watchCompany(user, 'Stripe', true)).toEqual({ ok: true });
    expect(await watchCompany(user, 'Ramp', true)).toEqual({ ok: true });
    expect(await watching(user.id)).toEqual(['Stripe', 'Ramp']);
    expect(await watchCompany(user, 'stripe', false)).toEqual({ ok: true });
    expect(await watching(user.id)).toEqual(['Ramp']);
    const watchAnswers = s.calls('/roles/act').filter((w) => 'watch' in w.body);
    expect(watchAnswers.map((w) => (w.json as { watching: string[] }).watching)).toEqual([
      ['Stripe'],
      ['Stripe', 'Ramp'],
      ['Ramp'],
    ]);

    // the saved role is taken down: it leaves the table, and Saved keeps it with the day it closed
    await t.db
      .sql`update orbit_private.jobs set closed_at = ${now()}::timestamptz where id = ${a!.job.id}::uuid`;
    // and so is a role the student did nothing with
    const d = table[3]!;
    await t.db
      .sql`update orbit_private.jobs set closed_at = ${now()}::timestamptz where id = ${d.job.id}::uuid`;
    expect(await refreshMatches(user)).toEqual({ ok: true });
    const after = await keptMatches(user.id);
    const savedNow = savedMatches(after);
    const closed = savedNow.find((m) => m.id === a!.id)!;
    expect(closed.job.closedAt).toMatch(ISO);
    expect(closed).toMatchObject({ status: 'saved', state: 'read' });
    // its score is still there to read in Saved
    expect(closed.fit).toEqual(a!.fit);
    const tableNow = tableMatches(after, search).map((m) => m.id);
    expect(tableNow).not.toContain(a!.id);
    expect(tableNow).not.toContain(d.id);
    expect(tableNow).not.toContain(b!.id);
    expect(tableNow).toContain(c!.id);
    // a dismissed role never comes back with a new search
    expect((await runSearch(user, { fresh: true })).ok).toBe(true);
    await Promise.all(s.background);
    const fresh = (await keptSearch(user.id))!;
    const freshTable = tableMatches(await keptMatches(user.id), fresh).map((m) => m.id);
    expect(fresh.searchId).not.toBe(search.searchId);
    expect(freshTable).not.toContain(b!.id);
    expect(freshTable).not.toContain(a!.id);
    expect(freshTable).toContain(c!.id);
    expect((await keptMatches(user.id)).find((r) => r.match.id === c!.id)!.match.status).toBe('applied');
    checkWire(s.wire);
  });

  it('a search another tab replaced: 404 search_replaced, and the loop follows the newer search without starting one', async () => {
    await seedRoles();
    const s = server();
    const { user, userId } = await studentWithProfile();
    // another tab, the same student: after this tab's first ask of /roles/more, "Search again" is pressed there
    let replaced: string | undefined;
    let asks = 0;
    s.hooks.before = async (route, req) => {
      if (route !== '/roles/more' || ++asks !== 2 || replaced) return;
      const again = await s.handler(
        new Request(`${BASE}/roles/search`, {
          method: 'POST',
          headers: req.headers,
          body: JSON.stringify({ fresh: true }),
        }),
      );
      replaced = ((await again.json()) as RolesSearchResponse).searchId;
    };
    s.wire.length = 0;
    expect(await runSearch(user)).toEqual({ ok: true });
    await Promise.all(s.background);
    expect(replaced).toMatch(UUID);
    const refused = s.calls('/roles/more').filter((w) => w.status !== 200);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.json).toEqual({
      error: { code: 'search_replaced', message: 'That search was replaced by a newer one.' },
    });
    // it asked which search to follow, and did not ask for a new one
    expect(s.calls('/roles/search').map((w) => w.body)).toEqual([{}, {}]);
    const search = (await keptSearch(user.id))!;
    expect(search).toMatchObject({ searchId: replaced, done: true, listed: 16, read: 16 });
    expect(tableMatches(await keptMatches(user.id), search)).toHaveLength(16);
    // two full searches were spent today (the first, and the other tab's), not three
    const [n] = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.role_searches where user_id = ${userId}::uuid`;
    expect(n!.n).toBe(2);
    // an id that never was a search is not found, and the browser reads that as an error it can show
    expect(
      await rolesCall(user.id, '/roles/more', { searchId: '00000000-0000-4000-8000-00000000abcd' }),
    ).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    checkWire(s.wire);
  });
});

// ---- one posting ---------------------------------------------------------------------------------------------------------

describe('a posting scored now', () => {
  it('by its text and by its link; a site Orbit cannot read asks for the text; no profile yet says so', async () => {
    await seedRoles();
    const s = server();
    const { user } = await studentWithProfile();
    s.wire.length = 0;
    const pasted = await scorePosting(user, {
      text: 'Data Engineer Intern at Lumen\nWhat you need:\nMust have Python.\nMust have SQL.\nMust have Airflow.',
    });
    expect(pasted, JSON.stringify(s.wire.at(-1))).toMatchObject({ ok: true });
    if (!pasted.ok) return;
    expect(pasted.match.job).toMatchObject({ source: 'posting', title: 'Data Engineer Intern at Lumen' });
    expect(pasted.match.fit!.score).toBeGreaterThanOrEqual(5);
    expect(pasted.match.answers!.skills.map((x) => x.answer)).toEqual(['work', 'work', 'none']);
    // a link to a board Orbit reads: the role, its text, a score
    const linked = await scorePosting(user, { url: NIMBUS_JOB });
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.match.job).toMatchObject({
      source: 'greenhouse',
      title: 'Software Engineering Intern, Payments',
      url: NIMBUS_JOB,
    });
    expect(linked.match.fit).toMatchObject({ score: 8, band: 'good' });
    // it is the role the board lists, not a second copy of it
    const [copies] = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit_private.jobs where source = 'greenhouse' and external_id = '7770001'`;
    expect(copies!.n).toBe(1);
    // a posting that was taken down, and a site with no posting Orbit can read: a line to show, never an error
    expect(await scorePosting(user, { url: 'https://boards.greenhouse.io/nimbuspay/jobs/9990001' })).toEqual({
      ok: false,
      message: 'That posting is no longer listed.',
    });
    const unreadable = await scorePosting(user, { url: 'https://careers.unreadable.example/jobs/1' });
    expect(unreadable.ok).toBe(false);
    if (!unreadable.ok) expect(unreadable.message).toMatch(/paste the posting.s text/i);
    // both scored postings are kept, so the panel opens on them and the table lists them with the search's roles
    const rows = await keptMatches(user.id);
    expect(rows.map((r) => r.match.id).sort()).toEqual([pasted.match.id, linked.match.id].sort());
    expect(tableMatches(rows, undefined)).toHaveLength(2);
    expect(await refreshMatches(user)).toEqual({ ok: true });
    expect(tableMatches(await keptMatches(user.id), await keptSearch(user.id))).toHaveLength(2);
    checkWire(s.wire);

    // a student with no profile yet: a problem that names the profile (the posting card links to Roles), not an error
    const fresh = await signedInUser(t);
    const them = await signIn(fresh.userId);
    s.wire.length = 0;
    const none = await scorePosting(them, { url: NIMBUS_JOB });
    expect(none).toEqual({ ok: false, message: NO_PROFILE });
    expect(NO_PROFILE).toMatch(/profile/i);
    expect(s.calls('/roles/score')[0]).toMatchObject({ status: 200, json: { problem: NO_PROFILE } });
    // and one who was only shown what Orbit read is in the same place
    await seedResume(them.id);
    expect((await readProfile(them, { resume: true, linkedin: false })).ok).toBe(true);
    expect(await scorePosting(them, { url: NIMBUS_JOB })).toEqual({ ok: false, message: NO_PROFILE });
    checkWire(s.wire);
  });
});

// ---- the model off --------------------------------------------------------------------------------------------------------

describe('the model unavailable', () => {
  it('every role comes ranked by what Orbit can read without it: no number, a note, and they stay listed', async () => {
    await seedRoles();
    // the profile is built while the model answers; then it is gone
    server();
    const { user } = await studentWithProfile();
    const { anthropicKey: _k, ...noModel } = ALL_KEYS;
    const s = server({ env: noModel });
    const out = await runSearch(user);
    expect(out).toEqual({ ok: true });
    const seen = checkWire(s.wire);
    // the search itself says it is over for now: nothing more is asked
    expect(seen).toEqual({ '/roles/search': 1 });
    const first = s.calls('/roles/search')[0]!.json as RolesSearchResponse;
    expect(first).toMatchObject({ listed: 16, read: 0, done: true, note: NOT_READ_NOTE });
    expect(first.matches).toHaveLength(16);
    expect(first.matches.every((m) => m.state === 'to_read' && !m.fit && m.roughFit)).toBe(true);
    const search = (await keptSearch(user.id))!;
    expect(search).toMatchObject({ done: true, note: NOT_READ_NOTE });
    // the browser lists them, each marked not read closely, none hidden by the least fit shown
    const table = tableMatches(await keptMatches(user.id), search);
    expect(table).toHaveLength(16);
    expect(table.every((m) => !m.fit && m.roughFit)).toBe(true);
    expect(filterMatches(table, DEFAULT_FILTERS)).toHaveLength(16);
    // by word: the role that names their skills is above the one that names none
    const sorted = sortMatches(table, 'fit');
    expect(sorted.at(-1)!.job.companyName).toBe('Beta');
    expect(sorted[0]!.roughFit).toMatchObject({ level: true, place: true });
    // saving one keeps it listed and still not read closely
    const one = await actOnMatch(user, table[0]!, 'saved');
    expect(one).toMatchObject({ ok: true, match: { status: 'saved', state: 'to_read' } });
    if (one.ok) expect(one.match.roughFit).toBeDefined();
    // the next visit brings the list up to date: they are still there, none read as taken down
    expect(await refreshMatches(user)).toEqual({ ok: true });
    const later = tableMatches(await keptMatches(user.id), await keptSearch(user.id));
    expect(later).toHaveLength(16);
    expect(later.every((m) => m.state === 'to_read' && m.roughFit)).toBe(true);
    checkWire(s.wire);
    // the model is back: the same search carries on and reads them
    const back = server();
    expect((await runSearch(user)).ok).toBe(true);
    await Promise.all(back.background);
    const done = (await keptSearch(user.id))!;
    expect(done).toMatchObject({ done: true, read: 16, searchId: search.searchId });
    const read = tableMatches(await keptMatches(user.id), done);
    expect(read).toHaveLength(16);
    expect(read.every((m) => m.fit && !m.roughFit)).toBe(true);
    expect(read.find((m) => m.id === table[0]!.id)!.status).toBe('saved');
    checkWire(back.wire);
  });
});

// keep the board list in step with the shared types (a new service must reach the readers and this test)
it('the board services the readers know are the ones the shared types name', () => {
  expect([...BOARD_SERVICES].sort()).toEqual(
    ['ashby', 'greenhouse', 'lever', 'recruitee', 'smartrecruiters', 'workable', 'workday'].sort(),
  );
  expect(harborBoard).toMatch(UUID);
});
