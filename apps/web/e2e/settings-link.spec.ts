import { expect, test } from '@playwright/test';
import { SETTINGS, settingHref } from '../src/chat/settingsMap';
import { loadDemo } from './helpers';

/**
 * The chat's setting card (plan 39 follow-up): a student who asks to change or find a setting gets one card with one
 * button, and the button lands on that exact spot in Settings, scrolled into view and lit for a moment.
 */
test.describe('a setting, straight from the chat', () => {
  test('every setting in the map opens at its own spot, in view and lit', async ({ page }) => {
    test.setTimeout(240_000);
    await loadDemo(page);
    for (const s of SETTINGS) {
      await page.goto(settingHref(s).replace(/^\//, ''));
      await expect(page, s.id).toHaveURL(new RegExp(`/settings/${s.section}#${s.id}$`));
      if (!s.target) continue;
      const spot = page.locator(`[data-setting-flash="${s.id}"]`);
      await expect(spot, `${s.id} is lit`).toHaveCount(1, { timeout: 8000 });
      // a whole section is taller than the window: its top is what has to be on screen
      await expect(spot, `${s.id} is in view`).toBeInViewport();
      // the light goes out by itself
      if (s.id === 'resume') await expect(spot).toHaveCount(0, { timeout: 6000 });
    }
  });

  test('"where do I add my resume" answers with a card whose button lands on the resume row', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.getByTestId('composer-input').fill('where do I add my resume');
    await page.keyboard.press('Enter');
    const card = page.getByTestId('result-setting').last();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveAttribute('data-setting', 'resume');
    await expect(card).toContainText('Resume');
    await expect(card).toContainText('Settings · Integrations');
    // what is there now, said plainly
    await expect(card).toContainText(/On file: .+\.pdf|No resume yet/);
    await card.getByTestId('setting-open').click();
    const row = page.locator('[data-setting-flash="resume"]');
    await expect(row).toHaveCount(1, { timeout: 8000 });
    await expect(row).toBeInViewport({ ratio: 0.5 });
    await expect(row).toContainText('Resume');
  });

  test('other settings get their own card: tone, Calendly, the booking link, the time zone', async ({
    page,
  }) => {
    await loadDemo(page);
    const cases: [string, string, string][] = [
      ['change my tone', 'tone', 'Open Writing style'],
      ['connect Calendly', 'calendly', 'Open Calendly'],
      ['how do I change my booking link', 'booking-link', 'Open Booking link in drafts'],
      ['change my time zone', 'timezone', 'Open Time zone'],
    ];
    for (const [said, id, button] of cases) {
      await expect(page.getByTestId('composer-stop')).toHaveCount(0, { timeout: 30_000 });
      await page.getByTestId('composer-input').fill(said);
      await page.keyboard.press('Enter');
      const card = page.locator(`[data-testid="result-setting"][data-setting="${id}"]`).last();
      await expect(card, said).toBeVisible({ timeout: 30_000 });
      await expect(card.getByTestId('setting-open'), said).toHaveText(button);
    }
    // a field takes the cursor when the spot is one
    await page
      .locator('[data-testid="result-setting"][data-setting="timezone"]')
      .last()
      .getByTestId('setting-open')
      .click();
    await expect(page.locator('#profile-tz')).toBeFocused({ timeout: 8000 });
  });
});
