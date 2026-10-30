import { expect, type Page, test } from '@playwright/test';
import { loadDemo } from './helpers';

const LINK = 'https://boards.greenhouse.io/stripe/jobs/6120000';

async function pastePosting(page: Page) {
  await page.goto('map');
  const input = page.getByTestId('reach-input');
  await input.fill(LINK);
  await expect(input).toHaveValue(LINK);
  await input.press('Enter');
}

/** Plan 23 §4.1: paste a job link, get the plan. */
test.describe('the plan from a job link', () => {
  test('on the Map: three people with badges and days in under 10 s; drafting sends nothing', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await loadDemo(page);
    const started = Date.now();
    await pastePosting(page);
    const plan = page.getByTestId('target-plan');
    await expect(plan).toBeVisible({ timeout: 10_000 });
    const steps = plan.getByTestId('target-plan-step');
    await expect(steps.first()).toBeVisible({ timeout: 10_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    await expect(plan.getByTestId('target-plan-title')).toContainText(
      'Software Engineer Intern · Payments · Stripe',
    );
    const n = await steps.count();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(3);
    for (let i = 0; i < n; i++) {
      await expect(steps.nth(i).getByTestId('target-plan-badge')).toHaveText(/(Direct|route|Long shot|Cold)/);
      await expect(steps.nth(i).getByTestId('target-plan-when')).toHaveText(
        /today|tomorrow|Mon|Tue|Wed|Thu|Fri|after \w+ replies/,
      );
    }
    expect(await plan.innerText()).not.toMatch(/[–—]/);
    const pickId = await steps.first().getAttribute('data-person-id');
    const sentBefore = await page.evaluate(async () => {
      const db = (
        window as unknown as { __orbitDb: { outbound: { toArray(): Promise<{ status: string }[]> } } }
      ).__orbitDb;
      return (await db.outbound.toArray()).filter((o) => o.status === 'sent').length;
    });
    await plan.getByTestId('target-plan-draft-all').click();
    await expect(page).toHaveURL(/\/inbox/);
    await expect(page.getByTestId('toasts')).toContainText(/Drafted .* Nothing is sent until you approve it/);
    const after = await page.evaluate(async () => {
      const db = (
        window as unknown as {
          __orbitDb: {
            outbound: { toArray(): Promise<{ status: string }[]> };
            targetPlans: { toArray(): Promise<{ steps: { status: string }[] }[]> };
          };
        }
      ).__orbitDb;
      const plans = await db.targetPlans.toArray();
      return {
        sent: (await db.outbound.toArray()).filter((o) => o.status === 'sent').length,
        statuses: plans.flatMap((p) => p.steps.map((s) => s.status)),
      };
    });
    expect(after.sent).toBe(sentBefore);
    expect(after.statuses.every((s) => s === 'drafted' || s === 'held' || s === 'done')).toBe(true);
    // the person page of a pick says they are in the plan
    await page.goto(`people/${pickId}`);
    await expect(page.getByTestId('person-in-plan')).toHaveText('In your plan for Stripe');
  });

  test('the chat answers a posting link with the same card', async ({ page }) => {
    test.setTimeout(120_000);
    await loadDemo(page);
    await page.getByTestId('composer-input').fill(`here's a posting ${LINK}`);
    await page.getByTestId('composer-input').press('Enter');
    await expect(page.getByTestId('target-plan')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('target-plan-title')).toContainText('Stripe');
  });

  test('a phone reads the plan top to bottom with the badges intact', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loadDemo(page);
    await pastePosting(page);
    const plan = page.getByTestId('target-plan');
    await expect(plan.getByTestId('target-plan-step').first()).toBeVisible({ timeout: 10_000 });
    await expect(plan.getByTestId('target-plan-badge').first()).toBeVisible();
    const box = (await plan.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('Discover takes a link too, and the company page shows the plan once Stripe is a target', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await loadDemo(page);
    await page.goto('discover');
    await page.getByTestId('discover-search').fill(LINK);
    await page.getByTestId('discover-search').press('Enter');
    await expect(page.getByTestId('target-plan')).toBeVisible({ timeout: 10_000 });
    await page.goto('people?view=companies');
    await page
      .getByRole('button', { name: /Stripe/ })
      .first()
      .click();
    await page.getByRole('link', { name: 'Open Stripe' }).click();
    await expect(page.getByTestId('company-page').getByRole('group', { name: 'Application' })).toBeVisible();
    await expect(page.getByTestId('company-plan-card').getByTestId('target-plan')).toBeVisible();
  });
});
