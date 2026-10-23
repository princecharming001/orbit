import { deflateRawSync } from 'node:zlib';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { briefWritten, injectPeople } from './helpers';

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
  await page
    .getByRole('button', { name: /^try the demo$/i })
    .first()
    .click();
  // the demo lands on the chat, its home
  await expect(page.getByTestId('greeting')).toContainText(/^Hey /, { timeout: 90_000 });
  await expect(page).toHaveURL(/\/(orbit\/?)?$/);
}

/** Drafts, where the day's cards live: the messages to send and the other cards that need the student. */
async function openDrafts(page: Page) {
  await page.goto('inbox');
  await expect(page.getByRole('heading', { name: 'Drafts', level: 1 })).toBeVisible();
}

/** A message just opened in the mail app or LinkedIn: it stays at the top of To send, with "I sent it". */
const handedOff = (page: Page) => page.getByTestId('drafts-handed-off');

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
    // signed in, "/" is the chat home; the landing page keeps its own route
    await page.goto('welcome');
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
  test("landing → demo → the chat; Drafts holds the day's cards and the brief counts them", async ({
    page,
  }) => {
    await loadDemo(page);
    await openDrafts(page);
    await expect(page.getByTestId('suggestion-schedule_confirm').first()).toBeVisible();
    await expect(page.getByTestId('suggestion-thank_you').first()).toBeVisible();
    await expect(page.getByTestId('suggestion-prep_brief').first()).toBeVisible();
    await expect(page.getByTestId('suggestion-warm_up_engage').first()).toBeVisible();
    // the season's later stages are exercised too: a referral ask or a nurture check-in
    await expect(
      page.getByTestId('suggestion-ask_referral').or(page.getByTestId('suggestion-nurture_checkin')).first(),
    ).toBeVisible();
    await expect(page.getByText('Coming up', { exact: true })).toBeVisible();
    // prep and warm-up steps are not messages: they sit under their own heading, after the drafts
    await expect(page.getByTestId('drafts-other').getByTestId('suggestion-prep_brief').first()).toBeVisible();
    await expect(page.getByTestId('drafts-to-send').getByTestId('suggestion-prep_brief')).toHaveCount(0);
    // the brief in the chat counts the same cards, including stage updates raised after it was built
    const cards = await page.locator('[data-testid^="suggestion-"]').count();
    await page.goto('');
    await page.getByTestId('chip-who-today').click();
    const brief = page.getByTestId('result-brief');
    await expect(brief).toContainText(`${cards} things for today`, { timeout: 30_000 });
    await expect(brief).toContainText(/coming up this week/);
    await expect(brief.getByTestId('brief-coming-up')).toBeVisible();
    await expect(brief.getByTestId('brief-more')).toHaveText(/^\d+ more in Drafts$/);
  });

  test('approve a thank-you: approval binds the text, card leaves To send, Sent tab lists it', async ({
    page,
  }) => {
    await loadDemo(page);
    await openDrafts(page);
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
    // the note says the resume is attached: Orbit cannot attach files, so the student confirms they will
    const open = card.getByRole('button', { name: /^open email to /i });
    if (await card.getByTestId('draft-attach-resume').isVisible()) {
      await expect(open).toBeDisabled();
      await card.getByTestId('draft-attach-confirm').check();
    }
    // without Gmail sending, the button says what it does and who to: it opens an email to them
    await open.click();
    await expect(page.getByText(/opened in your mail app/i).first()).toBeVisible({ timeout: 15_000 });
    // a mail-app hand-off is not "sent" until the student says so: it stays with the other drafts, with I sent it
    await expect(handedOff(page)).toBeVisible();
    await handedOff(page)
      .getByRole('button', { name: /i sent it/i })
      .first()
      .click();
    await expect(page.getByText(/logged as sent to/i)).toBeVisible();
    await page.goto('inbox?tab=sent');
    await page.getByRole('tab', { name: /^sent/i }).click();
    await expect(page.getByText('PS edited in e2e')).toBeVisible();
    await expect(page.getByRole('link', { name })).toBeVisible();
    // minutes after the thank-you, "Write to" does not draft a check-in
    await page.getByRole('link', { name }).first().click();
    await expect(page).toHaveURL(/\/people\//);
    await page.getByTestId('person-write').click();
    await expect(page.getByText(/a check-in fits in a few weeks/i)).toBeVisible();
    await expect(page.getByLabel('Message body')).toBeHidden();
  });

  test('an introduction the cues missed is asked about; yes opens a card with the referrer', async ({
    page,
  }) => {
    await loadDemo(page);
    await openDrafts(page);
    const card = page.getByTestId('suggestion-confirm_intro');
    await expect(card).toHaveCount(1);
    const question = await card.getByText(/^Did \S+ introduce you to \S+\?$/).innerText();
    const [, introducer, person] = /^Did (\S+) introduce you to (\S+)\?$/.exec(question)!;
    const fullName = await card.getByRole('link').nth(1).innerText();
    // a low-key question: two answers, no snooze or dismiss row
    await expect(card.getByRole('button', { name: /snooze/i })).toHaveCount(0);
    await card.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(
      page.getByText(`Added to your pipeline, noting that ${introducer} introduced you.`),
    ).toBeVisible();
    await expect(card).toHaveCount(0);
    // exactly what a detected introduction gives: the reply-while-fresh card, credited to the introducer (it is
    // drafted after the answer is saved, which can take longer than the default wait on a loaded machine)
    await expect(
      page.getByText(
        new RegExp(`${introducer} introduced you to ${person} .*reply while the intro is fresh`),
      ),
    ).toBeVisible({ timeout: 15_000 });
    await page.goto('people');
    await expect(page.getByTestId('chat-card-identified').filter({ hasText: fullName })).toBeVisible();
  });

  test('an introduction question answered no stays answered after a reload', async ({ page }) => {
    await loadDemo(page);
    await openDrafts(page);
    const card = page.getByTestId('suggestion-confirm_intro');
    await expect(card).toHaveCount(1);
    await card.getByRole('button', { name: 'No', exact: true }).click();
    await expect(page.getByText('Got it. Orbit will not ask about this thread again.')).toBeVisible();
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Drafts', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: /refresh/i }).click();
    await expect(page.getByRole('button', { name: /refresh/i })).toBeEnabled();
    await expect(page.getByTestId('suggestion-confirm_intro')).toHaveCount(0);
  });

  test('warm-up card: mark done, see progress', async ({ page }) => {
    await loadDemo(page);
    await openDrafts(page);
    const card = page.getByTestId('suggestion-warm_up_engage').first();
    await expect(card.getByRole('link', { name: /open on linkedin/i })).toHaveAttribute(
      'href',
      /linkedin\.com/,
    );
    await card.getByRole('button', { name: /^done$/i }).click();
    await expect(page.getByText(/logged the warm-up/i)).toBeVisible();
  });

  test('the People board renders stages; the list lets you change a stage', async ({ page }) => {
    await loadDemo(page);
    await page.goto('people');
    await expect(page.getByTestId('chat-card-scheduling').first()).toBeVisible();
    await expect(page.getByTestId('chat-card-warming').first()).toBeVisible();
    await page.getByRole('tab', { name: 'List' }).click();
    const row = page
      .getByTestId('people-row')
      .filter({ has: page.getByTestId('list-stage') })
      .first();
    const name = await row.getByTestId('person-name').innerText();
    await row.getByTestId('list-stage').selectOption('nurturing');
    await page.getByRole('tab', { name: 'Board' }).click();
    await expect(page.getByTestId('chat-card-nurturing').filter({ hasText: name })).toBeVisible();
    await page.getByRole('tab', { name: 'Companies' }).click();
    await expect(page.getByTestId('company-target').first()).toBeVisible();
  });

  test('person profile shows summary, facts and prep', async ({ page }) => {
    await loadDemo(page);
    await openDrafts(page);
    await page.getByTestId('suggestion-thank_you').first().getByRole('link').nth(1).click();
    await expect(page).toHaveURL(/\/people\//);
    await expect(page.getByText(/summary/i).first()).toBeVisible();
    await page.getByRole('tab', { name: /^about/i }).click();
    await expect(page.getByText(/from notes/i).first()).toBeVisible();
    await page.getByRole('tab', { name: /prep/i }).click();
    await expect(page.getByText(/questions to ask/i)).toBeVisible();
    await expect(page.getByText(/your goal for this chat/i)).toBeVisible();
    await expect(page.getByText(/anyone else you'd suggest I talk to/i)).toBeVisible();
    await expect(page.getByTestId('person-summary')).not.toHaveText(/\d{4}-\d{2}-\d{2}|building/i);
    await page.getByTestId('person-write').click();
    await expect(page.getByLabel('Message body')).toBeVisible();
  });

  test('prep tab: clear names are saved, unsure ones wait for a yes, roles stay unsaved', async ({
    page,
  }) => {
    await loadDemo(page);
    await openDrafts(page);
    await page.getByTestId('suggestion-thank_you').first().getByRole('link').nth(1).click();
    await expect(page).toHaveURL(/\/people\//);
    await page.getByRole('tab', { name: /prep/i }).click();
    const field = page.getByTestId('prep-suggested');
    await field.fill('Priya Shah at Stripe, will park, career services');
    await field.press('Enter');
    await expect(page.getByText(/saved to discover as suggested by .*: Priya Shah$/i)).toBeVisible();
    const unsure = page.getByTestId('prep-suggested-confirm');
    await expect(unsure.getByTestId('prep-confirm-row')).toHaveText([/Will Park/]);
    await expect(field).toHaveValue('career services');
    await expect(page.getByTestId('prep-suggested-skipped')).toContainText('career services');
    await unsure.getByTestId('prep-confirm-save').click();
    await expect(unsure).toBeHidden();
    await expect(
      page.getByText(/saved to discover as suggested by .*: Priya Shah, Will Park$/i),
    ).toBeVisible();
    await field.fill('mark chen');
    await field.press('Enter');
    await expect(unsure.getByTestId('prep-confirm-row')).toHaveText([/Mark Chen/]);
    await unsure.getByTestId('prep-confirm-skip').click();
    await expect(unsure).toBeHidden();
    await expect(
      page.getByText(/saved to discover as suggested by .*: Priya Shah, Will Park$/i),
    ).toBeVisible();
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
      // a stranger: Orbit writes the line itself from where they work, so nothing is left for the student to fill in
      if (/I (came across your profile|saw you)/.test(await page.getByLabel('Message body').inputValue())) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
    const approve = page.getByRole('button', { name: /open email to|send to|copy & open linkedin/i });
    await expect(page.getByLabel('Message body')).not.toHaveValue(/\[/);
    await expect(page.getByTestId('draft-needs-input')).toHaveCount(0);
    await expect(approve).toBeEnabled();
  });

  test('map renders the orbit and reach finds a route', async ({ page }) => {
    await loadDemo(page);
    await page.goto('map');
    await expect(page.getByTestId('orbit-canvas')).toBeVisible();
    await page.goto('people?view=list&f=chats');
    const name = await page.getByTestId('people-row').nth(2).getByTestId('person-name').innerText();
    await page.goto('map?reach=1');
    await page.getByTestId('reach-input').fill(name.trim());
    await page.getByTestId('reach-input').press('Enter');
    await expect(
      page
        .getByRole('button', { name: /write to|ask .* for an intro/i })
        .or(page.getByText(/no route found/i))
        .first(),
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
    await page.getByRole('tab', { name: /^about/i }).click();
    // the fact is stored as written ("offered to refer me") and shown to the student as "you"
    await expect(page.getByText(/offered to refer you/i).first()).toBeVisible();
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
    await page.getByRole('button', { name: /download all my data/i }).click();
    expect((await dl).suggestedFilename()).toMatch(/orbit-export/);
    page.on('dialog', (d) => d.accept());
    await page.getByRole('button', { name: /delete all data/i }).click();
    await expect(page).toHaveURL(/\/(orbit\/?)?$/);
  });
});

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
    await page.goto('people?view=list&f=chats');
    const name = await page.getByTestId('people-row').nth(2).getByTestId('person-name').innerText();
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
    // the first visit plays the arrival: tap where the dot has landed
    await expect(canvas).toHaveAttribute('data-animating', 'false', { timeout: 10_000 });
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
    // the route's own next step, not a warm-intro suggestion listed above the routes
    const next = page
      .getByRole('button', { name: /^(ask .+ for an intro|write to .+ directly)$/i })
      .and(page.locator(':not([data-testid="map-warm-intro-ask"])'))
      .first();
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

/** From the landing page through setup's Welcome step to the You step. */
async function startSetup(page: Page) {
  await page.goto('');
  await page
    .getByRole('button', { name: /^get started/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/onboarding\/0$/);
  await page
    .getByTestId('ob-welcome')
    .getByRole('button', { name: /get started/i })
    .click();
  await expect(page).toHaveURL(/\/onboarding\/1$/);
}

/** The You step, filled in with what every setup test needs. */
async function fillYou(page: Page, name: string, email: string) {
  await page.getByTestId('ob-name').fill(name);
  await page.getByTestId('ob-email').fill(email);
  await page.getByTestId('ob-school').fill('University of Michigan');
  await page.getByTestId('ob-year').selectOption({ index: 2 });
  await page.getByRole('button', { name: /^continue$/i }).click();
}

/** Writes the stored setup step straight into the browser's database, as an older build of Orbit left it. */
async function storeOnboardingStep(page: Page, step: number) {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('orbit');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('users', 'readwrite');
          const users = tx.objectStore('users');
          const all = users.getAll();
          all.onsuccess = () => {
            for (const u of all.result) users.put({ ...u, onboardingStep: n });
          };
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    step,
  );
}

test.describe('Manual onboarding', () => {
  test('a new user can set up without any integration and reach the chat home', async ({ page }) => {
    await prep(page);
    await startSetup(page);
    await fillYou(page, 'Sam Okafor', 'sam@umich.edu');
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
    // a company can be starred as a top priority right in the field
    await page.getByRole('button', { name: /mark figma as top priority/i }).click();
    await expect(page.getByRole('button', { name: /make figma a normal target/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: /^continue$/i }).click();
    // LinkedIn (no Gmail step: Google sign-in is not set up on this build): upload a tiny CSV
    await expect(page).toHaveURL(/\/onboarding\/3$/);
    // live LinkedIn is not switched on in this build, so there is no button that could only fail
    await expect(page.getByTestId('ob-linkedin-live')).toHaveCount(0);
    const csv =
      'First Name,Last Name,URL,Email Address,Company,Position,Connected On\nPriya,Patel,https://www.linkedin.com/in/priya-patel,priya@figma.com,Figma,Product Manager,12 Mar 2025\nDaniel,Kim,https://www.linkedin.com/in/daniel-kim,,Stripe,Software Engineer,03 Jan 2024\n';
    await page
      .getByTestId('ob-linkedin')
      .setInputFiles({ name: 'Connections.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(page.getByText(/2 people added/i)).toBeVisible();
    await page.getByRole('button', { name: /^continue$/i }).click();
    // the last step sums up what is set up
    await expect(page).toHaveURL(/\/onboarding\/5$/);
    await expect(page.getByTestId('ob-ready-linkedin')).toHaveAttribute('data-status', 'done');
    await expect(page.getByTestId('ob-ready-linkedin')).toContainText(/2 connections imported/);
    await expect(page.getByTestId('ob-ready-goals')).toContainText(/Product management · 1 target company/);
    await expect(page.getByTestId('ob-ready-gmail')).toHaveCount(0);
    await page.getByRole('button', { name: /open orbit/i }).click();
    // setup ends on the chat home
    await expect(page.getByTestId('greeting')).toContainText(/Hey Sam/, { timeout: 30_000 });
    await expect(page).toHaveURL(/\/orbit\/?$/);
    // with no chats yet, People opens on the list, so the people just imported are right there
    await page.goto('people');
    await expect(page.getByTestId('people-view-list')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('link', { name: /priya patel/i })).toBeVisible();
    await page.goto('discover');
    await expect(page.getByTestId('rec-card').first()).toBeVisible();
    // Coming back to the landing page never offers to wipe this profile, not even while it is being read.
    for (const state of await landingHeaderStates(page)) expect(state).toBe('Open Orbit');
    // signed in, the home route is the chat, not the landing page
    await page.goto('');
    await expect(page.getByTestId('greeting')).toContainText(/Hey Sam/);
    await expect(page.getByRole('button', { name: /try it with demo data|try the demo/i })).toHaveCount(0);
    await page.goto('welcome');
    await expect(page.getByRole('button', { name: /open orbit/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /try it with demo data|try the demo/i })).toHaveCount(0);
    await page
      .getByRole('button', { name: /open orbit/i })
      .last()
      .click();
    await expect(page).not.toHaveURL(/welcome|onboarding/);
    // an address past the end of setup, once it is done, opens the chat
    await page.goto('onboarding/99');
    await expect(page).toHaveURL(/\/orbit\/?$/);
    await expect(page.getByTestId('greeting')).toBeVisible();
  });

  test('landing during setup continues it and asks before loading the demo over it', async ({ page }) => {
    await prep(page);
    await startSetup(page);
    await fillYou(page, 'Real Person', 'real@umich.edu');
    await expect(page).toHaveURL(/\/onboarding\/2$/);
    // while the stored profile is read, the header never offers the first-visit buttons, not even for one frame
    for (const state of await landingHeaderStates(page))
      expect(state).not.toMatch(/try the demo|get started/i);
    await page.goto('welcome');
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      d.dismiss();
    });
    await page
      .getByRole('button', { name: /^try the demo$/i })
      .first()
      .click();
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toMatch(/discards the setup you started for Real Person/);
    await page
      .getByRole('button', { name: /continue setup/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/onboarding\/2$/);
  });

  test('someone part way through the older, longer setup lands on a step of this one', async ({ page }) => {
    await prep(page);
    await startSetup(page);
    // a typed address cannot skip ahead of the furthest step reached
    await page.goto('onboarding/4');
    await expect(page).toHaveURL(/\/onboarding\/1$/);
    await expect(page.getByTestId('ob-name')).toBeVisible();
    await fillYou(page, 'Old Setup', 'old@umich.edu');
    await expect(page).toHaveURL(/\/onboarding\/2$/);
    // the older setup's step 4 was the resume, gone now: LinkedIn comes next
    await storeOnboardingStep(page, 4);
    await page.goto('welcome');
    await page
      .getByRole('button', { name: /continue setup/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/onboarding\/3$/);
    await expect(page.getByRole('heading', { name: /linkedin/i })).toBeVisible();
    // its step 7 (meeting notes) and 8 (preferences) are past the last step here: Ready
    await storeOnboardingStep(page, 7);
    await page.goto('welcome');
    await page
      .getByRole('button', { name: /continue setup/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/onboarding\/5$/);
    await expect(page.getByTestId('ob-ready')).toBeVisible();
    // and a bookmarked address of the older setup moves forward to a step that exists
    await page.goto('onboarding/7');
    await expect(page).toHaveURL(/\/onboarding\/5$/);
    await page.goto('onboarding/4');
    await expect(page).toHaveURL(/\/onboarding\/5$/);
    // the steps before it are still there to go back to
    await page.goto('onboarding/2');
    await expect(page.getByTestId('ob-fn-pm')).toBeVisible();
  });
});

test.describe('Keyboard, dead ends and plain words', () => {
  test('palette closes on Escape; board cards are focusable and movable without dragging', async ({
    page,
  }) => {
    await loadDemo(page);
    await openDrafts(page);
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // the palette goes to People and Drafts; Today is gone
    await expect(dialog.getByRole('button', { name: /Go to People$/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Go to Drafts$/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Go to Today/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Snooze for 3 days' }).first()).toBeVisible();
    await page.goto('people');
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
      'people',
      'people?view=list',
      'people?view=companies',
      'discover',
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
    // a cold contact: known only from LinkedIn, so the card offers to write now instead of a plain first message
    const cold = page.getByTestId('rec-card').filter({ has: page.getByTestId('rec-write-now') });
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
    await fits('chat');
    if (vp.width < 768) {
      await expect(page.getByTestId('mobile-settings')).toBeVisible();
      await expect(page.getByTestId('mobile-add-note')).toBeVisible();
    }
    await openDrafts(page);
    const card = page.getByTestId('suggestion-thank_you').first();
    const box = await card.getByRole('button', { name: /dismiss/i }).boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(vp.width);
    await card.getByTestId('draft-review').click();
    await expect(card.getByLabel('Message body')).toBeVisible();
    await fits('drafts-draft-open');
    for (const [path, label] of [
      ['people?view=board', 'people-board'],
      ['people?view=list', 'people-list'],
      ['people?view=companies', 'people-companies'],
      ['discover', 'discover'],
      ['inbox', 'inbox'],
      ['settings/goals', 'settings-goals'],
    ]) {
      await page.goto(path!);
      await fits(label!);
    }
    await page.goto('people?view=list');
    // phones get a list instead of the table
    await page.locator('a[href*="/people/p"]:visible').first().click();
    await expect(page).toHaveURL(/\/people\//);
    await fits('person');
    const write = await page.getByTestId('person-write').boundingBox();
    expect(write && write.x + write.width).toBeLessThanOrEqual(vp.width);
    // The name keeps its own room: never one word per line, and never under the action buttons. Measured in lines and
    // overlap rather than pixels, because a name's width depends on the fonts the machine has.
    const name = await page.evaluate(() => {
      const h = document.querySelector('h1')!;
      const r = h.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(h);
      const tops = new Set([...range.getClientRects()].map((x) => Math.round(x.top)));
      const w = document.querySelector('[data-testid="person-write"]')!.getBoundingClientRect();
      const overlaps = r.left < w.right && r.right > w.left && r.top < w.bottom && r.bottom > w.top;
      return { words: (h.textContent ?? '').trim().split(/\s+/).length, lines: tops.size, overlaps };
    });
    expect(name.overlaps, 'name under the action buttons').toBe(false);
    expect(name.lines, 'name wrapped one word per line').toBeLessThan(Math.max(2, name.words));
    await page.getByTestId('person-write').click();
    await expect(page.getByLabel('Message body')).toBeVisible({ timeout: 15_000 });
    await fits('person-compose');
  });
}

test.describe('First-run guidance and plain next steps', () => {
  test('Drafts explains itself once: the hint closes for good, and each draft card says how to review it', async ({
    page,
  }) => {
    await loadDemo(page);
    await openDrafts(page);
    const hint = page.getByTestId('hint-drafts');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(/nothing goes out until you send it yourself/i);
    await page.getByTestId('hint-drafts-dismiss').click();
    await expect(hint).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('suggestion-thank_you').first()).toBeVisible();
    await expect(page.getByTestId('hint-drafts')).toHaveCount(0);
    // the brief in the chat is a count, not a list of every kind of card
    const cards = await page.locator('[data-testid^="suggestion-"]').count();
    await page.goto('');
    await page.getByTestId('chip-who-today').click();
    await expect(page.getByTestId('result-brief').locator('p').first()).toHaveText(
      new RegExp(`^${cards} things for today`),
      { timeout: 30_000 },
    );
    await openDrafts(page);
    // every card with a draft has a visible button that opens it, and the approve button says what it does
    const card = page.getByTestId('suggestion-follow_up_bump').first();
    await card.getByTestId('draft-review').click();
    await expect(card.getByRole('button', { name: /^open email to daniel$/i })).toBeVisible();
    // the card is Daniel's: no To line, no word count, no "drafted by" under the box
    await expect(card.getByTestId('draft-to')).toHaveCount(0);
    await expect(card.getByText(/drafted (by orbit|with claude)/i)).toHaveCount(0);
  });

  test('a duplicate is only merged after a second step, and a dismissed card can be brought back', async ({
    page,
  }) => {
    await loadDemo(page);
    await openDrafts(page);
    // the demo's only guess (Sana and Alina Ahmed: different first names, different employers) argues against
    // itself, so it is never asked; a pair with the same first name is
    await expect(page.getByTestId('suggestion-confirm_merge')).toHaveCount(0);
    await page.evaluate(async () => {
      const open = indexedDB.open('orbit');
      const idb: IDBDatabase = await new Promise((res, rej) => {
        open.onsuccess = () => res(open.result);
        open.onerror = () => rej(open.error);
      });
      const all = <T>(store: string): Promise<T[]> =>
        new Promise((res) => {
          const r = idb.transaction(store).objectStore(store).getAll();
          r.onsuccess = () => res(r.result as T[]);
        });
      const people = await all<{ id: string; userId: string; firstName: string }>('people');
      const priyas = people.filter((p) => p.firstName === 'Priya').slice(0, 2);
      const tx = idb.transaction('merges', 'readwrite');
      tx.objectStore('merges').put({
        id: 'mrg-e2e',
        userId: priyas[0]!.userId,
        personAId: priyas[0]!.id,
        personBId: priyas[1]!.id,
        score: 0.7,
        features: {},
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      await new Promise((res) => {
        tx.oncomplete = res;
      });
      idb.close();
    });
    await page.getByTestId('drafts-refresh').click();
    await expect(page.getByTestId('toasts')).toContainText(/updated/i);
    if (await page.getByTestId('drafts-more').isVisible()) await page.getByTestId('drafts-more').click();
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

  test('the Drafts badge counts the drafts to send today, and an opened draft stays with them, still counted', async ({
    page,
  }) => {
    await loadDemo(page);
    await openDrafts(page);
    const badgeNow = async () => Number(await page.getByTestId('approvals-badge').first().innerText());
    const toSend = page.getByTestId('drafts-to-send');
    // the drafts worth sending today, not everything that can wait (Drafts writes its cards' drafts a moment after
    // the page opens, so the two are compared once the page has caught up)
    const draftsNow = () =>
      toSend
        .locator('[data-testid^="suggestion-"]')
        .filter({ has: page.getByTestId('draft-review') })
        .count();
    await expect.poll(async () => (await badgeNow()) - (await draftsNow()), { timeout: 15_000 }).toBe(0);
    const badge = await badgeNow();
    expect(badge).toBeGreaterThan(0);
    await expect(page.getByRole('tab', { name: /^to send/i })).toContainText(String(badge));
    await expect(toSend.locator('[data-testid^="suggestion-"]')).toHaveCount(badge);
    // prep is not a message: it waits under its own heading, and the badge does not count it
    await expect(toSend.getByTestId('suggestion-prep_brief')).toHaveCount(0);
    await expect(page.getByTestId('drafts-other').getByTestId('suggestion-prep_brief').first()).toBeVisible();
    // opened in the mail app: it stays in To send, still counted, since it waits on the student's "I sent it"
    const card = page.getByTestId('suggestion-follow_up_bump').first();
    await card.getByTestId('draft-review').click();
    await card.getByRole('button', { name: /^open email to /i }).click();
    await expect(handedOff(page).getByRole('button', { name: /i sent it/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^to send/i })).toContainText(String(badge));
    await expect(page.getByTestId('approvals-badge').first()).toHaveText(String(badge));
    // leaving and coming back keeps the "I sent it" step, in the same list
    await page.goto('people');
    await page.goto('inbox');
    await expect(page.getByRole('tab', { name: /^to send/i })).toHaveAttribute('aria-selected', 'true');
    await expect(handedOff(page).getByRole('button', { name: /i sent it/i })).toBeVisible();
    await expect(page.getByTestId('handoff-copy')).toBeVisible();
  });

  test('Add note never picks the person behind your back, and files a notetaker summary with the person it names', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('notes/new');
    const select = page.getByTestId('capture-person');
    await expect.poll(() => select.locator('option').count(), { timeout: 15_000 }).toBeGreaterThan(3);
    await expect(select).toHaveValue('');
    // choosing someone and then "Let Orbit figure it out" again sticks
    await select.selectOption({ index: 3 });
    await select.selectOption({ label: 'Let Orbit figure it out' });
    await page.waitForTimeout(500);
    await expect(select).toHaveValue('');
    await page
      .getByTestId('capture-text')
      .fill(
        "Meeting summary - Hannah Brooks (Figma) / Alex Rivera\nAction items:\n- Alex to send portfolio link by Monday\nKey points:\n- Hannah recommended taking HCI course\n- Figma APM applications open in January\n- Hannah offered to review Alex's resume",
      );
    await expect(page.getByTestId('capture-match-preview')).toContainText(/file this with Hannah Brooks/);
    await page.getByTestId('capture-save').click();
    await expect(page).toHaveURL(/\/people\//, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Hannah Brooks' })).toBeVisible();
    await expect(page.getByTestId('toasts')).toContainText(/1 promise you made/);
    // the thank-you is right on the page she lands on
    await expect(page.getByTestId('person-waiting').getByTestId('suggestion-thank_you')).toBeVisible();
  });

  test('the demo says it is demo data and leads to your own setup', async ({ page }) => {
    await loadDemo(page);
    await expect(page.getByTestId('demo-banner')).toContainText(/made-up student/);
    await page.goto('welcome');
    await expect(page.getByRole('button', { name: /set up orbit for me/i }).first()).toBeVisible();
    await page.goto('inbox');
    await page.getByTestId('demo-start-own').click();
    await page.getByTestId('demo-start-confirm').click();
    // a new profile starts setup at its Welcome step, with nothing of the demo student's in it
    await expect(page).toHaveURL(/\/onboarding\/0$/, { timeout: 15_000 });
    await page
      .getByTestId('ob-welcome')
      .getByRole('button', { name: /get started/i })
      .click();
    await expect(page.getByTestId('ob-name')).toHaveValue('');
  });

  test('the People board explains its stages and finds who went quiet; the next-step chip opens that card in Drafts', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('people');
    await expect(page.getByTestId('people-view-board')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('hint-pipeline')).toBeVisible();
    await page.getByTestId('stage-legend').locator('summary').click();
    await expect(page.getByTestId('stage-legend')).toContainText(/waiting for a reply/i);
    await page.getByTestId('hint-pipeline-dismiss').click();
    await expect(page.getByTestId('hint-pipeline')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('chat-card-warming').first()).toBeVisible();
    await expect(page.getByTestId('hint-pipeline')).toHaveCount(0);
    const filter = page.getByLabel('Filter people');
    await expect(filter.getByTestId('filter-quiet')).toHaveText(/^Went quiet \(\d+\)$/);
    await filter.selectOption('quiet');
    await expect(page).toHaveURL(/f=quiet/);
    const quiet = page.locator('[data-testid^="chat-card-"]:not([data-testid="chat-card-move"])');
    await expect(quiet.first()).toBeVisible();
    for (const t of await quiet.allInnerTexts()) expect(t).toMatch(/quiet/);
    await filter.selectOption('all');
    // the list sorts by name
    await page.getByRole('tab', { name: 'List' }).click();
    await page.getByLabel('Sort people').selectOption('name');
    const names = await page.getByTestId('person-name').allInnerTexts();
    expect(names.length).toBeGreaterThan(3);
    expect(names.slice(0, 10)).toEqual([...names.slice(0, 10)].sort((a, b) => a.localeCompare(b)));
    await page.getByRole('tab', { name: 'Board' }).click();
    const next = page.getByTestId('chat-next').first();
    await next.click();
    await expect(page).toHaveURL(/\/inbox\?card=/);
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
    // without Google sign-in there are five steps: Welcome, You, Goals, LinkedIn, Ready
    await expect(page.getByTestId('ob-progress')).toHaveText(/step 1 of 5/i);
    await page
      .getByTestId('ob-welcome')
      .getByRole('button', { name: /get started/i })
      .click();
    await expect(page.getByTestId('ob-progress')).toHaveText(/step 2 of 5/i);
    await expect(page.getByTestId('ob-step-1')).toHaveAttribute('data-status', 'done');
    // Continue says what is missing while it is disabled
    await expect(page.getByRole('button', { name: /^continue$/i })).toBeDisabled();
    await expect(page.getByTestId('ob-missing')).toContainText(
      /your name, email, school and graduation year/i,
    );
    // labels belong to their fields, and the fields say they are required
    await expect(page.getByLabel('Full name')).toHaveAttribute('aria-required', 'true');
    await page.getByLabel('Full name').fill('Sam Okafor');
    await page.getByLabel('Email').fill('sam@umich.edu');
    // a school address is enough for Orbit to spot alumni: there is no domain field to fill
    await expect(page.getByTestId('ob-school-domain')).toContainText('umich.edu');
    await page.getByTestId('ob-school').fill('University of Michigan');
    await page.getByTestId('ob-year').selectOption({ index: 2 });
    await page.getByRole('button', { name: /^continue$/i }).click();
    await page.getByTestId('ob-fn-consulting').click();
    // the weekly goal is a slider from 1 to 350; the last stop is 350
    await page.getByTestId('ob-pace').fill('58');
    await expect(page.getByTestId('ob-pace-value')).toHaveText('350 a week');
    // a company typed but not added is kept, not thrown away
    await page.getByTestId('ob-company').fill('Evercore');
    await page.getByRole('button', { name: /^back$/i }).click();
    await expect(page).toHaveURL(/\/onboarding\/1$/);
    await expect(page.getByTestId('ob-name')).toHaveValue('Sam Okafor');
    await page.getByRole('button', { name: /^continue$/i }).click();
    await expect(page.getByTestId('ob-fn-consulting')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('ob-pace-value')).toHaveText('350 a week');
    await expect(page.getByRole('button', { name: /remove evercore/i })).toBeVisible();
    await page.getByRole('button', { name: /^continue$/i }).click();
    // without a Google sign-in set up on this build there is no Gmail step that could only say "not available"
    await expect(page.getByTestId('ob-google-unavailable')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /linkedin/i })).toBeVisible();
    await expect(page.getByTestId('ob-progress')).toHaveText(/step 4 of 5 · optional/i);
    await expect(page.getByTestId('ob-step-3')).toHaveAttribute('data-status', 'done');
    await expect(page.getByTestId('ob-step-4')).toHaveAttribute('data-status', 'current');
    await page.getByTestId('ob-skip').click(); // linkedin
    await expect(page.getByTestId('ob-step-4')).toHaveAttribute('data-status', 'skipped');
    await expect(page.getByTestId('ob-ready-linkedin')).toHaveAttribute('data-status', 'skipped');
    await expect(page.getByTestId('ob-ready-goals')).toContainText(/Consulting · 1 target company/);
    await page.getByRole('button', { name: /open orbit/i }).click();
    await expect(page.getByTestId('greeting')).toContainText(/Hey Sam/, { timeout: 30_000 });
    await page.goto('people');
    const empty = page.getByTestId('people-empty-network');
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
  test('an empty People page imports LinkedIn in place, says who to meet, and a note about someone met in person brings a thank-you', async ({
    page,
  }) => {
    await prep(page);
    await page.goto('');
    await page
      .getByRole('button', { name: /^get started/i })
      .first()
      .click();
    await page
      .getByTestId('ob-welcome')
      .getByRole('button', { name: /get started/i })
      .click();
    await fillYou(page, 'Jamie Park', 'jamie@umich.edu');
    await page.getByTestId('ob-fn-ib').click();
    await page.getByTestId('ob-company').fill('Goldman Sachs');
    await page.getByRole('button', { name: /^continue$/i }).click();
    // LinkedIn (no Gmail step on this build)
    await expect(page.getByRole('heading', { name: /linkedin/i })).toBeVisible();
    await page.getByTestId('ob-skip').click();
    await page.getByRole('button', { name: /open orbit/i }).click();
    await expect(page.getByTestId('greeting')).toContainText(/Hey Jamie/, { timeout: 30_000 });
    await page.goto('people');
    // the upload is a real control: the keyboard reaches it, and it opens the picker right here
    const upload = page.getByTestId('people-empty-network').getByTestId('linkedin-import');
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
    await page.goto('inbox');
    await expect(page.getByTestId('suggestion-thank_you').filter({ hasText: 'Sarah Lin' })).toBeVisible();
    await expect(page.getByTestId('suggestion-new_outreach').filter({ hasText: 'Sarah Lin' })).toHaveCount(0);
  });

  test('facts that disagree are pointed out, and a deleted fact can be brought back', async ({ page }) => {
    await loadDemo(page);
    await page.goto('people');
    await page.locator('a[href*="/people/p"]:visible').first().click();
    await page.getByRole('tab', { name: /^about/i }).click();
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

/** A fresh profile set up without Google, recruiting at Goldman Sachs, with nobody in it yet. */
async function newStudent(page: Page) {
  await prep(page);
  await startSetup(page);
  await fillYou(page, 'Sam Okafor', 'sam@umich.edu');
  await page.getByTestId('ob-fn-pm').click();
  await page.getByTestId('ob-company').fill('Goldman Sachs');
  await page.getByRole('button', { name: /^add$/i }).click();
  await page.getByRole('button', { name: /^continue$/i }).click();
  await page.getByTestId('ob-skip').click(); // linkedin
  await page.getByRole('button', { name: /open orbit/i }).click();
  await expect(page.getByTestId('greeting')).toContainText(/Hey Sam/, { timeout: 30_000 });
}

async function addByHand(
  page: Page,
  name: string,
  company: string,
  how: { email?: string; linkedin?: string },
) {
  // People's header always has Add a person
  await page.goto('people');
  await page
    .getByRole('button', { name: /add a person/i })
    .first()
    .click();
  await page.getByTestId('add-person-name').fill(name);
  await page.getByTestId('add-person-company').fill(company);
  if (how.email) await page.getByTestId('add-person-email').fill(how.email);
  if (how.linkedin) await page.getByTestId('add-person-linkedin').fill(how.linkedin);
  await page.getByTestId('add-person-save').click();
  await expect(page).toHaveURL(/\/people\//);
}

/** Waits until the follow-up draft's stored text ends with this: the editor opens on what is stored. */
async function bumpSaved(page: Page, ending: string) {
  await expect
    .poll(() =>
      page.evaluate(async (ending) => {
        type Out = { kind: string; status: string; bodyFinal?: string };
        const db = (window as unknown as { __orbitDb: { outbound: { toArray(): Promise<Out[]> } } })
          .__orbitDb;
        return (await db.outbound.toArray()).some(
          (o) => o.kind === 'bump' && o.status === 'draft' && !!o.bodyFinal?.endsWith(ending),
        );
      }, ending),
    )
    .toBe(true);
  // and the page has drawn it
  await page.waitForTimeout(300);
}

test.describe("Never losing the student's work, and honest hand-offs", () => {
  test('Close on an edited draft keeps the words, and Undo changes puts the text back', async ({ page }) => {
    await loadDemo(page);
    await openDrafts(page);
    const card = page.getByTestId('suggestion-follow_up_bump').first();
    await card.getByTestId('draft-review').click();
    const box = card.getByLabel('Message body');
    const original = await box.inputValue();
    await box.fill(`${original} PS: loved the retries post.`);
    await expect(card.getByRole('button', { name: 'Reset to suggested' })).toBeVisible();
    await card.getByTestId('draft-cancel').click();
    await expect(box).toBeHidden();
    await expect(page.getByTestId('toasts')).toContainText(/changes are kept/i);
    await bumpSaved(page, 'PS: loved the retries post.');
    await card.getByTestId('draft-review').click();
    await expect(box).toHaveValue(/PS: loved the retries post\.$/);
    // after a reload too
    await page.reload();
    await page.getByTestId('suggestion-follow_up_bump').first().getByTestId('draft-review').click();
    await expect(box).toHaveValue(/PS: loved the retries post\.$/);
    await box.fill(`${original} Another line.`);
    await card.getByTestId('draft-cancel').click();
    await page
      .getByTestId('toasts')
      .getByRole('button', { name: /undo changes/i })
      .click();
    // the editor opens on the stored text, so it is reopened once Undo has written it back
    await bumpSaved(page, 'PS: loved the retries post.');
    await card.getByTestId('draft-review').click();
    await expect(box).toHaveValue(/PS: loved the retries post\.$/);
    // closing without a change says nothing
    await card.getByTestId('draft-cancel').click();
    await expect(box).toBeHidden();
    await expect(page.getByTestId('toasts')).not.toContainText(/changes are kept/i);
  });

  test('Copy text hands off like the mail app: the message waits for "I sent it", then counts as sent', async ({
    page,
  }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await loadDemo(page);
    await openDrafts(page);
    const card = page.getByTestId('suggestion-thank_you').first();
    await card.getByTestId('draft-review').click();
    await expect(card.getByLabel('Message body')).toBeVisible();
    // the note says the resume is attached: Orbit cannot attach files, so the student confirms they will
    if (await card.getByTestId('draft-attach-resume').isVisible())
      await card.getByTestId('draft-attach-confirm').check();
    await card.getByTestId('draft-copy').click();
    // the copied message stays in To send, waiting for I sent it
    const waiting = handedOff(page).getByTestId('outbox-handed_off');
    await expect(waiting).toBeVisible();
    await expect(waiting).toContainText(/press I sent it/i);
    // only the message is copied: a "Subject:" line pasted into the body would go out as its first line
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).not.toMatch(/^Subject:/);
    expect(copied).toMatch(/^Hi /);
    await page.goto('inbox');
    await expect(page.getByTestId('outbox-item').filter({ hasText: /copied/i })).toBeVisible();
    await page
      .getByTestId('outbox-item')
      .getByRole('button', { name: /i sent it/i })
      .first()
      .click();
    // the Sent tab shows once something is in it
    await page.getByRole('tab', { name: /^sent/i }).click();
    await expect(page.getByText(/thank-you/i).first()).toBeVisible();
  });

  test('confirming a time and pressing "I sent it" books the chat under Coming up', async ({ page }) => {
    await loadDemo(page);
    await openDrafts(page);
    const card = page.getByTestId('suggestion-schedule_confirm').first();
    const name = (await card.locator('a.font-medium').first().innerText()).trim();
    await card.getByTestId('draft-review').click();
    await card.getByRole('button', { name: /open email to/i }).click();
    await handedOff(page)
      .getByTestId('outbox-item')
      .filter({ hasText: name })
      .getByRole('button', { name: /i sent it/i })
      .click();
    await expect(page.getByText(/is booked for/i)).toBeVisible();
    await expect(page.getByText('Coming up').locator('..').getByText(name)).toBeVisible();
  });

  test('a first message started on a person page survives leaving it, and is findable on Drafts', async ({
    page,
  }) => {
    await newStudent(page);
    await addByHand(page, 'Daniel Kim', 'Goldman Sachs', {
      linkedin: 'https://www.linkedin.com/in/daniel-kim-gs',
    });
    // adding someone leads to a next step in Drafts, not to an empty page
    await openDrafts(page);
    const next = page.getByTestId('drafts-to-write');
    await expect(next).toContainText('Daniel Kim');
    await expect(next.getByTestId('drafts-write')).toHaveText(/^Write to Daniel$/);
    // Discover is up to date without a Refresh
    await page.goto('discover');
    await expect(page.getByTestId('rec-card').filter({ hasText: 'Daniel Kim' })).toBeVisible();
    await openDrafts(page);
    await page.getByTestId('drafts-write').click();
    await expect(page.getByTestId('warmup-choice')).toBeVisible();
    await page.getByTestId('warmup-skip').click();
    const box = page.getByLabel('Message body');
    await expect(box).toBeVisible({ timeout: 15_000 });
    // Orbit writes the "why them" line itself: nothing for the student to fill in
    await expect(box).not.toHaveValue(/\[Why them/);
    await expect(page.getByTestId('draft-needs-input')).toHaveCount(0);
    // only one kind of message fits: no button that looks like a choice (it used to restart the draft)
    await expect(page.getByRole('group', { name: /kind of message/i })).toHaveCount(0);
    await box.fill(`${await box.inputValue()} Glad to.`);
    await page
      .getByRole('link', { name: /^drafts/i })
      .first()
      .click();
    const started = page.getByTestId('started-draft');
    await expect(started).toContainText('Daniel Kim');
    await expect(started).toContainText('Glad to');
    // the draft took the place of the "write to" step
    await expect(page.getByTestId('drafts-to-write')).toHaveCount(0);
    await expect(page.getByTestId('drafts-started')).toContainText('Daniel Kim');
    await page
      .getByTestId('drafts-started')
      .getByRole('button', { name: /continue writing/i })
      .click();
    await expect(box).toHaveValue(/Glad to/);
    // Write to opens the same draft, without asking about the warm-up again
    await page.reload();
    await page.getByTestId('person-write').click();
    await expect(page.getByTestId('warmup-choice')).toBeHidden();
    await expect(box).toHaveValue(/Glad to/);
  });

  test('Copy text stays off while the "Why them" line is missing (only when Orbit knows nothing about them)', async ({
    page,
  }) => {
    await newStudent(page);
    await addByHand(page, 'Priya Shah', '', { email: 'priya.shah@gs.com' });
    await page.getByTestId('person-write').click();
    await expect(page.getByLabel('Message body')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('draft-copy')).toBeDisabled();
    await page.getByTestId('draft-input-connection').fill('Your talk at the Michigan finance club last week');
    await page.getByTestId('draft-redraft').click();
    await expect(page.getByLabel('Message body')).toHaveValue(
      /I'm writing because of your talk at the Michigan finance club last week\./,
    );
    await expect(page.getByTestId('draft-copy')).toBeEnabled();
  });

  test('the landing page, Settings and the People board promise only what a build without Google does', async ({
    page,
  }) => {
    await prep(page);
    await page.goto('');
    // what the page says about Orbit; the logo wall's company names (Google among them) promise nothing
    const promises = await page.evaluate(() => {
      const copy = document.body.cloneNode(true) as HTMLElement;
      copy.querySelector('[data-testid="trusted-by"]')?.remove();
      return copy.innerText;
    });
    expect(promises).not.toMatch(/Google/);
    await expect(page.locator('body')).toContainText(/does not connect to your email or calendar/i);
    await loadDemo(page);
    await page.goto('settings/integrations');
    const google = page.getByTestId('google-unavailable');
    await expect(google).toContainText(/not part of this version/i);
    await page.goto('people');
    await expect(page.getByText(/cannot see your inbox/i)).toBeVisible();
  });

  test('the People list fits a laptop, and the board points at next steps off to the right', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('people?view=list&f=chats');
    const table = page.getByTestId('people-table');
    await expect(table).toBeVisible();
    const fits = await table.evaluate((t) => t.scrollWidth <= (t.parentElement as HTMLElement).clientWidth);
    expect(fits).toBe(true);
    await expect(table.getByText('Closeness', { exact: true })).toBeInViewport();
    await expect(table.getByText('Next', { exact: true })).toBeInViewport();
    await page.goto('people');
    const needs = page.getByTestId('board-needs');
    await expect(needs).toBeVisible();
    await needs.click();
    await expect(page.getByTestId('chat-card-completed').first()).toBeInViewport();
  });
});

test.describe('Phone: the same flows fit 390px', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('closing an edited draft and its Undo fit the screen', async ({ page }) => {
    await loadDemo(page);
    await openDrafts(page);
    const card = page.getByTestId('suggestion-follow_up_bump').first();
    await card.getByTestId('draft-review').click();
    const box = card.getByLabel('Message body');
    await box.fill(`${await box.inputValue()} PS.`);
    await card.getByTestId('draft-cancel').click();
    const toast = page.getByTestId('toasts').getByRole('status');
    await expect(toast).toBeVisible();
    const b = (await toast.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(390);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});

/** LinkedIn's export as it arrives: a ZIP with Connections.csv inside (deflated), built here byte by byte. */
function linkedInZip(csv: string): Buffer {
  const raw = Buffer.from(csv);
  const data = deflateRawSync(raw);
  const name = Buffer.from('Basic_LinkedInDataExport/Connections.csv');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

const chatCard = (page: Page, name: string) =>
  page.locator('[data-testid^="chat-card-"]').filter({ hasText: name });

test.describe('Usability round 5: one draft, kept edits, saved settings, chats that move on', () => {
  test('Write first message on Discover makes one draft, and sending it clears it everywhere', async ({
    page,
  }) => {
    await loadDemo(page);
    // Drafts writes its cards' drafts as it opens, so the badge is read once they are in
    await openDrafts(page);
    const toSend = page.getByTestId('drafts-to-send').locator('[data-testid^="suggestion-"]');
    // count the cards only once they are drawn
    await expect(toSend.first()).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => Number(await page.getByTestId('approvals-badge').first().innerText()), {
        timeout: 15_000,
      })
      .toBe(await toSend.count());
    const badge = Number(await page.getByTestId('approvals-badge').first().innerText());
    await page.goto('discover');
    await page
      .getByTestId('rec-card')
      .filter({ has: page.getByRole('button', { name: /^write first message$/i }) })
      .first()
      .getByTestId('rec-start')
      .click();
    await expect(page).toHaveURL(/\/people\//);
    await expect(page.getByLabel('Message body')).toBeVisible({ timeout: 15_000 });
    // one draft: the composer, not a second copy waiting under it, and no "First message" card beside it
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('approvals-badge').first()).toHaveText(String(badge + 1));
    await expect(page.getByTestId('person-started-draft')).toHaveCount(0);
    await expect(page.getByTestId('suggestion-new_outreach')).toHaveCount(0);
    await page.getByRole('button', { name: /^open email to /i }).click();
    await page.getByRole('button', { name: /^i sent it to /i }).click();
    await expect(page.getByText(/logged as sent to/i)).toBeVisible();
    await expect(page.getByTestId('approvals-badge').first()).toHaveText(String(badge));
    await expect(page.getByTestId('person-started-draft')).toHaveCount(0);
    await openDrafts(page);
    await expect(page.getByTestId('drafts-started')).toHaveCount(0);
  });

  test('the "Why them" line drops into an edited message, and a rewrite asks first and can be undone', async ({
    page,
  }) => {
    await newStudent(page);
    // nothing known about him but his name: the one case Orbit asks for the line
    await addByHand(page, 'Marcus Lee', '', {
      linkedin: 'https://www.linkedin.com/in/marcus-lee-gs',
    });
    await page.getByTestId('person-write').click();
    await page.getByTestId('warmup-skip').click();
    const box = page.getByLabel('Message body');
    await expect(box).toBeVisible({ timeout: 15_000 });
    const needs = page.getByTestId('draft-needs-input');
    await expect(needs).toContainText(/send buttons stay off until you add it/i);
    await expect(needs).not.toContainText(/will not send/i);
    const suggested = await box.inputValue();
    // the student rewrote the whole note: redrafting asks before it replaces their words
    await box.fill('Hi Marcus, my own words entirely. Alex');
    await page.getByTestId('draft-input-connection').fill('We both rowed crew at Michigan');
    await page.getByTestId('draft-redraft').click();
    await expect(page.getByTestId('draft-redraft-confirm')).toBeVisible();
    await page.getByRole('button', { name: /^keep my text$/i }).click();
    await expect(box).toHaveValue('Hi Marcus, my own words entirely. Alex');
    // with the bracketed gap still there, the line goes into it and the rest of their text stays
    await box.fill(`${suggested} MYEDIT`);
    await expect(page.getByTestId('draft-redraft')).toHaveText(/add to my message/i);
    await page.getByTestId('draft-redraft').click();
    await expect(box).toHaveValue(/We both rowed crew at Michigan\./);
    await expect(box).toHaveValue(/MYEDIT$/);
    await expect(box).not.toHaveValue(/\[Why them/);
    // the ask itself is the one the draft had
    const ask = suggested.split(']')[1]!.split('?')[0]!.trim();
    expect((await box.inputValue()).includes(ask)).toBe(true);
    await page
      .getByTestId('toasts')
      .getByRole('button', { name: /^undo$/i })
      .click();
    await expect(box).toHaveValue(/\[Why them.*MYEDIT$/);
  });

  test('Profile and Goals save as they are typed, and survive leaving the page and a reload', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('settings/profile');
    await page.locator('#profile-city').fill('Ann Arbor, MI');
    await expect(page.getByTestId('autosave')).toContainText(/save as you make them/i);
    await page
      .getByRole('link', { name: /^people$/i })
      .first()
      .click();
    await page.reload();
    await page.goto('settings/profile');
    await expect(page.locator('#profile-city')).toHaveValue('Ann Arbor, MI');
    await page.goto('settings/goals');
    await expect(page.getByText('What kind of work')).toBeVisible();
    await page.locator('#goals-locations').fill('Chicago');
    await expect(page.getByTestId('autosave')).toContainText(/save as you make them/i);
    await page.reload();
    await expect(page.locator('#goals-locations')).toHaveValue('Chicago');
    // without Google, nothing here talks about reading email
    await page.goto('settings/privacy');
    await expect(page.getByRole('main')).not.toContainText(/Google/);
    await page.goto('settings/integrations');
    await expect(page.getByTestId('ai-feature-emailTriage')).toHaveCount(0);
    await expect(page.getByTestId('resume-on-file')).toContainText(/on file/i);
  });

  test('a card moved to Replied gets a next step in Drafts; a booked chat shows its time or asks for it', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('people');
    await chatCard(page, 'Jonah Reyes').getByTestId('chat-card-move').selectOption('replied');
    await expect(page.getByText(/moved jonah to replied\. your reply is in drafts\./i)).toBeVisible();
    await openDrafts(page);
    await expect(
      page
        .getByTestId('suggestion-schedule_propose')
        .filter({ hasText: /Jonah replied\. Orbit cannot see what they wrote/ }),
    ).toBeVisible();
    // Scheduled with the time left for later: the card and the page ask for it
    await page.goto('people');
    await chatCard(page, 'Caleb Weber').getByTestId('chat-card-move').selectOption('scheduled');
    await page.getByRole('button', { name: /^not set yet$/i }).click();
    await expect(chatCard(page, 'Caleb Weber')).toContainText(/time not set/i);
    await chatCard(page, 'Caleb Weber').getByRole('link', { name: 'Caleb Weber' }).click();
    await page.getByTestId('person-set-time').click();
    // with an email on file, the time can go out as a Google Calendar invite (in the demo it is marked sent)
    const invite = page.getByTestId('schedule-invite');
    const invites = await invite.isVisible();
    await page.getByTestId('schedule-save').click();
    await expect(page.getByTestId('person-chat-time')).toContainText(/^Chat /);
    if (invites) await expect(page.getByTestId('person-invite-sent')).toContainText(/Invite sent/);
    await page.goto('people');
    await expect(chatCard(page, 'Caleb Weber').getByTestId('chat-card-time')).toContainText(/^Chat /);
    // a chat still ahead is not marked done by a slip of the menu
    await chatCard(page, 'Ethan Park').getByTestId('chat-card-move').selectOption('completed');
    await expect(page.getByTestId('confirm-early-done')).toContainText(/has not come yet/i);
    await page.getByRole('button', { name: /keep it scheduled/i }).click();
    await expect(chatCard(page, 'Ethan Park')).toHaveAttribute('data-testid', 'chat-card-scheduled');
  });

  test('a note dated before a booked chat keeps the chat booked, and says so before saving', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('people');
    await page.getByRole('link', { name: 'Ethan Park' }).first().click();
    await page.getByTestId('person-add-note').click();
    await expect(page.getByTestId('capture-booked-later')).toContainText(/keeps the chat booked/i);
    await page.getByTestId('capture-text').fill('Questions for Ethan: how new grads pick a team.');
    await page.getByTestId('capture-save').click();
    await expect(page).toHaveURL(/\/people\//);
    await expect(page.getByLabel('Chat stage')).toHaveValue('scheduled');
    await openDrafts(page);
    await expect(page.getByText('Coming up').locator('..').getByText('Ethan Park')).toBeVisible();
  });

  test('Discover names who could introduce you and lets you write now instead of a warm-up', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('discover');
    const intro = page.getByTestId('rec-intro').first();
    // it opens the routes on the Map, so it says that, not that it drafts the ask
    await expect(intro).toHaveText(/^Intro through \S+$/);
    const card = page
      .getByTestId('rec-card')
      .filter({ has: page.getByTestId('rec-write-now') })
      .first();
    await expect(card).toContainText(/could introduce you|LinkedIn/);
    await card.getByTestId('rec-write-now').click();
    await expect(page).toHaveURL(/\/people\//);
    await expect(page.getByLabel('Message body')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('warmup-choice')).toBeHidden();
  });

  test('setup splits a typed company list, Back is the browser Back, and the LinkedIn ZIP imports as it is', async ({
    page,
  }) => {
    await prep(page);
    await startSetup(page);
    await fillYou(page, 'Sam Okafor', 'sam@umich.edu');
    await page.getByTestId('ob-fn-ib').click();
    await page.getByTestId('ob-company').fill('Evercore, Lazard');
    await page.getByRole('button', { name: /^add$/i }).click();
    await expect(page.getByRole('button', { name: /^remove evercore$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^remove lazard$/i })).toBeVisible();
    await page.getByRole('button', { name: /^continue$/i }).click();
    await expect(page).toHaveURL(/\/onboarding\/3$/);
    await page.getByRole('button', { name: /^back$/i }).click();
    await expect(page).toHaveURL(/\/onboarding\/2$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/onboarding\/1$/);
    await page.getByRole('button', { name: /^continue$/i }).click();
    await page.getByRole('button', { name: /^continue$/i }).click();
    const csv =
      'First Name,Last Name,URL,Email Address,Company,Position,Connected On\nPriya,Patel,https://www.linkedin.com/in/priya-patel-lz,,Lazard,Analyst,12 Mar 2025\nMarcus,Bell,https://www.linkedin.com/in/marcus-bell-ev,marcus.bell@gmail.com,Evercore,Analyst,03 Jan 2024\n';
    await page.getByTestId('ob-linkedin').setInputFiles({
      name: 'Complete_LinkedInDataExport.zip',
      mimeType: 'application/zip',
      buffer: linkedInZip(csv),
    });
    await expect(page.getByText(/2 people added/i)).toBeVisible();
    // leaving the step and coming back still shows the import
    await page.getByRole('button', { name: /^back$/i }).click();
    await expect(page).toHaveURL(/\/onboarding\/2$/);
    await page.getByRole('button', { name: /^continue$/i }).click();
    await expect(page.getByTestId('ob-linkedin-done')).toContainText(/2 connections imported/i);
    await expect(page.getByTestId('ob-skip')).toHaveCount(0);
    await page.getByRole('button', { name: /^continue$/i }).click();
    await page.getByRole('button', { name: /open orbit/i }).click();
    await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/orbit\/?$/);
    // the address shows as LinkedIn had it, dot included (the list shows people without a chat too)
    await page.goto('people?view=list');
    await page
      .getByRole('link', { name: /marcus bell/i })
      .first()
      .click();
    await expect(page.getByTestId('person-header')).toContainText('marcus.bell@gmail.com');
  });

  test('a tap beside Add a person keeps what was typed; a message opened in the mail app waits in Drafts', async ({
    page,
  }) => {
    await newStudent(page);
    await page.goto('people');
    await page
      .getByRole('button', { name: /add a person/i })
      .first()
      .click();
    await page.getByTestId('add-person-name').fill('Rachel Kim');
    await page.mouse.click(8, 790);
    await expect(page.getByTestId('add-person-name')).toHaveValue('Rachel Kim');
    await page.getByTestId('add-person-company').fill('McKinsey');
    await page.getByTestId('add-person-email').fill('rachel.kim@mckinsey.com');
    await page.getByTestId('add-person-save').click();
    await expect(page).toHaveURL(/\/people\//);
    await page.getByTestId('person-write').click();
    await page.getByRole('button', { name: /^open email to rachel$/i }).click();
    await expect(page.getByTestId('outbox-handed_off')).toBeVisible();
    // Drafts shows it with the others: it waits for the student to say whether it went out
    await openDrafts(page);
    await expect(handedOff(page)).toContainText('Rachel Kim');
    await expect(page.getByText(/no drafts right now|nothing needs you/i)).toHaveCount(0);
  });
});

test.describe('Usability round 5: chats Orbit cannot see, and notes in shorthand', () => {
  test('"They replied" clears Waiting on a reply, and the reply asks for their times when Orbit has no calendar', async ({
    page,
  }) => {
    await newStudent(page);
    await addByHand(page, 'Aisha Bello', 'Bain', {
      linkedin: 'https://www.linkedin.com/in/aisha-bello-bain',
    });
    await page.getByTestId('person-write').click();
    await page.getByTestId('warmup-skip').click();
    await page.getByRole('button', { name: /^copy (note )?& open linkedin$/i }).click();
    await page.getByRole('button', { name: /^i sent it to aisha$/i }).click();
    await expect(page.getByText(/logged as sent to aisha/i)).toBeVisible();
    // twelve days of silence on LinkedIn: no follow-up is due yet, so she waits under Waiting on a reply in Drafts
    await page.clock.fastForward(12 * 86_400_000);
    await openDrafts(page);
    const quiet = page.getByTestId('drafts-quiet');
    await expect(quiet).toContainText('Aisha Bello');
    await quiet.getByTestId('drafts-quiet-replied').click();
    await expect(page.getByTestId('drafts-quiet')).toHaveCount(0);
    const card = page
      .getByTestId('suggestion-schedule_propose')
      .filter({ hasText: /Aisha replied\. Orbit cannot see what they wrote/ });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Find a time');
    await card.getByTestId('draft-review').click();
    const body = card.getByLabel('Message body');
    // Orbit has no calendar here: the draft asks for her times instead of offering slots the student never chose
    await expect(body).toHaveValue(/what times work for you/i);
    // Orbit never saw what she wrote, so the reply does not answer a yes it cannot know about
    await expect(body).toHaveValue(/Thanks for getting back to me\./);
    await expect(body).not.toHaveValue(/would either of these work|\(UTC\)|\d(am|pm)\b/i);
    await page.reload();
    await expect(page.getByTestId('suggestion-schedule_propose')).toBeVisible();
    await expect(page.getByTestId('drafts-quiet')).toHaveCount(0);
    await page.goto('people');
    await expect(chatCard(page, 'Aisha Bello')).toHaveAttribute('data-testid', 'chat-card-replied');
    await expect(chatCard(page, 'Aisha Bello')).not.toContainText(/quiet/);
  });

  test('a thank-you built from a shorthand note writes it out, speaks to the person, and says to read it once', async ({
    page,
  }) => {
    await newStudent(page);
    await addByHand(page, 'Rachel Kim', 'McKinsey', { email: 'rachel.kim@mckinsey.com' });
    await page.getByTestId('person-add-note').click();
    await page
      .getByTestId('capture-text')
      .fill(
        '- told me to reach out to her colleague Marcus Lee who runs Ross recruiting events for McK\n- said to update her after first round apps\n- offered to look over my resume',
      );
    await page.getByTestId('capture-save').click();
    await expect(page).toHaveURL(/\/people\//);
    await openDrafts(page);
    const card = page.getByTestId('suggestion-thank_you').filter({ hasText: 'Rachel Kim' });
    await card.getByTestId('draft-review').click();
    const body = card.getByLabel('Message body');
    await expect(body).toHaveValue(/your colleague Marcus Lee/);
    await expect(body).toHaveValue(/for McKinsey/);
    await expect(body).not.toHaveValue(/\bher colleague\b|\bMcK\b|reach out|advice to update you/);
    await expect(card.getByTestId('draft-from-notes')).toContainText(/read it once as rachel will/i);
    await expect(card.getByTestId('draft-cancel')).toHaveText('Close');
  });
});

test.describe('Usability round 5 on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('setup fits a phone, shows how far along it is, and says which steps are optional', async ({
    page,
  }) => {
    await prep(page);
    const fits = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      const button = await page
        .getByRole('button', { name: /^(get started|continue)$/i })
        .last()
        .boundingBox();
      // the one action spans the column, inside the 16px gutters
      expect(button!.x).toBeGreaterThanOrEqual(15);
      expect(button!.x + button!.width).toBeLessThanOrEqual(375);
      expect(button!.width).toBeGreaterThan(340);
    };
    await page.goto('');
    await page
      .getByRole('button', { name: /^get started/i })
      .first()
      .click();
    const progress = page.getByTestId('ob-progress');
    await expect(progress).toBeVisible();
    await expect(progress).toContainText('1 of 5');
    await expect(page.getByTestId('ob-step-5')).toBeVisible();
    await fits();
    await page
      .getByTestId('ob-welcome')
      .getByRole('button', { name: /get started/i })
      .click();
    await expect(page.getByTestId('ob-name')).toBeVisible();
    await fits();
    await fillYou(page, 'Sam Okafor', 'sam@umich.edu');
    await page.getByTestId('ob-fn-pm').click();
    await page.getByTestId('ob-company').fill('Goldman Sachs');
    await page.getByRole('button', { name: /^add$/i }).click();
    await fits();
    await page.getByRole('button', { name: /^continue$/i }).click();
    await expect(progress).toContainText(/4 of 5 · optional/i);
    await expect(page.getByTestId('ob-skip')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
  test("a person's tabs fit one row, so Prep is not left alone on a second line", async ({ page }) => {
    await loadDemo(page);
    await page.goto('people');
    await page.getByRole('link', { name: 'Ethan Park' }).first().click();
    const tabs = page.getByRole('tablist');
    await expect(tabs.getByRole('tab', { name: /^prep/i })).toBeVisible();
    const box = await tabs.boundingBox();
    expect(box!.height).toBeLessThan(44);
  });
  test('Settings is one menu on a phone, and nothing runs off the side', async ({ page }) => {
    await loadDemo(page);
    await page.goto('settings/profile');
    await page.getByTestId('settings-section-select').selectOption('privacy');
    await expect(page).toHaveURL(/settings\/privacy$/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});

test.describe('Usability round 6', () => {
  test('Add note keeps a half-typed note, picks the one person a typed name leaves, and dates a note to the chat it names', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('notes/new');
    await page.getByTestId('capture-text').fill('Coffee chat w Lena. She said interns get real ownership.');
    // a stray tap on the nav loses nothing
    await page.getByRole('link', { name: 'People' }).first().click();
    // the People page is really shown (a route change renders as a transition, so going back before it lands would
    // never leave Add note at all)
    await expect(page.getByRole('heading', { name: 'People', level: 1 })).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('capture-text')).toHaveValue(/Coffee chat w Lena/);
    await expect(page.getByTestId('capture-draft-hint')).toContainText(/unsaved note/i);
    // the note names Lena, who had a chat yesterday: it is filed with her, at the time of that chat
    await expect(page.getByTestId('capture-match-preview')).toContainText(/file this with Lena Novak/);
    await expect(page.getByTestId('capture-when-chat')).toContainText(/your chat with Lena/);
    await expect(page.getByTestId('capture-when')).not.toHaveValue('2026-10-06T10:00');
    // typing a name that leaves one person picks them
    await page.getByTestId('capture-person-filter').fill('Hannah');
    await expect(page.getByTestId('capture-person')).not.toHaveValue('');
    await expect(page.getByTestId('capture-person').locator('option:checked')).toHaveText(/Hannah Brooks/);
    await page.getByTestId('capture-person-filter').fill('');
    await expect(page.getByTestId('capture-person')).toHaveValue('');
    // a first name five people share is said once
    await page.getByTestId('capture-text').fill('Met Ethan and Priya at the fair.');
    await expect(page.getByTestId('capture-match-preview')).toContainText(/Ethan and \d people named Priya/);
    await page.getByTestId('capture-text').fill('Coffee chat w Lena. She said interns get real ownership.');
    await page.getByTestId('capture-save').click();
    await expect(page).toHaveURL(/\/people\//, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Lena Novak' })).toBeVisible();
    await page.goto('notes/new');
    await expect(page.getByTestId('capture-text')).toHaveValue('');
  });

  test('Settings reads a one-line resume entry cleanly, and any line can be fixed in place', async ({
    page,
  }) => {
    // the resume is no longer a setup step: it is added in Settings (or when the chat asks for it)
    await newStudent(page);
    await page.goto('settings/integrations');
    await page.locator('input[type="file"][accept=".pdf,.txt,.md,.docx"]').setInputFiles({
      name: 'resume.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        'Jamie Ortiz\njamie.ortiz@umich.edu\n\nExperience\nSummer Analyst Intern, Comerica Bank, Detroit, MI — June 2026 to August 2026. Built a DCF model for a mid-market\nclient; automated a weekly credit report in Excel.\n\nSkills\nExcel, Python\n',
      ),
    });
    await expect(page.getByTestId('resume-on-file')).toContainText('resume.txt', { timeout: 15_000 });
    await page.getByTestId('settings-resume-facets').click();
    const job = page.getByTestId('resume-facet').filter({ hasText: 'Comerica Bank' });
    await expect(job).toContainText('Summer Analyst Intern · Comerica Bank');
    await expect(job).toContainText('Built a DCF model for a mid-market client');
    await job.getByTestId('resume-facet-edit').click();
    const editor = page.getByTestId('resume-facet-editor');
    await editor.getByLabel('Role').fill('Summer Analyst');
    await editor.getByTestId('resume-facet-save').click();
    await expect(page.getByTestId('resume-facet').filter({ hasText: 'Comerica Bank' })).toContainText(
      'Summer Analyst · Comerica Bank',
    );
  });

  test('a LinkedIn connection note counts against the 200 characters a free account allows', async ({
    page,
  }) => {
    await newStudent(page);
    await addByHand(page, 'Sarah Lin', 'Evercore', { linkedin: 'https://www.linkedin.com/in/sarah-lin-ev' });
    await page.getByTestId('person-write').click();
    const skip = page.getByTestId('warmup-skip');
    await expect(skip.or(page.getByLabel('Message body'))).toBeVisible({ timeout: 15_000 });
    if (await skip.isVisible()) await skip.click();
    await expect(page.getByLabel('Message body')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('draft-linkedin-hint')).toContainText(/connection request/);
    await expect(page.getByTestId('draft-char-count')).toContainText('/ 200 characters');
    await page.getByLabel('Message body').fill('x'.repeat(240));
    await expect(page.getByTestId('draft-char-count')).toContainText(/free account cuts the rest/);
  });

  test('"I sent it" can be undone, putting the message back to waiting', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await loadDemo(page);
    await openDrafts(page);
    const card = page.getByTestId('suggestion-thank_you').first();
    await card.getByTestId('draft-review').click();
    await expect(card.getByLabel('Message body')).toBeVisible();
    // the note says the resume is attached: Orbit cannot attach files, so the student confirms they will
    if (await card.getByTestId('draft-attach-resume').isVisible())
      await card.getByTestId('draft-attach-confirm').check();
    await card.getByTestId('draft-copy').click();
    await expect(handedOff(page).getByTestId('outbox-handed_off')).toBeVisible();
    await handedOff(page)
      .getByRole('button', { name: /i sent it/i })
      .click();
    await expect(page.getByTestId('toasts')).toContainText(/logged as sent/i);
    await page
      .getByTestId('toasts')
      .getByRole('button', { name: /^undo$/i })
      .click();
    await expect(page.getByTestId('toasts')).toContainText(/not sent after all/i);
    await page.goto('inbox');
    await expect(
      page
        .getByTestId('outbox-item')
        .getByRole('button', { name: /i sent it/i })
        .first(),
    ).toBeVisible();
  });

  test('search puts an exact name first, and /drafts opens Drafts', async ({ page }) => {
    await loadDemo(page);
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').getByRole('textbox').fill('Lena');
    await expect(page.getByRole('dialog').locator('ul button').first()).toContainText('Lena Novak');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Lena Novak' })).toBeVisible();
    await page.goto('drafts');
    await expect(page).toHaveURL(/\/inbox$/);
  });

  test('the next day, a thank-you says the day, and a chat whose time passed asks for the thank-you', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.clock.setSystemTime(new Date('2026-10-08T10:00:00'));
    await openDrafts(page);
    const lena = page.getByTestId('suggestion-thank_you').filter({ hasText: 'Lena' });
    await lena.getByTestId('draft-review').click();
    // the day's brief rewrites "yesterday" on the new day; it can take a while on a slow machine
    await expect(lena.getByLabel('Message body')).toHaveValue(/making time on Monday/, { timeout: 30_000 });
    await expect(lena.getByLabel('Message body')).not.toHaveValue(/yesterday/);
    // Ethan's chat was yesterday at 11:30 and the demo has no calendar sync: it moved on by itself
    await expect(page.getByTestId('suggestion-thank_you').filter({ hasText: 'Ethan' })).toBeVisible();
  });
});

test.describe('People holds the board and the list; Drafts holds the day', () => {
  test('People switches between Board, List and Companies, and the list has everyone, with or without a chat', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('people');
    // the board is the default view
    await expect(page.getByRole('heading', { name: 'People', level: 1 })).toBeVisible();
    await expect(page.getByTestId('people-view-board')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('chat-card-warming').first()).toBeVisible();
    await page.getByTestId('people-view-list').click();
    await expect(page).toHaveURL(/\/people\?view=list$/);
    await expect(page.getByTestId('people-view-list')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-testid^="chat-card-"]')).toHaveCount(0);
    const rows = page.getByTestId('people-row');
    await expect(rows.first()).toBeVisible();
    // someone without a chat is listed too, with a way to start one
    const noChat = rows.filter({ has: page.getByTestId('list-start-chat') }).first();
    const name = await noChat.getByTestId('person-name').innerText();
    const everyone = await rows.count();
    // "With a chat" narrows the list to the people on the board
    await page.getByLabel('Filter people').selectOption('chats');
    await expect(page).toHaveURL(/f=chats/);
    await expect(page.getByTestId('list-start-chat')).toHaveCount(0);
    expect(await rows.count()).toBeLessThan(everyone);
    // one filter serves every view: switching keeps it
    await page.getByLabel('Filter people').selectOption('alumni');
    await page.getByTestId('people-view-board').click();
    await expect(page).toHaveURL(/view=board/);
    await expect(page).toHaveURL(/f=alumni/);
    await expect(page.getByLabel('Filter people')).toHaveValue('alumni');
    await page.getByTestId('people-view-companies').click();
    await expect(page.getByLabel('Filter people')).toHaveValue('alumni');
    // a filter picked straight after the tab click keeps the tab (it once wrote the old view back)
    await page.getByLabel('Filter people').selectOption('all');
    await expect(page.getByTestId('people-view-companies')).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/view=companies/);
    await expect(page.getByTestId('company-target').first()).toBeVisible();
    // Start a chat opens the first message on their page
    await page.getByTestId('people-view-list').click();
    await rows.filter({ hasText: name }).getByTestId('list-start-chat').click();
    await expect(page).toHaveURL(/\/people\/p/);
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await expect(
      page
        .getByLabel('Message body')
        .or(page.getByTestId('warmup-choice'))
        .or(page.getByText(/check-in fits/i)),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('a stage changes right in the list, with an Undo', async ({ page }) => {
    await loadDemo(page);
    await page.goto('people?view=list&f=chats');
    const row = page
      .getByTestId('people-row')
      .filter({ has: page.getByTestId('list-stage') })
      .first();
    const name = await row.getByTestId('person-name').innerText();
    const stage = page.getByTestId('people-row').filter({ hasText: name }).getByTestId('list-stage');
    const from = await stage.inputValue();
    // both stay in the list of people with a chat (a closed stage leaves it unless Show closed is on)
    const to = from === 'nurturing' ? 'replied' : 'nurturing';
    await stage.selectOption(to);
    await expect(page.getByTestId('toasts')).toContainText(`Moved ${name.split(' ')[0]} to`);
    await expect(stage).toHaveValue(to);
    await page
      .getByTestId('toasts')
      .getByRole('button', { name: /^undo$/i })
      .click();
    await expect(stage).toHaveValue(from);
  });

  test('the list draws 300 people at a time, and Show more draws the rest', async ({ page }) => {
    await loadDemo(page);
    await briefWritten(page);
    await injectPeople(page, 400);
    await page.goto('people?view=list');
    const rows = page.getByTestId('people-row');
    await expect(rows).toHaveCount(300);
    await expect(page.getByText(/^Showing 300 of \d+\./)).toBeVisible();
    await page.getByTestId('people-show-more').click();
    expect(await rows.count()).toBeGreaterThan(400);
  });

  test('old Today and Pipeline addresses land where their content lives now', async ({ page }) => {
    await loadDemo(page);
    await page.goto('today');
    await expect(page.getByTestId('greeting')).toBeVisible();
    await expect(page).toHaveURL(/\/(orbit\/?)?$/);
    // a link to one card or one person opens it in Drafts, outlined
    const card = await page.evaluate(async () => {
      const db = (
        window as unknown as {
          __orbitDb: {
            suggestions: {
              toArray(): Promise<{ id: string; kind: string; status: string; personId?: string }[]>;
            };
          };
        }
      ).__orbitDb;
      return (await db.suggestions.toArray()).find((s) => s.status === 'pending' && s.kind === 'thank_you')!;
    });
    await page.goto(`today?card=${card.id}`);
    await expect(page).toHaveURL(new RegExp(`/inbox\\?card=${card.id}$`));
    await expect(page.locator('[data-highlight="true"]')).toBeVisible();
    await page.goto(`today?person=${card.personId}`);
    await expect(page).toHaveURL(new RegExp(`/inbox\\?person=${card.personId}$`));
    await expect(page.locator('[data-highlight="true"]')).toBeVisible();
    // the Pipeline is the People board; its table is the list of people with a chat
    await page.goto('pipeline');
    await expect(page).toHaveURL(/\/people\?view=board$/);
    await expect(page.getByTestId('people-view-board')).toHaveAttribute('aria-selected', 'true');
    await page.goto('pipeline?view=table');
    await expect(page).toHaveURL(/\/people\?view=list&f=chats$/);
    await expect(page.getByTestId('people-view-list')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Filter people')).toHaveValue('chats');
    await page.goto('pipeline?view=companies');
    await expect(page).toHaveURL(/\/people\?view=companies$/);
    await page.goto('pipeline?quiet=1');
    await expect(page).toHaveURL(/\/people\?view=board&quiet=1$/);
    await expect(page.getByLabel('Filter people')).toHaveValue('quiet');
  });

  test('Drafts lists who is waiting on a reply, and "They replied" turns it into a reply to write', async ({
    page,
  }) => {
    await loadDemo(page);
    await openDrafts(page);
    // Daniel has not answered in over a week; his follow-up card speaks for the chat until it is dismissed
    const bump = page.getByTestId('suggestion-follow_up_bump').filter({ hasText: 'Daniel Okafor' });
    await bump.getByRole('button', { name: /^dismiss$/i }).click();
    await bump.getByRole('button', { name: /not now/i }).click();
    await expect(bump).toHaveCount(0);
    const who = 'Daniel Okafor';
    const quiet = page.getByTestId('drafts-quiet');
    await expect(quiet).toContainText('Waiting on a reply');
    const item = quiet.getByRole('listitem').filter({ hasText: who });
    await expect(item).toContainText(/You wrote /);
    await item.getByTestId('drafts-quiet-replied').click();
    const first = who.split(' ')[0]!;
    await expect(page.getByTestId('toasts')).toContainText(`Moved ${first} to Replied`);
    await expect(page.getByTestId('drafts-quiet').filter({ hasText: who })).toHaveCount(0);
    // the reply to write is a card here, and the toast's Show it outlines it
    await page
      .getByTestId('toasts')
      .getByRole('button', { name: /^show it$/i })
      .click();
    await expect(page).toHaveURL(/\/inbox\?person=p/);
    const reply = page.locator('[data-highlight="true"]');
    await expect(reply).toBeVisible();
    await expect(reply).toContainText(who);
    // and the board agrees
    await page.goto('people');
    await expect(chatCard(page, who)).toHaveAttribute('data-testid', 'chat-card-replied');
  });
});

test.describe('Wide screens use the room', () => {
  test('Drafts lists every card and opens one beside it; the board and Discover spread out', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1680, height: 1000 });
    await loadDemo(page);
    await openDrafts(page);
    const split = page.getByTestId('drafts-split');
    await expect(split).toBeVisible();
    const rows = split.getByTestId('drafts-row');
    expect(await rows.count()).toBeGreaterThan(3);
    // the first card is open, its draft ready to edit, without a click
    const reading = page.getByTestId('drafts-reading');
    await expect(reading.getByRole('textbox', { name: 'Message body' })).toBeVisible();
    const first = (await reading.textContent()) ?? '';
    // the keyboard moves down the list and opens the next card
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await reading.textContent()) ?? '').not.toBe(first);
    // Coming up sits in its own column, not under the list
    const coming = page.getByText('Coming up', { exact: true });
    const cb = (await coming.boundingBox())!;
    const sb = (await split.boundingBox())!;
    expect(cb.x).toBeGreaterThan(sb.x + sb.width - 1);
    // the page is wider than the old 1120px column
    await page.goto('discover');
    const scores = page.getByTestId('rec-scores').first();
    await expect(scores).toBeVisible();
    await expect(scores.getByRole('meter', { name: 'Match' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1680);
  });
});

test.describe('Morning brief', () => {
  test('pops up once a day, steps through the day and its decisions, and stays away once closed', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.addInitScript(() => {
      (globalThis as { __ORBIT_MORNING__?: string }).__ORBIT_MORNING__ = 'on';
    });
    await loadDemo(page);
    const brief = page.getByTestId('morning-brief');
    await expect(brief).toBeVisible({ timeout: 20_000 });
    await expect(brief.getByTestId('morning-overview')).toContainText(
      /Good (morning|afternoon|evening), Alex/,
    );
    await expect(brief.getByText('First messages this week')).toBeVisible();
    // the first decision, then Skip moves on; the arrow keys go back and forth
    await brief.getByTestId('morning-next').click();
    const decision = brief.getByTestId('morning-decision');
    await expect(decision).toContainText(/Decision 1 of \d/);
    await brief.getByTestId('morning-next').click();
    await expect(decision).toContainText(/Decision 2 of \d/);
    await page.keyboard.press('ArrowLeft');
    await expect(decision).toContainText(/Decision 1 of \d/);
    // closing puts it away for the day: a reload does not bring it back
    await brief.getByTestId('morning-close').click();
    await expect(brief).toBeHidden();
    await openDrafts(page);
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('morning-brief')).toBeHidden();
    // Settings brings it back on request
    await page.goto('settings/limits');
    await page.getByTestId('settings-morning-show').click();
    await expect(page.getByTestId('morning-brief')).toBeVisible();
  });
});

test.describe('Chat memory (plan 17 §G)', () => {
  test('a goal said in chat is remembered under Settings, Memory, reaches Goals, and can be deleted', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await newStudent(page);
    await page
      .getByTestId('composer-input')
      .fill("I'm targeting product manager internships at fintech startups in New York");
    await page.keyboard.press('Enter');
    // without Claude the router answers, and Orbit's own rules read the statement after the turn
    await expect(page.getByTestId('turn-assistant').last()).toContainText(
      'Noted for later: Targeting product manager internships at fintech startups in New York.',
      { timeout: 30_000 },
    );
    await page.goto('settings/memory');
    const item = page.getByTestId('memory-item');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('Targeting product manager internships at fintech startups in New York');
    await expect(item).toContainText('About a goal');
    await page.goto('settings/goals');
    await expect(page.locator('#goals-industries')).toHaveValue(/Fintech/);
    await expect(page.locator('#goals-locations')).toHaveValue(/New York City/);
    await expect(page.locator('#goals-roles')).toHaveValue(/Product Manager/);
    // deleting it in Settings, Memory removes it for good
    await page.goto('settings/memory');
    await page.getByTestId('memory-delete').click();
    await expect(page.getByTestId('memory-empty')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('memory-empty')).toBeVisible();
  });

  test('Settings, Memory offers the school and year from a two-column resume, never the employer', async ({
    page,
  }) => {
    await newStudent(page);
    await page.goto('settings/integrations');
    await page.locator('input[type="file"][accept=".pdf,.txt,.md,.docx"]').setInputFiles({
      name: 'resume.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        'Sam Okafor\nsam@msu.edu\n\nEDUCATION   Michigan State University   May 2029\nB.S. in Economics\n\nEXPERIENCE   Amma Health Inc.   San Francisco, CA\nSoftware Engineering Intern   Jun 2025 – Aug 2025\n• Built a FHIR ingestion pipeline for new clinics\n',
      ),
    });
    await expect(page.getByTestId('resume-on-file')).toContainText('resume.txt', { timeout: 15_000 });
    await page.goto('settings/memory');
    const offer = page.getByTestId('resume-profile-offer');
    await expect(offer).toContainText('school Michigan State University');
    await expect(offer).toContainText('major Economics');
    await expect(offer).toContainText('class of 2029');
    await expect(offer).not.toContainText('Amma');
    await offer.getByTestId('resume-profile-accept').click();
    await expect(offer).toHaveCount(0);
    await page.goto('settings/profile');
    await expect(page.locator('#profile-school')).toHaveValue('Michigan State University');
  });
});

test.describe('Autopilot', () => {
  test('the chat plans the sends, the student approves once, and Drafts lists them under Scheduled', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await loadDemo(page);
    await page.getByTestId('composer-input').fill('send these on autopilot');
    await page.keyboard.press('Enter');
    const card = page.getByTestId('result-needs_confirmation').last();
    await expect(card).toContainText(/on autopilot, spaced out/, { timeout: 30_000 });
    await card.getByTestId('confirm-approve').click();
    // the result lists each one with its time
    await expect(page.getByText('Scheduled', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await page.goto('inbox?tab=scheduled');
    const list = page.getByTestId('drafts-scheduled');
    await expect(list).toBeVisible();
    const items = list.getByTestId('scheduled-item');
    const n = await items.count();
    expect(n).toBeGreaterThan(1);
    // taken back, one goes to a draft again
    await items.first().getByTestId('scheduled-cancel').click();
    await expect(page.getByTestId('toasts')).toContainText('Taken off autopilot');
    await expect(items).toHaveCount(n - 1);
  });
});

test.describe('Resizable side panels', () => {
  test('the Map panel is dragged wider, keeps its width after a reload, and a double-click puts it back', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1600, height: 950 });
    await loadDemo(page);
    await page.goto('map');
    const panel = page.getByTestId('map-panel');
    const w0 = (await panel.boundingBox())!.width;
    const handle = page.getByTestId('resize-handle');
    const h = (await handle.boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + 120);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 - 200, h.y + 120, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(w0 + 150);
    const wide = (await panel.boundingBox())!.width;
    await page.reload();
    await expect
      .poll(async () => (await page.getByTestId('map-panel').boundingBox())!.width)
      .toBeCloseTo(wide, 0);
    // the orbit still fits beside the wider panel
    await expect(page.getByTestId('orbit-canvas')).toHaveAttribute('data-labels-clipped', '0');
    await page.getByTestId('resize-handle').dblclick();
    await expect
      .poll(async () => (await page.getByTestId('map-panel').boundingBox())!.width)
      .toBeCloseTo(w0, 0);
  });
});

test.describe('Meeting notes: pick one app', () => {
  test('turning Granola on turns Fathom off, and Fireflies after it turns Granola off', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await loadDemo(page);
    await page.goto('settings/integrations');
    await page.getByTestId('settings-fathom-connect').click();
    await expect(page.getByTestId('settings-fathom-status')).toContainText(/Connected/);
    await page.getByTestId('settings-granola-connect').click();
    await expect(page.getByTestId('settings-granola-status')).toContainText(/Connected/);
    // Fathom went off (the toast saying so is gone after a few seconds, so the rows are what count)
    await expect(page.getByTestId('settings-fathom-status')).toHaveCount(0);
    await expect(page.getByTestId('settings-fathom-connect')).toBeVisible();
    await expect(page.getByTestId('settings-wispr-connect')).toBeVisible();
    if (process.env.ORBIT_SHOT_DIR)
      await page
        .getByTestId('settings-granola')
        .locator('xpath=ancestor::section[1]')
        .screenshot({ path: `${process.env.ORBIT_SHOT_DIR}/meeting-apps.png` });
    // a real student's Fireflies asks for the key; the sample student connects straight away
    await page.getByTestId('settings-fireflies-connect').click();
    await expect(page.getByTestId('settings-fireflies-status')).toContainText(/Connected/);
    await expect(page.getByTestId('settings-granola-status')).toHaveCount(0);
    await expect(page.getByTestId('settings-granola-connect')).toBeVisible();
  });
});

test.describe('People board: drag a card to another stage', () => {
  test('picking a card up and dropping it on another column moves the chat; a click still opens the person', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 950 });
    await loadDemo(page);
    await page.goto('people');
    const columns = page.locator('[data-testid^="board-column-"]');
    await expect(columns.first()).toBeVisible();
    const stages = (await columns.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!))).map(
      (t) => t.replace('board-column-', ''),
    );
    expect(stages.length).toBeGreaterThan(1);
    let fromStage = '';
    for (const st of stages)
      if ((await page.getByTestId(`chat-card-${st}`).count()) > 0) {
        fromStage = st;
        break;
      }
    expect(fromStage).not.toBe('');
    const toStage = stages.find((st) => st !== fromStage)!;
    const card = page.getByTestId(`chat-card-${fromStage}`).first();
    const name = (await card.locator('a').first().innerText()).trim();
    const target = page.getByTestId(`board-column-${toStage}`);
    await card.scrollIntoViewIfNeeded();
    const from = (await card.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 20, from.y + 30, { steps: 4 });
    await expect(page.getByTestId('board-drag-ghost')).toBeVisible();
    const to = (await target.boundingBox())!;
    await page.mouse.move(to.x + Math.min(to.width / 2, 60), to.y + 40, { steps: 12 });
    await expect(page.getByTestId('board-drag-ghost')).toContainText('Move to');
    await page.mouse.up();
    await expect(target.getByText(name)).toBeVisible();
    // a plain click on a card still opens the person
    await target.getByText(name).click();
    await expect(page).toHaveURL(/\/people\/[^/?]+/);
  });
});
