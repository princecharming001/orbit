import { expect, type Page, test } from '@playwright/test';
import { loadDemo } from './helpers';

/**
 * The next-step pill on a board card or a list row ("Find a time", "Follow-up") opens that step right there, in a
 * panel over the page, with the same card Drafts shows. Acting on it closes the panel and the board follows.
 */

const boardCard = (page: Page, name: string) =>
  page.locator('[data-testid^="chat-card-"]:not([data-testid="chat-card-move"])').filter({ hasText: name });

/** Every page the tab was on, so a test can say it never left People. */
function pathsSeen(page: Page): string[] {
  const seen: string[] = [];
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) seen.push(new URL(f.url()).pathname);
  });
  return seen;
}

test.describe('The next step opens in place', () => {
  test('a Find a time pill opens its card over the board; dismissing it there closes the panel and the pill goes', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('people?view=board');
    const board = page.getByTestId('pipeline-board');
    await expect(board).toBeVisible();
    const card = boardCard(page, 'Hannah Brooks');
    const pill = card.getByTestId('chat-next');
    await expect(pill).toHaveText('Find a time');
    await expect(pill).toHaveAttribute('aria-haspopup', 'dialog');
    await pill.scrollIntoViewIfNeeded();
    const seen = pathsSeen(page);
    // the board as it is now: it must be the same one, scrolled to the same place, once the panel is open
    await board.evaluate((el) => {
      (window as unknown as { __board?: Element }).__board = el;
    });
    const place = () =>
      page.evaluate(() => ({
        same:
          (window as unknown as { __board?: Element }).__board ===
          document.querySelector('[data-testid="pipeline-board"]'),
        left: document.querySelector('[data-testid="pipeline-board"]')?.scrollLeft,
        top: document.querySelector('main')?.scrollTop,
      }));
    const before = await place();

    await pill.click();
    const panel = page.getByTestId('next-panel');
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(/\/people\?view=board&next=[\w-]+$/);
    await expect(panel).toHaveAttribute('role', 'dialog');
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    await expect(page.getByTestId('next-panel-title')).toHaveText('Find a time with Hannah');
    await expect(page.getByTestId('next-panel-person')).toHaveAttribute('href', /\/people\/[\w-]+$/);
    // the real card, with its draft open to edit and send
    const inPanel = panel.getByTestId('suggestion-schedule_propose');
    await expect(inPanel).toBeVisible();
    await expect(inPanel.locator('textarea').first()).toHaveValue(/Hi Hannah/);
    await expect(panel.getByRole('button', { name: /open email to hannah/i })).toBeVisible();
    await expect(page.getByTestId('next-panel-open-drafts')).toHaveAttribute('href', /\/inbox\?card=[\w-]+$/);
    // nothing about the board moved or was drawn from scratch
    expect(await place()).toEqual({ ...before, same: true });
    // the panel fits the window: once it has slid in, it sits against the right edge, and nothing runs off the side
    await expect
      .poll(async () => {
        const box = (await panel.boundingBox())!;
        return Math.round(box.x + box.width);
      })
      .toBe(1280);
    expect(Math.round((await panel.boundingBox())!.width)).toBe(500);
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    // Escape closes it and puts focus back on the pill
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(page).toHaveURL(/\/people\?view=board$/);
    await expect(pill).toBeFocused();
    // so does a click on the dimmed page
    await pill.click();
    await expect(panel).toBeVisible();
    await page.getByTestId('next-panel-backdrop').click({ position: { x: 40, y: 400 } });
    await expect(panel).toHaveCount(0);
    // Back closes it, and a reload opens it again
    await pill.click();
    await expect(panel).toBeVisible();
    await page.goBack();
    await expect(panel).toHaveCount(0);
    await expect(page).toHaveURL(/\/people\?view=board$/);
    await pill.click();
    await expect(panel).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('next-panel')).toBeVisible();
    await expect(page.getByTestId('next-panel-title')).toHaveText('Find a time with Hannah');

    // dealt with right here: the card's own Dismiss
    await panel.getByRole('button', { name: 'Dismiss' }).click();
    await panel.getByRole('button', { name: 'Not now' }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId('toasts')).toContainText('Card removed.');
    await expect(page).toHaveURL(/\/people\?view=board$/);
    // the board reads the same data: Hannah's card no longer asks for a time
    await expect(card).toBeVisible();
    await expect(card.getByTestId('chat-next').filter({ hasText: 'Find a time' })).toHaveCount(0);
    // all of it without leaving People
    expect(seen.filter((p) => !/\/people$/.test(p))).toEqual([]);
  });

  test('a message approved in the panel goes out from there, and the card moves on', async ({ page }) => {
    await loadDemo(page);
    await page.goto('people?view=board');
    const card = boardCard(page, 'Daniel Okafor');
    await expect(card.getByTestId('chat-next')).toHaveText('Follow-up');
    const seen = pathsSeen(page);
    await card.getByTestId('chat-next').click();
    const panel = page.getByTestId('next-panel');
    await expect(page.getByTestId('next-panel-title')).toHaveText('Follow up with Daniel');
    await panel.getByRole('button', { name: /open email to daniel/i }).click();
    // handed to the mail app: the card still asks whether it went, so the panel waits for the answer
    await expect(panel.getByTestId('outbox-handed_off')).toBeVisible();
    await expect(page).toHaveURL(/next=/);
    await panel.getByRole('button', { name: /^I sent it to Daniel$/i }).click();
    await expect(panel).toHaveCount(0);
    await expect(page).toHaveURL(/\/people\?view=board$/);
    await expect(
      boardCard(page, 'Daniel Okafor').getByTestId('chat-next').filter({ hasText: 'Follow-up' }),
    ).toHaveCount(0);
    expect(seen.filter((p) => !/\/people$/.test(p))).toEqual([]);
  });

  test('the list has the same pill and the same panel; on a phone the panel takes the whole width', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('people?view=list');
    // the pill in the list's Next column (found by its words, not by the table's own markup)
    await page.getByTestId('chat-next').filter({ hasText: 'Find a time' }).first().click();
    const panel = page.getByTestId('next-panel');
    await expect(panel).toBeVisible();
    // the row itself opens the person: the pill's click did not
    await expect(page).toHaveURL(/\/people\?view=list&next=[\w-]+$/);
    await expect(page.getByTestId('next-panel-title')).toHaveText('Find a time with Hannah');
    await page.getByTestId('next-panel-close').click();
    await expect(panel).toHaveCount(0);
    await expect(page).toHaveURL(/\/people\?view=list$/);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('people?view=board');
    await boardCard(page, 'Hannah Brooks').getByTestId('chat-next').click();
    await expect(panel).toBeVisible();
    // once it has slid in, it covers the screen edge to edge
    await expect.poll(async () => Math.round((await panel.boundingBox())!.x)).toBe(0);
    expect(Math.round((await panel.boundingBox())!.width)).toBe(390);
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    // the draft's own Close leaves the panel too: there is nothing to fold it back into here
    await panel.getByTestId('draft-cancel').click();
    await expect(panel).toHaveCount(0);
    await expect(page).toHaveURL(/\/people\?view=board$/);
  });
});
