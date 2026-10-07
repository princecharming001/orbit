import { expect, type Page, type TestInfo, test } from '@playwright/test';

async function prep(page: Page) {
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
      .locator('span.font-medium')
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

/** Add `n` synthetic contacts (Zipf-distributed companies, mostly weak ties) straight into IndexedDB. */
async function injectPeople(page: Page, n: number) {
  await page.evaluate(async (count) => {
    const open = indexedDB.open('orbit');
    const idb: IDBDatabase = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    const userId: string = await new Promise((res) => {
      const r = idb.transaction('users').objectStore('users').getAll();
      r.onsuccess = () => res((r.result as { id: string }[])[0]!.id);
    });
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const tx = idb.transaction('people', 'readwrite');
    const store = tx.objectStore('people');
    const companies = Math.max(5, Math.round(count / 3));
    for (let i = 0; i < count; i++) {
      const c = Math.floor(companies * rnd() ** 2.5);
      const u = rnd();
      const strength = u < 0.03 ? 0.6 + rnd() * 0.3 : u < 0.15 ? 0.3 + rnd() * 0.25 : rnd() * 0.25;
      store.put({
        id: `e2e-${i}`,
        userId,
        displayName: `Test Person ${i}`,
        firstName: 'Test',
        lastName: `Person${i}`,
        nameNormalized: `test person ${i}`,
        emails: [],
        currentOrganizationRaw: c === 0 ? 'Google' : `Synthetic Company ${c}`,
        relationshipType: 'unknown',
        strength,
        interactionCount: 0,
        sources: ['manual'],
        isHuman: true,
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    await new Promise((res) => {
      tx.oncomplete = res;
    });
    idb.close();
  }, n);
}

async function checkMap(page: Page, info: TestInfo, name: string) {
  const vp = page.viewportSize()!;
  const canvas = page.getByTestId('orbit-canvas');
  await expect(canvas).toBeVisible();
  // wait for the people to load and a frame with company labels to be drawn
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-labels')), { timeout: 10_000 })
    .toBeGreaterThan(0);
  await expect(canvas).toHaveAttribute('data-labels-clipped', '0');
  await expect(canvas).toHaveAttribute('data-overlaps', '0');
  // every dot sits inside its company's wedge, so a label names the people under it
  await expect(canvas).toHaveAttribute('data-outside-wedges', '0');
  const box = (await canvas.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vp.width);
  // the side panel (legend and the path finder) is reachable at every width
  const finder = page.getByRole('button', { name: /find a path to someone/i });
  await finder.scrollIntoViewIfNeeded();
  await expect(finder).toBeInViewport();
  const fb = (await finder.boundingBox())!;
  expect(fb.x + fb.width).toBeLessThanOrEqual(vp.width + 1);
  // the whole panel (legend, instructions, path finder) is on screen horizontally, never cut off (UI-07)
  const panel = (await page.getByTestId('map-panel').boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(vp.width + 1);
  expect(panel.height).toBeGreaterThan(150);
  await info.attach(`map-${name}-${vp.width}x${vp.height}`, {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
}

test.describe('Map readability', () => {
  test('orbit fits, has no overlapping dots and no clipped labels at phone and laptop widths', async ({
    page,
  }, info) => {
    test.setTimeout(180_000);
    await loadDemo(page);
    for (const [w, h] of [
      [390, 844],
      [820, 1180],
      [1024, 768],
      [1280, 720],
      [1440, 800],
    ] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto('map');
      await checkMap(page, info, 'demo');
    }
    // the stated scale: 300 and 2,000 people
    for (const extra of [210, 1700]) {
      await injectPeople(page, extra);
      for (const [w, h] of [
        [390, 844],
        [1280, 720],
      ] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.goto('map');
        await checkMap(page, info, `${extra}`);
        if (extra > 1000)
          expect(
            Number(await page.getByTestId('orbit-canvas').getAttribute('data-aggregated')),
          ).toBeGreaterThan(0);
      }
    }
  });

  test('reach never shows "No route found" before the routes load, and company search is normalised', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('pipeline?view=table');
    const name = await page
      .locator('table tbody tr')
      .nth(2)
      .locator('td')
      .first()
      .locator('span.font-medium')
      .innerText();
    await page.goto('map?reach=1');
    await page.evaluate(() => {
      const w = window as unknown as { __sawNoRoute: boolean };
      w.__sawNoRoute = false;
      new MutationObserver(() => {
        if (document.body.innerText.includes('No route found')) w.__sawNoRoute = true;
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.getByTestId('reach-input').fill(name.trim());
    await page.getByTestId('reach-input').press('Enter');
    await expect(page.getByTestId('reach-path').first()).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => (window as unknown as { __sawNoRoute: boolean }).__sawNoRoute)).toBe(
      false,
    );
    await page.getByTestId('reach-input').fill('stripe inc');
    await page.getByTestId('reach-input').press('Enter');
    await expect(page.getByText(/people there now/i)).toBeVisible();
  });
});

test.describe('Map on a touch phone (UI-18)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a tap names the person without leaving the map, and the reach routes are on screen', async ({
    page,
  }, info) => {
    await loadDemo(page);
    await page.goto('map');
    const canvas = page.getByTestId('orbit-canvas');
    await expect
      .poll(async () => await canvas.getAttribute('data-first-dot'), { timeout: 10_000 })
      .toBeTruthy();
    // the orbit holds still on touch screens, and the copy talks about taps, not hovering
    await expect(canvas).toHaveAttribute('data-moving', 'false');
    await expect(page.getByText(/tap a person to see who they are/i)).toBeVisible();
    await expect(page.getByText(/hover/i)).toHaveCount(0);
    const [x, y] = (await canvas.getAttribute('data-first-dot'))!.split(',').map(Number) as [number, number];
    const box = (await canvas.boundingBox())!;
    await page.touchscreen.tap(box.x + x, box.y + y);
    const card = page.getByTestId('map-tooltip');
    await expect(card).toBeVisible();
    await expect(page).toHaveURL(/\/map$/);
    await expect(card.getByTestId('map-open-person')).toBeVisible();
    const name = (await card.locator('.font-medium').first().innerText()).trim();
    expect(name.length).toBeGreaterThan(1);
    await info.attach('map-touch-tooltip-390x844', {
      body: await page.screenshot({ fullPage: false }),
      contentType: 'image/png',
    });
    // a second tap on the same dot opens the profile
    await page.touchscreen.tap(box.x + x, box.y + y);
    await expect(page).toHaveURL(/\/people\//);

    // reach on a phone: the first route shows without scrolling, the next step is reachable
    const targetId: string = await page.evaluate(async () => {
      const open = indexedDB.open('orbit');
      const idb: IDBDatabase = await new Promise((res, rej) => {
        open.onsuccess = () => res(open.result);
        open.onerror = () => rej(open.error);
      });
      const all: { id: string; strength: number; isHuman: boolean }[] = await new Promise((res) => {
        const r = idb.transaction('people').objectStore('people').getAll();
        r.onsuccess = () => res(r.result);
      });
      idb.close();
      return all.filter((p) => p.isHuman && p.strength < 0.3).sort((a, b) => a.id.localeCompare(b.id))[0]!.id;
    });
    await page.goto(`map?reach=${targetId}`);
    const route = page.getByTestId('reach-path').first();
    await expect(route).toBeVisible({ timeout: 15_000 });
    await expect(route).toBeInViewport();
    const next = page.getByRole('button', { name: /^(ask .+ for an intro|write to .+ directly)$/i });
    await next.scrollIntoViewIfNeeded();
    await expect(next).toBeInViewport();
    const nb = (await next.boundingBox())!;
    expect(nb.x + nb.width).toBeLessThanOrEqual(391);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await info.attach('map-touch-reach-390x844', {
      body: await page.screenshot({ fullPage: false }),
      contentType: 'image/png',
    });
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
  });
});
