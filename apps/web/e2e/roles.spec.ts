import { expect, type Page, test } from '@playwright/test';
import { createRolesSim } from '../src/engine/rolesSim';
import type { FakeOrbitApi } from '../src/test/fakeOrbitApi';
import { withFakeApi } from './fakeApi';
import { loadDemo } from './helpers';

/**
 * Plan 44, Roles, end to end against the fake orbit-api (the same fake the unit tests use, its Roles routes answered
 * from the sample roles): the first visit with LinkedIn only, a resume only or both; a search filling in as it is
 * read; a reload showing the same matches; Save; "Find a way in" landing on the target's plan with the role filled;
 * a job link in the chat showing the plan with its score; the switch off hiding the tab, the tool and the card.
 */

const LINK = 'https://boards.greenhouse.io/stripe/jobs/6120000';

/**
 * The year the made-up student graduates: two years from now, so they are a student (graduating more than a year
 * away) whenever the suite runs. The level comes from dates by the server's own rule (core `profileLevelOf`): a
 * graduation within a year is a new grad, who is shown entry roles and not internships.
 */
const GRAD = new Date().getFullYear() + 2;

/** Signed in to an account that finished setup elsewhere, with Roles on (or off) for it. */
async function signedIn(page: Page, opts: { roles?: boolean; step?: number } = {}): Promise<FakeOrbitApi> {
  const api = await withFakeApi(page);
  api.state.user.onboarding = { completed_at: '2026-10-05T12:00:00.000Z' };
  api.state.features = opts.roles === false ? [] : ['roles'];
  if (opts.step)
    api.state.roles = createRolesSim({ step: opts.step, now: () => new Date('2026-10-06T10:00:00') });
  await page.goto('');
  await page.getByTestId('landing-login').click();
  await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 20_000 });
  return api;
}

/** The student's own resume, as Orbit read it (the lines a resume upload leaves in the browser). */
async function seedResume(page: Page) {
  await page.evaluate(async (GRAD) => {
    const db = (
      window as unknown as {
        __orbitDb: Record<
          string,
          {
            put(x: unknown): Promise<unknown>;
            bulkPut(x: unknown[]): Promise<unknown>;
            toArray(): Promise<{ id: string }[]>;
          }
        >;
      }
    ).__orbitDb;
    const [u] = await db.users!.toArray();
    const userId = u!.id;
    await db.resumes!.put({
      id: 'r_e2e',
      userId,
      filename: 'Maya_Lin_Resume.pdf',
      text: '',
      isCurrent: true,
      createdAt: '2026-10-01T00:00:00.000Z',
      parsedAt: '2026-10-01T00:00:00.000Z',
    });
    await db.resumeFacets!.bulkPut([
      {
        id: 'rf_e2e_1',
        resumeId: 'r_e2e',
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
        id: 'rf_e2e_2',
        resumeId: 'r_e2e',
        kind: 'project',
        title: 'Campus marketplace',
        text: 'React and Postgres marketplace used by 800 students.',
        keywords: [],
        confirmed: true,
      },
      {
        id: 'rf_e2e_3',
        resumeId: 'r_e2e',
        kind: 'education',
        title: 'BS Computer Science',
        organizationName: 'Cornell University',
        endDate: `${GRAD}-05-31`,
        text: 'BS Computer Science.',
        keywords: [],
        confirmed: true,
      },
      {
        id: 'rf_e2e_4',
        resumeId: 'r_e2e',
        kind: 'skill_group',
        text: 'Go, Python, SQL, React, TypeScript',
        keywords: [],
        confirmed: true,
      },
    ]);
  }, GRAD);
}

/** The student's own LinkedIn profile as Orbit keeps it; `described`: its jobs say what they did. */
async function seedLinkedIn(page: Page, described: boolean) {
  await page.evaluate(
    async ([d, GRAD]) => {
      const db = (
        window as unknown as {
          __orbitDb: Record<
            string,
            { put(x: unknown): Promise<unknown>; toArray(): Promise<{ id: string }[]> }
          >;
        }
      ).__orbitDb;
      const [u] = await db.users!.toArray();
      await db.kv!.put({
        key: `self:linkedin:${u!.id}`,
        value: {
          readAt: new Date().toISOString(),
          v: 2,
          profile: {
            headline: 'Computer Science at Cornell',
            experience: [
              {
                title: 'Software Engineering Intern',
                company: 'Brex',
                current: false,
                start: '2026-06',
                end: '2026-08',
                ...(d ? { description: 'Built a reconciliation service for card transactions in Go.' } : {}),
              },
            ],
            education: [
              { school: 'Cornell University', degree: 'BS', field: 'Computer Science', end: String(GRAD) },
            ],
            throttled: [],
            skills: ['Go', 'SQL', 'TypeScript', 'React'],
          },
        },
      });
    },
    [described, GRAD] as const,
  );
}

/** Through the profile screen to the table, every role read. */
async function findRoles(page: Page) {
  await page.getByTestId('profile-read').click();
  await expect(page.getByTestId('roles-profile')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('profile-find').click();
  await expect(page.getByTestId('role-row').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('roles-reading')).toHaveCount(0, { timeout: 60_000 });
}

test.describe('Roles (plan 44, fake orbit-api)', () => {
  test('first visit with a resume only: what Orbit read, then the table', async ({ page }) => {
    test.setTimeout(120_000);
    const api = await signedIn(page);
    await seedResume(page);
    // the tab sits after Discover, with its briefcase
    const nav = page.getByRole('navigation', { name: 'Main' }).first();
    await expect(nav.getByRole('link', { name: 'Roles' })).toBeVisible();
    await nav.getByRole('link', { name: 'Roles' }).click();
    await expect(page.getByTestId('roles-first-visit')).toBeVisible();
    await expect(page.getByTestId('profile-use-resume')).toBeChecked();
    await expect(page.getByTestId('profile-use-linkedin')).toHaveCount(0);
    await page.getByTestId('profile-read').click();
    await expect(page.getByTestId('profile-where-line')).toHaveText(
      `Student, B.S. Computer Science, Cornell University, graduating May ${GRAD}`,
    );
    await expect(page.getByTestId('profile-note')).toHaveCount(0);
    await page.getByTestId('profile-find').click();
    await expect(page.getByTestId('role-row').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('roles-reading')).toHaveCount(0, { timeout: 60_000 });
    expect(
      api.state.roleCalls.find((c) => c.route === '/roles/profile' && 'read' in c.body)?.body,
    ).toMatchObject({
      read: { resume: { skills: ['Go', 'Python', 'SQL', 'React', 'TypeScript'] } },
    });
    await expect(page.getByTestId('roles-coverage-line')).toHaveText(
      'Roles from 1,240 company boards, SimplifyJobs and your LinkedIn search.',
    );
    expect(await page.getByTestId('roles-page').innerText()).not.toMatch(/[—–!]/);
  });

  test('first visit with LinkedIn only: it reads, and says the profile lists roles but not what was done', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await signedIn(page);
    await seedLinkedIn(page, false);
    await page.goto('roles');
    await expect(page.getByTestId('profile-use-linkedin')).toBeChecked();
    await expect(page.getByTestId('profile-use-resume')).toHaveCount(0);
    await page.getByTestId('profile-read').click();
    await expect(page.getByTestId('profile-note')).toHaveText(
      'Your LinkedIn profile lists your roles but not what you did in them. Add a resume for a closer read.',
    );
    await page.getByTestId('profile-find').click();
    await expect(page.getByTestId('role-row').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('roles-note-linkedin')).toBeVisible();
  });

  test('first visit with both: both are read, the job descriptions with them', async ({ page }) => {
    test.setTimeout(120_000);
    const api = await signedIn(page);
    await seedResume(page);
    await seedLinkedIn(page, true);
    await page.goto('roles');
    await expect(page.getByTestId('profile-use-linkedin')).toBeChecked();
    await expect(page.getByTestId('profile-use-resume')).toBeChecked();
    await expect(page.getByTestId('roles-first-visit')).toContainText('Using both');
    await findRoles(page);
    const read = api.state.roleCalls.find((c) => c.route === '/roles/profile' && 'read' in c.body)!.body as {
      read: { resume?: unknown; linkedin?: { positions: { description?: string }[] } };
    };
    expect(read.read.resume).toBeTruthy();
    expect(read.read.linkedin?.positions[0]?.description).toContain('reconciliation service');
    expect(api.state.roles.state().profile?.sources).toEqual(['resume', 'linkedin']);
  });

  test('the search fills in as it is read; a reload shows the same matches; Save keeps one', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const api = await signedIn(page, { step: 3 });
    await seedResume(page);
    await page.goto('roles');
    await page.getByTestId('profile-read').click();
    await page.getByTestId('profile-find').click();
    const reading = page.getByTestId('roles-reading');
    await expect(reading).toContainText(/Reading \d+ roles against your profile/, { timeout: 15_000 });
    // rows appear while the rest are still read
    await expect(page.getByTestId('role-row').first()).toBeVisible({ timeout: 15_000 });
    await expect(reading).toBeVisible();
    await expect(reading).toHaveCount(0, { timeout: 90_000 });
    const more = api.state.roleCalls.filter((c) => c.route === '/roles/more').length;
    expect(more).toBeGreaterThan(2);
    const titles = await page.getByTestId('role-title').allInnerTexts();
    await page.reload();
    await expect(page.getByTestId('role-row').first()).toBeVisible({ timeout: 20_000 });
    expect(await page.getByTestId('role-title').allInnerTexts()).toEqual(titles);
    await expect(page.getByTestId('roles-read-when')).toContainText(/^Read /);
    // a reload asks for nothing new to be read
    expect(api.state.roleCalls.filter((c) => c.route === '/roles/more').length).toBe(more);
    const first = page.getByTestId('role-row').first();
    const id = await first.getAttribute('data-id');
    await first.getByTestId('role-save').click();
    await expect(first.getByTestId('role-save')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => api.state.roles.state().matches[id!]?.status).toBe('saved');
    await page.getByRole('tab', { name: /Saved/ }).click();
    await expect(page.getByTestId('roles-saved-row')).toHaveCount(1);
  });

  test('Find a way in lands on the target plan, with the role filled', async ({ page }) => {
    test.setTimeout(120_000);
    await signedIn(page);
    await seedResume(page);
    await page.goto('roles');
    await findRoles(page);
    const stripe = page.getByTestId('role-row').filter({ hasText: 'Stripe' }).first();
    await stripe.getByTestId('role-title').click();
    const panel = page.getByTestId('role-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('role-panel-part')).toHaveCount(4);
    await expect(panel.getByTestId('role-panel-from-posting')).toBeVisible();
    await panel.getByTestId('role-way-in').click();
    await expect(page).toHaveURL(/\/companies\/[^/?]+\?plan=/, { timeout: 20_000 });
    await expect(page.getByTestId('company-plan-card').getByTestId('target-plan-title')).toContainText(
      'Software Engineer Intern',
    );
    await expect(page.getByTestId('company-target')).toBeVisible();
  });

  test('switch off: no tab, no page, no chat tool and no card', async ({ page }) => {
    test.setTimeout(120_000);
    const api = await signedIn(page, { roles: false });
    await expect(page.getByRole('link', { name: 'Roles' })).toHaveCount(0);
    await page.goto('roles');
    await expect(page.getByTestId('roles-off')).toBeVisible();
    await page.goto('');
    await expect(page.getByTestId('greeting')).toBeVisible();
    await page.getByTestId('composer-input').fill('What roles fit me?');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('composer-stop')).toHaveCount(0, { timeout: 20_000 });
    await page.waitForTimeout(500);
    await expect(page.getByTestId('result-roles')).toHaveCount(0);
    expect(api.state.roleCalls).toHaveLength(0);
  });
});

test.describe('Roles in the demo and the chat (plan 44 §2.6)', () => {
  test('the demo student: sample roles with no account; the chat finds roles and a job link shows the plan with its score', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await loadDemo(page);
    await page.goto('roles');
    await expect(page.getByTestId('profile-use-linkedin')).toBeChecked();
    await expect(page.getByTestId('profile-use-resume')).toBeChecked();
    await findRoles(page);
    expect(await page.getByTestId('role-row').count()).toBeGreaterThan(3);
    // the chat: the same table in a card
    await page.goto('');
    await expect(page.getByTestId('greeting')).toBeVisible();
    await page.getByTestId('composer-input').fill('What roles fit me?');
    await page.keyboard.press('Enter');
    const card = page.getByTestId('result-roles');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('role-row').first()).toBeVisible();
    // a job link: the plan for the posting, with how well the student fits it
    await expect(page.getByTestId('composer-stop')).toHaveCount(0, { timeout: 30_000 });
    await page.getByTestId('composer-input').fill(`here is a posting ${LINK}`);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('target-plan').last()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('plan-fit-score').last()).toHaveText(/^\d+\/10$/, { timeout: 20_000 });
  });
});
