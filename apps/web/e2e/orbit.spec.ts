import { expect, type Page, type TestInfo, test } from '@playwright/test';

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

/** Every state the landing header's buttons go through after a reload, as recorded by a MutationObserver. */
async function landingHeaderStates(page: Page): Promise<string[]> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __landingStates: string[] }).__landingStates = seen;
    const record = () => {
      const el = document.querySelector('[data-testid="landing-actions"]');
      if (!el) return;
      const text = Array.from(el.querySelectorAll('button'), (b) => b.textContent ?? '').join(',');
      // an empty header (the profile is still being read) is fine; only the buttons it shows matter
      if (text && seen[seen.length - 1] !== text) seen.push(text);
    };
    new MutationObserver(record).observe(document, { childList: true, subtree: true, characterData: true });
  });
  const states: string[] = [];
  for (let i = 0; i < 5; i++) {
    await page.goto('');
    await expect(page.getByTestId('landing-actions').getByRole('button').first()).toBeVisible();
    const seen = await page.evaluate(
      () => (window as unknown as { __landingStates: string[] }).__landingStates,
    );
    expect(seen.length).toBeGreaterThan(0);
    states.push(...seen);
  }
  return states;
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
    // the line under the greeting counts the cards on screen, including stage updates raised after the brief
    const summary = page.getByTestId('today-summary');
    await expect(summary).toContainText(/coming up this week/);
    const cards = await page.locator('[data-testid^="suggestion-"]').count();
    await expect(summary).toContainText(`${cards} things for today`);
  });

  test('approve a thank-you: approval binds the text, card leaves Today, Sent tab lists it', async ({
    page,
    context,
  }) => {
    await loadDemo(page);
    const card = page.getByTestId('suggestion-thank_you').first();
    const name = await card.getByRole('link').nth(1).innerText();
    await card.getByTestId('draft-review').click();
    const textarea = card.getByLabel('Message body');
    await expect(textarea).toBeVisible();
    // the demo's notes are in, so the stored thank-you already quotes what they said: no prompt, no placeholder
    await expect(card.getByTestId('draft-needs-input')).toBeHidden();
    await expect(textarea).not.toHaveValue(/\[/);
    await expect(textarea).toHaveValue(/what you said about|your advice|your point/i);
    await textarea.fill(`${await textarea.inputValue()}\n\nPS edited in e2e`);
    // without Gmail sending, the button says what it does: it opens the mail app
    await card.getByRole('button', { name: /^open in mail app$/i }).click();
    await expect(page.getByText(/opened in your mail app/i).first()).toBeVisible({ timeout: 15_000 });
    // a mail-app hand-off is not "sent" until the student says so
    await card.getByRole('button', { name: /i sent it/i }).click();
    await expect(page.getByText(/logged as sent to/i)).toBeVisible();
    await page.goto('inbox?tab=sent');
    await page.getByRole('tab', { name: /sent/i }).click();
    await expect(page.getByText('PS edited in e2e')).toBeVisible();
    await expect(page.getByRole('link', { name })).toBeVisible();
    // minutes after the thank-you, "Write to" does not draft a check-in
    await page.getByRole('link', { name }).first().click();
    await expect(page).toHaveURL(/\/people\//);
    await page.getByTestId('person-write').click();
    await expect(page.getByText(/a check-in fits in a few weeks/i)).toBeVisible();
    await expect(page.getByLabel('Message body')).toBeHidden();
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

  test('cold outreach asks for a connection line, redrafts with it, then approval unlocks', async ({
    page,
  }) => {
    await loadDemo(page);
    // demo contacts with an email, no chat and nothing checkable in common with the student; the generated cast
    // depends on the year the demo is loaded in (nobody joins a firm before it was founded), so the list covers
    // 2026 to 2029, the most reliable first
    const candidates = [
      'p47',
      'p67',
      'p68',
      'p74',
      'p21',
      'p33',
      'p44',
      'p65',
      'p70',
      'p46',
      'p48',
      'p79',
      'p85',
      'p89',
      'p90',
      'p40',
      'p42',
      'p43',
      'p51',
      'p55',
      'p63',
      'p66',
      'p71',
      'p81',
      'p25',
      'p26',
      'p27',
      'p34',
      'p36',
      'p38',
      'p50',
      'p56',
      'p61',
      'p39',
      'p45',
      'p52',
      'p54',
      'p62',
      'p64',
      'p69',
      'p72',
      'p75',
      'p83',
      'p84',
      'p87',
    ];
    let found = false;
    for (const id of candidates) {
      await page.goto(`people/${id}`);
      await page.getByTestId('person-write').click();
      await expect(page.getByLabel('Message body')).toBeVisible({ timeout: 15_000 });
      // the connection prompt itself: someone with a chat asks for an update instead
      if (await page.getByTestId('draft-input-connection').isVisible()) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
    const approve = page.getByRole('button', { name: /open in mail app|send to|copy & open linkedin/i });
    await expect(approve).toBeDisabled();
    await expect(page.getByLabel('Message body')).toHaveValue(/\[Your link to/);
    await page
      .getByTestId('draft-input-connection')
      .fill('We were both on the Cornell Hyperloop team, a few years apart');
    await page.getByTestId('draft-redraft').click();
    await expect(page.getByTestId('draft-needs-input')).toBeHidden({ timeout: 15_000 });
    await expect(page.getByLabel('Message body')).toHaveValue(/We were both on the Cornell Hyperloop team/);
    await expect(page.getByLabel('Message body')).not.toHaveValue(/\[/);
    await expect(approve).toBeEnabled();
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
      .getByRole('link')
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
    await expect(page).toHaveURL(/\/onboarding\/1$/);
    await page.getByTestId('ob-name').fill('Sam Okafor');
    await page.getByTestId('ob-email').fill('sam@umich.edu');
    await page.getByTestId('ob-school').fill('University of Michigan');
    await page.getByTestId('ob-year').selectOption({ index: 2 });
    await page.getByRole('button', { name: /continue/i }).click();
    await expect(page).toHaveURL(/\/onboarding\/2$/);
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
    await expect(page).toHaveURL(/\/onboarding\/3$/);
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
    // Coming back to the landing page never offers to wipe this profile, not even while it is being read.
    for (const state of await landingHeaderStates(page)) expect(state).toBe('Open Orbit');
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
    await page.getByTestId('ob-year').selectOption({ index: 2 });
    await page.getByRole('button', { name: /continue/i }).click();
    await expect(page).toHaveURL(/\/onboarding\/2$/);
    // while the stored profile is read, the header never offers the first-visit buttons, not even for one frame
    for (const state of await landingHeaderStates(page))
      expect(state).not.toMatch(/try the demo|get started/i);
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
    await expect(page).toHaveURL(/\/onboarding\/2$/);
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
    // the name link covers the card; the next-step chip is a second, separate link
    const link = card.getByRole('link').first();
    const name = await link.innerText();
    await link.focus();
    await expect(link).toBeFocused();
    await card.getByTestId('chat-card-move').selectOption('identified');
    await expect(page.getByTestId('chat-card-identified').filter({ hasText: name })).toBeVisible();
    // the move says what happened and can be undone
    await expect(page.getByTestId('toasts')).toContainText(`Moved ${name.split(' ')[0]} to To contact`);
    await page
      .getByTestId('chat-card-identified')
      .filter({ hasText: name })
      .getByRole('link')
      .first()
      .press('Enter');
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
    await card.getByTestId('draft-review').click();
    await expect(card.getByLabel('Message body')).toBeVisible();
    await fits('today-draft-open');
    for (const path of ['pipeline', 'pipeline?view=table', 'people', 'discover', 'inbox', 'settings/goals']) {
      await page.goto(path);
      await fits(path.replace(/[?=/]/g, '-'));
    }
    await page.goto('people');
    // phones get a list instead of the table
    await page.locator('a[href*="/people/p"]:visible').first().click();
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

test.describe('First-run guidance and plain next steps', () => {
  test('Today explains itself once: the hint closes for good, and each draft card says how to review it', async ({
    page,
  }) => {
    await loadDemo(page);
    const hint = page.getByTestId('hint-today');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(/nothing is sent until you approve it/i);
    await page.getByTestId('hint-today-dismiss').click();
    await expect(hint).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('suggestion-thank_you').first()).toBeVisible();
    await expect(page.getByTestId('hint-today')).toHaveCount(0);
    // the line under the greeting is a count, not a list of every kind of card
    const cards = await page.locator('[data-testid^="suggestion-"]').count();
    await expect(page.getByTestId('today-summary')).toHaveText(new RegExp(`^${cards} things for today`));
    // every card with a draft has a visible button that opens it, and the approve button says what it does
    const card = page.getByTestId('suggestion-follow_up_bump').first();
    await card.getByTestId('draft-review').click();
    await expect(card.getByTestId('draft-to')).toContainText(/^To: /);
    await expect(card.getByRole('button', { name: /^open in mail app$/i })).toBeVisible();
    await expect(card.getByTestId('draft-mail-hint')).toContainText(/opens this in your mail app/i);
  });

  test('a duplicate is only merged after a second step, and a dismissed card can be brought back', async ({
    page,
  }) => {
    await loadDemo(page);
    const merge = page.getByTestId('suggestion-confirm_merge').first();
    await expect(merge.getByTestId('merge-choice')).toContainText(/both have/i);
    await merge.getByTestId('merge-ask').click();
    await expect(merge.getByRole('alertdialog')).toContainText(/cannot be undone/i);
    await merge.getByRole('button', { name: /^cancel$/i }).click();
    await expect(merge.getByTestId('merge-confirm')).toHaveCount(0);
    // dismiss shows a toast with Undo, and Undo puts the card back
    const card = page.getByTestId('suggestion-thank_you').first();
    const who = await card.getByRole('link').nth(1).innerText();
    await card.getByRole('button', { name: /^dismiss$/i }).click();
    await card.getByRole('button', { name: /not now/i }).click();
    await expect(page.getByTestId('suggestion-thank_you').filter({ hasText: who })).toHaveCount(0);
    await page
      .getByTestId('toasts')
      .getByRole('button', { name: /^undo$/i })
      .click();
    await expect(page.getByTestId('suggestion-thank_you').filter({ hasText: who })).toBeVisible();
  });

  test('the Approvals badge counts exactly the messages on the Approvals page', async ({ page }) => {
    await loadDemo(page);
    const badge = Number(await page.getByTestId('approvals-badge').first().innerText());
    await page.goto('inbox');
    await expect(page.getByRole('tab', { name: /to approve/i })).toContainText(String(badge));
    await expect(page.locator('[data-testid^="suggestion-"]')).toHaveCount(badge);
    await expect(page.getByTestId('suggestion-prep_brief')).toHaveCount(0);
  });

  test('Pipeline explains its stages and finds who went quiet; the next-step chip opens that card on Today', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('pipeline');
    await expect(page.getByTestId('hint-pipeline')).toBeVisible();
    await page.getByTestId('stage-legend').locator('summary').click();
    await expect(page.getByTestId('stage-legend')).toContainText(/waiting for a reply/i);
    await page.getByTestId('hint-pipeline-dismiss').click();
    await expect(page.getByTestId('hint-pipeline')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('chat-card-warming').first()).toBeVisible();
    await expect(page.getByTestId('hint-pipeline')).toHaveCount(0);
    await page.getByTestId('filter-quiet').check();
    const quiet = page.locator('[data-testid^="chat-card-"]:not([data-testid="chat-card-move"])');
    await expect(quiet.first()).toBeVisible();
    for (const t of await quiet.allInnerTexts()) expect(t).toMatch(/quiet/);
    await page.getByTestId('filter-quiet').uncheck();
    // the table sorts from its headers
    await page.getByRole('tab', { name: 'Table' }).click();
    await page.locator('thead').getByRole('button', { name: 'Person', exact: true }).click();
    await expect(page.locator('th[aria-sort="ascending"]')).toContainText(/person/i);
    await page.getByRole('tab', { name: 'Board' }).click();
    const next = page.getByTestId('chat-next').first();
    await next.click();
    await expect(page).toHaveURL(/\/today\?card=/);
    await expect(page.locator('[data-highlight="true"]')).toBeVisible();
  });
});

test.describe('Setup without Google', () => {
  test('setup keeps answers on Back, marks skipped steps as skipped, and an empty Today offers Add a person', async ({
    page,
  }) => {
    await prep(page);
    await page.goto('');
    await page
      .getByRole('button', { name: /^get started/i })
      .first()
      .click();
    await expect(page.getByTestId('ob-progress')).toHaveText(/step 1 of 7/i);
    // Continue says what is missing while it is disabled
    await expect(page.getByTestId('ob-missing')).toContainText(
      /your name, your email, your school and your graduation year/i,
    );
    // labels belong to their fields, and say which are required
    await page.getByLabel('Full name Required').fill('Sam Okafor');
    await page.getByLabel('Email Required').fill('sam@umich.edu');
    await page.getByTestId('ob-school').fill('University of Michigan');
    await page.getByTestId('ob-year').selectOption({ index: 2 });
    await page.getByRole('button', { name: /continue/i }).click();
    await page.getByTestId('ob-fn-consulting').click();
    await page.getByTestId('ob-roles').fill('Summer analyst');
    // a company typed but not added is kept, not thrown away
    await page.getByTestId('ob-company').fill('Evercore');
    await page.getByRole('button', { name: /^back$/i }).click();
    await expect(page).toHaveURL(/\/onboarding\/1$/);
    await page.getByRole('button', { name: /continue/i }).click();
    await expect(page.getByTestId('ob-fn-consulting')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('ob-roles')).toHaveValue('Summer analyst');
    await expect(page.getByRole('button', { name: /remove evercore/i })).toBeVisible();
    await page.getByRole('button', { name: /continue/i }).click();
    await page.getByRole('button', { name: /skip for now/i }).click(); // resume
    // without a Google sign-in set up for this copy, the step says so in plain words, no client ID to paste
    await expect(page.getByTestId('ob-google-unavailable')).toBeVisible();
    await expect(page.getByLabel('OAuth client ID')).toBeHidden();
    await page.getByRole('button', { name: /skip for now/i }).click(); // google
    await expect(page.getByTestId('ob-step-3')).toHaveAttribute('data-status', 'skipped');
    await expect(page.getByTestId('ob-step-4')).toHaveAttribute('data-status', 'skipped');
    await expect(page.getByTestId('ob-step-2')).toHaveAttribute('data-status', 'done');
    await page.getByRole('button', { name: /skip for now/i }).click(); // linkedin
    await page.getByRole('button', { name: /continue/i }).click(); // notes
    await page.getByRole('button', { name: /finish setup/i }).click();
    await expect(page).toHaveURL(/\/today$/, { timeout: 30_000 });
    const empty = page.getByTestId('today-empty-network');
    await expect(empty).toBeVisible();
    await expect(empty.getByRole('button', { name: /someone at evercore/i })).toBeVisible();
    await empty.getByRole('button', { name: /someone at evercore/i }).click();
    await expect(page.getByTestId('add-person-company')).toHaveValue('Evercore');
    await page.getByTestId('add-person-name').fill('Priya Shah');
    await expect(page.getByTestId('add-person-save')).toBeDisabled(); // needs a way to reach them
    await page.getByTestId('add-person-email').fill('priya.shah@evercore.com');
    await page.getByTestId('add-person-save').click();
    await expect(page).toHaveURL(/\/people\//);
    await expect(page.getByRole('heading', { name: 'Priya Shah' })).toBeVisible();
    // looking at a first draft does not put her on the Pipeline
    await page.getByTestId('person-write').click();
    await expect(page.getByLabel('Message body')).toBeVisible({ timeout: 15_000 });
    await page.goto('pipeline');
    await expect(page.getByText(/no chats yet/i)).toBeVisible();
    await expect(page.locator('[data-testid^="chat-card-"]')).toHaveCount(0);
  });
  test('an empty Today imports LinkedIn in place, says who to meet, and a note about someone met in person brings a thank-you', async ({
    page,
  }) => {
    await prep(page);
    await page.goto('');
    await page
      .getByRole('button', { name: /^get started/i })
      .first()
      .click();
    await page.getByTestId('ob-name').fill('Jamie Park');
    await page.getByTestId('ob-email').fill('jamie@umich.edu');
    await page.getByTestId('ob-school').fill('University of Michigan');
    await page.getByTestId('ob-year').selectOption({ index: 2 });
    await page.getByRole('button', { name: /continue/i }).click();
    await page.getByTestId('ob-fn-ib').click();
    await page.getByTestId('ob-company').fill('Goldman Sachs');
    await page.getByRole('button', { name: /continue/i }).click();
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: /skip for now/i }).click();
    await page.getByRole('button', { name: /continue/i }).click();
    await page.getByRole('button', { name: /finish setup/i }).click();
    await expect(page).toHaveURL(/\/today$/, { timeout: 30_000 });
    // the upload is a real control: the keyboard reaches it, and it opens the picker right here
    const upload = page.getByTestId('today-empty-network').getByTestId('linkedin-import');
    await upload.focus();
    await expect(upload).toBeFocused();
    await upload.setInputFiles({
      name: 'Connections.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        [
          'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
          'Priya,Raman,https://www.linkedin.com/in/priyaraman,,Goldman Sachs,Investment Banking Analyst,12 Mar 2025',
          'Sarah,Lin,https://www.linkedin.com/in/sarahlin,,Evercore,Summer Analyst,21 Aug 2025',
          'Marcus,Webb,https://www.linkedin.com/in/marcuswebb,,Bain & Company,Associate Consultant,02 Feb 2024',
        ].join('\n'),
      ),
    });
    const toast = page.getByTestId('toasts');
    await expect(toast).toContainText(/3 people added.*worth a coffee chat are on Discover/i, {
      timeout: 30_000,
    });
    await toast.getByRole('button', { name: /see who to meet/i }).click();
    await expect(page).toHaveURL(/\/discover$/);
    const priya = page.getByTestId('rec-card').filter({ hasText: 'Priya Raman' });
    await expect(priya).toContainText('Works in investment banking (Investment Banking Analyst)');
    // a consultant is not called a banker
    await expect(page.getByTestId('rec-card').filter({ hasText: 'Marcus Webb' })).toHaveCount(0);
    // Start warm-up keeps the student on the list
    await priya.getByRole('button', { name: /start warm-up/i }).click();
    await expect(toast).toContainText(/warm-up started for priya/i);
    await expect(page).toHaveURL(/\/discover$/);
    // a note about someone the student met in person (never messaged) leads to a thank-you, not a cold first message
    await page.goto('notes/new');
    await page
      .getByTestId('capture-text')
      .fill('Coffee chat with Sarah Lin at the career fair. She suggested I practice paper LBOs.');
    await page.getByTestId('capture-save').click();
    await expect(page).toHaveURL(/\/people\//, { timeout: 15_000 });
    await page.goto('today');
    await expect(page.getByTestId('suggestion-thank_you').filter({ hasText: 'Sarah Lin' })).toBeVisible();
    await expect(page.getByTestId('suggestion-new_outreach').filter({ hasText: 'Sarah Lin' })).toHaveCount(0);
  });

  test('facts that disagree are pointed out, and a deleted fact can be brought back', async ({ page }) => {
    await loadDemo(page);
    await page.goto('people');
    await page.locator('a[href*="/people/p"]:visible').first().click();
    await page.getByRole('tab', { name: /facts/i }).click();
    for (const t of ['She grew up in Pittsburgh', 'She grew up in Chicago']) {
      await page.getByLabel('Kind of fact').selectOption('personal');
      await page.getByLabel('New fact').fill(t);
      await page.getByRole('button', { name: /^add$/i }).click();
    }
    await expect(page.getByTestId('fact-conflict')).toHaveCount(2);
    await page.getByRole('button', { name: 'Delete fact: She grew up in Chicago' }).click();
    await expect(page.getByTestId('fact-conflict')).toHaveCount(0);
    await page.getByTestId('toasts').getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('button', { name: 'Delete fact: She grew up in Chicago' })).toBeVisible();
    await expect(page.getByTestId('fact-conflict')).toHaveCount(2);
  });
});
