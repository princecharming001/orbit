import { expect, type Page, test } from '@playwright/test';
import { loadDemo } from './helpers';

/**
 * Plan 42: a card's button does its work beside the chat, not as another message in it. "Write to Lena", "Ask Arnav
 * for an intro", "Find warm routes" run at once and open their card in the side panel: the thread gets no new turn,
 * the step reads as done, and tapping it again opens the same card instead of writing a second one. The real engine
 * in router mode on the demo account. CHAT_SHOTS_DIR, when set, receives chat-panel-*.png.
 */
const SHOTS = process.env.CHAT_SHOTS_DIR;

async function home(page: Page) {
  await loadDemo(page);
  await page.goto('');
  await expect(page.getByTestId('greeting')).toBeVisible();
}

async function ask(page: Page, text: string) {
  await expect(page.getByTestId('composer-stop')).toHaveCount(0);
  await page.getByTestId('composer-input').fill(text);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('turn-user').last()).toHaveText(text);
}

const panel = (page: Page) => page.getByTestId('panel');
const turns = (page: Page) => page.getByTestId('turn-user');

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${SHOTS}/chat-panel-${name}.png` });
}

test.describe('Card buttons open beside the chat (plan 42)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('a next step writes the draft in the side panel, with no new message, and opens it again', async ({
    page,
  }) => {
    await home(page);
    await ask(page, 'who do I know at Ramp');
    const company = page.getByTestId('result-company').last();
    await expect(company).toBeVisible({ timeout: 20_000 });
    const before = await turns(page).count();
    const write = company.locator('[data-testid="next-step"][data-mode="panel"]').first();
    await expect(write).toBeVisible();
    const label = (await write.innerText()).trim();
    expect(label).toMatch(/^Write to /);
    await write.click();
    // the draft card, beside the chat, titled for what the step did
    await expect(panel(page)).toBeVisible({ timeout: 20_000 });
    const result = panel(page).getByTestId('panel-result');
    await expect(result).toHaveAttribute('data-kind', 'draft');
    await expect(page.getByTestId('panel-title')).toHaveText(/^Draft to /);
    // a card, not a page: there is no page to open it as
    await expect(page.getByTestId('panel-open-page')).toHaveCount(0);
    // the thread is as it was: no new message, no new turn
    expect(await turns(page).count()).toBe(before);
    await expect(page.getByTestId('turn-working')).toHaveCount(0);
    // the step reads as done, and says where it went
    const done = company.locator('[data-testid="next-step"][data-mode="panel"]').first();
    await expect(done).toHaveAttribute('data-state', 'done');
    await expect(done).toContainText(/Draft to .*Open/);
    await shot(page, 'draft-open');
    // closing and tapping again opens the same draft, never a second one
    await page.getByTestId('panel-close').click();
    await expect(panel(page)).toHaveCount(0);
    const drafts = await page.evaluate(async () => {
      const req = indexedDB.open('orbit');
      const db: IDBDatabase = await new Promise((r) => {
        req.onsuccess = () => r(req.result);
      });
      return new Promise<number>((r) => {
        const q = db.transaction('outbound').objectStore('outbound').count();
        q.onsuccess = () => r(q.result);
      });
    });
    await done.click();
    await expect(panel(page).getByTestId('panel-result')).toHaveAttribute('data-kind', 'draft');
    const after = await page.evaluate(async () => {
      const req = indexedDB.open('orbit');
      const db: IDBDatabase = await new Promise((r) => {
        req.onsuccess = () => r(req.result);
      });
      return new Promise<number>((r) => {
        const q = db.transaction('outbound').objectStore('outbound').count();
        q.onsuccess = () => r(q.result);
      });
    });
    expect(after).toBe(drafts);
    expect(await turns(page).count()).toBe(before);
    // a refresh keeps the panel's card (it is read back from what the tap recorded)
    await page.goto(page.url().replace(/\/orbit\?/, '/orbit/?'));
    await expect(panel(page).getByTestId('panel-result')).toHaveAttribute('data-kind', 'draft', {
      timeout: 20_000,
    });
  });

  test('picked people: routes to each open beside the chat, and their asks open in the same panel', async ({
    page,
  }) => {
    await home(page);
    await ask(page, 'Connect my LinkedIn.');
    const widget = page.getByTestId('setup-linkedin');
    await widget.getByTestId('linkedin-live-connect').click();
    await expect(widget.getByTestId('linkedin-live-connected')).toContainText('Synced live', {
      timeout: 20_000,
    });
    await ask(page, 'find me mentors at Stripe');
    const list = page.getByTestId('result-list').last();
    await expect(list).toBeVisible({ timeout: 20_000 });
    const boxes = list.getByTestId('pick-person');
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    const before = await turns(page).count();
    const routes = list.getByTestId('selection-step').filter({ hasText: 'Add and find routes' });
    await expect(routes).toHaveAttribute('data-mode', 'panel');
    await routes.click();
    const result = panel(page).getByTestId('panel-result');
    await expect(result).toHaveAttribute('data-kind', 'routes_many', { timeout: 30_000 });
    await expect(result.getByTestId('routes-many-person')).toHaveCount(2);
    expect(await turns(page).count()).toBe(before);
    // the pill says what it did, and opens it again
    await expect(
      list.getByTestId('selection-step').filter({ hasText: /^Added, routes to 2 people/ }),
    ).toBeVisible();
    await shot(page, 'routes-many');
    // a step on the card in the panel opens in the panel too, and Back returns to the routes
    const write = result.locator('[data-testid="next-step"][data-mode="panel"]').first();
    await write.click();
    await expect(panel(page).getByTestId('panel-result')).toHaveAttribute('data-kind', /draft|text/, {
      timeout: 20_000,
    });
    expect(await turns(page).count()).toBe(before);
    await shot(page, 'routes-many-then-draft');
    // the intro ask is one message: the note to forward is inside it, with no second box beside it
    const draft = panel(page).getByTestId('panel-result');
    if ((await draft.getAttribute('data-kind')) === 'draft') {
      await expect(draft.getByTestId('forward-note')).toHaveCount(0);
      // sending from the panel goes through the same approval as in the thread
      const send = draft.getByRole('button', { name: /^(Open email to|Send to) / });
      if (await send.isEnabled()) {
        await send.click();
        await expect(draft.getByTestId('result-outcome')).toBeVisible({ timeout: 20_000 });
        expect(await turns(page).count()).toBe(before);
        await shot(page, 'sent-from-panel');
      }
    }
    await page.getByTestId('panel-back').click();
    await expect(panel(page).getByTestId('panel-result')).toHaveAttribute('data-kind', 'routes_many');
  });

  test('without a panel to show it (a phone-sized screen still has one): the step never sends a message', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await home(page);
    await ask(page, 'who do I know at Ramp');
    const company = page.getByTestId('result-company').last();
    await expect(company).toBeVisible({ timeout: 20_000 });
    const before = await turns(page).count();
    await company.locator('[data-testid="next-step"][data-mode="panel"]').first().click();
    await expect(panel(page).getByTestId('panel-result')).toHaveAttribute('data-kind', 'draft', {
      timeout: 20_000,
    });
    expect(await turns(page).count()).toBe(before);
    await shot(page, 'phone-draft');
  });
});
