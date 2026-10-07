import { expect, type Page, test } from '@playwright/test';

async function prep(page: Page) {
  // The demo is laid out on business days relative to "now" (a Monday chat is not "tomorrow" on a Friday), so pin
  // the browser to a Tuesday morning; the clock keeps running from there.
  await page.clock.install({ time: new Date('2026-10-06T10:00:00') });
  await page.addInitScript(() => {
    // headless Chromium closes pages on mailto: popups; the app only uses window.open for hand-offs
    window.open = () => null;
  });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300));
  });
}

async function loadDemo(page: Page) {
  await prep(page);
  await page.goto('');
  await page.getByRole('button', { name: /try it with demo data/i }).click();
  await expect(page).toHaveURL(/\/today$/, { timeout: 90_000 });
  await expect(page.getByText(/good (morning|afternoon|evening)/i)).toBeVisible();
}

test.describe('Orbit demo flow', () => {
  test('landing → demo → today shows a brief with the expected cards', async ({ page }) => {
    await loadDemo(page);
    await expect(page.getByTestId('suggestion-schedule_confirm').first()).toBeVisible();
    await expect(page.getByTestId('suggestion-thank_you').first()).toBeVisible();
    await expect(page.getByTestId('suggestion-prep_brief').first()).toBeVisible();
    await expect(page.getByTestId('suggestion-warm_up_engage').first()).toBeVisible();
    // the season's later stages are exercised too: a referral ask or a nurture check-in
    await expect(
      page.getByTestId('suggestion-ask_referral').or(page.getByTestId('suggestion-nurture_checkin')).first(),
    ).toBeVisible();
    await expect(page.getByText(/upcoming/i)).toBeVisible();
  });

  test('approve a thank-you: approval binds the text, card leaves Today, Sent tab lists it', async ({
    page,
    context,
  }) => {
    await loadDemo(page);
    const card = page.getByTestId('suggestion-thank_you').first();
    const name = await card.getByRole('link').nth(1).innerText();
    await card.locator('button.line-clamp-2').click();
    const textarea = card.getByLabel('Message body');
    await expect(textarea).toBeVisible();
    await textarea.fill(`${await textarea.inputValue()}\n\nPS edited in e2e`);
    await card.getByRole('button', { name: /approve & send/i }).click();
    await expect(page.getByText(/opened in your mail app|sent to/i)).toBeVisible({ timeout: 15_000 });
    await page.goto('inbox?tab=sent');
    await page.getByRole('tab', { name: /sent/i }).click();
    await expect(page.getByText('PS edited in e2e')).toBeVisible();
    await expect(page.getByRole('link', { name })).toBeVisible();
  });

  test('warm-up card: mark done, see progress', async ({ page }) => {
    await loadDemo(page);
    const card = page.getByTestId('suggestion-warm_up_engage').first();
    await expect(card.getByRole('link', { name: /open on linkedin/i })).toHaveAttribute(
      'href',
      /linkedin\.com/,
    );
    await card.getByRole('button', { name: /^done$/i }).click();
    await expect(page.getByText(/logged the warm-up/i)).toBeVisible();
  });

  test('pipeline board renders stages; table lets you change a stage', async ({ page }) => {
    await loadDemo(page);
    await page.goto('pipeline');
    await expect(page.getByTestId('chat-card-scheduling').first()).toBeVisible();
    await expect(page.getByTestId('chat-card-warming').first()).toBeVisible();
    await page.getByRole('tab', { name: 'Table' }).click();
    const select = page.locator('table select').first();
    await select.selectOption('nurturing');
    await page.getByRole('tab', { name: 'Board' }).click();
    await expect(page.getByTestId('chat-card-nurturing').first()).toBeVisible();
    await page.getByRole('tab', { name: 'Companies' }).click();
    await expect(page.getByRole('cell', { name: /target/i }).first()).toBeVisible();
  });

  test('person profile shows summary, facts and prep', async ({ page }) => {
    await loadDemo(page);
    await page.getByTestId('suggestion-thank_you').first().getByRole('link').nth(1).click();
    await expect(page).toHaveURL(/\/people\//);
    await expect(page.getByText(/summary/i).first()).toBeVisible();
    await page.getByRole('tab', { name: /facts/i }).click();
    await expect(page.getByText(/from notes/i).first()).toBeVisible();
    await page.getByRole('tab', { name: /prep/i }).click();
    await expect(page.getByText(/questions to ask/i)).toBeVisible();
    await expect(page.getByText(/your goal for this chat/i)).toBeVisible();
    await expect(page.getByText(/anyone else you'd suggest I talk to/i)).toBeVisible();
    await expect(page.getByTestId('person-summary')).not.toHaveText(/\d{4}-\d{2}-\d{2}|building/i);
    await page.getByTestId('person-write').click();
    await expect(page.getByLabel('Message body')).toBeVisible();
  });

  test('map renders the orbit and reach finds a route', async ({ page }) => {
    await loadDemo(page);
    await page.goto('map');
    await expect(page.getByTestId('orbit-canvas')).toBeVisible();
    await page.goto('pipeline?view=table');
    const name = await page
      .locator('table tbody tr')
      .nth(2)
      .locator('td')
      .first()
      .getByRole('link')
      .innerText();
    await page.goto('map?reach=1');
    await page.getByTestId('reach-input').fill(name.trim());
    await page.getByTestId('reach-input').press('Enter');
    await expect(
      page
        .getByRole('button', { name: /write to|ask .* for an intro/i })
        .or(page.getByText(/no route found/i)),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('reach-input').fill('Stripe');
    await page.getByTestId('reach-input').press('Enter');
    await expect(page.getByText(/people there now/i)).toBeVisible();
  });

  test('capture a dictated note: facts land on the profile', async ({ page }) => {
    await loadDemo(page);
    await page.goto('notes/new');
    const select = page.getByTestId('capture-person');
    await expect.poll(() => select.locator('option').count(), { timeout: 15_000 }).toBeGreaterThan(1);
    const options = await select.locator('option').allInnerTexts();
    const target = options.find((o) => o.includes('·'))!;
    await select.selectOption({ label: target });
    await page
      .getByTestId('capture-text')
      .fill(
        'They recommended practicing system design interviews. They offered to refer me when the posting goes up. I will send my resume by Friday. They are hiring in January.',
      );
    await page.getByTestId('capture-save').click();
    await expect(page).toHaveURL(/\/people\//, { timeout: 15_000 });
    await page.getByRole('tab', { name: /facts/i }).click();
    await expect(page.getByText(/offered to refer me/i).first()).toBeVisible();
    await expect(page.getByText(/you promised/i).first()).toBeVisible();
  });

  test('discover: start a warm-up or outreach from a recommendation', async ({ page }) => {
    await loadDemo(page);
    await page.goto('discover');
    await expect(page.getByTestId('rec-card').first()).toBeVisible();
    await page.getByTestId('rec-start').first().click();
    await expect(page.getByLabel('Message body').or(page.getByText(/warm-up started/i))).toBeVisible({
      timeout: 15_000,
    });
  });

  test('settings: export and wipe', async ({ page }) => {
    await loadDemo(page);
    await page.goto('settings/privacy');
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: /export everything/i }).click();
    expect((await dl).suggestedFilename()).toMatch(/orbit-export/);
    page.on('dialog', (d) => d.accept());
    await page.getByRole('button', { name: /delete all data/i }).click();
    await expect(page).toHaveURL(/\/(orbit\/?)?$/);
  });
});

test.describe('Manual onboarding', () => {
  test('a new user can set up without any integration and reach an empty Today', async ({ page }) => {
    await prep(page);
    await page.goto('');
    await page
      .getByRole('button', { name: /^get started/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/onboarding\/2/);
    await page.getByTestId('ob-name').fill('Sam Okafor');
    await page.getByTestId('ob-email').fill('sam@umich.edu');
    await page.getByTestId('ob-school').fill('University of Michigan');
    await page.getByRole('button', { name: /continue/i }).click();
    await expect(page).toHaveURL(/\/onboarding\/3/);
    await page.getByTestId('ob-fn-pm').click();
    await page.getByTestId('ob-company').fill('Figma');
    await page.getByRole('button', { name: /^add$/i }).click();
    await expect(page.getByText('Figma')).toBeVisible();
    // the same company again, in another case, is not added twice
    await page.getByTestId('ob-company').fill('figma');
    await page.getByRole('button', { name: /^add$/i }).click();
    await expect(page.getByText(/already on your list/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /remove figma/i })).toHaveCount(1);
    await page.getByRole('button', { name: /continue/i }).click();
    await expect(page).toHaveURL(/\/onboarding\/4/);
    await page.getByRole('button', { name: /skip for now/i }).click();
    await page.getByRole('button', { name: /skip for now/i }).click(); // google
    // linkedin: upload a tiny CSV
    const csv =
      'First Name,Last Name,URL,Email Address,Company,Position,Connected On\nPriya,Patel,https://www.linkedin.com/in/priya-patel,priya@figma.com,Figma,Product Manager,12 Mar 2025\nDaniel,Kim,https://www.linkedin.com/in/daniel-kim,,Stripe,Software Engineer,03 Jan 2024\n';
    await page
      .getByTestId('ob-linkedin')
      .setInputFiles({ name: 'Connections.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(page.getByText(/2 people added/i)).toBeVisible();
    await page.getByRole('button', { name: /continue/i }).click();
    await page.getByRole('button', { name: /continue/i }).click(); // notes
    await page.getByRole('button', { name: /finish setup/i }).click();
    await expect(page).toHaveURL(/\/today$/, { timeout: 30_000 });
    await page.goto('people');
    await expect(page.getByRole('link', { name: /priya patel/i })).toBeVisible();
    await page.goto('discover');
    await expect(page.getByTestId('rec-card').first()).toBeVisible();
    // Coming back to the landing page never offers to wipe this profile.
    await page.goto('');
    await expect(page.getByRole('button', { name: /open orbit/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /try it with demo data|try the demo/i })).toHaveCount(0);
    await page
      .getByRole('button', { name: /open orbit/i })
      .last()
      .click();
    await expect(page).toHaveURL(/\/today$/);
    await page.goto('onboarding/99');
    await expect(page).toHaveURL(/\/today$/);
  });

  test('landing during setup continues it and asks before loading the demo over it', async ({ page }) => {
    await prep(page);
    await page.goto('');
    await page
      .getByRole('button', { name: /^get started/i })
      .first()
      .click();
    await page.getByTestId('ob-name').fill('Real Person');
    await page.getByTestId('ob-email').fill('real@umich.edu');
    await page.getByTestId('ob-school').fill('University of Michigan');
    await page.getByRole('button', { name: /continue/i }).click();
    await expect(page).toHaveURL(/\/onboarding\/3/);
    await page.goto('');
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      d.dismiss();
    });
    await page.getByRole('button', { name: /try it with demo data/i }).click();
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toMatch(/discards the setup you started for Real Person/);
    await page
      .getByRole('button', { name: /continue setup/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/onboarding\/3/);
  });
});

test.describe('Keyboard, dead ends and plain words', () => {
  test('palette closes on Escape; board cards are focusable and movable without dragging', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Snooze for 3 days' }).first()).toBeVisible();
    await page.goto('pipeline');
    const card = page.getByTestId('chat-card-warming').first();
    const name = await card.getByRole('link').innerText();
    await card.getByRole('link').focus();
    await expect(card.getByRole('link')).toBeFocused();
    await card.getByTestId('chat-card-move').selectOption('identified');
    await expect(page.getByTestId('chat-card-identified').filter({ hasText: name })).toBeVisible();
    await page.getByTestId('chat-card-identified').filter({ hasText: name }).getByRole('link').press('Enter');
    await expect(page).toHaveURL(/\/people\//);
  });

  test('dead-end links explain themselves and lead back', async ({ page }) => {
    await loadDemo(page);
    await page.goto('people/nope');
    await expect(page.getByText(/can't find that person/i)).toBeVisible();
    await page.getByRole('link', { name: /back to people/i }).click();
    await expect(page).toHaveURL(/\/people$/);
    await page.goto('companies/nope');
    await expect(page.getByText(/can't find that company/i)).toBeVisible();
    await page.goto('settings/bogus');
    await expect(page).toHaveURL(/\/settings\/profile$/);
  });

  test('no internal codes on screen', async ({ page }) => {
    await loadDemo(page);
    for (const path of [
      'today',
      'pipeline?view=table',
      'discover',
      'people',
      'inbox',
      'settings/goals',
      'map',
    ]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const text = await page.locator('main').innerText();
      expect(text, path).not.toMatch(
        /\b(swe|warm_up_engage|via gmail|thank_you|family friend|long_shot|confirm stage|schedule confirm)\b|_/,
      );
      // One word per concept (docs/plan/09 section 8).
      expect(text, path).not.toMatch(/strong ties|\boutreach\b|inbox zero/i);
      // Sentences, not dashes: card reasons and recommendation copy (a dash in an empty stat cell is fine).
      const cards = page.locator('[data-testid^="suggestion-"], [data-testid="rec-card"]');
      for (const t of await cards.allInnerTexts()) expect(t, path).not.toMatch(/[—–]/);
    }
  });

  test('writing to a cold LinkedIn contact explains the warm-up and allows a direct message', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('discover');
    const cold = page
      .getByTestId('rec-card')
      .filter({ has: page.getByRole('button', { name: /start warm-up/i }) });
    await expect(cold.first()).toBeVisible();
    await cold.first().getByRole('link').nth(1).click();
    await expect(page).toHaveURL(/\/people\//);
    await page.getByTestId('person-write').click();
    await expect(page.getByTestId('warmup-choice')).toBeVisible();
    await expect(page.getByTestId('warmup-choice').getByText(/haven't talked yet/i)).toBeVisible();
    await page.getByTestId('warmup-skip').click();
    await expect(page.getByLabel('Message body')).toBeVisible({ timeout: 15_000 });
  });
});

for (const vp of [
  { name: 'phone', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
]) {
  test(`layout fits a ${vp.width}px ${vp.name} screen`, async ({ page }, info) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await loadDemo(page);
    const fits = async (label: string) => {
      await page.waitForLoadState('networkidle');
      const over = await page.evaluate(() => {
        const main = document.querySelector('main');
        return {
          doc: document.documentElement.scrollWidth - window.innerWidth,
          main: main ? main.scrollWidth - main.clientWidth : 0,
        };
      });
      await page.screenshot({ path: info.outputPath(`${vp.name}-${label}.png`), fullPage: false });
      expect(over.doc, `${label} page overflow`).toBeLessThanOrEqual(1);
      expect(over.main, `${label} main overflow`).toBeLessThanOrEqual(1);
    };
    await fits('today');
    if (vp.width < 768) {
      await expect(page.getByTestId('mobile-settings')).toBeVisible();
      await expect(page.getByTestId('mobile-add-note')).toBeVisible();
    }
    const card = page.getByTestId('suggestion-thank_you').first();
    const box = await card.getByRole('button', { name: /dismiss/i }).boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(vp.width);
    await card.locator('button.line-clamp-2').click();
    await expect(card.getByLabel('Message body')).toBeVisible();
    await fits('today-draft-open');
    for (const path of ['pipeline', 'pipeline?view=table', 'people', 'discover', 'inbox', 'settings/goals']) {
      await page.goto(path);
      await fits(path.replace(/[?=/]/g, '-'));
    }
    await page.goto('people');
    await page.locator('table tbody tr').first().getByRole('link').click();
    await expect(page).toHaveURL(/\/people\//);
    await fits('person');
    const write = await page.getByTestId('person-write').boundingBox();
    expect(write && write.x + write.width).toBeLessThanOrEqual(vp.width);
    const h1 = await page.locator('h1').boundingBox();
    expect(h1!.width).toBeGreaterThan(120);
    await page.getByTestId('person-write').click();
    await expect(page.getByLabel('Message body')).toBeVisible({ timeout: 15_000 });
    await fits('person-compose');
  });
}
