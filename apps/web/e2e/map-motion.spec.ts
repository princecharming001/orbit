import { expect, type Page, test } from '@playwright/test';
import {
  angleFromCentre,
  degreesApart,
  loadDemo,
  mapCanvas,
  mapDots,
  mapSettled,
  mapSnapshot,
  nextRender,
  screenDots,
} from './helpers';

/** People by display name, straight from the app's database (ids are the demo's, never hard-coded). */
async function idsByName<N extends string>(page: Page, names: N[]): Promise<Record<N, string>> {
  const found = await page.evaluate(async (names) => {
    const db = (
      window as unknown as {
        __orbitDb: { people: { toArray(): Promise<{ id: string; displayName: string }[]> } };
      }
    ).__orbitDb;
    const all = await db.people.toArray();
    return names.map((n) => all.find((p) => p.displayName === n)?.id ?? '');
  }, names);
  const out = {} as Record<N, string>;
  names.forEach((n, i) => {
    if (!found[i]) throw new Error(`no one called ${n} in the demo`);
    out[n] = found[i];
  });
  return out;
}

async function openMap(page: Page) {
  await page.goto('map');
  await expect(mapCanvas(page)).toBeVisible();
  await mapSettled(page);
}

async function search(page: Page, q: string) {
  await page.getByTestId('reach-input').fill(q);
  await page.getByTestId('reach-input').press('Enter');
}

/** Pause the page clock: from here on, time only moves when the test steps it. */
async function pauseClock(page: Page) {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(now + 50));
}

/** With the clock paused: step it a frame at a time until `check` passes. */
async function stepUntil(page: Page, check: () => Promise<boolean>, maxMs = 3000) {
  for (let t = 0; t <= maxMs; t += 16) {
    if (await check()) return;
    await page.clock.runFor(16);
  }
  throw new Error(`still waiting after ${maxMs} ms of animation time`);
}

/** With the clock paused: step it until nothing on the map is in transition. */
async function stepUntilSettled(page: Page, maxMs = 8000) {
  for (let t = 0; t <= maxMs; t += 100) {
    if ((await mapCanvas(page).getAttribute('data-animating')) === 'false') return;
    await page.clock.runFor(100);
  }
  throw new Error(`the map was still moving after ${maxMs} ms of animation time`);
}

/**
 * Steps the paused clock one frame at a time and records how far each dot moves on screen per frame. Every sample is
 * taken after a real rendering step, so the map has been told about any layout change, as it is before a paint.
 */
async function stepAndMeasure(page: Page, ids: string[], frames: number, into: number[]) {
  await nextRender(page);
  let prev = await screenDots(page, ids);
  for (let i = 0; i < frames; i++) {
    await page.clock.runFor(16);
    await nextRender(page);
    const cur = await screenDots(page, ids);
    let max = 0;
    for (const id of ids) {
      const a = prev[id];
      const b = cur[id];
      if (a && b && a.alpha > 0.05 && b.alpha > 0.05) max = Math.max(max, Math.hypot(b.x - a.x, b.y - a.y));
    }
    into.push(max);
    prev = cur;
  }
}

/** Circular mean of the dots' angles around the centre, in degrees. */
function meanAngle(dots: { x: number; y: number }[], centre: [number, number]): number {
  let sx = 0;
  let sy = 0;
  for (const d of dots) {
    const a = (angleFromCentre({ ...d, r: 0, alpha: 1 }, { x: centre[0], y: centre[1] }) * Math.PI) / 180;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  return (Math.atan2(sy, sx) * 180) / Math.PI;
}

test.describe('Map motion', () => {
  test('the first visit of a session plays the arrival once; a click finishes it at once', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.getByRole('link', { name: /^map$/i }).first().click();
    await expect(mapCanvas(page)).toBeVisible();
    await mapSettled(page);
    const first = await mapSnapshot(page);
    expect(first.phaseLog).toContain('arrival');
    expect(first.phaseLog.indexOf('loading')).toBeLessThan(first.phaseLog.indexOf('arrival'));
    // the end state: every person on the map, fully drawn, labels in, none clipped
    const dots = await mapDots(page);
    expect(Object.keys(dots).length).toBe(first.nodes);
    for (const d of Object.values(dots)) expect(d.alpha).toBeGreaterThan(0.95);
    expect(Number(await mapCanvas(page).getAttribute('data-labels'))).toBeGreaterThan(0);
    await expect(mapCanvas(page)).toHaveAttribute('data-labels-clipped', '0');
    // only once per session: back from another page, the people are simply there
    await page
      .getByRole('link', { name: /^today$/i })
      .first()
      .click();
    await page.getByRole('link', { name: /^map$/i }).first().click();
    await mapSettled(page);
    expect((await mapSnapshot(page)).phaseLog).not.toContain('arrival');

    // a new tab is a new session: the arrival plays again, and a click finishes it at once
    const tab = await page.context().newPage();
    await tab.goto('map');
    await expect
      .poll(async () => (await mapSnapshot(tab).catch(() => undefined))?.phase, { timeout: 15_000 })
      .toBe('arrival');
    // a click on an empty corner, so no dot ends up under the pointer
    const box = (await mapCanvas(tab).boundingBox())!;
    await tab.mouse.click(box.x + 6, box.y + 6);
    await mapSettled(tab, 600);
    const done = await mapSnapshot(tab);
    expect(done.phaseLog).toContain('arrival');
    for (const d of Object.values(await mapDots(tab))) expect(d.alpha).toBeGreaterThan(0.95);
    await expect(tab).toHaveURL(/\/map$/);
    await tab.close();
  });

  test('a company search turns its wedge to the top, pops its people, shows the count chip; Esc reverses it', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    const before = await mapSnapshot(page);
    await search(page, 'Stripe');
    await expect(page.getByText(/people there now/i)).toBeVisible();
    await mapSettled(page);
    const snap = await mapSnapshot(page);
    expect(snap.focus).toBe('company:n:stripe');
    expect(snap.phaseLog).toContain('company');
    // the people emphasised are exactly the people at Stripe
    const stripe: string[] = await page.evaluate(async () => {
      const db = (
        window as unknown as { __orbitDb: { people: { toArray(): Promise<Record<string, unknown>[]> } } }
      ).__orbitDb;
      return (await db.people.toArray())
        .filter((p) => p.currentOrganizationId === 'org_stripe' && p.isHuman && !p.hiddenAt)
        .map((p) => p.id as string);
    });
    expect(new Set(snap.emphasized)).toEqual(new Set(stripe));
    const chip = (await mapCanvas(page).getAttribute('data-chip')) ?? '';
    expect(chip).toMatch(new RegExp(`^${stripe.length} at Stripe( · \\d+ warm)?$`));
    await expect(page.getByTestId('map-legend-line')).toHaveText(
      new RegExp(`Showing ${stripe.length} people at Stripe`),
    );
    // the wedge sits at twelve o'clock
    const dots = Object.values(await mapDots(page, stripe));
    expect(degreesApart(meanAngle(dots, snap.centre), -90)).toBeLessThan(25);
    // everyone else is faded back
    expect(snap.dimmed).toBe(snap.nodes - stripe.length);

    await page.keyboard.press('Escape');
    await mapSettled(page);
    const after = await mapSnapshot(page);
    expect(after.focus).toBe('');
    expect(after.emphasized).toEqual([]);
    expect(after.dimmed).toBe(0);
    await expect(mapCanvas(page)).toHaveAttribute('data-chip', '');
    expect(after.phaseLog).toContain('company-out');
    // the orbit turned back to where it was (it drifts slowly, so allow a little)
    const turned = Math.abs(((after.rotation - before.rotation + Math.PI) % (2 * Math.PI)) - Math.PI);
    expect(turned).toBeLessThan(0.05);
  });

  test('interrupting a focus never makes a dot jump', async ({ page }) => {
    await loadDemo(page);
    await openMap(page);
    await pauseClock(page);
    const ids = Object.keys(await mapDots(page)).slice(0, 70);
    const moves: number[] = [];
    await search(page, 'Stripe');
    await expect(page.getByText(/people there now/i)).toBeVisible();
    await stepAndMeasure(page, ids, 14, moves);
    // mid-turn, a second company: everything heads for the new target from where it is
    await search(page, 'Datadog');
    await expect(page.getByTestId('map-legend-line')).toHaveText(/at Datadog/);
    await stepAndMeasure(page, ids, 45, moves);
    // and Esc mid-way back home
    await page.keyboard.press('Escape');
    await stepAndMeasure(page, ids, 45, moves);
    expect(Math.max(...moves)).toBeGreaterThan(5); // it did move
    // the fastest turn covers about 33 px per 16 ms frame; a snap would be several times that
    expect(Math.max(...moves)).toBeLessThan(48);
    // no frame stands out from both of its neighbours: speed changes smoothly
    for (let i = 1; i < moves.length - 1; i++) {
      if (moves[i]! < 12) continue;
      expect(moves[i]!, `frame ${i}: ${moves.slice(i - 2, i + 3).join(', ')}`).toBeLessThanOrEqual(
        3 * Math.max(moves[i - 1]!, moves[i + 1]!),
      );
    }
  });

  test('reach draws the route hop by hop with the target at the top; switching routes morphs', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    const { 'Maya Chen': maya } = await idsByName(page, ['Maya Chen']);
    await search(page, 'Maya Chen');
    await expect(page.getByTestId('reach-path').first()).toBeVisible({ timeout: 15_000 });
    await mapSettled(page);
    let snap = await mapSnapshot(page);
    expect(snap.focus).toBe(`reach:${maya}:found`);
    expect(snap.phaseLog).toEqual(expect.arrayContaining(['reach-search', 'reach-path']));
    expect(snap.phaseLog.indexOf('reach-search')).toBeLessThan(snap.phaseLog.lastIndexOf('reach-path'));
    expect(snap.path[0]).toBe('user');
    expect(snap.path[snap.path.length - 1]).toBe(maya);
    expect(snap.pathDrawn).toBe(snap.path.length - 1);
    for (const id of snap.path.slice(1)) expect(snap.emphasized).toContain(id);
    const target = (await mapDots(page, [maya]))[maya]!;
    expect(degreesApart(angleFromCentre(target, { x: snap.centre[0], y: snap.centre[1] }), -90)).toBeLessThan(
      10,
    );
    const first = snap.path.join('>');

    // another route: the old one retracts and the new one draws
    const routes = page.getByTestId('reach-path');
    expect(await routes.count()).toBeGreaterThan(1);
    await routes.nth(1).click();
    await expect(mapCanvas(page)).not.toHaveAttribute('data-path', first);
    await mapSettled(page);
    snap = await mapSnapshot(page);
    expect(snap.path.join('>')).not.toBe(first);
    expect(snap.path[snap.path.length - 1]).toBe(maya);
    expect(snap.pathDrawn).toBe(snap.path.length - 1);
    // every dot on the route is fully drawn
    const onRoute = await mapDots(page, snap.path.slice(1));
    for (const d of Object.values(onRoute)) expect(d.alpha).toBeGreaterThan(0.95);
  });

  test('reach with no route: the sweep fades and the target shakes once', async ({ page }) => {
    await loadDemo(page);
    await openMap(page);
    // someone with no tie to the student or to anyone they know
    await page.evaluate(async () => {
      const db = (
        window as unknown as {
          __orbitDb: {
            users: { toArray(): Promise<{ id: string }[]> };
            people: { add(p: unknown): Promise<unknown> };
          };
        }
      ).__orbitDb;
      const user = (await db.users.toArray())[0]!;
      const now = new Date().toISOString();
      await db.people.add({
        id: 'e2e-alone',
        userId: user.id,
        displayName: 'Robin Okonkwo',
        firstName: 'Robin',
        lastName: 'Okonkwo',
        nameNormalized: 'robin okonkwo',
        emails: [],
        currentOrganizationRaw: 'Quietwater Labs',
        relationshipType: 'unknown',
        strength: 0,
        interactionCount: 0,
        sources: ['manual'],
        isHuman: true,
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
    });
    await page.goto('map?reach=e2e-alone');
    await expect(page.getByText(/no route found/i)).toBeVisible({ timeout: 15_000 });
    await mapSettled(page);
    const snap = await mapSnapshot(page);
    expect(snap.focus).toBe('reach:e2e-alone:none');
    expect(snap.phaseLog).toContain('reach-none');
    expect(snap.path).toEqual([]);
  });

  test('someone new is born at their introducer and lands; a stage change crossfades', async ({ page }) => {
    await loadDemo(page);
    await openMap(page);
    const { 'Tomas Costa': tomas, 'Maya Chen': maya } = await idsByName(page, ['Tomas Costa', 'Maya Chen']);
    await pauseClock(page);
    await page.evaluate(async (by) => {
      const db = (
        window as unknown as {
          __orbitDb: Record<
            string,
            { add(x: unknown): Promise<unknown>; toArray(): Promise<{ id: string }[]> }
          >;
        }
      ).__orbitDb;
      const user = (await db.users!.toArray())[0]!;
      const now = new Date().toISOString();
      // Tomas introduced the student to Jamie: the chat records him as referrer
      await db.chats!.add({
        id: 'c-e2e-new',
        userId: user.id,
        personId: 'e2e-new',
        stage: 'identified',
        stageEnteredAt: now,
        source: 'reach',
        goalTags: [],
        bumpCount: 0,
        priority: 2,
        referrerPersonId: by,
        referrerName: 'Tomas',
        createdAt: now,
        updatedAt: now,
      });
      await db.people!.add({
        id: 'e2e-new',
        userId: user.id,
        displayName: 'Jamie Lindgren',
        firstName: 'Jamie',
        lastName: 'Lindgren',
        nameNormalized: 'jamie lindgren',
        emails: [],
        currentOrganizationId: 'org_vercel',
        currentOrganizationRaw: 'Vercel',
        relationshipType: 'unknown',
        strength: 0.1,
        interactionCount: 0,
        sources: ['manual'],
        isHuman: true,
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
    }, tomas);
    // the first frame that shows Jamie shows them on top of Tomas
    let born: Record<string, { x: number; y: number; alpha: number }> = {};
    for (let i = 0; i < 60; i++) {
      await page.clock.runFor(16);
      born = await mapDots(page, ['e2e-new', tomas]);
      if (born['e2e-new'] && born['e2e-new'].alpha > 0) break;
    }
    expect(born['e2e-new']).toBeTruthy();
    expect(Math.hypot(born['e2e-new']!.x - born[tomas]!.x, born['e2e-new']!.y - born[tomas]!.y)).toBeLessThan(
      12,
    );
    expect((await mapSnapshot(page)).phaseLog).toContain('newcomer-intro');
    // it travels to its own slot and lands
    await stepUntilSettled(page);
    const landed = await mapDots(page, ['e2e-new', tomas]);
    expect(landed['e2e-new']!.alpha).toBeGreaterThan(0.95);
    expect(
      Math.hypot(landed['e2e-new']!.x - landed[tomas]!.x, landed['e2e-new']!.y - landed[tomas]!.y),
    ).toBeGreaterThan(20);

    // a chat gets booked: the stage ring crossfades, with one soft burst
    await page.evaluate(async (pid) => {
      const db = (
        window as unknown as {
          __orbitDb: {
            chats: {
              where(k: string): { equals(v: string): { first(): Promise<{ id: string }> } };
              update(id: string, x: unknown): Promise<unknown>;
            };
          };
        }
      ).__orbitDb;
      const chat = await db.chats.where('personId').equals(pid).first();
      await db.chats.update(chat.id, { stage: 'scheduled', updatedAt: new Date().toISOString() });
    }, maya);
    await stepUntil(page, async () => (await mapSnapshot(page)).phaseLog.slice(-2).includes('stage'));
    await expect(mapCanvas(page)).toHaveAttribute('data-animating', 'true');
    await stepUntilSettled(page, 3000);
  });

  test('the Introductions view grows outward generation by generation; a chain lights up; search turns to it', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    const ids = await idsByName(page, ['Elena Cohen', 'Tomas Costa', 'Aisha Volkov']);
    await pauseClock(page);
    await page.getByTestId('map-filter-intros').click();
    // links finish at different times: the second generation before the third
    const drawn: number[] = [];
    let total = 0;
    for (let i = 0; i < 40; i++) {
      await page.clock.runFor(50);
      const s = await mapSnapshot(page);
      total = s.webLinks;
      drawn.push(s.webDrawn);
      if (s.webDrawn === s.webLinks && !s.animating) break;
    }
    expect(total).toBeGreaterThanOrEqual(5);
    expect(drawn.at(-1)).toBe(total);
    expect(drawn.some((d) => d > 0 && d < total)).toBe(true);
    for (let i = 1; i < drawn.length; i++) expect(drawn[i]!).toBeGreaterThanOrEqual(drawn[i - 1]!);
    await page.clock.resume();
    await mapSettled(page);
    // each generation sits one ring further out: Elena, then Tomas whom she introduced, then Aisha whom he did
    const snap = await mapSnapshot(page);
    const dots = await mapDots(page, Object.values(ids));
    const dist = (id: string) => Math.hypot(dots[id]!.x - snap.centre[0], dots[id]!.y - snap.centre[1]);
    expect(dist(ids['Elena Cohen']!)).toBeLessThan(dist(ids['Tomas Costa']!));
    expect(dist(ids['Tomas Costa']!)).toBeLessThan(dist(ids['Aisha Volkov']!));
    // the panel tells each chain in words
    const stories = page.getByTestId('map-intro-story');
    expect(await stories.count()).toBeGreaterThanOrEqual(3);
    await expect(
      stories.filter({ hasText: 'Elena introduced you to Tomas, who introduced you to Aisha.' }),
    ).toHaveCount(1);
    // hovering a chain lights it, from Elena through Tomas to Aisha
    await stories.filter({ hasText: 'Elena introduced you to Tomas' }).hover();
    await expect
      .poll(async () => new Set((await mapSnapshot(page)).webLit))
      .toEqual(new Set(Object.values(ids)));
    // hovering Aisha on the map lights the same chain and says it in words under the list
    const box = (await mapCanvas(page).boundingBox())!;
    const aishaDot = (await mapDots(page, [ids['Aisha Volkov']]))[ids['Aisha Volkov']]!;
    await page.mouse.move(box.x + aishaDot.x, box.y + aishaDot.y);
    await expect(page.getByTestId('map-chain-sentence')).toHaveText(
      'Elena introduced you to Tomas, who introduced you to Aisha.',
    );
    await page.mouse.move(5, 5);
    await expect(page.getByTestId('map-chain-sentence')).toHaveCount(0);
    // the search box searches the web and turns the orbit to the match
    await search(page, 'Aisha');
    await expect.poll(async () => (await mapSnapshot(page)).focus).toBe(`web:${ids['Aisha Volkov']}`);
    await mapSettled(page);
    const s2 = await mapSnapshot(page);
    const aisha = (await mapDots(page, [ids['Aisha Volkov']!]))[ids['Aisha Volkov']!]!;
    expect(degreesApart(angleFromCentre(aisha, { x: s2.centre[0], y: s2.centre[1] }), -90)).toBeLessThan(10);
    // Esc lets go of the match, then of the view
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await mapSnapshot(page)).focus).toBe('web');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await mapSnapshot(page)).focus).toBe('');
    await mapSettled(page);
    // everyone is back in their own slot
    expect((await mapSnapshot(page)).webLinks).toBe(0);
  });

  test('hover lifts the dot and stops the drift; leaving lets it drift again', async ({ page }) => {
    await loadDemo(page);
    await openMap(page);
    const { 'Maya Chen': maya } = await idsByName(page, ['Maya Chen']);
    expect((await mapSnapshot(page)).spin).toBeGreaterThan(0);
    const box = (await mapCanvas(page).boundingBox())!;
    const at = (await mapDots(page, [maya]))[maya]!;
    await page.mouse.move(box.x + at.x, box.y + at.y);
    await expect(page.getByTestId('map-tooltip')).toContainText('Maya Chen');
    await expect.poll(async () => (await mapSnapshot(page)).hover).toBe(maya);
    // the orbit eases to a stop under the pointer, so the dot stays put
    await expect.poll(async () => (await mapSnapshot(page)).spin, { timeout: 3000 }).toBe(0);
    const lifted = (await mapDots(page, [maya]))[maya]!;
    expect(lifted.r).toBeGreaterThan(at.r * 1.15);
    await page.mouse.move(box.x + 3, box.y + 3);
    await expect(page.getByTestId('map-tooltip')).toHaveCount(0);
    await expect.poll(async () => (await mapSnapshot(page)).spin, { timeout: 3000 }).toBeGreaterThan(0);
  });

  test('filters sweep round the orbit from twelve o’clock and the legend line says what is shown', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    const alumni: string[] = await page.evaluate(async () => {
      const db = (
        window as unknown as { __orbitDb: { people: { toArray(): Promise<Record<string, unknown>[]> } } }
      ).__orbitDb;
      return (await db.people.toArray())
        .filter((p) => p.isAlumni && p.isHuman && !p.hiddenAt)
        .map((p) => p.id as string);
    });
    const all = Object.keys(await mapDots(page));
    const others = all.filter((id) => !alumni.includes(id));
    await pauseClock(page);
    await page.getByTestId('map-filter-alumni').click();
    await page.clock.runFor(96);
    // the dots fading out near twelve o'clock are further along than those just before it
    const snap = await mapSnapshot(page);
    const dots = await mapDots(page, others);
    const pos = (id: string) => {
      const a = angleFromCentre(dots[id]!, { x: snap.centre[0], y: snap.centre[1] });
      return (((a + 90) % 360) + 360) % 360; // degrees clockwise from twelve o'clock
    };
    const early = others.filter((id) => pos(id) < 90).map((id) => dots[id]!.alpha);
    const late = others.filter((id) => pos(id) > 270).map((id) => dots[id]!.alpha);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(early.length).toBeGreaterThan(0);
    expect(late.length).toBeGreaterThan(0);
    expect(mean(early)).toBeLessThan(mean(late));
    await page.clock.resume();
    await mapSettled(page);
    const end = await mapSnapshot(page);
    expect(end.dimmed).toBe(others.length);
    expect(end.phaseLog).toContain('filter');
    await expect(page.getByTestId('map-legend-line')).toHaveText(
      new RegExp(`Showing ${alumni.length} alumni`),
    );
    await page.keyboard.press('Escape');
    await mapSettled(page);
    expect((await mapSnapshot(page)).dimmed).toBe(0);
    await expect(page.getByTestId('map-filter-all')).toHaveAttribute('aria-pressed', 'true');
  });

  test('keyboard: Tab focuses the map, arrows move between people, Enter opens, Esc lets go', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    for (let i = 0; i < 60; i++) {
      if (await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'orbit-canvas'))
        break;
      await page.keyboard.press('Tab');
    }
    await expect(mapCanvas(page)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('map-announce')).toHaveText(/Press Enter to (open|see them)\.$/);
    const one = (await mapSnapshot(page)).hover;
    expect(one).toBeTruthy();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowDown');
    const two = (await mapSnapshot(page)).hover;
    expect(two).toBeTruthy();
    // the focused dot pops and its card shows, like a hover
    await expect(page.getByTestId('map-tooltip')).toBeVisible();
    // Esc lets go of the dot first, without leaving the map
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await mapSnapshot(page)).hover).toBeUndefined();
    await expect(page).toHaveURL(/\/map$/);
    await page.keyboard.press('ArrowUp');
    const three = (await mapSnapshot(page)).hover!;
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/people/${three}$`));
  });
});

test.describe('Map motion with reduced motion', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('every change is an instant set or a short fade: no arrival, no travel, no drift', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    const snap = await mapSnapshot(page);
    expect(snap.phaseLog).not.toContain('arrival');
    expect(snap.spin).toBe(0);
    await expect(mapCanvas(page)).toHaveAttribute('data-moving', 'false');
    await search(page, 'Stripe');
    await expect(page.getByText(/people there now/i)).toBeVisible();
    // settled within a short fade, already turned
    await mapSettled(page, 1500);
    const after = await mapSnapshot(page);
    const stripe = await page.evaluate(async () => {
      const db = (
        window as unknown as { __orbitDb: { people: { toArray(): Promise<Record<string, unknown>[]> } } }
      ).__orbitDb;
      return (await db.people.toArray())
        .filter((p) => p.currentOrganizationId === 'org_stripe')
        .map((p) => p.id as string);
    });
    const dots = Object.values(await mapDots(page, stripe));
    expect(degreesApart(meanAngle(dots, after.centre), -90)).toBeLessThan(25);
    expect(after.fans).toEqual([]);
  });
});

test.describe('Map motion on a touch screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('pending suggestions ripple together every 2.4 s, and the map sleeps in between', async ({ page }) => {
    await loadDemo(page);
    await openMap(page);
    // the orbit holds still on touch screens, so the ripples are all that moves
    await expect(mapCanvas(page)).toHaveAttribute('data-moving', 'false');
    await pauseClock(page);
    const before = (await mapSnapshot(page)).draws;
    // two ripple periods, a frame at a time: 300 frames at full rate
    for (let i = 0; i < 300; i++) await page.clock.runFor(16);
    const drawn = (await mapSnapshot(page)).draws - before;
    expect(drawn).toBeGreaterThan(20);
    expect(drawn).toBeLessThan(120);
    await expect(mapCanvas(page)).toHaveAttribute('data-animating', 'false');
  });
});
