import { expect, type Page, test } from '@playwright/test';

type Db = {
  __orbitDb: {
    briefs: {
      toArray(): Promise<{ id: string; generatedAt: string }[]>;
      update(id: string, c: Record<string, unknown>): Promise<number>;
    };
    outbound: { toArray(): Promise<{ id: string; status: string; kind: string }[]> };
  };
};

/** The demo on a Sunday evening, with the review allowed to open by itself. */
async function sundayDemo(page: Page) {
  await page.clock.install({ time: new Date('2026-10-11T18:30:00') });
  await page.addInitScript(() => {
    (window as unknown as { __ORBIT_REVIEW__: string }).__ORBIT_REVIEW__ = 'on';
    window.open = () => null;
  });
  await page.goto('');
  await page
    .getByRole('button', { name: /^try the demo$/i })
    .first()
    .click();
  await expect(page.getByTestId('greeting')).toContainText(/^Hey /, { timeout: 90_000 });
  // the student has had Orbit more than a week
  await page.evaluate(async () => {
    const db = (window as unknown as Db).__orbitDb;
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    for (const b of await db.briefs.toArray()) await db.briefs.update(b.id, { generatedAt: old });
  });
}

/** Plan 23 §4.8: the weekly review on Sunday evening. */
test.describe('the weekly review', () => {
  test('opens on Sunday evening, four cards, Approve on a nudge sends it, and it reopens from Drafts', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await sundayDemo(page);
    await page.goto('');
    const deck = page.getByTestId('week-review');
    await expect(deck).toBeVisible({ timeout: 20_000 });
    await expect(deck).toHaveAttribute('data-step', 'week');
    const headline = deck.getByTestId('week-review-headline').or(deck.getByTestId('week-review-empty'));
    await expect(headline).toHaveText(
      /^(\d+ reached · \d+ replied · \d+ chats? booked · \d+ went quiet|Nothing moved this week)/,
    );
    expect(await deck.innerText()).not.toMatch(/[–—]/);
    // the arrow keys move it, card by card
    await page.keyboard.press('ArrowRight');
    await expect(deck).toHaveAttribute('data-step', 'moved');
    await page.keyboard.press('ArrowRight');
    await expect(deck).toHaveAttribute('data-step', 'waiting');
    const approve = deck.getByTestId('week-review-approve').first();
    if (await approve.count()) {
      const before = await page.evaluate(
        async () =>
          (await (window as unknown as Db).__orbitDb.outbound.toArray()).filter((o) => o.status !== 'draft')
            .length,
      );
      await approve.click();
      await expect(approve).toHaveText('Approved');
      const after = await page.evaluate(
        async () =>
          (await (window as unknown as Db).__orbitDb.outbound.toArray()).filter((o) => o.status !== 'draft')
            .length,
      );
      expect(after).toBe(before + 1);
    }
    await page.keyboard.press('ArrowRight');
    await expect(deck).toHaveAttribute('data-step', 'next');
    await expect(deck.getByTestId('week-review-next-week')).toContainText(/Next week: \d+ first messages?/);
    await deck.getByTestId('week-review-next').click();
    await expect(deck).toHaveCount(0);
    // the week is kept as its recap brief once the review is put away
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await (window as unknown as Db).__orbitDb.briefs.toArray()).some(
            (b) => (b as { kind?: string }).kind === 'recap',
          ),
        ),
      )
      .toBe(true);
    // it does not come back by itself this week, and Drafts keeps it a tap away
    await page.goto('');
    await expect(page.getByTestId('greeting')).toBeVisible();
    await expect(page.getByTestId('week-review')).toHaveCount(0);
    await page.goto('inbox');
    await page.getByTestId('drafts-last-review').click();
    await expect(page.getByTestId('week-review')).toBeVisible();
  });
});
