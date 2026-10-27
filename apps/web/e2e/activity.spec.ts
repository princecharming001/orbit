import { expect, test } from '@playwright/test';
import { loadDemo } from './helpers';

/** Plan 23 §4.7: one quiet line says what Orbit is doing, and its popover answers "is it working?" in one look. */
test.describe('the status line', () => {
  test('a LinkedIn import shows on the line as it runs, then Up to date; the popover agrees with Settings', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await loadDemo(page);
    await page.goto('settings/integrations');
    const line = page.getByTestId('activity-line');
    await expect(line).toBeVisible();
    // every text the line shows from here on, in order
    await page.evaluate(() => {
      const w = window as unknown as { __lines: string[] };
      w.__lines = [];
      const el = document.querySelector('[data-testid="activity-text"]');
      const note = () => {
        const t = document.querySelector('[data-testid="activity-text"]')?.textContent ?? '';
        if (t && w.__lines.at(-1) !== t) w.__lines.push(t);
      };
      note();
      new MutationObserver(note).observe(el?.closest('[data-testid="rail"]') ?? document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    const card = page.getByTestId('settings-linkedin-live');
    await card.getByTestId('settings-linkedin-live-connect').click();
    await expect(card.getByTestId('settings-linkedin-live-status')).toContainText(/Connected/, {
      timeout: 30_000,
    });
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __lines: string[] }).__lines.join(' | ')), {
        timeout: 30_000,
      })
      .toMatch(/Reading your LinkedIn|Reading LinkedIn profiles/);
    await expect(page.getByTestId('activity-text')).toHaveText(/^Up to date/, { timeout: 60_000 });
    await expect(line).toHaveAttribute('data-state', 'idle');
    // nothing it said had a dash in it
    const said = await page.evaluate(() => (window as unknown as { __lines: string[] }).__lines);
    for (const t of said) expect(t).not.toMatch(/[–—]/);
    // the popover's profile count is the number Settings shows (read together: profiles may still be landing)
    await line.click();
    const pop = page.getByTestId('activity-popover');
    await expect(pop).toBeVisible();
    const count = (t: string) => Number(/(\d+) profiles? filled in/.exec(t)?.[1] ?? Number.NaN);
    await expect
      .poll(
        async () => {
          const settings = count(await card.getByTestId('settings-enrichment-status').innerText());
          const popover = count(await pop.getByTestId('activity-profiles-filled').innerText());
          return settings === popover ? 'same' : `${settings} vs ${popover}`;
        },
        { timeout: 30_000 },
      )
      .toBe('same');
    await expect(pop.getByTestId('activity-count-replies')).toHaveText(/\d+ times?/);
    // click away closes it
    await page.getByRole('heading', { level: 1 }).first().click();
    await expect(pop).toHaveCount(0);
  });

  test('LinkedIn signed out is an amber problem with Sign in again', async ({ page }) => {
    await loadDemo(page);
    await page.evaluate(async () => {
      const db = (
        window as unknown as {
          __orbitDb: {
            users: { toArray(): Promise<{ id: string }[]> };
            integrations: { put(row: unknown): Promise<unknown> };
          };
        }
      ).__orbitDb;
      const user = (await db.users.toArray())[0]!;
      await db.integrations.put({
        id: 'e2e-li',
        userId: user.id,
        provider: 'linkedin_live',
        externalAccountId: 'acc_e2e',
        status: 'active',
        scopes: [],
        syncState: {},
        lastSyncedAt: new Date().toISOString(),
        lastError: 'LinkedIn signed Orbit out. Sign in again to keep it current.',
        connectedAt: new Date().toISOString(),
      });
    });
    await page.goto('people');
    const line = page.getByTestId('activity-line');
    await expect(line).toHaveAttribute('data-state', 'problem', { timeout: 20_000 });
    await expect(page.getByTestId('activity-text')).toHaveText('LinkedIn signed you out · Sign in again');
    await expect(page.getByTestId('activity-dot').first()).toHaveAttribute('data-state', 'problem');
    await line.click();
    const problem = page.getByTestId('activity-problem');
    await expect(problem).toContainText('LinkedIn signed you out');
    await problem.getByRole('link', { name: 'Sign in again' }).click();
    await expect(page).toHaveURL(/settings\/integrations/);
  });

  test('on a phone the line sits at the top of the More sheet', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loadDemo(page);
    await page.getByTestId('tab-more').click();
    const sheet = page.getByTestId('more-sheet');
    await expect(sheet.getByTestId('activity-line')).toBeVisible();
    await expect(sheet.getByTestId('activity-text')).toHaveText(/Up to date|Checking|Reading|Fetching/);
  });
});
