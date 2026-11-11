import { expect, type Page, test } from '@playwright/test';
import { withFakeApi } from './fakeApi';
import { skipQuestions } from './helpers';

/**
 * Plan 40: while the first import runs, the student can always see where it stands (the sidebar chip, its checklist,
 * a slim line at the top of the chat) and how they will hear it is done; when it finishes in front of them, the app
 * says so once. Account mode against the fake orbit-api, whose /notify/status works readiness out with the real
 * readiness() from the fake's own import state.
 */
async function signUp(page: Page) {
  await page.goto('');
  await page
    .getByRole('button', { name: /^get started/i })
    .first()
    .click();
  await page.getByTestId('ob-google-signin').click();
  await expect(page).toHaveURL(/\/onboarding\/1$/, { timeout: 20_000 });
  await page.getByTestId('ob-year').selectOption('2027');
  await page.getByRole('button', { name: /^continue$/i }).click();
  await page.getByTestId('ob-fn-pm').click();
  await page.getByRole('button', { name: /^continue$/i }).click();
  await skipQuestions(page);
  await page.getByTestId('ob-skip').click();
  await page.getByTestId('ob-phone-skip').click();
}

test.describe('where setup stands (plan 40, fake orbit-api)', () => {
  test('the chip, its checklist and the chat line show each step, then "Orbit is ready" once', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const api = await withFakeApi(page);
    // LinkedIn still reading connections, Gmail on its recent mail, five jobs queued
    api.state.linkedin.status = 'active';
    api.state.notify.linkedinStage = 'relations';
    api.state.notify.pending = 5;
    api.state.status.counts = { ...api.state.status.counts, people: 812, messages: 1200 };
    api.state.status.google.backfill = { phase: 'recent', done: 0, total: null };
    await signUp(page);

    // the last setup screen shows the import live, and says how they will hear
    const ready = page.getByTestId('ob-ready');
    await expect(ready.getByTestId('ready-checklist')).toBeVisible();
    await expect(ready.getByTestId('ready-step-linkedin_people')).toHaveAttribute('data-state', 'working');
    await expect(ready.getByTestId('ready-notify')).toContainText(`email you at ${api.state.user.email}`);
    await page.getByRole('button', { name: /open orbit/i }).click();
    await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 30_000 });

    // the sidebar chip: syncing, with a percentage, and its checklist
    const chip = page.getByTestId('readiness-chip');
    await expect(chip).toHaveAttribute('data-state', 'syncing');
    await expect(chip).toContainText(/Syncing · \d{1,2}%/);
    await chip.click();
    const panel = page.getByTestId('readiness-panel');
    await expect(panel.getByTestId('ready-headline')).toHaveText('Reading your LinkedIn');
    await expect(panel.getByTestId('ready-step-linkedin_people')).toContainText('812 people so far');
    await expect(panel.getByTestId('ready-step-email_older')).toHaveAttribute('data-state', 'waiting');
    await expect(panel.getByTestId('ready-step-network')).toContainText('5 tasks left');
    // no number yet and texting is set up: one quiet way to add one
    await expect(panel.getByTestId('ready-add-phone')).toHaveAttribute('href', /\/settings\/profile#phone$/);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);

    // the line at the top of the chat, which opens the same checklist in place
    const banner = page.getByTestId('readiness-banner');
    await expect(banner).toContainText('Reading your LinkedIn');
    await banner.getByRole('button').first().click();
    await expect(banner.getByTestId('ready-step-email_recent')).toBeVisible();

    // the people and the recent mail come in: usable, still finishing
    api.state.notify.linkedinStage = 'chats';
    api.state.status.google.backfill = { phase: 'deep', done: 300, total: 1000 };
    await expect(chip).toHaveAttribute('data-state', 'usable', { timeout: 15_000 });
    await expect(chip).toContainText(/Finishing · \d{1,2}%/);
    await expect(banner).toContainText('Orbit is ready to use and still finishing');

    // everything is in and mapped: ready, said once, and the chat line goes away
    api.state.notify.linkedinStage = 'done';
    api.state.status.google.backfill = { phase: 'complete', done: 1000, total: 1000 };
    api.state.notify.pending = 0;
    await expect(chip).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
    await expect(chip).toHaveText(/Ready/);
    await expect(
      page.getByText('Orbit is ready. Your network is in and your first suggestions are waiting.'),
    ).toBeVisible();
    await expect(banner).toHaveCount(0);
  });

  test('a source that needs the student says what to do, in the chip and the chat line', async ({ page }) => {
    const api = await withFakeApi(page);
    api.state.status.google.status = 'needs_reauth';
    await signUp(page);
    await page.getByRole('button', { name: /open orbit/i }).click();
    await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 30_000 });
    const chip = page.getByTestId('readiness-chip');
    await expect(chip).toHaveAttribute('data-state', 'problem');
    await expect(chip).toContainText('Needs you');
    await expect(page.getByTestId('readiness-banner')).toContainText('Google needs you to sign in again');
  });
});
