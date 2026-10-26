import { expect, test } from '@playwright/test';
import { prep } from './helpers';

test.describe('Landing page', () => {
  test('the Prep deck works: Next, Back, a card from the list, the arrow keys and a swipe', async ({
    page,
  }) => {
    await prep(page);
    await page.goto('');
    const deck = page.getByTestId('lp-prep');
    await deck.scrollIntoViewIfNeeded();
    await expect(deck).toHaveAttribute('data-step', '5');
    await expect(deck).toContainText('Your 30-second intro');
    await page.getByTestId('lp-prep-next').click();
    await expect(deck).toHaveAttribute('data-step', '6');
    await expect(deck).toContainText('Openers');
    await page.getByTestId('lp-prep-back').click();
    await page.getByTestId('lp-prep-back').click();
    await expect(deck).toHaveAttribute('data-step', '4');
    await page.getByTestId('lp-prep-jump').filter({ hasText: 'Questions' }).click();
    await expect(deck).toHaveAttribute('data-step', '7');
    // up to three questions tick
    const boxes = deck.getByRole('checkbox');
    for (let i = 0; i < 3; i++) await boxes.nth(i).check();
    await expect(boxes.nth(3)).toBeDisabled();
    await deck.focus();
    await page.keyboard.press('ArrowRight');
    await expect(deck).toHaveAttribute('data-step', '8');
    await deck.dispatchEvent('pointerdown', {
      pointerType: 'touch',
      clientX: 300,
      clientY: 300,
      bubbles: true,
    });
    await deck.dispatchEvent('pointerup', {
      pointerType: 'touch',
      clientX: 100,
      clientY: 305,
      bubbles: true,
    });
    await expect(deck).toHaveAttribute('data-step', '9');
    await expect(page.getByTestId('lp-prep-next')).toHaveText(/start over/i);
    await expect(deck).not.toHaveText(/[–—]/);
  });

  test('the line under the faces says the same number of students as the count at the top', async ({
    page,
  }) => {
    await prep(page);
    await page.goto('');
    const count = page.getByTestId('trusted-count');
    await count.scrollIntoViewIfNeeded();
    const line = page.getByTestId('lp-students-line');
    await line.scrollIntoViewIfNeeded();
    const n = (await line.textContent())!.match(
      /^([\d,]+) students are already using Orbit to land jobs\.$/,
    )![1]!;
    // the count at the top counts up to it the first time it is seen
    await expect.poll(async () => (await count.textContent())?.replace(/\s/g, '')).toContain(n);
  });
});
