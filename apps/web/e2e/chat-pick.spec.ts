import { expect, type Page, test } from '@playwright/test';
import { loadDemo } from './helpers';

const composer = (page: Page) => page.getByTestId('composer-input');
async function ask(page: Page, text: string) {
  await expect(page.getByTestId('composer-stop')).toHaveCount(0);
  await composer(page).fill(text);
  await page.keyboard.press('Enter');
}

/** The people on a list of search results can be picked, and the picked ones get warm routes in one card. */
test.describe('Picking people on a card', () => {
  test('a LinkedIn search: pick two, Find warm routes adds them and shows the best way in to each', async ({
    page,
  }) => {
    await loadDemo(page);
    // live LinkedIn in the demo is the mock connector: connect it so the search can run
    await ask(page, 'Connect my LinkedIn.');
    const widget = page.getByTestId('setup-linkedin');
    await expect(widget).toBeVisible();
    await widget.getByTestId('linkedin-live-connect').click();
    await expect(widget.getByTestId('linkedin-live-connected')).toContainText('Synced live', {
      timeout: 20_000,
    });
    await ask(page, 'find me mentors at Stripe');
    const list = page.getByTestId('result-list').last();
    await expect(list).toBeVisible({ timeout: 20_000 });
    const boxes = list.getByTestId('pick-person');
    await expect(boxes.first()).toBeVisible();
    expect(await boxes.count()).toBeGreaterThan(1);
    // nothing picked yet: no count, the usual next steps stay
    await expect(list.getByTestId('selection-count')).toHaveCount(0);
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await expect(list.getByTestId('selection-count')).toHaveText('2 picked');
    // the checkbox labels name the people picked ("Pick Dana Lee")
    const names = (await boxes.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? '')))
      .slice(0, 2)
      .map((t) => t.replace(/^Pick /, '').trim());
    await list.getByTestId('selection-step').filter({ hasText: 'Find warm routes' }).click();
    // the message names them, with the ids the add needs, and the answer is one card with both
    await expect(page.getByTestId('turn-user').last()).toContainText(
      'Add to People and find warm routes to each of',
    );
    const card = page.getByTestId('result-routes_many').last();
    await expect(card).toBeVisible({ timeout: 30_000 });
    const rows = card.getByTestId('routes-many-person');
    await expect(rows).toHaveCount(2);
    for (const name of names) await expect(card).toContainText(name.split(' ')[0]!);
    // each person offers the step to take
    await expect(rows.first().getByTestId('next-step').first()).toBeVisible();
    // they are saved to contact, not someone the student knows: the board has them at To contact
    await page.goto('people?view=board');
    for (const name of names)
      await expect(
        page
          .getByTestId('chat-card-identified')
          .filter({ hasText: name.split(' ')[0]! })
          .first(),
      ).toBeVisible();
  });

  test('a people card: pick both, Find warm routes answers with one card', async ({ page }) => {
    await loadDemo(page);
    await ask(page, 'who do I know at Stripe');
    const card = page.getByTestId('result-company').last();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await ask(page, 'find warm routes to each of: Priya Ahmed and Elena Garcia');
    const many = page.getByTestId('result-routes_many').last();
    await expect(many).toBeVisible({ timeout: 30_000 });
    await expect(many.getByTestId('routes-many-person')).toHaveCount(2);
    await expect(many).toContainText('Priya');
    await expect(many).toContainText('Elena');
  });
});
