import { expect, type Page, test } from '@playwright/test';
import { loadDemo } from './helpers';

async function openStripe(page: Page) {
  await page.goto('people?view=companies');
  await page
    .getByRole('button', { name: /Stripe/ })
    .first()
    .click();
  await page.getByRole('link', { name: 'Open Stripe' }).click();
  await expect(page.getByTestId('company-page')).toBeVisible();
  await expect(page.getByTestId('company-person').first()).toBeVisible({ timeout: 20_000 });
}

/** Plan 23 §4.2: a company as a target, everyone there with the way in the Map shows. */
test.describe('the company page', () => {
  test('stats, team chips, and each badge is the one the Map shows for that person', async ({ page }) => {
    test.setTimeout(120_000);
    await loadDemo(page);
    await openStripe(page);
    await expect(page.getByTestId('company-stat')).toHaveCount(4);
    const chips = page.getByTestId('company-team-chip');
    await expect(chips.first()).toHaveText('All teams');
    expect(await chips.count()).toBeGreaterThan(1);
    // a team chip filters the list in place to that team
    const second = chips.nth(1);
    const team = (await second.innerText()).split(' · ')[0]!;
    await second.click();
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    for (const g of await page.getByTestId('company-group').all())
      await expect(g.locator('h2')).toContainText(team);
    await chips.first().click();
    // every number has its why on hover
    for (const s of await page.locator('[data-testid="company-stats"] > div').all())
      expect(await s.getAttribute('title')).toBeTruthy();
    // the first row's badge is the badge the Map shows for the same route
    const row = page.getByTestId('company-person').first();
    const id = await row.getAttribute('data-person-id');
    const badge = (await row.getByTestId('route-badge').innerText()).trim();
    await page.goto(`map?reach=${id}`);
    await expect(page.getByTestId('reach-path').first()).toBeVisible({ timeout: 20_000 });
    const onMap = (await page.getByTestId('reach-path-score').allInnerTexts()).map((t) => t.trim());
    expect(onMap).toContain(badge);
    // no dash anywhere on the page
    await openStripe(page);
    expect(await page.getByTestId('company-page').innerText()).not.toMatch(/[–—]/);
  });

  test('Set as target shows the application chips; Ask on a warm row lands on the intro card', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await loadDemo(page);
    // a company the demo student has not made a target yet
    const orgId = await page.evaluate(async () => {
      const db = (
        window as unknown as {
          __orbitDb: {
            organizations: { toArray(): Promise<{ id: string; name: string }[]> };
            targetCompanies: { toArray(): Promise<{ nameRaw: string }[]> };
            people: { toArray(): Promise<{ currentOrganizationId?: string }[]> };
          };
        }
      ).__orbitDb;
      const targets = new Set((await db.targetCompanies.toArray()).map((t) => t.nameRaw.toLowerCase()));
      const people = await db.people.toArray();
      const count = (id: string) => people.filter((p) => p.currentOrganizationId === id).length;
      return (await db.organizations.toArray())
        .filter((o) => !targets.has(o.name.toLowerCase()))
        .sort((a, b) => count(b.id) - count(a.id))[0]!.id;
    });
    await page.goto(`companies/${orgId}`);
    await expect(page.getByTestId('company-set-target')).toBeVisible();
    await page.getByTestId('company-set-target').click();
    const target = page.getByTestId('company-page').getByTestId('company-target');
    await expect(target).toBeVisible();
    await expect(target.getByRole('button', { name: 'Researching' })).toHaveAttribute('aria-pressed', 'true');
    await target.getByRole('button', { name: 'Applied' }).click();
    await expect(target.getByRole('button', { name: 'Applied' })).toHaveAttribute('aria-pressed', 'true');
    // a warm row somewhere in the demo: its button asks the first person on the route
    await openStripe(page);
    const ask = page.getByTestId('company-person-action').filter({ hasText: /^Ask / }).first();
    await expect(ask).toBeVisible();
    await ask.click();
    await expect(page).toHaveURL(/\/inbox\?card=/);
    await expect(page.getByTestId('toasts')).toContainText(/request to \w+ for an intro/);
  });

  test('a phone reads the page top to bottom with the badges intact', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loadDemo(page);
    await openStripe(page);
    const row = page.getByTestId('company-person').first();
    await expect(row.getByTestId('route-badge')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

/**
 * Plan 23 §4.3, as plan 42 changed it: the note the introducer can forward is inside the ask itself, so the one text the
 * student reads and edits is exactly what goes out. No second box beside it.
 */
test.describe('the intro ask with its note', () => {
  test('one card, one text with the note inside it; approving sends exactly that text', async ({ page }) => {
    test.setTimeout(120_000);
    await loadDemo(page);
    await openStripe(page);
    const ask = page.getByTestId('company-person-action').filter({ hasText: /^Ask / }).first();
    const via = (await ask.innerText()).replace(/^Ask /, '');
    await ask.click();
    await expect(page).toHaveURL(/\/inbox\?card=/);
    const card = page.getByTestId('suggestion-intro_request').filter({ hasText: via }).first();
    // no separate note under the preview, and none in the editor
    await expect(card.getByTestId('draft-preview-note')).toHaveCount(0);
    await card.getByTestId('draft-review').click();
    await expect(card.getByTestId('forward-note')).toHaveCount(0);
    // the note is in the ask: a lead-in, then the note in quotes, about the student in the third person
    const askText = await card.getByLabel('Message body').inputValue();
    expect(askText).toMatch(/here's a short note you could forward:\n\n"/i);
    expect(askText).not.toMatch(/note below/i);
    const quoted = askText.match(/"([^"]+)"/)?.[1] ?? '';
    expect(quoted).toMatch(/15 minutes/);
    expect(quoted).not.toMatch(/\b(I|my|me)\b/);
    // approving sends that text as it is: nothing is added under it
    await page
      .getByRole('button', { name: /^(Open email to|Send to|Copy & open LinkedIn)/ })
      .first()
      .click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const db = (
            window as unknown as {
              __orbitDb: {
                outbound: { toArray(): Promise<{ kind: string; bodyFinal?: string; status: string }[]> };
              };
            }
          ).__orbitDb;
          const o = (await db.outbound.toArray()).find(
            (x) => x.kind === 'intro_request' && x.status !== 'draft',
          );
          return o?.bodyFinal ?? '';
        }),
      )
      .toContain(quoted);
    const sent = await page.evaluate(async () => {
      const db = (
        window as unknown as {
          __orbitDb: {
            outbound: { toArray(): Promise<{ kind: string; bodyFinal?: string; status: string }[]> };
          };
        }
      ).__orbitDb;
      return (await db.outbound.toArray()).find((x) => x.kind === 'intro_request' && x.status !== 'draft')
        ?.bodyFinal;
    });
    expect(sent).not.toContain('\n\n----\n\n');
  });
});
