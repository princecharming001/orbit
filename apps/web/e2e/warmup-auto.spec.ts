import { expect, type Page, test } from '@playwright/test';
import { advanceWarmup, type FakeOrbitApi } from '../src/test/fakeOrbitApi';
import { withFakeApi } from './fakeApi';

/**
 * The automated LinkedIn warm-up. A student signed in to an Orbit account, with LinkedIn connected, starts a warm-up
 * for a stranger: the start sheet shows the whole plan and the comment Orbit drafted; Start sends the words in the box
 * as they are and asks nothing more; the person's page shows each step as Orbit runs it, then "Warmed up", and the
 * first message is offered on Drafts. Stop works on the person's page and on Drafts; the setting turns it all off.
 * The server is the in-memory fake: nothing here reaches LinkedIn.
 */

const PRIYA = '5c2a9e74-3b1f-4d86-a0c7-91e4f2b6d899';
const DRAFTED = 'Did the week one rule hold once the team passed twenty people?';
/** the browser's clock in these tests (helpers.ts): a Tuesday morning */
const BROWSER_NOW = new Date('2026-10-06T10:00:00').getTime();

async function signedIn(page: Page, linkedin: 'active' | 'not_connected' = 'active'): Promise<FakeOrbitApi> {
  const api = await withFakeApi(page);
  // the fake server's clock follows the browser's, so "Today" in the plan is today on the page
  api.advance(BROWSER_NOW - Date.now());
  api.state.user.onboarding = { completed_at: '2026-10-05T12:00:00.000Z' };
  api.state.linkedin.status = linkedin;
  api.state.status.marks = { changed: 'm0', linkedin: 'l0', autopilot: 'a0' };
  const at = '2026-10-01T12:00:00.000Z';
  api.state.pages.push({
    changes: {
      people: [
        {
          id: PRIYA,
          displayName: 'Priya Rao',
          currentOrganizationRaw: 'Northwind',
          currentTitle: 'Head of Analytics',
          userId: api.state.user.id,
          linkedinUrl: 'https://www.linkedin.com/in/priya-rao',
          linkedinSlug: 'priya-rao',
          emails: [],
          sources: ['linkedin'],
          tieScore: 4,
          tieBand: 'faint',
          interactionCount: 0,
          createdAt: at,
          updatedAt: at,
        },
      ],
    },
  });
  await page.goto('');
  await page.getByTestId('landing-login').click();
  await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 20_000 });
  return api;
}

async function openPriya(page: Page) {
  await page.goto(`people/${PRIYA}`);
  await expect(page.getByRole('heading', { name: 'Priya Rao', level: 1 })).toBeVisible({ timeout: 30_000 });
}

/** From Priya's page: Write to her, choose the warm-up, and wait for the start sheet. */
async function openSheet(page: Page) {
  await openPriya(page);
  await page.getByTestId('person-write').click();
  await expect(page.getByTestId('warmup-choice-auto')).toContainText(
    'Orbit does it for you from your LinkedIn',
  );
  await page.getByTestId('warmup-first').click();
  const sheet = page.getByTestId('warmup-sheet');
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  return sheet;
}

/** What the worker would do, then a reload so the app asks the server what changed. */
async function serverRuns(page: Page, api: FakeOrbitApi, o: Parameters<typeof advanceWarmup>[2]) {
  advanceWarmup(api, api.state.warmups.runs[api.state.warmups.runs.length - 1]!.id, o);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Priya Rao', level: 1 })).toBeVisible({ timeout: 30_000 });
}

const noShouting = async (page: Page, testId: string) => {
  const text = (await page.getByTestId(testId).textContent()) ?? '';
  expect(text).not.toMatch(/[–—!]/);
};

test.describe('Orbit runs the LinkedIn warm-up', () => {
  test('the sheet shows the plan and the comment; Start sends the edited words; the page follows the run to "Warmed up"', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const api = await signedIn(page);
    const sheet = await openSheet(page);
    // the whole plan, in plain words
    const lines = sheet.getByTestId('warmup-plan').locator('li');
    await expect(lines).toHaveCount(3);
    await expect(lines.nth(0)).toHaveText("Today: view Priya's profile.");
    await expect(lines.nth(1)).toHaveText(
      'Thursday: like their post: "New analysts should ship something real in their first week."',
    );
    await expect(lines.nth(2)).toHaveText('Friday: comment on that post.');
    await expect(sheet.getByTestId('warmup-comment-text')).toHaveValue(DRAFTED);
    await expect(sheet).toContainText('Orbit posts exactly these words.');
    await expect(sheet).toContainText('The message itself waits for your Send.');
    await noShouting(page, 'warmup-sheet');
    // nothing has started by looking
    expect(api.calls.filter((c) => c.route === '/warmups/start')).toHaveLength(0);

    // the student rewrites the comment, and that is what goes
    const mine = 'We tried day-two changes on my team project. Did it hold once you passed twenty people?';
    await sheet.getByTestId('warmup-comment-text').fill(mine);
    await sheet.getByTestId('warmup-start').click();
    await expect(sheet).toBeHidden({ timeout: 20_000 });
    await expect(
      page.getByText('Warm-up started for Priya. Orbit runs it and tells you when it is done.'),
    ).toBeVisible();
    expect(api.state.warmups.started).toHaveLength(1);
    expect(api.state.warmups.started[0]!.comment).toBe(mine);
    expect(api.state.warmups.started[0]!.personId).toBe(PRIYA);

    // the person's page: Orbit is running it, with the approved words, and nothing asked of the student
    const card = page.getByTestId('warmup-card');
    await expect(card.getByTestId('warmup-running')).toHaveText('Orbit is running it');
    await expect(card.getByTestId('warmup-approved-comment')).toContainText(mine);
    await expect(card.getByTestId('warmup-step-view_profile')).toContainText('Orbit views their profile');
    await expect(card.getByTestId('warmup-step-view_profile')).toContainText('Today');
    await expect(card.getByTestId('warmup-stop')).toBeVisible();
    await noShouting(page, 'warmup-card');

    // Drafts lists it under Coming up, with no step card for the student
    await page.goto('inbox');
    const upcoming = page.getByTestId('upcoming-warmup');
    await expect(upcoming).toContainText('Priya Rao');
    await expect(upcoming).toContainText('Orbit is warming up');
    await expect(page.getByTestId('warmup-steps')).toHaveCount(0);

    // the server runs the profile view: the page shows it done
    await openPriya(page);
    await serverRuns(page, api, { at: new Date(BROWSER_NOW + 3 * 3_600_000).toISOString() });
    await expect(card.getByTestId('warmup-step-view_profile')).toContainText('Done', { timeout: 20_000 });
    await expect(card.getByTestId('warmup-step-react_post')).not.toContainText('Done');
    await expect(card.getByTestId('warmup-running')).toBeVisible();

    // the like and the comment run: warmed up, told once, first message offered
    await serverRuns(page, api, { steps: 2, at: new Date(BROWSER_NOW + 3 * 86_400_000).toISOString() });
    await expect(card.getByTestId('warmup-warmed')).toHaveText('Warmed up', { timeout: 20_000 });
    await expect(card.getByTestId('warmup-done-line')).toContainText('Your first message is ready to write.');
    await expect(card.getByTestId('warmup-stop')).toHaveCount(0);
    await expect(
      page.getByText('Orbit finished the warm-up for Priya. Your first message is ready to write.'),
    ).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => api.state.warmups.told.length, { timeout: 20_000 }).toBe(1);

    // the next step on Drafts is the first message; it is a draft, and nothing was sent
    await page.goto('inbox');
    await expect(page.getByText('Orbit finished the warm-up; ready to message Priya')).toBeVisible({
      timeout: 30_000,
    });
    expect(api.calls.filter((c) => c.route === '/drafts/approve')).toHaveLength(0);
    // opened again later, it is not said again
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Drafts', level: 1 })).toBeVisible();
    await page.waitForTimeout(1500);
    expect(api.calls.filter((c) => c.route === '/warmups/told')).toHaveLength(1);
  });

  test('the comment can be left out, and Stop on the page stops it on the server', async ({ page }) => {
    test.setTimeout(120_000);
    const api = await signedIn(page);
    const sheet = await openSheet(page);
    await sheet.getByTestId('warmup-comment-switch').click();
    await expect(sheet.getByTestId('warmup-comment-text')).toHaveCount(0);
    await expect(sheet.getByTestId('warmup-comment-off')).toHaveText(
      'No comment will be posted. Orbit views the profile and likes the post.',
    );
    await expect(sheet.getByTestId('warmup-plan').locator('li')).toHaveCount(2);
    await sheet.getByTestId('warmup-start').click();
    await expect(sheet).toBeHidden({ timeout: 20_000 });
    expect(api.state.warmups.started[0]!.comment).toBeNull();
    const card = page.getByTestId('warmup-card');
    await expect(card.getByTestId('warmup-running')).toBeVisible();
    await expect(card.getByTestId('warmup-step-comment_post')).toHaveCount(0);
    await expect(card).toContainText('No comment, as you chose.');

    await card.getByTestId('warmup-stop').click();
    await expect(
      page.getByText('Stopped the warm-up for Priya. Nothing more will be done on LinkedIn.'),
    ).toBeVisible({
      timeout: 20_000,
    });
    expect(api.state.warmups.stopped).toHaveLength(1);
    expect(api.state.warmups.runs[0]!.status).toBe('stopped');
    await expect(card.getByTestId('warmup-running')).toHaveCount(0);
    await expect(card.getByTestId('warmup-stopped-line')).toHaveText('You stopped this warm-up.');
    // gone from Drafts
    await page.goto('inbox');
    await expect(page.getByRole('heading', { name: 'Drafts', level: 1 })).toBeVisible();
    await expect(page.getByTestId('upcoming-warmup')).toHaveCount(0);
  });

  test('Stop on Drafts, where warm-ups are listed', async ({ page }) => {
    test.setTimeout(120_000);
    const api = await signedIn(page);
    const sheet = await openSheet(page);
    await sheet.getByTestId('warmup-start').click();
    await expect(sheet).toBeHidden({ timeout: 20_000 });
    expect(api.state.warmups.started[0]!.comment).toBe(DRAFTED);
    await page.goto('inbox');
    const upcoming = page.getByTestId('upcoming-warmup');
    await expect(upcoming).toContainText('Orbit is warming up');
    await upcoming.getByTestId('upcoming-warmup-stop').click();
    await expect(page.getByTestId('upcoming-warmup')).toHaveCount(0, { timeout: 20_000 });
    expect(api.state.warmups.stopped).toHaveLength(1);
  });

  test('someone with no recent post gets the profile view only, and the sheet says so', async ({ page }) => {
    test.setTimeout(120_000);
    const api = await signedIn(page);
    api.state.warmups.post = null;
    const sheet = await openSheet(page);
    await expect(sheet.getByTestId('warmup-plan').locator('li')).toHaveCount(1);
    await expect(sheet.getByTestId('warmup-no-post')).toHaveText(
      'Priya has not posted lately, so this warm-up is the profile view only.',
    );
    await expect(sheet.getByTestId('warmup-comment-switch')).toHaveCount(0);
    await sheet.getByTestId('warmup-start').click();
    await expect(sheet).toBeHidden({ timeout: 20_000 });
    expect(api.state.warmups.started[0]!.comment).toBeNull();
    await expect(page.getByTestId('warmup-progress').locator('li')).toHaveCount(1);
  });

  test('"Run warm-ups for me" off brings back the reminders', async ({ page }) => {
    test.setTimeout(120_000);
    const api = await signedIn(page);
    await page.goto('settings/limits');
    const toggle = page.getByTestId('settings-warmup-auto');
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => api.state.profile.warmUpAuto, { timeout: 20_000 }).toBe(false);

    await openPriya(page);
    await page.getByTestId('person-write').click();
    const choice = page.getByTestId('warmup-choice');
    await expect(choice).toBeVisible();
    await expect(page.getByTestId('warmup-choice-auto')).toHaveCount(0);
    await page.getByTestId('warmup-first').click();
    // the manual warm-up: no sheet, no call to the server, and the first step is the student's
    await expect(page).toHaveURL(/\/inbox\?person=/, { timeout: 20_000 });
    await expect(page.getByTestId('warmup-sheet')).toHaveCount(0);
    expect(api.calls.filter((c) => c.route.startsWith('/warmups/'))).toHaveLength(0);
    await expect(page.getByText('Open on LinkedIn').first()).toBeVisible({ timeout: 20_000 });
  });

  test('without LinkedIn connected the warm-up stays manual', async ({ page }) => {
    test.setTimeout(120_000);
    const api = await signedIn(page, 'not_connected');
    await openPriya(page);
    await page.getByTestId('person-write').click();
    await expect(page.getByTestId('warmup-choice')).toBeVisible();
    await expect(page.getByTestId('warmup-choice-auto')).toHaveCount(0);
    await page.getByTestId('warmup-first').click();
    await expect(page).toHaveURL(/\/inbox\?person=/, { timeout: 20_000 });
    expect(api.calls.filter((c) => c.route.startsWith('/warmups/'))).toHaveLength(0);
  });
});
