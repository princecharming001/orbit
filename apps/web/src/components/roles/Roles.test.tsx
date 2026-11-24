/**
 * Plan 44 §13, the browser's components: the Roles page against the fake orbit-api (the real client, the real
 * shapes). The profile screen (edit a skill, untick a kind, widen the level, answer once), the table (sort, filters,
 * range pick, keyboard, keeps its place on return), the panel (parts, quotes, gaps, the way in), every state in §2.5,
 * the narrow layout, and the chat's card and the posting card's score.
 */
import type { User } from '@orbit/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ user: undefined as unknown, userId: undefined as string | undefined }));
vi.mock('../../state/session', () => ({
  useSession: () => ({ user: session.user, userId: session.userId }),
}));
// a logo is a lookup of its own; the rows only need the name beside it
vi.mock('../CompanyLogo', () => ({ CompanyLogo: () => null }));
// who could introduce them is the company page's graph: not what these tests are about
vi.mock('../../engine/graph', async (orig) => ({
  ...(await orig<typeof import('../../engine/graph')>()),
  reachCompany: vi.fn(async () => ({
    people: [],
    direct: [],
    saved: [],
    former: [],
    alumni: [],
    twoHop: [],
  })),
}));

import { PlanFit } from '../../chat/ui/cards/PlanFit';
import { RolesCard } from '../../chat/ui/cards/RolesCard';
import { db, wipeDatabase } from '../../db/schema';
import { setFeatureForTests } from '../../engine/features';
import { keptMatches, keptProfile, keptSearch, resetRolesForTests, tableMatches } from '../../engine/roles';
import { SAMPLE_JOBS } from '../../engine/rolesSample';
import { createRolesSim, NOT_READ_NOTE } from '../../engine/rolesSim';
import { refreshAccount, setOrbitApiFetchForTests } from '../../integrations/orbitApi';
import { RolesPage } from '../../pages/Roles';
import { forgetViews } from '../../state/viewState';
import { leaveFakeApi, signInToFakeApi } from '../../test/account';
import type { FakeOrbitApi } from '../../test/fakeOrbitApi';
import { ToastProvider } from '../../ui';
import { RolesTable, whyWords } from './RolesTable';

const T0 = '2026-11-24T12:00:00.000Z';

/**
 * The year the made-up student graduates: two years from now, so they are a student (graduating more than a year
 * away) whenever the suite runs. The level comes from dates by the server's own rule (core `profileLevelOf`): a
 * graduation within a year is a new grad, who is shown entry roles and not internships.
 */
const GRAD = new Date().getFullYear() + 2;

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
      title: 'Software Engineering Intern',
      organizationName: 'Brex',
      startDate: '2026-06-01',
      endDate: '2026-08-15',
      text: 'Built a reconciliation service in Go; wrote SQL reports for the finance team.',
      keywords: [],
      confirmed: true,
    },
    {
      id: `f2_${userId}`,
      resumeId: `r_${userId}`,
      kind: 'project',
      title: 'Campus marketplace',
      text: 'React and Postgres marketplace used by 800 students.',
      keywords: [],
      confirmed: true,
    },
    {
      id: `f3_${userId}`,
      resumeId: `r_${userId}`,
      kind: 'education',
      title: 'BS Computer Science',
      organizationName: 'Cornell University',
      endDate: `${GRAD}-05-31`,
      text: 'BS Computer Science.',
      keywords: [],
      confirmed: true,
    },
    {
      id: `f4_${userId}`,
      resumeId: `r_${userId}`,
      kind: 'skill_group',
      text: 'Go, Python, SQL, React, TypeScript',
      keywords: [],
      confirmed: true,
    },
  ]);
}

let api: FakeOrbitApi;
let user: User;
let host: HTMLDivElement;
let root: Root;
let where = '';

function Where() {
  const loc = useLocation();
  where = `${loc.pathname}${loc.search}`;
  return null;
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await wipeDatabase();
  resetRolesForTests();
  ({ api, user } = await signInToFakeApi());
  api.state.features = ['roles'];
  // four a step, so the sample roles take several steps as the server's sixty would
  api.state.roles = createRolesSim({ step: 4 });
  await refreshAccount();
  await seedResume(user.id);
  session.user = user;
  session.userId = user.id;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  resetRolesForTests();
  forgetViews();
  setFeatureForTests('roles', undefined);
  await leaveFakeApi();
});

const $ = (id: string, within: ParentNode = document.body) =>
  within.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const $$ = (id: string, within: ParentNode = document.body) => [
  ...within.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];
const click = (el: Element | null, init: MouseEventInit = {}) =>
  act(async () => {
    if (!el) throw new Error('nothing to click');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  });
async function until(fn: () => unknown, ms = 5000) {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${fn.toString()}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}
async function choose(select: HTMLElement | null, value: string) {
  await act(async () => {
    const s = select as HTMLSelectElement;
    s.value = value;
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function key(el: Element | null, k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    el!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });
}

async function show(path = '/roles') {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <Where />
          <Routes>
            <Route path="/roles" element={<RolesPage />} />
            <Route path="/companies/:id" element={<div data-testid="company-page" />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    );
  });
}

/** The first visit through to the table: read the resume, accept what Orbit read, Find roles, every role read. */
async function buildAndSearch() {
  await show();
  await until(() => $('roles-first-visit') && $('profile-use-resume'));
  await click($('profile-read'));
  await until(() => $('roles-profile'));
  await click($('profile-find'));
  await until(() => $$('role-row').length > 0 && !$('roles-reading'));
}

const titles = () => $$('role-title').map((b) => b.textContent);

describe('the first visit and the profile screen', () => {
  it('reads a resume only: where they are, skills as chips, kinds with why, sponsorship not guessed', async () => {
    await show();
    await until(() => $('profile-use-resume'));
    expect($('roles-first-visit')!.textContent).toContain('Use my resume');
    // LinkedIn is not connected: it is not offered
    expect($('profile-use-linkedin')).toBeNull();
    expect(($('profile-use-resume') as HTMLInputElement).checked).toBe(true);
    await click($('profile-read'));
    await until(() => $('roles-profile'));
    expect($('profile-where-line')!.textContent).toBe(
      `Student, B.S. Computer Science, Cornell University, graduating May ${GRAD}`,
    );
    expect($$('profile-skills-chip').map((c) => c.textContent)).toEqual(
      expect.arrayContaining(['Go', 'Python', 'SQL', 'React', 'TypeScript']),
    );
    const kinds = $$('profile-kind');
    expect(kinds.length).toBeGreaterThanOrEqual(3);
    expect(kinds.length).toBeLessThanOrEqual(6);
    expect(kinds[0]!.textContent).toContain('Software engineer');
    expect(kinds[0]!.textContent).toContain('From your Brex internship');
    // levels to look at default from the profile's level: a student looks at internships
    expect($('profile-level-chip-intern')!.getAttribute('aria-pressed')).toBe('true');
    expect($('profile-level-chip-entry')!.getAttribute('aria-pressed')).toBe('false');
    // asked once, never guessed
    expect($('profile-sponsorship-yes')!.getAttribute('aria-pressed')).toBe('false');
    expect($('profile-sponsorship-no')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('the server leaves the levels to the profile: they show ticked, and Find roles is ready at once', async () => {
    await show();
    await until(() => $('profile-use-resume'));
    await click($('profile-read'));
    await until(() => $('roles-profile'));
    // what the server sent has no levels picked (it means the ones that fit a student)
    expect(api.state.roles.state().proposed?.wants.levels).toEqual([]);
    expect($('profile-level-chip-intern')!.getAttribute('aria-pressed')).toBe('true');
    expect(($('profile-find') as HTMLButtonElement).disabled).toBe(false);
  });

  it('left before Find roles, then a reload: the review opens on what Orbit read, with no second read and no search', async () => {
    await show();
    await until(() => $('profile-use-resume'));
    await click($('profile-read'));
    await until(() => $('roles-profile'));
    const reads = () => api.state.roleCalls.filter((c) => c.route === '/roles/profile' && 'read' in c.body);
    expect(reads()).toHaveLength(1);
    // the reload: the page's own memory is gone, the server still has what it read
    act(() => root.unmount());
    forgetViews();
    resetRolesForTests();
    root = createRoot(host);
    await show();
    await until(() => $('roles-profile'));
    expect($('profile-where-line')!.textContent).toBe(
      `Student, B.S. Computer Science, Cornell University, graduating May ${GRAD}`,
    );
    expect(reads()).toHaveLength(1);
    // nothing was searched on a profile the student never confirmed
    expect(api.state.roleCalls.some((c) => c.route === '/roles/search')).toBe(false);
    expect(await keptProfile(user.id)).toBeUndefined();
    await click($('profile-find'));
    await until(() => $$('role-row').length > 0);
    expect(api.state.roles.state().profile).toBeTruthy();
  });

  it('edit a skill, untick a kind, widen the level and answer sponsorship: the saved profile has each', async () => {
    await show();
    await until(() => $('profile-use-resume'));
    await click($('profile-read'));
    await until(() => $('roles-profile'));
    await click(document.querySelector('[aria-label="Remove Python"]'));
    await type($('profile-skills-input') as HTMLInputElement, 'Rust');
    await key($('profile-skills-input'), 'Enter');
    const fullStack = $$('profile-kind').find((k) => k.textContent?.includes('Full stack engineer'))!;
    await click($('profile-kind-tick', fullStack));
    await click($('profile-level-chip-entry'));
    await click($('profile-sponsorship-no'));
    await click($('profile-find'));
    await until(() => api.state.roles.state().profile);
    const saved = api.state.roles.state().profile!;
    expect(saved.skills.map((s) => s.name)).not.toContain('Python');
    expect(saved.skills.find((s) => s.name === 'Rust')).toMatchObject({ from: 'added' });
    expect(saved.kinds.find((k) => k.title === 'Full stack engineer')?.on).toBe(false);
    expect(saved.wants.levels).toEqual(['intern', 'entry']);
    expect(saved.eligibility).toEqual({ needsSponsorship: false });
    // the widened level reaches the search: a new grad role is listed too
    await until(() => $$('role-row').length > 0 && !$('roles-reading'));
    expect(titles()).toContain('Software Engineer, New Grad');
  });

  it('LinkedIn only, with titles but no descriptions: it reads, and says so above the table', async () => {
    await db.resumes.clear();
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
            },
          ],
          education: [
            { school: 'Cornell University', degree: 'BS', field: 'Computer Science', end: String(GRAD) },
          ],
          throttled: [],
          skills: ['Go', 'SQL', 'TypeScript'],
        },
      },
    });
    await show();
    await until(() => $('profile-use-linkedin'));
    expect($('profile-use-resume')).toBeNull();
    await click($('profile-read'));
    await until(() => $('roles-profile'));
    expect($('profile-note')!.textContent).toBe(
      'Your LinkedIn profile lists your roles but not what you did in them. Add a resume for a closer read.',
    );
    await click($('profile-find'));
    await until(() => $$('role-row').length > 0 && !$('roles-reading'));
    expect($('roles-note-linkedin')!.textContent).toContain('lists your roles but not what you did in them');
  });
});

describe('the Roles table', () => {
  it('lists every read role best fit first, with its columns; sort and filters change it', async () => {
    await buildAndSearch();
    const heads = [...document.querySelectorAll('[data-testid="roles-table"] thead th')].map((th) =>
      th.textContent?.trim(),
    );
    expect(heads).toEqual(['Role', 'Company', 'Fit', 'Why', 'Path', 'Where', 'Posted', 'Actions']);
    const scores = $$('role-fit').map((f) => Number(f.dataset.score));
    expect(scores.length).toBeGreaterThan(3);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    // the least fit shown is 6 by default
    expect(scores.every((s) => s >= 6)).toBe(true);
    // a company the student has no page for links to the map's reach view
    const company = $('role-company', $$('role-row')[0]!)!;
    expect(company.getAttribute('href')).toMatch(/^\/map\?reach=1&company=/);
    expect($$('role-path')[0]!.dataset.kind).toBe('none');
    // newest first
    await choose($('roles-sort'), 'newest');
    const posted = $$('role-row').map((r) => r.querySelectorAll('td')[6]!.textContent);
    expect(posted[0]).toMatch(/^(Today|Yesterday)$/);
    // remote only
    await click($('roles-remote'));
    expect($$('role-row').length).toBeGreaterThan(0);
    for (const r of $$('role-row')) expect(r.textContent).toContain('Remote');
    await click($('roles-filters-clear'));
    // a kind of role as a chip
    const n = $$('role-row').length;
    await choose($('roles-min-fit'), '8');
    expect($$('role-row').length).toBeLessThan(n);
    expect($$('role-fit').every((f) => Number(f.dataset.score) >= 8)).toBe(true);
  });

  it('Shift picks a range, as in Find people, and the picked ones can be saved together', async () => {
    await buildAndSearch();
    const rows = $$('role-row');
    await click($('role-pick', rows[0]!));
    await click($('role-pick', rows[3]!), { shiftKey: true });
    expect($$('role-pick').filter((p) => (p as HTMLInputElement).checked)).toHaveLength(4);
    expect($('roles-picked')!.textContent).toContain('4 picked');
    await click($('roles-save-picked'));
    await until(
      () => Object.values(api.state.roles.state().matches).filter((m) => m.status === 'saved').length === 4,
    );
  });

  it('works from the keyboard: arrows move, Enter opens, S saves, X says not for me', async () => {
    await buildAndSearch();
    const table = $('roles-table')!;
    await key(table, 'ArrowDown');
    await key(table, 'ArrowDown');
    const second = $$('role-row')[1]!;
    expect(second.dataset.active).toBe('true');
    const id = second.dataset.id!;
    await key(table, 's');
    await until(() => api.state.roles.state().matches[id]?.status === 'saved');
    await key(table, 'Enter');
    await until(() => $('role-panel'));
    expect(where).toContain(`role=${id}`);
    await click($('role-drawer-close'));
    await key($('roles-table'), 'x');
    await until(() => api.state.roles.state().matches[id]?.status === 'dismissed');
    await until(() => !$$('role-row').some((r) => r.dataset.id === id));
  });

  it('keeps its view, filters and place when the student leaves and comes back', async () => {
    await buildAndSearch();
    await click($('roles-remote'));
    const remote = $$('role-row').length;
    await click(document.querySelectorAll('[role="tab"]')[1]!);
    expect($('roles-companies')).toBeTruthy();
    act(() => root.unmount());
    root = createRoot(host);
    await show();
    await until(() => $('roles-companies'));
    await click(document.querySelectorAll('[role="tab"]')[0]!);
    expect($('roles-remote')!.getAttribute('aria-pressed')).toBe('true');
    expect($$('role-row')).toHaveLength(remote);
  });
});

describe('one role, opened', () => {
  it('shows the score and its four parts, the quotes, the gaps, and Find a way in lands on the plan', async () => {
    await buildAndSearch();
    const stripe = $$('role-row').find((r) => r.textContent?.includes('Stripe'))!;
    await click($('role-title', stripe));
    await until(() => $('role-panel'));
    expect($$('role-panel-part').map((p) => p.dataset.part)).toEqual([
      'skills',
      'experience',
      'education',
      'level',
    ]);
    expect($$('role-panel-part')[0]!.textContent).toContain('the posting asks for');
    expect($('role-panel-from-posting')!.textContent).toContain('Experience with Go, Java or Ruby');
    expect($('role-panel-from-you')!.textContent).toContain('Built a reconciliation service in Go');
    expect($('role-panel-gaps')!.textContent).toMatch(
      /Payments is asked for and not on your resume|Distributed systems/,
    );
    expect($('role-panel-fit')!.textContent).toContain('Not a chance of an offer'.replace('Not a', 'not a'));
    await click($('role-way-in'));
    await until(() => where.startsWith('/companies/'));
    expect(where).toMatch(/\?plan=tp/);
    const t = await db.targetCompanies.where('userId').equals(user.id).first();
    expect(t).toMatchObject({ nameRaw: 'Stripe', role: 'Software Engineer Intern' });
    const log = (await db.audit.where('userId').equals(user.id).toArray()).map((e) => e.action);
    expect(log).toEqual(expect.arrayContaining(['roles.opened', 'roles.way_in']));
  });

  it('Not for me asks why, and the reason reaches the server', async () => {
    await buildAndSearch();
    const first = $$('role-row')[0]!;
    const id = first.dataset.id!;
    await click($('role-title', first));
    await until(() => $('role-panel'));
    await click($('role-panel-dismiss'));
    await click($('role-dismiss-company'));
    await until(() => api.state.roles.state().matches[id]?.status === 'dismissed');
    expect(api.state.roles.state().matches[id]?.dismissReason).toBe('company');
  });
});

describe('every state in plan 44 §2.5', () => {
  it('no resume and no LinkedIn: the first visit, nothing guessed', async () => {
    await db.resumes.clear();
    await show();
    await until(() => $('roles-first-visit'));
    expect($('profile-use-resume')).toBeNull();
    expect($('profile-use-linkedin')).toBeNull();
    expect(($('profile-read') as HTMLButtonElement).disabled).toBe(true);
    expect(api.state.roleCalls.filter((c) => c.route === '/roles/search')).toHaveLength(0);
  });

  it('a search running: the skeleton, "Reading N roles", and rows appearing as they are scored', async () => {
    let release: () => void = () => {};
    let gate = new Promise<void>((r) => {
      release = r;
    });
    setOrbitApiFetchForTests(async (input, init) => {
      if (String(input).endsWith('/roles/more')) await gate;
      return api.fetch(input, init);
    });
    await show();
    await until(() => $('profile-use-resume'));
    await click($('profile-read'));
    await until(() => $('roles-profile'));
    await click($('profile-find'));
    await until(() => $('roles-skeleton'));
    await until(() => /^Reading \d+ roles against your profile/.test($('roles-reading')?.textContent ?? ''));
    // one step answers: its rows show while the rest are read
    const first = release;
    gate = new Promise<void>((r) => {
      release = r;
    });
    first();
    await until(() => $$('role-row').length > 0);
    expect($('roles-reading')).toBeTruthy();
    expect($('roles-reading')!.textContent).toMatch(/4 of \d+ read/);
    setOrbitApiFetchForTests(api.fetch);
    release();
    await until(() => !$('roles-reading'));
  });

  it('nothing scores 6 or more: "No strong fits yet", the best five as stretches', async () => {
    api.state.roles = createRolesSim({
      jobs: SAMPLE_JOBS.map((j) => ({
        ...j,
        caps: [{ kind: 'years', quote: '5+ years', label: 'Asks for 5 years' }],
      })),
    });
    await buildAndSearch();
    expect($('roles-no-strong')!.textContent).toContain('No strong fits yet');
    expect($$('role-row')).toHaveLength(5);
    expect($$('role-fit').every((f) => f.textContent?.includes('Stretch'))).toBe(true);
    expect($$('role-why')[0]!.textContent).toBe('Asks for 5 years');
  });

  it('a posting taken down leaves the table; in Saved it stays, no longer listed', async () => {
    await buildAndSearch();
    const first = $$('role-row')[0]!;
    const id = first.dataset.id!;
    await click($('role-save', first));
    await until(() => api.state.roles.state().matches[id]?.status === 'saved');
    await api.state.roles.close(id.replace(/^rm_/, ''));
    act(() => root.unmount());
    root = createRoot(host);
    resetRolesForTests();
    await show();
    await until(() => $$('role-row').length > 0 && !$$('role-row').some((r) => r.dataset.id === id));
    await click(document.querySelectorAll('[role="tab"]')[2]!);
    await until(() => $('roles-saved'));
    expect($('roles-saved-closed', $$('roles-saved-row')[0]!)!.textContent).toBe('No longer listed');
  });

  it('the model unavailable: "Not read closely yet", never a number, and a line that says why', async () => {
    await api.state.roles.setModelOff(true);
    await buildAndSearch();
    expect($$('role-fit')).toHaveLength(0);
    expect($$('role-fit-rough').length).toBe($$('role-row').length);
    expect($('roles-note-model')!.textContent).toBe(
      `${NOT_READ_NOTE} Rows marked "Not read closely yet" have no score.`,
    );
  });

  it('offline, or reloaded: the last matches from the browser copy, with when they were read', async () => {
    await buildAndSearch();
    const shown = titles();
    act(() => root.unmount());
    root = createRoot(host);
    resetRolesForTests();
    forgetViews();
    setOrbitApiFetchForTests(async () => {
      throw new TypeError('offline');
    });
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      await show();
      await until(() => $$('role-row').length > 0);
      expect(titles()).toEqual(shown);
      expect($('roles-read-when')!.textContent).toMatch(
        /^You are offline\. These are the roles Orbit read before: read/,
      );
    } finally {
      onLine.mockRestore();
    }
  });

  it('the demo student: sample roles, read and scored in the browser, no server', async () => {
    const demo = { ...user, id: 'demo-user' } as User;
    session.user = demo;
    session.userId = 'demo-user';
    await seedResume('demo-user');
    const before = api.state.roleCalls.length;
    await buildAndSearch();
    expect($$('role-row').length).toBeGreaterThan(3);
    expect(api.state.roleCalls.length).toBe(before);
    const search = await keptSearch('demo-user');
    expect(tableMatches(await keptMatches('demo-user'), search).length).toBe(search!.listed);
  });

  it('switch off: no page, nothing offered', async () => {
    api.state.features = [];
    await refreshAccount();
    await show();
    await until(() => $('roles-off'));
    expect($('roles-off')!.textContent).toContain('Roles is not on for you yet');
    expect(api.state.roleCalls).toHaveLength(0);
  });

  it('a local copy with no Orbit account has no Roles', async () => {
    session.user = { ...user, id: 'local-user' } as User;
    session.userId = 'local-user';
    await show();
    await until(() => $('roles-off'));
  });
});

describe('narrow: Role, Company and Fit stay; Why and Path fold under the role', () => {
  it('a compact table (a chat card, the side panel) hides the other columns and folds the reason and path', async () => {
    await buildAndSearch();
    const rows = tableMatches(await keptMatches(user.id), await keptSearch(user.id));
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RolesTable
            rows={rows}
            picked={new Set()}
            onPick={() => {}}
            onPickAll={() => {}}
            onActive={() => {}}
            onOpen={() => {}}
            onSave={() => {}}
            onDismiss={() => {}}
            compact
          />
        </MemoryRouter>,
      );
    });
    const ths = [...host.querySelectorAll('thead th')];
    // shown in a card: not hidden, or hidden only below a phone's width
    const shown = ths
      .filter(
        (th) => !th.className.split(' ').includes('hidden') || th.className.includes('@[36rem]:table-cell'),
      )
      .map((th) => th.textContent?.trim());
    expect(shown).toEqual(['Role', 'Company', 'Fit', 'Actions']);
    const fold = $('role-fold', host)!;
    expect(fold.className).not.toContain('@[64rem]:hidden');
    expect(fold.textContent).toContain(whyWords(rows[0]!).text);
    expect($('role-path', fold)).toBeTruthy();
  });

  it('on the page the same columns fold by the box it is in (a container query), not by the window', async () => {
    await buildAndSearch();
    const why = [...document.querySelectorAll('thead th')].find((th) => th.textContent === 'Why')!;
    expect(why.className).toContain('@[64rem]:table-cell');
    expect($$('role-fold')[0]!.className).toContain('@[64rem]:hidden');
  });
});

describe('in the chat', () => {
  it('the roles card draws the same table, folded, and nothing while Roles is off', async () => {
    await buildAndSearch();
    const rows = tableMatches(await keptMatches(user.id), await keptSearch(user.id));
    act(() => root.unmount());
    root = createRoot(host);
    const env = {
      kind: 'roles' as const,
      summary: 'Found roles',
      href: '/roles',
      data: { ui: { query: 'What roles fit me?', matches: rows.slice(0, 5) }, forModel: {} },
    };
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RolesCard env={env} />
        </MemoryRouter>,
      );
    });
    await until(() => $('roles-card-table', host));
    expect($$('role-row', host)).toHaveLength(5);
    expect($('result-roles', host)!.textContent).toContain('What roles fit me?');
    setFeatureForTests('roles', false);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RolesCard env={{ ...env }} />
        </MemoryRouter>,
      );
    });
    await until(() => !$('result-roles', host));
  });

  it('the posting card gains the fit score and its reason', async () => {
    await buildAndSearch();
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <PlanFit url="https://boards.greenhouse.io/stripe/jobs/6120000" />
        </MemoryRouter>,
      );
    });
    await until(() => $('plan-fit', host));
    expect($('plan-fit-score', host)!.textContent).toMatch(/^\d+\/10$/);
    expect($('plan-fit-reason', host)!.textContent?.length).toBeGreaterThan(3);
  });
});
