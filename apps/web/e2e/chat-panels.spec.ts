import { expect, type Page, test } from '@playwright/test';
import { loadDemo } from './helpers';

/**
 * The chat's side panel on the real engine (router mode, demo account): pages open next to the conversation instead
 * of taking the student away from it, the open page lives in the address, and the real pages work inside it.
 */

async function home(page: Page) {
  await loadDemo(page);
  await page.goto('');
  await expect(page.getByTestId('greeting')).toBeVisible();
}

/** The brief card in the thread, from the first chip. */
async function briefInChat(page: Page) {
  await page.getByTestId('chip-who-today').click();
  const brief = page.getByTestId('result-brief');
  await expect(brief).toBeVisible({ timeout: 30_000 });
  return brief;
}

const panel = (page: Page) => page.getByTestId('panel');
const title = (page: Page) => page.getByTestId('panel-title');

test.describe('Side panel (laptop)', () => {
  test('a card opens its page in the panel; refresh, Escape and Back behave', async ({ page }) => {
    await home(page);
    const brief = await briefInChat(page);
    // the brief's "N more in Drafts" opens Drafts, where the rest of the day's cards are
    await brief.getByTestId('brief-more').click();
    await expect(panel(page)).toBeVisible();
    await expect(title(page)).toHaveText('Drafts');
    expect(page.url()).toContain('panel=%2Finbox');
    // the conversation stays beside it
    await expect(page.getByTestId('chat-thread')).toBeVisible();
    await expect(page.getByTestId('composer-input')).toBeVisible();

    // a refresh brings the same panel back (the router writes "/orbit?panel=", which GitHub Pages redirects to
    // "/orbit/?panel=" with the query kept; the preview server cannot, so the test goes to that form itself)
    await page.goto(page.url().replace(/\/orbit\?/, '/orbit/?'));
    await expect(panel(page)).toBeVisible();
    await expect(title(page)).toHaveText('Drafts');

    // Escape closes it and the address loses the panel
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    expect(page.url()).not.toContain('panel=');

    // Back closes a panel the student opened from the chat, and the chat stays
    await page.goto('');
    await expect(page.getByTestId('greeting')).toBeVisible();
    await page.getByTestId('chip-who-today').click();
    await page.getByTestId('result-brief').waitFor({ timeout: 30_000 });
    await page.getByTestId('brief-more').first().click();
    await expect(panel(page)).toBeVisible();
    await page.goBack();
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByTestId('thread-scroll')).toBeVisible();
  });

  test('people open as tabs: switch between them and close one', async ({ page }) => {
    await home(page);
    const brief = await briefInChat(page);
    await brief.locator('a[href*="/people/"]').first().click();
    await expect(panel(page)).toBeVisible();
    // the title resolves from the database, so wait for a real name before reading it
    await expect(title(page)).not.toHaveText(/^(Drafts|Profile)$/);
    const first = await title(page).innerText();
    await brief.getByTestId('brief-more').click();
    await expect(title(page)).toHaveText('Drafts');
    const tabs = page.getByTestId('panel-tabs');
    await expect(tabs.getByRole('tab')).toHaveCount(2);
    await tabs.getByRole('tab', { name: first }).click();
    await expect(title(page)).toHaveText(first);
    await tabs.getByRole('button', { name: `Close ${first}` }).click();
    await expect(title(page)).toHaveText('Drafts');
    await expect(page.getByTestId('panel-tabs')).toHaveCount(0);
  });

  test('links inside the panel stay in the panel, and its Back button steps back', async ({ page }) => {
    await home(page);
    await page.goto(`?panel=${encodeURIComponent('/people')}`);
    await expect(title(page)).toHaveText('People');
    await expect(page.getByTestId('panel-back')).toHaveCount(0);
    await panel(page).locator('a[href*="panel="]').first().click();
    await expect(page.getByTestId('panel-back')).toBeVisible();
    await expect(title(page)).not.toHaveText('People');
    await expect(page.getByTestId('greeting')).toBeVisible();
    await page.getByTestId('panel-back').click();
    await expect(title(page)).toHaveText('People');
  });

  test('expand, shrink and resize with the keyboard', async ({ page }) => {
    await home(page);
    await page.goto(`?panel=${encodeURIComponent('/inbox')}`);
    await expect(panel(page)).toBeVisible();
    const sep = page.getByTestId('panel-resize');
    await sep.focus();
    const before = Number(await sep.getAttribute('aria-valuenow'));
    await page.keyboard.press('ArrowLeft');
    expect(Number(await sep.getAttribute('aria-valuenow'))).toBe(before + 32);
    await page.getByTestId('panel-expand').click();
    await expect(panel(page)).toHaveAttribute('data-expanded', 'true');
    await expect(page.getByTestId('panel-resize')).toHaveCount(0);
    await page.getByTestId('panel-expand').click();
    await expect(panel(page)).toHaveAttribute('data-expanded', 'false');
  });

  test('"open as a page" leaves the chat for the real page', async ({ page }) => {
    await home(page);
    await page.goto(`?panel=${encodeURIComponent('/people?view=list')}`);
    await expect(title(page)).toHaveText('People');
    await page.getByTestId('panel-open-page').click();
    await expect(page).toHaveURL(/\/people\?view=list$/);
    await expect(page.getByTestId('people-view-list')).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page)).toHaveCount(0);
  });

  test('every page the student needs opens in the panel', async ({ page }) => {
    await home(page);
    const pages: [string, string][] = [
      ['/people', 'People'],
      ['/people?view=list', 'People'],
      // an old link opens where its content lives now
      ['/pipeline', 'People'],
      ['/today?card=nope', 'Drafts'],
      ['/map', 'Map'],
      ['/discover', 'Discover'],
      ['/inbox', 'Drafts'],
      ['/notes/new', 'Add a note'],
      ['/settings', 'Settings'],
      ['/settings/integrations', 'Connections'],
    ];
    for (const [href, name] of pages) {
      await page.goto(`?panel=${encodeURIComponent(href)}`);
      await expect(title(page)).toHaveText(name);
      await expect(page.getByTestId('panel-body')).toBeVisible();
      await expect(page.getByTestId('greeting')).toBeVisible();
    }
  });

  test('jobs done inside the panel: dismiss a card, edit a draft without sending it, start a note', async ({
    page,
  }) => {
    await home(page);
    await page.goto(`?panel=${encodeURIComponent('/inbox')}`);
    await expect(title(page)).toHaveText('Drafts');
    const cards = panel(page).locator('[data-testid^="suggestion-"]');
    await expect(cards.first()).toBeVisible();
    const n = await cards.count();
    await cards.first().getByRole('button', { name: 'Dismiss' }).click();
    await cards.first().getByRole('button', { name: 'Not now' }).click();
    await expect(cards).toHaveCount(n - 1);

    // a draft opens and edits in the panel; nothing is sent
    await panel(page)
      .getByRole('button', { name: /^review draft$/i })
      .first()
      .click();
    const body = panel(page).getByLabel('Message body').first();
    await expect(body).toBeVisible();
    await body.fill(`${await body.inputValue()}\n\nEdited in the panel`);
    await expect(body).toHaveValue(/Edited in the panel/);
    const sent = await page.evaluate(async () => {
      const db = (
        window as unknown as { __orbitDb: { outbound: { toArray(): Promise<{ status: string }[]> } } }
      ).__orbitDb;
      return (await db.outbound.toArray()).filter((o) => o.status !== 'draft').length;
    });
    expect(sent).toBe(0);

    // a person's page is reachable and its "Add note" starts a note in the same panel
    await page.goto(`?panel=${encodeURIComponent('/people/p1')}`);
    await expect(title(page)).not.toHaveText(/^(Profile|Drafts)$/);
    const addNote = panel(page).getByTestId('person-add-note');
    await expect(addNote).toBeVisible();
    await addNote.click();
    await expect(title(page)).toHaveText('Add a note');
    await expect(panel(page).getByRole('textbox').first()).toBeVisible();
  });
});

test.describe('Side panel (phone)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a card opens a sheet over the chat; the backdrop and the close button dismiss it', async ({
    page,
  }) => {
    await home(page);
    const brief = await briefInChat(page);
    await brief.getByTestId('brief-more').click();
    const sheet = page.getByTestId('panel-sheet');
    await expect(sheet).toBeVisible();
    await expect(title(page)).toHaveText('Drafts');
    // no horizontal scroll inside the sheet
    const overflow = await page.getByTestId('panel-body').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.mouse.click(195, 20);
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId('thread-scroll')).toBeVisible();
    await brief.getByTestId('brief-more').click();
    await expect(sheet).toBeVisible();
    await page.getByTestId('panel-close').click();
    await expect(sheet).toHaveCount(0);
  });
});
