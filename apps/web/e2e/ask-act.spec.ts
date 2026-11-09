import { expect, type Page, test } from '@playwright/test';
import { loadDemo } from './helpers';

/**
 * Plan 37 on the demo without a Claude key: a name that fits two companies is a question with the choices as buttons
 * and the tap finishes the ask; a card button that only changes data acts in place, adds no turn and is still done
 * when the chat is opened again.
 */
async function ask(page: Page, text: string) {
  await expect(page.getByTestId('composer-stop')).toHaveCount(0);
  await page.getByTestId('composer-input').fill(text);
  await page.keyboard.press('Enter');
}

test.describe('Ask before guessing, act in place', () => {
  test('who do I know at Juniper asks which one, and the tap shows that company', async ({ page }) => {
    await loadDemo(page);
    await ask(page, 'who do I know at Juniper');
    const question = page.getByTestId('result-clarify').last();
    await expect(question).toHaveAttribute('data-state', 'open');
    const options = question.getByTestId('clarify-option');
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toContainText('Juniper Health');
    await expect(options.nth(0)).toContainText('2 people you know there');
    await expect(options.nth(1)).toContainText('Juniper Capital');
    // no company card and no guess beside the question
    await expect(page.getByTestId('turn-assistant').last().getByTestId('result-company')).toHaveCount(0);
    await options.nth(0).click();
    // the student's turn reads as the name they tapped
    await expect(page.getByTestId('turn-user').last()).toHaveText('Juniper Health');
    const card = page.getByTestId('turn-assistant').last().getByTestId('result-company');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Juniper Health');
    await expect(card).toContainText('Nina Vashti');
    // the question above is a quiet line with the choice now
    await expect(page.getByTestId('result-clarify').first()).toHaveAttribute('data-state', 'answered');
    await expect(page.getByTestId('result-clarify').first()).toContainText('Juniper Health');
  });

  test('Add to targets acts in place: no new turn, the chip says Target, and it stays done after a reload', async ({
    page,
  }) => {
    await loadDemo(page);
    await ask(page, 'who do I know at Juniper Health');
    const card = page.getByTestId('turn-assistant').last().getByTestId('result-company');
    await expect(card).toBeVisible();
    const turns = await page.getByTestId('turn-user').count();
    await card.getByTestId('next-step').filter({ hasText: 'Add Juniper Health to targets' }).click();
    await expect(card.locator('[data-testid="next-step"][data-state="done"]')).toHaveText('Added to targets');
    await expect(card).toContainText('Target');
    // nothing was said in the chat
    await page.waitForTimeout(500);
    expect(await page.getByTestId('turn-user').count()).toBe(turns);
    expect(await page.getByTestId('turn-assistant').count()).toBe(turns);
    // opened again from Recent after leaving the app, the card still shows it done
    await page.goto('');
    await page.getByTestId('recent-item').first().click();
    const again = page.getByTestId('result-company').last();
    await expect(again.locator('[data-testid="next-step"][data-state="done"]')).toHaveText(
      'Added to targets',
    );
    await expect(again).toContainText('Target');
  });
});
