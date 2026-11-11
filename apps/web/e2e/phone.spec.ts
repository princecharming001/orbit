import { expect, type Page, test } from '@playwright/test';
import { prep, skipQuestions } from './helpers';

/**
 * Plan 40: setup asks for a phone number to text when Orbit is ready, with the country in the field, and Settings,
 * Profile keeps it. Local mode: the number stays in this browser (account mode sends it to orbit-notify).
 */
async function upToPhone(page: Page) {
  await prep(page);
  await page.goto('');
  await page
    .getByRole('button', { name: /^get started/i })
    .first()
    .click();
  await page
    .getByTestId('ob-welcome')
    .getByRole('button', { name: /get started/i })
    .click();
  await page.getByTestId('ob-name').fill('Sam Okafor');
  await page.getByTestId('ob-email').fill('sam@umich.edu');
  await page.getByTestId('ob-school').fill('University of Michigan');
  await page.getByTestId('ob-school').press('Escape');
  await page.getByTestId('ob-year').selectOption({ index: 2 });
  await page.getByRole('button', { name: /^continue$/i }).click();
  await page.getByTestId('ob-fn-pm').click();
  await page.getByTestId('ob-company').fill('Goldman Sachs');
  await page.getByRole('button', { name: /^add$/i }).click();
  await page.getByRole('button', { name: /^continue$/i }).click();
  await skipQuestions(page);
  await page.getByTestId('ob-skip').click(); // LinkedIn
  await expect(page).toHaveURL(/\/onboarding\/phone$/);
}

test.describe('a phone number for the "Orbit is ready" text (plan 40)', () => {
  test('setup takes a number with its country, and Settings, Profile shows it', async ({ page }) => {
    await upToPhone(page);
    const step = page.getByTestId('ob-phone');
    await expect(step).toContainText('Get a text when Orbit is ready');
    await expect(step).toContainText('email you at sam@umich.edu');
    // the country is in the field: the US first for a student in a US time zone
    await expect(page.getByTestId('phone-country')).toHaveAttribute('data-country', 'US');
    await expect(page.getByTestId('phone-country')).toContainText('+1');
    const save = page.getByTestId('ob-phone-save');
    await expect(save).toBeDisabled();
    // the list searches by name or code, and the keyboard picks
    await page.getByTestId('phone-country').click();
    await expect(page.getByTestId('phone-country-option').first()).toHaveAttribute('data-country', 'US');
    await page.getByTestId('phone-country-search').fill('+44');
    await expect(page.getByTestId('phone-country-option').first()).toHaveAttribute('data-country', 'GB');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('phone-country')).toHaveAttribute('data-country', 'GB');
    // a pasted number with its own code switches the country back
    await page.getByTestId('phone-input').fill('+1 415 555 0123');
    await expect(page.getByTestId('phone-country')).toHaveAttribute('data-country', 'US');
    await expect(page.getByTestId('phone-input')).toHaveValue('(415) 555-0123');
    await save.click();
    await expect(page.getByTestId('ob-ready')).toBeVisible();
    await page.getByRole('button', { name: /open orbit/i }).click();
    await expect(page.getByTestId('greeting')).toContainText(/Hey Sam/, { timeout: 30_000 });
    await page.goto('settings/profile');
    const row = page.getByTestId('settings-phone');
    await expect(row.getByTestId('phone-input')).toHaveValue('(415) 555-0123');
    await expect(row.getByTestId('phone-country')).toHaveAttribute('data-country', 'US');
    await expect(row.getByTestId('settings-phone-sms-on')).toHaveAttribute('aria-checked', 'true');
    // a new number saves when the field is left
    await row.getByTestId('phone-input').fill('2079460958');
    await row.getByTestId('phone-country').click();
    await page.getByTestId('phone-country-search').fill('united k');
    await page.getByTestId('phone-country-option').first().click();
    await row.getByTestId('phone-input').blur();
    await expect(row.getByTestId('settings-phone-state')).toHaveText('Saved');
    await page.reload();
    await expect(page.getByTestId('settings-phone').getByTestId('phone-country')).toHaveAttribute(
      'data-country',
      'GB',
    );
  });

  test('Skip keeps email only, and Settings offers the text once a number is there', async ({ page }) => {
    await upToPhone(page);
    await page.getByTestId('ob-phone-skip').click();
    await expect(page.getByTestId('ob-ready')).toBeVisible();
    await page.getByRole('button', { name: /open orbit/i }).click();
    await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 30_000 });
    await page.goto('settings/profile');
    const row = page.getByTestId('settings-phone');
    await expect(row.getByTestId('phone-input')).toHaveValue('');
    await expect(row.getByTestId('settings-phone-sms-on')).toBeDisabled();
    await expect(row.getByTestId('settings-phone-email-on')).toHaveAttribute('aria-checked', 'true');
    await expect(row).toContainText('add a number above first');
  });
});
