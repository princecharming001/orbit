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

  test('the hero shows Live with the two columns and no student count; the faces line is a placeholder', async ({
    page,
  }) => {
    await prep(page);
    await page.goto('');
    const hero = page.getByTestId('trusted-by');
    await expect(hero).toContainText('Live');
    await expect(hero.getByTestId('trusted-schools')).toBeVisible();
    await expect(hero.getByTestId('trusted-companies')).toBeVisible();
    await expect(page.getByTestId('trusted-count')).toHaveCount(0);
    await expect(hero).not.toContainText(/\d{1,3},\d{3}\s+students/);
    await page.getByTestId('lp-students-line').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('lp-students-line')).toHaveText(
      'XXX students are already using Orbit to land jobs.',
    );
  });
});
