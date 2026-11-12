import { expect, type Page, test } from '@playwright/test';
import { withFakeApi } from './fakeApi';

/**
 * The shipped default (plan 43, the owner's instruction): an Orbit account on a server that offers nothing optional.
 * No Instagram, X or Texts row in Settings, no step in setup, nothing on a person's page or in the privacy list, no
 * Launch section for a student; and once the owner offers Instagram, it shows up for the same student with nothing
 * rebuilt. A Mac browser, so Texts would show if it were offered.
 */
test.use({
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});

const PERSON = '3b1f7c2e-5d4a-4e6b-9c8d-7a6b5c4d3e2f';

async function noOptional(page: Page) {
  for (const id of ['settings-instagram', 'settings-x', 'settings-texts'])
    await expect(page.getByTestId(id)).toHaveCount(0);
}

function seedPerson(api: Awaited<ReturnType<typeof withFakeApi>>, at: string) {
  api.state.pages.push({
    changes: {
      people: [
        {
          id: PERSON,
          userId: api.state.user.id,
          displayName: 'Priya Shah',
          currentTitle: 'Product Lead',
          currentOrganizationRaw: 'Stripe',
          emails: [],
          sources: ['gmail'],
          interactionCount: 3,
          createdAt: at,
          updatedAt: at,
        },
      ],
    },
  });
}

test('nothing offered: setup has no Instagram, X or Texts step', async ({ page }) => {
  test.setTimeout(120_000);
  await withFakeApi(page);
  // setup: no Instagram, X or Texts step between LinkedIn and the rest
  await page.goto('');
  await page
    .getByRole('button', { name: /^get started/i })
    .first()
    .click();
  await page.getByTestId('ob-google-signin').click();
  await expect(page).toHaveURL(/\/onboarding\/1$/, { timeout: 20_000 });
  await expect(page.getByTestId('ob-name')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/Instagram|Texts/);
  for (const word of ['instagram', 'x', 'texts']) {
    await page.goto(`onboarding/${word}`);
    await expect(page.getByTestId(`ob-${word}`)).toHaveCount(0);
  }
});

test('nothing offered: no row, privacy line, card or Launch; offering Instagram shows it with no rebuild', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const api = await withFakeApi(page);
  const at = '2026-10-05T12:00:00.000Z';
  seedPerson(api, at);
  api.state.user.onboarding = { completed_at: at };
  await page.goto('');
  await page.getByTestId('landing-login').click();
  await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 20_000 });
  await page.goto('settings/integrations');
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('settings-linkedin').or(page.getByText('LinkedIn').first())).toBeVisible();
  await noOptional(page);
  // a student has no Launch section
  await expect(page.getByRole('link', { name: 'Launch' })).toHaveCount(0);
  await page.goto('settings/privacy');
  const leaves = page.getByTestId('privacy-leaves');
  await expect(leaves).toBeVisible();
  await expect(leaves).not.toContainText('Instagram');
  await expect(leaves).not.toContainText('Texts');
  await page.goto(`people/${PERSON}`);
  await expect(page.getByTestId('person-header')).toContainText('Priya Shah', { timeout: 20_000 });
  await expect(page.getByTestId('person-social')).toHaveCount(0);
  await expect(page.getByTestId('check-instagram')).toHaveCount(0);
  await expect(page.getByTestId('person-texts')).toHaveCount(0);
  expect(api.routes().filter((r) => /^\/(instagram|x|social)\//.test(r))).toEqual([]);
  await page.screenshot({ path: 'test-results/social-off-person.png' });

  // the owner offers Instagram: the same student sees its row on the next visit, nothing rebuilt
  api.state.sources.offered = ['instagram'];
  await page.goto('settings/integrations');
  await expect(page.getByTestId('settings-instagram')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('settings-instagram-status')).toHaveText('Not connected');
  await expect(page.getByTestId('settings-x')).toHaveCount(0);
  await expect(page.getByTestId('settings-texts')).toHaveCount(0);
});

test('the owner sees Launch, and offering a source takes one switch', async ({ page }) => {
  test.setTimeout(120_000);
  const api = await withFakeApi(page);
  api.state.isOwner = true;
  api.state.user.onboarding = { completed_at: '2026-10-05T12:00:00.000Z' };
  await page.goto('');
  await page.getByTestId('landing-login').click();
  await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 20_000 });
  await page.goto('settings/launch');
  await expect(page.getByTestId('settings-launch')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('launch-x-ready')).toContainText('Needs the X app client ID');
  await expect(page.getByTestId('launch-x-switch')).toBeDisabled();
  await page.getByTestId('launch-instagram-switch').click();
  await expect(page.getByTestId('launch-instagram-switch')).toHaveAttribute('aria-checked', 'true');
  expect(api.state.sources.offered).toContain('instagram');
  await page.screenshot({ path: 'test-results/social-launch.png', fullPage: true });
  await page.goto('settings/integrations');
  await expect(page.getByTestId('settings-instagram')).toBeVisible({ timeout: 20_000 });
});
