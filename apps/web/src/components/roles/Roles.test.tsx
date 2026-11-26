/**
 * Plan 44 §13, the browser's components: the Roles page against the fake orbit-api (the real client, the real
 * shapes). The profile screen (edit a skill, untick a kind, widen the level, answer once), the table (sort, filters,
 * range pick, keyboard, keeps its place on return), the panel (parts, quotes, gaps, the way in), every state in §2.5,
 * the narrow layout, and the chat's card and the posting card's score.
 */
import type { Person, User } from '@orbit/core';
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
import { reachCompany } from '../../engine/graph';
import { keptMatches, keptProfile, keptSearch, resetRolesForTests, tableMatches } from '../../engine/roles';
import { SAMPLE_JOBS } from '../../engine/rolesSample';
import { createRolesSim, NOT_READ_NOTE } from '../../engine/rolesSim';
import { forgetIntros } from '../../engine/rolesWayIn';
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
  forgetIntros();
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
const NO_REACH = async () => ({ people: [], direct: [], saved: [], former: [], alumni: [], twoHop: [] });
afterEach(async () => {
  vi.mocked(reachCompany).mockImplementation(NO_REACH);
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

/** Someone the student knows, at a company with open roles (a close tie unless said otherwise). */
async function knows(userId: string, id: string, name: string, org: string, extra: Partial<Person> = {}) {
  const now = new Date().toISOString();
  await db.people.put({
    id,
    userId,
    displayName: name,
    firstName: name.split(' ')[0]!,
    lastName: name.split(' ')[1] ?? '',
    nameNormalized: name.toLowerCase(),
    emails: [],
    primaryEmail: `${id}@example.com`,
    currentOrganizationRaw: org,
    currentTitle: 'Engineer',
    relationshipType: 'friend',
    strength: 0.7,
    tieScore: 80,
    interactionCount: 5,
    sources: ['manual'],
    isHuman: true,
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...extra,
  } as Person);
}

const BONUS: Record<string, number> = { close: 1.5, known: 1, intro: 0.75 };

describe('the roles, as cards', () => {
  it('lists every read role best match first, with its facts; search, sort and filters change it', async () => {
    await buildAndSearch();
    const scores = $$('role-fit').map((f) => Number(f.dataset.score));
    expect(scores.length).toBeGreaterThan(3);
    // no one known anywhere: best match is the fit
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    // the least fit shown is 6 by default
    expect(scores.every((s) => s >= 6)).toBe(true);
    for (const r of $$('role-row')) {
      expect($('role-company', r)!.textContent!.length).toBeGreaterThan(1);
      expect($('role-facts', r)!.textContent).toMatch(/\w/);
    }
    // no way in anywhere: no way-in line, never "No one yet"
    expect($$('role-path')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('No one yet');
    // newest first
    await choose($('roles-sort'), 'newest');
    expect($('role-posted', $$('role-row')[0]!)!.textContent).toMatch(/Today|1d/);
    // remote only
    await click($('roles-remote'));
    expect($$('role-row').length).toBeGreaterThan(0);
    for (const r of $$('role-row')) expect($('role-facts', r)!.textContent).toContain('Remote');
    await click($('roles-filters-clear'));
    // search by company
    await type($('roles-search') as HTMLInputElement, 'stripe');
    expect($$('role-row').length).toBeGreaterThan(0);
    for (const r of $$('role-row')) expect($('role-company', r)!.textContent).toBe('Stripe');
    await click($('roles-filters-clear'));
    const n = $$('role-row').length;
    await choose($('roles-min-fit'), '80');
    expect($$('role-row').length).toBeLessThan(n);
    expect($$('role-fit').every((f) => Number(f.dataset.score) >= 80)).toBe(true);
  });

  it('the way in: someone they know lifts a role in Best match, shows on the card, and the filter keeps only those', async () => {
    await knows(user.id, 'p_dana', 'Dana Whitfield', 'Stripe');
    await buildAndSearch();
    await choose($('roles-min-fit'), '1');
    // who they know at each company is read just after the roles show
    await until(() => $$('role-path').length > 0);
    const stripe = $$('role-row').filter((r) => $('role-company', r)!.textContent === 'Stripe');
    expect(stripe.length).toBeGreaterThan(0);
    const line = $('role-path', stripe[0]!)!;
    expect(line.dataset.way).toBe('close');
    expect(line.textContent).toContain('You know Dana Whitfield');
    // best match is the fit plus the way in: never out of order
    const best = $$('role-row').map((r) => {
      const fit = Number($('role-fit', r)?.dataset.score ?? 0);
      return fit + (BONUS[$('role-path', r)?.dataset.way ?? ''] ?? 0);
    });
    expect([...best].sort((a, b) => b - a)).toEqual(best);
    // easiest way in first: Stripe leads
    await choose($('roles-sort'), 'warmest');
    expect($('role-company', $$('role-row')[0]!)!.textContent).toBe('Stripe');
    // only where they know someone
    await choose($('roles-way-in-filter'), 'known');
    expect($$('role-row').every((r) => $('role-company', r)!.textContent === 'Stripe')).toBe(true);
    await choose($('roles-way-in-filter'), 'none');
    expect($$('role-row').some((r) => $('role-company', r)!.textContent === 'Stripe')).toBe(false);
  });

  it('works from the keyboard: arrows move, Enter opens, S saves, X says not for me', async () => {
    await buildAndSearch();
    const list = $('roles-list')!;
    await key(list, 'ArrowDown');
    await key(list, 'ArrowDown');
    const second = $$('role-row')[1]!;
    expect(second.dataset.active).toBe('true');
    const id = second.dataset.id!;
    await key(list, 's');
    await until(() => api.state.roles.state().matches[id]?.status === 'saved');
    await key(list, 'Enter');
    await until(() => $('role-panel'));
    expect(where).toContain(`role=${id}`);
    await click($('role-drawer-close'));
    await key($('roles-list'), 'x');
    await until(() => api.state.roles.state().matches[id]?.status === 'dismissed');
    await until(() => !$$('role-row').some((r) => r.dataset.id === id));
  });

  it('keeps its view, filters and place when the student leaves and comes back', async () => {
    await buildAndSearch();
    await click($('roles-remote'));
    const remote = $$('role-row').length;
    await click(document.querySelectorAll('[role="tab"]')[3]!);
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
  it('shows where to apply, the fit and its parts, the requirements, the gaps, and Find people lands on the plan', async () => {
    await buildAndSearch();
    const stripe = $$('role-row').find((r) => r.textContent?.includes('Stripe'))!;
    await click($('role-title', stripe));
    await until(() => $('role-panel'));
    expect($('role-apply-where')!.textContent).toBe('Applies on Stripe careers, on Greenhouse');
    expect($$('role-panel-part').map((p) => p.dataset.part)).toEqual([
      'skills',
      'experience',
      'education',
      'level',
    ]);
    expect($$('role-panel-part')[0]!.textContent).toContain('the posting asks for');
    const reqs = $$('role-panel-req');
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.some((r) => r.dataset.have === 'have')).toBe(true);
    expect($('role-panel-gaps')!.textContent).toMatch(
      /Payments is asked for and not on your resume|Distributed systems/,
    );
    expect($('role-fit', $('role-panel-fit')!)!.title).toContain('not a chance of an offer');
    // no one there: the way in says so, and finds people
    await until(() => $('role-panel-way-none'));
    await click($('role-way-in'));
    await until(() => where.startsWith('/companies/'));
    expect(where).toMatch(/\?plan=tp/);
    const t = await db.targetCompanies.where('userId').equals(user.id).first();
    expect(t).toMatchObject({ nameRaw: 'Stripe', role: 'Software Engineer Intern' });
    const log = (await db.audit.where('userId').equals(user.id).toArray()).map((e) => e.action);
    expect(log).toEqual(expect.arrayContaining(['roles.opened', 'roles.way_in']));
  });

  it('Apply, then "Yes, I applied": the role moves to Applied', async () => {
    await buildAndSearch();
    const first = $$('role-row')[0]!;
    const id = first.dataset.id!;
    await click($('role-title', first));
    await until(() => $('role-panel'));
    const apply = $('role-panel-open-posting') as HTMLAnchorElement;
    expect(apply.href).toMatch(/^https?:/);
    expect(apply.target).toBe('_blank');
    await click(apply);
    await until(() => $('role-applied-ask'));
    await click($('role-applied-yes'));
    await until(() => api.state.roles.state().matches[id]?.status === 'applied');
    await click($('role-drawer-close'));
    await click(document.querySelectorAll('[role="tab"]')[2]!);
    await until(() => $$('role-row').some((r) => r.dataset.id === id));
    expect($('role-status', $$('role-row')[0]!)!.textContent).toBe('Applied');
  });

  it('someone they know there: Ask for a referral writes the ask in place, naming the role', async () => {
    await knows(user.id, 'p_dana', 'Dana Whitfield', 'Stripe');
    await buildAndSearch();
    const stripe = $$('role-row').find((r) => $('role-company', r)!.textContent === 'Stripe')!;
    const title = $('role-title', stripe)!.textContent!;
    await click($('role-title', stripe));
    await until(() => $('role-panel-known') && $('role-panel-tip'));
    expect($('role-panel-tip')!.textContent).toBe('Ask Dana for a referral before you apply.');
    await click($('role-ask-referral'));
    await until(() => $('role-way-draft'), 8000);
    const drafts = await db.outbound.where('personId').equals('p_dana').toArray();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.kind).toBe('referral_ask');
    expect(drafts[0]!.bodyDraft).toContain(title);
    // the student never left Roles
    expect(where.startsWith('/roles')).toBe(true);
  }, 12_000);

  it('no one there, but a friend knows someone: the card says Intro via, and the ask is written in place', async () => {
    await knows(user.id, 'p_kenji', 'Kenji Mori', 'Acme');
    await knows(user.id, 'p_priya', 'Priya Shah', 'Ramp', {
      tieScore: 0,
      strength: 0,
      interactionCount: 0,
      relationshipType: 'unknown',
    });
    const priya = (await db.people.get('p_priya'))!;
    vi.mocked(reachCompany).mockImplementation(async (_u, company) => ({
      people:
        company === 'Ramp'
          ? [
              {
                person: priya,
                team: 'engineering',
                alum: false,
                action: 'ask',
                route: {
                  kind: 'warm',
                  score: 0.6,
                  line: 'via Kenji',
                  via: { id: 'p_kenji', name: 'Kenji Mori' },
                },
              },
            ]
          : [],
      direct: [],
      saved: [],
      former: [],
      alumni: [],
      twoHop: [],
    }));
    await buildAndSearch();
    await choose($('roles-min-fit'), '1');
    await until(() => $$('role-path').some((p) => p.dataset.way === 'intro'));
    const ramp = $$('role-row').find((r) => $('role-path', r)?.dataset.way === 'intro')!;
    expect($('role-company', ramp)!.textContent).toBe('Ramp');
    expect($('role-path', ramp)!.textContent).toContain('Intro via Kenji');
    await click($('role-title', ramp));
    await until(() => $('role-panel-intro'));
    expect($('role-panel-intro')!.textContent).toContain('Priya Shah');
    await click($('role-ask-intro'));
    await until(() => $('role-way-draft') || /Drafts/.test($('role-panel-intro')?.textContent ?? ''), 8000);
    const ask = await db.suggestions.where('personId').equals('p_kenji').first();
    expect(ask).toMatchObject({ kind: 'intro_request' });
    expect(where.startsWith('/roles')).toBe(true);
  }, 12_000);

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

  it('the three-dot menu on a card says not for me, with a reason', async () => {
    await buildAndSearch();
    const first = $$('role-row')[0]!;
    const id = first.dataset.id!;
    await click($('role-card-menu', first));
    await click($('role-card-dismiss-level', first));
    await until(() => api.state.roles.state().matches[id]?.dismissReason === 'level');
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
    expect($$('role-fit').every((f) => f.title.includes('a stretch'))).toBe(true);
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
    await click(document.querySelectorAll('[role="tab"]')[1]!);
    await until(() => $$('role-row').some((r) => r.dataset.id === id));
    const card = $$('role-row').find((r) => r.dataset.id === id)!;
    expect($('role-closed', card)!.textContent).toBe('No longer listed');
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
    // no Why: the reason is in the open role, not on the row
    const why = whyWords(rows[0]!).text;
    if (why) expect(host.textContent).not.toContain(why);
    expect($('role-path', fold)).toBeTruthy();
  });

  it('on the page the roles are cards, not the table', async () => {
    await buildAndSearch();
    expect($('roles-table')).toBeNull();
    expect($('roles-list')).toBeTruthy();
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
    expect($('plan-fit-score', host)!.textContent).toMatch(/^\d{1,3}$/);
    expect($('plan-fit-reason', host)!.textContent?.length).toBeGreaterThan(3);
  });
});
