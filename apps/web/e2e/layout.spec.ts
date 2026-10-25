import { expect, test } from '@playwright/test';
import { clippedLabels, loadDemo, openDrafts, prep } from './helpers';

/**
 * No name, title or status line is ever cut off or spills out of its card: the demo's board, Drafts and person page
 * at a wide screen, a laptop, a small laptop and a phone. A card too narrow for its labels wraps them instead.
 */
const WIDTHS = [
  { name: 'wide', width: 1680, height: 1000 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'small laptop', width: 1024, height: 768 },
  { name: 'phone', width: 390, height: 844 },
];

test.describe('Layout', () => {
  test('no card label is clipped, at any width', async ({ page }) => {
    test.setTimeout(240_000);
    await loadDemo(page);
    for (const size of WIDTHS) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto('people');
      await expect(page.locator('[data-testid^="chat-card-"]').first()).toBeVisible();
      expect(await clippedLabels(page, '[data-testid^="chat-card-"]'), `People board, ${size.name}`).toEqual(
        [],
      );
      await openDrafts(page);
      await expect(page.locator('[data-testid^="suggestion-"]').first()).toBeVisible();
      expect(await clippedLabels(page, '[data-testid^="suggestion-"]'), `Drafts, ${size.name}`).toEqual([]);
    }
  });

  test('no label on the landing page is clipped, at a wide screen, a small laptop and a phone', async ({
    page,
  }) => {
    await prep(page, { clock: false });
    const cards = [
      '[data-testid="lp-step"]',
      '[data-testid="lp-drafts"]',
      '[data-testid="lp-board-card"]',
      '[data-testid="lp-prep"]',
      '[data-testid="lp-promise"]',
    ].join(', ');
    for (const size of [
      { name: 'wide', width: 1440, height: 900 },
      { name: 'small laptop', width: 1024, height: 768 },
      { name: 'phone', width: 390, height: 844 },
    ]) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto('');
      await expect(page.getByTestId('lp-drafts')).toBeAttached();
      // every section fades in on first sight: scroll through the page so each one is laid out as a visitor sees it
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 400) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 20));
        }
      });
      await expect(page.getByTestId('lp-board-card').first()).toBeVisible();
      expect(await clippedLabels(page, cards), `Landing, ${size.name}`).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        `Landing, ${size.name}`,
      ).toBeLessThanOrEqual(size.width);
    }
  });
});
