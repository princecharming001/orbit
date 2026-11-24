/**
 * Plan 44, Roles in the browser (§10, §13): the profile is read from the resume's kept lines and the LinkedIn profile;
 * a search is read in steps and carries on from where it stopped; a cancelled or replaced search drops its answers;
 * a profile changed mid-search starts on an empty table; the kept copy is what a reload or an offline visit shows;
 * what the student does with a role reaches the server; "Find a way in" plans for the role without overwriting a
 * target's own; the feature switch decides whether any of it exists.
 */
import { type FitAnswers, fitOf, type RoleProfile, type RolesSearchResponse, type User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { refreshAccount, setOrbitApiFetchForTests } from '../integrations/orbitApi';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import type { FakeOrbitApi } from '../test/fakeOrbitApi';
import { featureOn, setFeatureForTests } from './features';
import {
  actOnMatch,
  cancelSearch,
  DEFAULT_FILTERS,
  filterMatches,
  findWayIn,
  keptMatches,
  keptProfile,
  keptSearch,
  profileLines,
  readProfile,
  refreshMatches,
  resetRolesForTests,
  rolesCall,
  rolesMode,
  rolesRun,
  runSearch,
  STALLED_NOTE,
  savedMatches,
  saveProfile,
  scorePosting,
  searchRunning,
  setRolesPauseForTests,
  setRolesStallForTests,
  sortMatches,
  tableMatches,
} from './roles';
import { createRolesSim, NOT_READ_NOTE } from './rolesSim';

const T0 = '2026-11-24T12:00:00.000Z';

/**
 * The year the made-up student graduates: two years from now, so they are a student (graduating more than a year
 * away) whenever the suite runs. The level comes from dates by the server's own rule (core `profileLevelOf`): a
 * graduation within a year is a new grad, who is shown entry roles and not internships.
 */
const GRAD = new Date().getFullYear() + 2;

async function seedResume(userId: string) {
  await db.resumes.put({
    id: 'r_test',
    userId,
    filename: 'Maya_Lin_Resume.pdf',
    text: '',
    isCurrent: true,
    createdAt: T0,
    parsedAt: T0,
  });
  await db.resumeFacets.bulkPut([
    {
      id: 'f1',
      resumeId: 'r_test',
      kind: 'experience',
      title: 'Software Engineering Intern',
      organizationName: 'Brex',
      startDate: '2026-06-01',
      endDate: '2026-08-15',
      text: 'Built a reconciliation service in Go; wrote SQL reports for the finance team.',
      keywords: [],
      confirmed: true,
    },
    {
      id: 'f2',
      resumeId: 'r_test',
      kind: 'project',
      title: 'Campus marketplace',
      text: 'React and Postgres marketplace used by 800 students.',
      keywords: [],
      confirmed: true,
    },
    {
      id: 'f3',
      resumeId: 'r_test',
      kind: 'education',
      title: 'BS Computer Science',
      organizationName: 'Cornell University',
      endDate: `${GRAD}-05-31`,
      text: 'BS Computer Science. Courses: distributed systems, databases.',
      keywords: [],
      confirmed: true,
    },
    {
      id: 'f4',
      resumeId: 'r_test',
      kind: 'skill_group',
      text: 'Go, Python, SQL, React, TypeScript',
      keywords: [],
      confirmed: true,
    },
    // a line the student unticked: never sent
    {
      id: 'f5',
      resumeId: 'r_test',
      kind: 'experience',
      title: 'Barista',
      organizationName: 'Collegetown Bagels',
      text: 'Made coffee for a secret employer nobody should see.',
      keywords: [],
      confirmed: true,
      excluded: true,
    },
  ]);
}

describe('Roles in the browser, against the fake orbit-api', () => {
  let api: FakeOrbitApi;
  let user: User;
  beforeEach(async () => {
    await wipeDatabase();
    resetRolesForTests();
    ({ api, user } = await signInToFakeApi());
    api.state.features = ['roles'];
    // five a step instead of the server's fifteen, so the sample roles take several steps
    api.state.roles = createRolesSim({ step: 5 });
    await refreshAccount();
    await seedResume(user.id);
  });
  afterEach(async () => {
    resetRolesForTests();
    setFeatureForTests('roles', undefined);
    await leaveFakeApi();
  });

  const routes = () => api.state.roleCalls.map((c) => c.route);

  async function built(): Promise<RoleProfile> {
    const r = await readProfile(user, { resume: true, linkedin: false });
    if (!r.ok) throw new Error(r.message);
    return r.proposed;
  }

  it('the feature switch: on for the account only when the server says so, never for a local copy', async () => {
    expect(featureOn('roles', user.id)).toBe(true);
    expect(rolesMode(user.id)).toBe('server');
    api.state.features = [];
    await refreshAccount();
    expect(featureOn('roles', user.id)).toBe(false);
    expect(rolesMode(user.id)).toBe('off');
    expect(featureOn('roles', 'some-local-user')).toBe(false);
    expect(rolesMode('demo-user')).toBe('demo');
    // the owner tries it before it is launched: on for their account while the public switch stays off
    api.state.isOwner = true;
    await refreshAccount();
    expect(api.state.features).toEqual([]);
    expect(featureOn('roles', user.id)).toBe(true);
    expect(rolesMode(user.id)).toBe('server');
    expect((await rolesCall(user.id, '/roles/list', {})).ok).toBe(true);
    // anyone else is refused while it is not offered
    api.state.isOwner = false;
    expect(await rolesCall(user.id, '/roles/list', {})).toMatchObject({ ok: false, status: 404 });
  });

  it('sends the kept resume lines, never an unticked one, and LinkedIn job descriptions when asked', async () => {
    await db.kv.put({
      key: `self:linkedin:${user.id}`,
      value: {
        readAt: T0,
        v: 2,
        profile: {
          experience: [
            {
              title: 'Software Engineering Intern',
              company: 'Brex',
              current: false,
              start: '2026-06',
              end: '2026-08',
              description: 'Built the card reconciliation service.',
            },
          ],
          education: [
            { school: 'Cornell University', degree: 'BS', field: 'Computer Science', end: String(GRAD) },
          ],
          throttled: [],
          skills: ['Go', 'Kubernetes'],
        },
      },
    });
    const lines = await profileLines(user, { resume: true, linkedin: true });
    expect(JSON.stringify(lines)).not.toContain('Barista');
    expect(lines.resume?.experience).toHaveLength(1);
    expect(lines.resume?.skills).toEqual(['Go', 'Python', 'SQL', 'React', 'TypeScript']);
    expect(lines.resume?.courses).toEqual(['distributed systems', 'databases']);
    expect(lines.linkedin?.positions[0]?.description).toBe('Built the card reconciliation service.');
    const only = await profileLines(user, { resume: false, linkedin: true });
    expect(only.resume).toBeUndefined();
  });

  it('reads the profile, then the search in steps: /roles/search once, /roles/more until done, every row kept', async () => {
    const p = await built();
    expect(p.level).toBe('student');
    expect(p.wants.levels).toEqual(['intern']);
    expect(p.skills.map((s) => s.name)).toContain('Go');
    // never guessed
    expect(p.eligibility).toEqual({});
    const r = await saveProfile(user, p, { search: false });
    expect(r.ok).toBe(true);
    const out = await runSearch(user);
    expect(out.ok).toBe(true);
    const calls = routes();
    expect(calls.filter((c) => c === '/roles/search')).toHaveLength(1);
    const search = await keptSearch(user.id);
    expect(search?.done).toBe(true);
    expect(search?.listed).toBeGreaterThan(5);
    // a step reads five here: listed / 5 calls, rounded up
    expect(calls.filter((c) => c === '/roles/more')).toHaveLength(Math.ceil(search!.listed / 5));
    const rows = tableMatches(await keptMatches(user.id), search);
    expect(rows).toHaveLength(search!.listed);
    expect(rows.every((m) => m.fit && m.fit.score >= 1 && m.fit.score <= 10)).toBe(true);
    // only internships for a student
    expect(rows.every((m) => m.job.level === 'intern' || !m.job.level)).toBe(true);
  });

  it('waits between /roles/more calls (the server reads in the background), and an answer of every row read so far replaces rows by id', async () => {
    await saveProfile(user, await built(), { search: false });
    setRolesPauseForTests(60);
    // the production server: it answers at once and reads behind the answer, so the first answers hold nothing new,
    // then each holds every row read so far, `done` false until all are read
    const at: number[] = [];
    const answers: { read: number; done: boolean; ids: string[] }[] = [];
    let asked = 0;
    setOrbitApiFetchForTests(async (input, init) => {
      if (!String(input).endsWith('/roles/more')) return api.fetch(input, init);
      at.push(Date.now());
      // every other ask finds the background read still going: the same rows as before, nothing more read
      const res = ++asked % 2 === 1 && answers.length ? undefined : await api.fetch(input, init);
      if (!res) {
        const last = answers.at(-1)!;
        const kept = (await keptMatches(user.id)).map((r) => r.match).filter((m) => last.ids.includes(m.id));
        answers.push(last);
        return Response.json({ ...lastBody, matches: kept, read: last.read, done: false });
      }
      const body = (await res.clone().json()) as RolesSearchResponse;
      lastBody = body;
      answers.push({ read: body.read, done: body.done, ids: body.matches.map((m) => m.id) });
      return res;
    });
    let lastBody: RolesSearchResponse | undefined;
    try {
      expect((await runSearch(user)).ok).toBe(true);
    } finally {
      setRolesPauseForTests(undefined);
    }
    // it waited between asks, never a tight loop
    expect(at.length).toBeGreaterThan(3);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(50);
    // each answer was the whole of what is read so far, growing, and only the last said done
    expect(answers.map((a) => a.done)).toEqual([...answers.slice(0, -1).map(() => false), true]);
    for (let i = 1; i < answers.length; i++)
      expect(answers[i]!.read).toBeGreaterThanOrEqual(answers[i - 1]!.read);
    expect(answers.at(-1)!.ids.length).toBe(answers.at(-1)!.read);
    expect(
      answers.some((a, i) => i > 0 && a.ids.length > 5 && a.ids.length < answers.at(-1)!.ids.length),
    ).toBe(true);
    // and no row is kept twice: the table has each role once
    const s = await keptSearch(user.id);
    expect(s).toMatchObject({ done: true, read: s!.listed });
    const rows = tableMatches(await keptMatches(user.id), s);
    expect(rows).toHaveLength(s!.listed);
    expect(new Set(rows.map((m) => m.id)).size).toBe(rows.length);
    expect((await keptMatches(user.id)).length).toBe(rows.length);
  });

  it('nothing more read for a long while: it stops asking, lists the rest as not read closely, and carries on next time', async () => {
    await saveProfile(user, await built(), { search: false });
    // a clock the test moves: each ask of /roles/more is 20 seconds after the last
    let clock = 0;
    setRolesStallForTests(90_000, () => clock);
    let asked = 0;
    let stuck: RolesSearchResponse | undefined;
    setOrbitApiFetchForTests(async (input, init) => {
      if (!String(input).endsWith('/roles/more')) return api.fetch(input, init);
      asked++;
      clock += 20_000;
      // the first ask reads five; after that the background read has died: the same answer, never done
      if (!stuck) {
        const res = await api.fetch(input, init);
        stuck = (await res.clone().json()) as RolesSearchResponse;
        return res;
      }
      return Response.json(stuck);
    });
    try {
      const out = await runSearch(user);
      // not an error: a polite stop
      expect(out).toEqual({ ok: true });
    } finally {
      setRolesStallForTests(undefined);
    }
    // 20 s an ask: the first reads, then five more with nothing new reach 100 s without progress, past 90
    expect(asked).toBe(6);
    expect(searchRunning(user.id)).toBe(false);
    expect(rolesRun(user.id)).toMatchObject({ phase: 'idle', error: undefined });
    const s = await keptSearch(user.id);
    expect(s).toMatchObject({ done: false, read: 5, note: STALLED_NOTE });
    expect(STALLED_NOTE).not.toMatch(/[—!]/);
    // what was read keeps its score; the rest are listed too, with no number
    const rows = tableMatches(await keptMatches(user.id), s);
    expect(rows).toHaveLength(s!.listed);
    expect(rows.filter((m) => m.fit)).toHaveLength(5);
    const rest = rows.filter((m) => !m.fit);
    expect(rest.length).toBe(s!.listed - 5);
    expect(rest.every((m) => m.roughFit && m.state === 'to_read')).toBe(true);
    expect(routes().filter((c) => c === '/roles/list').length).toBeGreaterThan(0);
    expect(api.state.roleCalls.find((c) => c.route === '/roles/list' && c.body.rest === true)).toBeTruthy();
    // the least fit shown never hides a role that has no number
    expect(filterMatches(rows, DEFAULT_FILTERS).filter((m) => !m.fit)).toHaveLength(rest.length);
    // the next visit carries on from there, with no new search, and the line that said it stopped goes
    const before = routes().filter((c) => c === '/roles/search').length;
    setOrbitApiFetchForTests(api.fetch);
    expect((await runSearch(user, { resume: true })).ok).toBe(true);
    expect(routes().filter((c) => c === '/roles/search').length).toBe(before);
    const done = await keptSearch(user.id);
    expect(done).toMatchObject({ done: true, searchId: s!.searchId, read: s!.listed });
    expect(done?.note).toBeUndefined();
    const all = tableMatches(await keptMatches(user.id), done);
    expect(all).toHaveLength(done!.listed);
    expect(all.every((m) => m.fit && !m.roughFit)).toBe(true);
  });

  it('a search that still makes progress, however slowly, is never given up on', async () => {
    await saveProfile(user, await built(), { search: false });
    let clock = 0;
    setRolesStallForTests(90_000, () => clock);
    api.state.roles = createRolesSim({ step: 1 });
    await api.state.roles.handle('/roles/profile', { save: (await keptProfile(user.id))!.profile });
    setOrbitApiFetchForTests(async (input, init) => {
      // 80 seconds between asks, one more role read each time: slow, and alive
      if (String(input).endsWith('/roles/more')) clock += 80_000;
      return api.fetch(input, init);
    });
    try {
      expect((await runSearch(user)).ok).toBe(true);
    } finally {
      setRolesStallForTests(undefined);
    }
    const s = await keptSearch(user.id);
    expect(s).toMatchObject({ done: true, read: s!.listed });
    expect(s?.note).toBeUndefined();
  });

  it('a search another tab replaced: /roles/more answers 404 search_replaced, and the loop follows the newer search', async () => {
    await saveProfile(user, await built(), { search: false });
    let more = 0;
    let newer: string | undefined;
    setOrbitApiFetchForTests(async (input, init) => {
      // after the first step another tab presses Search again: the server has a newer search for the same profile
      if (String(input).endsWith('/roles/more') && ++more === 2 && !newer) {
        const r = await api.state.roles.handle('/roles/search', { fresh: true });
        newer = r.ok ? (r.value as RolesSearchResponse).searchId : undefined;
      }
      return api.fetch(input, init);
    });
    expect((await runSearch(user)).ok).toBe(true);
    const calls = api.state.roleCalls.filter((c) => c.route === '/roles/search');
    // the loop asked which search to follow, once, and did not start one of its own (that would replace the newer
    // one in turn, and spend one of the day's three searches)
    expect(calls.map((c) => c.body)).toEqual([{}, {}]);
    const s = await keptSearch(user.id);
    expect(newer).toBeTruthy();
    expect(s).toMatchObject({ searchId: newer, done: true });
    const rows = tableMatches(await keptMatches(user.id), s);
    expect(rows).toHaveLength(s!.listed);
    expect(new Set(rows.map((m) => m.id)).size).toBe(rows.length);
  });

  it('a search the server no longer has is asked about once, then the loop stops with what the server said', async () => {
    await saveProfile(user, await built(), { search: false });
    // every /roles/more is refused, whatever the search: the loop must not go round for ever
    let more = 0;
    setOrbitApiFetchForTests(async (input, init) => {
      if (!String(input).endsWith('/roles/more')) return api.fetch(input, init);
      more++;
      return Response.json(
        { error: { code: 'search_replaced', message: 'That search was replaced by a newer one.' } },
        { status: 404 },
      );
    });
    const out = await runSearch(user);
    expect(out.ok).toBe(false);
    expect(more).toBe(2);
    expect(routes().filter((c) => c === '/roles/search')).toHaveLength(2);
    expect(rolesRun(user.id).error).toBeTruthy();
  });

  it('Roles switched off mid-search (404 not_offered) is not a replaced search: nothing is asked again', async () => {
    await saveProfile(user, await built(), { search: false });
    let more = 0;
    setOrbitApiFetchForTests(async (input, init) => {
      if (String(input).endsWith('/roles/more') && ++more === 2) api.state.features = [];
      return api.fetch(input, init);
    });
    const out = await runSearch(user);
    expect(out.ok).toBe(false);
    expect(routes().filter((c) => c === '/roles/search')).toHaveLength(1);
    expect(routes().filter((c) => c === '/roles/more')).toHaveLength(2);
  });

  it('carries on from where it stopped, without listing the roles again', async () => {
    await saveProfile(user, await built(), { search: false });
    // the first /roles/more answers, the second never does (the student left and the tab closed)
    let more = 0;
    setOrbitApiFetchForTests(async (input, init) => {
      if (String(input).endsWith('/roles/more') && ++more === 2) {
        cancelSearch(user.id);
        throw new TypeError('network down');
      }
      return api.fetch(input, init);
    });
    await runSearch(user);
    const half = await keptSearch(user.id);
    expect(half?.done).toBe(false);
    expect(half?.read).toBe(5);
    const before = routes().filter((c) => c === '/roles/search').length;
    setOrbitApiFetchForTests(api.fetch);
    await runSearch(user, { resume: true });
    expect(routes().filter((c) => c === '/roles/search').length).toBe(before);
    const done = await keptSearch(user.id);
    expect(done?.done).toBe(true);
    expect(done?.searchId).toBe(half?.searchId);
    expect(tableMatches(await keptMatches(user.id), done)).toHaveLength(done!.listed);
  });

  it('a cancelled search stops asking, and an answer that lands after is dropped', async () => {
    await saveProfile(user, await built(), { search: false });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    setOrbitApiFetchForTests(async (input, init) => {
      if (String(input).endsWith('/roles/more')) await gate;
      return api.fetch(input, init);
    });
    const running = runSearch(user);
    await new Promise((r) => setTimeout(r, 30));
    cancelSearch(user.id);
    release();
    expect((await running).ok).toBe(false);
    expect(routes().filter((c) => c === '/roles/more')).toHaveLength(1);
    // the one answer that came back after the cancel was not kept
    const s = await keptSearch(user.id);
    expect(tableMatches(await keptMatches(user.id), s)).toHaveLength(0);
  });

  it('a profile changed mid-search drops the old rows: nothing scored for the old profile appears', async () => {
    const p = await built();
    await saveProfile(user, p, { search: false });
    await runSearch(user);
    const old = await keptSearch(user.id);
    const oldIds = tableMatches(await keptMatches(user.id), old).map((m) => m.id);
    expect(oldIds.length).toBeGreaterThan(0);
    // a slow search for the old profile is under way when the student changes it
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let gated = true;
    setOrbitApiFetchForTests(async (input, init) => {
      if (gated && String(input).endsWith('/roles/more')) await gate;
      return api.fetch(input, init);
    });
    const slow = runSearch(user, { fresh: true });
    await new Promise((r) => setTimeout(r, 30));
    gated = false;
    const changed: RoleProfile = {
      ...p,
      kinds: p.kinds.map((k) => ({ ...k, on: k.title === 'Data analyst' })),
    };
    await saveProfile(user, changed, { search: false });
    release();
    await slow;
    // the table is empty until the new profile's search answers
    expect(tableMatches(await keptMatches(user.id), await keptSearch(user.id))).toHaveLength(0);
    await runSearch(user);
    const now = await keptSearch(user.id);
    expect(now?.searchId).not.toBe(old?.searchId);
    const rows = tableMatches(await keptMatches(user.id), now);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((m) => m.job.family === 'data_ml')).toBe(true);
  });

  it('the kept copy is what a reload or an offline visit shows, with when it was read', async () => {
    await saveProfile(user, await built(), { search: false });
    await runSearch(user);
    const before = tableMatches(await keptMatches(user.id), await keptSearch(user.id));
    // offline: the server cannot be reached
    setOrbitApiFetchForTests(async () => {
      throw new TypeError('offline');
    });
    const r = await refreshMatches(user);
    expect(r).toEqual({ ok: false, offline: true });
    resetRolesForTests();
    const s = await keptSearch(user.id);
    expect(s?.at).toBeTruthy();
    expect(tableMatches(await keptMatches(user.id), s).map((m) => m.id)).toEqual(before.map((m) => m.id));
  });

  it('save, applied and not for me with a reason: kept here and on the server; a dismissed role leaves the table', async () => {
    await saveProfile(user, await built(), { search: false });
    await runSearch(user);
    const s = await keptSearch(user.id);
    const [a, b] = sortMatches(tableMatches(await keptMatches(user.id), s), 'fit');
    expect((await actOnMatch(user, a!, 'saved')).ok).toBe(true);
    expect((await actOnMatch(user, a!, 'applied')).ok).toBe(true);
    expect((await actOnMatch(user, b!, 'dismissed', 'place')).ok).toBe(true);
    expect(api.state.roles.state().matches[a!.id]?.status).toBe('applied');
    expect(api.state.roles.state().matches[b!.id]).toMatchObject({
      status: 'dismissed',
      dismissReason: 'place',
    });
    const rows = await keptMatches(user.id);
    expect(tableMatches(rows, s).some((m) => m.id === b!.id)).toBe(false);
    expect(savedMatches(rows).map((m) => m.id)).toEqual([a!.id]);
    const log = await db.audit.where('userId').equals(user.id).toArray();
    expect(log.map((e) => e.action)).toEqual(
      expect.arrayContaining(['roles.profile_built', 'roles.search_run', 'roles.saved', 'roles.dismissed']),
    );
    expect(log.find((e) => e.action === 'roles.dismissed')?.metadata.reason).toBe('place');
  });

  it('a posting taken down leaves the table and stays in Saved, no longer listed', async () => {
    await saveProfile(user, await built(), { search: false });
    await runSearch(user);
    const s = await keptSearch(user.id);
    const [a, b] = tableMatches(await keptMatches(user.id), s);
    await actOnMatch(user, a!, 'saved');
    await api.state.roles.close(a!.job.id);
    await api.state.roles.close(b!.job.id);
    await refreshMatches(user);
    const rows = await keptMatches(user.id);
    const table = tableMatches(rows, await keptSearch(user.id));
    expect(table.some((m) => m.id === a!.id || m.id === b!.id)).toBe(false);
    const saved = savedMatches(rows).find((m) => m.id === a!.id);
    expect(saved?.job.closedAt).toBeTruthy();
  });

  it('the model unavailable: rows ranked by what can be read without it, no number, and a note', async () => {
    await api.state.roles.setModelOff(true);
    await saveProfile(user, await built(), { search: false });
    await runSearch(user);
    const s = await keptSearch(user.id);
    expect(s?.note).toBe(NOT_READ_NOTE);
    const rows = tableMatches(await keptMatches(user.id), s);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((m) => !m.fit && m.roughFit)).toBe(true);
    // the least fit shown never hides a role that has no number
    expect(filterMatches(rows, DEFAULT_FILTERS)).toHaveLength(rows.length);
  });

  it('a pasted posting is scored now; a site Orbit cannot read asks for the text', async () => {
    await saveProfile(user, await built(), { search: false });
    const known = await scorePosting(user, { url: 'https://boards.greenhouse.io/stripe/jobs/6120000' });
    expect(known.ok && known.match.job.companyName).toBe('Stripe');
    const linkedin = await scorePosting(user, { url: 'https://www.example.com/careers/123' });
    expect(linkedin).toEqual({
      ok: false,
      message: "Orbit cannot read this site. Paste the posting's text.",
    });
    const text = await scorePosting(user, {
      text: 'Backend Engineer Intern at Acme Pay\nYou will write Go services and SQL. Kubernetes is a plus.',
    });
    expect(text.ok && text.match.job.title).toBe('Backend Engineer Intern');
    expect(text.ok && text.match.answers?.skills.map((x) => x.name)).toEqual(
      expect.arrayContaining(['Go', 'SQL', 'Kubernetes']),
    );
  });

  it('Find a way in: a new target with the role; a target with another role keeps its own, and the plan is for this one', async () => {
    await saveProfile(user, await built(), { search: false });
    await runSearch(user);
    const rows = tableMatches(await keptMatches(user.id), await keptSearch(user.id));
    const stripe = rows.find((m) => m.job.companyName === 'Stripe')!;
    const r = await findWayIn(user, stripe);
    expect(r.added).toBe(true);
    expect(r.plan.posting).toMatchObject({ company: 'Stripe', role: stripe.job.title, url: stripe.job.url });
    const t = await db.targetCompanies.where('userId').equals(user.id).first();
    expect(t?.role).toBe(stripe.job.title);
    expect(r.orgId).toBeTruthy();
    // Ramp is a target already, for another role
    await db.targetCompanies.put({
      id: 'tc_ramp',
      userId: user.id,
      nameRaw: 'Ramp',
      priority: 2,
      status: 'researching',
      role: 'Product Manager Intern',
    });
    const ramp = rows.find((m) => m.job.companyName === 'Ramp')!;
    const again = await findWayIn(user, ramp);
    expect(again.added).toBe(false);
    expect((await db.targetCompanies.get('tc_ramp'))?.role).toBe('Product Manager Intern');
    expect(again.plan.posting.role).toBe(ramp.job.title);
    expect(again.plan.targetCompanyId).toBe('tc_ramp');
  });
});

describe('the score (the sample server keeps the plan 44 formula)', () => {
  it('1 and 10 are both reachable, a silent part is left out, and caps hold a score down', () => {
    const none = fitOf({
      skills: [{ name: 'Go', need: 'must', answer: 'none' }],
      experience: { answer: 'none' },
      education: { answer: 'no' },
      level: { answer: 'far' },
      caps: [],
      reason: '',
      gaps: [],
    });
    expect(none.score).toBe(1);
    const answers: FitAnswers = {
      skills: [
        { name: 'Go', need: 'must', answer: 'work' },
        { name: 'SQL', need: 'nice', answer: 'work' },
      ],
      experience: { answer: 'same' },
      education: { answer: 'unsaid' },
      level: { answer: 'at' },
      caps: [],
      reason: '',
      gaps: [],
    };
    const all = fitOf(answers);
    expect(all.score).toBe(10);
    expect(all.parts.education).toBeUndefined();
    expect(all.weights.skills! + all.weights.experience! + all.weights.level!).toBeCloseTo(1);
    const capped = fitOf({ ...answers, caps: [{ kind: 'thin', label: 'The posting says little' }] });
    expect(capped.score).toBe(7);
    expect(capped.raw).toBe(10);
  });

  it('the demo search runs on the sample server in the browser, with no Orbit account', async () => {
    const sim = createRolesSim({ step: 6 });
    const r = await sim.handle('/roles/search', {});
    expect(r).toMatchObject({ ok: false, code: 'no_profile' });
  });
});
