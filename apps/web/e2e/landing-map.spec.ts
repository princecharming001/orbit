import { expect, test } from '@playwright/test';

/** The landing page's map: a sample network the visitor can search before signing up. */
test.describe('Landing map', () => {
  test('plays on its own, then hands over: a company shows the warm ways in, a person a route and a draft', async ({
    page,
  }) => {
    await page.goto('');
    const map = page.getByTestId('landing-map');
    await map.scrollIntoViewIfNeeded();
    // it plays sample searches until the visitor touches it
    await expect(map.getByText('Playing a demo')).toBeVisible();
    await expect(page.getByTestId('landing-map-search')).not.toHaveValue('', { timeout: 15_000 });

    // the visitor takes over by typing: suggestions, then a company
    const box = page.getByTestId('landing-map-search');
    await box.click();
    await expect(map.getByText('Your turn')).toBeVisible();
    await box.fill('Stri');
    await expect(page.getByTestId('landing-map-suggestion').first()).toContainText('Stripe');
    await box.press('Enter');
    await expect(box).toHaveValue('Stripe');
    await expect(page.getByTestId('landing-map-result')).toContainText('Maya Chen');
    await expect(page.getByTestId('landing-map-legend')).toContainText('7 people at Stripe');

    // a person: routes, warmest first, and the ask drafted
    await box.fill('Priya Ahmed');
    await box.press('Enter');
    const routes = page.getByTestId('landing-map-result');
    await expect(routes).toContainText('Route 1');
    await expect(routes.getByRole('button').first()).toContainText('Theo');
    await expect(page.getByTestId('landing-map-legend')).toContainText('through Theo');
    await page.getByTestId('landing-map-draft').click();
    await expect(page.getByTestId('landing-map-draft-text')).toContainText('Hi Theo', { timeout: 10_000 });

    // nothing runs off the side on a phone
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
